// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Experiment records (JSON) and CSV exports, plus the visible list of model limitations.

import { dischargeBins, mixingReport, originComposition, regionMatrix, summarize } from './metrics';
import { SOLVER_VERSION, type Simulation } from './solver';
import type { ExperimentConfig } from './types';

export const RECORD_SCHEMA_VERSION = 1;

export const BAND_NAMES_3 = ['bottom', 'middle', 'top'];

export function bandNames(k: number): string[] {
  if (k === 3) return BAND_NAMES_3;
  return Array.from({ length: k }, (_, i) => `band ${i + 1}`);
}

/** Model limitations active for a run; shown beside results and stored in every record. */
export function modelLimitations(cfg: ExperimentConfig): string[] {
  const lim = [
    '2D cross-section: liquid cannot flow around the sides of the pot; volumes are 2D-equivalent (constant effective depth).',
    'Generic labelled vessel geometry, not a measured teapot; the 2D spout is far wider than a real spout so flow rates are not real-vessel predictions.',
    'Uniform-density liquid unless thermal coupling is on; constant water properties at 70 degC.',
    'No boiling, evaporation, tea extraction, air dynamics (open vent assumed), lid, surface tension, wetting or drips; no tea bag.',
    'Walls are free-slip and voxelised on the pressure grid (stair-stepped); wall boundary layers are not resolved.',
    'The receiving glass is an accounting display only; liquid in it is not simulated.',
    `Numerical stabilisation: PIC/FLIP blend ${cfg.transfer === 'flip' ? cfg.flipRatio.toFixed(2) : '(APIC)'}, position-only density correction ${cfg.densityCorrection}; both can move parcels and are logged.`,
    'Not validated against measurements; results are a qualitative instrument, not a calibrated digital twin.',
  ];
  if (cfg.thermal.mode === 'passive')
    lim.push('Temperature is carried passively and does NOT affect the motion.');
  if (cfg.thermal.mode === 'coupled')
    lim.push(
      'Boussinesq buoyancy with linear expansion; cooling uses prescribed heat-transfer coefficients on cell faces (front/back walls ignored).',
    );
  return lim;
}

export interface ExperimentRecord {
  schemaVersion: number;
  solverVersion: string;
  appVersion: string;
  createdAt: string;
  config: ExperimentConfig;
  derived: {
    cellSize: number;
    gridNx: number;
    gridNy: number;
    effectiveDepth: number;
    parcelVolume: number;
    parcels: number;
  };
  motionEvents: { time: number; phase: string; angleDeg: number; dischargedMl: number }[];
  /** Manual mode: every tilt the user asked for, with the simulated time (reproducible input history). */
  manualInputs: { time: number; targetDeg: number }[];
  diagnostics: ReturnType<Simulation['diagnostics']>;
  composition: ReturnType<typeof originComposition>;
  bins: ReturnType<typeof dischargeBins>;
  regionMatrix: ReturnType<typeof regionMatrix>;
  mixing: ReturnType<typeof mixingReport>;
  summary: string[];
  history: Simulation['history'];
  limitations: string[];
  provenance: string;
}

export function buildRecord(sim: Simulation, appVersion: string, now = new Date()): ExperimentRecord {
  const names = bandNames(sim.initialBandCounts.length);
  const comp = originComposition(sim);
  const mix = mixingReport(sim);
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    solverVersion: SOLVER_VERSION,
    appVersion,
    createdAt: now.toISOString(),
    config: sim.cfg,
    derived: {
      cellSize: sim.h,
      gridNx: sim.nx,
      gridNy: sim.ny,
      effectiveDepth: sim.depth,
      parcelVolume: sim.parcelVolume,
      parcels: sim.n,
    },
    motionEvents: sim.controller.events.map((e) => ({
      time: e.time,
      phase: e.phase,
      angleDeg: e.angleDeg,
      dischargedMl: e.discharged * 1e6,
    })),
    manualInputs: sim.controller.inputs.slice(),
    diagnostics: sim.diagnostics(),
    composition: comp,
    bins: dischargeBins(sim),
    regionMatrix: regionMatrix(sim, names),
    mixing: mix,
    summary: summarize(comp, mix, names, sim.cfg.motion.targetVolume * 1e6),
    history: sim.history,
    limitations: modelLimitations(sim.cfg),
    provenance:
      'PourLab browser simulation (2D PIC/FLIP or APIC, MAC grid, PCG pressure). Deterministic for identical code, configuration and seed.',
  };
}

function csvRow(cells: (string | number | null)[]): string {
  return cells
    .map((c) => (c === null ? '' : typeof c === 'number' ? String(c) : `"${c.replace(/"/g, '""')}"`))
    .join(',');
}

/** CSV of the time history plus discharge bins, separated by a blank line. */
export function recordToCsv(r: ExperimentRecord): string {
  const names = bandNames(r.composition.initialFractions.length);
  const lines: string[] = [];
  lines.push(
    csvRow([
      'time_s',
      'angle_deg',
      'in_pot_mL',
      'discharged_mL',
      'spilled_mL',
      'lost_mL',
      'max_div_per_s',
      'pressure_residual_per_s',
      'pressure_iterations',
      'kinetic_energy_J',
      'represented_drift',
      'mean_temperature_K',
    ]),
  );
  for (const h of r.history)
    lines.push(
      csvRow([
        h.time,
        h.angleDeg,
        h.inPot * 1e6,
        h.discharged * 1e6,
        h.spilled * 1e6,
        h.lost * 1e6,
        h.divergenceAfter,
        h.pressureResidual,
        h.pressureIterations,
        h.kineticEnergy,
        h.representedDrift,
        h.meanTemperature,
      ]),
    );
  lines.push('');
  lines.push(csvRow(['bin_from_mL', 'bin_to_mL', 'partial', ...names.map((n) => `${n}_mL`)]));
  for (const b of r.bins)
    lines.push(
      csvRow([b.from * 1e6, b.to * 1e6, b.partial ? 'yes' : 'no', ...b.byOrigin.map((v) => v * 1e6)]),
    );
  return lines.join('\n') + '\n';
}
