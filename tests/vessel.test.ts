// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { defaultVessel } from '../src/sim/config';
import {
  buildVessel,
  crossesSection,
  exactSdf,
  localToWorld,
  makePose,
  pointInPolygon,
  vesselSdf,
  vesselSdfGrad,
  worldToLocal,
} from '../src/sim/vessel';
import { createRng } from '../src/sim/rng';

describe('vessel geometry', () => {
  it('tank SDF is negative inside walls and positive in the cavity', () => {
    const v = buildVessel(defaultVessel('tank'));
    expect(v.outflow).toBeNull();
    expect(vesselSdf(v, 0.08, 0.05)).toBeGreaterThan(0.02);
    expect(vesselSdf(v, -0.005, 0.08)).toBeLessThan(0); // inside left wall
    expect(vesselSdf(v, 0.08, -0.005)).toBeLessThan(0); // inside floor
    // Inner wall face at x = 0 is the zero level set.
    expect(Math.abs(vesselSdf(v, 0, 0.08))).toBeLessThan(1e-9);
  });

  it('gradient points away from the solid', () => {
    const v = buildVessel(defaultVessel('tank'));
    const g = new Float64Array(2);
    const d = vesselSdfGrad(v, 0.003, 0.08, g);
    expect(d).toBeCloseTo(0.003, 6);
    expect(g[0]).toBeCloseTo(1, 6);
    expect(g[1]).toBeCloseTo(0, 6);
    vesselSdfGrad(v, -0.005, 0.08, g); // exactly on the centreline: fallback normal
    expect(Math.hypot(g[0], g[1])).toBeCloseTo(1, 6);
  });

  it('square-cornered tank is supported', () => {
    const c = defaultVessel('tank');
    c.cornerRadius = 0;
    const v = buildVessel(c);
    expect(v.polylines[0]).toHaveLength(4);
  });

  it('teapot has a real passage: the spout channel is open fluid space', () => {
    const c = defaultVessel('teapot');
    const v = buildVessel(c);
    expect(v.outflow).not.toBeNull();
    expect(v.spoutPolygon).not.toBeNull();
    const a = (c.spoutAngleDeg * Math.PI) / 180;
    // Walk along the spout axis from the inlet: every point must be at least half a channel from walls.
    const x0 = c.innerWidth + c.wall / 2;
    for (let s = 0.01; s < c.spoutLength - 0.01; s += 0.01) {
      const x = x0 + Math.cos(a) * s;
      const y = c.inletHeight + Math.sin(a) * s;
      expect(vesselSdf(v, x, y)).toBeGreaterThan(c.channelWidth * 0.3);
      expect(pointInPolygon(v.spoutPolygon!, x, y)).toBe(true);
    }
    // The lower spout tip is above the default fill level (no spill at rest).
    const tipY = v.polylines[0][v.polylines[0].length - 1][1];
    expect(tipY).toBeGreaterThan(0.1);
  });

  it('German glass teapot: wide cylinder, no spout, lip section at the rim', () => {
    const c = defaultVessel('glass');
    const v = buildVessel(c);
    expect(v.spoutPolygon).toBeNull();
    expect(v.outflow).not.toBeNull();
    expect(c.innerWidth).toBeGreaterThan(c.innerHeight);
    // The only opening is above the rim: the section starts at the lip tip, above the rim.
    expect(Math.min(v.outflow!.ay, v.outflow!.by)).toBeGreaterThan(c.innerHeight - 0.03);
    // Closed side wall all the way up on the pouring side (no low inlet).
    for (let y = 0.005; y < c.innerHeight; y += 0.005)
      expect(vesselSdf(v, c.innerWidth + c.wall / 2, y)).toBeLessThan(0);
  });

  it('pitcher has a lip section', () => {
    const v = buildVessel(defaultVessel('pitcher'));
    expect(v.outflow).not.toBeNull();
    expect(v.spoutPolygon).toBeNull();
    expect(v.envelope.x1).toBeGreaterThan(0.17);
  });

  it('section crossing is one-directional and bounded to the segment', () => {
    const s = { ax: 0, ay: 0, bx: 0, by: 1, nx: 1, ny: 0 };
    expect(crossesSection(s, -0.1, 0.5, 0.1, 0.5)).toBe(true);
    expect(crossesSection(s, 0.1, 0.5, -0.1, 0.5)).toBe(false); // wrong direction
    expect(crossesSection(s, -0.1, 1.5, 0.1, 1.5)).toBe(false); // beyond segment
    expect(crossesSection(s, -0.1, 0.5, -0.05, 0.5)).toBe(false); // no crossing
    // A very fast parcel cannot skip the section (segment test, not point-in-region).
    expect(crossesSection(s, -50, 0.5, 50, 0.5)).toBe(true);
  });

  it('pose transforms round-trip', () => {
    const rng = createRng(3);
    const p = makePose(-0.7, 1.2, [0.08, 0.06], [0.2, 0.3]);
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    for (let k = 0; k < 50; k++) {
      const x = rng();
      const y = rng();
      worldToLocal(p, x, y, a);
      localToWorld(p, a[0], a[1], b);
      expect(b[0]).toBeCloseTo(x, 12);
      expect(b[1]).toBeCloseTo(y, 12);
    }
    // Pivot maps to pivot.
    worldToLocal(p, 0.2, 0.3, a);
    expect(a[0]).toBeCloseTo(0.08, 12);
    expect(a[1]).toBeCloseTo(0.06, 12);
  });

  it('the far-field SDF table never changes decisions near walls', () => {
    const v = buildVessel(defaultVessel('teapot'));
    const rng = createRng(11);
    const c = v.cache!;
    for (let k = 0; k < 4000; k++) {
      const x = c.x0 - 0.01 + rng() * (c.nx * c.step + 0.02);
      const y = c.y0 - 0.01 + rng() * (c.ny * c.step + 0.02);
      const exact = exactSdf(v, x, y);
      const fast = vesselSdf(v, x, y);
      if (exact < c.exact)
        expect(fast).toBe(exact); // exact near walls (and outside the table)
      else expect(Math.abs(fast - exact)).toBeLessThan(c.step); // approximate only far away
      expect(Math.sign(fast)).toBe(Math.sign(exact));
    }
  });

  it('point in polygon', () => {
    const sq: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(pointInPolygon(sq, 0.5, 0.5)).toBe(true);
    expect(pointInPolygon(sq, 1.5, 0.5)).toBe(false);
  });
});

describe('rng', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs[0]).not.toBe(c());
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
