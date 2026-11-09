// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Verify the WebGPU 3D solver on this machine's GPU against the CPU reference (docs/plan.md,
// phase F): the full gentle pour at the given cell sizes, compared with benchmarks/run3d.json
// (poured volume within 1 %, layer shares within 2 points, no lost parcels), plus a step-by-step
// comparison from the identical seeded state. Runs headless Chromium on the hardware adapter.
// Usage: npm run build && npx tsx scripts/verify-gpu.ts [cellMm ...] > benchmarks/gpu3d.json
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

interface CpuRow {
  cellMm: number;
  dischargedMl: number;
  lostMl: number;
  dischargedFractions: number[];
  wallSeconds: number;
  simulatedSeconds: number;
}

const cells = process.argv.slice(2).map(Number);
if (cells.length === 0) cells.push(5);
const cpuRows = (JSON.parse(readFileSync('benchmarks/run3d.json', 'utf8')) as { rows: CpuRow[] }).rows;
const server = spawn('node', ['scripts/serve-subpath.mjs', 'dist', '4176', '/teapotFluidSimulation/'], {
  stdio: 'pipe',
});
await new Promise((r) => server.stdout.once('data', r));
try {
  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => process.stderr.write(`[page] ${m.text()}\n`));
  await page.goto('http://127.0.0.1:4176/teapotFluidSimulation/verify-gpu.html');
  await page.waitForFunction(() => 'pourlabGpu' in globalThis, null, { timeout: 60_000 });
  const adapter = await page.locator('#adapter').textContent();
  process.stderr.write(`${adapter}\n`);
  // Passed as strings: tsx would otherwise inject helpers that do not exist in the page.
  const steps = await page.evaluate(`globalThis.pourlabGpu.compare(5, 200)`);
  const rows: unknown[] = [];
  for (const cellMm of cells) {
    const r = (await page.evaluate(`globalThis.pourlabGpu.pour(${cellMm})`)) as {
      dischargedMl: number;
      lostMl: number;
      dischargedFractions: number[];
      realTimeFactor: number;
    };
    const cpu = cpuRows.find((c) => c.cellMm === cellMm);
    const check = cpu && {
      cpuDischargedMl: cpu.dischargedMl,
      cpuFractions: cpu.dischargedFractions,
      cpuRealTimeFactor: cpu.simulatedSeconds / cpu.wallSeconds,
      volumeDifferencePercent: (100 * (r.dischargedMl - cpu.dischargedMl)) / cpu.dischargedMl,
      shareDifferencePoints: r.dischargedFractions.map((f, k) => 100 * (f - cpu.dischargedFractions[k])),
    };
    const pass =
      !!check &&
      Math.abs(check.volumeDifferencePercent) <= 1 &&
      check.shareDifferencePoints.every((d) => Math.abs(d) <= 2) &&
      r.lostMl === 0;
    rows.push({ ...r, comparison: check ?? null, pass });
    process.stderr.write(`${cellMm} mm: ${JSON.stringify({ ...check, rtf: r.realTimeFactor, pass })}\n`);
  }
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        browser: `chromium ${browser.version()}`,
        adapter,
        criteria:
          'poured volume within 1 %, layer shares within 2 points, no lost parcels (docs/plan.md, phase F)',
        stepComparison: steps,
        rows,
      },
      null,
      1,
    ),
  );
  await browser.close();
} finally {
  server.kill();
}
