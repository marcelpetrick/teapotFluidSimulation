// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Buffer layout and uniform packing of the WebGPU 3D solver. All grid fields live in three large
// storage buffers (f32 fields, i32 atomic accumulators, u32 flags), addressed by offsets carried
// in one uniform block. The WGSL struct declaration and the packing both come from FIELDS below,
// so the shader and the host can never disagree about the order.

import type { Simulation3D } from '../sim3d/solver3d';

/** Cells per workgroup of the liquid-cell compaction. */
export const BLOCK = 256;

/** Fixed-point scales of the atomic scatter (integer sums are order-independent: deterministic). */
export const SCALE_VEL = 1 << 20;
export const SCALE_WEIGHT = 1 << 24;
export const SCALE_RATIO = 1 << 16;

/** Stats block (i32 slots in the atomic buffer). Slots >= STAT_STEP are cleared every substep. */
export const STAT = {
  inPot: 0,
  discharged: 1,
  spilled: 2,
  lost: 3,
  originBottom: 4,
  originMiddle: 5,
  originTop: 6,
  pressureFailures: 7,
  maxSpeedSq: 8,
  maxDivergence: 9,
  interiorCount: 10,
  interiorSum: 11,
  pressureIterations: 12,
  correctionIterations: 13,
} as const;
export const STAT_STEP = 8;
export const STAT_SLOTS = 16;

type Kind = 'u32' | 'f32';

/** Uniform fields in declaration order. Everything is a 4-byte scalar (no padding surprises). */
export const FIELDS: [string, Kind][] = [
  ['nx', 'u32'],
  ['ny', 'u32'],
  ['nz', 'u32'],
  ['n', 'u32'],
  ['nu', 'u32'],
  ['nv', 'u32'],
  ['nw', 'u32'],
  ['nc', 'u32'],
  // f32 buffer
  ['fU', 'u32'],
  ['fV', 'u32'],
  ['fW', 'u32'],
  ['fUp', 'u32'],
  ['fVp', 'u32'],
  ['fWp', 'u32'],
  ['fUc', 'u32'],
  ['fVc', 'u32'],
  ['fWc', 'u32'],
  ['fRhs', 'u32'],
  ['fQ', 'u32'],
  ['fS', 'u32'],
  ['fR', 'u32'],
  ['fZ', 'u32'],
  ['fAs', 'u32'],
  ['fDiag', 'u32'],
  ['fCd', 'u32'],
  // u32 buffer
  ['uCell', 'u32'],
  ['uValid', 'u32'],
  ['uExtA', 'u32'],
  ['uExtB', 'u32'],
  ['uList', 'u32'],
  ['uBlock', 'u32'],
  ['uCount', 'u32'],
  ['blocks', 'u32'],
  ['uStatus', 'u32'],
  ['uOrigin', 'u32'],
  // i32 atomic buffer
  ['aSum', 'u32'],
  ['aWeight', 'u32'],
  ['aDensity', 'u32'],
  ['aOccupied', 'u32'],
  ['aStats', 'u32'],
  // physics and geometry
  ['h', 'f32'],
  ['dt', 'f32'],
  ['omega', 'f32'],
  ['c0', 'f32'],
  ['s0', 'f32'],
  ['c1', 'f32'],
  ['s1', 'f32'],
  ['pwx', 'f32'],
  ['pwy', 'f32'],
  ['pivx', 'f32'],
  ['pivy', 'f32'],
  ['gravity', 'f32'],
  ['flip', 'f32'],
  ['kappa', 'f32'],
  ['radius', 'f32'],
  ['height', 'f32'],
  ['wall', 'f32'],
  ['bore', 'f32'],
  ['ax', 'f32'],
  ['ay', 'f32'],
  ['dx', 'f32'],
  ['dy', 'f32'],
  ['spoutLength', 'f32'],
  ['tipX', 'f32'],
  ['tipY', 'f32'],
  ['pad0', 'u32'],
];

export type Params = Record<string, number>;

/** WGSL declaration of the uniform block. */
export function paramsStruct(): string {
  return `struct Params {\n${FIELDS.map(([n, k]) => `  ${n}: ${k},`).join('\n')}\n};`;
}

/** Size of the uniform block in bytes (multiple of 16). */
export function paramsBytes(): number {
  return Math.ceil((FIELDS.length * 4) / 16) * 16;
}

