// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Measure rendered frames per second and simulated-time throughput of the default pour in
// headless Chromium and Firefox against the production build (vision §11 performance gate).
// Usage: npm run build && npx tsx scripts/measure-browser.ts
import { spawn } from 'node:child_process';
import { chromium, firefox } from '@playwright/test';

const server = spawn('node', ['scripts/serve-subpath.mjs', 'dist', '4175', '/teapotFluidSimulation/'], {
  stdio: 'pipe',
});
await new Promise((r) => server.stdout.once('data', r));
const results: Record<string, unknown>[] = [];
try {
  for (const [name, type] of [
    ['chromium', chromium],
    ['firefox', firefox],
  ] as const) {
    const browser = await type.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto('http://127.0.0.1:4175/teapotFluidSimulation/?preset=teapot-gentle');
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Ready'));
    const version = browser.version();
    await page.locator('#pour').click();
    // Passed as a string: tsx would otherwise inject helpers that do not exist in the page.
    const m = (await page.evaluate(`(async () => {
      const app = window.pourlab;
      let frames = 0, lastSim = -1, simUpdates = 0;
      const t0 = performance.now();
      const sim0 = app.diagnostics.time;
      await new Promise((resolve) => {
        const f = () => {
          frames++;
          if (app.diagnostics.time !== lastSim) { simUpdates++; lastSim = app.diagnostics.time; }
          if (performance.now() - t0 < 6000) requestAnimationFrame(f); else resolve();
        };
        requestAnimationFrame(f);
      });
      const wall = (performance.now() - t0) / 1000;
      return { rafFps: frames / wall, simFramesPerSecond: simUpdates / wall, simPerWall: (app.diagnostics.time - sim0) / wall };
    })()`)) as Record<string, number>;
    results.push({ browser: name, version, ...m });
    await browser.close();
  }
} finally {
  server.kill();
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 1));
