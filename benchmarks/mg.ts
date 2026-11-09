// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Compare pressure preconditioners (MIC(0) vs multigrid) on the gentle pour: wall time,
// pressure iterations and the physical outcome. Usage: npx tsx benchmarks/mg.ts [cells] [seconds]
import { presetById } from '../src/sim/config';
import { Simulation } from '../src/sim/solver';

const [cells = '44', seconds = '4'] = process.argv.slice(2);
for (const pre of ['mic0', 'multigrid'] as const) {
  const cfg = presetById('teapot-gentle').build();
  cfg.cellsAcrossBody = Number(cells);
  cfg.pressurePreconditioner = pre;
  const sim = new Simulation(cfg);
  const t0 = performance.now();
  let maxIt = 0;
  while (sim.time < Number(seconds)) maxIt = Math.max(maxIt, sim.advance(0.1).pressureIterationsMax);
  const ms = performance.now() - t0;
  const d = sim.diagnostics();
  console.log(
    `${pre.padEnd(9)} cells ${cells}: ${(ms / sim.steps).toFixed(2)} ms/step, max PCG iterations ${maxIt}, poured ${(d.volumeDischarged * 1e6).toFixed(1)} mL, failures ${d.pressureFailures}`,
  );
}
