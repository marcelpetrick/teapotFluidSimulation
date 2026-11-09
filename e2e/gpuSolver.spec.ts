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

test('runs the 3D pour live in the page and labels it as live', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the live WebGPU view is tested in Chromium');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?preset=tank-rest');
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
  await page.locator('#open3dLive').click();
  await expect(page.locator('#v3status')).toContainText('Live 3D simulation, computed now on your GPU', {
    timeout: 30_000,
  });
  // Software rendering is slow, but simulated time must advance.
  await expect(page.locator('#v3info')).toContainText(/^Live: .*t = 0\.[1-9]/, { timeout: 60_000 });
  await expect(page.locator('#v3scrub')).toBeHidden();
  await page.locator('#v3preset').selectOption('manual-5');
  await expect(page.locator('#v3tilt')).toBeVisible();
  await page.locator('#open3d').click();
  await expect(page.locator('#v3status')).toContainText('Recorded 3D simulation', { timeout: 30_000 });
  expect(errors).toEqual([]);
});
