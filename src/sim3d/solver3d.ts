// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Offline 3D reference: incompressible free-surface PIC/FLIP on a staggered 3D MAC grid with a
// tilting cylindrical teapot and a round spout (vision §18.8 / Version 3). Same building blocks as
// the 2D solver: pressure projection with MIC(0)-PCG, rigid moving-wall face fluxes, position-only
// density correction, RK2 advection with SDF collisions, an oriented lip section for discharge.
//
// The pot and the tilt are mirror-symmetric about the vertical plane through the spout, so only
// the half z >= 0 is simulated with a free-slip symmetry wall; reported volumes are doubled.

import { PourController } from '../sim/motion';
import { createRng } from '../sim/rng';
import type { MotionConfig } from '../sim/types';
import { buildTeapot3D, inCavity, teapotSdf, type Teapot3D, type Teapot3DConfig } from './vessel3d';

const AIR = 0;
const FLUID = 1;
const SOLID = 2;
export const IN_POT = 0;
export const DISCHARGED = 1;
export const SPILLED = 2;
export const LOST = 3;

export interface Config3D {
  teapot: Teapot3DConfig;
  /** Cell size (m). */
  h: number;
  /** Liquid volume of the whole pot (m^3); the fill height follows from the body radius. */
  initialVolume: number;
  motion: MotionConfig;
  /** Tilt pivot in pot-local x, y (m). */
  pivot: [number, number];
  gravity: number;
  flipRatio: number;
  densityCorrection: number;
  cfl: number;
  maxSubstep: number;
  pressureTolerance: number;
  pressureMaxIterations: number;
  seed: number;
  duration: number;
}

export interface Diagnostics3D {
  time: number;
  steps: number;
  angleDeg: number;
  phase: string;
  particles: number;
  grid: [number, number, number];
  dischargedMl: number;
  spilledMl: number;
  lostMl: number;
  inPotMl: number;
  pressureIterations: number;
  pressureFailures: number;
  maxDivergence: number;
  interiorDensity: number;
}

export class Simulation3D {
  readonly cfg: Config3D;
  readonly pot: Teapot3D;
  readonly controller: PourController;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly h: number;
  readonly fillHeight: number;
  /** World position of the pivot; local (x, y) = R^-1 (world - pivotWorld) + pivot, z = world z - h. */
  readonly pivotWorld: [number, number];
  readonly n: number;
  readonly parcelVolume: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  readonly origin: Uint8Array;
  readonly status: Uint8Array;
  readonly y0: Float32Array;
  readonly bandCounts = [0, 0, 0];
  readonly dischargeOrder: number[] = [];
  time = 0;
  steps = 0;
  private phi = 0;
  private omega = 0;
  private cell: Uint8Array;
  private u: Float64Array;
  private v: Float64Array;
  private w: Float64Array;
  private uPrev: Float64Array;
  private vPrev: Float64Array;
  private wPrev: Float64Array;
  private uw: Float64Array;
  private vw: Float64Array;
  private ww: Float64Array;
  private uValid: Uint8Array;
  private vValid: Uint8Array;
  private wValid: Uint8Array;
  private rhs: Float64Array;
  private q: Float64Array;
  private density: Float64Array;
  private uc: Float64Array;
  private vc: Float64Array;
  private wc: Float64Array;
  private pcg: Pcg3D;
  private lastIterations = 0;
  private failures = 0;
  private maxDiv = 0;
  private interior = 1;
  private counts = [0, 0, 0, 0];

