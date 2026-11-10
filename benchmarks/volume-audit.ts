// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// Observational refinement and grid-phase sensitivity; never changes solver state or its gate.
// Usage: npx tsx benchmarks/volume-audit.ts > benchmarks/volume-audit.json
import { execFileSync } from 'node:child_process';
import { presetById } from '../src/sim/config';
import { Simulation } from '../src/sim/solver';
import { STATUS_IN_POT } from '../src/sim/types';

function probe(sim: Simulation) {
  const occupied = [];
  // Translating only the measuring grid exposes the all-or-nothing surface-cell ambiguity.
  for (const phase of [0, 0.25, 0.5, 0.75]) {
    const cells = new Set<string>();
    for (let p = 0; p < sim.n; p++) {
      if (sim.status[p] !== STATUS_IN_POT) continue;
      cells.add(`${Math.floor(sim.x[p] / sim.h + phase)},${Math.floor(sim.y[p] / sim.h + phase)}`);
    }
    occupied.push({ phase, occupiedMl: cells.size * sim.h * sim.h * sim.depth * 1e6 });
  }
  const d = sim.diagnostics();
  return {
    time: sim.time,
    inPotMl: d.volumeInPot * 1e6,
    ledgerErrorMl: d.ledgerError * 1e6,
    representedDrift: d.representedDrift,
    originalGatePass: Math.abs(d.representedDrift) < 0.01,
    fluidCells: d.fluidCells,
    gridPhaseProbe: occupied,
    phaseRangeMl:
      Math.max(...occupied.map((p) => p.occupiedMl)) - Math.min(...occupied.map((p) => p.occupiedMl)),
  };
}
const results = [];
for (const preset of ['teapot-still', 'teapot-gentle']) {
  for (const resolution of [32, 44, 64]) {
    const cfg = presetById(preset).build();
    cfg.cellsAcrossBody = resolution;
    cfg.duration = 14;
    const sim = new Simulation(cfg);
    const samples = [probe(sim)];
    for (const target of [2, 7, 14]) {
      while (!sim.finished && sim.time < target) sim.advance(Math.min(0.1, target - sim.time));
      samples.push(probe(sim));
    }
    results.push({ preset, resolution, parcels: sim.n, samples });
    process.stderr.write(`${preset} ${resolution} complete\n`);
  }
}
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      note: 'No physics changes. The shifted measuring grid counts all in-pot parcels, including wall-intersecting cells, so it is a sensitivity probe, not a replacement for solver fluidCells or an independent volume measurement. Equal parcel volume makes the ledger exact by construction; it cannot validate spatial incompressibility. The original one-percent gate is retained.',
      results,
    },
    null,
    2,
  ),
);
