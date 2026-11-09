// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Matrix-free preconditioned conjugate gradient for the pressure Poisson system
// on a MAC grid (Bridson & Mueller-Fischer 2007, MIC(0) preconditioner).
//
// Unknown per fluid cell: q = p * dt / (rho * h). With D = net face flux * (1/1) in m/s,
// projection makes  sum_nonSolidNeighbours (q_c - q_n) = -D_c,  air neighbours have q = 0.

import { Multigrid2D } from './multigrid';
import { CELL_AIR, CELL_FLUID, CELL_SOLID } from './types';

export interface PressureResult {
  iterations: number;
  /** Max-norm residual in velocity-flux units (m/s); divide by h for 1/s. */
  residual: number;
  rhsNorm: number;
  converged: boolean;
  /** Number of enclosed (no air contact) liquid components whose gauge was fixed. */
  enclosedComponents: number;
}

export class PressureSolver {
  readonly nx: number;
  readonly ny: number;
  private adiag: Float64Array;
  private aplusi: Float64Array;
  private aplusj: Float64Array;
  private precon: Float64Array;
  private r: Float64Array;
  private z: Float64Array;
  private s: Float64Array;
  private as: Float64Array;
  private comp: Int32Array;
  private queue: Int32Array;
  fluidList: Int32Array;
  fluidCount = 0;
  /** Preconditioner: incomplete Cholesky (default) or a multigrid V-cycle (MGPCG). */
  preconditioner: 'mic0' | 'multigrid' = 'mic0';
  private mg: Multigrid2D | null = null;
  private useMg = false;

  constructor(nx: number, ny: number) {
    this.nx = nx;
    this.ny = ny;
    const n = nx * ny;
    this.adiag = new Float64Array(n);
    this.aplusi = new Float64Array(n);
    this.aplusj = new Float64Array(n);
    this.precon = new Float64Array(n);
    this.r = new Float64Array(n);
    this.z = new Float64Array(n);
    this.s = new Float64Array(n);
    this.as = new Float64Array(n);
    this.comp = new Int32Array(n);
    this.queue = new Int32Array(n);
    this.fluidList = new Int32Array(n);
  }

  /**
   * Solve A q = b where b = -D (rhs given in `b`, length nx*ny, zero outside fluid).
   * Border cells must be solid so neighbour indexing never leaves the grid.
   */
  solve(cell: Uint8Array, b: Float64Array, q: Float64Array, tol: number, maxIter: number): PressureResult {
    const { nx } = this;
    const n = nx * this.ny;
    const fl = this.fluidList;
    let m = 0;
    for (let c = 0; c < n; c++) if (cell[c] === CELL_FLUID) fl[m++] = c;
    this.fluidCount = m;
    q.fill(0);
    if (m === 0) return { iterations: 0, residual: 0, rhsNorm: 0, converged: true, enclosedComponents: 0 };

    const { adiag, aplusi, aplusj } = this;
    // Coefficients of non-fluid cells must be zero: neighbour terms read them unguarded.
    adiag.fill(0);
    aplusi.fill(0);
    aplusj.fill(0);
    this.precon.fill(0);
    for (let k = 0; k < m; k++) {
      const c = fl[k];
      let d = 0;
      if (cell[c - 1] !== CELL_SOLID) d++;
      if (cell[c + 1] !== CELL_SOLID) d++;
      if (cell[c - nx] !== CELL_SOLID) d++;
      if (cell[c + nx] !== CELL_SOLID) d++;
      adiag[c] = d;
      aplusi[c] = cell[c + 1] === CELL_FLUID ? -1 : 0;
      aplusj[c] = cell[c + nx] === CELL_FLUID ? -1 : 0;
    }

    const enclosed = this.fixEnclosedGauges(cell, b);
    // Multigrid does not model the pinned gauge of enclosed liquid: fall back to MIC(0) there.
    this.useMg = this.preconditioner === 'multigrid' && enclosed === 0;
    if (this.useMg) {
      this.mg ??= new Multigrid2D(this.nx, this.ny);
      this.mg.setup(cell);
    } else this.buildPreconditioner(cell);

    const r = this.r;
    let bnorm = 0;
    for (let k = 0; k < m; k++) {
      const c = fl[k];
      r[c] = b[c];
      const a = Math.abs(b[c]);
      if (a > bnorm) bnorm = a;
    }
    const target = Math.max(tol * bnorm, 1e-14);
    if (bnorm <= 1e-14)
      return {
        iterations: 0,
        residual: bnorm,
        rhsNorm: bnorm,
        converged: true,
        enclosedComponents: enclosed,
      };

    const { z, s, as } = this;
    this.applyPreconditioner(r, z);
    let sigma = 0;
    for (let k = 0; k < m; k++) {
      const c = fl[k];
      s[c] = z[c];
      sigma += z[c] * r[c];
    }
    let res = bnorm;
    let it: number;
    for (it = 1; it <= maxIter; it++) {
      this.applyA(s, as);
      let sas = 0;
      for (let k = 0; k < m; k++) sas += s[fl[k]] * as[fl[k]];
      if (sas <= 0 || !Number.isFinite(sas)) break;
      const alpha = sigma / sas;
      res = 0;
      for (let k = 0; k < m; k++) {
        const c = fl[k];
        q[c] += alpha * s[c];
        r[c] -= alpha * as[c];
        const a = Math.abs(r[c]);
        if (a > res) res = a;
      }
      if (res <= target) {
        return {
          iterations: it,
          residual: res,
          rhsNorm: bnorm,
          converged: true,
          enclosedComponents: enclosed,
        };
      }
      this.applyPreconditioner(r, z);
      let sigmaNew = 0;
      for (let k = 0; k < m; k++) sigmaNew += z[fl[k]] * r[fl[k]];
      const beta = sigmaNew / sigma;
      for (let k = 0; k < m; k++) {
        const c = fl[k];
        s[c] = z[c] + beta * s[c];
      }
      sigma = sigmaNew;
    }
    return {
      iterations: Math.min(it, maxIter),
      residual: res,
      rhsNorm: bnorm,
      converged: res <= target,
      enclosedComponents: enclosed,
    };
  }

