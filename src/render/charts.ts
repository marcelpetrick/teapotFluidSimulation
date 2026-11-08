// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Small dependency-free Canvas charts. Each has one y-axis, thin marks, recessive grid,
// and a legend in the surrounding HTML; values are also available as tables.

import type { DischargeBin } from '../sim/metrics';
import type { HistoryRow } from '../sim/solver';
import type { Ctx2D, Theme } from './scene';

export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function chartBox(width: number, height: number): ChartBox {
  return { width, height, left: 40, right: 8, top: 8, bottom: 22 };
}

function axes(
  ctx: Ctx2D,
  b: ChartBox,
  theme: Theme,
  yTicks: number[],
  yMax: number,
  yLabel: (v: number) => string,
  xLabel: string,
): void {
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, b.width, b.height);
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = theme.muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ph = b.height - b.top - b.bottom;
  for (const t of yTicks) {
    const y = b.top + ph - (t / yMax) * ph;
    ctx.beginPath();
    ctx.moveTo(b.left, y);
    ctx.lineTo(b.width - b.right, y);
    ctx.stroke();
    ctx.fillText(yLabel(t), b.left - 4, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(xLabel, b.left + (b.width - b.left - b.right) / 2, b.height - b.bottom + 6);
}

/** Composition of each consecutive 50 mL bin of discharge: 100% stacked bars, one per bin. */
export function drawBinsChart(ctx: Ctx2D, b: ChartBox, bins: DischargeBin[], theme: Theme): void {
  axes(ctx, b, theme, [0, 0.5, 1], 1, (v) => `${(v * 100).toFixed(0)}%`, 'discharged volume, 50 mL bins');
  const pw = b.width - b.left - b.right;
  const ph = b.height - b.top - b.bottom;
  const n = Math.max(bins.length, 8);
  const bw = pw / n;
  bins.forEach((bin, i) => {
    const tot = bin.byOrigin.reduce((a, c) => a + c, 0);
    if (tot <= 0) return;
    let y = b.top + ph;
    bin.byOrigin.forEach((v, k) => {
      const hh = (v / tot) * ph;
      ctx.fillStyle = theme.origins[k % theme.origins.length];
      ctx.globalAlpha = bin.partial ? 0.55 : 1;
      if (hh > 2) ctx.fillRect(b.left + i * bw + 1, y - hh + 1, Math.max(1, bw - 2), hh - 2);
      y -= hh;
    });
    ctx.globalAlpha = 1;
  });
}

/** Bias ratio B_k per origin with a reference line at 1 (proportional sampling). */
export function drawBiasChart(
  ctx: Ctx2D,
  b: ChartBox,
  bias: (number | null)[] | null,
  names: string[],
  theme: Theme,
): void {
  const yMax = Math.max(2, ...(bias ?? []).map((v) => (v ?? 0) * 1.1));
  const ticks = [0, 1, 2].filter((t) => t <= yMax);
  axes(ctx, b, theme, ticks, yMax, (v) => v.toFixed(0), 'B = share poured / share initially');
  const pw = b.width - b.left - b.right;
  const ph = b.height - b.top - b.bottom;
  const K = names.length;
  const bw = pw / K;
  ctx.strokeStyle = theme.ink;
  ctx.setLineDash([4, 3]);
  const y1 = b.top + ph - (1 / yMax) * ph;
  ctx.beginPath();
  ctx.moveTo(b.left, y1);
  ctx.lineTo(b.width - b.right, y1);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let k = 0; k < K; k++) {
    const v = bias?.[k] ?? null;
    const x = b.left + k * bw + bw * 0.25;
    if (v !== null) {
      const hh = (v / yMax) * ph;
      ctx.fillStyle = theme.origins[k % theme.origins.length];
      ctx.fillRect(x, b.top + ph - hh, bw * 0.5, hh);
      ctx.fillStyle = theme.ink;
      ctx.fillText(v.toFixed(2), x + bw * 0.25, b.top + ph - hh - 2);
    }
    ctx.fillStyle = theme.muted;
    ctx.textBaseline = 'top';
    ctx.fillText(names[k], x + bw * 0.25, b.top + ph + 2);
    ctx.textBaseline = 'bottom';
  }
}

/** One series against time (separate charts for separate measures: no dual axes). */
export function drawTimeSeries(
  ctx: Ctx2D,
  b: ChartBox,
  history: HistoryRow[],
  pick: (h: HistoryRow) => number,
  duration: number,
  yMax: number,
  unit: string,
  theme: Theme,
  reference: number | null,
): void {
  const ym = Math.max(yMax, 1e-9);
  axes(ctx, b, theme, [0, ym / 2, ym], ym, (v) => `${v.toFixed(0)}${unit}`, 'time (s)');
  const pw = b.width - b.left - b.right;
  const ph = b.height - b.top - b.bottom;
  if (reference !== null) {
    ctx.strokeStyle = theme.muted;
    ctx.setLineDash([4, 3]);
    const y = b.top + ph - (reference / ym) * ph;
    ctx.beginPath();
    ctx.moveTo(b.left, y);
    ctx.lineTo(b.width - b.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((h, i) => {
    const x = b.left + (h.time / duration) * pw;
    const y = b.top + ph - (Math.min(pick(h), ym) / ym) * ph;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
