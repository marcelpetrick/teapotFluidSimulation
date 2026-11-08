// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Phase profile of the solver: wraps the substep phases with timers and prints each phase's
// share of the run time. Usage: npx tsx benchmarks/profile.ts [presetId] [cellsAcrossBody] [seconds]
import { presetById } from '../src/sim/config';
import { Simulation } from '../src/sim/solver';

const [preset = 'teapot-gentle', cells = '44', seconds = '3'] = process.argv.slice(2);
const phases = [
  'classify',
  'particlesToGrid',
  'applyBodyForces',
  'applyViscosity',
  'setSolidFaces',
  'project',
  'extrapolate',
  'gridToParticles',
  'densityCorrection',
  'advect',
  'thermalStep',
  'recordSamples',
  'stableDt',
];
const proto = Simulation.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const t: Record<string, number> = {};
for (const m of phases) {
  const f = proto[m];
  proto[m] = function (this: unknown, ...a: unknown[]) {
    const s = performance.now();
    const r = f.apply(this, a);
    t[m] = (t[m] ?? 0) + performance.now() - s;
    return r;
  };
}
const cfg = presetById(preset).build();
cfg.cellsAcrossBody = Number(cells);
const sim = new Simulation(cfg);
const s0 = performance.now();
sim.advance(Number(seconds));
const total = performance.now() - s0;
console.log(
  `${preset} @ ${cells} cells: ${sim.n} parcels, ${sim.steps} steps, ${(total / sim.steps).toFixed(2)} ms/step`,
);
for (const [k, v] of Object.entries(t).sort((a, b) => b[1] - a[1]))
  console.log(`${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
