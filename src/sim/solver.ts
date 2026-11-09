// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// 2D incompressible free-surface liquid: hybrid particle/grid (PIC/FLIP or APIC) on a
// staggered MAC grid with a pressure projection, a prescribed moving (tilting) vessel,
// immutable parcel origin labels and an outflow/spill/loss ledger.
//
// Substep (see docs/physics.md for the full discussion):
//  1. controller decides the tilt at t+dt; wall angular velocity = (phi(t+dt)-phi(t))/dt
//  2. classify cells (solid from the vessel SDF at pose(t), fluid = contains an in-pot parcel)
//  3. particle-to-grid transfer, keep the transferred grid (FLIP increment reference)
//  4. gravity (+ Boussinesq buoyancy in coupled thermal mode), explicit viscosity
//  5. moving-wall face velocities, pressure solve (PCG/MIC0), projection
//  6. velocity extrapolation, grid-to-particle transfer (PIC/FLIP blend or APIC)
//  7. RK2 advection in the projected field, SDF collision against the vessel at pose(t+dt)
//  8. outflow section crossing / spill / loss accounting, thermal transport

import { createRng } from './rng';
import { PourController } from './motion';
import { PressureSolver, type PressureResult } from './pressure';
import {
  buildVessel,
  crossesSection,
  makePose,
  pointInPolygon,
  vesselSdf,
  vesselSdfGrad,
  worldToLocal,
  localToWorld,
  type Pose,
  type Vessel,
} from './vessel';
import {
  CELL_AIR,
  CELL_FLUID,
  CELL_SOLID,
  STATUS_DISCHARGED,
  STATUS_IN_POT,
  STATUS_LOST,
  STATUS_SPILLED,
  type Diagnostics,
  type ExperimentConfig,
  type RenderSnapshot,
} from './types';

export const SOLVER_VERSION = '1.0.0';

export interface HistoryRow {
  time: number;
  angleDeg: number;
  inPot: number;
  discharged: number;
  spilled: number;
  lost: number;
  divergenceAfter: number;
  pressureResidual: number;
  pressureIterations: number;
  kineticEnergy: number;
  representedDrift: number;
  meanTemperature: number;
}

export interface Pathline {
  particle: number;
  origin: number;
  points: number[]; // pot-local x,y pairs
}

const SQRT5 = Math.sqrt(5);
const MAX_HISTORY = 6000;
const PATHLINE_POINTS = 1500;

export class Simulation {
  readonly cfg: ExperimentConfig;
  readonly vessel: Vessel;
  readonly controller: PourController;
  readonly nx: number;
  readonly ny: number;
  readonly h: number;
  /** Effective 2D depth b: initial volume / initial seeded area. */
  readonly depth: number;
  readonly parcelVolume: number;
  readonly n: number;

  // Grid state.
  readonly cell: Uint8Array;
  private border: Uint8Array;
  readonly u: Float64Array;
  readonly v: Float64Array;
  private uPrev: Float64Array;
  private vPrev: Float64Array;
  private uw: Float64Array;
  private vw: Float64Array;
  private uSolid: Uint8Array;
  private vSolid: Uint8Array;
  private uValid: Uint8Array;
  private vValid: Uint8Array;
  private uTmp: Float64Array;
  private vTmp: Float64Array;
  private validTmp: Uint8Array;
  private newlyBuf: Int32Array;
  readonly pressure: Float64Array;
  private rhs: Float64Array;
  /** Position-only density-correction velocity (never written into parcel velocities). */
  private uCorr: Float64Array;
  private vCorr: Float64Array;
  private qCorr: Float64Array;
  private cellDensity: Float64Array;
  private cellT: Float64Array;
  private cellTw: Float64Array;
  private cellDT: Float64Array;
  readonly pressureSolver: PressureSolver;

  // Particle state (structure of arrays).
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  private cux: Float64Array;
  private cuy: Float64Array;
  private cvx: Float64Array;
  private cvy: Float64Array;
  readonly temperature: Float64Array;
  /** Immutable origin band index (0 = bottom). */
  readonly origin: Uint8Array;
  readonly initiallyInSpout: Uint8Array;
  readonly status: Uint8Array;
  /** Initial positions in pot-local coordinates. */
  readonly x0: Float32Array;
  readonly y0: Float32Array;
  readonly exitTime: Float32Array;
  /** Particle indices in the order they crossed the outflow section. */
  readonly dischargeOrder: number[] = [];
  readonly bandEdges: number[];
  readonly initialBandCounts: number[];

  time = 0;
  steps = 0;
  pose: Pose;
  private phi = 0;
  private scratch = new Float64Array(2);
  private scratch2 = new Float64Array(2);
  private counts = [0, 0, 0, 0];
  private collisionCorrections = 0;
  private collisionDisplacement = 0;
  private densityDisplacement = 0;
  private maxDensityRatio = 0;
  private densityIterations = 0;
  private interiorDensity = 1;
  private pressureFailures = 0;
  private lastPressure: PressureResult = {
    iterations: 0,
    residual: 0,
    rhsNorm: 0,
    converged: true,
    enclosedComponents: 0,
  };
  private pressureItersMaxAdvance = 0;
  private divBefore = 0;
  private divAfter = 0;
  private fluidCellCount = 0;
  private initialRepresented = 0;
  private initialHeat = 0;
  private heatLostBoundary = 0;
  private heatRemoved = 0;
  private tref: number;
  readonly history: HistoryRow[] = [];
  private nextHistory = 0;
  readonly pathlines: Pathline[] = [];
  private nextPath = 0;
  private lastDt = 0;
  private lastSubsteps = 0;
  private lastWallMs = 0;
  readonly warnings: string[] = [];

  constructor(cfg: ExperimentConfig) {
    this.cfg = cfg;
    this.vessel = buildVessel(cfg.vessel);
    this.controller = new PourController(cfg.motion);
    this.h = cfg.vessel.innerWidth / cfg.cellsAcrossBody;
    this.nx = Math.ceil(cfg.domainWidth / this.h);
    this.ny = Math.ceil(cfg.domainHeight / this.h);
    const { nx, ny } = this;
    const nc = nx * ny;
    this.cell = new Uint8Array(nc);
    this.border = new Uint8Array(nc);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) this.border[i + j * nx] = 1;
    const nu = (nx + 1) * ny;
    const nv = nx * (ny + 1);
    this.u = new Float64Array(nu);
    this.uPrev = new Float64Array(nu);
    this.uw = new Float64Array(nu);
    this.uSolid = new Uint8Array(nu);
    this.uValid = new Uint8Array(nu);
    this.uTmp = new Float64Array(nu);
    this.v = new Float64Array(nv);
    this.vPrev = new Float64Array(nv);
    this.vw = new Float64Array(nv);
    this.vSolid = new Uint8Array(nv);
    this.vValid = new Uint8Array(nv);
    this.vTmp = new Float64Array(nv);
    this.validTmp = new Uint8Array(Math.max(nu, nv));
    this.newlyBuf = new Int32Array(Math.max(nu, nv));
    this.pressure = new Float64Array(nc);
    this.rhs = new Float64Array(nc);
    this.uCorr = new Float64Array(nu);
    this.vCorr = new Float64Array(nv);
    this.qCorr = new Float64Array(nc);
    this.cellDensity = new Float64Array(nc);
    this.cellT = new Float64Array(nc);
    this.cellTw = new Float64Array(nc);
    this.cellDT = new Float64Array(nc);
    this.pressureSolver = new PressureSolver(nx, ny);
    this.pressureSolver.preconditioner = cfg.pressurePreconditioner ?? 'mic0';
    this.pose = makePose(0, 0, cfg.pivotLocal, cfg.pivotWorld);

