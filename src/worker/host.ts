// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Worker-side command handler, independent of worker globals so it can be unit tested.
// The main thread requests one frame at a time ("pull"), so there is never an unbounded
// queue of frames: at most one request and one response are in flight.

import { buildRecord, recordToCsv, bandNames } from '../sim/experiment';
import { dischargeBins, mixingReport, originComposition, regionMatrix } from '../sim/metrics';
import { Simulation } from '../sim/solver';
import { CELL_FLUID, type Diagnostics, type ExperimentConfig, type RenderSnapshot } from '../sim/types';

export type ToWorker =
  | { type: 'init'; config: ExperimentConfig }
  | { type: 'frame' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'speed'; value: number }
  | { type: 'tilt'; angleDeg: number }
  | { type: 'export'; format?: 'json' | 'csv' };

export interface StaticInfo {
  config: ExperimentConfig;
  polylines: [number, number][][];
  halfWall: number;
  outflow: { ax: number; ay: number; bx: number; by: number } | null;
  n: number;
  nx: number;
  ny: number;
  h: number;
  depth: number;
  parcelVolume: number;
  origin: Uint8Array;
  x0: Float32Array;
  y0: Float32Array;
  bandEdges: number[];
  bandNames: string[];
  pathlineParticles: number[];
}

export interface FrameMetrics {
  composition: ReturnType<typeof originComposition>;
  bins: ReturnType<typeof dischargeBins>;
  mixing: ReturnType<typeof mixingReport>;
  regions: ReturnType<typeof regionMatrix>;
  history: Simulation['history'];
  pathlines: number[][];
}

export type FromWorker =
  | {
      type: 'ready';
      info: StaticInfo;
      snapshot: RenderSnapshot;
      diagnostics: Diagnostics;
      metrics: FrameMetrics;
    }
  | {
      type: 'frame';
      snapshot: RenderSnapshot;
      diagnostics: Diagnostics;
      metrics: FrameMetrics | null;
      arrows: Float32Array;
      running: boolean;
      finished: boolean;
      realtimeFactor: number;
    }
  | { type: 'export'; format?: 'json' | 'csv'; json: string; csv: string; fileStem: string }
  | { type: 'error'; message: string };

/** Largest simulated-time backlog (s); beyond it the run slows down and says so. */
export const MAX_DEBT = 0.1;

export class SimulationHost {
  sim: Simulation | null = null;
  running = false;
  speed = 1;
  private framesSinceMetrics = 0;
  constructor(private appVersion: string) {}

  handle(msg: ToWorker): FromWorker[] {
    try {
      return this.dispatch(msg);
    } catch (e) {
      this.running = false;
      return [{ type: 'error', message: e instanceof Error ? e.message : String(e) }];
    }
  }

  private dispatch(msg: ToWorker): FromWorker[] {
    if (msg.type === 'init') {
      this.sim = new Simulation(msg.config);
      this.running = false;
      this.failure = null;
      this.debt = 0;
      this.lastPump = -1;
      this.realtime = 1;
      const s = this.sim;
      const info: StaticInfo = {
        config: s.cfg,
        polylines: s.vessel.polylines,
        halfWall: s.vessel.halfWall,
        outflow: s.vessel.outflow,
        n: s.n,
        nx: s.nx,
        ny: s.ny,
        h: s.h,
        depth: s.depth,
        parcelVolume: s.parcelVolume,
        origin: s.origin.slice(),
        x0: s.x0.slice(),
        y0: s.y0.slice(),
        bandEdges: s.bandEdges,
        bandNames: bandNames(s.initialBandCounts.length),
        pathlineParticles: s.pathlines.map((p) => p.particle),
      };
      return [
        {
          type: 'ready',
          info,
          snapshot: s.snapshot(),
          diagnostics: s.diagnostics(),
          metrics: this.metrics(),
        },
      ];
    }
    const s = this.sim;
    if (!s) return [{ type: 'error', message: 'Simulation not initialised.' }];
    switch (msg.type) {
      case 'play':
        if (!s.finished) this.running = true;
        this.realtime = 1;
        return [];
      case 'pause':
        this.running = false;
        return [];
      case 'tilt':
        s.setTiltTarget(msg.angleDeg);
        return [];
      case 'speed':
        this.speed = Math.max(0.05, Math.min(4, msg.value));
        return [];
      case 'step':
        this.running = false;
        if (!s.finished) s.advance(Math.min(1 / 60, s.cfg.duration - s.time));
        return [this.frame(true)];
      case 'frame': {
        if (this.failure !== null) {
          const message = this.failure;
          this.failure = null;
          return [{ type: 'error', message }];
        }
        // Rendering is decoupled from stepping: a frame request returns the latest state;
        // pump() advances the simulation in the background.
        this.framesSinceMetrics++;
        const withMetrics = this.framesSinceMetrics >= 6 || !this.running;
        return [this.frame(withMetrics)];
      }
      case 'export': {
        const rec = buildRecord(s, this.appVersion);
        return [
          {
            type: 'export',
            format: msg.format ?? 'json',
            json: JSON.stringify(rec, null, 1),
            csv: recordToCsv(rec),
            fileStem: `pourlab-${s.cfg.presetId}-seed${s.cfg.seed}-t${s.time.toFixed(1)}`,
          },
        ];
      }
    }
  }

