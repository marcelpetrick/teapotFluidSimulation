// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  configFromSettings,
  defaultProfile,
  fitFillToVessel,
  defaultVessel,
  maxFillHeight,
  parseShape,
  shapeToString,
  validateProfile,
  vesselFromProfile,
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

describe('drawn pots, fill limits, particles and manual control', () => {
  const bowl: [number, number][] = [
    [0.0, 0.1],
    [0.01, 0.04],
    [0.05, 0.005],
    [0.15, 0.005],
    [0.19, 0.04],
    [0.21, 0.1],
  ];

  it('shape strings round-trip in millimetres and reject junk', () => {
    const s = shapeToString(bowl);
    expect(s.startsWith('0,100;10,40')).toBe(true);
    expect(parseShape(s)).toEqual(bowl);
    expect(parseShape('')).toBeNull();
    expect(parseShape('1,2;x,3')).toBeNull();
  });

  it('validates outlines', () => {
    expect(validateProfile(bowl)).toEqual([]);
    expect(validateProfile(bowl.slice(0, 2)).join()).toMatch(/3 to 24/);
    expect(validateProfile([[0, 0]]).join()).toMatch(/3 to 24/);
    expect(validateProfile(bowl.map(([x, y]) => [x * 3, y]) as [number, number][]).join()).toMatch(/wide/);
    expect(validateProfile(bowl.map(([x, y]) => [x, y * 4]) as [number, number][]).join()).toMatch(/high/);
    expect(validateProfile([...bowl].reverse()).join()).toMatch(/back rim/);
    const low = bowl.slice();
    low[low.length - 1] = [0.21, 0.02];
    expect(validateProfile(low).join()).toMatch(/4 cm above/);
  });

  it('turns an outline into a vessel with the inner floor at y = 0 and a lip section', () => {
    const v = vesselFromProfile(bowl);
    expect(v.kind).toBe('custom');
    expect(Math.min(...v.profile!.map((p) => p[1]))).toBeCloseTo(-0.005);
    expect(Math.min(...v.profile!.map((p) => p[0]))).toBeCloseTo(-0.005);
    const built = buildVessel(v);
    expect(built.outflow).not.toBeNull();
    expect(built.cavity).not.toBeNull();
    expect(() => buildVessel({ ...v, profile: [[0, 0]] })).toThrow(/three/);
    expect(() => buildVessel({ ...v, profile: undefined })).toThrow(/three/);
    expect(defaultVessel('custom').kind).toBe('custom');
    expect(defaultProfile().length).toBeGreaterThan(5);
  });

  it('limits the fill to what each pot holds', () => {
    expect(maxFillHeight(defaultVessel('teapot'))).toBeGreaterThan(0.1);
    expect(maxFillHeight(defaultVessel('glass'))).toBeCloseTo(0.125);
    // Rim centreline 9 cm above the inner floor, minus half the wall and a 5 mm margin.
    expect(maxFillHeight(vesselFromProfile(bowl))).toBeCloseTo(0.08);
    const base = settingsFromConfig(presetById('teapot-gentle').build());
    expect(validateSettings({ ...base, fillMl: 2000 }).join()).toMatch(/overflows above/);
    expect(validateSettings({ ...base, vessel: 'custom', shape: 'nonsense' }).join()).toMatch(
      /could not be read/,
    );
    expect(
      validateSettings({ ...base, vessel: 'custom', shape: shapeToString(bowl.slice(0, 2)) }).join(),
    ).toMatch(/3 to 24/);
    expect(validateSettings({ ...base, ppc: 5 }).join()).toMatch(/Particles per cell/);
    expect(validateSettings({ ...base, control: 'joystick' as never }).join()).toMatch(/control mode/);
  });

  it('fits the fill to a small drawn pot', () => {
    const base = settingsFromConfig(presetById('teapot-gentle').build());
    const v = vesselFromProfile(bowl);
    const fit = fitFillToVessel(base, v);
    expect(fit.changed).toBe(true);
    expect(fit.settings.fillMl).toBe(1200);
    expect(fit.settings.targetMl).toBe(400);
    expect(validateSettings({ ...fit.settings, vessel: 'custom', shape: shapeToString(bowl) })).toEqual([]);
    expect(fitFillToVessel({ ...base, fillMl: 500 }, v).changed).toBe(false);
  });

  it('applies particles per cell, drawn shapes and manual control', () => {
    const base = settingsFromConfig(presetById('teapot-gentle').build());
    const c = configFromSettings({
      ...base,
      ppc: 4,
      vessel: 'custom',
      shape: shapeToString(bowl),
      control: 'manual',
      fillMl: 900,
    });
    expect(c.particlesPerCellAxis).toBe(4);
    expect(c.vessel.kind).toBe('custom');
    expect(c.motion.kind).toBe('manual');
    expect(c.motion.targetVolume).toBe(0);
    const back = settingsFromConfig(c);
    expect(back.control).toBe('manual');
    expect(parseShape(back.shape)!.length).toBe(bowl.length);
    const q = settingsFromQuery(
      settingsToQuery({ ...base, vessel: 'custom', shape: shapeToString(bowl), control: 'manual' }),
    );
    expect(q.vessel).toBe('custom');
    expect(q.control).toBe('manual');
    expect(q.shape).toBe(shapeToString(bowl));
    // Unreadable stored shape falls back to the default outline.
    const fallback = configFromSettings({ ...base, vessel: 'custom', shape: '' });
    expect(fallback.vessel.profile!.length).toBe(defaultProfile().length);
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
    const glass = configFromSettings({ ...base, vessel: 'glass' });
    expect(glass.vessel.kind).toBe('glass');
    expect(glass.fillHeight).toBeCloseTo(0.085);
    expect(glass.pivotLocal[0]).toBeCloseTo(0.095);
    const tank = configFromSettings({ ...base, vessel: 'tank' });
    expect(tank.vessel.kind).toBe('tank');
  });
});
