// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Lazily loaded entry of the live 3D view: asks for a WebGPU device for the solver, creates the
// WebGL renderer and orbit controls, and starts the live pour. Only loaded on request.

import { WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GpuSimulation3D, requestSolverDevice } from '../gpu3d/solver';
import { liveConfig, LivePourViewer, type LivePreset } from './live';
import type { ViewerTheme } from './viewer';

export async function open3dLive(
  canvas: HTMLCanvasElement,
  theme: ViewerTheme,
  preset: LivePreset,
  gpu: GPU | undefined = (navigator as Navigator & { gpu?: GPU }).gpu,
): Promise<LivePourViewer> {
  if (!gpu) throw new Error('this browser has no WebGPU');
  const { device } = await requestSolverDevice(gpu);
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true });
  } catch {
    device.destroy();
    throw new Error('WebGL is not available in this browser');
  }
  let viewer: LivePourViewer;
  try {
    viewer = new LivePourViewer(
      canvas,
      theme,
      {
        createRenderer: () => renderer,
        createControls: (camera, element) => new OrbitControls(camera, element),
        createSim: (p) => new GpuSimulation3D(device, liveConfig(p)),
        schedule: (cb) => requestAnimationFrame(cb),
        cancel: (id) => cancelAnimationFrame(id),
        now: () => performance.now(),
        pixelRatio: Math.min(2, window.devicePixelRatio || 1),
      },
      preset,
    );
  } catch (error) {
    renderer.dispose();
    device.destroy();
    throw error;
  }
  const dispose = viewer.dispose.bind(viewer);
  viewer.dispose = () => {
    dispose();
    device.destroy();
  };
  viewer.start();
  return viewer;
}