/** Pack params into the uniform layout; missing fields are an error (catches typos early). */
export function packParams(p: Params, out = new ArrayBuffer(paramsBytes())): ArrayBuffer {
  const u = new Uint32Array(out);
  const f = new Float32Array(out);
  FIELDS.forEach(([name, kind], i) => {
    const v = p[name];
    if (v === undefined) throw new Error(`missing uniform field ${name}`);
    if (kind === 'u32') u[i] = v;
    else f[i] = v;
  });
  return out;
}

export interface Layout {
  params: Params;
  /** Element counts of the three grid buffers. */
  floats: number;
  ints: number;
  flags: number;
  /** Number of faces over the three staggered components. */
  faces: number;
}

/** Grid sizes and offsets for a simulation (the CPU instance supplies grid, pivot and geometry). */
export function buildLayout(sim: Simulation3D): Layout {
  const { nx, ny, nz, n, h } = sim;
  const nu = (nx + 1) * ny * nz;
  const nv = nx * (ny + 1) * nz;
  const nw = nx * ny * (nz + 1);
  const nc = nx * ny * nz;
  const faces = nu + nv + nw;
  let f = 0;
  const take = (k: number) => {
    const o = f;
    f += k;
    return o;
  };
  // Face fields are stored component after component: u at 0, v at nu, w at nu + nv.
  const fU = take(faces);
  const fUp = take(faces);
  const fUc = take(faces);
  const fRhs = take(nc);
  const fQ = take(nc);
  const fS = take(nc);
  const fR = take(nc);
  const fZ = take(nc);
  const fAs = take(nc);
  const fDiag = take(nc);
  const fCd = take(nc);
  const floats = f;
  f = 0;
  const uCell = take(nc);
  const uValid = take(faces);
  const uExtA = take(faces);
  const uExtB = take(faces);
  const uList = take(nc);
  const blocks = Math.ceil(nc / BLOCK);
  const uBlock = take(blocks);
  const uCount = take(4);
  const uStatus = take(n);
  const uOrigin = take(n);
  const flags = f;
  f = 0;
  const aSum = take(faces);
  const aWeight = take(faces);
  const aDensity = take(nc);
  const aOccupied = take(nc);
  const aStats = take(STAT_SLOTS);
  const ints = f;
  const t = sim.pot.cfg;
  const params: Params = {
    nx,
    ny,
    nz,
    n,
    nu,
    nv,
    nw,
    nc,
    fU,
    fV: fU + nu,
    fW: fU + nu + nv,
    fUp,
    fVp: fUp + nu,
    fWp: fUp + nu + nv,
    fUc,
    fVc: fUc + nu,
    fWc: fUc + nu + nv,
    fRhs,
    fQ,
    fS,
    fR,
    fZ,
    fAs,
    fDiag,
    fCd,
    uCell,
    uValid,
    uExtA,
    uExtB,
    uList,
    uBlock,
    uCount,
    blocks,
    uStatus,
    uOrigin,
    aSum,
    aWeight,
    aDensity,
    aOccupied,
    aStats,
    h,
    dt: 0,
    omega: 0,
    c0: 1,
    s0: 0,
    c1: 1,
    s1: 0,
    pwx: sim.pivotWorld[0],
    pwy: sim.pivotWorld[1],
    pivx: sim.cfg.pivot[0],
    pivy: sim.cfg.pivot[1],
    gravity: sim.cfg.gravity,
    flip: sim.cfg.flipRatio,
    kappa: sim.cfg.densityCorrection,
    radius: t.radius,
    height: t.height,
    wall: t.wall,
    bore: t.boreRadius,
    ax: sim.pot.ax,
    ay: sim.pot.ay,
    dx: sim.pot.dx,
    dy: sim.pot.dy,
    spoutLength: t.spoutLength,
    tipX: sim.pot.tipX,
    tipY: sim.pot.tipY,
    pad0: 0,
  };
  return { params, floats, ints, flags, faces };
}

/** Solve settings (second bind group): tolerance, iteration cap and where to record the count. */
export function packSolve(
  tol: number,
  maxIter: number,
  statSlot: number,
  countFailure: boolean,
): ArrayBuffer {
  const out = new ArrayBuffer(16);
  new Float32Array(out)[0] = tol;
  const u = new Uint32Array(out);
  u[1] = maxIter;
  u[2] = statSlot;
  u[3] = countFailure ? 1 : 0;
  return out;
}

/** Bits of a non-negative f32 as stored by atomicMax in the stats block, back to a number. */
export function floatFromBits(bits: number): number {
  const b = new ArrayBuffer(4);
  new Int32Array(b)[0] = bits;
  return new Float32Array(b)[0];
}