    // Seed parcels on a jittered lattice aligned with the grid.
    const seeds = this.seedPositions();
    const n = seeds.length / 2;
    if (n === 0) throw new Error('Configuration seeds no liquid parcels.');
    this.n = n;
    this.counts = [n, 0, 0, 0];
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.cux = new Float64Array(n);
    this.cuy = new Float64Array(n);
    this.cvx = new Float64Array(n);
    this.cvy = new Float64Array(n);
    this.temperature = new Float64Array(n);
    this.origin = new Uint8Array(n);
    this.initiallyInSpout = new Uint8Array(n);
    this.status = new Uint8Array(n);
    this.x0 = new Float32Array(n);
    this.y0 = new Float32Array(n);
    this.exitTime = new Float32Array(n).fill(-1);
    const spacing = this.h / cfg.particlesPerCellAxis;
    this.depth = cfg.initialVolume / (n * spacing * spacing);
    this.parcelVolume = cfg.initialVolume / n;
    const loc = this.scratch;
    for (let p = 0; p < n; p++) {
      this.x[p] = seeds[2 * p];
      this.y[p] = seeds[2 * p + 1];
      worldToLocal(this.pose, this.x[p], this.y[p], loc);
      this.x0[p] = loc[0];
      this.y0[p] = loc[1];
      const sp = this.vessel.spoutPolygon;
      if (sp && loc[0] > cfg.vessel.innerWidth && pointInPolygon(sp, loc[0], loc[1]))
        this.initiallyInSpout[p] = 1;
    }

