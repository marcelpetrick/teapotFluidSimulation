// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Experiment presets, validation and URL (de)serialisation of user settings.

import { buildVessel, localToWorld, makePose } from './vessel';
import type { ExperimentConfig, MotionConfig, VesselConfig } from './types';

export const ML = 1e-6; // m^3 per millilitre
export const C_TO_K = 273.15;

/**
 * Reference liquid-water properties at 70 degC and 0.1 MPa (IAPWS formulations as tabulated
 * by NIST; see docs/physics.md). Rounded to 3-4 significant digits.
 */
export const WATER_70C = {
  density: 977.76, // kg m^-3
  dynamicViscosity: 4.04e-4, // Pa s
  thermalConductivity: 0.663, // W m^-1 K^-1
  specificHeat: 4190, // J kg^-1 K^-1
  thermalExpansion: 5.84e-4, // K^-1
};

export const QUALITY_LADDER = [44, 64, 96, 128] as const;

export function defaultVessel(kind: VesselConfig['kind']): VesselConfig {
  if (kind === 'custom') return vesselFromProfile(defaultProfile());
  if (kind === 'glass') {
    // German-style glass teapot: a wide glass cylinder, flat bottom with a small radius,
    // no spout - a short lip at the rim. Liquid can only leave over the top.
    return {
      kind,
      innerWidth: 0.19,
      innerHeight: 0.13,
      wall: 0.01, // thicker than real glass: walls need >= 2.5 cells at the coarsest resolution
      cornerRadius: 0.012,
      inletHeight: 0,
      channelWidth: 0,
      spoutLength: 0,
      spoutAngleDeg: 0,
      lipLength: 0.018,
      lipRise: 0.15,
    };
  }
  return {
    kind,
    innerWidth: 0.16,
    innerHeight: 0.16,
    wall: 0.01,
    cornerRadius: 0.025,
    inletHeight: 0.045,
    channelWidth: 0.026,
    spoutLength: 0.14,
    spoutAngleDeg: 45,
    lipLength: 0.03,
    lipRise: 0.35,
    ...(kind === 'pitcher' ? { innerHeight: 0.13 } : {}),
  };
}

/** Fill height (m) that represents the 1.5 L reference fill in each vessel model. */
export function referenceFillHeight(kind: VesselConfig['kind']): number {
  return kind === 'glass' ? 0.085 : 0.1;
}

export const VESSEL_KINDS: VesselConfig['kind'][] = [
  'teapot',
  'glass',
  'pitcher',
  'tank',
  'custom',
  'cavity',
];

/** Highest fill level (m above the inner floor) that does not overflow at rest. */
export function maxFillHeight(v: VesselConfig): number {
  if (v.kind === 'teapot') {
    const pl = buildVessel(v).polylines[0];
    return pl[pl.length - 1][1] - 0.005; // lower spout lip tip
  }
  if (v.kind === 'custom' && v.profile) {
    const p = v.profile;
    return Math.min(p[0][1], p[p.length - 1][1]) - v.wall / 2 - 0.005;
  }
  return v.innerHeight - 0.005;
}

/** Largest fill (mL, multiple of 50) the vessel holds without overflowing at rest. */
export function maxFillMl(v: VesselConfig): number {
  // The tolerance keeps 1199.999... (floating point) from rounding down a whole step.
  return Math.floor(((maxFillHeight(v) / referenceFillHeight(v.kind)) * 1500) / 50 + 1e-9) * 50;
}

/** Lower fill and target so they fit the chosen vessel; returns the adjusted settings and whether anything changed. */
export function fitFillToVessel(
  s: UserSettings,
  v: VesselConfig,
): { settings: UserSettings; changed: boolean } {
  const max = maxFillMl(v);
  if (s.fillMl <= max) return { settings: s, changed: false };
  const fillMl = Math.max(LIMITS.fillMl.min, max);
  const targetMl = Math.min(s.targetMl, Math.floor((fillMl * 0.5) / 25) * 25);
  return { settings: { ...s, fillMl, targetMl }, changed: true };
}

