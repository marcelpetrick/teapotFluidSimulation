// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// The GPU check page loads in every browser and says whether WebGPU is available.
import { expect, test } from '@playwright/test';

test.describe('GPU check page', () => {
  test('loads in every browser and explains what it found', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('./verify-gpu.html');
    await expect(page.locator('#adapter')).not.toHaveText('Looking for a WebGPU adapter...', {
      timeout: 30_000,
    });
    await expect(page.locator('#adapter')).toContainText(/WebGPU/);
    expect(errors).toEqual([]);
  });
});