    // Equal-volume horizontal origin bands from the actual parcels (ties broken by index).
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => this.y0[a] - this.y0[b] || a - b);
    const K = Math.max(1, Math.min(8, cfg.originBands));
    this.initialBandCounts = new Array(K).fill(0);
    this.bandEdges = [];
    for (let r = 0; r < n; r++) {
      const k = Math.min(K - 1, Math.floor((r * K) / n));
      this.origin[order[r]] = k;
      this.initialBandCounts[k]++;
    }
    for (let k = 1; k < K; k++) {
      const r = Math.floor((k * n) / K);
      this.bandEdges.push(0.5 * (this.y0[order[r - 1]] + this.y0[order[r]]));
    }

    // Temperature: linear profile in initial height.
    const th = cfg.thermal;
    let ymax = 0;
    for (let p = 0; p < n; p++) ymax = Math.max(ymax, this.y0[p]);
    let tsum = 0;
    for (let p = 0; p < n; p++) {
      const s = ymax > 0 ? Math.max(0, Math.min(1, this.y0[p] / ymax)) : 0;
      this.temperature[p] = th.bottomTemperature + (th.topTemperature - th.bottomTemperature) * s;
      tsum += this.temperature[p];
    }
    this.tref = tsum / n;
    this.initialHeat = this.heatInventory();

    // Pathline sample: evenly spread across the population, deterministic.
    const rng = createRng(cfg.seed ^ 0x9e3779b9);
    const want = Math.min(30, n);
    const chosen = new Set<number>();
    while (chosen.size < want) chosen.add(Math.floor(rng() * n));
    for (const p of [...chosen].sort((a, b) => a - b))
      this.pathlines.push({ particle: p, origin: this.origin[p], points: [] });

    this.classify();
    this.initialRepresented = this.fluidCellCount * this.h * this.h * this.depth;
    this.recordSamples(true);
  }

  // ---------------------------------------------------------------- seeding

  private seedPositions(): number[] {
    const cfg = this.cfg;
    const h = this.h;
    const ppa = Math.max(1, Math.round(cfg.particlesPerCellAxis));
    const s = h / ppa;
    const rng = createRng(cfg.seed);
    const out: number[] = [];
    const loc = new Float64Array(2);
    const pose = this.pose;
    const vc = cfg.vessel;
    const sp = this.vessel.spoutPolygon;
    const margin = Math.max(0.5 * s, 0.25 * h);
    const total = Math.ceil(cfg.domainWidth / s);
    const totalY = Math.ceil(cfg.domainHeight / s);
    for (let b = 0; b < totalY; b++) {
      for (let a = 0; a < total; a++) {
        const wx = (a + 0.5 + (rng() - 0.5) * cfg.jitter) * s;
        const wy = (b + 0.5 + (rng() - 0.5) * cfg.jitter) * s;
        if (wx < 1.5 * h || wy < 1.5 * h || wx > cfg.domainWidth - 1.5 * h || wy > cfg.domainHeight - 1.5 * h)
          continue;
        worldToLocal(pose, wx, wy, loc);
        const lx = loc[0];
        const ly = loc[1];
        if (ly < 0 || ly > cfg.fillHeight) continue;
        const cav = this.vessel.cavity;
        const inBody = cav ? pointInPolygon(cav, lx, ly) : lx >= 0 && lx <= vc.innerWidth;
        const inSpout = !inBody && sp !== null && pointInPolygon(sp, lx, ly);
        if (!inBody && !inSpout) continue;
        if (vesselSdf(this.vessel, lx, ly) < margin) continue;
        out.push(wx, wy);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- public API

  /** Manual mode: set the tilt the user is asking for (degrees); recorded with the simulated time. */
  setTiltTarget(angleDeg: number): void {
    this.controller.setTarget(angleDeg, this.time);
  }

  /** Advance by a duration of simulated time using adaptive substeps. */
  advance(duration: number): Diagnostics {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Whole stable substeps only (clipped solely at the experiment's end), so the substep sequence
    // and therefore the result do not depend on how callers chunk simulated time. The last
    // substep may overshoot `duration` by less than one substep.
    const end = this.time + duration;
    let sub = 0;
    this.pressureItersMaxAdvance = 0;
    while (this.time < end - 1e-12 && !this.finished) {
      const dt = Math.min(this.stableDt(), this.cfg.duration - this.time);
      this.step(dt);
      sub++;
    }
    this.lastSubsteps = sub;
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.lastWallMs = t1 - t0;
    return this.diagnostics();
  }

  get finished(): boolean {
    return this.time >= this.cfg.duration - 1e-9;
  }

  stableDt(): number {
    const { h, cfg } = this;
    let umax = 0;
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== STATUS_IN_POT) continue;
      const s = this.vx[p] * this.vx[p] + this.vy[p] * this.vy[p];
      if (s > umax) umax = s;
    }
    umax = Math.sqrt(umax);
    // Wall speed bound: |omega| times the largest distance from the pivot within the domain.
    const R = Math.hypot(cfg.domainWidth, cfg.domainHeight);
    const wall = Math.abs(this.pose.omega) * R;
    const speed = umax + SQRT5 * Math.sqrt(h * cfg.gravity) + wall;
    let dt = Math.min(cfg.maxSubstep, (cfg.cfl * h) / speed);
    // Explicit viscosity and heat diffusion stay stable for D dt / h^2 <= 0.2 (only binding when
    // the diffusivities are large, e.g. in the convection benchmark).
    if (cfg.viscosity && cfg.kinematicViscosity > 0)
      dt = Math.min(dt, (0.2 * h * h) / cfg.kinematicViscosity);
    if (cfg.thermal.mode !== 'off' && cfg.thermalDiffusivity > 0)
      dt = Math.min(dt, (0.2 * h * h) / cfg.thermalDiffusivity);
    return dt;
  }

  step(dt: number): void {
    const cfg = this.cfg;
    const discharged = this.counts[STATUS_DISCHARGED] * this.parcelVolume;
    const tilt1 = this.controller.advance(this.time + dt, dt, discharged);
    const phi1 = -tilt1; // positive tilt toward the right-hand spout = clockwise
    const omega = (phi1 - this.phi) / dt;
    this.pose = makePose(this.phi, omega, cfg.pivotLocal, cfg.pivotWorld);

    this.classify();
    this.particlesToGrid();
    this.uPrev.set(this.u);
    this.vPrev.set(this.v);
    this.applyBodyForces(dt);
    if (cfg.viscosity && cfg.kinematicViscosity > 0) this.applyViscosity(dt);
    this.setSolidFaces();
    this.project(dt);
    this.extrapolate(3);
    this.gridToParticles();
    this.densityCorrection(dt);

    const poseOld = this.pose;
    const poseNew = makePose(phi1, omega, cfg.pivotLocal, cfg.pivotWorld);
    this.advect(dt, poseOld, poseNew);
    if (cfg.thermal.mode !== 'off') this.thermalStep(dt);

    this.phi = phi1;
    this.pose = poseNew;
    this.time += dt;
    this.steps++;
    this.lastDt = dt;
    this.recordSamples(false);
  }

  // ---------------------------------------------------------------- grid helpers

  private classify(): void {
    const { nx, ny, h, cell, border, pose, vessel } = this;
    const loc = this.scratch;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + j * nx;
        if (border[c]) {
          cell[c] = CELL_SOLID;
          continue;
        }
        worldToLocal(pose, (i + 0.5) * h, (j + 0.5) * h, loc);
        cell[c] = vesselSdf(vessel, loc[0], loc[1]) < 0 ? CELL_SOLID : CELL_AIR;
      }
    }
    let fc = 0;
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== STATUS_IN_POT) continue;
      const i = Math.floor(this.x[p] / h);
      const j = Math.floor(this.y[p] / h);
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const c = i + j * nx;
      if (cell[c] === CELL_AIR) {
        cell[c] = CELL_FLUID;
        fc++;
      }
    }
    this.fluidCellCount = fc;
    // Face solidity.
    const { uSolid, vSolid } = this;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const f = i + j * (nx + 1);
        uSolid[f] =
          i === 0 || i === nx || cell[i - 1 + j * nx] === CELL_SOLID || cell[i + j * nx] === CELL_SOLID
            ? 1
            : 0;
      }
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        vSolid[f] =
          j === 0 || j === ny || cell[i + (j - 1) * nx] === CELL_SOLID || cell[i + j * nx] === CELL_SOLID
            ? 1
            : 0;
      }
  }

  /** Bilinear stencil for a u-face sample: returns base index; weights in w4. */
  private stencilU(x: number, y: number, w4: Float64Array): number {
    const { nx, ny, h } = this;
    const gx = x / h;
    const gy = y / h - 0.5;
    let i = Math.floor(gx);
    let j = Math.floor(gy);
    if (i < 0) i = 0;
    else if (i > nx - 1) i = nx - 1;
    if (j < 0) j = 0;
    else if (j > ny - 2) j = ny - 2;
    let fx = gx - i;
    let fy = gy - j;
    fx = fx < 0 ? 0 : fx > 1 ? 1 : fx;
    fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
    w4[0] = (1 - fx) * (1 - fy);
    w4[1] = fx * (1 - fy);
    w4[2] = (1 - fx) * fy;
    w4[3] = fx * fy;
    w4[4] = fx;
    w4[5] = fy;
    return i + j * (nx + 1);
  }

  private stencilV(x: number, y: number, w4: Float64Array): number {
    const { nx, ny, h } = this;
    const gx = x / h - 0.5;
    const gy = y / h;
    let i = Math.floor(gx);
    let j = Math.floor(gy);
    if (i < 0) i = 0;
    else if (i > nx - 2) i = nx - 2;
    if (j < 0) j = 0;
    else if (j > ny - 1) j = ny - 1;
    let fx = gx - i;
    let fy = gy - j;
    fx = fx < 0 ? 0 : fx > 1 ? 1 : fx;
    fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
    w4[0] = (1 - fx) * (1 - fy);
    w4[1] = fx * (1 - fy);
    w4[2] = (1 - fx) * fy;
    w4[3] = fx * fy;
    w4[4] = fx;
    w4[5] = fy;
    return i + j * nx;
  }

  private w6 = new Float64Array(6);
  // Reusable scratch for allocation-free inner loops.
  private ws4 = new Float64Array(4);
  private cs4 = new Int32Array(4);
  private nb4 = new Int32Array(4);

  /** Plain bilinear sample of a u-like field. */
  sampleU(field: Float64Array, x: number, y: number): number {
    const w = this.w6;
    const k = this.stencilU(x, y, w);
    const s = this.nx + 1;
    return w[0] * field[k] + w[1] * field[k + 1] + w[2] * field[k + s] + w[3] * field[k + s + 1];
  }

  sampleV(field: Float64Array, x: number, y: number): number {
    const w = this.w6;
    const k = this.stencilV(x, y, w);
    const s = this.nx;
    return w[0] * field[k] + w[1] * field[k + 1] + w[2] * field[k + s] + w[3] * field[k + s + 1];
  }

  private particlesToGrid(): void {
    const { u, v, uw, vw, n, h } = this;
    u.fill(0);
    v.fill(0);
    uw.fill(0);
    vw.fill(0);
    const apic = this.cfg.transfer === 'apic';
    const w = this.w6;
    const su = this.nx + 1;
    const sv = this.nx;
    for (let p = 0; p < n; p++) {
      if (this.status[p] !== STATUS_IN_POT) continue;
      const px = this.x[p];
      const py = this.y[p];
      let k = this.stencilU(px, py, w);
      let vel = this.vx[p];
      if (apic) {
        // Face positions relative to the particle: x_face - x_p.
        const i = k % su;
        const j = (k - i) / su;
        const fx0 = i * h - px;
        const fy0 = (j + 0.5) * h - py;
        const cx = this.cux[p];
        const cy = this.cuy[p];
        const a0 = vel + cx * fx0 + cy * fy0;
        const a1 = a0 + cx * h;
        const a2 = a0 + cy * h;
        const a3 = a0 + cx * h + cy * h;
        u[k] += w[0] * a0;
        u[k + 1] += w[1] * a1;
        u[k + su] += w[2] * a2;
        u[k + su + 1] += w[3] * a3;
      } else {
        u[k] += w[0] * vel;
        u[k + 1] += w[1] * vel;
        u[k + su] += w[2] * vel;
        u[k + su + 1] += w[3] * vel;
      }
      uw[k] += w[0];
      uw[k + 1] += w[1];
      uw[k + su] += w[2];
      uw[k + su + 1] += w[3];

      k = this.stencilV(px, py, w);
      vel = this.vy[p];
      if (apic) {
        const i = k % sv;
        const j = (k - i) / sv;
        const fx0 = (i + 0.5) * h - px;
        const fy0 = j * h - py;
        const cx = this.cvx[p];
        const cy = this.cvy[p];
        const a0 = vel + cx * fx0 + cy * fy0;
        v[k] += w[0] * a0;
        v[k + 1] += w[1] * (a0 + cx * h);
        v[k + sv] += w[2] * (a0 + cy * h);
        v[k + sv + 1] += w[3] * (a0 + cx * h + cy * h);
      } else {
        v[k] += w[0] * vel;
        v[k + 1] += w[1] * vel;
        v[k + sv] += w[2] * vel;
        v[k + sv + 1] += w[3] * vel;
      }
      vw[k] += w[0];
      vw[k + 1] += w[1];
      vw[k + sv] += w[2];
      vw[k + sv + 1] += w[3];
    }
    for (let f = 0; f < u.length; f++) u[f] = uw[f] > 1e-9 ? u[f] / uw[f] : 0;
    for (let f = 0; f < v.length; f++) v[f] = vw[f] > 1e-9 ? v[f] / vw[f] : 0;

    if (this.cfg.thermal.mode !== 'off') this.temperatureToGrid();
  }

  private temperatureToGrid(): void {
    const { nx, ny, h, cellT, cellTw } = this;
    cellT.fill(0);
    cellTw.fill(0);
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== STATUS_IN_POT) continue;
      const gx = this.x[p] / h - 0.5;
      const gy = this.y[p] / h - 0.5;
      const i = Math.max(0, Math.min(nx - 2, Math.floor(gx)));
      const j = Math.max(0, Math.min(ny - 2, Math.floor(gy)));
      const fx = Math.max(0, Math.min(1, gx - i));
      const fy = Math.max(0, Math.min(1, gy - j));
      const c = i + j * nx;
      const T = this.temperature[p];
      const ws = this.ws4;
      const cs = this.cs4;
      ws[0] = (1 - fx) * (1 - fy);
      ws[1] = fx * (1 - fy);
      ws[2] = (1 - fx) * fy;
      ws[3] = fx * fy;
      cs[0] = c;
      cs[1] = c + 1;
      cs[2] = c + nx;
      cs[3] = c + nx + 1;
      for (let k = 0; k < 4; k++) {
        cellT[cs[k]] += ws[k] * T;
        cellTw[cs[k]] += ws[k];
      }
    }
    for (let c = 0; c < cellT.length; c++) {
      if (this.cell[c] === CELL_FLUID && cellTw[c] > 1e-9) cellT[c] /= cellTw[c];
      else if (this.cell[c] === CELL_FLUID) cellT[c] = this.tref;
      else cellT[c] = 0;
    }
  }

  private applyBodyForces(dt: number): void {
    const { nx, ny, v, cell, cfg } = this;
    const g = cfg.gravity;
    const coupled = cfg.thermal.mode === 'coupled';
    const beta = cfg.thermalExpansion;
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const below = cell[i + (j - 1) * nx];
        const above = cell[i + j * nx];
        if (below !== CELL_FLUID && above !== CELL_FLUID) continue;
        let a = -g;
        if (coupled) {
          let T = 0;
          let c = 0;
          if (below === CELL_FLUID) {
            T += this.cellT[i + (j - 1) * nx];
            c++;
          }
          if (above === CELL_FLUID) {
            T += this.cellT[i + j * nx];
            c++;
          }
          // Boussinesq: rho = rho0 (1 - beta (T - Tref)); buoyant acceleration relative to rho0 g.
          a += g * beta * (T / c - this.tref);
        }
        v[i + j * nx] += a * dt;
      }
    }
  }

  /** Explicit viscous diffusion of face velocities; zero-gradient at air and solid neighbours (free-slip). */
  private applyViscosity(dt: number): void {
    const { nx, ny, h, cfg, cell } = this;
    const k = (cfg.kinematicViscosity * dt) / (h * h);
    // Liquid faces: not solid and next to a liquid cell. uValid/vValid serve as scratch here;
    // extrapolate() recomputes them after the projection.
    const um = this.uValid;
    const vm = this.vValid;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const f = i + j * (nx + 1);
        um[f] =
          !this.uSolid[f] && (cell[i - 1 + j * nx] === CELL_FLUID || cell[i + j * nx] === CELL_FLUID) ? 1 : 0;
      }
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        vm[f] =
          !this.vSolid[f] && (cell[i + (j - 1) * nx] === CELL_FLUID || cell[i + j * nx] === CELL_FLUID)
            ? 1
            : 0;
      }
    const noSlip = cfg.wallTreatment === 'no-slip';
    const om = this.pose.omega;
    const pose = this.pose;
    // `tangentialAlongI`: for v the walls tangential to the flow are left/right neighbours (i +- 1);
    // for u they are the neighbours above/below (j +- 1). No-slip uses a ghost value mirrored about
    // the wall (half a cell away): contribution 2 (u_wall - u).
    const lap = (
      f: Float64Array,
      tmp: Float64Array,
      mask: Uint8Array,
      solid: Uint8Array,
      w: number,
      hgt: number,
      tangentialAlongI: boolean,
      wallVel: (i: number, j: number) => number,
    ) => {
      tmp.set(f);
      for (let j = 0; j < hgt; j++)
        for (let i = 0; i < w; i++) {
          const c = i + j * w;
          if (!mask[c]) continue;
          const fc = f[c];
          let s = 0;
          if (i > 0 && mask[c - 1]) s += f[c - 1] - fc;
          else if (noSlip && tangentialAlongI && (i === 0 || solid[c - 1])) s += 2 * (wallVel(i - 1, j) - fc);
          if (i < w - 1 && mask[c + 1]) s += f[c + 1] - fc;
          else if (noSlip && tangentialAlongI && (i === w - 1 || solid[c + 1]))
            s += 2 * (wallVel(i + 1, j) - fc);
          if (j > 0 && mask[c - w]) s += f[c - w] - fc;
          else if (noSlip && !tangentialAlongI && (j === 0 || solid[c - w]))
            s += 2 * (wallVel(i, j - 1) - fc);
          if (j < hgt - 1 && mask[c + w]) s += f[c + w] - fc;
          else if (noSlip && !tangentialAlongI && (j === hgt - 1 || solid[c + w]))
            s += 2 * (wallVel(i, j + 1) - fc);
          tmp[c] = fc + k * s;
        }
      f.set(tmp);
    };
    // Rigid wall velocity components (zero for the static domain border and a resting vessel).
    // Faces next to the static domain border (outermost cell rows/columns) have zero wall velocity.
    lap(this.u, this.uTmp, um, this.uSolid, nx + 1, ny, false, (_i, j) =>
      j <= 0 || j >= ny - 1 ? 0 : -om * ((j + 0.5) * h - pose.pwy),
    );
    lap(this.v, this.vTmp, vm, this.vSolid, nx, ny + 1, true, (i) =>
      i <= 0 || i >= nx - 1 ? 0 : om * ((i + 0.5) * h - pose.pwx),
    );
  }

  /** Solid faces carry the normal component of the rigid wall velocity omega x (x - pivot). */
  private setSolidFaces(): void {
    const { nx, ny, h, cell, border, pose } = this;
    const om = pose.omega;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const f = i + j * (nx + 1);
        if (!this.uSolid[f]) continue;
        const l = i - 1 + j * nx;
        const r = i + j * nx;
        const domainWall =
          i === 0 ||
          i === nx ||
          (cell[l] === CELL_SOLID && border[l]) ||
          (cell[r] === CELL_SOLID && border[r]);
        this.u[f] = domainWall ? 0 : -om * ((j + 0.5) * h - pose.pwy);
      }
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        if (!this.vSolid[f]) continue;
        const b = i + (j - 1) * nx;
        const t = i + j * nx;
        const domainWall =
          j === 0 ||
          j === ny ||
          (cell[b] === CELL_SOLID && border[b]) ||
          (cell[t] === CELL_SOLID && border[t]);
        this.v[f] = domainWall ? 0 : om * ((i + 0.5) * h - pose.pwx);
      }
  }

  /** Max |div u| over fluid cells, in 1/s. */
  maxDivergence(): number {
    const { nx, ny, h, cell, u, v } = this;
    let m = 0;
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        if (cell[c] !== CELL_FLUID) continue;
        const d =
          Math.abs(u[i + 1 + j * (nx + 1)] - u[i + j * (nx + 1)] + v[i + (j + 1) * nx] - v[i + j * nx]) / h;
        if (d > m) m = d;
      }
    return m;
  }

  private project(dt: number): void {
    const { nx, ny, cell, u, v, rhs, pressure } = this;
    rhs.fill(0);
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        if (cell[c] !== CELL_FLUID) continue;
        rhs[c] = -(u[i + 1 + j * (nx + 1)] - u[i + j * (nx + 1)] + v[i + (j + 1) * nx] - v[i + j * nx]);
      }
    this.divBefore = this.maxDivergence();
    const res = this.pressureSolver.solve(
      cell,
      rhs,
      pressure,
      this.cfg.pressureTolerance,
      this.cfg.pressureMaxIterations,
    );
    this.lastPressure = res;
    if (res.iterations > this.pressureItersMaxAdvance) this.pressureItersMaxAdvance = res.iterations;
    if (!res.converged) this.pressureFailures++;
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const f = i + j * (nx + 1);
        if (this.uSolid[f]) continue;
        const l = i - 1 + j * nx;
        const r = i + j * nx;
        if (cell[l] !== CELL_FLUID && cell[r] !== CELL_FLUID) continue;
        u[f] -= pressure[r] - pressure[l];
      }
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        if (this.vSolid[f]) continue;
        const b = i + (j - 1) * nx;
        const t = i + j * nx;
        if (cell[b] !== CELL_FLUID && cell[t] !== CELL_FLUID) continue;
        v[f] -= pressure[t] - pressure[b];
      }
    this.divAfter = this.maxDivergence();
    // Convert to pascals for reporting: p = q rho h / dt.
    const scale = (this.cfg.density * this.h) / dt;
    for (let k = 0; k < this.pressureSolver.fluidCount; k++)
      pressure[this.pressureSolver.fluidList[k]] *= scale;
  }

  private extrapolate(layers: number): void {
    const { nx, ny, cell } = this;
    const uValid = this.uValid;
    const vValid = this.vValid;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const f = i + j * (nx + 1);
        uValid[f] =
          this.uSolid[f] ||
          (i > 0 && i < nx && (cell[i - 1 + j * nx] === CELL_FLUID || cell[i + j * nx] === CELL_FLUID))
            ? 1
            : 0;
      }
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        vValid[f] =
          this.vSolid[f] ||
          (j > 0 && j < ny && (cell[i + (j - 1) * nx] === CELL_FLUID || cell[i + j * nx] === CELL_FLUID))
            ? 1
            : 0;
      }
    this.extrapolateField(this.u, uValid, nx + 1, ny, layers, this.uTmp);
    this.extrapolateField(this.v, vValid, nx, ny + 1, layers, this.vTmp);
  }

  private extrapolateField(
    f: Float64Array,
    valid: Uint8Array,
    w: number,
    hgt: number,
    layers: number,
    tmp: Float64Array,
  ): void {
    const mark = this.validTmp;
    // Work on a copy of the valid mask so the original (pre-extrapolation) mask stays available for G2P.
    const vm = mark.subarray(0, w * hgt);
    vm.set(valid);
    for (let L = 0; L < layers; L++) {
      tmp.set(f);
      const newly = this.newlyBuf;
      let count = 0;
      for (let j = 0; j < hgt; j++)
        for (let i = 0; i < w; i++) {
          const c = i + j * w;
          if (vm[c]) continue;
          let s = 0;
          let k = 0;
          if (i > 0 && vm[c - 1]) {
            s += f[c - 1];
            k++;
          }
          if (i < w - 1 && vm[c + 1]) {
            s += f[c + 1];
            k++;
          }
          if (j > 0 && vm[c - w]) {
            s += f[c - w];
            k++;
          }
          if (j < hgt - 1 && vm[c + w]) {
            s += f[c + w];
            k++;
          }
          if (k > 0) {
            tmp[c] = s / k;
            newly[count++] = c;
          }
        }
      if (count === 0) break;
      f.set(tmp);
      for (let q = 0; q < count; q++) vm[newly[q]] = 1;
    }
  }

  /** Validity-weighted bilinear sample (only faces adjacent to liquid or solid contribute). */
  private sampleMasked(
    field: Float64Array,
    valid: Uint8Array,
    k: number,
    s: number,
    w: Float64Array,
  ): number {
    let acc = 0;
    let ws = 0;
    if (valid[k]) {
      acc += w[0] * field[k];
      ws += w[0];
    }
    if (valid[k + 1]) {
      acc += w[1] * field[k + 1];
      ws += w[1];
    }
    if (valid[k + s]) {
      acc += w[2] * field[k + s];
      ws += w[2];
    }
    if (valid[k + s + 1]) {
      acc += w[3] * field[k + s + 1];
      ws += w[3];
    }
    if (ws > 1e-9) return acc / ws;
    return w[0] * field[k] + w[1] * field[k + 1] + w[2] * field[k + s] + w[3] * field[k + s + 1];
  }

  private gridToParticles(): void {
    const { n, u, v, uPrev, vPrev, uValid, vValid, h } = this;
    const alpha = this.cfg.flipRatio;
    const apic = this.cfg.transfer === 'apic';
    const w = this.w6;
    const su = this.nx + 1;
    const sv = this.nx;
    for (let p = 0; p < n; p++) {
      if (this.status[p] !== STATUS_IN_POT) continue;
      const px = this.x[p];
      const py = this.y[p];
      let k = this.stencilU(px, py, w);
      const uNew = this.sampleMasked(u, uValid, k, su, w);
      if (apic) {
        this.vx[p] = uNew;
        // C = sum_i u_i grad(w_ip) for the bilinear kernel.
        const fx = w[4];
        const fy = w[5];
        const u00 = u[k];
        const u10 = u[k + 1];
        const u01 = u[k + su];
        const u11 = u[k + su + 1];
        this.cux[p] = ((1 - fy) * (u10 - u00) + fy * (u11 - u01)) / h;
        this.cuy[p] = ((1 - fx) * (u01 - u00) + fx * (u11 - u10)) / h;
      } else {
        const uOld = this.sampleMasked(uPrev, uValid, k, su, w);
        this.vx[p] = (1 - alpha) * uNew + alpha * (this.vx[p] + uNew - uOld);
      }
      k = this.stencilV(px, py, w);
      const vNew = this.sampleMasked(v, vValid, k, sv, w);
      if (apic) {
        this.vy[p] = vNew;
        const fx = w[4];
        const fy = w[5];
        const v00 = v[k];
        const v10 = v[k + 1];
        const v01 = v[k + sv];
        const v11 = v[k + sv + 1];
        this.cvx[p] = ((1 - fy) * (v10 - v00) + fy * (v11 - v01)) / h;
        this.cvy[p] = ((1 - fx) * (v01 - v00) + fx * (v11 - v10)) / h;
      } else {
        const vOld = this.sampleMasked(vPrev, vValid, k, sv, w);
        this.vy[p] = (1 - alpha) * vNew + alpha * (this.vy[p] + vNew - vOld);
      }
    }
  }

  /**
   * FLIP particles slowly cluster, which loses represented volume. Cells whose parcel density
   * exceeds the seeding density get a target expansion; a second pressure-like solve turns that
   * into a divergence-only correction velocity used for positions only (no momentum injected).
   */
  private densityCorrection(dt: number): void {
    const kappa = this.cfg.densityCorrection;
    this.uCorr.fill(0);
    this.vCorr.fill(0);
    this.maxDensityRatio = 0;
    const { nx, ny, h, cell, cellDensity, rhs } = this;
    cellDensity.fill(0);
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== STATUS_IN_POT) continue;
      const gx = this.x[p] / h - 0.5;
      const gy = this.y[p] / h - 0.5;
      const i = Math.max(0, Math.min(nx - 2, Math.floor(gx)));
      const j = Math.max(0, Math.min(ny - 2, Math.floor(gy)));
      const fx = Math.max(0, Math.min(1, gx - i));
      const fy = Math.max(0, Math.min(1, gy - j));
      const c = i + j * nx;
      cellDensity[c] += (1 - fx) * (1 - fy);
      cellDensity[c + 1] += fx * (1 - fy);
      cellDensity[c + nx] += (1 - fx) * fy;
      cellDensity[c + nx + 1] += fx * fy;
    }
    const rest = this.cfg.particlesPerCellAxis * this.cfg.particlesPerCellAxis;
    rhs.fill(0);
    let any = false;
    let interior = 0;
    let interiorSum = 0;
    for (let c = 0; c < nx * ny; c++) {
      if (cell[c] !== CELL_FLUID) continue;
      const ratio = cellDensity[c] / rest;
      if (ratio > this.maxDensityRatio) this.maxDensityRatio = ratio;
      // Interior cells (no air neighbour) measure compression without free-surface partial cells.
      const isInterior =
        cell[c - 1] !== CELL_AIR &&
        cell[c + 1] !== CELL_AIR &&
        cell[c - nx] !== CELL_AIR &&
        cell[c + nx] !== CELL_AIR;
      if (isInterior) {
        interior++;
        interiorSum += ratio;
      }
      // Interior cells are corrected in both directions (an expansion-only rule is biased by
      // sampling noise); surface cells only expand because partial cells legitimately read low.
      if (kappa > 0 && (ratio > 1 || isInterior)) {
        // Desired net outflux (m/s): expand by kappa * excess per step.
        rhs[c] = (kappa * (ratio - 1) * h) / dt;
        any = true;
      }
    }
    this.interiorDensity = interior > 0 ? interiorSum / interior : 1;
    if (!any) return;
    const res = this.pressureSolver.solve(cell, rhs, this.qCorr, 1e-4, 100);
    this.densityIterations = res.iterations;
    const q = this.qCorr;
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const f = i + j * (nx + 1);
        if (this.uSolid[f]) continue;
        const l = i - 1 + j * nx;
        const r = i + j * nx;
        if (cell[l] !== CELL_FLUID && cell[r] !== CELL_FLUID) continue;
        this.uCorr[f] = -(q[r] - q[l]);
      }
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        if (this.vSolid[f]) continue;
        const b = i + (j - 1) * nx;
        const t = i + j * nx;
        if (cell[b] !== CELL_FLUID && cell[t] !== CELL_FLUID) continue;
        this.vCorr[f] = -(q[t] - q[b]);
      }
  }

  // ---------------------------------------------------------------- advection & accounting

  private advect(dt: number, poseOld: Pose, poseNew: Pose): void {
    const { n, u, v, h, cfg, vessel } = this;
    const loc0 = this.scratch;
    const loc1 = this.scratch2;
    const grad = new Float64Array(2);
    const margin = 0.1 * h;
    const lo = h + 1e-6;
    const xmax = this.nx * h - h - 1e-6;
    const ymax = this.ny * h - h - 1e-6;
    const out = vessel.outflow;
    const env = vessel.envelope;
    const g = cfg.gravity;
    const corr = cfg.densityCorrection > 0;
    for (let p = 0; p < n; p++) {
      const st = this.status[p];
      if (st === STATUS_DISCHARGED || st === STATUS_SPILLED) {
        // Visual-only ballistic continuation of removed parcels (not part of the liquid solve).
        if (this.y[p] > -1) {
          this.vy[p] -= g * dt;
          this.x[p] += this.vx[p] * dt;
          this.y[p] += this.vy[p] * dt;
        }
        continue;
      }
      if (st !== STATUS_IN_POT) continue;
      const x0 = this.x[p];
      const y0 = this.y[p];
      worldToLocal(poseOld, x0, y0, loc0);
      const lx0 = loc0[0];
      const ly0 = loc0[1];
      // RK2 (midpoint) in the projected, extrapolated grid field.
      const u1 = this.sampleU(u, x0, y0);
      const v1 = this.sampleV(v, x0, y0);
      const xm = x0 + 0.5 * dt * u1;
      const ym = y0 + 0.5 * dt * v1;
      let x1 = x0 + dt * this.sampleU(u, xm, ym);
      let y1 = y0 + dt * this.sampleV(v, xm, ym);
      if (corr) {
        // Density correction moves positions only; it is logged separately from advection.
        const cx = dt * this.sampleU(this.uCorr, x0, y0);
        const cy = dt * this.sampleV(this.vCorr, x0, y0);
        x1 += cx;
        y1 += cy;
        this.densityDisplacement += Math.hypot(cx, cy);
      }

      // Collision against the vessel at its new pose.
      worldToLocal(poseNew, x1, y1, loc1);
      // Cheap far-field check first; the exact distance and gradient only near walls.
      let collided = false;
      const d =
        vesselSdf(vessel, loc1[0], loc1[1]) < margin ? vesselSdfGrad(vessel, loc1[0], loc1[1], grad) : margin;
      if (d < margin) {
        collided = true;
        const push = margin - d;
        loc1[0] += grad[0] * push;
        loc1[1] += grad[1] * push;
        localToWorld(poseNew, loc1[0], loc1[1], this.scratch);
        x1 = this.scratch[0];
        y1 = this.scratch[1];
        this.collisionCorrections++;
        this.collisionDisplacement += push;
        // Remove the inward normal component of the velocity relative to the moving wall.
        const nwx = poseNew.cos * grad[0] - poseNew.sin * grad[1];
        const nwy = poseNew.sin * grad[0] + poseNew.cos * grad[1];
        const wvx = -poseNew.omega * (y1 - poseNew.pwy);
        const wvy = poseNew.omega * (x1 - poseNew.pwx);
        const rn = (this.vx[p] - wvx) * nwx + (this.vy[p] - wvy) * nwy;
        if (rn < 0) {
          this.vx[p] -= rn * nwx;
          this.vy[p] -= rn * nwy;
        }
      }
      if (
        !Number.isFinite(x1) ||
        !Number.isFinite(y1) ||
        !Number.isFinite(this.vx[p]) ||
        !Number.isFinite(this.vy[p])
      ) {
        this.setStatus(p, STATUS_LOST);
        continue;
      }
      worldToLocal(poseNew, x1, y1, loc1);
      this.x[p] = x1;
      this.y[p] = y1;
      if (out && crossesSection(out, lx0, ly0, loc1[0], loc1[1])) {
        this.setStatus(p, STATUS_DISCHARGED);
        this.exitTime[p] = this.time + dt;
        this.dischargeOrder.push(p);
        if (cfg.thermal.mode !== 'off') this.heatRemoved += this.temperature[p];
        continue;
      }
      const outsideEnv = loc1[0] < env.x0 || loc1[0] > env.x1 || loc1[1] < env.y0 || loc1[1] > env.y1;
      const atDomainEdge = x1 <= lo || y1 <= lo || x1 >= xmax || y1 >= ymax;
      if (outsideEnv || atDomainEdge) {
        this.setStatus(p, STATUS_SPILLED);
        this.exitTime[p] = this.time + dt;
        if (cfg.thermal.mode !== 'off') this.heatRemoved += this.temperature[p];
        continue;
      }
      // Deep inside a wall after correction means the collision failed: count it as lost.
      if (collided && vesselSdf(vessel, loc1[0], loc1[1]) < -0.5 * vessel.halfWall)
        this.setStatus(p, STATUS_LOST);
    }
  }

  private setStatus(p: number, s: number): void {
    this.counts[this.status[p]]--;
    this.counts[s]++;
    this.status[p] = s;
  }

  // ---------------------------------------------------------------- thermal

  private thermalStep(dt: number): void {
    const { nx, ny, h, cell, cellT, cellDT, cfg } = this;
    const th = cfg.thermal;
    const alpha = cfg.thermalDiffusivity;
    const rcp = cfg.density * cfg.specificHeat;
    const kd = (alpha * dt) / (h * h);
    const kw = (th.wallHeatTransfer * dt) / (rcp * h);
    const ks = (th.surfaceHeatTransfer * dt) / (rcp * h);
    const Ta = th.ambientTemperature;
    cellDT.fill(0);
    let lostPerDepth = 0;
    const fixedWalls = th.hotWallTemperature !== undefined && th.coldWallTemperature !== undefined;
    const Th = th.hotWallTemperature ?? Ta;
    const Tc = th.coldWallTemperature ?? Ta;
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        if (cell[c] !== CELL_FLUID) continue;
        const T = cellT[c];
        let dT = 0;
        const nbs = this.nb4;
        nbs[0] = c - 1;
        nbs[1] = c + 1;
        nbs[2] = c - nx;
        nbs[3] = c + nx;
        let boundary = 0;
        for (let k = 0; k < 4; k++) {
          const d = nbs[k];
          if (cell[d] === CELL_FLUID) dT += kd * (cellT[d] - T);
          else if (cell[d] === CELL_SOLID) {
            if (fixedWalls) {
              // Side walls at fixed temperature (wall half a cell away); floor and lid adiabatic.
              if (k < 2) {
                const Tw = k === 0 ? Th : Tc;
                const q = 2 * kd * (Tw - T);
                dT += q;
                boundary -= q;
              }
            } else {
              dT -= kw * (T - Ta);
              boundary += kw * (T - Ta);
            }
          } else {
            dT -= ks * (T - Ta);
            boundary += ks * (T - Ta);
          }
        }
        cellDT[c] = dT;
        // Heat crossing boundaries (diffusive exchange between fluid cells cancels in the sum).
        lostPerDepth += boundary;
      }
    // Boundary heat in units of "parcel-kelvin" so it is comparable with the parcel inventory.
    const cellsPerParcel = (h * h * this.depth) / this.parcelVolume;
    this.heatLostBoundary += lostPerDepth * cellsPerParcel;
    // FLIP-style update: parcels receive the interpolated grid temperature change (no smoothing).
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== STATUS_IN_POT) continue;
      const gx = this.x[p] / h - 0.5;
      const gy = this.y[p] / h - 0.5;
      const i = Math.max(0, Math.min(nx - 2, Math.floor(gx)));
      const j = Math.max(0, Math.min(ny - 2, Math.floor(gy)));
      const fx = Math.max(0, Math.min(1, gx - i));
      const fy = Math.max(0, Math.min(1, gy - j));
      const c = i + j * nx;
      const ws = this.ws4;
      const cs = this.cs4;
      ws[0] = (1 - fx) * (1 - fy);
      ws[1] = fx * (1 - fy);
      ws[2] = (1 - fx) * fy;
      ws[3] = fx * fy;
      cs[0] = c;
      cs[1] = c + 1;
      cs[2] = c + nx;
      cs[3] = c + nx + 1;
      let acc = 0;
      let wsum = 0;
      for (let k = 0; k < 4; k++) {
        if (cell[cs[k]] !== CELL_FLUID) continue;
        acc += ws[k] * cellDT[cs[k]];
        wsum += ws[k];
      }
      if (wsum > 1e-9) this.temperature[p] += acc / wsum;
    }
  }

  /**
   * Mean Nusselt numbers on the hot (left) and cold (right) side walls of a differentially heated
   * cavity: Nu = (L / dT) * mean wall-normal temperature gradient, the gradient taken between the
   * wall and the adjacent liquid cell centre (half a cell). Null without fixed-temperature walls.
   */
  wallNusselt(): { hot: number; cold: number } | null {
    const th = this.cfg.thermal;
    if (th.hotWallTemperature === undefined || th.coldWallTemperature === undefined || th.mode === 'off')
      return null;
    const { nx, ny, h, cell, cellT } = this;
    const dT = th.hotWallTemperature - th.coldWallTemperature;
    const L = this.cfg.vessel.innerWidth;
    let hot = 0;
    let nh = 0;
    let cold = 0;
    let nc = 0;
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        if (cell[c] !== CELL_FLUID) continue;
        if (cell[c - 1] === CELL_SOLID) {
          hot += (th.hotWallTemperature - cellT[c]) / (h / 2);
          nh++;
        }
        if (cell[c + 1] === CELL_SOLID) {
          cold += (cellT[c] - th.coldWallTemperature) / (h / 2);
          nc++;
        }
      }
    if (nh === 0 || nc === 0 || dT === 0) return null;
    return { hot: ((hot / nh) * L) / dT, cold: ((cold / nc) * L) / dT };
  }

  /** Sum of parcel temperatures (parcel-kelvin); multiply by rho cp Vp for joules. */
  heatInventory(): number {
    let s = 0;
    for (let p = 0; p < this.n; p++) if (this.status[p] === STATUS_IN_POT) s += this.temperature[p];
    return s;
  }

  // ---------------------------------------------------------------- diagnostics

  private recordSamples(force: boolean): void {
    if (force || this.time >= this.nextHistory) {
      if (this.history.length < MAX_HISTORY) {
        const d = this.diagnostics();
        this.history.push({
          time: this.time,
          angleDeg: d.angleDeg,
          inPot: d.volumeInPot,
          discharged: d.volumeDischarged,
          spilled: d.volumeSpilled,
          lost: d.volumeLost,
          divergenceAfter: d.divergenceAfter,
          pressureResidual: d.pressureResidual,
          pressureIterations: d.pressureIterations,
          kineticEnergy: d.kineticEnergy,
          representedDrift: d.representedDrift,
          meanTemperature: d.meanTemperature,
        });
      }
      this.nextHistory = this.time + 0.05;
    }
    if (force || this.time >= this.nextPath) {
      for (const pl of this.pathlines) {
        if (pl.points.length >= PATHLINE_POINTS * 2) continue;
        if (this.status[pl.particle] !== STATUS_IN_POT && pl.points.length > 0) continue;
        // Pot-local coordinates: trails move with the pot and show where a parcel went inside it.
        worldToLocal(this.pose, this.x[pl.particle], this.y[pl.particle], this.scratch);
        pl.points.push(this.scratch[0], this.scratch[1]);
      }
      this.nextPath = this.time + 1 / 30;
    }
  }

  /** Parcel counts per ledger status [in pot, discharged, spilled, lost]. */
  statusCounts(): number[] {
    return this.counts.slice();
  }

  diagnostics(): Diagnostics {
    const c = this.statusCounts();
    const Vp = this.parcelVolume;
    let ke = 0;
    let pe = 0;
    let vmax = 0;
    let tsum = 0;
    for (let p = 0; p < this.n; p++) {
      if (this.status[p] !== STATUS_IN_POT) continue;
      const s2 = this.vx[p] * this.vx[p] + this.vy[p] * this.vy[p];
      ke += s2;
      pe += this.y[p];
      if (s2 > vmax) vmax = s2;
      tsum += this.temperature[p];
    }
    const m = this.cfg.density * Vp;
    const rep = this.fluidCellCount * this.h * this.h * this.depth;
    const inPot = c[STATUS_IN_POT];
    const heatNow = this.heatInventory();
    const heatErr =
      this.cfg.thermal.mode === 'off' || this.initialHeat === 0
        ? 0
        : (heatNow + this.heatLostBoundary + this.heatRemoved - this.initialHeat) / this.initialHeat;
    const vol = c.map((k) => k * Vp);
    return {
      time: this.time,
      steps: this.steps,
      substepsLastAdvance: this.lastSubsteps,
      dtLast: this.lastDt,
      angleDeg: this.controller.angleDeg,
      phase: this.controller.phase,
      particleCount: this.n,
      gridNx: this.nx,
      gridNy: this.ny,
      cellSize: this.h,
      fluidCells: this.fluidCellCount,
      pressureIterations: this.lastPressure.iterations,
      pressureIterationsMax: this.pressureItersMaxAdvance,
      pressureResidual: this.lastPressure.residual / this.h,
      pressureConverged: this.lastPressure.converged,
      pressureFailures: this.pressureFailures,
      divergenceBefore: this.divBefore,
      divergenceAfter: this.divAfter,
      maxSpeed: Math.sqrt(vmax),
      kineticEnergy: 0.5 * m * ke,
      potentialEnergy: m * this.cfg.gravity * pe,
      volumeInitial: this.cfg.initialVolume,
      volumeInPot: vol[STATUS_IN_POT],
      volumeDischarged: vol[STATUS_DISCHARGED],
      volumeSpilled: vol[STATUS_SPILLED],
      volumeLost: vol[STATUS_LOST],
      ledgerError: vol[0] + vol[1] + vol[2] + vol[3] - this.cfg.initialVolume,
      representedVolume: rep,
      // Represented volume per parcel volume, relative to the initial ratio (0 = no compression).
      representedDrift:
        this.initialRepresented > 0 && inPot > 0
          ? rep / (inPot * Vp) / (this.initialRepresented / this.cfg.initialVolume) - 1
          : 0,
      maxDensityRatio: this.maxDensityRatio,
      interiorDensity: this.interiorDensity,
      densityCorrectionDisplacement: this.densityDisplacement,
      densityCorrectionIterations: this.densityIterations,
      meanParticlesPerFluidCell: this.fluidCellCount > 0 ? inPot / this.fluidCellCount : 0,
      collisionCorrections: this.collisionCorrections,
      collisionDisplacement: this.collisionDisplacement,
      meanTemperature: inPot > 0 ? tsum / inPot : 0,
      thermalInventoryError: heatErr,
      wallClockMsLastAdvance: this.lastWallMs,
    };
  }

  snapshot(): RenderSnapshot {
    const n = this.n;
    const positions = new Float32Array(2 * n);
    const speed = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      positions[2 * p] = this.x[p];
      positions[2 * p + 1] = this.y[p];
      speed[p] = Math.hypot(this.vx[p], this.vy[p]);
    }
    return {
      time: this.time,
      angleDeg: this.controller.angleDeg,
      count: n,
      positions,
      status: this.status.slice(),
      temperature: this.cfg.thermal.mode === 'off' ? null : Float32Array.from(this.temperature),
      speed,
    };
  }
}
