// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Lazily loaded entry of the 3D view: fetches and decodes the recording, creates the WebGL
// renderer and orbit controls, and starts playback. Only loaded when the user opens the 3D view.

import { WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { decodeRecording, gunzip } from './format';
import { PourViewer, type ViewerTheme } from './viewer';

export async function open3d(
  canvas: HTMLCanvasElement,
  theme: ViewerTheme,
  url: string,
): Promise<PourViewer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`recording not found (${res.status})`);
  const rec = decodeRecording(await gunzip(await res.arrayBuffer()));
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true });
  } catch {
    throw new Error('WebGL is not available in this browser');
  }
  const viewer = new PourViewer(canvas, rec, theme, {
    createRenderer: () => renderer,
    createControls: (camera, element) => new OrbitControls(camera, element),
    schedule: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
    pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  });
  viewer.start();
  return viewer;
}
