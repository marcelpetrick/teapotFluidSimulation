// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// UI-only redraw cost; the simulation is paused. CPU throttling is not a real phone measurement.
// Usage: npm run build && npx tsx scripts/measure-ui.ts
import { chromium, type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
const server = spawn('node', ['scripts/serve-subpath.mjs', 'dist', '4181', '/teapotFluidSimulation/'], {
  stdio: 'pipe',
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.once('exit', (code) => reject(new Error(`Server exited: ${code}`)));
  server.stdout.once('data', () => resolve());
});
let browser: Browser | undefined;
const results = [];
let version: string;
try {
  browser = await chromium.launch();
  version = browser.version();
  for (const c of [
    { name: 'desktop-default', width: 1440, quality: 44, ppc: 2, throttle: 1 },
    { name: 'desktop-max', width: 1440, quality: 128, ppc: 4, throttle: 1 },
    { name: 'phone-default-4x-cpu', width: 390, quality: 44, ppc: 2, throttle: 4 },
  ]) {
    const page = await browser.newPage({ viewport: { width: c.width, height: 900 } });
    if (c.throttle > 1) {
      const cd = await page.context().newCDPSession(page);
      await cd.send('Emulation.setCPUThrottlingRate', { rate: c.throttle });
    }
    await page.goto(`http://127.0.0.1:4181/teapotFluidSimulation/?quality=${c.quality}&ppc=${c.ppc}`);
    await page.waitForFunction(
      () => (window as unknown as { pourlab: import('../src/ui/app').App }).pourlab?.info,
    );
    const result = await page.evaluate(async () => {
      const a = (window as unknown as { pourlab: import('../src/ui/app').App }).pourlab;
      const samples: number[] = [];
      const f = a.render.bind(a);
      for (let i = 0; i < 10; i++) {
        const t = performance.now();
        f();
        samples.push(performance.now() - t);
      }
      samples.sort((a, b) => a - b);
      return {
        parcels: a.info!.n,
        renderMedianMs: samples[5],
        renderMaxMs: samples[9],
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    results.push({ ...c, ...result });
    await page.close();
  }
} finally {
  await browser?.close();
  server.kill();
}
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      browser: version,
      note: 'Paused redraws; maximum count is 128 cells with 16 parcels per cell. Throttling emulates a slower CPU only.',
      results,
    },
    null,
    2,
  ),
);
