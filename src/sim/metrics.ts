// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Metrics that answer the question, computed from raw parcel state (never from pixels):
//  - origin composition of discharged liquid (cumulative and in volume bins), bias ratios B_k
//  - origin-to-current-region matrix in pot coordinates
//  - coarse-scale segregation S of origin labels at several sampling scales
//  - survivor-cohort analysis separating selective removal from mixing

import { pointInPolygon, worldToLocal, type Pose, type Vessel } from './vessel';
import { STATUS_DISCHARGED, STATUS_IN_POT, STATUS_LOST, STATUS_SPILLED } from './types';

/** Minimal parcel view needed by the metrics (the Simulation satisfies it). */
export interface ParcelState {
  n: number;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  x0: ArrayLike<number>;
  y0: ArrayLike<number>;
  origin: ArrayLike<number>;
  status: ArrayLike<number>;
  initiallyInSpout: ArrayLike<number>;
  dischargeOrder: number[];
  parcelVolume: number;
  bandEdges: number[];
  initialBandCounts: number[];
  vessel: Vessel;
  pose: Pose;
}

export interface OriginComposition {
  /** F_k: initial volume fraction per origin. */
  initialFractions: number[];
  /** P_k: fraction of discharged volume per origin (null until discharge is nonzero). */
  dischargedFractions: number[] | null;
  /** B_k = P_k / F_k (null where undefined). */
  bias: (number | null)[] | null;
  dischargedVolume: number;
  dischargedByOrigin: number[];
  /** Volume of discharge that was initially in the spout channel. */
  dischargedFromSpout: number;
}

export function originComposition(s: ParcelState): OriginComposition {
  const K = s.initialBandCounts.length;
  const total = s.initialBandCounts.reduce((a, b) => a + b, 0);
  const F = s.initialBandCounts.map((c) => c / total);
  const byOrigin = new Array(K).fill(0);
  let spout = 0;
  for (const p of s.dischargeOrder) {
    byOrigin[s.origin[p]]++;
    if (s.initiallyInSpout[p]) spout++;
  }
  const nd = s.dischargeOrder.length;
  const P = nd > 0 ? byOrigin.map((c) => c / nd) : null;
  return {
    initialFractions: F,
    dischargedFractions: P,
    bias: P ? P.map((p, k) => (F[k] > 0 ? p / F[k] : null)) : null,
    dischargedVolume: nd * s.parcelVolume,
    dischargedByOrigin: byOrigin.map((c) => c * s.parcelVolume),
    dischargedFromSpout: spout * s.parcelVolume,
  };
}

export interface DischargeBin {
  /** Bin start/end in cumulative discharged volume (m^3). */
  from: number;
  to: number;
  /** Volume per origin in this bin. */
  byOrigin: number[];
  partial: boolean;
}

/** Composition of discharge in consecutive volume bins (default 50 mL); the last bin may be partial. */
export function dischargeBins(s: ParcelState, binVolume = 50e-6): DischargeBin[] {
  const K = s.initialBandCounts.length;
  const perBin = Math.max(1, Math.round(binVolume / s.parcelVolume));
  const bins: DischargeBin[] = [];
  const order = s.dischargeOrder;
  for (let start = 0; start < order.length; start += perBin) {
    const end = Math.min(order.length, start + perBin);
    const byOrigin = new Array(K).fill(0);
    for (let r = start; r < end; r++) byOrigin[s.origin[order[r]]] += s.parcelVolume;
    bins.push({
      from: start * s.parcelVolume,
      to: end * s.parcelVolume,
      byOrigin,
      partial: end - start < perBin,
    });
  }
  return bins;
}

export const REGION_NAMES_BASE = ['spout', 'discharged', 'spilled', 'lost'];

export interface RegionMatrix {
  /** Column labels: pot bands (bottom..top, by the initial band edges) then spout, discharged, spilled, lost. */
  columns: string[];
  /** rows[k][j]: volume of origin k now in region j. */
  volumes: number[][];
  /** Row-normalised fractions. */
  fractions: number[][];
}

