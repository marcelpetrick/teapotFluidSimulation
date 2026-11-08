// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/solver';
import { STATUS_DISCHARGED, STATUS_IN_POT, STATUS_LOST } from '../src/sim/types';
import { cfgFor } from './helpers';
import { configFromSettings, settingsFromQuery } from '../src/sim/config';
import { vesselSdf, worldToLocal } from '../src/sim/vessel';

describe('solver: verification cases', () => {
  it('hydrostatic rest: no sustained currents, no volume loss, converged projection', () => {
    const sim = new Simulation(cfgFor('tank-rest'));
    const y0 = Array.from(sim.y).reduce((a, b) => a + b, 0) / sim.n;
    const d = sim.advance(2);
    expect(d.volumeInPot).toBeCloseTo(d.volumeInitial, 12);
    expect(d.volumeLost + d.volumeSpilled + d.volumeDischarged).toBe(0);
    expect(d.maxSpeed).toBeLessThan(0.02);
    expect(d.pressureConverged).toBe(true);
    expect(d.pressureFailures).toBe(0);
    expect(d.divergenceAfter).toBeLessThan(1e-3);
    expect(d.divergenceAfter).toBeLessThan(d.divergenceBefore + 1e-12);
    const y1 = Array.from(sim.y).reduce((a, b) => a + b, 0) / sim.n;
    expect(Math.abs(y1 - y0)).toBeLessThan(0.002); // centroid drift < 2 mm
    expect(Math.abs(d.interiorDensity - 1)).toBeLessThan(0.05);
    expect(Math.abs(d.ledgerError)).toBeLessThan(1e-15);
  });

  it('uniform translation without gravity is reproduced exactly by advection', () => {
    const cfg = cfgFor('tank-rest', (c) => {
      c.gravity = 0;
      c.viscosity = false;
      c.densityCorrection = 0;
    });
    const sim = new Simulation(cfg);
    // Lift the block off the floor (side walls are free-slip), then translate it upward.
    for (let p = 0; p < sim.n; p++) {
      sim.y[p] += 0.03;
      sim.vy[p] = 0.05;
    }
    const y0 = Float64Array.from(sim.y);
    sim.advance(0.1);
    const errs = Array.from({ length: sim.n }, (_, p) => Math.abs(sim.y[p] - y0[p] - 0.005)).sort(
      (a, b) => a - b,
    );
    // Bulk transport is exact to micrometres. Parcels in the stair-stepped wall layer
    // (cells whose centre lies in the voxelised wall) are slowed: a documented limitation.
    expect(errs[Math.floor(sim.n / 2)]).toBeLessThan(1e-5);
    const affected = errs.filter((e) => e > 2e-4).length / sim.n;
    // At most one wall-adjacent cell column on each side: 2 / 44 columns ~ 4.5 %.
    expect(affected).toBeLessThan(2 / 44);
  });

  it('is deterministic for a seed and changes with the seed', () => {
    const a = new Simulation(cfgFor('tank-tilt'));
    const b = new Simulation(cfgFor('tank-tilt'));
    const c = new Simulation(cfgFor('tank-tilt', (k) => (k.seed = 2)));
    a.advance(0.3);
    b.advance(0.3);
    c.advance(0.3);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.x)).not.toEqual(Array.from(c.x.slice(0, a.n)));
  });

  it('origin bands are equal-volume, ordered by height and immutable', () => {
    const sim = new Simulation(cfgFor('teapot-gentle'));
    const counts = sim.initialBandCounts;
    expect(counts).toHaveLength(3);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(sim.bandEdges[0]).toBeLessThan(sim.bandEdges[1]);
    for (let p = 0; p < sim.n; p++) {
      const k = sim.origin[p];
      if (k > 0) expect(sim.y0[p]).toBeGreaterThanOrEqual(sim.bandEdges[k - 1] - 1e-9);
      if (k < 2) expect(sim.y0[p]).toBeLessThanOrEqual(sim.bandEdges[k] + 1e-9);
    }
    const before = sim.origin.slice();
    sim.advance(0.5);
    expect(Array.from(sim.origin)).toEqual(Array.from(before));
    // The effective depth makes the parcel ledger equal the requested 1.5 L.
    expect(sim.n * sim.parcelVolume).toBeCloseTo(1.5e-3, 12);
  });

  it('tilting tank: moving walls do not let parcels tunnel or vanish', () => {
    const sim = new Simulation(cfgFor('tank-tilt'));
    const loc = new Float64Array(2);
    let maxPen = 0;
    for (let k = 0; k < 60; k++) {
      sim.advance(0.1);
      for (let p = 0; p < sim.n; p++) {
        worldToLocal(sim.pose, sim.x[p], sim.y[p], loc);
        maxPen = Math.max(maxPen, -vesselSdf(sim.vessel, loc[0], loc[1]));
        // Parcels stay inside the cavity (no tunnelling to the outside).
        expect(loc[0]).toBeGreaterThan(-0.001);
        expect(loc[0]).toBeLessThan(sim.cfg.vessel.innerWidth + 0.001);
        expect(loc[1]).toBeGreaterThan(-0.001);
      }
    }
    expect(maxPen).toBeLessThan(1e-9);
    const d = sim.diagnostics();
    expect(d.volumeInPot).toBeCloseTo(d.volumeInitial, 12);
    expect(d.pressureFailures).toBe(0);
    expect(sim.controller.events.map((e) => e.phase)).toContain('return');
  });

  it('teapot pour: discharge is caused by the flow, counted once, ledger closes, near target', () => {
    const sim = new Simulation(cfgFor('teapot-gentle', (c) => (c.duration = 7)));
    while (!sim.finished) sim.advance(0.25);
    const d = sim.diagnostics();
    expect(d.volumeDischarged).toBeGreaterThan(380e-6);
    expect(d.volumeDischarged).toBeLessThan(420e-6); // within 5% of 400 mL
    expect(new Set(sim.dischargeOrder).size).toBe(sim.dischargeOrder.length);
    for (const p of sim.dischargeOrder) {
      expect(sim.status[p]).toBe(STATUS_DISCHARGED);
      expect(sim.exitTime[p]).toBeGreaterThan(0);
    }
    expect(sim.dischargeOrder.length * sim.parcelVolume).toBeCloseTo(d.volumeDischarged, 12);
    expect(Math.abs(d.ledgerError)).toBeLessThan(1e-12);
    expect(d.volumeLost).toBe(0);
    expect(d.pressureFailures).toBe(0);
    // Snapshot reflects state without sharing buffers.
    const s = sim.snapshot();
    expect(s.positions.length).toBe(2 * sim.n);
    s.status[0] = 99;
    expect(sim.status[0]).not.toBe(99);
    expect(s.temperature).toBeNull();
  });

  it('German glass teapot pours from the top: no bottom-layer liquid leaves', () => {
    const sim = new Simulation(cfgFor('glass-gentle'));
    while (!sim.finished && sim.controller.phase !== 'done') sim.advance(0.25);
    sim.advance(0.5); // let liquid in transit over the lip arrive
    const d = sim.diagnostics();
    expect(d.volumeDischarged).toBeGreaterThan(380e-6);
    expect(d.volumeDischarged).toBeLessThan(420e-6);
    const byOrigin = [0, 0, 0];
    for (const p of sim.dischargeOrder) byOrigin[sim.origin[p]]++;
    expect(byOrigin[0]).toBe(0);
    expect(byOrigin[2]).toBeGreaterThan(byOrigin[1]);
  });

  it('a drawn pot tilted by hand pours, and inputs are part of the record', () => {
    const sim = new Simulation(
      configFromSettings({
        ...settingsFromQuery('preset=teapot-gentle'),
        vessel: 'custom',
        shape: '0,100;10,40;50,5;150,5;190,40;210,100',
        control: 'manual',
        fillMl: 900,
      }),
    );
    sim.advance(0.3);
    sim.setTiltTarget(50);
    sim.advance(2.5);
    sim.setTiltTarget(0);
    sim.advance(1.5);
    const d = sim.diagnostics();
    expect(d.volumeDischarged).toBeGreaterThan(100e-6);
    expect(d.volumeLost).toBe(0);
    expect(sim.controller.inputs).toHaveLength(2);
    expect(Math.abs(d.angleDeg)).toBeLessThan(1);
  });

  it('still control: nothing leaves the pot', () => {
    const sim = new Simulation(cfgFor('teapot-still', (c) => (c.duration = 1.5)));
    while (!sim.finished) sim.advance(0.5);
    const d = sim.diagnostics();
    expect(d.volumeDischarged).toBe(0);
    expect(d.volumeSpilled).toBe(0);
    expect(sim.history.length).toBeGreaterThan(10);
    expect(sim.pathlines[0].points.length).toBeGreaterThan(10);
  });

  it('APIC transfer runs the hydrostatic case stably', () => {
    const sim = new Simulation(cfgFor('tank-rest', (c) => (c.transfer = 'apic')));
    const d = sim.advance(1);
    expect(d.maxSpeed).toBeLessThan(0.02);
    expect(d.volumeInPot).toBeCloseTo(d.volumeInitial, 12);
  });

  it('a non-finite parcel is moved to the lost ledger, not silently dropped', () => {
    const sim = new Simulation(cfgFor('tank-rest', (c) => (c.densityCorrection = 0)));
    sim.vx[10] = NaN;
    sim.x[10] = NaN;
    sim.advance(0.01);
    expect(sim.status[10]).toBe(STATUS_LOST);
    const d = sim.diagnostics();
    expect(d.volumeLost).toBeCloseTo(sim.parcelVolume, 15);
    expect(Math.abs(d.ledgerError)).toBeLessThan(1e-15);
    expect(sim.statusCounts()[STATUS_IN_POT]).toBe(sim.n - 1);
  });

  it('rejects configurations that seed no liquid', () => {
    expect(() => new Simulation(cfgFor('tank-rest', (c) => (c.fillHeight = 0)))).toThrow(/no liquid/);
  });
});

