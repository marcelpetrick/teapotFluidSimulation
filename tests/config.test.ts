// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  configFromSettings,
  fitDomain,
  presetById,
  settingsFromConfig,
  settingsFromQuery,
  settingsToQuery,
  validateSettings,
} from '../src/sim/config';
import { buildVessel, localToWorld, makePose } from '../src/sim/vessel';

describe('presets', () => {
  it('every preset builds a valid configuration whose settings validate', () => {
    for (const p of PRESETS) {
      const c = p.build();
      expect(c.presetId).toBe(p.id);
      expect(validateSettings(settingsFromConfig(c))).toEqual([]);
    }
    expect(presetById('nope').id).toBe(PRESETS[0].id);
  });

  it('the fitted domain contains the vessel at every angle of the motion', () => {
    const c = fitDomain(presetById('teapot-fast').build());
    const v = buildVessel(c.vessel);
    const w = new Float64Array(2);
    for (let a = 0; a <= c.motion.maxAngleDeg; a += 5) {
      const pose = makePose((-a * Math.PI) / 180, 0, c.pivotLocal, c.pivotWorld);
      for (const pl of v.polylines)
        for (const [x, y] of pl) {
          localToWorld(pose, x, y, w);
          expect(w[0]).toBeGreaterThan(0);
          expect(w[1]).toBeGreaterThan(0);
          expect(w[0]).toBeLessThan(c.domainWidth);
          expect(w[1]).toBeLessThan(c.domainHeight);
        }
    }
  });
});

describe('settings', () => {
  it('round-trip through the URL query', () => {
    const s = settingsFromConfig(presetById('pitcher-gentle').build());
    s.seed = 99;
    s.transfer = 'apic';
    s.thermal = 'passive';
    const back = settingsFromQuery(settingsToQuery(s));
    expect(back).toEqual(s);
  });

  it('ignore junk in the query', () => {
    const s = settingsFromQuery('preset=teapot-gentle&seed=abc&vessel=bucket&transfer=x&thermal=y&fillMl=');
    const d = settingsFromConfig(presetById('teapot-gentle').build());
    expect(s).toEqual(d);
  });

  it('validation reports each problem', () => {
    const s = settingsFromConfig(presetById('teapot-gentle').build());
    expect(validateSettings({ ...s, holdAngle: 500 })[0]).toMatch(/Hold angle/);
    expect(validateSettings({ ...s, seed: NaN })[0]).toMatch(/Seed must be a number/);
    expect(validateSettings({ ...s, quality: 50 }).join()).toMatch(/Resolution/);
    expect(validateSettings({ ...s, targetMl: 900, fillMl: 900 }).join()).toMatch(/smaller than the fill/);
    expect(validateSettings({ ...s, vessel: 'bucket' as never }).join()).toMatch(/vessel/);
    expect(validateSettings({ ...s, transfer: 'sph' as never }).join()).toMatch(/transfer/);
    expect(validateSettings({ ...s, thermal: 'hot' as never }).join()).toMatch(/thermal/);
  });

  it('apply onto presets, including vessel changes and tilt-only motion', () => {
    const base = settingsFromConfig(presetById('teapot-gentle').build());
    const c = configFromSettings({
      ...base,
      vessel: 'pitcher',
      fillMl: 1200,
      targetMl: 300,
      holdAngle: 30,
    });
    expect(c.vessel.kind).toBe('pitcher');
    expect(c.vessel.innerHeight).toBeCloseTo(0.13);
    expect(c.initialVolume).toBeCloseTo(1.2e-3);
    expect(c.fillHeight).toBeCloseTo(0.08);
    expect(c.motion.targetVolume).toBeCloseTo(3e-4);
    const t = configFromSettings({ ...settingsFromConfig(presetById('teapot-tilt').build()), holdAngle: 6 });
    expect(t.motion.maxAngleDeg).toBe(6);
    expect(t.motion.targetVolume).toBe(0);
    const tank = configFromSettings({ ...base, vessel: 'tank' });
    expect(tank.vessel.kind).toBe('tank');
  });
});
