// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { defaultVessel } from '../src/sim/config';
import {
  dischargeBins,
  mixingReport,
  originComposition,
  regionMatrix,
  segregation,
  summarize,
  type ParcelState,
} from '../src/sim/metrics';
import { buildVessel, makePose } from '../src/sim/vessel';
import { STATUS_DISCHARGED, STATUS_IN_POT, STATUS_LOST, STATUS_SPILLED } from '../src/sim/types';

/** 3 layers x 40 parcels on a 0.16 x 0.09 m grid in an upright teapot (identity pose). */
function state(): ParcelState & {
  status: Uint8Array;
  x: Float64Array;
  y: Float64Array;
  origin: Uint8Array;
  initiallyInSpout: Uint8Array;
} {
  const n = 120;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const origin = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const k = Math.floor(p / 40);
    origin[p] = k;
    // Offsets keep every parcel well away from sampling-bin boundaries.
    x[p] = 0.0113 + ((p % 40) % 10) * 0.015;
    y[p] = 0.0063 + k * 0.03 + Math.floor((p % 40) / 10) * 0.0075;
  }
  return {
    n,
    x,
    y,
    x0: Float32Array.from(x),
    y0: Float32Array.from(y),
    origin,
    status: new Uint8Array(n),
    initiallyInSpout: new Uint8Array(n),
    dischargeOrder: [],
    parcelVolume: 1e-5,
    bandEdges: [0.03, 0.06],
    initialBandCounts: [40, 40, 40],
    vessel: buildVessel(defaultVessel('teapot')),
    pose: makePose(0, 0, [0, 0], [0, 0]),
  };
}

describe('origin composition', () => {
  it('is undefined before discharge and correct after', () => {
    const s = state();
    const c0 = originComposition(s);
    expect(c0.dischargedFractions).toBeNull();
    expect(c0.bias).toBeNull();
    expect(c0.initialFractions).toEqual([1 / 3, 1 / 3, 1 / 3]);
    // Pour 6 bottom parcels and 2 top ones.
    for (const p of [0, 1, 2, 3, 4, 5, 80, 81]) {
      s.status[p] = STATUS_DISCHARGED;
      s.dischargeOrder.push(p);
    }
    s.initiallyInSpout[0] = 1;
    const c = originComposition(s);
    expect(c.dischargedFractions).toEqual([0.75, 0, 0.25]);
    expect(c.bias![0]).toBeCloseTo(2.25);
    expect(c.bias![1]).toBe(0);
    expect(c.dischargedVolume).toBeCloseTo(8e-5);
    expect(c.dischargedFromSpout).toBeCloseTo(1e-5);
  });

  it('handles an empty category', () => {
    const s = state();
    s.initialBandCounts = [80, 0, 40];
    s.dischargeOrder.push(0);
    expect(originComposition(s).bias![1]).toBeNull();
  });

  it('bins discharge by volume and keeps the partial bin', () => {
    const s = state();
    for (let p = 0; p < 13; p++) s.dischargeOrder.push(p);
    const bins = dischargeBins(s, 5e-5); // 5 parcels per bin
    expect(bins).toHaveLength(3);
    expect(bins[2].partial).toBe(true);
    expect(bins[0].partial).toBe(false);
    expect(bins[2].byOrigin[0]).toBeCloseTo(3e-5);
    const total = bins.reduce((a, b) => a + b.byOrigin.reduce((x, y) => x + y, 0), 0);
    expect(total).toBeCloseTo(13e-5);
  });
});

describe('region matrix', () => {
  it('rows sum to one and destinations include ledger states', () => {
    const s = state();
    s.status[0] = STATUS_DISCHARGED;
    s.status[1] = STATUS_SPILLED;
    s.status[2] = STATUS_LOST;
    // Move one parcel into the spout channel.
    s.x[3] = 0.2;
    s.y[3] = 0.075;
    const m = regionMatrix(s, ['bottom', 'middle', 'top']);
    expect(m.columns).toEqual([
      'bottom zone',
      'middle zone',
      'top zone',
      'spout',
      'discharged',
      'spilled',
      'lost',
    ]);
    for (const row of m.fractions) expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(m.volumes[0][3]).toBeCloseTo(1e-5);
    expect(m.volumes[0][4]).toBeCloseTo(1e-5);
    expect(m.volumes[0][5]).toBeCloseTo(1e-5);
    expect(m.volumes[0][6]).toBeCloseTo(1e-5);
    expect(m.fractions[1][1]).toBe(1);
  });

  it('empty rows normalise to zero', () => {
    const s = state();
    s.initialBandCounts = [40, 40, 40, 0];
    const m = regionMatrix(s, ['a', 'b', 'c', 'd']);
    expect(m.fractions[3].every((v) => v === 0)).toBe(true);
  });
});

