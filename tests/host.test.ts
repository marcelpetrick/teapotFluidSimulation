// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { MAX_SIM_PER_FRAME, SimulationHost, velocityArrows, type FromWorker } from '../src/worker/host';
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
    // Not running: frames do not advance time.
    let f = only(h.handle({ type: 'frame', wallDt: 0.05 }), 'frame');
    expect(f.diagnostics.time).toBe(0);
    expect(f.metrics).not.toBeNull();
    h.handle({ type: 'speed', value: 100 });
    expect(h.speed).toBe(4);
    h.handle({ type: 'play' });
    f = only(h.handle({ type: 'frame', wallDt: 1 }), 'frame');
    expect(f.diagnostics.time).toBeCloseTo(MAX_SIM_PER_FRAME, 9);
    expect(f.running).toBe(true);
    expect(f.realtimeFactor).toBeLessThan(1);
    expect(f.arrows.length % 4).toBe(0);
    h.handle({ type: 'pause' });
    expect(h.running).toBe(false);
    const s = only(h.handle({ type: 'step' }), 'frame');
    expect(s.diagnostics.time).toBeCloseTo(MAX_SIM_PER_FRAME + 1 / 60, 9);
    h.handle({ type: 'play' });
    for (let k = 0; k < 20 && h.running; k++) h.handle({ type: 'frame', wallDt: 0.1 });
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
    expect(only(weird.handle({ type: 'frame', wallDt: 0.02 }), 'error').message).toBe('boom');
  });

  it('velocity arrows sample liquid cells', () => {
    const h = new SimulationHost('t');
    h.handle({ type: 'init', config: cfgFor('tank-rest') });
    expect(velocityArrows(h.sim!, 3).length).toBeGreaterThan(40);
  });
});
