// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { presetById } from '../src/sim/config';
import type { ExperimentConfig } from '../src/sim/types';

/** A preset at reduced cost: shorter duration, optional resolution override. */
export function cfgFor(id: string, mutate?: (c: ExperimentConfig) => void): ExperimentConfig {
  const c = presetById(id).build();
  mutate?.(c);
  return c;
}

/** Recording fake of the subset of CanvasRenderingContext2D used by the renderer. */
export function fakeCtx() {
  const calls: string[] = [];
  const rec = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    stroke: rec('stroke'),
    fill: rec('fill'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    arc: rec('arc'),
    fillText: rec('fillText'),
    setLineDash: rec('setLineDash'),
    clearRect: rec('clearRect'),
    closePath: rec('closePath'),
    fillStyle: '' as string,
    strokeStyle: '' as string,
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
  };
}

/** Recording fake of the Web Audio API subset used by the soundscape. */
export function fakeAudio() {
  const log: string[] = [];
  const param = (name: string, value = 0) => ({
    value,
    setTargetAtTime: (v: number) => log.push(`${name}->${v.toFixed(3)}`),
    cancelScheduledValues: () => {},
  });
  const node = (kind: string) => ({
    kind,
    connect: () => {},
    start: () => log.push(`start ${kind}`),
    gain: param(`${kind}.gain`, 1),
    frequency: param(`${kind}.frequency`),
    detune: param(`${kind}.detune`),
    Q: param(`${kind}.Q`),
    type: '',
    buffer: null as unknown,
    loop: false,
  });
  const ctx = {
    log,
    currentTime: 0,
    sampleRate: 8000,
    destination: node('destination'),
    state: 'suspended',
    createGain: () => node('gain'),
    createOscillator: () => node('osc'),
    createBiquadFilter: () => node('filter'),
    createBufferSource: () => node('source'),
    createBuffer: (_c: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    },
    resume: async () => {
      ctx.state = 'running';
      log.push('resume');
    },
    suspend: async () => {
      ctx.state = 'suspended';
    },
  };
  return ctx;
}
