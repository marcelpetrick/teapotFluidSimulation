// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { defaultMotion, ML } from '../src/sim/config';
import { DISCHARGED, IN_POT, Pcg3D, Simulation3D, type Config3D } from '../src/sim3d/solver3d';
import { buildTeapot3D, defaultTeapot3D, inCavity, teapotSdf } from '../src/sim3d/vessel3d';

function cfg(over: Partial<Config3D> = {}): Config3D {
  return {
    teapot: defaultTeapot3D(),
    h: 0.008,
    initialVolume: 1500 * ML,
    motion: { ...defaultMotion(), kind: 'still', targetVolume: 0 },
    pivot: [0, 0.06],
    gravity: 9.81,
    flipRatio: 0.95,
    densityCorrection: 0.3,
    cfl: 0.8,
    maxSubstep: 1 / 200,
    pressureTolerance: 1e-6,
    pressureMaxIterations: 300,
    seed: 1,
    duration: 0.3,
    ...over,
  };
}

describe('3D teapot geometry', () => {
  const t = buildTeapot3D(defaultTeapot3D());
  const c = t.cfg;
  it('has a cylindrical wall, a floor and an open body', () => {
    expect(teapotSdf(t, 0, 0.05, 0)).toBeGreaterThan(0.03); // inside the body: liquid space
    expect(teapotSdf(t, -(c.radius + c.wall / 2), 0.08, 0)).toBeLessThan(0); // back wall
    expect(teapotSdf(t, 0, -c.wall / 2, 0)).toBeLessThan(0); // floor
    expect(teapotSdf(t, 0, c.height + 0.02, 0)).toBeGreaterThan(0); // open top
    expect(inCavity(t, 0, 0.05, 0)).toBe(true);
    expect(inCavity(t, 0, -0.01, 0)).toBe(false);
  });

  it('the spout is a real passage: open along its axis, walled around it', () => {
    for (let s = 0.0; s < c.spoutLength - 0.005; s += 0.01) {
      const x = t.ax + s * t.dx;
      const y = t.ay + s * t.dy;
      expect(teapotSdf(t, x, y, 0)).toBeGreaterThan(0); // bore is open, including through the body wall
      expect(inCavity(t, x, y, 0)).toBe(true);
    }
    // Spout wall above the axis, outside the body.
    const s = 0.08;
    const nx = -t.dy;
    const ny = t.dx;
    const off = c.boreRadius + c.wall / 2;
    expect(teapotSdf(t, t.ax + s * t.dx + nx * off, t.ay + s * t.dy + ny * off, 0)).toBeLessThan(0);
    // The body wall is intact away from the bore.
    expect(teapotSdf(t, c.radius + c.wall / 2, 0.11, 0)).toBeLessThan(0);
    // Lip above the 1.5 L fill level, so the pot holds its tea at rest.
    expect(t.tipY - c.boreRadius).toBeGreaterThan(1.5e-3 / (Math.PI * c.radius * c.radius));
  });
});

describe('3D pressure solver', () => {
  it('solves a closed-bottom column with a free top to tolerance', () => {
    const n = 8;
    const cell = new Uint8Array(n * n * n);
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const c = i + n * (j + n * k);
          const border = i === 0 || j === 0 || k === 0 || i === n - 1 || j === n - 1 || k === n - 1;
          cell[c] = border ? 2 : j < 5 ? 1 : 0;
        }
    const b = new Float64Array(n * n * n);
    for (let c = 0; c < b.length; c++) if (cell[c] === 1) b[c] = Math.sin(c);
    const q = new Float64Array(n * n * n);
    const pcg = new Pcg3D(n, n, n);
    const r = pcg.solve(cell, b, q, 1e-8, 200);
    expect(r.converged).toBe(true);
    expect(r.iterations).toBeLessThan(40);
    expect(pcg.solve(cell, new Float64Array(n * n * n), q, 1e-8, 10).iterations).toBe(0);
    expect(pcg.solve(cell, b, q, 1e-14, 1).converged).toBe(false);
  });
});

describe('3D simulation', () => {
  it('rests stably, conserves volume and keeps equal-volume layers', () => {
    const sim = new Simulation3D(cfg());
    const counts = sim.bandCounts;
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    const d = sim.advance(0.3);
    expect(d.inPotMl).toBeCloseTo(1500, 6);
    expect(d.dischargedMl + d.spilledMl + d.lostMl).toBe(0);
    expect(d.pressureFailures).toBe(0);
    expect(sim.dischargedFractions()).toBeNull();
    for (let p = 0; p < sim.n; p++) expect(sim.z[p]).toBeGreaterThanOrEqual(sim.h); // symmetry plane
  });

  it('pours through the spout when tilted steeply, deterministically', () => {
    const tiltCfg = () =>
      cfg({
        motion: {
          ...defaultMotion(),
          startDelay: 0,
          tiltDuration: 0.4,
          holdAngleDeg: 60,
          maxAngleDeg: 60,
          maxHold: 5,
        },
        duration: 1.6,
      });
    const a = new Simulation3D(tiltCfg());
    const b = new Simulation3D(tiltCfg());
    while (!a.finished) a.advance(0.4);
    while (!b.finished) b.advance(0.8);
    const d = a.diagnostics();
    expect(d.dischargedMl).toBeGreaterThan(20);
    expect(d.lostMl).toBe(0);
    expect(d.inPotMl + d.dischargedMl + d.spilledMl + d.lostMl).toBeCloseTo(1500, 6);
    expect(a.dischargedFractions()!.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    for (const p of a.dischargeOrder) expect(a.status[p]).toBe(DISCHARGED);
    expect(Array.from(b.x)).toEqual(Array.from(a.x));
    expect(a.status.includes(IN_POT)).toBe(true);
  });
});
