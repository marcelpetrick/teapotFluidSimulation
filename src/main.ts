// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Browser bootstrap: wires the real worker, canvas and browser APIs into the App.

import { App, type WorkerLike } from './ui/app';
import type { Ctx2D } from './render/scene';

const worker = new Worker(new URL('./worker/simulation.worker.ts', import.meta.url), { type: 'module' });

function download(name: string, data: string | Blob): void {
  const a = document.createElement('a');
  const isUrl = typeof data === 'string' && data.startsWith('data:');
  const url = isUrl
    ? (data as string)
    : URL.createObjectURL(typeof data === 'string' ? new Blob([data]) : data);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!isUrl) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const app = new App({
  doc: document,
  worker: worker as unknown as WorkerLike,
  getContext: (c) => c.getContext('2d') as Ctx2D | null,
  schedule: (cb) => requestAnimationFrame(cb),
  now: () => performance.now(),
  location: window.location,
  history: window.history,
  download,
  copy: (t) => navigator.clipboard.writeText(t),
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  version: __APP_VERSION__,
  audio: () => {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Ctor ? new Ctor() : null;
  },
  // Storage can be unavailable (private mode, blocked site data): fail silently.
  prefs: {
    get: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* preference not persisted */
      }
    },
  },
});
app.start();
(window as unknown as { pourlab: App }).pourlab = app;