export function regionMatrix(s: ParcelState, bandNames: string[]): RegionMatrix {
  const K = s.initialBandCounts.length;
  const columns = [...bandNames.map((b) => `${b} zone`), 'spout', 'discharged', 'spilled', 'lost'];
  const J = columns.length;
  const vol = Array.from({ length: K }, () => new Array(J).fill(0));
  const loc = new Float64Array(2);
  const sp = s.vessel.spoutPolygon;
  const W = s.vessel.config.innerWidth;
  for (let p = 0; p < s.n; p++) {
    const k = s.origin[p];
    const st = s.status[p];
    let j: number;
    if (st === STATUS_DISCHARGED) j = K + 1;
    else if (st === STATUS_SPILLED) j = K + 2;
    else if (st === STATUS_LOST) j = K + 3;
    else {
      worldToLocal(s.pose, s.x[p], s.y[p], loc);
      if (sp && loc[0] > W && pointInPolygon(sp, loc[0], loc[1])) j = K;
      else {
        j = 0;
        while (j < K - 1 && loc[1] > s.bandEdges[j]) j++;
      }
    }
    vol[k][j] += s.parcelVolume;
  }
  const fractions = vol.map((row) => {
    const t = row.reduce((a, b) => a + b, 0);
    return row.map((v) => (t > 0 ? v / t : 0));
  });
  return { columns, volumes: vol, fractions };
}

export interface SegregationResult {
  /** Bin edge length (m). */
  scale: number;
  /** S = sum_j w_j sum_k (p_jk - pbar_k)^2, null if no bin qualifies. */
  S: number | null;
  binsUsed: number;
  /** Volume fraction of the population in bins below the minimum sample count (excluded). */
  excludedFraction: number;
  /** Composition pbar of the population considered. */
  pbar: number[];
}

/**
 * Coarse-scale segregation of origin labels for a parcel subset at bin size `scale`,
 * using pot-local coordinates (`useInitial` selects the initial positions).
 */
export function segregation(
  s: ParcelState,
  include: (p: number) => boolean,
  scale: number,
  useInitial: boolean,
  minCount = 4,
): SegregationResult {
  const K = s.initialBandCounts.length;
  const loc = new Float64Array(2);
  const bins = new Map<number, number[]>();
  const pbarCount = new Array(K).fill(0);
  let total = 0;
  for (let p = 0; p < s.n; p++) {
    if (!include(p)) continue;
    let lx: number;
    let ly: number;
    if (useInitial) {
      lx = s.x0[p];
      ly = s.y0[p];
    } else {
      worldToLocal(s.pose, s.x[p], s.y[p], loc);
      lx = loc[0];
      ly = loc[1];
    }
    const bi = Math.floor((lx + 1) / scale);
    const bj = Math.floor((ly + 1) / scale);
    const key = bi * 100000 + bj;
    let b = bins.get(key);
    if (!b) {
      b = new Array(K + 1).fill(0);
      bins.set(key, b);
    }
    b[s.origin[p]]++;
    b[K]++;
    pbarCount[s.origin[p]]++;
    total++;
  }
  const pbar = pbarCount.map((c) => (total > 0 ? c / total : 0));
  let S = 0;
  let used = 0;
  let usedCount = 0;
  for (const b of bins.values()) {
    if (b[K] < minCount) continue;
    used++;
    usedCount += b[K];
  }
  if (used === 0) return { scale, S: null, binsUsed: 0, excludedFraction: total > 0 ? 1 : 0, pbar };
  for (const b of bins.values()) {
    if (b[K] < minCount) continue;
    const w = b[K] / usedCount;
    let acc = 0;
    for (let k = 0; k < K; k++) acc += (b[k] / b[K] - pbar[k]) ** 2;
    S += w * acc;
  }
  return { scale, S, binsUsed: used, excludedFraction: total > 0 ? 1 - usedCount / total : 0, pbar };
}

