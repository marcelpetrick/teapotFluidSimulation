// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { expect, test } from '@playwright/test';

test('loads under the Pages sub-path and pours from the worker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?preset=teapot-gentle&duration=4');
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
  await expect(page.locator('#pour')).toHaveText('Pour 400 mL');
  await page.locator('#speed').selectOption('2');
  await page.locator('#pour').click();
  await expect(page.locator('#status')).toContainText('finished', { timeout: 90_000 });
  const poured = await page.evaluate(
    () =>
      (window as unknown as { pourlab: { diagnostics: { volumeDischarged: number } } }).pourlab.diagnostics
        .volumeDischarged * 1e6,
  );
  expect(poured).toBeGreaterThan(300);
  await expect(page.locator('#summary')).toContainText('Of ');
  await expect(page.locator('#comparison')).toContainText('Gentle 400 mL pour');
  expect(errors).toEqual([]);
});

test('settings validate, apply to the URL, and survive reload', async ({ page }) => {
  await page.goto('./?preset=tank-rest');
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
  await page.locator('#set-holdAngle').fill('500');
  await page.locator('#settings button[type=submit]').click();
  await expect(page.locator('#errors')).toContainText('Hold angle');
  await page.locator('#set-holdAngle').fill('12');
  await page.locator('summary', { hasText: 'Numerics' }).click();
  await page.locator('#set-seed').fill('7');
  await page.locator('#settings button[type=submit]').click();
  await expect(page.locator('#errors')).toHaveText('');
  await expect(page).toHaveURL(/seed=7/);
  await page.reload();
  await expect(page.locator('#set-seed')).toHaveValue('7');
});

test('step, scrub, exports and view toggles work', async ({ page }) => {
  await page.goto('./?preset=tank-tilt&duration=2');
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
  await page.locator('#step').click();
  await expect(page.locator('#status')).toContainText('t = 0.02');
  await page.locator('#play').click();
  await expect(page.locator('#status')).toContainText('finished', { timeout: 90_000 });
  await expect(page.locator('#scrub')).toBeEnabled();
  await page.locator('#scrub').fill('0');
  await expect(page.locator('#scrubTime')).toContainText('stored frame');
  for (const id of ['#arrows', '#markers']) await page.locator(id).check();
  await page.locator('#mode').selectOption('speed');
  const [json] = await Promise.all([page.waitForEvent('download'), page.locator('#expJson').click()]);
  expect(json.suggestedFilename()).toMatch(/^pourlab-tank-tilt-seed1.*\.json$/);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.locator('#expCsv').click()]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  const [png] = await Promise.all([page.waitForEvent('download'), page.locator('#expPng').click()]);
  expect(png.suggestedFilename()).toBe('pourlab-view.png');
});