  /**
   * Advance the running simulation toward real time (times the playback speed) for at most
   * `budgetMs` of computation. Called repeatedly by the worker loop. Time debt is capped, so when
   * the machine cannot keep up the simulation slows down (and reports it) instead of taking
   * unstable large steps or queueing work.
   */
  pump(nowMs: number, budgetMs = 12, clock: () => number = () => performance.now()): void {
    const s = this.sim;
    const wall = this.lastPump < 0 ? 0 : Math.max(0, (nowMs - this.lastPump) / 1000);
    this.lastPump = nowMs;
    if (!s || !this.running || s.finished) {
      this.debt = 0;
      return;
    }
    const wanted = wall * this.speed;
    this.debt = Math.min(this.debt + wanted, MAX_DEBT);
    const t0 = clock();
    let done = 0;
    try {
      while (this.debt > 1e-9 && clock() - t0 < budgetMs && !s.finished) {
        // advance() completes whole substeps, so book the time that actually elapsed.
        const before = s.time;
        s.advance(Math.min(this.debt, 1 / 120));
        const elapsed = s.time - before;
        this.debt -= elapsed;
        done += elapsed;
      }
    } catch (e) {
      // Reported on the next frame request.
      this.running = false;
      this.failure = e instanceof Error ? e.message : String(e);
      return;
    }
    if (s.finished) this.running = false;
    if (wanted > 0) this.realtime += (Math.min(1, done / wanted) - this.realtime) * 0.1;
  }

  private lastPump = -1;
  private failure: string | null = null;
  private debt = 0;
  /** Smoothed fraction of the requested simulated-time rate actually achieved. */
  realtime = 1;

  private frame(withMetrics: boolean): FromWorker {
    const s = this.sim!;
    if (withMetrics) this.framesSinceMetrics = 0;
    return {
      type: 'frame',
      snapshot: s.snapshot(),
      diagnostics: s.diagnostics(),
      metrics: withMetrics ? this.metrics() : null,
      arrows: velocityArrows(s, 3),
      running: this.running,
      finished: s.finished,
      realtimeFactor: this.realtime,
    };
  }

  private metrics(): FrameMetrics {
    const s = this.sim!;
    return {
      composition: originComposition(s),
      bins: dischargeBins(s),
      mixing: mixingReport(s),
      regions: regionMatrix(s, bandNames(s.initialBandCounts.length)),
      history: s.history,
      pathlines: s.pathlines.map((p) => p.points),
    };
  }
}

/** Coarse velocity samples (x, y, u, v) at the centres of liquid cells, every `stride` cells. */
export function velocityArrows(s: Simulation, stride: number): Float32Array {
  const out: number[] = [];
  for (let j = 1; j < s.ny - 1; j += stride)
    for (let i = 1; i < s.nx - 1; i += stride) {
      if (s.cell[i + j * s.nx] !== CELL_FLUID) continue;
      const x = (i + 0.5) * s.h;
      const y = (j + 0.5) * s.h;
      out.push(x, y, s.sampleU(s.u, x, y), s.sampleV(s.v, x, y));
    }
  return Float32Array.from(out);
}
