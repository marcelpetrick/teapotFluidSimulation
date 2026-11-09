// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// WGSL compute kernels of the WebGPU 3D solver: a step-by-step port of src/sim3d/solver3d.ts
// (classify, particle-to-grid, gravity and moving-wall faces, pressure projection, valid faces,
// extrapolation, grid-to-particle, density correction, advection with SDF collisions and the spout
// discharge plane). Scatter uses fixed-point integer atomics so sums do not depend on thread order,
// and the pressure solve runs in one workgroup with fixed-order reductions: a run is deterministic.

import { BLOCK, paramsStruct, SCALE_RATIO, SCALE_VEL, SCALE_WEIGHT, STAT } from './layout';

/** Chebyshev preconditioner: polynomial degree and the interval of D^-1 A it targets. */
export const CHEB_DEGREE = 6;
export const CHEB_UPPER = 2;
export const CHEB_LOWER = 0.05;
/** Liquid cells per thread whose index and diagonal stay in registers inside the pressure solve. */
export const PCG_CACHED = 8;

/** Threads per workgroup of the per-element kernels. */
export const WG = 64;

export function solverWgsl(): string {
  return /* wgsl */ `
${paramsStruct()}

struct Solve { tol: f32, maxIter: u32, statSlot: u32, countFailure: u32 };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> F: array<f32>;
@group(0) @binding(2) var<storage, read_write> A: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> U: array<u32>;
@group(0) @binding(4) var<storage, read_write> POS: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> VEL: array<vec4f>;

const AIR: u32 = 0u;
const FLUID: u32 = 1u;
const SOLID: u32 = 2u;
const IN_POT: u32 = 0u;
const DISCHARGED: u32 = 1u;
const SPILLED: u32 = 2u;
const LOST: u32 = 3u;
const SV: f32 = ${SCALE_VEL}.0;
const SW: f32 = ${SCALE_WEIGHT}.0;
const SR: f32 = ${SCALE_RATIO}.0;
const ST_MAXSPEED: u32 = ${STAT.maxSpeedSq}u;
const ST_MAXDIV: u32 = ${STAT.maxDivergence}u;
const ST_INTCOUNT: u32 = ${STAT.interiorCount}u;
const ST_INTSUM: u32 = ${STAT.interiorSum}u;
const ST_ORIGIN: u32 = ${STAT.originBottom}u;

fn gidx(g: vec3u, nwg: vec3u) -> u32 { return g.x + g.y * nwg.x * ${WG}u; }

// ---------------------------------------------------------------- geometry and frames

fn toLocal(c: f32, s: f32, w: vec3f) -> vec3f {
  let rx = w.x - P.pwx;
  let ry = w.y - P.pwy;
  return vec3f(c * rx + s * ry + P.pivx, -s * rx + c * ry + P.pivy, w.z - P.h);
}

fn toWorld(c: f32, s: f32, l: vec3f) -> vec3f {
  let rx = l.x - P.pivx;
  let ry = l.y - P.pivy;
  return vec3f(c * rx - s * ry + P.pwx, s * rx + c * ry + P.pwy, l.z + P.h);
}

fn spoutAxis(l: vec3f) -> vec2f {
  let px = l.x - P.ax;
  let py = l.y - P.ay;
  let s = px * P.dx + py * P.dy;
  let sc = clamp(s, 0.0, P.spoutLength);
  let qx = px - sc * P.dx;
  let qy = py - sc * P.dy;
  return vec2f(sqrt(qx * qx + qy * qy + l.z * l.z), s);
}

fn sdf(l: vec3f) -> f32 {
  let hw = P.wall / 2.0;
  let r = sqrt(l.x * l.x + l.z * l.z);
  let ring = abs(r - (P.radius + hw)) - hw;
  let yIn = max(-(l.y + P.wall), l.y - P.height);
  let side = max(ring, yIn);
  let floorD = max(abs(l.y + hw) - hw, r - (P.radius + P.wall));
  var solid = min(side, floorD);
  let a = spoutAxis(l);
  let along = max(-a.y, a.y - P.spoutLength);
  let tube = max(abs(a.x - (P.bore + hw)) - hw, along);
  solid = min(solid, max(tube, P.radius - r));
  let boreD = max(max(a.x - P.bore, -a.y - P.wall), a.y - P.spoutLength);
  return max(solid, -boreD);
}

// ---------------------------------------------------------------- grid helpers

fn cellAt(i: i32, j: i32, k: i32) -> u32 {
  if (i < 0 || j < 0 || k < 0 || i >= i32(P.nx) || j >= i32(P.ny) || k >= i32(P.nz)) { return SOLID; }
  return U[P.uCell + u32(i) + P.nx * (u32(j) + P.ny * u32(k))];
}

/** Sizes of a staggered component. */
fn compSize(comp: u32) -> vec3u {
  if (comp == 0u) { return vec3u(P.nx + 1u, P.ny, P.nz); }
  if (comp == 1u) { return vec3u(P.nx, P.ny + 1u, P.nz); }
  return vec3u(P.nx, P.ny, P.nz + 1u);
}

fn compOffset(comp: u32) -> vec3f {
  if (comp == 0u) { return vec3f(0.0, 0.5, 0.5); }
  if (comp == 1u) { return vec3f(0.5, 0.0, 0.5); }
  return vec3f(0.5, 0.5, 0.0);
}

/** Start of a component inside a face field (u, then v, then w). */
fn compBase(comp: u32) -> u32 {
  if (comp == 0u) { return 0u; }
  if (comp == 1u) { return P.nu; }
  return P.nu + P.nv;
}

struct Stencil { base: u32, f: vec3f, sx: u32, sxy: u32 };

fn stencil(p: vec3f, o: vec3f, sz: vec3u) -> Stencil {
  let g = p / P.h - o;
  let fl = floor(g);
  let i = clamp(i32(fl.x), 0, i32(sz.x) - 2);
  let j = clamp(i32(fl.y), 0, i32(sz.y) - 2);
  let k = clamp(i32(fl.z), 0, i32(sz.z) - 2);
  let f = clamp(g - vec3f(f32(i), f32(j), f32(k)), vec3f(0.0), vec3f(1.0));
  var st: Stencil;
  st.base = u32(i) + sz.x * (u32(j) + sz.y * u32(k));
  st.f = f;
  st.sx = sz.x;
  st.sxy = sz.x * sz.y;
  return st;
}

fn cornerIndex(st: Stencil, c: u32) -> u32 {
  return st.base + (c & 1u) + select(0u, st.sx, (c & 2u) != 0u) + select(0u, st.sxy, (c & 4u) != 0u);
}

fn cornerWeight(st: Stencil, c: u32) -> f32 {
  let wx = select(1.0 - st.f.x, st.f.x, (c & 1u) != 0u);
  let wy = select(1.0 - st.f.y, st.f.y, (c & 2u) != 0u);
  let wz = select(1.0 - st.f.z, st.f.z, (c & 4u) != 0u);
  return wx * wy * wz;
}

/** Trilinear sample of a face field component; with useValid only valid faces count. */
fn sampleComp(field: u32, comp: u32, p: vec3f, useValid: bool) -> f32 {
  let st = stencil(p, compOffset(comp), compSize(comp));
  let cb = compBase(comp);
  var acc = 0.0;
  var ws = 0.0;
  var all = 0.0;
  for (var c = 0u; c < 8u; c++) {
    let idx = cb + cornerIndex(st, c);
    let w = cornerWeight(st, c);
    let v = F[field + idx];
    all += w * v;
    if (!useValid || U[P.uValid + idx] != 0u) {
      acc += w * v;
      ws += w;
    }
  }
  if (!useValid) { return all; }
  return select(all, acc / ws, ws > 1e-9);
}

fn sampleVec(field: u32, p: vec3f, useValid: bool) -> vec3f {
  return vec3f(sampleComp(field, 0u, p, useValid), sampleComp(field, 1u, p, useValid), sampleComp(field, 2u, p, useValid));
}

/** Decode a flattened face index into (component, i, j, k, index within the component). */
struct Face { comp: u32, i: i32, j: i32, k: i32, local: u32, sz: vec3u };

fn decodeFace(fi: u32) -> Face {
  var f: Face;
  var r = fi;
  f.comp = 0u;
  if (r >= P.nu) { r -= P.nu; f.comp = 1u; if (r >= P.nv) { r -= P.nv; f.comp = 2u; } }
  f.sz = compSize(f.comp);
  f.local = r;
  f.i = i32(r % f.sz.x);
  f.j = i32((r / f.sz.x) % f.sz.y);
  f.k = i32(r / (f.sz.x * f.sz.y));
  return f;
}

/** Cells on the two sides of a face: (a below/left/behind, b at the face index). */
fn faceCells(f: Face) -> vec2u {
  var ia = f.i;
  var ja = f.j;
  var ka = f.k;
  if (f.comp == 0u) { ia -= 1; } else if (f.comp == 1u) { ja -= 1; } else { ka -= 1; }
  return vec2u(cellAt(ia, ja, ka), cellAt(f.i, f.j, f.k));
}

fn atomicMaxF(slot: u32, v: f32) {
  // Non-negative f32 bit patterns order like integers.
  atomicMax(&A[P.aStats + slot], bitcast<i32>(max(v, 0.0)));
}

// ---------------------------------------------------------------- kernels

@compute @workgroup_size(${WG})
fn markOccupied(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let p = gidx(g, nwg);
  if (p >= P.n || U[P.uStatus + p] != IN_POT) { return; }
  let x = POS[p].xyz;
  let i = i32(floor(x.x / P.h));
  let j = i32(floor(x.y / P.h));
  let k = i32(floor(x.z / P.h));
  if (i < 1 || j < 1 || k < 1 || i >= i32(P.nx) - 1 || j >= i32(P.ny) - 1 || k >= i32(P.nz) - 1) { return; }
  atomicStore(&A[P.aOccupied + u32(i) + P.nx * (u32(j) + P.ny * u32(k))], 1);
}

@compute @workgroup_size(${WG})
fn classify(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let c = gidx(g, nwg);
  if (c >= P.nc) { return; }
  let i = c % P.nx;
  let j = (c / P.nx) % P.ny;
  let k = c / (P.nx * P.ny);
  var t = AIR;
  if (i == 0u || j == 0u || k == 0u || i == P.nx - 1u || j == P.ny - 1u || k == P.nz - 1u) {
    t = SOLID;
  } else {
    let l = toLocal(P.c0, P.s0, (vec3f(f32(i), f32(j), f32(k)) + 0.5) * P.h);
    if (sdf(l) < 0.0) { t = SOLID; } else if (atomicLoad(&A[P.aOccupied + c]) != 0) { t = FLUID; }
  }
  U[P.uCell + c] = t;
  // Pressure, CG direction and Chebyshev direction must be zero outside the liquid.
  F[P.fQ + c] = 0.0;
  F[P.fS + c] = 0.0;
  F[P.fCd + c] = 0.0;
}

// ---------------------------------------------------------------- liquid-cell compaction
// Deterministic stream compaction in index order (count per block, scan the block counts, write),
// plus the matrix diagonal; built once per substep and shared by both pressure solves.

var<workgroup> blockScan: array<u32, ${BLOCK}>;

fn isFluid(c: u32) -> u32 {
  return select(0u, 1u, c < P.nc && U[P.uCell + c] == FLUID);
}

/** Inclusive scan of one flag per thread over the block (Hillis-Steele). */
fn scanBlock(li: u32, flag: u32) -> u32 {
  blockScan[li] = flag;
  workgroupBarrier();
  for (var o = 1u; o < ${BLOCK}u; o <<= 1u) {
    var v = 0u;
    if (li >= o) { v = blockScan[li - o]; }
    workgroupBarrier();
    blockScan[li] += v;
    workgroupBarrier();
  }
  return blockScan[li];
}

@compute @workgroup_size(${BLOCK})
fn compactCount(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = wid.x;
  let total = scanBlock(li, isFluid(b * ${BLOCK}u + li));
  if (li == ${BLOCK}u - 1u) { U[P.uBlock + b] = total; }
}

/** Exclusive scan of the block counts in one workgroup (chunked), total into uCount. */
@compute @workgroup_size(${BLOCK})
fn compactScan(@builtin(local_invocation_index) li: u32) {
  let chunk = (P.blocks + ${BLOCK}u - 1u) / ${BLOCK}u;
  let b0 = min(li * chunk, P.blocks);
  let b1 = min(b0 + chunk, P.blocks);
  var sum = 0u;
  for (var b = b0; b < b1; b++) { sum += U[P.uBlock + b]; }
  let incl = scanBlock(li, sum);
  var off = incl - sum;
  for (var b = b0; b < b1; b++) {
    let k = U[P.uBlock + b];
    U[P.uBlock + b] = off;
    off += k;
  }
  if (li == ${BLOCK}u - 1u) { U[P.uCount] = incl; }
}

@compute @workgroup_size(${BLOCK})
fn compactWrite(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let c = wid.x * ${BLOCK}u + li;
  let flag = isFluid(c);
  let incl = scanBlock(li, flag);
  if (flag == 0u) { return; }
  let t = U[P.uBlock + wid.x] + incl - 1u;
  U[P.uList + t] = c;
  let nxy = P.nx * P.ny;
  var d = 0.0;
  if (U[P.uCell + c - 1u] != SOLID) { d += 1.0; }
  if (U[P.uCell + c + 1u] != SOLID) { d += 1.0; }
  if (U[P.uCell + c - P.nx] != SOLID) { d += 1.0; }
  if (U[P.uCell + c + P.nx] != SOLID) { d += 1.0; }
  if (U[P.uCell + c - nxy] != SOLID) { d += 1.0; }
  if (U[P.uCell + c + nxy] != SOLID) { d += 1.0; }
  F[P.fDiag + t] = d;
}

@compute @workgroup_size(${WG})
fn particlesToGrid(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let p = gidx(g, nwg);
  if (p >= P.n || U[P.uStatus + p] != IN_POT) { return; }
  let x = POS[p].xyz;
  let v = VEL[p].xyz;
  for (var comp = 0u; comp < 3u; comp++) {
    let st = stencil(x, compOffset(comp), compSize(comp));
    let cb = compBase(comp);
    let vc = v[comp];
    for (var c = 0u; c < 8u; c++) {
      let idx = cb + cornerIndex(st, c);
      let w = cornerWeight(st, c);
      atomicAdd(&A[P.aSum + idx], i32(round(w * vc * SV)));
      atomicAdd(&A[P.aWeight + idx], i32(round(w * SW)));
    }
  }
}

/** Normalise the scatter, keep a copy for FLIP, add gravity, then impose moving-wall velocities. */
@compute @workgroup_size(${WG})
fn gridInit(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let fi = gidx(g, nwg);
  if (fi >= P.nu + P.nv + P.nw) { return; }
  let f = decodeFace(fi);
  let wsum = atomicLoad(&A[P.aWeight + fi]);
  var val = 0.0;
  if (f32(wsum) / SW > 1e-9) { val = (f32(atomicLoad(&A[P.aSum + fi])) / f32(wsum)) * (SW / SV); }
  F[P.fUp + fi] = val;
  let ab = faceCells(f);
  if (f.comp == 1u && f.j >= 1 && f.j < i32(P.ny) && (ab.x == FLUID || ab.y == FLUID)) {
    val -= P.gravity * P.dt;
  }
  if (ab.x == SOLID || ab.y == SOLID) {
    if (f.comp == 0u) { val = -P.omega * ((f32(f.j) + 0.5) * P.h - P.pwy); }
    else if (f.comp == 1u) { val = P.omega * ((f32(f.i) + 0.5) * P.h - P.pwx); }
    else { val = 0.0; }
  }
  F[P.fU + fi] = val;
}

fn divergenceAt(c: u32) -> f32 {
  let i = c % P.nx;
  let j = (c / P.nx) % P.ny;
  let k = c / (P.nx * P.ny);
  let iu = P.fU + i + (P.nx + 1u) * (j + P.ny * k);
  let iv = P.fV + i + P.nx * (j + (P.ny + 1u) * k);
  let iw = P.fW + c;
  return F[iu + 1u] - F[iu] + F[iv + P.nx] - F[iv] + F[iw + P.nx * P.ny] - F[iw];
}

@compute @workgroup_size(${WG})
fn divergenceRhs(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let c = gidx(g, nwg);
  if (c >= P.nc) { return; }
  var r = 0.0;
  if (U[P.uCell + c] == FLUID) { r = -divergenceAt(c); }
  F[P.fRhs + c] = r;
}

@compute @workgroup_size(${WG})
fn divergenceCheck(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let c = gidx(g, nwg);
  if (c >= P.nc || U[P.uCell + c] != FLUID) { return; }
  atomicMaxF(ST_MAXDIV, abs(divergenceAt(c)) / P.h);
}

fn gradientInto(fi: u32, dstField: u32) {
  if (fi >= P.nu + P.nv + P.nw) { return; }
  let f = decodeFace(fi);
  if (f.comp == 0u && (f.i < 1 || f.i >= i32(P.nx))) { return; }
  if (f.comp == 1u && (f.j < 1 || f.j >= i32(P.ny))) { return; }
  if (f.comp == 2u && (f.k < 1 || f.k >= i32(P.nz))) { return; }
  let ab = faceCells(f);
  if (ab.x == SOLID || ab.y == SOLID || (ab.x != FLUID && ab.y != FLUID)) { return; }
  let b = u32(f.i) + P.nx * (u32(f.j) + P.ny * u32(f.k));
  var a = b - 1u;
  if (f.comp == 1u) { a = b - P.nx; } else if (f.comp == 2u) { a = b - P.nx * P.ny; }
  F[dstField + fi] -= F[P.fQ + b] - F[P.fQ + a];
}

@compute @workgroup_size(${WG})
fn gradientVelocity(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  gradientInto(gidx(g, nwg), P.fU);
}

@compute @workgroup_size(${WG})
fn gradientCorrection(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  gradientInto(gidx(g, nwg), P.fUc);
}

@compute @workgroup_size(${WG})
fn markValid(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let fi = gidx(g, nwg);
  if (fi >= P.nu + P.nv + P.nw) { return; }
  let ab = faceCells(decodeFace(fi));
  let v = select(0u, 1u, ab.x == SOLID || ab.y == SOLID || ab.x == FLUID || ab.y == FLUID);
  U[P.uValid + fi] = v;
  U[P.uExtA + fi] = v;
}

/** One layer of averaging extrapolation into faces that are not yet valid (src mask -> dst mask). */
fn extrapolateLayer(fi: u32, src: u32, dst: u32) {
  if (fi >= P.nu + P.nv + P.nw) { return; }
  if (U[src + fi] != 0u) { U[dst + fi] = 1u; return; }
  let f = decodeFace(fi);
  let sx = f.sz.x;
  let sxy = f.sz.x * f.sz.y;
  var s = 0.0;
  var n = 0u;
  if (f.i > 0 && U[src + fi - 1u] != 0u) { s += F[P.fU + fi - 1u]; n++; }
  if (f.i < i32(f.sz.x) - 1 && U[src + fi + 1u] != 0u) { s += F[P.fU + fi + 1u]; n++; }
  if (f.j > 0 && U[src + fi - sx] != 0u) { s += F[P.fU + fi - sx]; n++; }
  if (f.j < i32(f.sz.y) - 1 && U[src + fi + sx] != 0u) { s += F[P.fU + fi + sx]; n++; }
  if (f.k > 0 && U[src + fi - sxy] != 0u) { s += F[P.fU + fi - sxy]; n++; }
  if (f.k < i32(f.sz.z) - 1 && U[src + fi + sxy] != 0u) { s += F[P.fU + fi + sxy]; n++; }
  if (n > 0u) {
    F[P.fU + fi] = s / f32(n);
    U[dst + fi] = 1u;
  } else {
    U[dst + fi] = 0u;
  }
}

@compute @workgroup_size(${WG})
fn extrapolate1(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  extrapolateLayer(gidx(g, nwg), P.uExtA, P.uExtB);
}

@compute @workgroup_size(${WG})
fn extrapolate2(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  extrapolateLayer(gidx(g, nwg), P.uExtB, P.uExtA);
}

@compute @workgroup_size(${WG})
fn gridToParticles(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let p = gidx(g, nwg);
  if (p >= P.n || U[P.uStatus + p] != IN_POT) { return; }
  let x = POS[p].xyz;
  let vn = sampleVec(P.fU, x, true);
  let vo = sampleVec(P.fUp, x, true);
  let a = P.flip;
  VEL[p] = vec4f((1.0 - a) * vn + a * (VEL[p].xyz + vn - vo), 0.0);
}

@compute @workgroup_size(${WG})
fn densityScatter(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let p = gidx(g, nwg);
  if (p >= P.n || U[P.uStatus + p] != IN_POT) { return; }
  let st = stencil(POS[p].xyz, vec3f(0.5), vec3u(P.nx, P.ny, P.nz));
  for (var c = 0u; c < 8u; c++) {
    atomicAdd(&A[P.aDensity + cornerIndex(st, c)], i32(round(cornerWeight(st, c) * SW)));
  }
}

@compute @workgroup_size(${WG})
fn densityRhs(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let c = gidx(g, nwg);
  if (c >= P.nc) { return; }
  var r = 0.0;
  if (U[P.uCell + c] == FLUID) {
    let ratio = f32(atomicLoad(&A[P.aDensity + c])) / SW / 8.0;
    let nxy = P.nx * P.ny;
    let interior = U[P.uCell + c - 1u] != AIR && U[P.uCell + c + 1u] != AIR && U[P.uCell + c - P.nx] != AIR &&
      U[P.uCell + c + P.nx] != AIR && U[P.uCell + c - nxy] != AIR && U[P.uCell + c + nxy] != AIR;
    if (interior) {
      atomicAdd(&A[P.aStats + ST_INTCOUNT], 1);
      atomicAdd(&A[P.aStats + ST_INTSUM], i32(round(ratio * SR)));
    }
    if (P.kappa > 0.0 && (ratio > 1.0 || interior)) { r = P.kappa * (ratio - 1.0) * P.h / P.dt; }
  }
  F[P.fRhs + c] = r;
}

fn setStatus(p: u32, s: u32) {
  atomicAdd(&A[P.aStats + U[P.uStatus + p]], -1);
  atomicAdd(&A[P.aStats + s], 1);
  U[P.uStatus + p] = s;
}

@compute @workgroup_size(${WG})
fn advect(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let p = gidx(g, nwg);
  if (p >= P.n) { return; }
  let st = U[P.uStatus + p];
  let dt = P.dt;
  if (st == DISCHARGED || st == SPILLED) {
    // Visual-only ballistic continuation of removed parcels (not part of the liquid solve).
    var x = POS[p];
    var v = VEL[p];
    if (x.y > -1.0) {
      v.y -= P.gravity * dt;
      x = vec4f(x.xyz + v.xyz * dt, 0.0);
      POS[p] = x;
      VEL[p] = v;
    }
    return;
  }
  if (st != IN_POT) { return; }
  let x0 = POS[p].xyz;
  var vel = VEL[p].xyz;
  let loc0 = toLocal(P.c0, P.s0, x0);
  let v1 = sampleVec(P.fU, x0, false);
  let xm = x0 + 0.5 * dt * v1;
  var x1 = x0 + dt * sampleVec(P.fU, xm, false);
  if (P.kappa > 0.0) { x1 += dt * sampleVec(P.fUc, x0, false); }
  // Collision with the pot at its new pose (numerical SDF gradient).
  let eps = 1e-4;
  let margin = 0.1 * P.h;
  var loc1 = toLocal(P.c1, P.s1, x1);
  let d = sdf(loc1);
  if (d < margin) {
    let gx = sdf(loc1 + vec3f(eps, 0.0, 0.0)) - sdf(loc1 - vec3f(eps, 0.0, 0.0));
    let gy = sdf(loc1 + vec3f(0.0, eps, 0.0)) - sdf(loc1 - vec3f(0.0, eps, 0.0));
    let gz = sdf(loc1 + vec3f(0.0, 0.0, eps)) - sdf(loc1 - vec3f(0.0, 0.0, eps));
    var gl = length(vec3f(gx, gy, gz));
    if (gl == 0.0) { gl = 1.0; }
    let push = margin - d;
    loc1 += vec3f(gx, gy, gz) / gl * push;
    x1 = toWorld(P.c1, P.s1, loc1);
    // Remove the inward normal velocity relative to the moving wall.
    let nw = vec3f((P.c1 * gx - P.s1 * gy) / gl, (P.s1 * gx + P.c1 * gy) / gl, gz / gl);
    let wv = vec3f(-P.omega * (x1.y - P.pwy), P.omega * (x1.x - P.pwx), 0.0);
    let rn = dot(vel - wv, nw);
    if (rn < 0.0) { vel -= rn * nw; }
  }
  // Symmetry plane z = h (local z = 0): reflect.
  if (x1.z < P.h) {
    x1.z = 2.0 * P.h - x1.z;
    vel.z = abs(vel.z);
  }
  // WGSL may assume finite floats, so test the exponent bits instead of x != x.
  let bits = bitcast<vec3u>(x1) & vec3u(0x7f800000u);
  if (any(bits == vec3u(0x7f800000u))) {
    VEL[p] = vec4f(vel, 0.0);
    setStatus(p, LOST);
    return;
  }
  POS[p] = vec4f(x1, 0.0);
  VEL[p] = vec4f(vel, 0.0);
  loc1 = toLocal(P.c1, P.s1, x1);
  // Discharge: crossing the plane through the spout mouth, perpendicular to the spout axis.
  let s0 = (loc0.x - P.tipX) * P.dx + (loc0.y - P.tipY) * P.dy;
  let s1 = (loc1.x - P.tipX) * P.dx + (loc1.y - P.tipY) * P.dy;
  if (s0 < 0.0 && s1 >= 0.0) {
    let rx = loc1.x - P.tipX - s1 * P.dx;
    let ry = loc1.y - P.tipY - s1 * P.dy;
    if (length(vec3f(rx, ry, loc1.z)) < P.bore + 3.0 * P.wall) {
      setStatus(p, DISCHARGED);
      atomicAdd(&A[P.aStats + ST_ORIGIN + U[P.uOrigin + p]], 1);
      return;
    }
  }
  let r = sqrt(loc1.x * loc1.x + loc1.z * loc1.z);
  let insideBody = r < P.radius + 2.0 * P.wall && loc1.y > -2.0 * P.wall;
  let nearSpout = loc1.x > 0.0 && loc1.x < P.tipX + 0.03;
  let lo = P.h * 1.01;
  let atEdge = x1.x <= lo || x1.y <= lo || x1.x >= f32(P.nx - 1u) * P.h || x1.y >= f32(P.ny - 1u) * P.h ||
    x1.z >= f32(P.nz - 1u) * P.h;
  if ((!insideBody && !nearSpout) || atEdge) {
    setStatus(p, SPILLED);
    return;
  }
  atomicMaxF(ST_MAXSPEED, dot(vel, vel));
}
`;
}