  constructor(cfg: Config3D) {
    this.cfg = cfg;
    this.pot = buildTeapot3D(cfg.teapot);
    this.controller = new PourController(cfg.motion);
    const h = cfg.h;
    this.h = h;
    const t = cfg.teapot;
    this.fillHeight = cfg.initialVolume / (Math.PI * t.radius * t.radius);
    // Domain: bounding box of the pot over the tilt range, plus margins.
    const pts: [number, number][] = [
      [-t.radius - t.wall, -t.wall],
      [-t.radius - t.wall, t.height + 0.02],
      [t.radius + t.wall, -t.wall],
      [t.radius + t.wall, t.height + 0.02],
      [this.pot.tipX + 0.02, this.pot.tipY + 0.02],
      [this.pot.tipX + 0.02, this.pot.tipY - 0.03],
    ];
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const maxA = Math.max(cfg.motion.maxAngleDeg, cfg.motion.holdAngleDeg);
    for (let a = 0; a <= maxA; a += 2) {
      const phi = (-a * Math.PI) / 180;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      for (const [lx, ly] of pts) {
        const rx = lx - cfg.pivot[0];
        const ry = ly - cfg.pivot[1];
        const wx = c * rx - s * ry;
        const wy = s * rx + c * ry;
        x0 = Math.min(x0, wx);
        x1 = Math.max(x1, wx);
        y0 = Math.min(y0, wy);
        y1 = Math.max(y1, wy);
      }
    }
    const m = 3 * h;
    this.pivotWorld = [-x0 + m, -y0 + m];
    this.nx = Math.ceil((x1 - x0 + 2 * m) / h);
    this.ny = Math.ceil((y1 - y0 + 2 * m) / h);
    this.nz = Math.ceil((t.radius + t.wall + 2 * h) / h) + 1;
    const { nx, ny, nz } = this;
    const nc = nx * ny * nz;
    this.cell = new Uint8Array(nc);
    const nu = (nx + 1) * ny * nz;
    const nv = nx * (ny + 1) * nz;
    const nw = nx * ny * (nz + 1);
    this.u = new Float64Array(nu);
    this.uPrev = new Float64Array(nu);
    this.uw = new Float64Array(nu);
    this.uValid = new Uint8Array(nu);
    this.uc = new Float64Array(nu);
    this.v = new Float64Array(nv);
    this.vPrev = new Float64Array(nv);
    this.vw = new Float64Array(nv);
    this.vValid = new Uint8Array(nv);
    this.vc = new Float64Array(nv);
    this.w = new Float64Array(nw);
    this.wPrev = new Float64Array(nw);
    this.ww = new Float64Array(nw);
    this.wValid = new Uint8Array(nw);
    this.wc = new Float64Array(nw);
    this.rhs = new Float64Array(nc);
    this.q = new Float64Array(nc);
    this.density = new Float64Array(nc);
    this.pcg = new Pcg3D(nx, ny, nz);

    // Seed 2 x 2 x 2 parcels per cell inside the liquid (half pot, z >= 0).
    const rng = createRng(cfg.seed);
    const s = h / 2;
    const xs: number[] = [];
    const loc = [0, 0, 0];
    for (let k = 0; k < nz * 2; k++)
      for (let j = 0; j < ny * 2; j++)
        for (let i = 0; i < nx * 2; i++) {
          const wx = (i + 0.5 + (rng() - 0.5) * 0.5) * s;
          const wy = (j + 0.5 + (rng() - 0.5) * 0.5) * s;
          const wz = (k + 0.5 + (rng() - 0.5) * 0.5) * s;
          this.toLocal(wx, wy, wz, loc);
          if (loc[2] < 0 || loc[1] < 0 || loc[1] > this.fillHeight) continue;
          if (!inCavity(this.pot, loc[0], loc[1], loc[2])) continue;
          if (teapotSdf(this.pot, loc[0], loc[1], loc[2]) < 0.4 * h) continue;
          xs.push(wx, wy, wz);
        }
    const n = xs.length / 3;
    this.n = n;
    this.parcelVolume = cfg.initialVolume / (2 * n); // half pot simulated
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.vz = new Float64Array(n);
    this.origin = new Uint8Array(n);
    this.status = new Uint8Array(n);
    this.y0 = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      this.x[p] = xs[3 * p];
      this.y[p] = xs[3 * p + 1];
      this.z[p] = xs[3 * p + 2];
      this.toLocal(this.x[p], this.y[p], this.z[p], loc);
      this.y0[p] = loc[1];
    }
    // Equal-volume horizontal bands from the actual parcels.
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => this.y0[a] - this.y0[b] || a - b);
    for (let r = 0; r < n; r++) {
      const k = Math.min(2, Math.floor((r * 3) / n));
      this.origin[order[r]] = k;
      this.bandCounts[k]++;
    }
    this.counts = [n, 0, 0, 0];
  }

  // ------------------------------------------------------------ frames

  private toLocal(wx: number, wy: number, wz: number, out: number[]): void {
    const c = Math.cos(this.phi);
    const s = Math.sin(this.phi);
    const rx = wx - this.pivotWorld[0];
    const ry = wy - this.pivotWorld[1];
    out[0] = c * rx + s * ry + this.cfg.pivot[0];
    out[1] = -s * rx + c * ry + this.cfg.pivot[1];
    out[2] = wz - this.h;
  }

  private toLocalAt(phi: number, wx: number, wy: number, wz: number, out: number[]): void {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const rx = wx - this.pivotWorld[0];
    const ry = wy - this.pivotWorld[1];
    out[0] = c * rx + s * ry + this.cfg.pivot[0];
    out[1] = -s * rx + c * ry + this.cfg.pivot[1];
    out[2] = wz - this.h;
  }

  private toWorldAt(phi: number, lx: number, ly: number, lz: number, out: number[]): void {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const rx = lx - this.cfg.pivot[0];
    const ry = ly - this.cfg.pivot[1];
    out[0] = c * rx - s * ry + this.pivotWorld[0];
    out[1] = s * rx + c * ry + this.pivotWorld[1];
    out[2] = lz + this.h;
  }

  // ------------------------------------------------------------ public

  get finished(): boolean {
    return this.time >= this.cfg.duration - 1e-9;
  }

  stableDt(): number {
    let m = 0;
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== IN_POT) continue;
      const s = this.vx[p] ** 2 + this.vy[p] ** 2 + this.vz[p] ** 2;
      if (s > m) m = s;
    }
    const R = Math.hypot(this.nx, this.ny) * this.h;
    const speed = Math.sqrt(m) + Math.sqrt(5 * this.h * this.cfg.gravity) + Math.abs(this.omega) * R;
    return Math.min(this.cfg.maxSubstep, (this.cfg.cfl * this.h) / speed);
  }

  /** Advance by whole stable substeps (chunk-independent, like the 2D solver). */
  advance(duration: number): Diagnostics3D {
    const end = this.time + duration;
    while (this.time < end - 1e-12 && !this.finished)
      this.step(Math.min(this.stableDt(), this.cfg.duration - this.time));
    return this.diagnostics();
  }

  step(dt: number): void {
    const discharged = this.counts[DISCHARGED] * this.parcelVolume * 2;
    const tilt1 = this.controller.advance(this.time + dt, dt, discharged);
    const phi1 = -tilt1;
    this.omega = (phi1 - this.phi) / dt;
    this.classify();
    this.particlesToGrid();
    this.uPrev.set(this.u);
    this.vPrev.set(this.v);
    this.wPrev.set(this.w);
    this.applyGravity(dt);
    this.setSolidFaces();
    this.project();
    this.markValid();
    this.extrapolate();
    this.gridToParticles();
    this.densityCorrection(dt);
    this.advect(dt, phi1);
    this.phi = phi1;
    this.time += dt;
    this.steps++;
  }

  // ------------------------------------------------------------ grid

  private classify(): void {
    const { nx, ny, nz, h, cell } = this;
    const loc = [0, 0, 0];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) {
            cell[c] = SOLID;
            continue;
          }
          this.toLocal((i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h, loc);
          cell[c] = teapotSdf(this.pot, loc[0], loc[1], loc[2]) < 0 ? SOLID : AIR;
        }
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== IN_POT) continue;
      const i = Math.floor(this.x[p] / h);
      const j = Math.floor(this.y[p] / h);
      const k = Math.floor(this.z[p] / h);
      if (i < 1 || j < 1 || k < 1 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) continue;
      const c = i + nx * (j + ny * k);
      if (cell[c] === AIR) cell[c] = FLUID;
    }
  }

  /** Trilinear stencil for a staggered component: offsets (ox, oy, oz) in cells, sizes (sx, sy, sz). */
  private stencil(
    x: number,
    y: number,
    z: number,
    ox: number,
    oy: number,
    oz: number,
    sx: number,
    sy: number,
    sz: number,
    out: Float64Array,
  ): number {
    const h = this.h;
    const gx = x / h - ox;
    const gy = y / h - oy;
    const gz = z / h - oz;
    const i = Math.max(0, Math.min(sx - 2, Math.floor(gx)));
    const j = Math.max(0, Math.min(sy - 2, Math.floor(gy)));
    const k = Math.max(0, Math.min(sz - 2, Math.floor(gz)));
    out[0] = Math.max(0, Math.min(1, gx - i));
    out[1] = Math.max(0, Math.min(1, gy - j));
    out[2] = Math.max(0, Math.min(1, gz - k));
    return i + sx * (j + sy * k);
  }

  private st = new Float64Array(3);

  private forEachCorner(base: number, sx: number, sy: number, cb: (idx: number, w: number) => void): void {
    const [fx, fy, fz] = this.st;
    const sxy = sx * sy;
    cb(base, (1 - fx) * (1 - fy) * (1 - fz));
    cb(base + 1, fx * (1 - fy) * (1 - fz));
    cb(base + sx, (1 - fx) * fy * (1 - fz));
    cb(base + sx + 1, fx * fy * (1 - fz));
    cb(base + sxy, (1 - fx) * (1 - fy) * fz);
    cb(base + sxy + 1, fx * (1 - fy) * fz);
    cb(base + sxy + sx, (1 - fx) * fy * fz);
    cb(base + sxy + sx + 1, fx * fy * fz);
  }

  private dims(comp: 0 | 1 | 2): [number, number, number, number, number, number] {
    const { nx, ny, nz } = this;
    if (comp === 0) return [0, 0.5, 0.5, nx + 1, ny, nz];
    if (comp === 1) return [0.5, 0, 0.5, nx, ny + 1, nz];
    return [0.5, 0.5, 0, nx, ny, nz + 1];
  }

  private sample(
    field: Float64Array,
    comp: 0 | 1 | 2,
    x: number,
    y: number,
    z: number,
    valid?: Uint8Array,
  ): number {
    const [ox, oy, oz, sx, sy, sz] = this.dims(comp);
    const base = this.stencil(x, y, z, ox, oy, oz, sx, sy, sz, this.st);
    let acc = 0;
    let ws = 0;
    let all = 0;
    this.forEachCorner(base, sx, sy, (idx, w) => {
      all += w * field[idx];
      if (!valid || valid[idx]) {
        acc += w * field[idx];
        ws += w;
      }
    });
    if (!valid) return all;
    return ws > 1e-9 ? acc / ws : all;
  }

  private particlesToGrid(): void {
    const fields: [Float64Array, Float64Array, Float64Array, 0 | 1 | 2][] = [
      [this.u, this.uw, this.vx, 0],
      [this.v, this.vw, this.vy, 1],
      [this.w, this.ww, this.vz, 2],
    ];
    for (const [f, wt, vel, comp] of fields) {
      f.fill(0);
      wt.fill(0);
      const [ox, oy, oz, sx, sy, sz] = this.dims(comp);
      for (let p = 0; p < this.n; p++) {
        if (this.status[p] !== IN_POT) continue;
        const base = this.stencil(this.x[p], this.y[p], this.z[p], ox, oy, oz, sx, sy, sz, this.st);
        const vp = vel[p];
        this.forEachCorner(base, sx, sy, (idx, w) => {
          f[idx] += w * vp;
          wt[idx] += w;
        });
      }
      for (let i = 0; i < f.length; i++) f[i] = wt[i] > 1e-9 ? f[i] / wt[i] : 0;
    }
  }

  private applyGravity(dt: number): void {
    const { nx, ny, nz, cell, v } = this;
    const g = this.cfg.gravity * dt;
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const below = cell[i + nx * (j - 1 + ny * k)];
          const above = cell[i + nx * (j + ny * k)];
          if (below === FLUID || above === FLUID) v[i + nx * (j + (ny + 1) * k)] -= g;
        }
  }

  /** Face is solid when either neighbouring cell is solid; it then carries the wall velocity. */
  private setSolidFaces(): void {
    const { nx, ny, nz, h, cell } = this;
    const om = this.omega;
    const [pwx, pwy] = this.pivotWorld;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i <= nx; i++) {
          const a = i > 0 ? cell[i - 1 + nx * (j + ny * k)] : SOLID;
          const b = i < nx ? cell[i + nx * (j + ny * k)] : SOLID;
          if (a === SOLID || b === SOLID) this.u[i + (nx + 1) * (j + ny * k)] = -om * ((j + 0.5) * h - pwy);
        }
    for (let k = 0; k < nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) {
          const a = j > 0 ? cell[i + nx * (j - 1 + ny * k)] : SOLID;
          const b = j < ny ? cell[i + nx * (j + ny * k)] : SOLID;
          if (a === SOLID || b === SOLID) this.v[i + nx * (j + (ny + 1) * k)] = om * ((i + 0.5) * h - pwx);
        }
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const a = k > 0 ? cell[i + nx * (j + ny * (k - 1))] : SOLID;
          const b = k < nz ? cell[i + nx * (j + ny * k)] : SOLID;
          if (a === SOLID || b === SOLID) this.w[i + nx * (j + ny * k)] = 0;
        }
  }

  private divergenceRhs(): number {
    const { nx, ny, nz, cell, rhs } = this;
    rhs.fill(0);
    let m = 0;
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++)
        for (let i = 1; i < nx - 1; i++) {
          const c = i + nx * (j + ny * k);
          if (cell[c] !== FLUID) continue;
          const d =
            this.u[i + 1 + (nx + 1) * (j + ny * k)] -
            this.u[i + (nx + 1) * (j + ny * k)] +
            this.v[i + nx * (j + 1 + (ny + 1) * k)] -
            this.v[i + nx * (j + (ny + 1) * k)] +
            this.w[i + nx * (j + ny * (k + 1))] -
            this.w[i + nx * (j + ny * k)];
          rhs[c] = -d;
          if (Math.abs(d) > m) m = Math.abs(d);
        }
    return m / this.h;
  }

  /** Subtract the gradient of q from non-solid faces next to liquid (into the given fields). */
  private applyGradient(
    q: Float64Array,
    fu: Float64Array,
    fv: Float64Array,
    fw: Float64Array,
    sign: number,
  ): void {
    const { nx, ny, nz, cell } = this;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const a = i - 1 + nx * (j + ny * k);
          const b = a + 1;
          if (cell[a] === SOLID || cell[b] === SOLID || (cell[a] !== FLUID && cell[b] !== FLUID)) continue;
          fu[i + (nx + 1) * (j + ny * k)] += sign * (q[b] - q[a]);
        }
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const a = i + nx * (j - 1 + ny * k);
          const b = a + nx;
          if (cell[a] === SOLID || cell[b] === SOLID || (cell[a] !== FLUID && cell[b] !== FLUID)) continue;
          fv[i + nx * (j + (ny + 1) * k)] += sign * (q[b] - q[a]);
        }
    for (let k = 1; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const a = i + nx * (j + ny * (k - 1));
          const b = a + nx * ny;
          if (cell[a] === SOLID || cell[b] === SOLID || (cell[a] !== FLUID && cell[b] !== FLUID)) continue;
          fw[i + nx * (j + ny * k)] += sign * (q[b] - q[a]);
        }
  }

  private project(): void {
    this.divergenceRhs();
    const res = this.pcg.solve(
      this.cell,
      this.rhs,
      this.q,
      this.cfg.pressureTolerance,
      this.cfg.pressureMaxIterations,
    );
    this.lastIterations = res.iterations;
    if (!res.converged) this.failures++;
    this.applyGradient(this.q, this.u, this.v, this.w, -1);
    this.maxDiv = this.divergenceRhs();
  }

  private markValid(): void {
    const { nx, ny, nz, cell } = this;
    const mark = (valid: Uint8Array, sx: number, sy: number, sz: number, comp: 0 | 1 | 2) => {
      for (let k = 0; k < sz; k++)
        for (let j = 0; j < sy; j++)
          for (let i = 0; i < sx; i++) {
            const ia = comp === 0 ? i - 1 : i;
            const ja = comp === 1 ? j - 1 : j;
            const ka = comp === 2 ? k - 1 : k;
            const a = ia >= 0 && ja >= 0 && ka >= 0 ? cell[ia + nx * (ja + ny * ka)] : SOLID;
            const b = i < nx && j < ny && k < nz ? cell[i + nx * (j + ny * k)] : SOLID;
            valid[i + sx * (j + sy * k)] = a === SOLID || b === SOLID || a === FLUID || b === FLUID ? 1 : 0;
          }
    };
    mark(this.uValid, nx + 1, ny, nz, 0);
    mark(this.vValid, nx, ny + 1, nz, 1);
    mark(this.wValid, nx, ny, nz + 1, 2);
  }

  /** Two layers of averaging extrapolation into invalid faces (for advection near the surface). */
  private extrapolate(): void {
    const ex = (f: Float64Array, valid: Uint8Array, sx: number, sy: number, sz: number) => {
      const vm = valid.slice();
      for (let layer = 0; layer < 2; layer++) {
        const add: number[] = [];
        const vals: number[] = [];
        for (let k = 0; k < sz; k++)
          for (let j = 0; j < sy; j++)
            for (let i = 0; i < sx; i++) {
              const c = i + sx * (j + sy * k);
              if (vm[c]) continue;
              let s = 0;
              let n = 0;
              const nb = (d: number, ok: boolean) => {
                if (ok && vm[d]) {
                  s += f[d];
                  n++;
                }
              };
              nb(c - 1, i > 0);
              nb(c + 1, i < sx - 1);
              nb(c - sx, j > 0);
              nb(c + sx, j < sy - 1);
              nb(c - sx * sy, k > 0);
              nb(c + sx * sy, k < sz - 1);
              if (n > 0) {
                add.push(c);
                vals.push(s / n);
              }
            }
        add.forEach((c, t) => {
          f[c] = vals[t];
          vm[c] = 1;
        });
      }
    };
    const { nx, ny, nz } = this;
    ex(this.u, this.uValid, nx + 1, ny, nz);
    ex(this.v, this.vValid, nx, ny + 1, nz);
    ex(this.w, this.wValid, nx, ny, nz + 1);
  }

  private gridToParticles(): void {
    const a = this.cfg.flipRatio;
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== IN_POT) continue;
      const x = this.x[p];
      const y = this.y[p];
      const z = this.z[p];
      const un = this.sample(this.u, 0, x, y, z, this.uValid);
      const vn = this.sample(this.v, 1, x, y, z, this.vValid);
      const wn = this.sample(this.w, 2, x, y, z, this.wValid);
      const uo = this.sample(this.uPrev, 0, x, y, z, this.uValid);
      const vo = this.sample(this.vPrev, 1, x, y, z, this.vValid);
      const wo = this.sample(this.wPrev, 2, x, y, z, this.wValid);
      this.vx[p] = (1 - a) * un + a * (this.vx[p] + un - uo);
      this.vy[p] = (1 - a) * vn + a * (this.vy[p] + vn - vo);
      this.vz[p] = (1 - a) * wn + a * (this.vz[p] + wn - wo);
    }
  }

  /** Position-only density correction (as in 2D): expand over-full cells, compress under-full interior ones. */
  private densityCorrection(dt: number): void {
    const kappa = this.cfg.densityCorrection;
    this.uc.fill(0);
    this.vc.fill(0);
    this.wc.fill(0);
    const { nx, ny, nz, h, cell, density, rhs } = this;
    density.fill(0);
    const ds = new Float64Array(3);
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== IN_POT) continue;
      const base = this.stencil(this.x[p], this.y[p], this.z[p], 0.5, 0.5, 0.5, nx, ny, nz, ds);
      this.st.set(ds);
      this.forEachCorner(base, nx, ny, (idx, w) => {
        density[idx] += w;
      });
    }
    rhs.fill(0);
    let interior = 0;
    let sum = 0;
    let any = false;
    const nxy = nx * ny;
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++)
        for (let i = 1; i < nx - 1; i++) {
          const c = i + nx * (j + ny * k);
          if (cell[c] !== FLUID) continue;
          const ratio = density[c] / 8;
          const isInterior =
            cell[c - 1] !== AIR &&
            cell[c + 1] !== AIR &&
            cell[c - nx] !== AIR &&
            cell[c + nx] !== AIR &&
            cell[c - nxy] !== AIR &&
            cell[c + nxy] !== AIR;
          if (isInterior) {
            interior++;
            sum += ratio;
          }
          if (kappa > 0 && (ratio > 1 || isInterior)) {
            rhs[c] = (kappa * (ratio - 1) * h) / dt;
            any = true;
          }
        }
    this.interior = interior > 0 ? sum / interior : 1;
    if (!any) return;
    const qc = new Float64Array(nx * ny * nz);
    this.pcg.solve(cell, rhs, qc, 1e-4, 80);
    this.applyGradient(qc, this.uc, this.vc, this.wc, -1);
  }

  private advect(dt: number, phi1: number): void {
    const out = [0, 0, 0];
    const loc0 = [0, 0, 0];
    const loc1 = [0, 0, 0];
    const corr = this.cfg.densityCorrection > 0;
    const eps = 1e-4;
    const margin = 0.1 * this.h;
    const pot = this.pot;
    const tip = { x: pot.tipX, y: pot.tipY };
    const lo = this.h * 1.01;
    const hiX = (this.nx - 1) * this.h;
    const hiY = (this.ny - 1) * this.h;
    const hiZ = (this.nz - 1) * this.h;
    for (let p = 0; p < this.n; p++) {
      const st = this.status[p];
      if (st !== IN_POT) continue;
      const x0 = this.x[p];
      const y0 = this.y[p];
      const z0 = this.z[p];
      this.toLocal(x0, y0, z0, loc0);
      const u1 = this.sample(this.u, 0, x0, y0, z0);
      const v1 = this.sample(this.v, 1, x0, y0, z0);
      const w1 = this.sample(this.w, 2, x0, y0, z0);
      const xm = x0 + 0.5 * dt * u1;
      const ym = y0 + 0.5 * dt * v1;
      const zm = z0 + 0.5 * dt * w1;
      let x1 = x0 + dt * this.sample(this.u, 0, xm, ym, zm);
      let y1 = y0 + dt * this.sample(this.v, 1, xm, ym, zm);
      let z1 = z0 + dt * this.sample(this.w, 2, xm, ym, zm);
      if (corr) {
        x1 += dt * this.sample(this.uc, 0, x0, y0, z0);
        y1 += dt * this.sample(this.vc, 1, x0, y0, z0);
        z1 += dt * this.sample(this.wc, 2, x0, y0, z0);
      }
      // Collision with the pot at its new pose (numerical SDF gradient).
      this.toLocalAt(phi1, x1, y1, z1, loc1);
      const d = teapotSdf(pot, loc1[0], loc1[1], loc1[2]);
      if (d < margin) {
        const gx =
          teapotSdf(pot, loc1[0] + eps, loc1[1], loc1[2]) - teapotSdf(pot, loc1[0] - eps, loc1[1], loc1[2]);
        const gy =
          teapotSdf(pot, loc1[0], loc1[1] + eps, loc1[2]) - teapotSdf(pot, loc1[0], loc1[1] - eps, loc1[2]);
        const gz =
          teapotSdf(pot, loc1[0], loc1[1], loc1[2] + eps) - teapotSdf(pot, loc1[0], loc1[1], loc1[2] - eps);
        const gl = Math.hypot(gx, gy, gz) || 1;
        const push = margin - d;
        loc1[0] += (gx / gl) * push;
        loc1[1] += (gy / gl) * push;
        loc1[2] += (gz / gl) * push;
        this.toWorldAt(phi1, loc1[0], loc1[1], loc1[2], out);
        x1 = out[0];
        y1 = out[1];
        z1 = out[2];
        // Remove the inward normal velocity relative to the moving wall.
        const c = Math.cos(phi1);
        const s = Math.sin(phi1);
        const nwx = (c * gx - s * gy) / gl;
        const nwy = (s * gx + c * gy) / gl;
        const nwz = gz / gl;
        const wvx = -this.omega * (y1 - this.pivotWorld[1]);
        const wvy = this.omega * (x1 - this.pivotWorld[0]);
        const rn = (this.vx[p] - wvx) * nwx + (this.vy[p] - wvy) * nwy + this.vz[p] * nwz;
        if (rn < 0) {
          this.vx[p] -= rn * nwx;
          this.vy[p] -= rn * nwy;
          this.vz[p] -= rn * nwz;
        }
      }
      // Symmetry plane z = h (local z = 0): reflect.
      if (z1 < this.h) {
        z1 = 2 * this.h - z1;
        this.vz[p] = Math.abs(this.vz[p]);
      }
      if (!Number.isFinite(x1 + y1 + z1)) {
        this.setStatus(p, LOST);
        continue;
      }
      this.x[p] = x1;
      this.y[p] = y1;
      this.z[p] = z1;
      this.toLocalAt(phi1, x1, y1, z1, loc1);
      // Discharge: crossing the plane through the spout mouth, perpendicular to the spout axis,
      // within a few bore radii of the axis.
      const s0 = (loc0[0] - tip.x) * pot.dx + (loc0[1] - tip.y) * pot.dy;
      const s1 = (loc1[0] - tip.x) * pot.dx + (loc1[1] - tip.y) * pot.dy;
      if (s0 < 0 && s1 >= 0) {
        const rx = loc1[0] - tip.x - s1 * pot.dx;
        const ry = loc1[1] - tip.y - s1 * pot.dy;
        if (Math.hypot(rx, ry, loc1[2]) < pot.cfg.boreRadius + 3 * pot.cfg.wall) {
          this.setStatus(p, DISCHARGED);
          this.dischargeOrder.push(p);
          continue;
        }
      }
      const r = Math.hypot(loc1[0], loc1[2]);
      const insideBody = r < pot.cfg.radius + 2 * pot.cfg.wall && loc1[1] > -2 * pot.cfg.wall;
      const nearSpout = loc1[0] > 0 && loc1[0] < pot.tipX + 0.03;
      const atEdge = x1 <= lo || y1 <= lo || x1 >= hiX || y1 >= hiY || z1 >= hiZ;
      if ((!insideBody && !nearSpout) || atEdge) this.setStatus(p, SPILLED);
    }
  }

  private setStatus(p: number, s: number): void {
    this.counts[this.status[p]]--;
    this.counts[s]++;
    this.status[p] = s;
  }

  diagnostics(): Diagnostics3D {
    const v = this.parcelVolume * 2 * 1e6; // mL per parcel, both halves
    return {
      time: this.time,
      steps: this.steps,
      angleDeg: this.controller.angleDeg,
      phase: this.controller.phase,
      particles: this.n,
      grid: [this.nx, this.ny, this.nz],
      dischargedMl: this.counts[DISCHARGED] * v,
      spilledMl: this.counts[SPILLED] * v,
      lostMl: this.counts[LOST] * v,
      inPotMl: this.counts[IN_POT] * v,
      pressureIterations: this.lastIterations,
      pressureFailures: this.failures,
      maxDivergence: this.maxDiv,
      interiorDensity: this.interior,
    };
  }

  /** Share of the poured volume per starting layer (bottom, middle, top), or null before pouring. */
  dischargedFractions(): number[] | null {
    const n = this.dischargeOrder.length;
    if (n === 0) return null;
    const c = [0, 0, 0];
    for (const p of this.dischargeOrder) c[this.origin[p]]++;
    return c.map((k) => k / n);
  }
}

