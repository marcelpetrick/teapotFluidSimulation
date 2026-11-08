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
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
  };
}