/**
 * A loop over this thread's liquid cells (t = li, li + T, ...). The first K cells keep their grid
 * index c and diagonal dg in registers (fully unrolled constant loop, so the loads of several
 * cells overlap); any further cells read them from memory.
 */
function cells(body: string): string {
  return `
    for (var k = 0u; k < K; k++) {
      let t = li + k * T;
      if (t < m) { let c = cs[k]; let dg = ds[k]; ${body} }
    }
    for (var t = li + K * T; t < m; t += T) { let c = U[P.uList + t]; let dg = F[P.fDiag + t]; ${body} }`;
}

/**
 * z = p(D^-1 A) D^-1 r: DEGREE Chebyshev steps for D^-1 A on [lower, upper] from z = 0. Only
 * matrix-vector products (one barrier pair each), no reductions; the polynomial is positive on the
 * whole spectrum (0, 2], so M^-1 stays symmetric positive definite and CG remains valid.
 */
const PRECONDITION = `
  {
    let sigma1 = THETA / DELTA;
    var rho = 1.0 / sigma1;
    storageBarrier();
    workgroupBarrier();
    ${cells(`
      let d = F[P.fR + t] / (dg * THETA);
      F[P.fCd + c] = d;
      F[P.fZ + t] = d;
      F[P.fAs + t] = F[P.fR + t];`)}
    for (var deg = 1u; deg < DEGREE; deg++) {
      storageBarrier();
      workgroupBarrier();
      ${cells(`
        let ad = dg * F[P.fCd + c] - F[P.fCd + c - 1u] - F[P.fCd + c + 1u] - F[P.fCd + c - nx] -
          F[P.fCd + c + nx] - F[P.fCd + c - nxy] - F[P.fCd + c + nxy];
        F[P.fAs + t] -= ad;`)}
      storageBarrier();
      workgroupBarrier();
      let rhoN = 1.0 / (2.0 * sigma1 - rho);
      ${cells(`
        let d = rhoN * rho * F[P.fCd + c] + (2.0 * rhoN / DELTA) * F[P.fAs + t] / dg;
        F[P.fCd + c] = d;
        F[P.fZ + t] += d;`)}
      rho = rhoN;
    }
    storageBarrier();
    workgroupBarrier();
  }`;