/** Matrix-free PCG with a 3D MIC(0) preconditioner (Bridson & Mueller-Fischer 2007). */
export class Pcg3D {
  private adiag: Float64Array;
  private ai: Float64Array;
  private aj: Float64Array;
  private ak: Float64Array;
  private pc: Float64Array;
  private r: Float64Array;
  private z: Float64Array;
  private s: Float64Array;
  private as: Float64Array;
  private list: Int32Array;
  private m = 0;

  constructor(
    private nx: number,
    private ny: number,
    nz: number,
  ) {
    const n = nx * ny * nz;
    this.adiag = new Float64Array(n);
    this.ai = new Float64Array(n);
    this.aj = new Float64Array(n);
    this.ak = new Float64Array(n);
    this.pc = new Float64Array(n);
    this.r = new Float64Array(n);
    this.z = new Float64Array(n);
    this.s = new Float64Array(n);
    this.as = new Float64Array(n);
    this.list = new Int32Array(n);
  }

  solve(cell: Uint8Array, b: Float64Array, q: Float64Array, tol: number, maxIter: number) {
    const { nx, ny } = this;
    const nxy = nx * ny;
    const { adiag, ai, aj, ak, pc, list } = this;
    adiag.fill(0);
    ai.fill(0);
    aj.fill(0);
    ak.fill(0);
    pc.fill(0);
    q.fill(0);
    let m = 0;
    for (let c = 0; c < cell.length; c++) if (cell[c] === FLUID) list[m++] = c;
    this.m = m;
    let bnorm = 0;
    for (let t = 0; t < m; t++) {
      const c = list[t];
      let d = 0;
      for (const o of [-1, 1, -nx, nx, -nxy, nxy]) if (cell[c + o] !== SOLID) d++;
      adiag[c] = d;
      ai[c] = cell[c + 1] === FLUID ? -1 : 0;
      aj[c] = cell[c + nx] === FLUID ? -1 : 0;
      ak[c] = cell[c + nxy] === FLUID ? -1 : 0;
      bnorm = Math.max(bnorm, Math.abs(b[c]));
    }
    if (m === 0 || bnorm < 1e-14) return { iterations: 0, converged: true, residual: bnorm };
    const tau = 0.97;
    for (let t = 0; t < m; t++) {
      const c = list[t];
      const pi = pc[c - 1];
      const pj = pc[c - nx];
      const pk = pc[c - nxy];
      let e =
        adiag[c] -
        (ai[c - 1] * pi) ** 2 -
        (aj[c - nx] * pj) ** 2 -
        (ak[c - nxy] * pk) ** 2 -
        tau *
          (ai[c - 1] * (aj[c - 1] + ak[c - 1]) * pi * pi +
            aj[c - nx] * (ai[c - nx] + ak[c - nx]) * pj * pj +
            ak[c - nxy] * (ai[c - nxy] + aj[c - nxy]) * pk * pk);
      if (e < 0.25 * adiag[c]) e = adiag[c];
      pc[c] = e > 0 ? 1 / Math.sqrt(e) : 0;
    }
    const { r, z, s, as } = this;
    for (let t = 0; t < m; t++) r[list[t]] = b[list[t]];
    this.precondition(r, z);
    let sigma = 0;
    for (let t = 0; t < m; t++) {
      const c = list[t];
      s[c] = z[c];
      sigma += z[c] * r[c];
    }
    const target = Math.max(tol * bnorm, 1e-14);
    let res = bnorm;
    for (let it = 1; it <= maxIter; it++) {
      this.applyA(s, as);
      let sas = 0;
      for (let t = 0; t < m; t++) sas += s[list[t]] * as[list[t]];
      if (!(sas > 0)) break;
      const alpha = sigma / sas;
      res = 0;
      for (let t = 0; t < m; t++) {
        const c = list[t];
        q[c] += alpha * s[c];
        r[c] -= alpha * as[c];
        res = Math.max(res, Math.abs(r[c]));
      }
      if (res <= target) return { iterations: it, converged: true, residual: res };
      this.precondition(r, z);
      let sn = 0;
      for (let t = 0; t < m; t++) sn += z[list[t]] * r[list[t]];
      const beta = sn / sigma;
      for (let t = 0; t < m; t++) {
        const c = list[t];
        s[c] = z[c] + beta * s[c];
      }
      sigma = sn;
    }
    return { iterations: maxIter, converged: res <= target, residual: res };
  }

