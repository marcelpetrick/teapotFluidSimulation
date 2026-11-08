// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Calibrate the pour controller's return anticipation for a preset by bisection, so the
// automated pour lands near its target discharge. Prints the value to put into
// src/sim/config.ts. The controller never removes liquid; this only tunes *when* the
// return starts. Usage: npx tsx scripts/calibrate-anticipation.ts <presetId> [quality]

import { presetById } from '../src/sim/config';
import { Simulation } from '../src/sim/solver';

function run(id: string, anticipation: number, quality?: number): number {
  const cfg = presetById(id).build();
  if (quality) cfg.cellsAcrossBody = quality;
  cfg.motion.anticipation = anticipation;
  const sim = new Simulation(cfg);
  let doneAt = -1;
  while (!sim.finished) {
    sim.advance(0.1);
    if (sim.controller.phase === 'done' && doneAt < 0) doneAt = sim.time;
    if (doneAt >= 0 && sim.time > doneAt + 1) break;
  }
  return sim.diagnostics().volumeDischarged;
}

const id = process.argv[2];
if (!id) {
  console.error('usage: calibrate-anticipation.ts <presetId> [quality]');
  process.exit(2);
}
const quality = process.argv[3] ? Number(process.argv[3]) : undefined;
const target = presetById(id).build().motion.targetVolume;
let lo = 0;
let hi = 2.5;
let best = { a: 0, v: run(id, 0, quality) };
console.log(`a=0.000 discharge=${(best.v * 1e6).toFixed(1)} mL`);
for (let k = 0; k < 9; k++) {
  const mid = 0.5 * (lo + hi);
  const v = run(id, mid, quality);
  console.log(`a=${mid.toFixed(3)} discharge=${(v * 1e6).toFixed(1)} mL`);
  if (Math.abs(v - target) < Math.abs(best.v - target)) best = { a: mid, v };
  if (v > target) lo = mid;
  else hi = mid;
}
const err = (best.v / target - 1) * 100;
console.log(
  `${id}: anticipation=${best.a.toFixed(3)} discharge=${(best.v * 1e6).toFixed(1)} mL (${err.toFixed(1)}% vs target)`,
);
