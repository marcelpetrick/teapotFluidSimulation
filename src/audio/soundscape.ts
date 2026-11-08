// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Procedural soundscape with the Web Audio API - no audio files.
//  - Ambience: three slightly detuned low drones through a slowly breathing low-pass filter,
//    filtered "space wind" noise and a faint high shimmer with tremolo.
//  - Pouring: band-passed noise whose level follows the measured discharge rate, with a wobbling
//    filter for a bubbling, liquid character. Silent when nothing pours.
// Sound is off until the user turns it on (browsers require a user gesture anyway).

/** Minimal subset of AudioContext used here (lets tests inject a fake). */
export interface AudioCtxLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNode;
  state: string;
  createGain(): GainNode;
  createOscillator(): OscillatorNode;
  createBiquadFilter(): BiquadFilterNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  resume(): Promise<void>;
  suspend(): Promise<void>;
}

export type AudioFactory = () => AudioCtxLike | null;

/** Pour level (0..1) from a discharge rate in mL per simulated second. */
export function pourIntensity(mlPerSecond: number): number {
  if (!(mlPerSecond > 1)) return 0;
  // Perceptual curve: quiet trickles are audible, heavy pours saturate.
  return Math.min(1, Math.sqrt(mlPerSecond / 600));
}

export class Soundscape {
  private ctx: AudioCtxLike | null = null;
  private master: GainNode | null = null;
  private pourGain: GainNode | null = null;
  private started = false;
  enabled = false;
  volume = 0.6;
  intensity = 0;

  constructor(private factory: AudioFactory) {}

  /** Turn sound on (creates the graph on first use). Returns false if Web Audio is unavailable. */
  async enable(): Promise<boolean> {
    if (!this.ctx) {
      this.ctx = this.factory();
      if (!this.ctx) return false;
    }
    if (!this.started) this.build();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.enabled = true;
    this.ramp(this.master!, this.volume * 0.5, 1.5);
    return true;
  }

  async disable(): Promise<void> {
    this.enabled = false;
    if (!this.ctx || !this.master) return;
    this.ramp(this.master, 0, 0.4);
    this.ramp(this.pourGain!, 0, 0.2);
    this.intensity = 0;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.enabled && this.master) this.ramp(this.master, this.volume * 0.5, 0.2);
  }

  /** Set the pouring loudness (0..1); smoothed so the sound follows the flow without clicks. */
  setPourIntensity(level: number): void {
    const l = Math.max(0, Math.min(1, level));
    this.intensity = l;
    if (this.enabled && this.pourGain) this.ramp(this.pourGain, 0.9 * l, 0.15);
  }

  private ramp(g: GainNode, value: number, seconds: number): void {
    const t = this.ctx!.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(value, t, seconds / 3);
  }

  private noiseBuffer(seconds: number, brown: boolean): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = seed / 2147483648 - 1;
      if (brown) {
        last = (last + 0.02 * white) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = white;
    }
    return buf;
  }

  private lfo(freq: number, depth: number, target: AudioParam): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g);
    g.connect(target);
    o.start();
  }

  private build(): void {
    const ctx = this.ctx!;
    this.started = true;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this.master = master;

    // Drones: low, detuned, slowly breathing filter.
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 420;
    droneFilter.Q.value = 6;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.16;
    droneFilter.connect(droneGain);
    droneGain.connect(master);
    for (const [f, type] of [
      [55, 'sawtooth'],
      [82.6, 'triangle'],
      [110.4, 'sawtooth'],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = (f % 7) - 3;
      o.connect(droneFilter);
      o.start();
    }
    this.lfo(0.05, 260, droneFilter.frequency);

    // Space wind: brown noise through a wandering band-pass.
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuffer(6, true);
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 500;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.35;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);
    this.lfo(0.031, 300, windFilter.frequency);
    wind.start();

    // Shimmer: a faint high tone with slow tremolo.
    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.value = 1318.5;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.012;
    shimmer.connect(shimmerGain);
    shimmerGain.connect(master);
    this.lfo(0.17, 0.01, shimmerGain.gain);
    shimmer.start();

    // Pouring: white noise, band-passed and wobbling for a liquid, bubbling character.
    const pour = ctx.createBufferSource();
    pour.buffer = this.noiseBuffer(3, false);
    pour.loop = true;
    const pourBand = ctx.createBiquadFilter();
    pourBand.type = 'bandpass';
    pourBand.frequency.value = 900;
    pourBand.Q.value = 1.4;
    const pourLow = ctx.createBiquadFilter();
    pourLow.type = 'lowpass';
    pourLow.frequency.value = 2600;
    const pourGain = ctx.createGain();
    pourGain.gain.value = 0;
    pour.connect(pourBand);
    pourBand.connect(pourLow);
    pourLow.connect(pourGain);
    pourGain.connect(master);
    this.lfo(7.3, 380, pourBand.frequency);
    this.lfo(2.1, 150, pourBand.frequency);
    pour.start();
    this.pourGain = pourGain;
  }
}
