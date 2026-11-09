// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import {
  bandNames,
  buildRecord,
  temperatureStatistics,
  modelLimitations,
  recordToCsv,
  RECORD_SCHEMA_VERSION,
} from '../src/sim/experiment';
import { Simulation, SOLVER_VERSION } from '../src/sim/solver';
import { cfgFor } from './helpers';

describe('experiment record', () => {
  it('contains everything needed to reproduce and judge the run', () => {
    const sim = new Simulation(cfgFor('tank-tilt'));
    sim.advance(0.5);
    const r = buildRecord(sim, '9.9.9', new Date('2026-01-01T00:00:00Z'));
    expect(r.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(r.solverVersion).toBe(SOLVER_VERSION);
    expect(r.appVersion).toBe('9.9.9');
    expect(r.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(r.config.seed).toBe(1);
    expect(r.derived.parcels).toBe(sim.n);
    expect(r.motionEvents[0].phase).toBe('tilt-in');
    expect(r.limitations.length).toBeGreaterThan(5);
    expect(r.history.length).toBeGreaterThan(5);
    expect(r.regionMatrix.columns).toContain('discharged');
    expect(JSON.parse(JSON.stringify(r)).config.vessel.kind).toBe('tank');
    const csv = recordToCsv(r);
    const lines = csv.split('\n');
    expect(lines[0]).toMatch(/^"time_s","angle_deg"/);
    expect(lines.length).toBeGreaterThan(r.history.length + 2);
    expect(csv).toContain('"bin_from_mL"');
  });

  it('CSV quotes text and writes empty cells for null', () => {
    const sim = new Simulation(cfgFor('teapot-gentle', (c) => (c.duration = 4)));
    while (!sim.finished) sim.advance(0.5);
    const r = buildRecord(sim, '1');
    const csv = recordToCsv(r);
    expect(csv).toMatch(/,"(yes|no)",/);
  });

  it('limitations follow the thermal mode', () => {
    const c = cfgFor('teapot-gentle');
    expect(modelLimitations(c).join()).not.toMatch(/Boussinesq/);
    c.thermal.mode = 'passive';
    expect(modelLimitations(c).join()).toMatch(/does NOT affect the motion/);
    c.thermal.mode = 'coupled';
    c.transfer = 'apic';
    expect(modelLimitations(c).join()).toMatch(/Boussinesq/);
    expect(modelLimitations(c).join()).toMatch(/APIC/);
  });

  it('band names', () => {
    expect(bandNames(3)).toEqual(['bottom', 'middle', 'top']);
    expect(bandNames(2)).toEqual(['band 1', 'band 2']);
  });
});

describe('temperature inventory moments', () => {
  it('separates remaining-liquid variance from all retained parcel records', () => {
    const sim = new Simulation(cfgFor('thermal-stratified'));
    sim.temperature.fill(300);
    sim.temperature[0] = 310;
    sim.temperature[1] = 290;
    sim.status[0] = sim.status[1] = 1;
    const record = buildRecord(sim, 'test');
    expect(record.temperatureStatistics!.remaining.meanK).toBe(300);
    expect(record.temperatureStatistics!.remaining.varianceK2).toBe(0);
    expect(record.temperatureStatistics!.allParcels.meanK).toBe(300);
    expect(record.temperatureStatistics!.allParcels.varianceK2).toBeCloseTo(200 / sim.n, 12);
    sim.status.fill(1);
    expect(temperatureStatistics(sim, true)).toEqual({ volume: 0, meanK: null, varianceK2: null });
  });
});
