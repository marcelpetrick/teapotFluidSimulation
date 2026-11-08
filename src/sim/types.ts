// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Shared simulation types. All internal quantities are SI units
// (metres, seconds, kilograms, pascals, kelvin). The UI converts to mL and degC.

/** Grid cell classification. */
export const CELL_AIR = 0;
export const CELL_FLUID = 1;
export const CELL_SOLID = 2;

/** Parcel ledger status. A removed parcel still contributes to the conservation ledger. */
export const STATUS_IN_POT = 0;
export const STATUS_DISCHARGED = 1;
export const STATUS_SPILLED = 2;
export const STATUS_LOST = 3;

export type TransferScheme = 'flip' | 'apic';
export type WallTreatment = 'free-slip';
export type ThermalMode = 'off' | 'passive' | 'coupled';
export type VesselKind = 'tank' | 'pitcher' | 'teapot';

/** Vessel geometry, all lengths in metres, in pot-local coordinates (y up, pivot at local origin offset). */
export interface VesselConfig {
  kind: VesselKind;
  /** Inner width of the body. */
  innerWidth: number;
  /** Inner height of the body from floor to rim. */
  innerHeight: number;
  /** Wall thickness (solid band width). */
  wall: number;
  /** Corner radius of the body bottom. */
  cornerRadius: number;
  /** Teapot only: height of spout inlet centre above the floor. */
  inletHeight: number;
  /** Teapot only: perpendicular channel width of the spout. */
  channelWidth: number;
  /** Teapot only: spout length along its axis. */
  spoutLength: number;
  /** Teapot only: spout elevation angle in degrees from horizontal. */
  spoutAngleDeg: number;
  /** Pitcher only: horizontal extent of the pouring lip. */
  lipLength: number;
}

/** Prescribed vessel motion: smooth tilt-in, hold, controlled return. Angles in degrees, positive = toward spout. */
export interface MotionConfig {
  kind: 'still' | 'pour' | 'tilt';
  /** Wait before tilting starts. */
  startDelay: number;
  /** Duration of the eased tilt-in. */
  tiltDuration: number;
  /** Angle reached at the end of tilt-in. */
  holdAngleDeg: number;
  /** Slow further tilt during hold (deg/s), as a person does while a pot empties. */
  holdTiltRate: number;
  /** Upper bound on tilt. */
  maxAngleDeg: number;
  /** Duration of the eased return to upright. */
  returnDuration: number;
  /** Maximum hold time before return regardless of discharge (safety bound, reported). */
  maxHold: number;
  /** For 'tilt' motion: hold time without discharge target. */
  holdTime: number;
  /** Target discharge (m^3, 2D-equivalent). 0 for no target. */
  targetVolume: number;
  /** Fraction of the return duration used to anticipate flow still in transit. */
  anticipation: number;
  /** Number of pours (repeated-pour preset). */
  repeats: number;
  /** Rest between repeated pours. */
  repeatGap: number;
  /** Settle time after the final return. */
  settleTime: number;
}

export interface ThermalConfig {
  mode: ThermalMode;
  /** Initial temperature at bottom and top of fill (K). Linear profile between. */
  bottomTemperature: number;
  topTemperature: number;
  /** Ambient temperature for cooling (K). */
  ambientTemperature: number;
  /** Heat-transfer coefficients (W m^-2 K^-1) on walls and free surface; 0 disables. */
  wallHeatTransfer: number;
  surfaceHeatTransfer: number;
  /** Waiting period before motion starts during which cooling acts (s). Included in startDelay. */
}

export interface ExperimentConfig {
  schemaVersion: 1;
  name: string;
  presetId: string;
  /** Domain size (m). */
  domainWidth: number;
  domainHeight: number;
  /** Cells across the vessel inner width (resolution ladder 44 / 64 / 96). */
  cellsAcrossBody: number;
  /** Particles per cell per axis at seeding (2 => 4 per cell). */
  particlesPerCellAxis: number;
  /** Initial liquid volume (m^3), sets the effective 2D depth. */
  initialVolume: number;
  /** Fill height above the floor (m), in pot coordinates. */
  fillHeight: number;
  vessel: VesselConfig;
  /** Pivot of the tilt in pot-local coordinates and its world position. */
  pivotLocal: [number, number];
  pivotWorld: [number, number];
  motion: MotionConfig;
  thermal: ThermalConfig;
  /** Reference water properties (documented in docs/physics.md). */
  density: number;
  kinematicViscosity: number;
  thermalDiffusivity: number;
  thermalExpansion: number;
  specificHeat: number;
  gravity: number;
  transfer: TransferScheme;
  /** FLIP fraction of the PIC/FLIP blend (0 = pure PIC). */
  flipRatio: number;
  /** Position-only density correction strength per step (0 disables). A numerical stabiliser. */
  densityCorrection: number;
  /** Apply the physical viscosity term (explicit). */
  viscosity: boolean;
  cfl: number;
  maxSubstep: number;
  pressureTolerance: number;
  pressureMaxIterations: number;
  originBands: number;
  seed: number;
  jitter: number;
  /** Total simulated duration of the experiment (s). */
  duration: number;
}

/** Per-advance diagnostics. */
export interface Diagnostics {
  time: number;
  steps: number;
  substepsLastAdvance: number;
  dtLast: number;
  angleDeg: number;
  phase: string;
  particleCount: number;
  gridNx: number;
  gridNy: number;
  cellSize: number;
  fluidCells: number;
  pressureIterations: number;
  pressureIterationsMax: number;
  pressureResidual: number;
  pressureConverged: boolean;
  pressureFailures: number;
  divergenceBefore: number;
  divergenceAfter: number;
  maxSpeed: number;
  kineticEnergy: number;
  potentialEnergy: number;
  volumeInitial: number;
  volumeInPot: number;
  volumeDischarged: number;
  volumeSpilled: number;
  volumeLost: number;
  ledgerError: number;
  /** Volume represented by fluid cells times effective depth; drift indicates compression/expansion. */
  representedVolume: number;
  representedDrift: number;
  meanParticlesPerFluidCell: number;
  maxDensityRatio: number;
  /** Mean parcel density over interior liquid cells relative to seeding density (1 = no compression). */
  interiorDensity: number;
  densityCorrectionDisplacement: number;
  densityCorrectionIterations: number;
  collisionCorrections: number;
  collisionDisplacement: number;
  meanTemperature: number;
  thermalInventoryError: number;
  wallClockMsLastAdvance: number;
}

export interface RenderSnapshot {
  time: number;
  angleDeg: number;
  count: number;
  positions: Float32Array;
  status: Uint8Array;
  temperature: Float32Array | null;
  speed: Float32Array;
}
