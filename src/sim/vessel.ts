// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Vessel geometry in pot-local coordinates. Walls are unions of capsules
// (thick polyline segments), giving an analytic signed distance function:
// negative inside the solid wall, positive in liquid/air. The local frame has
// x = 0 at the inner face of the left wall, y = 0 at the inner floor.

import type { VesselConfig } from './types';

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface OutflowSection {
  /** Segment endpoints in local coordinates. Crossing from the inner side counts as discharge. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Unit normal pointing out of the vessel (downstream). */
  nx: number;
  ny: number;
}

export interface Vessel {
  config: VesselConfig;
  segments: Segment[];
  /** Polylines for rendering (local). */
  polylines: [number, number][][];
  halfWall: number;
  outflow: OutflowSection | null;
  /** Local-space spout channel polygon (teapot) used for region classification. */
  spoutPolygon: [number, number][] | null;
  /** Custom only: closed wall-centreline polygon; liquid is seeded inside it. */
  cavity: [number, number][] | null;
  /** Bounding envelope in local coordinates; a parcel outside it that was not discharged is a spill. */
  envelope: { x0: number; x1: number; y0: number; y1: number };
  /** Precomputed far-field distance table (local frame, static because the vessel is rigid). */
  cache: SdfCache | null;
}

/**
 * Tabulated SDF used only as a fast exit far from the walls: where the tabulated value exceeds
 * `exact` the true distance is certainly positive and larger than any collision margin, so the
 * table value is returned; closer to the walls the exact distance is always computed.
 */
export interface SdfCache {
  x0: number;
  y0: number;
  step: number;
  nx: number;
  ny: number;
  exact: number;
  /** Lower bound of the distance for any point outside the table (walls are >= pad inside it). */
  outside: number;
  values: Float32Array;
}

function buildCache(v: Vessel, step: number): SdfCache {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pl of v.polylines)
    for (const [x, y] of pl) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  const pad = 0.03;
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  const nx = Math.ceil((x1 - x0) / step) + 1;
  const ny = Math.ceil((y1 - y0) / step) + 1;
  const values = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) values[i + j * nx] = exactSdf(v, x0 + i * step, y0 + j * step);
  // Bilinear interpolation of a 1-Lipschitz function errs by at most ~step; 3 steps is safe.
  return { x0, y0, step, nx, ny, exact: 3 * step, outside: pad - v.halfWall, values };
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Body outline centreline from the left rim, down and around the bottom, to the right wall at height yEnd. */
function bodyPath(c: VesselConfig, yRightEnd: number): [number, number][] {
  const hw = c.wall / 2;
  const xl = -hw;
  const xr = c.innerWidth + hw;
  const yb = -hw;
  const r = Math.max(c.cornerRadius, 0) + hw;
  const pts: [number, number][] = [[xl, c.innerHeight]];
  if (r > hw + 1e-9) {
    pts.push(...arc(xl + r, yb + r, r, Math.PI, 1.5 * Math.PI, 8));
    pts.push(...arc(xr - r, yb + r, r, 1.5 * Math.PI, 2 * Math.PI, 8));
  } else {
    pts.push([xl, yb], [xr, yb]);
  }
  pts.push([xr, yRightEnd]);
  return pts;
}

function toSegments(polylines: [number, number][][]): Segment[] {
  const segs: Segment[] = [];
  for (const pl of polylines) {
    for (let k = 0; k + 1 < pl.length; k++) {
      const [ax, ay] = pl[k];
      const [bx, by] = pl[k + 1];
      if (Math.hypot(bx - ax, by - ay) > 1e-12) segs.push({ ax, ay, bx, by });
    }
  }
  return segs;
}