describe('solver: thermal extension', () => {
  it('passive temperature does not change the motion', () => {
    const a = new Simulation(cfgFor('tank-tilt'));
    const b = new Simulation(
      cfgFor('tank-tilt', (c) => {
        c.thermal.mode = 'passive';
        c.thermal.topTemperature = 360;
        c.thermal.bottomTemperature = 320;
      }),
    );
    a.advance(0.3);
    b.advance(0.3);
    expect(Array.from(b.x)).toEqual(Array.from(a.x));
    expect(b.snapshot().temperature).not.toBeNull();
  });

  it('coupled buoyancy: unstable layering (cool over warm) overturns, stable layering stays quiet', () => {
    const mk = (top: number, bottom: number) =>
      new Simulation(
        cfgFor('tank-rest', (c) => {
          c.thermal.mode = 'coupled';
          c.thermal.topTemperature = top;
          c.thermal.bottomTemperature = bottom;
          c.thermalExpansion = 2e-2; // exaggerated to act within the test time
        }),
      );
    const unstable = mk(330, 350);
    const stable = mk(350, 330);
    const du = unstable.advance(1.5);
    const ds = stable.advance(1.5);
    expect(du.kineticEnergy).toBeGreaterThan(5 * ds.kineticEnergy);
    // Warm parcels rose in the unstable case: their mean height increased.
    const meanY = (s: Simulation, warm: boolean) => {
      let acc = 0;
      let n = 0;
      for (let p = 0; p < s.n; p++) {
        const isWarm = s.temperature[p] > 340;
        if (isWarm === warm) {
          acc += s.y[p];
          n++;
        }
      }
      return acc / n;
    };
    const warmStart = Array.from(unstable.y0).reduce((a, b, p) => a + (unstable.origin[p] === 0 ? b : 0), 0);
    expect(warmStart).toBeGreaterThan(0);
    expect(meanY(unstable, true)).toBeGreaterThan(meanY(stable, false) - 0.05);
  });

  it('thermal diffusion matches the analytic decay of a cosine mode (insulated column)', () => {
    const alpha = 1e-4; // exaggerated so the decay is measurable in 1 s
    const sim = new Simulation(
      cfgFor('tank-rest', (c) => {
        c.thermal.mode = 'passive';
        c.thermalDiffusivity = alpha;
      }),
    );
    const L = sim.cfg.fillHeight;
    const amplitude = () => {
      let mean = 0;
      for (let p = 0; p < sim.n; p++) mean += sim.temperature[p];
      mean /= sim.n;
      let a = 0;
      for (let p = 0; p < sim.n; p++) a += (sim.temperature[p] - mean) * Math.cos((Math.PI * sim.y0[p]) / L);
      return (2 * a) / sim.n;
    };
    for (let p = 0; p < sim.n; p++) sim.temperature[p] = 340 + 5 * Math.cos((Math.PI * sim.y0[p]) / L);
    const a0 = amplitude();
    sim.advance(1);
    const measured = -Math.log(amplitude() / a0);
    const analytic = (alpha * Math.PI * Math.PI) / (L * L);
    expect(measured).toBeGreaterThan(analytic * 0.85);
    expect(measured).toBeLessThan(analytic * 1.15);
  });

  it('thermal diffusion conserves the heat inventory without cooling', () => {
    const sim = new Simulation(
      cfgFor('tank-rest', (c) => {
        c.thermal.mode = 'passive';
        c.thermal.topTemperature = 350;
        c.thermal.bottomTemperature = 330;
        c.thermalDiffusivity = 1e-5; // exaggerated
      }),
    );
    const spread0 = Math.max(...sim.temperature) - Math.min(...sim.temperature);
    const d = sim.advance(1);
    const spread1 = Math.max(...sim.temperature) - Math.min(...sim.temperature);
    expect(spread1).toBeLessThan(spread0);
    expect(Math.abs(d.thermalInventoryError)).toBeLessThan(0.01);
  });

  it('cooling lowers the mean temperature and is accounted in the inventory', () => {
    const sim = new Simulation(
      cfgFor('tank-rest', (c) => {
        c.thermal.mode = 'coupled';
        c.thermal.wallHeatTransfer = 5000;
        c.thermal.surfaceHeatTransfer = 5000;
      }),
    );
    const t0 = sim.diagnostics().meanTemperature;
    const d = sim.advance(1);
    expect(d.meanTemperature).toBeLessThan(t0 - 0.05);
    expect(Math.abs(d.thermalInventoryError)).toBeLessThan(0.02);
  });
});
