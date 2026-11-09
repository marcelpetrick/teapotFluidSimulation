// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Host side of the WebGPU 3D solver. The initial state (grid, pivot, seeded parcels, layer labels)
// comes from the CPU reference constructor, so both solvers start bit-identical. Each substep is
// one command buffer; the only readback is a 64-byte stats block (counts, max speed, divergence),
// which the CPU needs for the next stable substep and for the target-volume pour controller.

import { PourController } from '../sim/motion';
import { Simulation3D, type Config3D, type Diagnostics3D } from '../sim3d/solver3d';
import {
  buildLayout,
  floatFromBits,
  packParams,
  packSolve,
  SCALE_RATIO,
  STAT,
  STAT_SLOTS,
  STAT_STEP,
  type Layout,
} from './layout';
import { pcgWgsl, renderWgsl, solverWgsl, WG } from './shaders';

export interface GpuStats {
  counts: [number, number, number, number];
  dischargedByOrigin: [number, number, number];
  pressureFailures: number;
  maxSpeedSq: number;
  maxDivergence: number;
  interiorDensity: number;
  pressureIterations: number;
  correctionIterations: number;
}

export function decodeStats(raw: Int32Array): GpuStats {
  const ic = raw[STAT.interiorCount];
  return {
    counts: [raw[STAT.inPot], raw[STAT.discharged], raw[STAT.spilled], raw[STAT.lost]],
    dischargedByOrigin: [raw[STAT.originBottom], raw[STAT.originMiddle], raw[STAT.originTop]],
    pressureFailures: raw[STAT.pressureFailures],
    maxSpeedSq: floatFromBits(raw[STAT.maxSpeedSq]),
    maxDivergence: floatFromBits(raw[STAT.maxDivergence]),
    interiorDensity: ic > 0 ? raw[STAT.interiorSum] / SCALE_RATIO / ic : 1,
    pressureIterations: raw[STAT.pressureIterations],
    correctionIterations: raw[STAT.correctionIterations],
  };
}

/** Largest power of two not above the device's workgroup limits (capped at 1024). */
export function pcgThreads(
  limits: Pick<GPUSupportedLimits, 'maxComputeInvocationsPerWorkgroup' | 'maxComputeWorkgroupSizeX'>,
): number {
  const cap = Math.min(1024, limits.maxComputeInvocationsPerWorkgroup, limits.maxComputeWorkgroupSizeX);
  let t = 1;
  while (t * 2 <= cap) t *= 2;
  return t;
}

/** Workgroup counts for a 1D problem, folded into 2D above the 65535 per-dimension limit. */
export function workgroups(count: number): [number, number] {
  const total = Math.max(1, Math.ceil(count / WG));
  const x = Math.min(total, 65535);
  return [x, Math.ceil(total / x)];
}

/** Ask for a high-performance adapter with the limits the solver can use. */
export async function requestSolverDevice(gpu: GPU): Promise<{ device: GPUDevice; info: GPUAdapterInfo }> {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const l = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: l.maxComputeWorkgroupSizeX,
      maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
      maxBufferSize: l.maxBufferSize,
    },
  });
  return { device, info: adapter.info };
}

const STORAGE = 0x80; // GPUBufferUsage.STORAGE (constants inlined: no globals needed in tests)
const COPY_SRC = 0x04;
const COPY_DST = 0x08;
const MAP_READ = 0x01;
const UNIFORM = 0x40;
const VERTEX = 0x20;
const COMPUTE = 0x4; // GPUShaderStage.COMPUTE

export class GpuSimulation3D {
  readonly cpu: Simulation3D;
  readonly cfg: Config3D;
  readonly controller: PourController;
  readonly layout: Layout;
  readonly n: number;
  readonly threads: number;
  time = 0;
  steps = 0;
  stats: GpuStats;
  private phi = 0;
  private params: ArrayBuffer;
  private buffers: Record<string, GPUBuffer> = {};
  private pipelines: Record<string, GPUComputePipeline> = {};
  private group0!: GPUBindGroup;
  private solveGroups: GPUBindGroup[] = [];
  private renderPipeline!: GPUComputePipeline;
  private renderLayout!: GPUBindGroupLayout;
  private renderGroups = new Map<GPUBuffer, GPUBindGroup>();

