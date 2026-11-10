// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawDenseOrigins, packedColour, rasterizeOrigins } from '../src/render/dense';
import type { StaticInfo } from '../src/worker/host';
import type { RenderSnapshot } from '../src/sim/types';
import { fakeCtx } from './helpers';

const info = { h: 0.01, origin: new Uint8Array([0, 1, 2]), config: { domainHeight: 1 } } as StaticInfo;
const viewport = { width: 14, height: 10, ox: 0, oy: 10, scale: 10 };
const snap = (): RenderSnapshot => ({
  count: 3,
  positions: new Float32Array([0.2, 0.5, 0.2, 0.5, 0.9, 0.5]),
  status: new Uint8Array(3),
  speed: new Float32Array(3),
  temperature: null,
  time: 0,
  angleDeg: 0,
});
const theme = {
  origins: ['#f00', '#0f0', '#00f'],
  dim: '#123456',
  surface: '#fff',
  ink: '#000',
  muted: '#555',
  wall: '#333',
  grid: '#ddd',
  arrow: '#000',
};
const opts = { mode: 'origin' as const, markers: false, pathlines: false, arrows: false };
const colours = theme.origins.map((c) => packedColour(c)!);
afterEach(() => vi.unstubAllGlobals());

describe('dense origin raster', () => {
  it('packs exact opaque colours for either byte order and rejects alpha colours', () => {
    expect(packedColour('#123', true)).toBe(0xff332211);
    expect(packedColour('#112233', false)).toBe(0x112233ff);
    expect(packedColour('rgba(1,2,3,0.5)')).toBeNull();
    expect(packedColour('#11223344')).toBeNull();
  });
  it('preserves painter order and origin colours without modifying state', () => {
    const s = snap(),
      before = s.positions.slice(),
      status = s.status.slice(),
      origins = info.origin.slice();
    const pixels = new Uint8ClampedArray(14 * 10 * 4);
    rasterizeOrigins(pixels, 14, 10, viewport, info, s, -1, colours, packedColour(theme.dim)!);
    const words = new Uint32Array(pixels.buffer);
    expect(words[5 * 14 + 2]).toBe(colours[1]);
    expect(words[5 * 14 + 9]).toBe(colours[2]);
    expect(words[0]).toBe(0);
    expect(s.positions).toEqual(before);
    expect(s.status).toEqual(status);
    expect(info.origin).toEqual(origins);
    rasterizeOrigins(pixels, 14, 10, viewport, info, s, 0, colours, packedColour(theme.dim)!);
    expect(words[5 * 14 + 2]).toBe(packedColour(theme.dim));
  });
  it('clears old pixels, hides removed and out-of-view parcels, and clips canvas edges', () => {
    const s = snap();
    const pixels = new Uint8ClampedArray(14 * 10 * 4).fill(255);
    s.status.set([2, 3, 1]);
    s.positions[5] = 2;
    rasterizeOrigins(pixels, 14, 10, viewport, info, s, undefined, colours, 0);
    expect(pixels.every((v) => v === 0)).toBe(true);
    s.status.fill(0);
    s.positions.set([-10, 0.5, 0.2, -2, 0, 0.5]);
    rasterizeOrigins(pixels, 14, 10, viewport, info, s, undefined, colours, 0);
    expect(new Uint32Array(pixels.buffer)[5 * 14]).toBe(colours[2]);
  });
  it('uses reusable offscreen storage and falls back for incompatible views', () => {
    const create = vi.fn(
      (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
    );
    const put = vi.fn();
    let available = true;
    const ctor = vi.fn();
    class Canvas {
      constructor(
        public width: number,
        public height: number,
      ) {
        ctor();
      }
      getContext() {
        return available ? { createImageData: create, putImageData: put } : null;
      }
    }
    vi.stubGlobal('OffscreenCanvas', Canvas);
    const ctx = Object.assign(fakeCtx(), { canvas: { width: 14, height: 10 }, drawImage: vi.fn() });
    const sample = snap();
    const s = {
      ...sample,
      count: 20000,
      positions: new Float32Array(40000),
      status: new Uint8Array(20000).fill(3),
      speed: new Float32Array(20000),
    };
    s.positions.set(sample.positions);
    s.status.set(sample.status); // the remaining parcels are legitimately lost and not rendered
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(true);
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(true);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
    ctx.canvas.width = 15;
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(true);
    expect(ctor).toHaveBeenCalledTimes(2);
    expect(drawDenseOrigins(ctx, viewport, info, s, { ...opts, mode: 'speed' }, theme)).toBe(false);
    expect(drawDenseOrigins(ctx, viewport, info, s, { ...opts, markers: true }, theme)).toBe(false);
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, { ...theme, glow: true })).toBe(false);
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, { ...theme, dim: 'rgba(0,0,0,0.5)' })).toBe(false);
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, { ...theme, origins: ['transparent'] })).toBe(
      false,
    );
    ctx.globalAlpha = 0.5;
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(false);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(false);
    ctx.globalCompositeOperation = 'source-over';
    ctx.canvas.width = 0;
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(false);
    available = false;
    ctx.canvas.width = 20;
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(false);
    expect(drawDenseOrigins(fakeCtx(), viewport, info, s, opts, theme)).toBe(false);
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(false);
    s.count = 3;
    expect(drawDenseOrigins(ctx, viewport, info, s, opts, theme)).toBe(false);
  });
});
