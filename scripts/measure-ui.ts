// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// UI-only redraw cost; the simulation is paused. CPU throttling is not a real phone measurement.
// Usage: npm run build && npx tsx scripts/measure-ui.ts
import { chromium, type Browser } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
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
    { name: 'desktop-default', width: 1440, quality: 44, ppc: 2, throttle: 1, phase: 'initial' },
    { name: 'desktop-max', width: 1440, quality: 128, ppc: 4, throttle: 1, phase: 'initial' },
    { name: 'desktop-pouring', width: 1440, quality: 44, ppc: 2, throttle: 1, phase: 'pouring' },
    { name: 'phone-default-4x-cpu', width: 390, quality: 44, ppc: 2, throttle: 4, phase: 'initial' },
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
    if (c.phase === 'pouring') {
      await page.locator('#pour').click();
      await page.waitForFunction(
        () =>
          ((window as unknown as { pourlab: import('../src/ui/app').App }).pourlab.diagnostics
            ?.volumeDischarged ?? 0) > 50e-6,
      );
    }
    // Pass plain JS so tsx's function-name helpers cannot leak into the browser context.
    const result = await page.evaluate(`(async () => {
      const app = window.pourlab;
      const median = xs => { const s = [...xs].sort((a,b) => a-b); return (s[14] + s[15]) / 2; };
      const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 0; i < 5; i++) { app.render(); await nextFrame(); }
      const submit = [], intervals = [];
      let previous = await nextFrame();
      const start = previous;
      const simStart = app.diagnostics.time;
      for (let i = 0; i < 30; i++) {
        const before = performance.now();
        app.render();
        submit.push(performance.now() - before);
        const now = await nextFrame();
        intervals.push(now - previous);
        previous = now;
      }
      const sorted = [...intervals].sort((a,b) => a-b);
      return {
        appVersion: document.querySelector('#version').textContent,
        parcels: app.info.n,
        renderMedianMs: median(submit),
        renderMaxMs: Math.max(...submit),
        frameIntervalMedianMs: median(intervals),
        frameIntervalP95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1],
        redrawOpportunitiesPerSecond: 30 * 1000 / (previous - start),
        simulatedSecondsAdvanced: app.diagnostics.time - simStart,
        submissionSamplesMs: submit,
        frameIntervalSamplesMs: intervals,
        scrollWidth: document.documentElement.scrollWidth,
      };
    })()`);
    results.push({ ...c, ...(result as Record<string, unknown>) });
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
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTreeChanges: Boolean(
        execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts/measure-ui.ts'], {
          encoding: 'utf8',
        }).trim(),
      ),
      cpu: cpus()[0]?.model,
      platform: platform(),
      osRelease: release(),
      node: process.version,
      note: 'Five warmup frames, then 30 paced redraws. rAF cadence includes event-loop/display scheduling but does not prove GPU completion or real-phone performance. The pouring case includes worker traffic and normal UI updates.',
      results,
    },
    null,
    2,
  ),
);
