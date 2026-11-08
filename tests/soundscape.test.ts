// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { describe, expect, it } from 'vitest';
import { Soundscape, pourIntensity, type AudioCtxLike } from '../src/audio/soundscape';
import { fakeAudio } from './helpers';

describe('pour intensity', () => {
  it('is silent without flow and saturates for heavy pours', () => {
    expect(pourIntensity(0)).toBe(0);
    expect(pourIntensity(NaN)).toBe(0);
    expect(pourIntensity(-50)).toBe(0);
    expect(pourIntensity(150)).toBeCloseTo(0.5, 6);
    expect(pourIntensity(5000)).toBe(1);
  });
});

describe('Soundscape', () => {
  it('builds the ambience once, resumes the context, and follows volume and pour level', async () => {
    const a = fakeAudio();
    const s = new Soundscape(() => a as unknown as AudioCtxLike);
    expect(s.enabled).toBe(false);
    s.setPourIntensity(1); // ignored while off
    expect(a.log).toHaveLength(0);
    expect(await s.enable()).toBe(true);
    expect(a.log).toContain('resume');
    const starts = a.log.filter((l) => l.startsWith('start')).length;
    expect(starts).toBeGreaterThan(5); // drones, LFOs, wind, shimmer, pour
    expect(a.log.at(-1)).toBe('gain.gain->0.300'); // master fades in to volume * 0.5
    s.setPourIntensity(2);
    expect(s.intensity).toBe(1);
    expect(a.log.at(-1)).toBe('gain.gain->0.900');
    s.setVolume(0.2);
    expect(a.log.at(-1)).toBe('gain.gain->0.100');
    await s.disable();
    expect(s.enabled).toBe(false);
    expect(s.intensity).toBe(0);
    await s.enable(); // second enable reuses the graph
    expect(a.log.filter((l) => l.startsWith('start')).length).toBe(starts);
  });

  it('does not hang when the audio device never starts (headless browsers)', async () => {
    const a = fakeAudio();
    a.resume = () => new Promise<void>(() => {});
    const s = new Soundscape(() => a as unknown as AudioCtxLike);
    expect(await s.enable()).toBe(true);
    expect(s.enabled).toBe(true);
  });

  it('reports missing Web Audio support', async () => {
    const s = new Soundscape(() => null);
    expect(await s.enable()).toBe(false);
    await s.disable(); // harmless without a context
    s.setVolume(5);
    expect(s.volume).toBe(1);
  });
});