/** Drawn outline as "x,y;x,y;..." in whole millimetres (URL friendly). */
export function shapeToString(pts: [number, number][]): string {
  return pts.map(([x, y]) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`).join(';');
}

export function parseShape(s: string): [number, number][] | null {
  if (!s) return null;
  const pts: [number, number][] = [];
  for (const part of s.split(';')) {
    const [a, b] = part.split(',').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    pts.push([a / 1000, b / 1000]);
  }
  return pts;
}

/** Problems with a drawn outline (empty when usable). Coordinates in metres, any origin. */
export function validateProfile(pts: [number, number][]): string[] {
  const errs: string[] = [];
  if (pts.length < 3 || pts.length > 24) errs.push('A drawn pot needs 3 to 24 wall points.');
  if (pts.length < 2) return errs;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  if (w < 0.06 || w > 0.32) errs.push('The pot must be 6 to 32 cm wide.');
  if (h < 0.05 || h > 0.25) errs.push('The pot must be 5 to 25 cm high.');
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (last[0] <= first[0]) errs.push('Draw from the back rim (left) round to the pouring lip (right).');
  const minY = Math.min(...ys);
  if (first[1] - minY < 0.04 || last[1] - minY < 0.04)
    errs.push('Both the back rim and the lip must be at least 4 cm above the bottom.');
  return errs;
}

/**
 * Turn a drawn outline into a vessel: the outline becomes the wall centreline, shifted so the
 * inner floor is at y = 0 and the inner back wall at x = 0.
 */
export function vesselFromProfile(pts: [number, number][]): VesselConfig {
  const wall = 0.01;
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const profile = pts.map(([x, y]) => [x - minX - wall / 2, y - minY - wall / 2] as [number, number]);
  const maxX = Math.max(...profile.map((p) => p[0]));
  const maxY = Math.max(...profile.map((p) => p[1]));
  return {
    ...defaultVessel('glass'),
    kind: 'custom',
    innerWidth: maxX - wall / 2,
    innerHeight: maxY,
    wall,
    profile,
  };
}

/** Starting outline for the shape editor: the German glass teapot's wall centreline. */
export function defaultProfile(): [number, number][] {
  return buildVessel(defaultVessel('glass')).polylines[0].map(([x, y]) => [x, y] as [number, number]);
}

export function defaultMotion(): MotionConfig {
  return {
    kind: 'pour',
    startDelay: 0.5,
    tiltDuration: 2,
    holdAngleDeg: 22,
    holdTiltRate: 3,
    maxAngleDeg: 80,
    returnDuration: 1.2,
    maxHold: 12,
    holdTime: 1.5,
    targetVolume: 400 * ML,
    // Calibrated with scripts/calibrate-anticipation.ts at the default resolution (44).
    anticipation: 0.254,
    repeats: 1,
    repeatGap: 1.5,
    settleTime: 2,
  };
}

export function baseConfig(): ExperimentConfig {
  const cfg: ExperimentConfig = {
    schemaVersion: 1,
    name: 'Gentle 400 mL pour (teapot)',
    presetId: 'teapot-gentle',
    domainWidth: 0.5,
    domainHeight: 0.5,
    cellsAcrossBody: 44,
    particlesPerCellAxis: 2,
    initialVolume: 1500 * ML,
    fillHeight: 0.1,
    vessel: defaultVessel('teapot'),
    pivotLocal: [0.08, 0.06],
    pivotWorld: [0.25, 0.25],
    motion: defaultMotion(),
    thermal: {
      mode: 'off',
      bottomTemperature: 70 + C_TO_K,
      topTemperature: 70 + C_TO_K,
      ambientTemperature: 21 + C_TO_K,
      wallHeatTransfer: 0,
      surfaceHeatTransfer: 0,
    },
    density: WATER_70C.density,
    kinematicViscosity: WATER_70C.dynamicViscosity / WATER_70C.density,
    thermalDiffusivity: WATER_70C.thermalConductivity / (WATER_70C.density * WATER_70C.specificHeat),
    thermalExpansion: WATER_70C.thermalExpansion,
    specificHeat: WATER_70C.specificHeat,
    gravity: 9.81,
    transfer: 'flip',
    flipRatio: 0.95,
    viscosity: true,
    densityCorrection: 0.3,
    cfl: 0.8,
    maxSubstep: 1 / 200,
    pressureTolerance: 1e-6,
    pressureMaxIterations: 400,
    originBands: 3,
    seed: 1,
    jitter: 0.5,
    duration: 14,
  };
  return cfg;
}

/**
 * Size the domain so the vessel stays inside it for every tilt between 0 and maxAngle,
 * with a margin of a few cells. Mutates and returns cfg.
 */
export function fitDomain(cfg: ExperimentConfig): ExperimentConfig {
  const v = buildVessel(cfg.vessel);
  const h = cfg.vessel.innerWidth / cfg.cellsAcrossBody;
  const pts: [number, number][] = [];
  for (const pl of v.polylines) for (const p of pl) pts.push(p);
  // Include the top of the open body so splashes above the rim have room.
  pts.push([0, cfg.vessel.innerHeight + 0.03], [cfg.vessel.innerWidth, cfg.vessel.innerHeight + 0.03]);
  const maxA = cfg.motion.kind === 'still' ? 0 : Math.max(cfg.motion.maxAngleDeg, cfg.motion.holdAngleDeg);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const out = new Float64Array(2);
  for (let a = 0; a <= maxA + 1e-9; a += Math.max(1, maxA / 40)) {
    const pose = makePose((-a * Math.PI) / 180, 0, cfg.pivotLocal, [0, 0]);
    for (const [lx, ly] of pts) {
      localToWorld(pose, lx, ly, out);
      x0 = Math.min(x0, out[0]);
      y0 = Math.min(y0, out[1]);
      x1 = Math.max(x1, out[0]);
      y1 = Math.max(y1, out[1]);
    }
  }
  const margin = v.halfWall + 4 * h;
  cfg.pivotWorld = [-x0 + margin, -y0 + margin];
  cfg.domainWidth = x1 - x0 + 2 * margin;
  cfg.domainHeight = y1 - y0 + 2 * margin;
  return cfg;
}

export interface PresetInfo {
  id: string;
  label: string;
  purpose: string;
  status: string;
  build: () => ExperimentConfig;
}

function make(id: string, name: string, mutate: (c: ExperimentConfig) => void): () => ExperimentConfig {
  return () => {
    const c = baseConfig();
    c.presetId = id;
    c.name = name;
    mutate(c);
    return fitDomain(c);
  };
}

/** de Vahl Davis (1983) benchmark Nusselt numbers for the differentially heated square cavity (Pr 0.71). */
export const DE_VAHL_DAVIS_NU: Record<number, number> = { 1e3: 1.118, 1e4: 2.243, 1e5: 4.519 };

/**
 * Differentially heated square cavity (verification of the thermal mode): closed 10 cm box filled
 * with liquid, hot left wall, cold right wall, adiabatic floor and lid, no-slip walls, Boussinesq
 * buoyancy. Diffusivities are set so the Rayleigh number equals `ra` at Prandtl number `pr`.
 */
export function cavityConfig(ra: number, cells = 44, pr = 0.71): ExperimentConfig {
  const c = baseConfig();
  c.presetId = 'thermal-cavity';
  c.name = `Differentially heated cavity, Ra = ${ra.toExponential(0)} (verification)`;
  const L = 0.1;
  const dT = 10;
  c.vessel = { ...defaultVessel('tank'), kind: 'cavity', innerWidth: L, innerHeight: L, cornerRadius: 0 };
  c.fillHeight = L;
  c.initialVolume = 1000 * ML;
  c.pivotLocal = [L / 2, L / 2];
  c.cellsAcrossBody = cells;
  c.motion = { ...defaultMotion(), kind: 'still', targetVolume: 0 };
  c.thermalExpansion = 1e-3;
  const alpha = Math.sqrt((c.gravity * c.thermalExpansion * dT * L ** 3) / (ra * pr));
  c.thermalDiffusivity = alpha;
  c.kinematicViscosity = pr * alpha;
  c.wallTreatment = 'no-slip';
  c.thermal = {
    ...c.thermal,
    mode: 'coupled',
    bottomTemperature: 300,
    topTemperature: 300,
    hotWallTemperature: 300 + dT / 2,
    coldWallTemperature: 300 - dT / 2,
    wallHeatTransfer: 0,
    surfaceHeatTransfer: 0,
  };
  c.duration = 60;
  return fitDomain(c);
}

export const PRESETS: PresetInfo[] = [
  {
    id: 'teapot-gentle',
    label: 'Gentle 400 mL pour',
    purpose: 'Main scenario: low-inlet spout teapot, smooth tilt, return near the target.',
    status: 'Version 1',
    build: make('teapot-gentle', 'Gentle 400 mL pour (teapot)', () => {}),
  },
  {
    id: 'teapot-still',
    label: 'Still pot (no pour)',
    purpose: 'Control: identical initial state left upright for the same time; shows numerical drift.',
    status: 'Version 1',
    build: make('teapot-still', 'Still teapot, no pour (control)', (c) => {
      c.motion.kind = 'still';
      c.motion.targetVolume = 0;
    }),
  },
  {
    id: 'teapot-fast',
    label: 'Faster pour, matched discharge',
    purpose: 'Motion sensitivity: same target volume, quicker and steeper tilt.',
    status: 'Version 1',
    build: make('teapot-fast', 'Faster 400 mL pour (teapot)', (c) => {
      c.motion.tiltDuration = 0.8;
      c.motion.holdAngleDeg = 32;
      c.motion.holdTiltRate = 5;
      c.motion.returnDuration = 0.6;
      c.motion.anticipation = 1.406;
    }),
  },
  {
    id: 'teapot-slow',
    label: 'Slower pour, matched discharge',
    purpose: 'Motion sensitivity: same target volume, slow and shallow tilt.',
    status: 'Version 1',
    build: make('teapot-slow', 'Slower 400 mL pour (teapot)', (c) => {
      c.motion.tiltDuration = 3;
      c.motion.holdAngleDeg = 15;
      c.motion.holdTiltRate = 2;
      c.motion.returnDuration = 1.5;
      c.motion.anticipation = 0.176;
      c.duration = 20;
      c.motion.maxHold = 16;
    }),
  },
  {
    id: 'teapot-tilt',
    label: 'Tilt and return, no spill',
    purpose: 'Isolates the effect of motion from removal: tilt below the spill angle and return.',
    status: 'Version 1',
    build: make('teapot-tilt', 'Tilt and return without spilling (teapot)', (c) => {
      c.motion.kind = 'tilt';
      c.motion.holdAngleDeg = 4;
      c.motion.maxAngleDeg = 4;
      c.motion.holdTiltRate = 0;
      c.motion.holdTime = 1.5;
      c.motion.targetVolume = 0;
    }),
  },
  {
    id: 'pitcher-gentle',
    label: 'Rim-pouring pitcher',
    purpose: 'Geometry sensitivity: liquid leaves over a rim lip instead of a low-inlet spout.',
    status: 'Version 1',
    build: make('pitcher-gentle', 'Gentle 400 mL pour (rim pitcher)', (c) => {
      c.vessel = defaultVessel('pitcher');
      c.motion.holdAngleDeg = 30;
      c.motion.anticipation = 0.229;
    }),
  },
  {
    id: 'glass-gentle',
    label: 'German glass teapot (top lip)',
    purpose:
      'Wide glass cylinder without a spout: liquid can only leave over the lip at the rim, so the top of the pot reaches the cup first.',
    status: 'Version 1',
    build: make('glass-gentle', 'Gentle 400 mL pour (German glass teapot)', (c) => {
      c.vessel = defaultVessel('glass');
      c.fillHeight = referenceFillHeight('glass');
      c.pivotLocal = [0.095, 0.06];
      c.motion.holdAngleDeg = 25;
      c.motion.anticipation = 0.186;
    }),
  },
  {
    id: 'teapot-repeat',
    label: 'Repeated pours (2 x 200 mL)',
    purpose: 'Cumulative exchange: two half-size pours with a pause between them.',
    status: 'Later version 1',
    build: make('teapot-repeat', 'Two 200 mL pours (teapot)', (c) => {
      c.motion.repeats = 2;
      c.motion.anticipation = 0.371;
      c.duration = 20;
    }),
  },
  {
    id: 'thermal-stratified',
    label: 'Warm above cool, then pour',
    purpose: 'Stable buoyancy stratification (75 degC top, 65 degC bottom) with Boussinesq coupling.',
    status: 'Version 2',
    build: make('thermal-stratified', 'Warm above cool, coupled buoyancy, 400 mL pour', (c) => {
      c.thermal.mode = 'coupled';
      c.thermal.topTemperature = 75 + C_TO_K;
      c.thermal.bottomTemperature = 65 + C_TO_K;
    }),
  },
  {
    id: 'thermal-cooling',
    label: 'Wall and surface cooling (exaggerated)',
    purpose:
      'Convection before pouring. Heat-transfer coefficients are exaggerated so cooling acts within seconds.',
    status: 'Version 2',
    build: make('thermal-cooling', 'Cooling-driven convection, then 400 mL pour', (c) => {
      c.thermal.mode = 'coupled';
      c.thermal.wallHeatTransfer = 4000;
      c.thermal.surfaceHeatTransfer = 4000;
      c.motion.startDelay = 4;
      c.duration = 18;
    }),
  },
  {
    id: 'thermal-cavity',
    label: 'Heated cavity, Ra 1e4 (thermal benchmark)',
    purpose:
      'Verification of the thermal mode: hot left wall, cold right wall, closed box. The measured Nusselt number is compared with de Vahl Davis (1983).',
    status: 'Verification',
    build: () => cavityConfig(1e4),
  },
  {
    id: 'tank-rest',
    label: 'Hydrostatic tank (numerical test)',
    purpose: 'Verification: a resting open tank must stay at rest with no volume loss.',
    status: 'Verification',
    build: make('tank-rest', 'Hydrostatic open tank (verification)', (c) => {
      c.vessel = defaultVessel('tank');
      c.motion.kind = 'still';
      c.motion.targetVolume = 0;
      c.duration = 4;
    }),
  },
  {
    id: 'tank-tilt',
    label: 'Tilting tank, no spill (numerical test)',
    purpose: 'Verification: moving walls must not let parcels tunnel or lose volume.',
    status: 'Verification',
    build: make('tank-tilt', 'Tilting open tank (verification)', (c) => {
      c.vessel = defaultVessel('tank');
      c.motion.kind = 'tilt';
      c.motion.holdAngleDeg = 15;
      c.motion.maxAngleDeg = 15;
      c.motion.holdTiltRate = 0;
      c.motion.targetVolume = 0;
      c.duration = 6;
    }),
  },
];

export function presetById(id: string): PresetInfo {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/** User-adjustable settings exposed in the UI and URL. Units are user-facing (mL, s, deg, degC). */
export interface UserSettings {
  preset: string;
  /** Particles per cell per axis: 2, 3 or 4 (4, 9 or 16 parcels per cell). */
  ppc: number;
  /** 'manual': the user tilts the pot with a slider instead of the automated pour. */
  control: 'auto' | 'manual';
  /** Drawn pot outline for vessel 'custom' (see shapeToString); empty otherwise. */
  shape: string;
  fillMl: number;
  targetMl: number;
  tiltDuration: number;
  holdAngle: number;
  returnDuration: number;
  vessel: VesselConfig['kind'];
  quality: number;
  seed: number;
  transfer: ExperimentConfig['transfer'];
  flipRatio: number;
  thermal: ExperimentConfig['thermal']['mode'];
  topC: number;
  bottomC: number;
  coolingWm2K: number;
  duration: number;
}

export function settingsFromConfig(c: ExperimentConfig): UserSettings {
  return {
    preset: c.presetId,
    ppc: c.particlesPerCellAxis,
    control: c.motion.kind === 'manual' ? 'manual' : 'auto',
    shape: c.vessel.kind === 'custom' && c.vessel.profile ? shapeToString(c.vessel.profile) : '',
    fillMl: Math.round(c.initialVolume / ML),
    targetMl: Math.round(c.motion.targetVolume / ML),
    tiltDuration: c.motion.tiltDuration,
    holdAngle: c.motion.holdAngleDeg,
    returnDuration: c.motion.returnDuration,
    vessel: c.vessel.kind,
    quality: c.cellsAcrossBody,
    seed: c.seed,
    transfer: c.transfer,
    flipRatio: c.flipRatio,
    thermal: c.thermal.mode,
    topC: Math.round((c.thermal.topTemperature - C_TO_K) * 10) / 10,
    bottomC: Math.round((c.thermal.bottomTemperature - C_TO_K) * 10) / 10,
    coolingWm2K: c.thermal.wallHeatTransfer,
    duration: c.duration,
  };
}

export interface SettingLimit {
  min: number;
  max: number;
  label: string;
  unit: string;
  step: number;
}

export const LIMITS: Record<
  | 'fillMl'
  | 'targetMl'
  | 'tiltDuration'
  | 'holdAngle'
  | 'returnDuration'
  | 'flipRatio'
  | 'topC'
  | 'bottomC'
  | 'coolingWm2K'
  | 'duration'
  | 'seed',
  SettingLimit
> = {
  fillMl: { min: 200, max: 3000, label: 'Fill', unit: 'mL', step: 50 },
  targetMl: { min: 0, max: 900, label: 'Target discharge', unit: 'mL', step: 25 },
  tiltDuration: { min: 0.3, max: 5, label: 'Tilt-in duration', unit: 's', step: 0.1 },
  holdAngle: { min: 2, max: 80, label: 'Hold angle', unit: 'deg', step: 1 },
  returnDuration: { min: 0.3, max: 5, label: 'Return duration', unit: 's', step: 0.1 },
  flipRatio: { min: 0, max: 1, label: 'FLIP fraction', unit: '', step: 0.01 },
  topC: { min: 20, max: 99, label: 'Top temperature', unit: 'degC', step: 0.5 },
  bottomC: { min: 20, max: 99, label: 'Bottom temperature', unit: 'degC', step: 0.5 },
  coolingWm2K: { min: 0, max: 10000, label: 'Cooling coefficient', unit: 'W/m2K', step: 10 },
  duration: { min: 2, max: 120, label: 'Simulated duration', unit: 's', step: 1 },
  seed: { min: 1, max: 999999, label: 'Seed', unit: '', step: 1 },
};

/** Validate settings, returning human-readable problems (empty when valid). */
export function validateSettings(s: UserSettings): string[] {
  const errs: string[] = [];
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const lim = LIMITS[key];
    const val = s[key];
    if (typeof val !== 'number' || !Number.isFinite(val)) errs.push(`${lim.label} must be a number.`);
    else if (val < lim.min || val > lim.max)
      errs.push(`${lim.label} must be between ${lim.min} and ${lim.max} ${lim.unit}.`.trim());
  }
  if (!(QUALITY_LADDER as readonly number[]).includes(s.quality))
    errs.push(`Resolution must be one of ${QUALITY_LADDER.join(', ')}.`);
  if (!VESSEL_KINDS.includes(s.vessel)) errs.push('Unknown vessel.');
  if (![2, 3, 4].includes(s.ppc)) errs.push('Particles per cell must be 4, 9 or 16.');
  if (s.control !== 'auto' && s.control !== 'manual') errs.push('Unknown control mode.');
  let vessel: VesselConfig | null = null;
  if (s.vessel === 'custom') {
    const pts = parseShape(s.shape);
    const shapeErrs = pts ? validateProfile(pts) : ['The drawn pot outline could not be read.'];
    errs.push(...shapeErrs);
    if (pts && shapeErrs.length === 0) vessel = vesselFromProfile(pts);
  } else if (VESSEL_KINDS.includes(s.vessel)) vessel = defaultVessel(s.vessel);
  // A closed cavity is always completely full; its fill setting does not apply.
  if (vessel && vessel.kind !== 'cavity' && Number.isFinite(s.fillMl)) {
    const maxMl = maxFillMl(vessel);
    if (s.fillMl > maxMl) errs.push(`This pot overflows above ${maxMl} mL: lower the fill.`);
  }
  if (!['flip', 'apic'].includes(s.transfer)) errs.push('Unknown transfer scheme.');
  if (!['off', 'passive', 'coupled'].includes(s.thermal)) errs.push('Unknown thermal mode.');
  if (Number.isFinite(s.targetMl) && Number.isFinite(s.fillMl) && s.targetMl >= s.fillMl)
    errs.push('Target discharge must be smaller than the fill.');
  return errs;
}

/** Apply user settings on top of the chosen preset. Geometry changes refit the domain. */
export function configFromSettings(s: UserSettings): ExperimentConfig {
  const c = presetById(s.preset).build();
  if (s.vessel === 'custom') {
    c.vessel = vesselFromProfile(parseShape(s.shape) ?? defaultProfile());
    c.pivotLocal = [c.vessel.innerWidth / 2, 0.06];
    c.motion.anticipation = 0.2;
  } else if (s.vessel !== c.vessel.kind) {
    c.vessel = defaultVessel(s.vessel);
    c.pivotLocal = [c.vessel.innerWidth / 2, 0.06];
  }
  c.particlesPerCellAxis = s.ppc;
  if (s.control === 'manual') {
    c.motion.kind = 'manual';
    c.motion.targetVolume = 0;
    c.motion.maxAngleDeg = 90;
  }
  // Fill height scales with requested volume relative to the 1.5 L reference fill.
  if (c.vessel.kind !== 'cavity') {
    c.fillHeight = referenceFillHeight(c.vessel.kind) * (s.fillMl / 1500);
    c.initialVolume = s.fillMl * ML;
  }
  if (c.motion.kind === 'pour') c.motion.targetVolume = s.targetMl * ML;
  c.motion.tiltDuration = s.tiltDuration;
  c.motion.holdAngleDeg = s.holdAngle;
  c.motion.maxAngleDeg = Math.max(c.motion.maxAngleDeg, s.holdAngle);
  if (c.motion.kind === 'tilt') c.motion.maxAngleDeg = s.holdAngle;
  c.motion.returnDuration = s.returnDuration;
  c.cellsAcrossBody = s.quality;
  c.seed = Math.round(s.seed);
  c.transfer = s.transfer;
  c.flipRatio = s.flipRatio;
  c.thermal.mode = s.thermal;
  c.thermal.topTemperature = s.topC + C_TO_K;
  c.thermal.bottomTemperature = s.bottomC + C_TO_K;
  c.thermal.wallHeatTransfer = s.coolingWm2K;
  c.thermal.surfaceHeatTransfer = s.coolingWm2K;
  c.duration = s.duration;
  return fitDomain(c);
}

const NUM_KEYS: (keyof UserSettings)[] = [
  'ppc',
  'fillMl',
  'targetMl',
  'tiltDuration',
  'holdAngle',
  'returnDuration',
  'quality',
  'seed',
  'flipRatio',
  'topC',
  'bottomC',
  'coolingWm2K',
  'duration',
];

export function settingsToQuery(s: UserSettings): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(s)) p.set(k, String(v));
  return p.toString();
}

/** Parse settings from a query string; unknown or missing keys fall back to the preset defaults. */
export function settingsFromQuery(q: string): UserSettings {
  const p = new URLSearchParams(q);
  const base = settingsFromConfig(presetById(p.get('preset') ?? PRESETS[0].id).build());
  const out: UserSettings = { ...base };
  for (const k of NUM_KEYS) {
    const raw = p.get(k);
    if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw)))
      (out as unknown as Record<string, number>)[k] = Number(raw);
  }
  const vessel = p.get('vessel') as VesselConfig['kind'] | null;
  if (vessel && VESSEL_KINDS.includes(vessel)) out.vessel = vessel;
  const control = p.get('control');
  if (control === 'auto' || control === 'manual') out.control = control;
  const shape = p.get('shape');
  if (shape !== null) out.shape = shape;
  const transfer = p.get('transfer');
  if (transfer === 'flip' || transfer === 'apic') out.transfer = transfer;
  const thermal = p.get('thermal');
  if (thermal === 'off' || thermal === 'passive' || thermal === 'coupled') out.thermal = thermal;
  return out;
}
