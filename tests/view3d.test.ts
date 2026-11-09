// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// @vitest-environment happy-dom
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { decodeRecording, encodeRecording, gunzip, type RecordingHeader } from '../src/view3d/format';
import { PourViewer, type ControlsLike, type RendererLike } from '../src/view3d/viewer';
import { defaultTeapot3D } from '../src/sim3d/vessel3d';

function header(frames: number, parcels: number): RecordingHeader {
  return {
    version: 1,
    frames,
    parcels,
    fps: 10,
    quantum: 0.00025,
    cellMm: 5,
    simulatedParcels: parcels * 3,
    teapot: defaultTeapot3D(),
    pivot: [0, 0.06],
    pivotWorld: [0.2, 0.2],
    zOffset: 0.005,
    domain: [0.4, 0.4, 0.08],
    angles: Array.from({ length: frames }, (_, k) => k * 10),
    poured: Array.from({ length: frames }, (_, k) => [k, 2 * k, 3 * k]),
    finalShares: [0.3, 0.5, 0.2],
    label: 'test',
  };
}

function sample(frames = 3, P = 4) {
  const h = header(frames, P);
  const origin = Uint8Array.from({ length: P }, (_, k) => k % 3);
  const fr = Array.from({ length: frames }, (_, k) =>
    Float32Array.from({ length: 3 * P }, (_, i) => 0.1 + 0.01 * k + 0.001 * i),
  );
  return { h, origin, fr };
}

describe('recording format', () => {
  it('round-trips through encode, gzip and decode within the quantum', async () => {
    const { h, origin, fr } = sample();
    const raw = encodeRecording(h, origin, fr);
    const gz = gzipSync(raw);
    const back = decodeRecording(await gunzip(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)));
    expect(back.header.frames).toBe(3);
    expect(Array.from(back.origin)).toEqual(Array.from(origin));
    for (let k = 0; k < 3; k++)
      for (let i = 0; i < fr[k].length; i++)
        expect(Math.abs(back.positions[k][i] - fr[k][i])).toBeLessThan(h.quantum);
  });

  it('clamps out-of-range positions and huge jumps consistently', () => {
    const h = header(2, 1);
    const fr = [Float32Array.from([-1, 0.1, 0.1]), Float32Array.from([100, 0.1, 0.1])];
    const back = decodeRecording(encodeRecording(h, new Uint8Array(1), fr));
    expect(back.positions[0][0]).toBe(0); // clamped at 0
    expect(back.positions[1][0]).toBeCloseTo(32767 * h.quantum, 6); // delta clamped to int16
  });

  it('rejects unknown versions', () => {
    const { h, origin, fr } = sample();
    const raw = encodeRecording({ ...h, version: 2 as 1 }, origin, fr);
    expect(() => decodeRecording(raw)).toThrow(/Unsupported/);
  });
});

function fakes() {
  const calls: string[] = [];
  const renderer: RendererLike = {
    setSize: () => calls.push('setSize'),
    setPixelRatio: () => calls.push('pixelRatio'),
    setClearColor: () => calls.push('clear'),
    render: () => calls.push('render'),
    dispose: () => calls.push('disposeRenderer'),
  };
  const controls: ControlsLike = {
    target: new Vector3(),
    enableDamping: false,
    update: () => calls.push('controlsUpdate'),
    saveState: () => calls.push('save'),
    reset: () => calls.push('resetView'),
    dispose: () => calls.push('disposeControls'),
  };
  let scheduled: ((t: number) => void) | null = null;
  return {
    calls,
    deps: {
      createRenderer: () => renderer,
      createControls: () => controls,
      schedule: (cb: (t: number) => void) => {
        scheduled = cb;
        return 7;
      },
      cancel: (id: number) => calls.push(`cancel ${id}`),
      pixelRatio: 2,
    },
    fire: (t: number) => scheduled?.(t),
  };
}

const theme = {
  background: '#000000',
  wall: '#7df9ff',
  layers: ['#2e6bff', '#28b030', '#b04bff'] as [string, string, string],
};

describe('PourViewer', () => {
  it('interpolates frames, mirrors the half pot, hides fallen parcels and tilts the pot', () => {
    const { h, origin, fr } = sample(3, 4);
    fr[1][1] = 0; // parcel 0 falls out at frame 1
    const rec = decodeRecording(encodeRecording(h, origin, fr));
    const f = fakes();
    const v = new PourViewer(document.createElement('canvas'), rec, theme, f.deps);
    expect(f.calls).toContain('save');
    expect(v.frames).toBe(3);
    v.seek(0.5);
    const pos = v.scene.children.find((c) => c.type === 'Points')!;
    const arr = (
      pos as unknown as { geometry: { getAttribute: (n: string) => { array: Float32Array } } }
    ).geometry.getAttribute('position').array;
    expect(arr[0]).toBeCloseTo((rec.positions[0][0] + rec.positions[1][0]) / 2, 5);
    // Mirror image of parcel 1 across z = zOffset.
    expect(arr[3 * (1 + 4) + 2]).toBeCloseTo(2 * h.zOffset - arr[3 * 1 + 2], 6);
    v.seek(1);
    expect(arr[1]).toBe(-100); // hidden
    expect(v.angleDeg()).toBe(10);
    expect(v.poured()).toEqual([1, 2, 3]);
    expect(v.time).toBeCloseTo(0.1);
    v.seek(99);
    expect(v.frame).toBe(2);
    v.resize(800, 400);
    expect(v.camera.aspect).toBe(2);
    v.applyTheme({ ...theme, background: '#ffffff' });
    v.resetView();
    expect(f.calls).toContain('resetView');
  });

  it('plays, holds at the end, loops, renders every tick and disposes', () => {
    const { h, origin, fr } = sample(3, 2);
    const v = new PourViewer(
      document.createElement('canvas'),
      decodeRecording(encodeRecording(h, origin, fr)),
      theme,
      fakes().deps,
    );
    const seen: number[] = [];
    v.onFrame = (k) => seen.push(k);
    v.tick(100, 0); // +1 frame at 10 fps
    expect(v.frame).toBeCloseTo(1);
    v.tick(1000, 100);
    expect(v.frame).toBe(2); // clamped at the end
    v.tick(16, 200); // starts the hold
    v.tick(16, 1000);
    expect(v.frame).toBe(2);
    v.tick(16, 1800); // hold over: loop
    expect(v.frame).toBe(0);
    v.playing = false;
    v.tick(500, 2000);
    expect(v.frame).toBe(0);
    expect(seen.length).toBeGreaterThan(2);
    const f = fakes();
    const w = new PourViewer(
      document.createElement('canvas'),
      decodeRecording(encodeRecording(h, origin, fr)),
      theme,
      f.deps,
    );
    w.start();
    f.fire(0);
    f.fire(50);
    expect(f.calls.filter((c) => c === 'render').length).toBe(2);
    w.dispose();
    expect(f.calls).toContain('cancel 7');
    expect(f.calls).toContain('disposeRenderer');
  });
});
