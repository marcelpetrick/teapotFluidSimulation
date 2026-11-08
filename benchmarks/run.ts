// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Headless benchmark and sensitivity runner (vision §11, §18.7). Each case runs one preset
// with overrides until the controller is done plus 1 s (or the preset duration) and records
// discharge, origin fractions, survivor segregation, conservation and cost.
// Usage: npx tsx benchmarks/run.ts [caseId | prefix*] > benchmarks/results.json
import { presetById } from '../src/sim/config';
import { mixingReport, originComposition } from '../src/sim/metrics';
import { Simulation } from '../src/sim/solver';
import type { ExperimentConfig } from '../src/sim/types';

interface Case {
  id: string;
  preset: string;
  mutate?: (c: ExperimentConfig) => void;
}

const res = (q: number) => (c: ExperimentConfig) => (c.cellsAcrossBody = q);
export const CASES: Case[] = [
  { id: 'rest-flip-44', preset: 'tank-rest' },
  { id: 'rest-apic-44', preset: 'tank-rest', mutate: (c) => (c.transfer = 'apic') },
  { id: 'tilt-flip-44', preset: 'teapot-tilt' },
  { id: 'tilt-apic-44', preset: 'teapot-tilt', mutate: (c) => (c.transfer = 'apic') },
  { id: 'pour-flip-44', preset: 'teapot-gentle' },
  { id: 'pour-flip-64', preset: 'teapot-gentle', mutate: res(64) },
  { id: 'pour-flip-96', preset: 'teapot-gentle', mutate: res(96) },
  {
    id: 'pour-flip-96-halfdt',
    preset: 'teapot-gentle',
    mutate: (c) => ((c.cellsAcrossBody = 96), (c.maxSubstep = 1 / 400), (c.cfl = 0.4)),
  },
  { id: 'pour-apic-44', preset: 'teapot-gentle', mutate: (c) => (c.transfer = 'apic') },
  {
    id: 'pour-apic-64',
    preset: 'teapot-gentle',
    mutate: (c) => ((c.transfer = 'apic'), (c.cellsAcrossBody = 64)),
  },
  { id: 'pour-flip0.80-44', preset: 'teapot-gentle', mutate: (c) => (c.flipRatio = 0.8) },
  { id: 'pour-flip1.00-44', preset: 'teapot-gentle', mutate: (c) => (c.flipRatio = 1) },
  { id: 'pour-nodensity-44', preset: 'teapot-gentle', mutate: (c) => (c.densityCorrection = 0) },
  { id: 'pour-seed2-44', preset: 'teapot-gentle', mutate: (c) => (c.seed = 2) },
  { id: 'still-44', preset: 'teapot-still', mutate: (c) => (c.duration = 7) },
  { id: 'fast-44', preset: 'teapot-fast' },
  { id: 'slow-44', preset: 'teapot-slow' },
  { id: 'pitcher-44', preset: 'pitcher-gentle' },
  { id: 'repeat-44', preset: 'teapot-repeat' },
];

export function runCase(k: Case) {
  const cfg = presetById(k.preset).build();
  k.mutate?.(cfg);
  const t0 = performance.now();
  const sim = new Simulation(cfg);
  let doneAt = -1;
  let maxIter = 0;
  let maxDiv = 0;
  let maxSpeedAfter2s = 0;
  while (!sim.finished) {
    const d = sim.advance(0.1);
    maxIter = Math.max(maxIter, d.pressureIterationsMax);
    maxDiv = Math.max(maxDiv, d.divergenceAfter);
    if (d.time > 2) maxSpeedAfter2s = Math.max(maxSpeedAfter2s, d.maxSpeed);
    if (sim.controller.phase === 'done' && doneAt < 0) doneAt = sim.time;
    if (doneAt >= 0 && sim.time > doneAt + 1 && cfg.motion.kind !== 'still') break;
  }
  const wall = (performance.now() - t0) / 1000;
  const d = sim.diagnostics();
  const comp = originComposition(sim);
  const mix = mixingReport(sim);
  return {
    id: k.id,
    preset: k.preset,
    cellsAcrossBody: cfg.cellsAcrossBody,
    transfer: cfg.transfer,
    flipRatio: cfg.flipRatio,
    densityCorrection: cfg.densityCorrection,
    parcels: sim.n,
    simulatedSeconds: sim.time,
    wallSeconds: wall,
    simSecondsPerWallSecond: sim.time / wall,
    dischargedMl: d.volumeDischarged * 1e6,
    targetMl: cfg.motion.targetVolume * 1e6,
    spilledMl: d.volumeSpilled * 1e6,
    lostMl: d.volumeLost * 1e6,
    ledgerErrorMl: d.ledgerError * 1e6,
    originFractions: comp.dischargedFractions,
    bias: comp.bias,
    fromSpoutMl: comp.dischargedFromSpout * 1e6,
    survivorSInitial2cm: mix.survivorInitial[1],
    survivorSNow2cm: mix.survivorNow[1],
    interiorDensity: d.interiorDensity,
    representedDrift: d.representedDrift,
    maxPressureIterations: maxIter,
    pressureFailures: d.pressureFailures,
    maxDivergenceAfter: maxDiv,
    maxSpeedAfter2s,
    densityCorrectionDisplacement: d.densityCorrectionDisplacement,
  };
}

const filter = process.argv[2];
const selected = CASES.filter(
  (c) => !filter || c.id === filter || (filter.endsWith('*') && c.id.startsWith(filter.slice(0, -1))),
);
const results = selected.map((c) => {
  const r = runCase(c);
  process.stderr.write(`${r.id}: ${r.dischargedMl.toFixed(1)} mL in ${r.wallSeconds.toFixed(1)} s\n`);
  return r;
});
console.log(
  JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, results }, null, 1),
);
