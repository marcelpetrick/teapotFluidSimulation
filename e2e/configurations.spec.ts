// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// End-to-end checks of the most common configurations: each runs a full experiment in the real
// browser (worker, production build) and checks the physical outcome, not just the UI.
import { expect, test } from '@playwright/test';

interface Outcome {
  pouredMl: number;
  spilledMl: number;
  lostMl: number;
  fractions: number[] | null;
  finished: boolean;
}

interface Case {
  preset: string;
  /** Expected poured volume range (mL). */
  poured: [number, number];
  /** Optional upper bound for the bottom-layer share of the poured tea. */
  maxBottomShare?: number;
}

const CASES: Case[] = [
  { preset: 'teapot-gentle', poured: [380, 420] },
  { preset: 'teapot-fast', poured: [380, 420] },
  { preset: 'teapot-slow', poured: [380, 420] },
  { preset: 'glass-gentle', poured: [380, 420], maxBottomShare: 0.02 },
  { preset: 'pitcher-gentle', poured: [380, 420], maxBottomShare: 0.05 },
  { preset: 'teapot-repeat', poured: [380, 420] },
  { preset: 'thermal-stratified', poured: [370, 430] },
  { preset: 'teapot-still', poured: [0, 0] },
  { preset: 'teapot-tilt', poured: [0, 0] },
];

for (const c of CASES) {
  test(`${c.preset}: pours ${c.poured[0]}-${c.poured[1]} mL with nothing spilled or lost`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto(`./?preset=${c.preset}`);
    await expect(page.locator('#status')).toContainText('Ready', { timeout: 30_000 });
    await page.locator('#speed').selectOption('2');
    await page.locator('#pour').click();
    await expect(page.locator('#status')).toContainText('finished', { timeout: 170_000 });
    const o = (await page.evaluate(`(() => {
      const a = window.pourlab;
      const d = a.diagnostics;
      return {
        pouredMl: d.volumeDischarged * 1e6,
        spilledMl: d.volumeSpilled * 1e6,
        lostMl: d.volumeLost * 1e6,
        fractions: a.metrics.composition.dischargedFractions,
        finished: a.finished,
      };
    })()`)) as Outcome;
    expect(o.finished).toBe(true);
    expect(o.pouredMl).toBeGreaterThanOrEqual(c.poured[0]);
    expect(o.pouredMl).toBeLessThanOrEqual(c.poured[1]);
    expect(o.spilledMl).toBe(0);
    expect(o.lostMl).toBe(0);
    if (c.maxBottomShare !== undefined) expect(o.fractions![0]).toBeLessThanOrEqual(c.maxBottomShare);
    if (c.poured[1] > 0) await expect(page.locator('#summary')).toContainText('actual');
  });
}
