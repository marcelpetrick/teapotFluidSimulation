// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick

import { defaultMotion, ML } from '../sim/config';
import type { Config3D } from './solver3d';
import { defaultTeapot3D } from './vessel3d';

/** The gentle 400 mL pour of the 2D main scenario, in 3D (same motion, controller and fill). */
export function gentlePour3D(cellMm: number, seconds: number): Config3D {
  return {
    teapot: defaultTeapot3D(),
    h: cellMm / 1000,
    initialVolume: 1500 * ML,
    motion: { ...defaultMotion(), maxHold: 20 },
    pivot: [0, 0.06],
    gravity: 9.81,
    flipRatio: 0.95,
    densityCorrection: 0.3,
    cfl: 0.8,
    maxSubstep: 1 / 200,
    pressureTolerance: 1e-6,
    pressureMaxIterations: 400,
    seed: 1,
    duration: seconds,
  };
}
