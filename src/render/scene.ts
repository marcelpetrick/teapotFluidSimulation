// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Canvas 2D rendering. Colours come only from immutable origin IDs (the renderer never
// changes labels or metrics). Drawing uses a minimal context interface so it can be tested.

import { drawDenseOrigins } from './dense';
import { makePose, localToWorld } from '../sim/vessel';
import { STATUS_DISCHARGED, STATUS_IN_POT, type RenderSnapshot } from '../sim/types';
import type { StaticInfo } from '../worker/host';

export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'fill'
  | 'fillRect'
  | 'rect'
  | 'strokeRect'
  | 'arc'
  | 'fillText'
  | 'setLineDash'
  | 'clearRect'
  | 'closePath'
> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

export interface Theme {
  surface: string;
  ink: string;
  muted: string;
  wall: string;
  grid: string;
  origins: string[];
  dim: string;
  arrow: string;
  /** Cyber skin: draw liquid additively so dense regions glow. */
  glow?: boolean;
}

export type ColourMode = 'origin' | 'poured-map' | 'speed' | 'temperature';

export interface SceneOptions {
  mode: ColourMode;
  /** Origin to emphasise in 'origin' mode; -1 shows all origins in colour. */
  highlight?: number;
  pathlines: boolean;
  arrows: boolean;
  markers: boolean;
}

export interface Viewport {
  scale: number;
  ox: number;
  oy: number;
  width: number;
  height: number;
}

/** Fit the world domain into width x height pixels (y up in world, down on screen). */
export function fitViewport(
  domainW: number,
  domainH: number,
  width: number,
  height: number,
  pad = 8,
): Viewport {
  const scale = Math.min((width - 2 * pad) / domainW, (height - 2 * pad) / domainH);
  const ox = (width - domainW * scale) / 2;
  const oy = height - (height - domainH * scale) / 2;
  return { scale, ox, oy, width, height };
}

export function toScreen(v: Viewport, x: number, y: number): [number, number] {
  return [v.ox + x * v.scale, v.oy - y * v.scale];
}

/** Sequential single-hue ramp (light -> dark) for magnitude modes. */
export function rampColour(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  const l = 88 - 58 * c;
  return `hsl(205 70% ${l.toFixed(0)}%)`;
}

/** Diverging ramp for temperature: cool blue - neutral grey - warm red. */
export function temperatureColour(t: number): string {
  const c = Math.max(-1, Math.min(1, t));
  if (Math.abs(c) < 0.05) return 'hsl(0 0% 60%)';
  const hue = c < 0 ? 215 : 10;
  const sat = 15 + 60 * Math.abs(c);
  return `hsl(${hue} ${sat.toFixed(0)}% ${(58 - 12 * Math.abs(c)).toFixed(0)}%)`;
}

function drawMarker(ctx: Ctx2D, k: number, x: number, y: number, r: number): void {
  ctx.beginPath();
  if (k === 0) ctx.arc(x, y, r, 0, Math.PI * 2);
  else if (k === 1) {
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.lineTo(x - r, y + r);
    ctx.closePath();
  } else {
    ctx.moveTo(x, y - r * 1.2);
    ctx.lineTo(x + r * 1.1, y + r * 0.8);
    ctx.lineTo(x - r * 1.1, y + r * 0.8);
    ctx.closePath();
  }
  ctx.fill();
}

