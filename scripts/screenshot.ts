// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Capture the README screenshot (docs/screenshot.png) from the production build mid-pour.
// Usage: npm run build && npx tsx scripts/screenshot.ts [outFile] [lab|cyber]
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'docs/screenshot.png';
const skin = process.argv[3] ?? 'lab';
const server = spawn('node', ['scripts/serve-subpath.mjs', 'dist', '4174', '/teapotFluidSimulation/'], {
  stdio: 'pipe',
});
await new Promise((r) => server.stdout.once('data', r));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:4174/teapotFluidSimulation/?preset=teapot-gentle');
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Ready'));
  await page.locator('#skin').selectOption(skin);
  await page.locator('#pour').click();
  // Stop when roughly 300 mL have left so the stream, glass and charts are all visible.
  await page.waitForFunction(
    () => {
      const app = (window as unknown as { pourlab: { diagnostics: { volumeDischarged: number } | null } })
        .pourlab;
      return (app.diagnostics?.volumeDischarged ?? 0) > 300e-6;
    },
    undefined,
    { timeout: 120_000 },
  );
  await page.locator('#play').click();
  await page.locator('#diagToggle').check();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log(`wrote ${out}`);
} finally {
  server.kill();
}