  /** y = A x over fluid cells. */
  applyA(x: Float64Array, y: Float64Array): void {
    const { nx, adiag, aplusi, aplusj, fluidList: fl } = this;
    for (let k = 0; k < this.fluidCount; k++) {
      const c = fl[k];
      y[c] =
        adiag[c] * x[c] +
        aplusi[c] * x[c + 1] +
        aplusi[c - 1] * x[c - 1] +
        aplusj[c] * x[c + nx] +
        aplusj[c - nx] * x[c - nx];
    }
  }

  private buildPreconditioner(cell: Uint8Array): void {
    const { nx, adiag, aplusi, aplusj, precon, fluidList: fl } = this;
    const tau = 0.97;
    const sigma = 0.25;
    for (let k = 0; k < this.fluidCount; k++) {
      const c = fl[k];
      const pi = cell[c - 1] === CELL_FLUID ? precon[c - 1] : 0;
      const pj = cell[c - nx] === CELL_FLUID ? precon[c - nx] : 0;
      const ai = aplusi[c - 1];
      const aj = aplusj[c - nx];
      let e =
        adiag[c] -
        (ai * pi) ** 2 -
        (aj * pj) ** 2 -
        tau * (ai * aplusj[c - 1] * pi * pi + aj * aplusi[c - nx] * pj * pj);
      if (e < sigma * adiag[c]) e = adiag[c];
      precon[c] = e > 0 ? 1 / Math.sqrt(e) : 0;
    }
  }

  private applyPreconditioner(r: Float64Array, z: Float64Array): void {
    if (this.useMg) {
      this.mg!.apply(r, z);
      return;
    }
    const { nx, aplusi, aplusj, precon, fluidList: fl } = this;
    const m = this.fluidCount;
    const qv = this.as; // scratch reused before applyA overwrites it
    // Forward solve L q = r (non-fluid entries of qv are never read because a+ coefficients vanish).
    for (let k = 0; k < m; k++) {
      const c = fl[k];
      const t =
        r[c] - aplusi[c - 1] * precon[c - 1] * qv[c - 1] - aplusj[c - nx] * precon[c - nx] * qv[c - nx];
      qv[c] = t * precon[c];
    }
    // Backward solve L^T z = q.
    for (let k = m - 1; k >= 0; k--) {
      const c = fl[k];
      const t = qv[c] - aplusi[c] * precon[c] * z[c + 1] - aplusj[c] * precon[c] * z[c + nx];
      z[c] = t * precon[c];
    }
  }

  /**
   * A liquid component without air contact has an all-Neumann pressure problem: the matrix is
   * singular and solvable only for zero-mean rhs. Remove the mean (reported as an incompatibility)
   * and pin one cell by adding to its diagonal, which fixes the gauge.
   */
  private fixEnclosedGauges(cell: Uint8Array, b: Float64Array): number {
    const { nx, comp, queue, fluidList: fl, adiag } = this;
    const m = this.fluidCount;
    for (let k = 0; k < m; k++) comp[fl[k]] = -1;
    let enclosed = 0;
    let label = 0;
    for (let k = 0; k < m; k++) {
      const seed = fl[k];
      if (comp[seed] !== -1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      comp[seed] = label;
      let touchesAir = false;
      let sum = 0;
      while (head < tail) {
        const c = queue[head++];
        sum += b[c];
        for (let t = 0; t < 4; t++) {
          const d = t === 0 ? c - 1 : t === 1 ? c + 1 : t === 2 ? c - nx : c + nx;
          if (cell[d] === CELL_AIR) touchesAir = true;
          else if (cell[d] === CELL_FLUID && comp[d] === -1) {
            comp[d] = label;
            queue[tail++] = d;
          }
        }
      }
      if (!touchesAir) {
        enclosed++;
        const mean = sum / tail;
        for (let t = 0; t < tail; t++) b[queue[t]] -= mean;
        adiag[seed] += 1;
      }
      label++;
    }
    return enclosed;
  }
}