  constructor(
    readonly device: GPUDevice,
    cfg: Config3D,
    private readonly pcgSource: (threads: number) => string = pcgWgsl,
  ) {
    this.cfg = cfg;
    this.cpu = new Simulation3D(cfg);
    this.controller = new PourController(cfg.motion);
    this.layout = buildLayout(this.cpu);
    this.n = this.cpu.n;
    this.threads = pcgThreads(device.limits);
    this.params = packParams(this.layout.params);
    this.stats = decodeStats(new Int32Array(STAT_SLOTS));
    this.stats.counts = [this.n, 0, 0, 0];
    this.createBuffers();
    this.createPipelines();
  }

  private buffer(name: string, size: number, usage: number): GPUBuffer {
    const b = this.device.createBuffer({ label: name, size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    this.buffers[name] = b;
    return b;
  }

  private createBuffers(): void {
    const { device, layout: L, n, cpu } = this;
    const P = L.params;
    this.buffer('params', this.params.byteLength, UNIFORM | COPY_DST);
    this.buffer('floats', L.floats * 4, STORAGE | COPY_DST | COPY_SRC);
    this.buffer('ints', L.ints * 4, STORAGE | COPY_DST | COPY_SRC);
    this.buffer('flags', L.flags * 4, STORAGE | COPY_DST | COPY_SRC);
    this.buffer('pos', n * 16, STORAGE | COPY_DST | COPY_SRC);
    this.buffer('vel', n * 16, STORAGE | COPY_DST | COPY_SRC);
    this.buffer('statsRead', STAT_SLOTS * 4, MAP_READ | COPY_DST);
    this.buffer('solveA', 16, UNIFORM | COPY_DST);
    this.buffer('solveB', 16, UNIFORM | COPY_DST);
    const pos = new Float32Array(4 * n);
    for (let p = 0; p < n; p++) {
      pos[4 * p] = cpu.x[p];
      pos[4 * p + 1] = cpu.y[p];
      pos[4 * p + 2] = cpu.z[p];
    }
    device.queue.writeBuffer(this.buffers.pos, 0, pos);
    const origin = new Uint32Array(n);
    for (let p = 0; p < n; p++) origin[p] = cpu.origin[p];
    device.queue.writeBuffer(this.buffers.flags, P.uOrigin * 4, origin);
    const stats = new Int32Array(STAT_SLOTS);
    stats[STAT.inPot] = n;
    device.queue.writeBuffer(this.buffers.ints, P.aStats * 4, stats);
    device.queue.writeBuffer(
      this.buffers.solveA,
      0,
      packSolve(cpu.cfg.pressureTolerance, cpu.cfg.pressureMaxIterations, STAT.pressureIterations, true),
    );
    device.queue.writeBuffer(this.buffers.solveB, 0, packSolve(1e-4, 80, STAT.correctionIterations, false));
  }

  private createPipelines(): void {
    const { device, buffers: B } = this;
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: COMPUTE,
      buffer: { type: 'storage' },
    });
    const g0 = device.createBindGroupLayout({
      label: 'solver',
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' } },
        storage(1),
        storage(2),
        storage(3),
        storage(4),
        storage(5),
      ],
    });
    const g1 = device.createBindGroupLayout({
      label: 'solve',
      entries: [{ binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' } }],
    });
    const main = device.createShaderModule({ label: 'solver', code: solverWgsl() });
    const plain = device.createPipelineLayout({ bindGroupLayouts: [g0] });
    for (const entry of [
      'markOccupied',
      'classify',
      'compactCount',
      'compactScan',
      'compactWrite',
      'particlesToGrid',
      'gridInit',
      'divergenceRhs',
      'divergenceCheck',
      'gradientVelocity',
      'gradientCorrection',
      'markValid',
      'extrapolate1',
      'extrapolate2',
      'gridToParticles',
      'densityScatter',
      'densityRhs',
      'advect',
    ])
      this.pipelines[entry] = device.createComputePipeline({
        label: entry,
        layout: plain,
        compute: { module: main, entryPoint: entry },
      });
    this.pipelines.pcg = device.createComputePipeline({
      label: 'pcg',
      layout: device.createPipelineLayout({ bindGroupLayouts: [g0, g1] }),
      compute: {
        module: device.createShaderModule({ label: 'pcg', code: this.pcgSource(this.threads) }),
        entryPoint: 'pcg',
      },
    });
    this.group0 = device.createBindGroup({
      layout: g0,
      entries: ['params', 'floats', 'ints', 'flags', 'pos', 'vel'].map((name, binding) => ({
        binding,
        resource: { buffer: B[name] },
      })),
    });
    this.solveGroups = ['solveA', 'solveB'].map((name) =>
      device.createBindGroup({ layout: g1, entries: [{ binding: 0, resource: { buffer: B[name] } }] }),
    );
    this.renderLayout = device.createBindGroupLayout({
      label: 'render',
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: COMPUTE, buffer: { type: 'read-only-storage' } },
        storage(2),
      ],
    });
    this.renderPipeline = device.createComputePipeline({
      label: 'render',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.renderLayout] }),
      compute: {
        module: device.createShaderModule({ label: 'render', code: renderWgsl() }),
        entryPoint: 'writePositions',
      },
    });
  }

  get finished(): boolean {
    return this.time >= this.cfg.duration - 1e-9;
  }

  /** Same stable-substep rule as the CPU solver, from the max parcel speed of the last substep. */
  stableDt(): number {
    const { nx, ny, h } = this.cpu;
    const omega = this.layout.params.omega;
    const R = Math.hypot(nx, ny) * h;
    const speed =
      Math.sqrt(this.stats.maxSpeedSq) + Math.sqrt(5 * h * this.cfg.gravity) + Math.abs(omega) * R;
    return Math.min(this.cfg.maxSubstep, (this.cfg.cfl * h) / speed);
  }

  private dispatch(pass: GPUComputePassEncoder, name: string, count: number, solve = -1): void {
    pass.setPipeline(this.pipelines[name]);
    pass.setBindGroup(0, this.group0);
    if (solve >= 0) {
      pass.setBindGroup(1, this.solveGroups[solve]);
      pass.dispatchWorkgroups(1);
      return;
    }
    const [x, y] = workgroups(count);
    pass.dispatchWorkgroups(x, y);
  }

  /** Dispatch a kernel with an explicit workgroup count (compaction kernels: one block each). */
  private dispatchGroups(pass: GPUComputePassEncoder, name: string, groups: number): void {
    pass.setPipeline(this.pipelines[name]);
    pass.setBindGroup(0, this.group0);
    pass.dispatchWorkgroups(groups);
  }

  /** One substep; dt defaults to the stable substep (pass the CPU's dt to compare step by step). */
  async step(dt = Math.min(this.stableDt(), this.cfg.duration - this.time)): Promise<void> {
    const { device, buffers: B, layout: L, n } = this;
    const P = L.params;
    const discharged = this.stats.counts[1] * this.cpu.parcelVolume * 2;
    const tilt1 = this.controller.advance(this.time + dt, dt, discharged);
    const phi1 = -tilt1;
    P.dt = dt;
    P.omega = (phi1 - this.phi) / dt;
    P.c0 = Math.cos(this.phi);
    P.s0 = Math.sin(this.phi);
    P.c1 = Math.cos(phi1);
    P.s1 = Math.sin(phi1);
    packParams(P, this.params);
    device.queue.writeBuffer(B.params, 0, this.params);
    const enc = device.createCommandEncoder({ label: 'substep' });
    // Accumulators (sum, weight, density, occupancy) are contiguous before the stats block.
    enc.clearBuffer(B.ints, 0, P.aStats * 4);
    enc.clearBuffer(B.ints, (P.aStats + STAT_STEP) * 4, (STAT_SLOTS - STAT_STEP) * 4);
    const nc = P.nc;
    const faces = L.faces;
    let pass = enc.beginComputePass({ label: 'projection' });
    this.dispatch(pass, 'markOccupied', n);
    this.dispatch(pass, 'classify', nc);
    this.dispatchGroups(pass, 'compactCount', P.blocks);
    this.dispatchGroups(pass, 'compactScan', 1);
    this.dispatchGroups(pass, 'compactWrite', P.blocks);
    this.dispatch(pass, 'particlesToGrid', n);
    this.dispatch(pass, 'gridInit', faces);
    this.dispatch(pass, 'divergenceRhs', nc);
    this.dispatch(pass, 'pcg', 1, 0);
    this.dispatch(pass, 'gradientVelocity', faces);
    this.dispatch(pass, 'divergenceCheck', nc);
    this.dispatch(pass, 'markValid', faces);
    this.dispatch(pass, 'extrapolate1', faces);
    this.dispatch(pass, 'extrapolate2', faces);
    this.dispatch(pass, 'gridToParticles', n);
    this.dispatch(pass, 'densityScatter', n);
    this.dispatch(pass, 'densityRhs', nc);
    pass.end();
    enc.clearBuffer(B.floats, P.fUc * 4, faces * 4);
    pass = enc.beginComputePass({ label: 'correction and advection' });
    this.dispatch(pass, 'pcg', 1, 1);
    this.dispatch(pass, 'gradientCorrection', faces);
    this.dispatch(pass, 'advect', n);
    pass.end();
    enc.copyBufferToBuffer(B.ints, P.aStats * 4, B.statsRead, 0, STAT_SLOTS * 4);
    device.queue.submit([enc.finish()]);
    await B.statsRead.mapAsync(MAP_READ);
    this.stats = decodeStats(new Int32Array(B.statsRead.getMappedRange().slice(0)));
    B.statsRead.unmap();
    this.phi = phi1;
    this.time += dt;
    this.steps++;
  }

  /** Advance by whole stable substeps (chunk-independent, like the CPU solver). */
  async advance(duration: number): Promise<Diagnostics3D> {
    const end = this.time + duration;
    while (this.time < end - 1e-12 && !this.finished) await this.step();
    return this.diagnostics();
  }

  diagnostics(): Diagnostics3D {
    const v = this.cpu.parcelVolume * 2 * 1e6;
    const s = this.stats;
    return {
      time: this.time,
      steps: this.steps,
      angleDeg: this.controller.angleDeg,
      phase: this.controller.phase,
      particles: this.n,
      grid: [this.cpu.nx, this.cpu.ny, this.cpu.nz],
      dischargedMl: s.counts[1] * v,
      spilledMl: s.counts[2] * v,
      lostMl: s.counts[3] * v,
      inPotMl: s.counts[0] * v,
      pressureIterations: s.pressureIterations,
      pressureFailures: s.pressureFailures,
      maxDivergence: s.maxDivergence,
      interiorDensity: s.interiorDensity,
    };
  }

  /** Share of the poured volume per starting layer (bottom, middle, top), or null before pouring. */
  dischargedFractions(): number[] | null {
    const c = this.stats.dischargedByOrigin;
    const total = c[0] + c[1] + c[2];
    return total > 0 ? c.map((k) => k / total) : null;
  }

  /** Read parcel state back (verification only; rendering never reads back). */
  async readParticles(): Promise<{ pos: Float32Array; vel: Float32Array; status: Uint32Array }> {
    const { device, buffers: B, n } = this;
    const P = this.layout.params;
    const read = async (src: GPUBuffer, offset: number, bytes: number): Promise<ArrayBuffer> => {
      const tmp = device.createBuffer({ size: bytes, usage: MAP_READ | COPY_DST });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(src, offset, tmp, 0, bytes);
      device.queue.submit([enc.finish()]);
      await tmp.mapAsync(MAP_READ);
      const out = tmp.getMappedRange().slice(0);
      tmp.unmap();
      tmp.destroy();
      return out;
    };
    return {
      pos: new Float32Array(await read(B.pos, 0, n * 16)),
      vel: new Float32Array(await read(B.vel, 0, n * 16)),
      status: new Uint32Array(await read(B.flags, P.uStatus * 4, n * 4)),
    };
  }

  /** Size in bytes of a render buffer: xyz of the simulated half and its mirror image. */
  get renderBytes(): number {
    return this.n * 2 * 3 * 4;
  }

  /** Create a buffer the renderer can draw from (storage for the compute write, vertex for drawing). */
  createRenderBuffer(): GPUBuffer {
    return this.device.createBuffer({
      label: 'parcels',
      size: this.renderBytes,
      usage: STORAGE | VERTEX | COPY_SRC,
    });
  }

  /** Write the current parcel positions (and mirror image) into a render buffer on the GPU. */
  writeRenderPositions(target: GPUBuffer): void {
    let group = this.renderGroups.get(target);
    if (!group) {
      group = this.device.createBindGroup({
        layout: this.renderLayout,
        entries: [
          { binding: 0, resource: { buffer: this.buffers.params } },
          { binding: 1, resource: { buffer: this.buffers.pos } },
          { binding: 2, resource: { buffer: target } },
        ],
      });
      this.renderGroups.set(target, group);
    }
    const enc = this.device.createCommandEncoder({ label: 'render positions' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, group);
    const [x, y] = workgroups(this.n);
    pass.dispatchWorkgroups(x, y);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    for (const b of Object.values(this.buffers)) b.destroy();
  }
}
