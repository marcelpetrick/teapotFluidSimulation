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

test('draw a pot in the editor, then tilt it by hand until liquid pours', async ({ page }) => {
  await page.goto('./?preset=teapot-gentle&control=manual&duration=20');
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
  await page.locator('summary', { hasText: 'Draw your own pot' }).click();
  await page.locator('#shape-bowl').click();
  // Drag the lip point a little higher.
  const canvas = page.locator('#shapeCanvas');
  await canvas.scrollIntoViewIfNeeded();
  await page.locator('#shapeUse').click();
  await expect(page).toHaveURL(/vessel=custom/);
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
  await expect(page.locator('#tiltBox')).toBeVisible();
  await page.locator('#pour').click();
  await page.locator('#tiltSlider').fill('55');
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as unknown as { pourlab: { diagnostics: { volumeDischarged: number } } }).pourlab
              .diagnostics.volumeDischarged,
        ),
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThan(50e-6);
  // The exported record contains the manual input history.
  await page.locator('#play').click();
  const [json] = await Promise.all([page.waitForEvent('download'), page.locator('#expJson').click()]);
  const path = await json.path();
  const rec = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'));
  expect(rec.config.vessel.kind).toBe('custom');
  expect(rec.manualInputs.at(-1).targetDeg).toBe(55);
});

test('cyber look is remembered across reloads and the soundscape switches on', async ({ page }) => {
  await page.goto('./?preset=tank-rest');
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
  await page.locator('#mode-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#mode-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#skin').selectOption('cyber');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'cyber');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'cyber');
  await expect(page.locator('#skin')).toHaveValue('cyber');
  await page.locator('#soundToggle').click();
  await expect(page.locator('#soundToggle')).toHaveText('Sound: on');
  await page.locator('#soundToggle').click();
  await expect(page.locator('#soundToggle')).toHaveText('Sound: off');
});

test('the recorded 3D view opens, plays and can be rotated', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
  await page.locator('#open3d').click();
  await expect(page.locator('#v3status')).toHaveText(/Recorded 3D simulation|3D view unavailable/, {
    timeout: 60_000,
  });
  const status = (await page.locator('#v3status').textContent()) ?? '';
  if (status.startsWith('Recorded')) {
    await expect(page.locator('#view3dCanvas')).toBeVisible();
    const t0 = await page.locator('#v3info').textContent();
    await expect(page.locator('#v3info')).not.toHaveText(t0 ?? '', { timeout: 10_000 }); // playback advances
    const box = (await page.locator('#view3dCanvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await page.locator('#v3scrub').fill('60');
    await expect(page.locator('#v3info')).toContainText('poured');
  } else {
    await expect(page.locator('#view3dBox')).toBeHidden();
  }
  expect(errors).toEqual([]);
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

test('phone-width editor supports keyboard and point buttons without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.locator('#shapeBox > summary').click();
  await page.locator('#shape-jug').click();
  await page.locator('#shapeNext').click();
  await expect(page.locator('#shapePoint')).toContainText('Point 1');
  await expect(page.locator('#shapeCanvas')).toBeFocused();
  const position = await page.locator('#shapePoint').textContent();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#shapePoint')).not.toHaveText(position!);
  await page.locator('#shapeAdd').click();
  await expect(page.locator('#shapePoint')).toContainText('Point 2');
  await page.locator('#shapeRemove').click();
  await expect(page.locator('#shapeUse')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
