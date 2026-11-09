// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Offline 3D reference run of the gentle 400 mL pour (vision §18.8), for comparison with the
// 2D model. Usage: npx tsx benchmarks/run3d.ts [cellSizeMm] [seconds] > benchmarks/run3d.json
import { gentlePour3D } from '../src/sim3d/presets3d';
import { Simulation3D } from '../src/sim3d/solver3d';

const [cellArg = '4', secondsArg = '20'] = process.argv.slice(2);
const sim = new Simulation3D(gentlePour3D(Number(cellArg), Number(secondsArg)));
const t0 = performance.now();
const rows: unknown[] = [];
process.stderr.write(`3D: ${sim.n} parcels (half pot), grid ${sim.nx}x${sim.ny}x${sim.nz}\n`);
let doneAt = -1;
while (!sim.finished) {
  const d = sim.advance(0.5);
  rows.push(d);
  process.stderr.write(
    `t=${d.time.toFixed(1)} ${d.phase} tilt=${d.angleDeg.toFixed(1)} out=${d.dischargedMl.toFixed(0)} spill=${d.spilledMl.toFixed(0)} lost=${d.lostMl.toFixed(0)} it=${d.pressureIterations} rho=${d.interiorDensity.toFixed(3)} wall=${((performance.now() - t0) / 1000).toFixed(0)}s\n`,
  );
  if (d.phase === 'done' && doneAt < 0) doneAt = d.time;
  if (doneAt >= 0 && d.time > doneAt + 1.5) break;
}
const d = sim.diagnostics();
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      cellMm: Number(cellArg),
      result: d,
      dischargedFractions: sim.dischargedFractions(),
      wallSeconds: (performance.now() - t0) / 1000,
      history: rows,
    },
    null,
    1,
  ),
);