export function buildVessel(c: VesselConfig): Vessel {
  const hw = c.wall / 2;
  const xr = c.innerWidth + hw;
  let polylines: [number, number][][];
  let outflow: OutflowSection | null = null;
  let spoutPolygon: [number, number][] | null = null;
  const envelope = {
    x0: -c.wall * 2,
    x1: c.innerWidth + c.wall * 2,
    y0: -c.wall * 2,
    y1: c.innerHeight + 1.0,
  };

  let cavity: [number, number][] | null = null;
  if (c.kind === 'custom') {
    const pts = c.profile ?? [];
    if (pts.length < 3) throw new Error('A drawn pot needs at least three wall points.');
    polylines = [pts.map((p) => [p[0], p[1]] as [number, number])];
    cavity = polylines[0];
    const [ax, ay] = pts[pts.length - 2];
    const [tx, ty] = pts[pts.length - 1];
    const len = Math.hypot(tx - ax, ty - ay) || 1;
    const ux = (tx - ax) / len;
    const uy = (ty - ay) / len;
    // Section through the lip tip, perpendicular to the last wall segment (like the pitcher lip).
    const nx = -uy;
    const ny = ux;
    outflow = {
      ax: tx - nx * 0.02,
      ay: ty - ny * 0.02,
      bx: tx + nx * 0.06,
      by: ty + ny * 0.06,
      nx: ux,
      ny: uy,
    };
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    envelope.x0 = x0 - c.wall * 2;
    envelope.x1 = x1 + c.wall * 2;
    envelope.y0 = y0 - c.wall * 2;
    envelope.y1 = y1 + 1.0;
  } else if (c.kind === 'cavity') {
    // Closed square box (verification): walls all round, including a lid; no free surface.
    const xl = -hw;
    const xr2 = c.innerWidth + hw;
    const yb = -hw;
    const yt = c.innerHeight + hw;
    polylines = [
      [
        [xl, yt],
        [xl, yb],
        [xr2, yb],
        [xr2, yt],
        [xl, yt],
      ],
    ];
    envelope.y1 = c.innerHeight + c.wall * 2;
  } else if (c.kind === 'tank') {
    polylines = [bodyPath(c, c.innerHeight)];
  } else if (c.kind === 'pitcher' || c.kind === 'glass') {
    // Rim lip: the right wall continues past the rim into a short lip ("Ausgiesser").
    const lipRise = c.lipLength * c.lipRise;
    const tipX = xr + c.lipLength;
    const tipY = c.innerHeight + lipRise;
    polylines = [[...bodyPath(c, c.innerHeight), [tipX, tipY]]];
    // Section a short distance beyond the lip tip, perpendicular to the lip direction.
    const dx = tipX - xr;
    const dy = tipY - c.innerHeight;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const off = 0;
    const px = tipX + ux * off;
    const py = tipY + uy * off;
    // Normal to the lip pointing "up" (into the liquid side over the lip).
    const nx = -uy;
    const ny = ux;
    const above = 0.06;
    const below = 0.02;
    outflow = {
      ax: px - nx * below,
      ay: py - ny * below,
      bx: px + nx * above,
      by: py + ny * above,
      nx: ux,
      ny: uy,
    };
    envelope.x1 = tipX + c.wall * 2;
  } else {
    // Teapot: right wall has an inlet opening at inletHeight that connects to an inclined spout channel.
    const a = (c.spoutAngleDeg * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const gap = (c.channelWidth + c.wall) / Math.cos(a);
    const yLo = c.inletHeight - gap / 2;
    const yHi = c.inletHeight + gap / 2;
    const L = c.spoutLength;
    const lowTip: [number, number] = [xr + dx * L, yLo + dy * L];
    const upLen = Math.max(L - gap * Math.sin(a) * 0.5, L * 0.5);
    const upTip: [number, number] = [xr + dx * upLen, yHi + dy * upLen];
    polylines = [
      [...bodyPath(c, yLo), lowTip],
      [upTip, [xr, yHi], [xr, c.innerHeight]],
    ];
    // Discharge section across the spout mouth, slightly downstream of the lower tip, perpendicular to the axis.
    // The plane passes through the end of the lower lip: parcels that pass the tip (including
    // those wrapping around the lip edge) have left through the spout.
    const off = 0;
    const mx = lowTip[0] + dx * off;
    const my = lowTip[1] + dy * off;
    const nx = -dy;
    const ny = dx;
    const span = c.channelWidth + c.wall * 3;
    outflow = {
      ax: mx - nx * c.wall * 1.5,
      ay: my - ny * c.wall * 1.5,
      bx: mx + nx * span,
      by: my + ny * span,
      nx: dx,
      ny: dy,
    };
    // Channel polygon (inner side of the walls) for region bookkeeping.
    const pn = c.wall / 2;
    spoutPolygon = [
      [xr + nx * pn, yLo + ny * pn],
      [lowTip[0] + nx * pn, lowTip[1] + ny * pn],
      [upTip[0] - nx * pn, upTip[1] - ny * pn],
      [xr - nx * pn, yHi - ny * pn],
    ];
    envelope.x1 = Math.max(lowTip[0], upTip[0]) + c.wall * 2;
    envelope.y1 = Math.max(envelope.y1, upTip[1] + 1.0);
  }
  const vessel: Vessel = {
    config: c,
    segments: toSegments(polylines),
    polylines,
    halfWall: hw,
    outflow,
    spoutPolygon,
    cavity,
    envelope,
    cache: null,
  };
  vessel.cache = buildCache(vessel, 0.002);
  return vessel;
}

/** Signed distance (local coordinates) to the vessel wall surface. Negative inside solid. */
export function vesselSdf(v: Vessel, x: number, y: number): number {
  const c = v.cache;
  if (c) {
    const gx = (x - c.x0) / c.step;
    const gy = (y - c.y0) / c.step;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    if (i >= 0 && j >= 0 && i < c.nx - 1 && j < c.ny - 1) {
      const fx = gx - i;
      const fy = gy - j;
      const k = i + j * c.nx;
      const val =
        (1 - fx) * (1 - fy) * c.values[k] +
        fx * (1 - fy) * c.values[k + 1] +
        (1 - fx) * fy * c.values[k + c.nx] +
        fx * fy * c.values[k + c.nx + 1];
      if (val > c.exact) return val;
    } else if (c.outside > c.exact) {
      // Outside the table every wall is at least `pad` away: a cheap, valid lower bound that is
      // far above every threshold the solver compares against.
      return c.outside;
    }
  }
  return exactSdf(v, x, y);
}

/** Exact signed distance (no table). */
export function exactSdf(v: Vessel, x: number, y: number): number {
  let best = Infinity;
  const segs = v.segments;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const wx = x - s.ax;
    const wy = y - s.ay;
    let t = (wx * ex + wy * ey) / (ex * ex + ey * ey);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * ex;
    const dy = wy - t * ey;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best) - v.halfWall;
}

