// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { MAX_DEBT, SimulationHost, velocityArrows, type FromWorker } from '../src/worker/host';
import { cfgFor } from './helpers';

function only<T extends FromWorker['type']>(out: FromWorker[], type: T): Extract<FromWorker, { type: T }> {
  expect(out).toHaveLength(1);
  expect(out[0].type).toBe(type);
  return out[0] as Extract<FromWorker, { type: T }>;
}

describe('worker host', () => {
  it('requires init', () => {
    const h = new SimulationHost('t');
    expect(only(h.handle({ type: 'play' }), 'error').message).toMatch(/not initialised/);
  });

  it('init, play, bounded frames, pause, step, speed, export', () => {
    const h = new SimulationHost('t');
    const ready = only(
      h.handle({ type: 'init', config: cfgFor('tank-tilt', (c) => (c.duration = 0.3)) }),
      'ready',
    );
    expect(ready.info.n).toBeGreaterThan(1000);
    expect(ready.info.bandNames).toEqual(['bottom', 'middle', 'top']);
    // Not running: pumping and frames do not advance time.
    h.pump(0);
    h.pump(1000);
    let f = only(h.handle({ type: 'frame' }), 'frame');
    expect(f.diagnostics.time).toBe(0);
    expect(f.metrics).not.toBeNull();
    h.handle({ type: 'speed', value: 100 });
    expect(h.speed).toBe(4);
    h.handle({ type: 'speed', value: 1 });
    h.handle({ type: 'play' });
    // 20 ms of wall time with an unlimited budget advances exactly 20 ms of simulated time.
    h.pump(1020, Infinity);
    f = only(h.handle({ type: 'frame' }), 'frame');
    expect(f.diagnostics.time).toBeGreaterThanOrEqual(0.02 - 1e-12);
    expect(f.diagnostics.time).toBeLessThan(0.02 + h.sim!.cfg.maxSubstep + 1e-9);
    expect(f.running).toBe(true);
    expect(f.arrows.length % 4).toBe(0);
    // A long stall is capped (time debt bounded), and a zero budget achieves nothing: realtime drops.
    let fake = 0;
    h.pump(6020, 0, () => fake++);
    expect(h.realtime).toBeLessThan(1);
    h.pump(6021, Infinity);
    expect(h.sim!.time).toBeLessThanOrEqual(0.02 + MAX_DEBT + 2 * h.sim!.cfg.maxSubstep + 1e-9);
    h.handle({ type: 'pause' });
    expect(h.running).toBe(false);
    const before = h.sim!.time;
    const s = only(h.handle({ type: 'step' }), 'frame');
    expect(s.diagnostics.time).toBeGreaterThanOrEqual(before + 1 / 60 - 1e-12);
    h.handle({ type: 'play' });
    for (let k = 0; k < 400 && h.running; k++) h.pump(7000 + k * 50, Infinity);
    expect(h.running).toBe(false);
    expect(h.sim!.finished).toBe(true);
    h.handle({ type: 'play' });
    expect(h.running).toBe(false); // finished runs do not restart
    const e = only(h.handle({ type: 'export' }), 'export');
    expect(JSON.parse(e.json).schemaVersion).toBe(1);
    expect(e.csv).toContain('time_s');
    expect(e.fileStem).toMatch(/^pourlab-tank-tilt-seed1-t0\.3$/);
  });

  it('reports solver errors as messages', () => {
    const h = new SimulationHost('t');
    const out = h.handle({ type: 'init', config: cfgFor('tank-rest', (c) => (c.fillHeight = 0)) });
    expect(only(out, 'error').message).toMatch(/no liquid/);
    const weird = new SimulationHost('t');
    weird.handle({ type: 'init', config: cfgFor('tank-rest') });
    (weird.sim as unknown as { advance: () => never }).advance = () => {
      throw 'boom';
    };
    weird.handle({ type: 'play' });
    weird.pump(0);
    weird.pump(20, Infinity);
    expect(weird.running).toBe(false);
    expect(only(weird.handle({ type: 'frame' }), 'error').message).toBe('boom');
    expect(only(weird.handle({ type: 'frame' }), 'frame').type).toBe('frame');
    // A failure from a previous experiment is not reported after a reset.
    weird.handle({ type: 'play' });
    weird.pump(40);
    weird.pump(60, Infinity);
    weird.handle({ type: 'init', config: cfgFor('tank-rest') });
    expect(only(weird.handle({ type: 'frame' }), 'frame').type).toBe('frame');
    const thrower = new SimulationHost('t');
    thrower.handle({ type: 'init', config: cfgFor('tank-rest') });
    (thrower.sim as unknown as { advance: () => never }).advance = () => {
      throw new Error('kaboom');
    };
    expect(only(thrower.handle({ type: 'step' }), 'error').message).toBe('kaboom');
  });

  it('velocity arrows sample liquid cells', () => {
    const h = new SimulationHost('t');
    h.handle({ type: 'init', config: cfgFor('tank-rest') });
    expect(velocityArrows(h.sim!, 3).length).toBeGreaterThan(40);
  });
});