  private applyA(x: Float64Array, y: Float64Array): void {
    const { nx, ny, adiag, ai, aj, ak, list } = this;
    const nxy = nx * ny;
    for (let t = 0; t < this.m; t++) {
      const c = list[t];
      y[c] =
        adiag[c] * x[c] +
        ai[c] * x[c + 1] +
        ai[c - 1] * x[c - 1] +
        aj[c] * x[c + nx] +
        aj[c - nx] * x[c - nx] +
        ak[c] * x[c + nxy] +
        ak[c - nxy] * x[c - nxy];
    }
  }

  private precondition(r: Float64Array, z: Float64Array): void {
    const { nx, ny, ai, aj, ak, pc, list } = this;
    const nxy = nx * ny;
    const qv = this.as;
    for (let t = 0; t < this.m; t++) {
      const c = list[t];
      const v =
        r[c] -
        ai[c - 1] * pc[c - 1] * qv[c - 1] -
        aj[c - nx] * pc[c - nx] * qv[c - nx] -
        ak[c - nxy] * pc[c - nxy] * qv[c - nxy];
      qv[c] = v * pc[c];
    }
    for (let t = this.m - 1; t >= 0; t--) {
      const c = list[t];
      const v = qv[c] - ai[c] * pc[c] * z[c + 1] - aj[c] * pc[c] * z[c + nx] - ak[c] * pc[c] * z[c + nxy];
      z[c] = v * pc[c];
    }
  }
}
