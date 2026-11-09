// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Geometric multigrid V-cycle used as a preconditioner for the pressure PCG (MGPCG, after
// McAdams, Sifakis & Teran 2010). Same operator as the PCG system: for each liquid cell,
// sum over non-solid neighbours of (q_c - q_n), air neighbours being q = 0 (Dirichlet).
// Coarsening by 2: a coarse cell is air if any child is air, else liquid if any child is
// liquid, else solid. Damped Jacobi smoothing with equal pre/post sweeps, averaging restriction
// and piecewise-constant prolongation keep the V-cycle symmetric, as conjugate gradients require.

import { CELL_AIR, CELL_FLUID, CELL_SOLID } from './types';

interface Level {
  nx: number;
  ny: number;
  cell: Uint8Array;
  diag: Float64Array;
  x: Float64Array;
  b: Float64Array;
  r: Float64Array;
  /** Liquid cells of this level (work is restricted to them; most of the domain is air). */
  list: Int32Array;
  count: number;
}

export class Multigrid2D {
  private levels: Level[] = [];
  readonly smooth = 2;
  readonly omega = 0.8;

  constructor(nx: number, ny: number) {
    let w = nx;
    let h = ny;
    for (;;) {
      const n = w * h;
      this.levels.push({
        nx: w,
        ny: h,
        cell: new Uint8Array(n),
        diag: new Float64Array(n),
        x: new Float64Array(n),
        b: new Float64Array(n),
        r: new Float64Array(n),
        list: new Int32Array(n),
        count: 0,
      });
      if (w <= 8 || h <= 8) break;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
  }

  get depth(): number {
    return this.levels.length;
  }

  /** Build the level hierarchy for the current cell classification (once per pressure solve). */
  setup(fine: Uint8Array): void {
    const L0 = this.levels[0];
    L0.cell.set(fine);
    for (let l = 1; l < this.levels.length; l++) {
      const f = this.levels[l - 1];
      const c = this.levels[l];
      for (let j = 0; j < c.ny; j++)
        for (let i = 0; i < c.nx; i++) {
          let air = false;
          let liquid = false;
          for (let dj = 0; dj < 2; dj++)
            for (let di = 0; di < 2; di++) {
              const fi = 2 * i + di;
              const fj = 2 * j + dj;
              if (fi >= f.nx || fj >= f.ny) continue;
              const t = f.cell[fi + fj * f.nx];
              if (t === CELL_AIR) air = true;
              else if (t === CELL_FLUID) liquid = true;
            }
          const border = i === 0 || j === 0 || i === c.nx - 1 || j === c.ny - 1;
          c.cell[i + j * c.nx] = border ? CELL_SOLID : air ? CELL_AIR : liquid ? CELL_FLUID : CELL_SOLID;
        }
    }
    for (const L of this.levels) {
      const { nx, cell, diag } = L;
      diag.fill(0);
      L.count = 0;
      L.x.fill(0);
      L.r.fill(0);
      for (let c = 0; c < cell.length; c++) {
        if (cell[c] !== CELL_FLUID) continue;
        L.list[L.count++] = c;
        let d = 0;
        if (cell[c - 1] !== CELL_SOLID) d++;
        if (cell[c + 1] !== CELL_SOLID) d++;
        if (cell[c - nx] !== CELL_SOLID) d++;
        if (cell[c + nx] !== CELL_SOLID) d++;
        diag[c] = d;
      }
    }
  }

  /** z = M^-1 r (one V-cycle from zero). */
  apply(r: Float64Array, z: Float64Array): void {
    const L0 = this.levels[0];
    for (let t = 0; t < L0.count; t++) L0.b[L0.list[t]] = r[L0.list[t]];
    this.vcycle(0);
    for (let t = 0; t < L0.count; t++) z[L0.list[t]] = L0.x[L0.list[t]];
  }

  private residual(L: Level): void {
    const { nx, cell, diag, x, b, r, list } = L;
    for (let t = 0; t < L.count; t++) {
      const c = list[t];
      let ax = diag[c] * x[c];
      if (cell[c - 1] === CELL_FLUID) ax -= x[c - 1];
      if (cell[c + 1] === CELL_FLUID) ax -= x[c + 1];
      if (cell[c - nx] === CELL_FLUID) ax -= x[c - nx];
      if (cell[c + nx] === CELL_FLUID) ax -= x[c + nx];
      r[c] = b[c] - ax;
    }
  }

  private jacobi(L: Level, sweeps: number): void {
    const { diag, x, r, list } = L;
    for (let s = 0; s < sweeps; s++) {
      this.residual(L);
      for (let t = 0; t < L.count; t++) {
        const c = list[t];
        if (diag[c] > 0) x[c] += (this.omega * r[c]) / diag[c];
      }
    }
  }

  private vcycle(l: number): void {
    const L = this.levels[l];
    for (let t = 0; t < L.count; t++) L.x[L.list[t]] = 0;
    if (l === this.levels.length - 1) {
      this.jacobi(L, 40);
      return;
    }
    this.jacobi(L, this.smooth);
    this.residual(L);
    const C = this.levels[l + 1];
    // Restriction: sum of the liquid children (= 4 x average; the operator scales with the cell size squared).
    for (let t = 0; t < C.count; t++) C.b[C.list[t]] = 0;
    for (let t = 0; t < L.count; t++) {
      const c = L.list[t];
      const i = c % L.nx;
      const cc = (i >> 1) + (((c - i) / L.nx) >> 1) * C.nx;
      if (C.cell[cc] === CELL_FLUID) C.b[cc] += L.r[c];
    }
    this.vcycle(l + 1);
    // Prolongation: piecewise constant, then post-smoothing.
    for (let t = 0; t < L.count; t++) {
      const c = L.list[t];
      const i = c % L.nx;
      const cc = (i >> 1) + (((c - i) / L.nx) >> 1) * C.nx;
      if (C.cell[cc] === CELL_FLUID) L.x[c] += C.x[cc];
    }
    this.jacobi(L, this.smooth);
  }
}