/**
 * Pressure solve in a single workgroup: Chebyshev-polynomial-preconditioned CG over the liquid
 * cells listed by the compaction kernels, with fixed-order reductions. The liquid region is a few
 * thousand cells, so one workgroup keeps the whole solve in one dispatch with no CPU round trips.
 * Same stopping rule as the CPU MIC(0)-PCG: max |residual| <= tol * max |b|.
 */
export function pcgWgsl(
  threads: number,
  degree = CHEB_DEGREE,
  lower = CHEB_LOWER,
  cached = PCG_CACHED,
): string {
  const theta = (CHEB_UPPER + lower) / 2;
  const delta = (CHEB_UPPER - lower) / 2;
  const groups = 2 ** Math.floor(Math.log2(threads) / 2);
  return /* wgsl */ `
${paramsStruct()}

struct Solve { tol: f32, maxIter: u32, statSlot: u32, countFailure: u32 };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> F: array<f32>;
@group(0) @binding(2) var<storage, read_write> A: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> U: array<u32>;
@group(1) @binding(0) var<uniform> S: Solve;

const T: u32 = ${threads}u;
const K: u32 = ${cached}u;
const FAIL_SLOT: u32 = ${STAT.pressureFailures}u;
const DEGREE: u32 = ${degree}u;
const G: u32 = ${groups}u;
const RUN: u32 = ${threads / groups}u;
const THETA: f32 = ${theta};
const DELTA: f32 = ${delta};

var<workgroup> redA: array<f32, T>;
var<workgroup> redB: array<f32, T>;
var<workgroup> bcastU: u32;
var<workgroup> bcast2: vec2f;

/**
 * Two-level fixed-order reduction (3 barriers instead of log2(T)): G threads each combine a run of
 * T / G partials, then thread 0 combines the G results. Returns (max or sum of a, sum of b).
 */
fn reduce2(li: u32, a: f32, b: f32, maxA: bool) -> vec2f {
  redA[li] = a;
  redB[li] = b;
  workgroupBarrier();
  if (li < G) {
    var x = redA[li * RUN];
    var y = redB[li * RUN];
    for (var k = 1u; k < RUN; k++) {
      let v = redA[li * RUN + k];
      x = select(x + v, max(x, v), maxA);
      y += redB[li * RUN + k];
    }
    redA[li * RUN] = x;
    redB[li * RUN] = y;
  }
  workgroupBarrier();
  if (li == 0u) {
    var x = redA[0];
    var y = redB[0];
    for (var k = 1u; k < G; k++) {
      let v = redA[k * RUN];
      x = select(x + v, max(x, v), maxA);
      y += redB[k * RUN];
    }
    bcast2 = vec2f(x, y);
  }
  return workgroupUniformLoad(&bcast2);
}

@compute @workgroup_size(T)
fn pcg(@builtin(local_invocation_index) li: u32) {
  let nx = P.nx;
  let nxy = P.nx * P.ny;
  if (li == 0u) { bcastU = U[P.uCount]; }
  let m = workgroupUniformLoad(&bcastU);
  var cs: array<u32, K>;
  var ds: array<f32, K>;
  for (var k = 0u; k < K; k++) {
    let t = li + k * T;
    if (t < m) {
      cs[k] = U[P.uList + t];
      ds[k] = F[P.fDiag + t];
    }
  }
  // r = b, q = 0, max |b|.
  var bmax = 0.0;
  ${cells(`
    let b = F[P.fRhs + c];
    F[P.fR + t] = b;
    F[P.fQ + c] = 0.0;
    bmax = max(bmax, abs(b));`)}
  let bnorm = reduce2(li, bmax, 0.0, true).x;
  if (m == 0u || bnorm < 1e-14) {
    if (li == 0u) { atomicStore(&A[P.aStats + S.statSlot], 0); }
    return;
  }
  // z = M^-1 r, s = z, sigma = z . r
  ${PRECONDITION}
  var part = 0.0;
  ${cells(`
    let z = F[P.fZ + t];
    F[P.fS + c] = z;
    part += z * F[P.fR + t];`)}
  var sigma = reduce2(li, part, 0.0, false).x;
  let goal = max(S.tol * bnorm, 1e-14);
  var it = 0u;
  var converged = false;
  loop {
    if (it >= S.maxIter) { break; }
    it++;
    storageBarrier();
    workgroupBarrier();
    // as = A s
    var sas = 0.0;
    ${cells(`
      let s = F[P.fS + c];
      let ap = dg * s - F[P.fS + c - 1u] - F[P.fS + c + 1u] - F[P.fS + c - nx] - F[P.fS + c + nx] -
        F[P.fS + c - nxy] - F[P.fS + c + nxy];
      F[P.fAs + t] = ap;
      sas += s * ap;`)}
    let sasU = reduce2(li, sas, 0.0, false).x;
    if (!(sasU > 0.0)) { break; }
    let alpha = sigma / sasU;
    var rmax = 0.0;
    ${cells(`
      F[P.fQ + c] += alpha * F[P.fS + c];
      let r = F[P.fR + t] - alpha * F[P.fAs + t];
      F[P.fR + t] = r;
      rmax = max(rmax, abs(r));`)}
    // The preconditioner runs before the convergence test so both reductions share one pass.
    ${PRECONDITION}
    var zr = 0.0;
    ${cells(`zr += F[P.fZ + t] * F[P.fR + t];`)}
    let red = reduce2(li, rmax, zr, true);
    if (red.x <= goal) { converged = true; break; }
    let beta = red.y / sigma;
    sigma = red.y;
    ${cells(`F[P.fS + c] = F[P.fZ + t] + beta * F[P.fS + c];`)}
  }
  if (li == 0u) {
    atomicStore(&A[P.aStats + S.statSlot], i32(it));
    if (!converged && S.countFailure != 0u) { atomicAdd(&A[P.aStats + FAIL_SLOT], 1); }
  }
}
`;
}

/** Writes world positions (half pot plus mirror image) for rendering, straight on the GPU. */
export function renderWgsl(): string {
  return /* wgsl */ `
${paramsStruct()}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> POS: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> OUT: array<f32>;

@compute @workgroup_size(${WG})
fn writePositions(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let p = g.x + g.y * nwg.x * ${WG}u;
  if (p >= P.n) { return; }
  var x = POS[p].xyz;
  if (x.y < 0.0005) { x.y = -100.0; }
  let m = p + P.n;
  OUT[3u * p] = x.x;
  OUT[3u * p + 1u] = x.y;
  OUT[3u * p + 2u] = x.z;
  OUT[3u * m] = x.x;
  OUT[3u * m + 1u] = x.y;
  OUT[3u * m + 2u] = 2.0 * P.h - x.z;
}
`;
}