/** SDF plus outward unit gradient (pointing away from the solid). */
export function vesselSdfGrad(v: Vessel, x: number, y: number, out: Float64Array): number {
  let best = Infinity;
  let gx = 0;
  let gy = 1;
  const segs = v.segments;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const wx = x - s.ax;
    const wy = y - s.ay;
    let t = (wx * ex + wy * ey) / (ex * ex + ey * ey);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * ex;
    const dy = wy - t * ey;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      gx = dx;
      gy = dy;
    }
  }
  const d = Math.sqrt(best);
  if (d > 1e-12) {
    out[0] = gx / d;
    out[1] = gy / d;
  } else {
    out[0] = 0;
    out[1] = 1;
  }
  return d - v.halfWall;
}

/** Point-in-polygon (even-odd). */
export function pointInPolygon(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the motion from (x0,y0) to (x1,y1) crosses the section from its upstream side. */
export function crossesSection(s: OutflowSection, x0: number, y0: number, x1: number, y1: number): boolean {
  const d0 = (x0 - s.ax) * s.nx + (y0 - s.ay) * s.ny;
  const d1 = (x1 - s.ax) * s.nx + (y1 - s.ay) * s.ny;
  if (!(d0 < 0 && d1 >= 0)) return false;
  // Intersection parameter along the motion, then position along the section segment.
  const t = d0 / (d0 - d1);
  const ix = x0 + (x1 - x0) * t;
  const iy = y0 + (y1 - y0) * t;
  const ex = s.bx - s.ax;
  const ey = s.by - s.ay;
  const u = ((ix - s.ax) * ex + (iy - s.ay) * ey) / (ex * ex + ey * ey);
  return u >= 0 && u <= 1;
}

/** Rigid pose of the vessel: world = pivotWorld + R(phi) (local - pivotLocal). */
export interface Pose {
  phi: number;
  omega: number;
  cos: number;
  sin: number;
  plx: number;
  ply: number;
  pwx: number;
  pwy: number;
}

export function makePose(
  phi: number,
  omega: number,
  pivotLocal: [number, number],
  pivotWorld: [number, number],
): Pose {
  return {
    phi,
    omega,
    cos: Math.cos(phi),
    sin: Math.sin(phi),
    plx: pivotLocal[0],
    ply: pivotLocal[1],
    pwx: pivotWorld[0],
    pwy: pivotWorld[1],
  };
}

export function worldToLocal(p: Pose, x: number, y: number, out: Float64Array): void {
  const rx = x - p.pwx;
  const ry = y - p.pwy;
  out[0] = p.cos * rx + p.sin * ry + p.plx;
  out[1] = -p.sin * rx + p.cos * ry + p.ply;
}

export function localToWorld(p: Pose, x: number, y: number, out: Float64Array): void {
  const rx = x - p.plx;
  const ry = y - p.ply;
  out[0] = p.cos * rx - p.sin * ry + p.pwx;
  out[1] = p.sin * rx + p.cos * ry + p.pwy;
}
