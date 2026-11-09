// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// @vitest-environment happy-dom
//
// The live 3D view with a scripted stand-in for the WebGPU solver (the real solver runs in the
// browser tests). Checks pacing, readback, presets, manual tilt, theme and lifecycle.
import { BufferAttribute, Color, Points, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { MotionPhase } from '../src/sim/motion';
import { defaultTeapot3D } from '../src/sim3d/vessel3d';
import {
  LIVE_PRESETS,
  liveConfig,
  LivePourViewer,
  type LiveDeps,
  type LivePreset,
  type LiveSim,
} from '../src/view3d/live';

function fakeSim(preset: LivePreset, n = 6) {
  const origin = Uint8Array.from({ length: n }, (_, k) => k % 3);
  const xs = Float64Array.from({ length: n }, (_, k) => 0.1 + k * 0.001);
  const sim = {
    preset,
    n,
    time: 0,
    duration: 20,
    get finished() {
      return this.time >= this.duration;
    },
    destroyed: false,
    targets: [] as number[],
    controller: {
      angleDeg: 0,
      phase: 'wait' as MotionPhase,
      setTarget(a: number) {
        sim.targets.push(a);
      },
    },
    stats: { dischargedByOrigin: [0, 0, 0] as [number, number, number] },
    cpu: {
      parcelVolume: 1e-6 / 2,
      origin,
      x: xs,
      y: xs,
      z: Float64Array.from({ length: n }, () => 0.006),
      h: 0.005,
      pivotWorld: [0.2, 0.2] as [number, number],
      cfg: { pivot: [0, 0.06] as [number, number], teapot: defaultTeapot3D() },
    },
    async step() {
      sim.time += 0.01;
      sim.controller.angleDeg = 10;
      sim.stats.dischargedByOrigin = [1, 2, 1];
      if (sim.time > 0.05) sim.controller.phase = 'done';
    },
    reads: 0,
    async readRenderPositions() {
      sim.reads++;
      return new Float32Array(6 * n).fill(0.5);
    },
    destroy() {
      sim.destroyed = true;
    },
  };
  return sim;
}

const theme = {
  background: '#ffffff',
  wall: '#333333',
  layers: ['#0000ff', '#00ff00', '#ff0000'] as [string, string, string],
};

function setup(preset: LivePreset = 'gentle-5') {
  let clock = 0;
  const sims: ReturnType<typeof fakeSim>[] = [];
  const renderer = {
    renders: 0,
    size: [0, 0],
    setSize(w: number, h: number) {
      this.size = [w, h];
    },
    setPixelRatio() {},
    setClearColor() {},
    render() {
      this.renders++;
    },
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
  const controls = {
    target: new Vector3(),
    enableDamping: false,
    update() {},
    saveState() {},
    wasReset: false,
    reset() {
      this.wasReset = true;
    },
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
  let scheduled: ((t: number) => void) | null = null;
  const deps: LiveDeps = {
    createRenderer: () => renderer,
    createControls: () => controls,
    createSim: (p) => {
      const s = fakeSim(p);
      sims.push(s);
      return s as unknown as LiveSim;
    },
    schedule: (cb) => {
      scheduled = cb;
      return 7;
    },
    cancel: () => {
      scheduled = null;
    },
    now: () => clock,
    pixelRatio: 1,
  };
  const v = new LivePourViewer(document.createElement('canvas'), theme, deps, preset);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    v,
    sims,
    renderer,
    controls,
    flush,
    advance: (ms: number) => (clock += ms),
    frame: (t: number) => scheduled?.(t),
  };
}

describe('live 3D view', () => {
  it('maps presets to solver configurations', () => {
    expect(liveConfig('gentle-5').h).toBe(0.005);
    expect(liveConfig('gentle-4').h).toBe(0.004);
    const m = liveConfig('manual-5');
    expect(m.motion.kind).toBe('manual');
    expect(m.duration).toBe(3600);
    expect(LIVE_PRESETS['manual-5'].manual).toBe(true);
  });

  it('draws both halves coloured by starting layer', () => {
    const { v } = setup();
    const pts = v.scene.children.find((c) => c instanceof Points) as Points;
    const pos = pts.geometry.getAttribute('position') as BufferAttribute;
    expect(pos.count).toBe(12);
    expect(pos.getZ(6)).toBeCloseTo(2 * 0.005 - 0.006, 9); // mirror image of parcel 0
    const col = pts.geometry.getAttribute('color') as BufferAttribute;
    expect(col.getX(0)).toBeCloseTo(new Color('#0000ff').r, 6);
    expect(col.getZ(0)).toBeCloseTo(1, 6);
    expect(col.getY(1)).toBeCloseTo(1, 6);
    v.applyTheme({ ...theme, layers: ['#ff0000', '#00ff00', '#0000ff'] });
    expect(col.getX(0)).toBeCloseTo(1, 6);
  });

  it('keeps simulated time with the wall clock, reads positions back and measures the speed', async () => {
    const { v, sims, renderer, flush, advance } = setup();
    const sim = sims[0];
    v.tick(0);
    await flush();
    expect(sim.time).toBe(0);
    for (let k = 0; k < 4; k++) {
      advance(200);
      v.tick(200);
      await flush();
    }
    expect(sim.time).toBeGreaterThan(0.04);
    expect(sim.reads).toBeGreaterThan(0);
    const pts = v.scene.children.find((c) => c instanceof Points) as Points;
    expect((pts.geometry.getAttribute('position') as BufferAttribute).getX(0)).toBe(0.5);
    expect(renderer.renders).toBe(5);
    expect(v.realTimeFactor()).toBeGreaterThan(0);
    expect(v.poured()).toEqual([1, 2, 1].map((k) => k * 1e-6 * 1e6));
    expect(v.angleDeg()).toBe(10);
    expect(v.phase()).toBe('done');
    expect(v.time).toBe(sim.time);
    // The automatic pour is finished 1.5 s after it is back upright.
    for (let k = 0; k < 20 && !v.finished; k++) {
      advance(250);
      v.tick(250);
      await flush();
    }
    expect(v.finished).toBe(true);
    const t = sim.time;
    v.tick(100);
    await flush();
    expect(sim.time).toBe(t);
  });

  it('pauses, restarts and switches presets; tilt applies to the manual preset only', async () => {
    const { v, sims, flush } = setup();
    v.setTilt(30);
    expect(sims[0].targets).toEqual([]);
    v.playing = false;
    v.tick(100);
    await flush();
    expect(sims[0].time).toBe(0);
    let frames = 0;
    v.onFrame = () => frames++;
    v.seek();
    expect(sims[0].destroyed).toBe(true);
    expect(sims[1].preset).toBe('gentle-5');
    expect(v.playing).toBe(true);
    v.restart('manual-5');
    expect(v.preset).toBe('manual-5');
    expect(v.manual).toBe(true);
    v.setTilt(30);
    expect(sims[2].targets).toEqual([30]);
    expect(frames).toBe(2);
  });

  it('resizes, resets the camera, runs its frame loop and disposes everything', () => {
    const { v, renderer, controls, sims, frame } = setup();
    v.resize(800, 400);
    expect(renderer.size).toEqual([800, 400]);
    expect(v.camera.aspect).toBe(2);
    v.resetView();
    expect(controls.wasReset).toBe(true);
    v.start();
    frame(16);
    frame(32);
    expect(renderer.renders).toBe(2);
    v.dispose();
    expect(renderer.disposed && controls.disposed && sims[0].destroyed).toBe(true);
  });
});
