// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// Compare reference state and throughput across checkouts on the same machine.
// Usage: npx tsx benchmarks/review-profile.ts [checkout-root] [repetitions]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Simulation as Sim } from '../src/sim/solver';

const root = resolve(process.argv[2] ?? '.');
const repetitions = Number(process.argv[3] ?? 3);
if (!Number.isInteger(repetitions) || repetitions < 1)
  throw new Error('Repetitions must be a positive integer.');
const { presetById } = await import(pathToFileURL(resolve(root, 'src/sim/config.ts')).href);
const { Simulation } = await import(pathToFileURL(resolve(root, 'src/sim/solver.ts')).href);
const warm = new Simulation(presetById('teapot-gentle').build()) as Sim;
warm.advance(0.5);
const runs = [];
for (let run = 0; run < repetitions; run++) {
  const cfg = presetById('teapot-gentle').build();
  const start = performance.now();
  const sim = new Simulation(cfg) as Sim;
  const initialized = performance.now();
  sim.advance(cfg.duration);
  const finished = performance.now();
  const hash = createHash('sha256');
  for (const array of [
    sim.x,
    sim.y,
    sim.vx,
    sim.vy,
    sim.temperature,
    sim.status,
    sim.origin,
    sim.exitTime,
    sim.u,
    sim.v,
    sim.pressure,
  ])
    hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  hash.update(
    JSON.stringify([
      sim.time,
      sim.steps,
      [0, 1, 2, 3].map((status) => sim.status.reduce((n, s) => n + Number(s === status), 0)),
      sim.dischargeOrder,
      sim.history.map(({ time, angleDeg, inPot, discharged, spilled, lost }) => ({
        time,
        angleDeg,
        inPot,
        discharged,
        spilled,
        lost,
      })),
    ]),
  );
  runs.push({
    residentMiB: process.memoryUsage().rss / 2 ** 20,
    peakResidentMiB: process.resourceUsage().maxRSS / 1024,
    initMs: initialized - start,
    solverMs: finished - initialized,
    stateSha256: hash.digest('hex'),
    steps: sim.steps,
    parcels: sim.n,
  });
}
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      node: process.version,
      cpu: cpus()[0]?.model,
      preset: 'teapot-gentle',
      seconds: 14,
      runs,
    },
    null,
    2,
  ),
);
