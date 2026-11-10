// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// Dense opaque origin views: rasterize every parcel into a reusable pixel buffer instead of
// submitting enormous overlapping canvas paths. Physics, status and immutable labels stay untouched.
import { STATUS_DISCHARGED, STATUS_IN_POT, type RenderSnapshot } from '../sim/types';
import type { StaticInfo } from '../worker/host';
import type { Ctx2D, SceneOptions, Theme, Viewport } from './scene';

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Only opaque hex colours qualify. Transparency must retain individual parcel compositing. */
export function packedColour(hex: string, littleEndian = LITTLE_ENDIAN): number | null {
  if (!/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(hex)) return null;
  const full = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1);
  const rgb = Number.parseInt(full, 16);
  const r = rgb >>> 16;
  const g = (rgb >>> 8) & 255;
  const b = rgb & 255;
  return (
    (littleEndian ? r | (g << 8) | (b << 16) | (255 << 24) : (r << 24) | (g << 16) | (b << 8) | 255) >>> 0
  );
}

/** One square per visible parcel, in painter order. No averaging or origin-colour blending. */
export function rasterizeOrigins(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  v: Viewport,
  info: StaticInfo,
  snap: RenderSnapshot,
  highlight: number | undefined,
  colours: number[],
  dim: number,
): void {
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
  words.fill(0);
  const r = Math.max(1.2, info.h * v.scale * 0.3);
  for (let p = 0; p < snap.count; p++) {
    const status = snap.status[p];
    const y = snap.positions[2 * p + 1];
    if (status !== STATUS_IN_POT && status !== STATUS_DISCHARGED) continue;
    if (y < -0.05 || y > info.config.domainHeight * 1.2) continue;
    const origin = info.origin[p];
    const colour =
      highlight !== undefined && highlight >= 0 && highlight !== origin
        ? dim
        : colours[origin % colours.length];
    const sx = v.ox + snap.positions[2 * p] * v.scale;
    const sy = v.oy - y * v.scale;
    const x0 = Math.max(0, Math.floor(sx - r));
    const x1 = Math.min(width, Math.ceil(sx + r));
    const y0 = Math.max(0, Math.floor(sy - r));
    const y1 = Math.min(height, Math.ceil(sy + r));
    for (let row = y0; row < y1; row++) for (let x = x0; x < x1; x++) words[row * width + x] = colour;
  }
}

interface Raster {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
  image: ImageData;
}
const cache = new WeakMap<object, Raster>();

/** Returns false for unsupported platforms or views that need the ordinary canvas renderer. */
export function drawDenseOrigins(
  ctx: Ctx2D,
  v: Viewport,
  info: StaticInfo,
  snap: RenderSnapshot,
  opts: SceneOptions,
  theme: Theme,
): boolean {
  if (
    snap.count < 20000 ||
    opts.mode !== 'origin' ||
    opts.markers ||
    theme.glow ||
    ctx.globalAlpha !== 1 ||
    ctx.globalCompositeOperation !== 'source-over' ||
    typeof OffscreenCanvas === 'undefined' ||
    !('canvas' in ctx) ||
    !('drawImage' in ctx)
  )
    return false;
  const colours = theme.origins.map((c) => packedColour(c));
  const dim = packedColour(theme.dim);
  if (dim === null || colours.some((c) => c === null)) return false;
  const native = ctx as CanvasRenderingContext2D;
  const { width, height } = native.canvas;
  if (width <= 0 || height <= 0) return false;
  let raster = cache.get(ctx);
  if (!raster || raster.canvas.width !== width || raster.canvas.height !== height) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return false;
    raster = { canvas, context, image: context.createImageData(width, height) };
    cache.set(ctx, raster);
  }
  rasterizeOrigins(raster.image.data, width, height, v, info, snap, opts.highlight, colours as number[], dim);
  raster.context.putImageData(raster.image, 0, 0);
  native.drawImage(raster.canvas, 0, 0);
  return true;
}