export const DEFAULT_SCALES = [0.01, 0.02, 0.04];

export interface MixingReport {
  scales: number[];
  /** S of the liquid currently in the pot, at each scale. */
  remainingNow: (number | null)[];
  /** S of the whole initial fill at t = 0, at each scale (reference S0). */
  initialAll: (number | null)[];
  /** Survivor cohort: the parcels currently in the pot, at their initial and current positions. */
  survivorInitial: (number | null)[];
  survivorNow: (number | null)[];
  survivorCount: number;
  survivorComposition: number[];
  excludedFraction: number[];
}

export function mixingReport(s: ParcelState, scales = DEFAULT_SCALES): MixingReport {
  const inPot = (p: number) => s.status[p] === STATUS_IN_POT;
  const all = () => true;
  const now = scales.map((sc) => segregation(s, inPot, sc, false));
  const init = scales.map((sc) => segregation(s, all, sc, true));
  const survInit = scales.map((sc) => segregation(s, inPot, sc, true));
  let count = 0;
  for (let p = 0; p < s.n; p++) if (inPot(p)) count++;
  return {
    scales,
    remainingNow: now.map((r) => r.S),
    initialAll: init.map((r) => r.S),
    survivorInitial: survInit.map((r) => r.S),
    survivorNow: now.map((r) => r.S),
    survivorCount: count,
    survivorComposition: now[0].pbar,
    excludedFraction: now.map((r) => r.excludedFraction),
  };
}

/** Plain-language summary answering the two questions, derived only from measured numbers. */
export function summarize(
  comp: OriginComposition,
  mix: MixingReport,
  bandNames: string[],
  targetMl: number,
  final = true,
): string[] {
  const out: string[] = [];
  if (!comp.dischargedFractions || comp.dischargedVolume <= 0) {
    out.push('No liquid has left through the spout or lip yet.');
  } else {
    const ml = comp.dischargedVolume * 1e6;
    const parts = comp.dischargedFractions.map((f, k) => `${(f * 100).toFixed(0)}% ${bandNames[k]}`);
    out.push(`Where did the cup's liquid start? Of ${ml.toFixed(0)} mL poured: ${parts.join(', ')}.`);
    if (targetMl > 0) {
      const over = ml - targetMl;
      out.push(
        final
          ? `Target ${targetMl.toFixed(0)} mL; actual ${ml.toFixed(0)} mL (${over >= 0 ? '+' : ''}${over.toFixed(0)} mL).`
          : `Target ${targetMl.toFixed(0)} mL; poured so far ${ml.toFixed(0)} mL.`,
      );
    }
    if (comp.bias) {
      let maxK = 0;
      comp.bias.forEach((b, k) => {
        if ((b ?? 0) > (comp.bias![maxK] ?? 0)) maxK = k;
      });
      out.push(
        `Most over-represented origin: ${bandNames[maxK]} (B = ${(comp.bias[maxK] ?? 0).toFixed(2)}; B = 1 means proportional sampling).`,
      );
    }
  }
  const sNow = mix.survivorNow[1];
  const sInit = mix.survivorInitial[1];
  if (sNow !== null && sInit !== null && sInit > 0) {
    const ratio = sNow / sInit;
    const verdict =
      ratio > 0.8
        ? 'the liquid left behind stayed largely layered'
        : ratio > 0.4
          ? 'the liquid left behind was partly rearranged'
          : 'the liquid left behind was substantially rearranged';
    out.push(
      `What happened to the rest? For the parcels still in the pot, segregation at the ${(mix.scales[1] * 100).toFixed(0)} cm scale went from ${sInit.toFixed(3)} to ${sNow.toFixed(3)} (ratio ${ratio.toFixed(2)}): ${verdict} at this scale.`,
    );
  }
  return out;
}
