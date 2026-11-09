// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { Multigrid2D } from '../src/sim/multigrid';
import { PressureSolver } from '../src/sim/pressure';
import { createRng } from '../src/sim/rng';
import { Simulation } from '../src/sim/solver';
import { CELL_AIR, CELL_FLUID, CELL_SOLID } from '../src/sim/types';
import { cfgFor } from './helpers';

function pool(nx: number, ny: number, rows: number) {
  const cell = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      cell[i + j * nx] =
        i === 0 || j === 0 || i === nx - 1 || j === ny - 1 ? CELL_SOLID : j <= rows ? CELL_FLUID : CELL_AIR;
  return cell;
}

describe('multigrid preconditioner (MGPCG)', () => {
  it('builds a hierarchy and is a symmetric operator (required for conjugate gradients)', () => {
    const nx = 40;
    const ny = 36;
    const mg = new Multigrid2D(nx, ny);
    expect(mg.depth).toBeGreaterThan(2);
    const cell = pool(nx, ny, 20);
    mg.setup(cell);
    const rng = createRng(4);
    const a = new Float64Array(nx * ny);
    const b = new Float64Array(nx * ny);
    for (let c = 0; c < a.length; c++)
      if (cell[c] === CELL_FLUID) {
        a[c] = rng() - 0.5;
        b[c] = rng() - 0.5;
      }
    const ma = new Float64Array(nx * ny);
    const mb = new Float64Array(nx * ny);
    mg.apply(a, ma);
    mg.apply(b, mb);
    let ab = 0;
    let ba = 0;
    for (let c = 0; c < a.length; c++) {
      ab += b[c] * ma[c];
      ba += a[c] * mb[c];
    }
    expect(Math.abs(ab - ba)).toBeLessThan(1e-9 * Math.abs(ab));
  });

  it('PCG with multigrid converges to the same tolerance with an iteration count comparable to MIC(0)', () => {
    const nx = 60;
    const ny = 60;
    const cell = pool(nx, ny, 45);
    const b = new Float64Array(nx * ny);
    for (let c = 0; c < b.length; c++) {
      const i = c % nx;
      const j = (c - i) / nx;
      if (cell[c] === CELL_FLUID) b[c] = Math.sin((Math.PI * i) / nx) * Math.cos((Math.PI * j) / 45);
    }
    const solve = (pre: 'mic0' | 'multigrid') => {
      const ps = new PressureSolver(nx, ny);
      ps.preconditioner = pre;
      return ps.solve(cell, b.slice(), new Float64Array(nx * ny), 1e-8, 500);
    };
    const mic = solve('mic0');
    const mg = solve('multigrid');
    expect(mg.converged).toBe(true);
    expect(mic.converged).toBe(true);
    expect(mg.iterations).toBeLessThanOrEqual(1.5 * mic.iterations);
  });

  it('falls back to MIC(0) for enclosed liquid and runs a full experiment', () => {
    const nx = 12;
    const ny = 12;
    const cell = pool(nx, ny, 12); // no air at all: enclosed
    for (let i = 1; i < nx - 1; i++) cell[i + (ny - 2) * nx] = CELL_FLUID;
    const b = new Float64Array(nx * ny);
    for (let c = 0; c < b.length; c++) if (cell[c] === CELL_FLUID) b[c] = c % 3;
    const ps = new PressureSolver(nx, ny);
    ps.preconditioner = 'multigrid';
    const r = ps.solve(cell, b, new Float64Array(nx * ny), 1e-8, 400);
    expect(r.enclosedComponents).toBe(1);
    expect(r.converged).toBe(true);
    const sim = new Simulation(cfgFor('tank-rest', (c) => (c.pressurePreconditioner = 'multigrid')));
    const d = sim.advance(0.3);
    expect(d.pressureFailures).toBe(0);
    expect(d.maxSpeed).toBeLessThan(0.05);
  });
});
