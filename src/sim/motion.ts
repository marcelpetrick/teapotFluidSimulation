// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Prescribed vessel motion with a physical return-to-upright target controller.
// The controller never removes liquid: it only decides *when* to start returning,
// based on the measured discharge so far and an estimate of liquid still in transit.

import type { MotionConfig } from './types';

export type MotionPhase = 'wait' | 'tilt-in' | 'hold' | 'return' | 'rest' | 'done' | 'manual';

const DEG = Math.PI / 180;

export interface MotionEvent {
  time: number;
  phase: MotionPhase;
  angleDeg: number;
  discharged: number;
}

export class PourController {
  readonly cfg: MotionConfig;
  phase: MotionPhase = 'wait';
  /** Current tilt in radians (positive toward the spout). */
  angle = 0;
  private phaseStart = 0;
  private startAngle = 0;
  private startRate = 0;
  private lastRate = 0;
  private pour = 0;
  private flowRate = 0;
  private lastDischarged = 0;
  readonly events: MotionEvent[] = [];
  /** Manual mode: every user input as (simulated time, requested angle in degrees). */
  readonly inputs: { time: number; targetDeg: number }[] = [];
  private target = 0;
  private manualRate = 0;

  /** Manual mode: request a tilt angle (degrees, clamped to 0..maxAngle). */
  setTarget(angleDeg: number, time: number): void {
    const a = Math.max(0, Math.min(this.cfg.maxAngleDeg, angleDeg));
    this.target = a * DEG;
    this.inputs.push({ time, targetDeg: a });
  }

  constructor(cfg: MotionConfig) {
    this.cfg = cfg;
    if (cfg.kind === 'still') this.phase = 'done';
    if (cfg.kind === 'manual') this.phase = 'manual';
  }

  /** Target cumulative discharge for the current pour. */
  pourTarget(): number {
    const reps = Math.max(1, this.cfg.repeats);
    return (this.cfg.targetVolume * (this.pour + 1)) / reps;
  }

  get poursCompleted(): number {
    return this.pour;
  }

  private enter(phase: MotionPhase, t: number, discharged: number): void {
    this.phase = phase;
    this.phaseStart = t;
    this.startAngle = this.angle;
    this.startRate = this.lastRate;
    this.events.push({ time: t, phase, angleDeg: this.angle / DEG, discharged });
  }

  /**
   * Advance the controller to time t (end of the substep) given discharge measured so far.
   * Returns the tilt angle at t. Decisions use only past measurements, so a run is deterministic.
   */
  advance(t: number, dt: number, discharged: number): number {
    const c = this.cfg;
    if (dt > 0) {
      const inst = (discharged - this.lastDischarged) / dt;
      const k = Math.min(1, dt / 0.25);
      this.flowRate += (inst - this.flowRate) * k;
    }
    this.lastDischarged = discharged;
    const prev = this.angle;
    if (this.phase === 'manual') {
      // Follow the requested angle like a hand would: first-order lag (0.15 s) with bounded
      // angular acceleration and a 90 deg/s rate limit, so the walls never jump.
      if (dt > 0) {
        const desired = Math.max(-90 * DEG, Math.min(90 * DEG, (this.target - this.angle) / 0.15));
        const maxChange = 600 * DEG * dt;
        this.manualRate += Math.max(-maxChange, Math.min(maxChange, desired - this.manualRate));
        this.angle += this.manualRate * dt;
        this.lastRate = (this.angle - prev) / dt;
      }
      return this.angle;
    }
    const hold = c.holdAngleDeg * DEG;
    const maxA = c.maxAngleDeg * DEG;

    // Phase transitions (loop allows several in one call for tiny durations).
    for (let guard = 0; guard < 4; guard++) {
      const el = t - this.phaseStart;
      if (this.phase === 'wait' && t >= c.startDelay) {
        this.enter('tilt-in', c.startDelay, discharged);
      } else if ((this.phase === 'tilt-in' || this.phase === 'hold') && this.shouldReturn(t, discharged)) {
        this.enter('return', t, discharged);
      } else if (this.phase === 'tilt-in' && el >= c.tiltDuration) {
        this.angle = hold;
        this.enter('hold', this.phaseStart + c.tiltDuration, discharged);
      } else if (this.phase === 'return' && el >= c.returnDuration) {
        this.angle = 0;
        this.pour++;
        this.enter('rest', this.phaseStart + c.returnDuration, discharged);
      } else if (this.phase === 'rest' && this.pour < Math.max(1, c.repeats) && el >= c.repeatGap) {
        this.enter('tilt-in', this.phaseStart + c.repeatGap, discharged);
      } else if (this.phase === 'rest' && this.pour >= Math.max(1, c.repeats)) {
        this.enter('done', t, discharged);
      } else break;
    }

    const el = t - this.phaseStart;
    switch (this.phase) {
      case 'tilt-in': {
        const s = Math.min(1, el / c.tiltDuration);
        this.angle = this.startAngle + (hold - this.startAngle) * 0.5 * (1 - Math.cos(Math.PI * s));
        break;
      }
      case 'hold':
        this.angle = Math.min(maxA, this.startAngle + c.holdTiltRate * DEG * el);
        break;
      case 'return': {
        // Cubic Hermite from (startAngle, startRate) to (0, 0): C1-continuous angular velocity.
        const T = c.returnDuration;
        const s = Math.min(1, el / T);
        const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
        const h10 = s ** 3 - 2 * s ** 2 + s;
        this.angle = h00 * this.startAngle + h10 * T * this.startRate;
        break;
      }
      default:
        this.angle = 0;
    }
    if (dt > 0) this.lastRate = (this.angle - prev) / dt;
    return this.angle;
  }

  private shouldReturn(t: number, discharged: number): boolean {
    const c = this.cfg;
    if (c.kind === 'tilt') {
      return this.phase === 'hold' && t - this.phaseStart >= c.holdTime;
    }
    if (this.phase === 'hold' && t - this.phaseStart >= c.maxHold) return true;
    if (c.targetVolume <= 0) return false;
    const inTransit = Math.max(0, this.flowRate) * c.anticipation * c.returnDuration;
    return discharged + inTransit >= this.pourTarget();
  }

  get angleDeg(): number {
    return this.angle / DEG;
  }
}
