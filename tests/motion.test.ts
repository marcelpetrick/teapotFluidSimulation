// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { defaultMotion } from '../src/sim/config';
import { PourController } from '../src/sim/motion';
import type { MotionConfig } from '../src/sim/types';

function run(c: MotionConfig, discharge: (t: number, angleDeg: number) => number, T = 20, dt = 0.005) {
  const ctl = new PourController(c);
  const angles: number[] = [];
  let out = 0;
  for (let t = dt; t <= T + 1e-9; t += dt) {
    angles.push(ctl.advance(t, dt, out) * (180 / Math.PI));
    out = discharge(t, ctl.angleDeg);
  }
  return { ctl, angles, dt };
}

describe('pour controller', () => {
  it('still motion never tilts', () => {
    const c = { ...defaultMotion(), kind: 'still' as const };
    const { ctl, angles } = run(c, () => 0, 3);
    expect(ctl.phase).toBe('done');
    expect(Math.max(...angles.map(Math.abs))).toBe(0);
  });

  it('pours: wait, tilt-in, hold, return near target, rest, done; motion is smooth', () => {
    const c = defaultMotion();
    // Synthetic flow: 200 mL/s whenever tilted beyond 10 deg.
    let v = 0;
    const { ctl, angles, dt } = run(c, (_t, a) => (v += a > 10 ? 200e-6 * 0.005 : 0));
    const phases = ctl.events.map((e) => e.phase);
    expect(phases).toEqual(['tilt-in', 'hold', 'return', 'rest', 'done']);
    expect(ctl.poursCompleted).toBe(1);
    const ret = ctl.events.find((e) => e.phase === 'return')!;
    expect(ret.discharged).toBeLessThan(c.targetVolume);
    expect(ret.discharged).toBeGreaterThan(c.targetVolume * 0.5);
    // Angular velocity has no jumps larger than the tilt-in peak rate allows (C1 transitions).
    let maxJump = 0;
    for (let i = 2; i < angles.length; i++) {
      const w1 = (angles[i - 1] - angles[i - 2]) / dt;
      const w2 = (angles[i] - angles[i - 1]) / dt;
      maxJump = Math.max(maxJump, Math.abs(w2 - w1));
    }
    expect(maxJump).toBeLessThan(5); // deg/s change per step
    expect(angles[angles.length - 1]).toBe(0);
    expect(Math.max(...angles)).toBeLessThanOrEqual(c.maxAngleDeg + 1e-9);
  });

  it('returns after maxHold if the target is never reached', () => {
    const c = { ...defaultMotion(), maxHold: 1 };
    const { ctl } = run(c, () => 0, 8);
    const hold = ctl.events.find((e) => e.phase === 'hold')!;
    const ret = ctl.events.find((e) => e.phase === 'return')!;
    expect(ret.time - hold.time).toBeCloseTo(1, 1);
  });

  it('target 0 holds until maxHold', () => {
    const c = { ...defaultMotion(), targetVolume: 0, maxHold: 0.5 };
    const { ctl } = run(c, () => 0, 6);
    expect(ctl.events.map((e) => e.phase)).toContain('return');
  });

  it('tilt-only motion holds for holdTime and ignores discharge', () => {
    const c = {
      ...defaultMotion(),
      kind: 'tilt' as const,
      holdAngleDeg: 10,
      maxAngleDeg: 10,
      holdTiltRate: 0,
      holdTime: 1,
    };
    const { ctl, angles } = run(c, () => 1, 8);
    expect(Math.max(...angles)).toBeCloseTo(10, 6);
    const hold = ctl.events.find((e) => e.phase === 'hold')!;
    const ret = ctl.events.find((e) => e.phase === 'return')!;
    expect(ret.time - hold.time).toBeCloseTo(1, 1);
    expect(ctl.phase).toBe('done');
  });

  it('repeated pours split the target', () => {
    const c = { ...defaultMotion(), repeats: 2 };
    expect(new PourController(c).pourTarget()).toBeCloseTo(c.targetVolume / 2);
    let v = 0;
    const { ctl } = run(c, (_t, a) => (v += a > 10 ? 200e-6 * 0.005 : 0), 30);
    expect(ctl.events.filter((e) => e.phase === 'return')).toHaveLength(2);
    expect(ctl.poursCompleted).toBe(2);
  });

  it('returns during tilt-in when flow is fast', () => {
    const c = { ...defaultMotion(), tiltDuration: 5 };
    let v = 0;
    const { ctl } = run(c, (_t, a) => (v += a > 2 ? 2000e-6 * 0.005 : 0), 10);
    expect(ctl.events[1].phase).toBe('return');
  });
});
