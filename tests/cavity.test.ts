// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { DE_VAHL_DAVIS_NU, cavityConfig, presetById } from '../src/sim/config';
import { Simulation } from '../src/sim/solver';
import { buildVessel, vesselSdf } from '../src/sim/vessel';

describe('differentially heated cavity (thermal verification)', () => {
  it('is a closed, completely filled box', () => {
    const cfg = cavityConfig(1e3, 24);
    const v = buildVessel(cfg.vessel);
    expect(v.outflow).toBeNull();
    // Lid present: the point just above the inner top is inside the wall.
    expect(vesselSdf(v, 0.05, 0.1 + 0.005)).toBeLessThan(0);
    const sim = new Simulation(cfg);
    expect(sim.diagnostics().fluidCells).toBeGreaterThan(20 * 20);
    expect(presetById('thermal-cavity').build().vessel.kind).toBe('cavity');
  });

  it('limits the time step for explicit viscosity and heat diffusion', () => {
    const cfg = cavityConfig(1e3, 24);
    const sim = new Simulation(cfg);
    const h = sim.h;
    expect(sim.stableDt()).toBeLessThanOrEqual((0.2 * h * h) / cfg.thermalDiffusivity + 1e-15);
    expect(sim.stableDt()).toBeLessThanOrEqual((0.2 * h * h) / cfg.kinematicViscosity + 1e-15);
  });

  it('Ra = 1e3 reaches the de Vahl Davis Nusselt number within 10 % and conserves heat', () => {
    const sim = new Simulation(cavityConfig(1e3, 24));
    expect(sim.wallNusselt()).not.toBeNull();
    sim.advance(20);
    const nu = sim.wallNusselt()!;
    const ref = DE_VAHL_DAVIS_NU[1e3];
    expect(Math.abs((nu.hot + nu.cold) / 2 - ref) / ref).toBeLessThan(0.1);
    // Steady state: what enters at the hot wall leaves at the cold wall.
    expect(Math.abs(nu.hot - nu.cold) / ref).toBeLessThan(0.1);
    const d = sim.diagnostics();
    expect(Math.abs(d.thermalInventoryError)).toBeLessThan(0.01);
    expect(d.pressureFailures).toBe(0);
    // Hot wall on the left: the liquid circulates clockwise (rises at the hot wall).
    let leftUp = 0;
    for (let p = 0; p < sim.n; p++) if (sim.x0[p] < 0.02) leftUp += sim.vy[p];
    expect(leftUp).toBeGreaterThan(0);
  });

  it('no Nusselt number without fixed-temperature walls', () => {
    const cfg = cavityConfig(1e3, 24);
    cfg.thermal.hotWallTemperature = undefined;
    expect(new Simulation(cfg).wallNusselt()).toBeNull();
    const off = cavityConfig(1e3, 24);
    off.thermal.mode = 'off';
    expect(new Simulation(off).wallNusselt()).toBeNull();
  });

  it('no-slip walls slow the liquid next to a wall compared with free-slip', () => {
    const run = (wall: 'no-slip' | 'free-slip') => {
      const cfg = cavityConfig(1e4, 24);
      cfg.wallTreatment = wall;
      const sim = new Simulation(cfg);
      sim.advance(3);
      let near = 0;
      for (let p = 0; p < sim.n; p++) if (sim.x0[p] < 0.004 && sim.y[p] > 0.03) near += Math.abs(sim.vy[p]);
      return near;
    };
    expect(run('no-slip')).toBeLessThan(run('free-slip'));
  });
});
