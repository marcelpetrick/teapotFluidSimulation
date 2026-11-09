// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// The WebGPU 3D solver against the CPU reference in a real browser. Chromium runs on the SwiftShader
// software adapter, so the check behaves the same on machines without a GPU (CI).
import { expect, test } from '@playwright/test';

interface Comparison {
  steps: number;
  rmsPositionCells: number;
  maxPositionCells: number;
  relativeVelocityRms: number;
  statusMismatches: number;
  gpu: { pressureFailures: number; lostMl: number; pressureIterations: number };
}

test.use({
  launchOptions: {
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader'],
  },
});

test('matches the CPU solver step by step from the same seeded state', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the WebGPU solver test runs in Chromium');
  const gpuErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') gpuErrors.push(m.text());
  });
  await page.goto('./verify-gpu.html');
  await page.waitForFunction(() => 'pourlabGpu' in globalThis, null, { timeout: 30_000 });
  const r = (await page.evaluate('globalThis.pourlabGpu.compare(10, 20)')) as Comparison;
  expect(gpuErrors).toEqual([]);
  expect(r.steps).toBe(20);
  // f32 GPU arithmetic and a different (converged) preconditioner: far below a cell.
  expect(r.rmsPositionCells).toBeLessThan(1e-3);
  expect(r.maxPositionCells).toBeLessThan(1e-2);
  expect(r.relativeVelocityRms).toBeLessThan(1e-3);
  expect(r.statusMismatches).toBe(0);
  expect(r.gpu.pressureFailures).toBe(0);
  expect(r.gpu.pressureIterations).toBeGreaterThan(0);
  expect(r.gpu.lostMl).toBe(0);
});
