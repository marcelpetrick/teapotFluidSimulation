// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Thermal verification: differentially heated square cavity against de Vahl Davis (1983).
// Runs each Rayleigh number until the hot-wall Nusselt number is steady, then reports it.
// Usage: npx tsx benchmarks/cavity.ts [cells] [Ra ...] > benchmarks/cavity.json
import { DE_VAHL_DAVIS_NU, cavityConfig } from '../src/sim/config';
import { Simulation } from '../src/sim/solver';

const [cellsArg = '32', ...ras] = process.argv.slice(2);
const cells = Number(cellsArg);
const list = ras.length ? ras.map(Number) : [1e3, 1e4, 1e5];
const rows = list.map((ra) => {
  const cfg = cavityConfig(ra, cells);
  cfg.duration = 150; // upper bound; runs stop once steady
  const sim = new Simulation(cfg);
  const t0 = performance.now();
  const history: number[] = [];
  const coldHistory: number[] = [];
  let nu = { hot: NaN, cold: NaN };
  while (sim.time < cfg.duration) {
    sim.advance(1);
    nu = sim.wallNusselt() ?? nu;
    history.push(nu.hot);
    coldHistory.push(nu.cold);
    const n = history.length;
    // Steady: both wall Nusselt numbers changed by < 0.5 % over 5 simulated seconds, and the heat
    // entering at the hot wall matches what leaves at the cold wall within 2 %.
    const still = (h: number[]) => Math.abs(h[n - 1] - h[n - 6]) < 0.005 * Math.abs(h[n - 1]);
    const balanced = Math.abs(nu.hot - nu.cold) < 0.02 * Math.abs(nu.hot);
    if (n > 10 && still(history) && still(coldHistory) && balanced) break;
  }
  const reference = DE_VAHL_DAVIS_NU[ra];
  const mean = 0.5 * (nu.hot + nu.cold);
  const row = {
    rayleigh: ra,
    cells,
    simulatedSeconds: sim.time,
    wallSeconds: (performance.now() - t0) / 1000,
    nusseltHot: nu.hot,
    nusseltCold: nu.cold,
    nusseltMean: mean,
    reference,
    errorPercent: reference ? ((mean - reference) / reference) * 100 : null,
    maxSpeed: sim.diagnostics().maxSpeed,
    pressureFailures: sim.diagnostics().pressureFailures,
  };
  process.stderr.write(
    `Ra ${ra.toExponential(0)} @ ${cells}: Nu hot ${nu.hot.toFixed(3)} cold ${nu.cold.toFixed(3)} (ref ${reference}) in ${row.simulatedSeconds.toFixed(0)} s sim\n`,
  );
  return row;
});
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 1));
