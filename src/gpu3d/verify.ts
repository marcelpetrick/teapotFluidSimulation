// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Verification of the WebGPU 3D solver against the CPU reference (docs/plan.md, phase F):
// a step-by-step comparison from the identical seeded state with the CPU's substep sequence, and
// a full gentle pour whose poured volume and layer shares are compared with the committed CPU run.

import { gentlePour3D } from '../sim3d/presets3d';
import { IN_POT, Simulation3D, type Config3D, type Diagnostics3D } from '../sim3d/solver3d';
import { GpuSimulation3D } from './solver';

export interface StepComparison {
  steps: number;
  simulatedSeconds: number;
  parcels: number;
  /** RMS and max distance between CPU and GPU parcel positions, in cell sizes. */
  rmsPositionCells: number;
  maxPositionCells: number;
  /** RMS velocity difference relative to the CPU RMS speed. */
  relativeVelocityRms: number;
  /** Parcels whose status differs (in pot, discharged, spilled, lost). */
  statusMismatches: number;
  cpu: Diagnostics3D;
  gpu: Diagnostics3D;
}

/** Run both solvers from the same seeded state with the CPU's substeps and compare the parcels. */
export async function compareSteps(device: GPUDevice, cfg: Config3D, steps: number): Promise<StepComparison> {
  const cpu = new Simulation3D(cfg);
  const gpu = new GpuSimulation3D(device, cfg);
  try {
    for (let s = 0; s < steps && !cpu.finished; s++) {
      const dt = Math.min(cpu.stableDt(), cfg.duration - cpu.time);
      cpu.step(dt);
      await gpu.step(dt);
    }
    const { pos, vel, status } = await gpu.readParticles();
    const n = cpu.n;
    let d2 = 0;
    let dmax = 0;
    let dv2 = 0;
    let v2 = 0;
    let mism = 0;
    let counted = 0;
    for (let p = 0; p < n; p++) {
      if (status[p] !== cpu.status[p]) mism++;
      if (cpu.status[p] !== IN_POT) continue;
      counted++;
      const d = Math.hypot(pos[4 * p] - cpu.x[p], pos[4 * p + 1] - cpu.y[p], pos[4 * p + 2] - cpu.z[p]);
      d2 += d * d;
      dmax = Math.max(dmax, d);
      dv2 +=
        (vel[4 * p] - cpu.vx[p]) ** 2 + (vel[4 * p + 1] - cpu.vy[p]) ** 2 + (vel[4 * p + 2] - cpu.vz[p]) ** 2;
      v2 += cpu.vx[p] ** 2 + cpu.vy[p] ** 2 + cpu.vz[p] ** 2;
    }
    const c = Math.max(1, counted);
    return {
      steps: cpu.steps,
      simulatedSeconds: cpu.time,
      parcels: n,
      rmsPositionCells: Math.sqrt(d2 / c) / cfg.h,
      maxPositionCells: dmax / cfg.h,
      relativeVelocityRms: v2 > 0 ? Math.sqrt(dv2 / v2) : Math.sqrt(dv2 / c),
      statusMismatches: mism,
      cpu: cpu.diagnostics(),
      gpu: gpu.diagnostics(),
    };
  } finally {
    gpu.destroy();
  }
}

export interface PourRun {
  cellMm: number;
  parcelsHalfPot: number;
  grid: [number, number, number];
  simulatedSeconds: number;
  steps: number;
  dischargedMl: number;
  spilledMl: number;
  lostMl: number;
  dischargedFractions: number[] | null;
  pressureFailures: number;
  maxPressureIterations: number;
  maxDivergence: number;
  interiorDensity: number;
  wallSeconds: number;
  /** Simulated seconds per wall-clock second (1 = real time). */
  realTimeFactor: number;
}

/**
 * The gentle 400 mL pour on the GPU until 1.5 s after the pot is back upright (as benchmarks/run3d.ts).
 * `onProgress` receives diagnostics about every half simulated second.
 */
export async function runPour(
  device: GPUDevice,
  cellMm: number,
  seconds = 20,
  onProgress?: (d: Diagnostics3D) => void,
): Promise<PourRun> {
  const sim = new GpuSimulation3D(device, gentlePour3D(cellMm, seconds));
  try {
    const t0 = performance.now();
    let doneAt = -1;
    let maxIt = 0;
    let maxDiv = 0;
    while (!sim.finished) {
      const target = sim.time + 0.5;
      while (sim.time < target - 1e-12 && !sim.finished) {
        await sim.step();
        maxIt = Math.max(maxIt, sim.stats.pressureIterations);
        maxDiv = Math.max(maxDiv, sim.stats.maxDivergence);
      }
      const d = sim.diagnostics();
      onProgress?.(d);
      if (d.phase === 'done' && doneAt < 0) doneAt = d.time;
      if (doneAt >= 0 && d.time > doneAt + 1.5) break;
    }
    const wall = (performance.now() - t0) / 1000;
    const d = sim.diagnostics();
    return {
      cellMm,
      parcelsHalfPot: sim.n,
      grid: d.grid,
      simulatedSeconds: d.time,
      steps: d.steps,
      dischargedMl: d.dischargedMl,
      spilledMl: d.spilledMl,
      lostMl: d.lostMl,
      dischargedFractions: sim.dischargedFractions(),
      pressureFailures: d.pressureFailures,
      maxPressureIterations: maxIt,
      maxDivergence: maxDiv,
      interiorDensity: d.interiorDensity,
      wallSeconds: wall,
      realTimeFactor: d.time / wall,
    };
  } finally {
    sim.destroy();
  }
}