describe('segregation', () => {
  it('layered state is segregated; a perfectly interleaved state is not', () => {
    const s = state();
    const layered = segregation(s, () => true, 0.03, false, 4);
    expect(layered.S).not.toBeNull();
    expect(layered.S!).toBeGreaterThan(0.2); // max for 3 equal classes is 2/3
    // Interleave labels so every bin holds all three equally.
    for (let p = 0; p < s.n; p++) s.origin[p] = p % 3;
    const mixed = segregation(s, () => true, 0.2, false, 4);
    expect(mixed.S!).toBeLessThan(0.01);
    expect(mixed.pbar.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('reports exclusions and returns null when no bin qualifies', () => {
    const s = state();
    const r = segregation(s, () => true, 0.001, true, 4);
    expect(r.S).toBeNull();
    expect(r.excludedFraction).toBe(1);
    const none = segregation(s, () => false, 0.02, true);
    expect(none.S).toBeNull();
    expect(none.excludedFraction).toBe(0);
  });

  it('survivor cohort separates removal from mixing', () => {
    const s = state();
    // Pour away the whole top layer; nothing moves. Remaining-liquid S changes only by selection,
    // and the survivor cohort shows identical initial and current segregation (no mixing).
    for (let p = 80; p < 120; p++) {
      s.status[p] = STATUS_DISCHARGED;
      s.dischargeOrder.push(p);
    }
    const m = mixingReport(s, [0.03]);
    expect(m.survivorCount).toBe(80);
    expect(m.survivorNow[0]).toBeCloseTo(m.survivorInitial[0]!, 12);
    expect(m.initialAll[0]).not.toBeCloseTo(m.remainingNow[0]!, 3);
  });
});

describe('summary text', () => {
  it('covers no-discharge, discharge and mixing verdicts', () => {
    const s = state();
    const names = ['bottom', 'middle', 'top'];
    expect(summarize(originComposition(s), mixingReport(s), names, 400)[0]).toMatch(/No liquid/);
    for (let p = 0; p < 4; p++) s.dischargeOrder.push(p);
    const lines = summarize(originComposition(s), mixingReport(s), names, 400);
    expect(lines.join(' ')).toMatch(/100% bottom/);
    expect(lines.join(' ')).toMatch(/Target 400 mL/);
    expect(lines.join(' ')).toMatch(/stayed largely layered/);
    // Mixed survivors: shuffle positions so labels are interleaved now.
    for (let p = 0; p < s.n; p++) {
      const slot = (p % 40) * 3 + Math.floor(p / 40); // neighbouring slots hold different layers
      s.x[p] = 0.0113 + (slot % 10) * 0.015;
      s.y[p] = 0.0063 + Math.floor(slot / 10) * 0.0075;
    }
    const mixedLines = summarize(originComposition(s), mixingReport(s), names, 0);
    expect(mixedLines.join(' ')).toMatch(/rearranged/);
    expect(mixedLines.join(' ')).not.toMatch(/Target/);
  });

  it('labels partial rearrangement', () => {
    const comp = {
      initialFractions: [1],
      dischargedFractions: null,
      bias: null,
      dischargedVolume: 0,
      dischargedByOrigin: [0],
      dischargedFromSpout: 0,
    };
    const mix = {
      scales: [0.01, 0.02, 0.04],
      remainingNow: [0, 0, 0],
      initialAll: [0, 0, 0],
      survivorInitial: [0, 1, 0],
      survivorNow: [0, 0.6, 0],
      survivorCount: 1,
      survivorComposition: [1],
      excludedFraction: [0, 0, 0],
    };
    expect(summarize(comp, mix, ['x'], 0).join(' ')).toMatch(/partly rearranged/);
  });
});

void STATUS_IN_POT;
