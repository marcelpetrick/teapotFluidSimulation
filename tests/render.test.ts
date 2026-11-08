// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { chartBox, drawBiasChart, drawBinsChart, drawTimeSeries } from '../src/render/charts';
import {
  drawArrows,
  drawGlass,
  drawInitialMap,
  drawParcels,
  drawPathlines,
  drawVessel,
  fitViewport,
  rampColour,
  temperatureColour,
  toScreen,
  type Theme,
} from '../src/render/scene';
import { SimulationHost } from '../src/worker/host';
import { STATUS_DISCHARGED } from '../src/sim/types';
import { cfgFor, fakeCtx } from './helpers';

const theme: Theme = {
  surface: '#fff',
  ink: '#000',
  muted: '#555',
  wall: '#333',
  grid: '#ddd',
  dim: '#ccc',
  arrow: '#444',
  origins: ['#0072b2', '#009e73', '#d55e00'],
};

function ready(id = 'teapot-gentle') {
  const h = new SimulationHost('t');
  const out = h.handle({ type: 'init', config: cfgFor(id) })[0];
  if (out.type !== 'ready') throw new Error('not ready');
  return { h, ...out };
}

describe('viewport and colour ramps', () => {
  it('fits and maps y up to screen y down', () => {
    const v = fitViewport(2, 1, 400, 300, 0);
    expect(v.scale).toBe(200);
    const [x0, y0] = toScreen(v, 0, 0);
    const [x1, y1] = toScreen(v, 2, 1);
    expect(x1 - x0).toBe(400);
    expect(y1).toBeLessThan(y0);
  });

  it('ramps are clamped and diverging has a neutral midpoint', () => {
    expect(rampColour(-1)).toBe(rampColour(0));
    expect(rampColour(2)).toBe(rampColour(1));
    expect(temperatureColour(0)).toBe('hsl(0 0% 60%)');
    expect(temperatureColour(-1)).toContain('215');
    expect(temperatureColour(5)).toContain('10 ');
  });
});

describe('scene drawing', () => {
  it('draws vessel, parcels in every mode, pathlines, arrows, glass, initial map', () => {
    const { info, snapshot, metrics, h } = ready();
    const ctx = fakeCtx();
    const vp = fitViewport(info.config.domainWidth, info.config.domainHeight, 800, 600);
    drawVessel(ctx, vp, info, 20, theme);
    expect(ctx.calls.filter((c) => c === 'stroke').length).toBeGreaterThanOrEqual(3); // 2 walls + section
    snapshot.status[0] = STATUS_DISCHARGED;
    for (const mode of ['origin', 'poured-map', 'speed', 'temperature'] as const)
      for (const markers of [false, true]) {
        const c = fakeCtx();
        drawParcels(
          c,
          vp,
          info,
          snapshot,
          { mode, pathlines: true, arrows: true, markers },
          theme,
          [330, 350],
        );
        expect(c.calls.length).toBeGreaterThan(info.n);
      }
    const withT = { ...snapshot, temperature: new Float32Array(info.n).fill(340) };
    drawParcels(
      fakeCtx(),
      vp,
      info,
      withT,
      { mode: 'temperature', pathlines: false, arrows: false, markers: false },
      theme,
      [330, 350],
    );
    // Off-screen removed parcels are skipped.
    const far = { ...snapshot, positions: snapshot.positions.slice() };
    far.positions[1] = -5;
    drawParcels(
      fakeCtx(),
      vp,
      info,
      far,
      { mode: 'origin', pathlines: false, arrows: false, markers: false },
      theme,
      [0, 1],
    );
    h.handle({ type: 'play' });
    for (let k = 0; k < 5; k++) h.handle({ type: 'frame', wallDt: 0.05 });
    const f = h.handle({ type: 'frame', wallDt: 0.05 })[0];
    if (f.type !== 'frame') throw new Error();
    const pc = fakeCtx();
    drawPathlines(pc, vp, info, [[0, 0], ...(f.metrics ?? metrics).pathlines], theme);
    expect(pc.calls).toContain('arc');
    const ac = fakeCtx();
    drawArrows(ac, vp, f.arrows, theme);
    expect(ac.calls.filter((c) => c === 'stroke').length).toBe(f.arrows.length / 4);
    const gc = fakeCtx();
    drawGlass(gc, 0, 0, 80, 200, 5e-4, [1e-4, 0, 2e-4], info.bandNames, theme);
    expect(gc.calls.filter((c) => c === 'fillRect').length).toBe(2);
    const mc = fakeCtx();
    drawInitialMap(mc, 300, 200, info, snapshot.status, theme);
    expect(mc.calls.filter((c) => c === 'fillRect').length).toBe(info.n + 1);
  });

  it('pitcher vessel without spout polygon and tank without section draw', () => {
    const { info } = ready('tank-rest');
    const ctx = fakeCtx();
    drawVessel(ctx, fitViewport(1, 1, 100, 100), info, 0, theme);
    expect(ctx.calls).not.toContain('setLineDash');
  });
});

describe('charts', () => {
  it('bins chart, bias chart (with and without data), time series', () => {
    const b = chartBox(300, 150);
    const c1 = fakeCtx();
    drawBinsChart(
      c1,
      b,
      [
        { from: 0, to: 5e-5, byOrigin: [3e-5, 1e-5, 1e-5], partial: false },
        { from: 5e-5, to: 7e-5, byOrigin: [2e-5, 0, 0], partial: true },
        { from: 7e-5, to: 7e-5, byOrigin: [0, 0, 0], partial: true },
      ],
      theme,
    );
    expect(c1.calls.filter((c) => c === 'fillRect').length).toBeGreaterThanOrEqual(5);
    const c2 = fakeCtx();
    drawBiasChart(c2, b, [1.5, 0.5, null], ['a', 'b', 'c'], theme);
    expect(c2.calls.filter((c) => c === 'fillText').length).toBeGreaterThanOrEqual(5);
    drawBiasChart(fakeCtx(), b, null, ['a'], theme);
    const c3 = fakeCtx();
    const hist = [0, 1, 2].map((t) => ({
      time: t,
      angleDeg: t * 10,
      inPot: 0,
      discharged: t * 1e-4,
      spilled: 0,
      lost: 0,
      divergenceAfter: 0,
      pressureResidual: 0,
      pressureIterations: 0,
      kineticEnergy: 0,
      representedDrift: 0,
      meanTemperature: 0,
    }));
    drawTimeSeries(c3, b, hist, (h) => h.discharged * 1e6, 2, 400, ' mL', theme, 400);
    drawTimeSeries(c3, b, hist, (h) => h.angleDeg, 2, 0, '', theme, null);
    expect(c3.calls).toContain('lineTo');
  });
});