export function drawVessel(ctx: Ctx2D, v: Viewport, info: StaticInfo, angleDeg: number, theme: Theme): void {
  const pose = makePose((-angleDeg * Math.PI) / 180, 0, info.config.pivotLocal, info.config.pivotWorld);
  const w = new Float64Array(2);
  ctx.save();
  ctx.strokeStyle = theme.wall;
  ctx.lineWidth = Math.max(1, 2 * info.halfWall * v.scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.55;
  for (const pl of info.polylines) {
    ctx.beginPath();
    pl.forEach(([lx, ly], i) => {
      localToWorld(pose, lx, ly, w);
      const [sx, sy] = toScreen(v, w[0], w[1]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    // Outline the actual wall thickness like cut glass; keep its physical centreline unchanged.
    const wallWidth = ctx.lineWidth;
    ctx.strokeStyle = theme.surface;
    ctx.lineWidth = Math.max(1, wallWidth - 3);
    ctx.stroke();
    ctx.lineWidth = wallWidth;
    ctx.strokeStyle = theme.wall;
  }
  ctx.globalAlpha = 1;
  if (info.outflow) {
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.muted;
    ctx.beginPath();
    localToWorld(pose, info.outflow.ax, info.outflow.ay, w);
    let [sx, sy] = toScreen(v, w[0], w[1]);
    ctx.moveTo(sx, sy);
    localToWorld(pose, info.outflow.bx, info.outflow.by, w);
    [sx, sy] = toScreen(v, w[0], w[1]);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

export function drawParcels(
  ctx: Ctx2D,
  v: Viewport,
  info: StaticInfo,
  snap: RenderSnapshot,
  opts: SceneOptions,
  theme: Theme,
  tempRange: [number, number],
): void {
  if (drawDenseOrigins(ctx, v, info, snap, opts, theme)) return;
  const r = Math.max(1.2, info.h * v.scale * (opts.markers ? 0.42 : 0.3));
  const pos = snap.positions;
  const maxY = info.config.domainHeight;
  const colourOf = (p: number, st: number, k: number): string => {
    switch (opts.mode) {
      case 'speed':
        return rampColour(snap.speed[p] / 0.6);
      case 'temperature': {
        const T = snap.temperature ? snap.temperature[p] : tempRange[0];
        const mid = 0.5 * (tempRange[0] + tempRange[1]);
        const half = Math.max(0.5, 0.5 * (tempRange[1] - tempRange[0]));
        return temperatureColour((T - mid) / half);
      }
      case 'poured-map':
        return st === STATUS_DISCHARGED ? theme.origins[k % theme.origins.length] : theme.dim;
      default:
        return opts.highlight !== undefined && opts.highlight >= 0 && opts.highlight !== k
          ? theme.dim
          : theme.origins[k % theme.origins.length];
    }
  };
  // Cyber skin: a faint additive halo first (glow), then the parcels in their true colours on
  // top, so colours always match the legend (plain additive blending would saturate them).
  for (const halo of theme.glow ? [true, false] : [false]) {
    ctx.save();
    if (halo) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.14;
    }
    const rr = halo ? r * 2.6 : r;
    let lastColour = '';
    // Only opaque rectangles may share a path: overlapping translucent parcels and additive
    // halos must keep their individual compositing. Consecutive colours preserve painter order.
    const batch =
      !halo &&
      !opts.markers &&
      opts.mode === 'origin' &&
      [...theme.origins, theme.dim].every((c) => /^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(c));
    if (batch) ctx.beginPath();
    for (let p = 0; p < snap.count; p++) {
      const st = snap.status[p];
      const y = pos[2 * p + 1];
      if (st !== STATUS_IN_POT && st !== STATUS_DISCHARGED) continue;
      if (y < -0.05 || y > maxY * 1.2) continue;
      const k = info.origin[p];
      const colour = colourOf(p, st, k);
      if (colour !== lastColour) {
        if (batch && lastColour) {
          ctx.fill();
          ctx.beginPath();
        }
        ctx.fillStyle = colour;
        lastColour = colour;
      }
      const sx = v.ox + pos[2 * p] * v.scale;
      const sy = v.oy - y * v.scale;
      if (!halo && opts.markers && opts.mode === 'origin') drawMarker(ctx, k, sx, sy, rr);
      else if (batch) ctx.rect(sx - rr, sy - rr, 2 * rr, 2 * rr);
      else ctx.fillRect(sx - rr, sy - rr, 2 * rr, 2 * rr);
    }
    if (batch && lastColour) ctx.fill();
    ctx.restore();
  }
}

export function drawPathlines(
  ctx: Ctx2D,
  v: Viewport,
  info: StaticInfo,
  paths: number[][],
  theme: Theme,
  status?: Uint8Array,
  angleDeg = 0,
): void {
  // Trails are stored in pot coordinates and drawn with the pot's current pose.
  const pose = makePose((-angleDeg * Math.PI) / 180, 0, info.config.pivotLocal, info.config.pivotWorld);
  const w = new Float64Array(2);
  const at = (lx: number, ly: number): [number, number] => {
    localToWorld(pose, lx, ly, w);
    return toScreen(v, w[0], w[1]);
  };
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  paths.forEach((pts, idx) => {
    if (pts.length < 4) return;
    const k = info.origin[info.pathlineParticles[idx]];
    ctx.strokeStyle = theme.origins[k % theme.origins.length];
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      const [sx, sy] = at(pts[i], pts[i + 1]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    // End marker: solid dot = where the parcel is now; hollow ring = where it left through the lip.
    const [ex, ey] = at(pts[pts.length - 2], pts[pts.length - 1]);
    const poured = status !== undefined && status[info.pathlineParticles[idx]] === STATUS_DISCHARGED;
    ctx.beginPath();
    ctx.arc(ex, ey, poured ? 3.5 : 2.5, 0, Math.PI * 2);
    if (poured) {
      ctx.strokeStyle = theme.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = theme.ink;
      ctx.fill();
    }
  });
  ctx.restore();
}

export function drawArrows(ctx: Ctx2D, v: Viewport, arrows: Float32Array, theme: Theme): void {
  ctx.save();
  ctx.strokeStyle = theme.arrow;
  ctx.lineWidth = 1;
  const k = 0.12; // seconds of travel shown per arrow
  for (let i = 0; i + 3 < arrows.length; i += 4) {
    const [sx, sy] = toScreen(v, arrows[i], arrows[i + 1]);
    const [ex, ey] = toScreen(v, arrows[i] + arrows[i + 2] * k, arrows[i + 1] + arrows[i + 3] * k);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ex, ey, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The receiving glass is an accounting display, not a simulation: stacked bands show
 * discharged volume by origin, bottom band first, in the order the volume arrived.
 */
export function drawGlass(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  capacity: number,
  byOrigin: number[],
  names: string[],
  theme: Theme,
): void {
  ctx.save();
  let level = y + h;
  const total = byOrigin.reduce((a, b) => a + b, 0);
  byOrigin.forEach((vol, k) => {
    const hh = (vol / capacity) * h;
    if (hh <= 0) return;
    ctx.fillStyle = theme.origins[k % theme.origins.length];
    ctx.fillRect(x + 2, level - hh, w - 4, Math.max(0, hh - 2));
    level -= hh;
  });
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w, y);
  ctx.stroke();
  ctx.fillStyle = theme.ink;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${(total * 1e6).toFixed(0)} mL`, x + w / 2, y + h + 6);
  ctx.fillStyle = theme.muted;
  ctx.fillText('glass (accounting only)', x + w / 2, y + h + 22);
  void names;
  ctx.restore();
}

/** Initial pot view: where did the poured liquid start? Discharged parcels in colour at their initial positions. */
export function drawInitialMap(
  ctx: Ctx2D,
  width: number,
  height: number,
  info: StaticInfo,
  status: Uint8Array,
  theme: Theme,
): void {
  ctx.save();
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, width, height);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const pl of info.polylines)
    for (const [x, y] of pl) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  const vp = fitViewport(x1 - x0 + 0.02, y1 - y0 + 0.02, width, height, 6);
  const tx = (x: number) => vp.ox + (x - x0 + 0.01) * vp.scale;
  const ty = (y: number) => vp.oy - (y - y0 + 0.01) * vp.scale;
  ctx.strokeStyle = theme.wall;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = Math.max(1, 2 * info.halfWall * vp.scale);
  ctx.lineCap = 'round';
  for (const pl of info.polylines) {
    ctx.beginPath();
    pl.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(tx(x), ty(y)) : ctx.lineTo(tx(x), ty(y))));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const r = Math.max(1, info.h * vp.scale * 0.3);
  // Dim parcels first, then highlighted discharged ones on top.
  let lastColour = '';
  for (let pass = 0; pass < 2; pass++)
    for (let p = 0; p < info.n; p++) {
      const poured = status[p] === STATUS_DISCHARGED;
      if ((pass === 0) === poured) continue;
      const colour = poured ? theme.origins[info.origin[p] % theme.origins.length] : theme.dim;
      if (colour !== lastColour) {
        ctx.fillStyle = colour;
        lastColour = colour;
      }
      ctx.fillRect(tx(info.x0[p]) - r, ty(info.y0[p]) - r, 2 * r, 2 * r);
    }
  // Band edges.
  ctx.strokeStyle = theme.muted;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const e of info.bandEdges) {
    ctx.beginPath();
    ctx.moveTo(tx(0), ty(e));
    ctx.lineTo(tx(info.config.vessel.innerWidth), ty(e));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}
