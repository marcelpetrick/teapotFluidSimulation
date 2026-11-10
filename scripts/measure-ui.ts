// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// Paced redraw cost, including active worker traffic. CPU throttling is not a real phone measurement.
// Usage: npm run build && npx tsx scripts/measure-ui.ts [samples=600] [repetitions=3]
import { chromium, type Browser } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
const samples = Number(process.argv[2] ?? 600);
const repetitions = Number(process.argv[3] ?? 3);
if (!Number.isInteger(samples) || samples < 30 || !Number.isInteger(repetitions) || repetitions < 1)
  throw new Error('Expected integer samples >= 30 and repetitions >= 1');
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
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const c of [
      { name: 'desktop-default', width: 1440, quality: 44, ppc: 2, throttle: 1, phase: 'initial' },
      { name: 'desktop-max', width: 1440, quality: 128, ppc: 4, throttle: 1, phase: 'initial' },
      {
        name: 'desktop-glass-max',
        preset: 'glass-gentle',
        width: 1440,
        quality: 128,
        ppc: 4,
        throttle: 1,
        phase: 'initial',
      },
      { name: 'desktop-pouring', width: 1440, quality: 44, ppc: 2, throttle: 1, phase: 'pouring' },
      { name: 'phone-default-4x-cpu', width: 390, quality: 44, ppc: 2, throttle: 4, phase: 'initial' },
    ]) {
      const page = await browser.newPage({ viewport: { width: c.width, height: 900 } });
      if (c.throttle > 1) {
        const cd = await page.context().newCDPSession(page);
        await cd.send('Emulation.setCPUThrottlingRate', { rate: c.throttle });
      }
      await page.goto(
        `http://127.0.0.1:4181/teapotFluidSimulation/?preset=${'preset' in c ? c.preset : 'teapot-gentle'}&quality=${c.quality}&ppc=${c.ppc}`,
      );
      await page.waitForFunction(
        () => (window as unknown as { pourlab: import('../src/ui/app').App }).pourlab?.info,
      );
      if (c.phase === 'pouring') {
        await page.locator('#pour').click();
        await page.waitForFunction(
          () =>
            ((window as unknown as { pourlab: import('../src/ui/app').App }).pourlab.diagnostics
              ?.volumeDischarged ?? 0) > 50e-6,
          undefined,
          { timeout: 120_000 },
        );
      }
      // Pass plain JS so tsx's function-name helpers cannot leak into the browser context.
      const result = await page.evaluate(`(async () => {
      const app = window.pourlab;
      const median = xs => { const s = [...xs].sort((a,b) => a-b); return (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2; };
      const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 0; i < 60; i++) { app.render(); await nextFrame(); }
      const submit = [], intervals = [];
      let previous = await nextFrame();
      const start = previous;
      const simStart = app.diagnostics.time;
      for (let i = 0; i < ${samples}; i++) {
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
        redrawOpportunitiesPerSecond: ${samples} * 1000 / (previous - start),
        simulatedSecondsAdvanced: app.diagnostics.time - simStart,
        submissionSamplesMs: submit,
        frameIntervalSamplesMs: intervals,
        scrollWidth: document.documentElement.scrollWidth,
      };
    })()`);
      results.push({ repetition, ...c, ...(result as Record<string, unknown>) });
      await page.close();
      process.stderr.write(`${c.name} repetition ${repetition} complete\n`);
    }
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
      samplesPerCase: samples,
      repetitions,
      note: 'Sixty warmup frames, then the configured number of paced redraws. rAF cadence includes event-loop/display scheduling but does not prove GPU completion or real-phone performance. The pouring case includes worker traffic and normal UI updates.',
      results,
    },
    null,
    2,
  ),
);
