// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Live 3D view: the WebGPU solver (src/gpu3d) computes the pour while you watch. Parcels are drawn
// with the same WebGL renderer as the recording; once per rendered frame the GPU writes their
// positions and they are read back (about 1 MB). Drawing straight from the solver's buffer with a
// WebGPU canvas fails on hybrid-GPU laptops (the canvas cannot be presented from the discrete GPU),
// so the readback is the portable path. The simulation runs in whole stable substeps; when the GPU
// cannot keep up, simulated time runs slower than real time and the measured speed says so.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  PointsMaterial,
  Scene,
  type Camera,
  type PerspectiveCamera,
} from 'three';
import type { MotionPhase } from '../sim/motion';
import { gentlePour3D } from '../sim3d/presets3d';
import type { Config3D } from '../sim3d/solver3d';
import type { Teapot3DConfig } from '../sim3d/vessel3d';
import { addLights, buildPot, startCamera, disposeObjects } from './scene';
import type { ControlsLike, RendererLike, ViewerTheme } from './viewer';

/** The part of GpuSimulation3D the view uses (structural, so tests can drive it without a GPU). */
export interface LiveSim {
  readonly n: number;
  readonly time: number;
  readonly finished: boolean;
  readonly controller: {
    readonly angleDeg: number;
    readonly phase: MotionPhase;
    setTarget(angleDeg: number, time: number): void;
  };
  readonly stats: { dischargedByOrigin: [number, number, number] };
  readonly cpu: {
    readonly parcelVolume: number;
    readonly origin: Uint8Array;
    readonly x: Float64Array;
    readonly y: Float64Array;
    readonly z: Float64Array;
    readonly h: number;
    readonly pivotWorld: [number, number];
    readonly cfg: { pivot: [number, number]; teapot: Teapot3DConfig };
  };
  step(): Promise<void>;
  sync?(): Promise<void>;
  readRenderPositions(): Promise<Float32Array>;
  destroy(): void;
}

export type LivePreset = 'gentle-5' | 'gentle-4' | 'manual-5';

export const LIVE_PRESETS: Record<LivePreset, { label: string; cellMm: number; manual: boolean }> = {
  'gentle-5': { label: 'Gentle 400 mL pour, 5 mm cells', cellMm: 5, manual: false },
  'gentle-4': { label: 'Gentle 400 mL pour, 4 mm cells (finer, slower)', cellMm: 4, manual: false },
  'manual-5': { label: 'Tilt by hand, 5 mm cells', cellMm: 5, manual: true },
};

/** Solver configuration of a live preset: the CPU reference preset, or a long manual session. */
export function liveConfig(preset: LivePreset): Config3D {
  const p = LIVE_PRESETS[preset];
  if (!p.manual) return gentlePour3D(p.cellMm, 20);
  const c = gentlePour3D(p.cellMm, 3600);
  c.motion = { ...c.motion, kind: 'manual' };
  return c;
}

export interface LiveDeps {
  createRenderer(canvas: HTMLCanvasElement): RendererLike;
  createControls(camera: PerspectiveCamera, element: HTMLElement): ControlsLike;
  createSim(preset: LivePreset): LiveSim;
  schedule(cb: (t: number) => void): number;
  cancel(id: number): void;
  now(): number;
  pixelRatio: number;
}

/** How far the simulation may fall behind the wall clock (s) before the backlog is dropped. */
const MAX_LAG_S = 0.25;
/** After an automatic pour returns upright, keep simulating this long (s), as the CPU benchmark does. */
const SETTLE_S = 1.5;

