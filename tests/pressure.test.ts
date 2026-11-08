// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { PressureSolver } from '../src/sim/pressure';
import { createRng } from '../src/sim/rng';
import { CELL_AIR, CELL_FLUID, CELL_SOLID } from '../src/sim/types';

function box(nx: number, ny: number, fluidRows: number, airTop = true) {
  const cell = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = i + j * nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) cell[c] = CELL_SOLID;
      else if (j <= fluidRows) cell[c] = CELL_FLUID;
      else cell[c] = airTop ? CELL_AIR : CELL_SOLID;
    }
  return cell;
}

describe('PCG pressure solver', () => {
  it('solves A q = b to tolerance for random rhs with a free surface', () => {
    const nx = 20;
    const ny = 16;
    const cell = box(nx, ny, 10);
    const b = new Float64Array(nx * ny);
    const rng = createRng(5);
    for (let c = 0; c < b.length; c++) if (cell[c] === CELL_FLUID) b[c] = rng() - 0.5;
    const q = new Float64Array(nx * ny);
    const ps = new PressureSolver(nx, ny);
    const res = ps.solve(cell, b, q, 1e-8, 500);
    expect(res.converged).toBe(true);
    expect(res.enclosedComponents).toBe(0);
    const Aq = new Float64Array(nx * ny);
    ps.applyA(q, Aq);
    let err = 0;
    for (let c = 0; c < b.length; c++)
      if (cell[c] === CELL_FLUID) err = Math.max(err, Math.abs(Aq[c] - b[c]));
    expect(err).toBeLessThan(1e-7);
    // MIC(0) preconditioning should converge well below the system size.
    expect(res.iterations).toBeLessThan(60);
  });

  it('is reusable when the fluid region shrinks (stale coefficients cleared)', () => {
    const nx = 12;
    const ny = 12;
    const ps = new PressureSolver(nx, ny);
    const q = new Float64Array(nx * ny);
    const b1 = new Float64Array(nx * ny).fill(0.1);
    ps.solve(box(nx, ny, 9), b1, q, 1e-8, 300);
    const cell = box(nx, ny, 3);
    const b2 = new Float64Array(nx * ny);
    for (let c = 0; c < b2.length; c++) if (cell[c] === CELL_FLUID) b2[c] = 0.2;
    const res = ps.solve(cell, b2, q, 1e-8, 300);
    expect(res.converged).toBe(true);
    for (let c = 0; c < q.length; c++) if (cell[c] !== CELL_FLUID) expect(q[c]).toBe(0);
  });

  it('handles an enclosed (all-Neumann) liquid region by fixing the gauge', () => {
    const nx = 10;
    const ny = 10;
    const cell = box(nx, ny, 8, false);
    const b = new Float64Array(nx * ny);
    const rng = createRng(9);
    for (let c = 0; c < b.length; c++) if (cell[c] === CELL_FLUID) b[c] = rng();
    const q = new Float64Array(nx * ny);
    const res = new PressureSolver(nx, ny).solve(cell, b, q, 1e-8, 500);
    expect(res.enclosedComponents).toBe(1);
    expect(res.converged).toBe(true);
  });

  it('returns immediately without fluid or with zero rhs', () => {
    const ps = new PressureSolver(6, 6);
    const q = new Float64Array(36);
    const empty = new Uint8Array(36);
    expect(ps.solve(empty, new Float64Array(36), q, 1e-6, 10).iterations).toBe(0);
    const cell = box(6, 6, 3);
    const r = ps.solve(cell, new Float64Array(36), q, 1e-6, 10);
    expect(r.converged).toBe(true);
    expect(r.iterations).toBe(0);
  });

  it('reports non-convergence when the iteration cap is too small', () => {
    const nx = 30;
    const ny = 30;
    const cell = box(nx, ny, 25);
    const b = new Float64Array(nx * ny);
    const rng = createRng(1);
    for (let c = 0; c < b.length; c++) if (cell[c] === CELL_FLUID) b[c] = rng() - 0.5;
    const res = new PressureSolver(nx, ny).solve(cell, b, new Float64Array(nx * ny), 1e-12, 2);
    expect(res.converged).toBe(false);
    expect(res.iterations).toBe(2);
  });
});
