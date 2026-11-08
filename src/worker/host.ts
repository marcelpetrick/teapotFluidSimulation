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
  | { type: 'frame'; wallDt: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'speed'; value: number }
  | { type: 'export' };

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
  | { type: 'export'; json: string; csv: string; fileStem: string }
  | { type: 'error'; message: string };

/** Largest simulated time advanced per frame request; beyond this the run slows and says so. */
export const MAX_SIM_PER_FRAME = 1 / 20;

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
        return [];
      case 'pause':
        this.running = false;
        return [];
      case 'speed':
        this.speed = Math.max(0.05, Math.min(4, msg.value));
        return [];
      case 'step':
        this.running = false;
        if (!s.finished) s.advance(Math.min(1 / 60, s.cfg.duration - s.time));
        return [this.frame(1 / 60, 1 / 60, true)];
      case 'frame': {
        const wall = Math.max(0, Math.min(0.1, msg.wallDt));
        let simDt = 0;
        if (this.running && !s.finished) {
          simDt = Math.min(wall * this.speed, MAX_SIM_PER_FRAME, s.cfg.duration - s.time);
          if (simDt > 0) s.advance(simDt);
          if (s.finished) this.running = false;
        }
        this.framesSinceMetrics++;
        const withMetrics = this.framesSinceMetrics >= 6 || !this.running;
        return [this.frame(simDt, wall, withMetrics)];
      }
      case 'export': {
        const rec = buildRecord(s, this.appVersion);
        return [
          {
            type: 'export',
            json: JSON.stringify(rec, null, 1),
            csv: recordToCsv(rec),
            fileStem: `pourlab-${s.cfg.presetId}-seed${s.cfg.seed}-t${s.time.toFixed(1)}`,
          },
        ];
      }
    }
  }

  private frame(simDt: number, wall: number, withMetrics: boolean): FromWorker {
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
      realtimeFactor: wall > 0 ? simDt / (wall * this.speed) : 0,
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