export class LivePourViewer {
  readonly live = true;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly frames = 1;
  frame = 0;
  playing = true;
  speed = 1;
  onFrame: ((frame: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  sim: LiveSim;
  preset: LivePreset;
  private renderer: RendererLike;
  private controls: ControlsLike;
  private glass;
  private pot;
  private points: Points | null = null;
  private reading = false;
  private theme: ViewerTheme;
  private raf = -1;
  private last = -1;
  private busy = false;
  private mark: { wall: number; sim: number } | null = null;
  /** Simulated time the run should have reached (advances with the wall clock while playing). */
  private goal = 0;
  private doneAt = -1;
  private disposed = false;
  private failed = false;
  /** Measured simulated seconds per wall-clock second while playing (smoothed). */
  private rate = 0;

  constructor(
    canvas: HTMLCanvasElement,
    theme: ViewerTheme,
    private deps: LiveDeps,
    preset: LivePreset = 'gentle-5',
  ) {
    this.theme = theme;
    this.preset = preset;
    this.renderer = deps.createRenderer(canvas);
    this.renderer.setPixelRatio(deps.pixelRatio);
    this.renderer.setClearColor(new Color(theme.background), 1);
    addLights(this.scene);
    this.sim = deps.createSim(preset);
    const placement = this.placement();
    const built = buildPot(placement, theme.wall);
    this.pot = built.pot;
    this.glass = built.glass;
    this.scene.add(this.pot);
    const cam = startCamera(placement);
    this.camera = cam.camera;
    this.controls = deps.createControls(this.camera, canvas);
    this.controls.target.copy(cam.target);
    this.controls.enableDamping = true;
    this.controls.update();
    this.controls.saveState();
    this.buildParcels();
  }

  private placement() {
    const c = this.sim.cpu;
    return { teapot: c.cfg.teapot, pivot: c.cfg.pivot, pivotWorld: c.pivotWorld, zOffset: c.h };
  }

  /** Parcels: the simulated half plus its mirror image across the symmetry plane. */
  private buildParcels(): void {
    if (this.points) {
      this.scene.remove(this.points);
      disposeObjects(this.points);
    }
    const { n, cpu } = this.sim;
    const pos = new Float32Array(6 * n);
    for (let p = 0; p < n; p++) {
      pos.set([cpu.x[p], cpu.y[p], cpu.z[p]], 3 * p);
      pos.set([cpu.x[p], cpu.y[p], 2 * cpu.h - cpu.z[p]], 3 * (p + n));
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(6 * n), 3));
    this.points = new Points(
      geo,
      new PointsMaterial({ size: 0.0035, vertexColors: true, sizeAttenuation: true }),
    );
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.fillColors();
  }

  private fillColors(): void {
    const col = this.points?.geometry.getAttribute('color') as BufferAttribute | undefined;
    if (!col) return;
    const pal = this.theme.layers.map((c) => new Color(c));
    const { n, cpu } = this.sim;
    for (let p = 0; p < n; p++) {
      const c = pal[cpu.origin[p]] ?? pal[0];
      col.setXYZ(p, c.r, c.g, c.b);
      col.setXYZ(p + n, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  /** Fetch the latest parcel positions from the GPU (one request at a time). */
  private async refreshPositions(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const sim = this.sim;
    try {
      const data = await sim.readRenderPositions();
      if (sim !== this.sim || this.disposed || !this.points) return;
      const attr = this.points.geometry.getAttribute('position') as BufferAttribute;
      (attr.array as Float32Array).set(data);
      attr.needsUpdate = true;
    } catch (e) {
      if (sim === this.sim) this.fail(e);
    } finally {
      this.reading = false;
    }
  }

  /** Simulated time (s). */
  get time(): number {
    return this.sim.time;
  }

  get manual(): boolean {
    return LIVE_PRESETS[this.preset].manual;
  }

  /** True once the pour is over (automatic presets) or the simulated duration is used up. */
  get finished(): boolean {
    return this.sim.finished || (this.doneAt >= 0 && this.sim.time > this.doneAt + SETTLE_S);
  }

  /** Measured simulated seconds per wall-clock second (1 = real time). */
  realTimeFactor(): number {
    return this.rate;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Live runs cannot be scrubbed: any seek restarts the pour from the initial state. */
  seek(): void {
    this.restart();
  }

  /** Start again from the seeded state, optionally with another preset. */
  restart(preset: LivePreset = this.preset): void {
    const changed = preset !== this.preset;
    this.sim.destroy();
    this.preset = preset;
    this.sim = this.deps.createSim(preset);
    this.failed = false;
    this.doneAt = -1;
    this.rate = 0;
    this.goal = 0;
    this.mark = null;
    this.buildParcels();
    if (changed) {
      this.scene.remove(this.pot);
      disposeObjects(this.pot);
      const built = buildPot(this.placement(), this.theme.wall);
      this.pot = built.pot;
      this.glass = built.glass;
      this.scene.add(this.pot);
    }
    this.playing = true;
    this.onFrame?.(0);
  }

  /** Manual preset: ask the hand to tilt the pot to this angle (degrees). */
  setTilt(angleDeg: number): void {
    if (this.manual) this.sim.controller.setTarget(angleDeg, this.sim.time);
  }

  /** Poured millilitres per starting layer so far. */
  poured(): number[] {
    const ml = this.sim.cpu.parcelVolume * 2 * 1e6;
    return this.sim.stats.dischargedByOrigin.map((k) => k * ml);
  }

  angleDeg(): number {
    return this.sim.controller.angleDeg;
  }

  phase(): MotionPhase {
    return this.sim.controller.phase;
  }

  applyTheme(theme: ViewerTheme): void {
    this.theme = theme;
    this.renderer.setClearColor(new Color(theme.background), 1);
    this.glass.color.set(theme.wall);
    this.fillColors();
  }

  resetView(): void {
    this.controls.reset();
  }

  /** Run substeps until the simulation reaches the goal clock (each step yields to rendering). */
  private async pump(): Promise<void> {
    this.busy = true;
    const sim = this.sim;
    try {
      while (sim === this.sim && !this.disposed && this.playing && sim.time < this.goal && !this.finished) {
        await sim.step();
        if (sim !== this.sim || this.disposed) return;
        if (sim.controller.phase === 'done' && this.doneAt < 0 && !this.manual) this.doneAt = sim.time;
      }
      // Flush the final pipelined stats only after completion; flushing a pause would alter the
      // one-step lag used for subsequent substeps and break pause-independent determinism.
      if (sim === this.sim && !this.disposed && this.finished) await sim.sync?.();
    } catch (e) {
      if (sim === this.sim) this.fail(e);
    } finally {
      this.busy = false;
    }
  }

  private fail(error: unknown): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.playing = false;
    this.onError?.(error instanceof Error ? error.message : String(error));
  }

  /** Measure simulated seconds per wall-clock second over windows of at least half a second. */
  private measure(): void {
    const now = this.deps.now();
    if (!this.playing || this.finished) {
      this.mark = null;
      return;
    }
    if (!this.mark) {
      this.mark = { wall: now, sim: this.sim.time };
      return;
    }
    const wall = (now - this.mark.wall) / 1000;
    if (wall < 0.5) return;
    const r = (this.sim.time - this.mark.sim) / wall;
    this.rate = this.rate === 0 ? r : 0.7 * this.rate + 0.3 * r;
    this.mark = { wall: now, sim: this.sim.time };
  }

  /** One animation frame: keep the simulation going, fetch the parcel positions, render. */
  tick(dtMs: number): void {
    if (this.failed) this.playing = false;
    if (this.playing && !this.finished) {
      // A slower GPU falls behind by at most MAX_LAG_S; the measured speed then shows it.
      this.goal = Math.min(this.goal + (dtMs / 1000) * this.speed, this.sim.time + MAX_LAG_S);
      if (!this.busy) void this.pump();
    } else this.goal = this.sim.time;
    this.measure();
    if (!this.failed) void this.refreshPositions();
    this.pot.rotation.z = (-this.sim.controller.angleDeg * Math.PI) / 180;
    this.controls.update();
    this.renderer.render(this.scene, this.camera as Camera);
    this.onFrame?.(0);
  }

  start(): void {
    const loop = (t: number) => {
      const dt = this.last < 0 ? 0 : Math.min(100, t - this.last);
      this.last = t;
      this.tick(dt);
      this.raf = this.deps.schedule(loop);
    };
    this.raf = this.deps.schedule(loop);
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf >= 0) this.deps.cancel(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
    this.sim.destroy();
    disposeObjects(this.scene);
  }
}
