// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// @vitest-environment happy-dom
//
// The lazily loaded live-3D entry: WebGPU device, WebGL renderer, controls and solver wiring
// (with a fake GPU, a stand-in renderer and stand-in orbit controls).
import { describe, expect, it, vi } from 'vitest';
import { fakeGpu } from './fakeGpu';

const state = vi.hoisted(() => ({ failWebGL: false, renders: 0 }));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class WebGLRenderer {
    constructor() {
      if (state.failWebGL) throw new Error('no context');
    }
    setSize() {}
    setPixelRatio() {}
    setClearColor() {}
    render() {
      state.renders++;
    }
    dispose() {}
  }
  return { ...three, WebGLRenderer };
});

vi.mock('three/examples/jsm/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three');
  return {
    OrbitControls: class {
      target = new Vector3();
      enableDamping = false;
      update() {}
      saveState() {}
      reset() {}
      dispose() {}
    },
  };
});

const { open3dLive } = await import('../src/view3d/loadLive');

const theme = {
  background: '#fff',
  wall: '#333',
  layers: ['#00f', '#0f0', '#f00'] as [string, string, string],
};

function gpuFor(g: ReturnType<typeof fakeGpu>, destroyed: { n: number }) {
  (g.device as unknown as { destroy: () => void }).destroy = () => destroyed.n++;
  return {
    requestAdapter: async () => ({
      limits: g.device.limits,
      info: { vendor: 'fake' },
      requestDevice: async () => g.device,
    }),
  } as unknown as GPU;
}

describe('open3dLive', () => {
  it('needs WebGPU', async () => {
    await expect(open3dLive(document.createElement('canvas'), theme, 'gentle-5', undefined)).rejects.toThrow(
      'this browser has no WebGPU',
    );
  });

  it('releases the device when WebGL is missing', async () => {
    state.failWebGL = true;
    const destroyed = { n: 0 };
    await expect(
      open3dLive(document.createElement('canvas'), theme, 'gentle-5', gpuFor(fakeGpu(), destroyed)),
    ).rejects.toThrow('WebGL is not available in this browser');
    expect(destroyed.n).toBe(1);
    state.failWebGL = false;
  });

  it('starts the live run on the GPU solver and renders frames', async () => {
    const g = fakeGpu();
    const v = await open3dLive(document.createElement('canvas'), theme, 'manual-5', gpuFor(g, { n: 0 }));
    expect(v.preset).toBe('manual-5');
    expect(g.calls).toContain('module:solver');
    await new Promise((r) => setTimeout(r, 60));
    expect(state.renders).toBeGreaterThan(0);
    v.dispose();
  });
});
