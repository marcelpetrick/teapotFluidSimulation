// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Isolated solver throughput: simulated seconds per wall-clock second for the default pour at
// each resolution of the quality ladder, run sequentially. Usage: npx tsx benchmarks/perf.ts
import { cpus } from 'node:os';
import { QUALITY_LADDER, presetById } from '../src/sim/config';
import { Simulation } from '../src/sim/solver';

const rows = QUALITY_LADDER.map((q) => {
  const cfg = presetById('teapot-gentle').build();
  cfg.cellsAcrossBody = q;
  const sim = new Simulation(cfg);
  const t0 = performance.now();
  sim.advance(4); // includes tilt-in and the start of the pour
  const wall = (performance.now() - t0) / 1000;
  return {
    cellsAcrossBody: q,
    parcels: sim.n,
    grid: `${sim.nx}x${sim.ny}`,
    simulatedSeconds: 4,
    wallSeconds: wall,
    simPerWall: 4 / wall,
    steps: sim.steps,
  };
});
console.log(
  JSON.stringify(
    { generatedAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, rows },
    null,
    1,
  ),
);
