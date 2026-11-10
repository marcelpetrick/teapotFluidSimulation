// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// @vitest-environment happy-dom
//
// Host-side tests of the WebGPU 3D solver with a fake device. The kernels themselves are verified
// against the CPU solver in a real browser (e2e/gpu.spec.ts, scripts/verify-gpu.ts).
import { describe, expect, it } from 'vitest';
import {
  buildLayout,
  FIELDS,
  floatFromBits,
  packParams,
  packSolve,
  paramsBytes,
  paramsStruct,
  STAT,
  STAT_SLOTS,
} from '../src/gpu3d/layout';
import { CPU_5MM, startGpuCheck } from '../src/gpu3d/page';
import { pcgWgsl, renderWgsl, solverWgsl } from '../src/gpu3d/shaders';
import {
  decodeStats,
  GpuSimulation3D,
  pcgThreads,
  requestSolverDevice,
  workgroups,
} from '../src/gpu3d/solver';
import { compareSteps, runPour } from '../src/gpu3d/verify';
import { gentlePour3D } from '../src/sim3d/presets3d';
import { Simulation3D } from '../src/sim3d/solver3d';
import { fakeGpu, type FakeBuffer } from './fakeGpu';

const small = () => gentlePour3D(10, 0.05);

describe('gpu3d layout', () => {
  it('declares every uniform field once and packs u32 and f32 values', () => {
    const names = FIELDS.map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
    expect(paramsBytes() % 16).toBe(0);
    for (const n of names) expect(paramsStruct()).toContain(`  ${n}: `);
    const p = buildLayout(new Simulation3D(small())).params;
    const buf = packParams(p);
    expect(new Uint32Array(buf)[0]).toBe(p.nx);
    expect(new Float32Array(buf)[names.indexOf('h')]).toBeCloseTo(p.h, 7);
    expect(() => packParams({ ...p, h: undefined as unknown as number })).toThrow('missing uniform field h');
  });

  it('places fields without overlap inside the three buffers', () => {
    const sim = new Simulation3D(small());
    const L = buildLayout(sim);
    const P = L.params;
    expect(L.faces).toBe(P.nu + P.nv + P.nw);
    expect(P.fV - P.fU).toBe(P.nu);
    expect(P.fW - P.fV).toBe(P.nv);
    const floats = ['fU', 'fUp', 'fUc', 'fRhs', 'fQ', 'fS', 'fR', 'fZ', 'fAs', 'fDiag', 'fCd'].map(
      (k) => P[k],
    );
    expect([...floats].sort((a, b) => a - b)).toEqual(floats);
    expect(P.fCd + P.nc).toBe(L.floats);
    expect(P.uOrigin + P.n).toBe(L.flags);
    expect(P.aStats + STAT_SLOTS).toBe(L.ints);
    expect(P.blocks * 256).toBeGreaterThanOrEqual(P.nc);
  });

  it('packs solve settings and decodes float bits', () => {
    const b = packSolve(1e-6, 400, 12, true);
    expect(new Float32Array(b)[0]).toBeCloseTo(1e-6, 12);
    expect([...new Uint32Array(b).slice(1)]).toEqual([400, 12, 1]);
    expect(new Uint32Array(packSolve(1e-4, 80, 13, false))[3]).toBe(0);
    const f = new Float32Array([2.5]);
    expect(floatFromBits(new Int32Array(f.buffer)[0])).toBe(2.5);
  });
});

describe('gpu3d shaders', () => {
  // A few WGSL reserved words that are tempting identifiers; using one fails shader compilation.
  const reserved = [
    'shared',
    'target',
    'as',
    'filter',
    'type',
    'self',
    'from',
    'set',
    'get',
    'match',
    'move',
  ];
  const declared = (src: string) =>
    [...src.matchAll(/\b(?:let|var|fn|const)\s+([A-Za-z_]\w*)|\(([A-Za-z_]\w*):|,\s*([A-Za-z_]\w*):/g)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );

  it('declares no reserved identifiers and every entry point the host uses', () => {
    for (const src of [solverWgsl(), pcgWgsl(256), renderWgsl()])
      for (const name of declared(src)) expect(reserved, name).not.toContain(name);
    for (const entry of ['markOccupied', 'classify', 'compactCount', 'compactScan', 'compactWrite', 'advect'])
      expect(solverWgsl()).toContain(`fn ${entry}(`);
  });

  it('sizes the pressure solve from the thread count and Chebyshev settings', () => {
    const src = pcgWgsl(1024, 3, 0.2, 4);
    expect(src).toContain('const T: u32 = 1024u;');
    expect(src).toContain('const K: u32 = 4u;');
    expect(src).toContain('const DEGREE: u32 = 3u;');
    expect(src).toContain('const G: u32 = 32u;');
    expect(src).toContain('const THETA: f32 = 1.1;');
    expect(pcgWgsl(256)).toContain('const RUN: u32 = 16u;');
  });
});

describe('gpu3d host', () => {
  it('derives thread counts and workgroup grids', () => {
    expect(pcgThreads({ maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256 })).toBe(256);
    expect(pcgThreads({ maxComputeInvocationsPerWorkgroup: 1536, maxComputeWorkgroupSizeX: 1024 })).toBe(
      1024,
    );
    expect(pcgThreads({ maxComputeInvocationsPerWorkgroup: 600, maxComputeWorkgroupSizeX: 1024 })).toBe(512);
    expect(workgroups(0)).toEqual([1, 1]);
    expect(workgroups(64 * 10)).toEqual([10, 1]);
    expect(workgroups(64 * 70000)).toEqual([65535, 2]);
  });

  it('decodes the stats block', () => {
    const raw = new Int32Array(STAT_SLOTS);
    raw[STAT.inPot] = 7;
    raw[STAT.discharged] = 3;
    raw[STAT.originTop] = 2;
    raw[STAT.interiorCount] = 2;
    raw[STAT.interiorSum] = 3 * 65536;
    raw[STAT.maxSpeedSq] = new Int32Array(new Float32Array([4]).buffer)[0];
    const s = decodeStats(raw);
    expect(s.counts).toEqual([7, 3, 0, 0]);
    expect(s.dischargedByOrigin).toEqual([0, 0, 2]);
    expect(s.interiorDensity).toBe(1.5);
    expect(s.maxSpeedSq).toBe(4);
    expect(decodeStats(new Int32Array(STAT_SLOTS)).interiorDensity).toBe(1);
  });

  it('requests a high-performance device with the adapter limits', async () => {
    await expect(requestSolverDevice({ requestAdapter: async () => null } as unknown as GPU)).rejects.toThrow(
      'no WebGPU adapter',
    );
    let asked: GPUDeviceDescriptor | undefined;
    const gpu = {
      requestAdapter: async (o: GPURequestAdapterOptions) => {
        expect(o.powerPreference).toBe('high-performance');
        return {
          limits: {
            maxComputeInvocationsPerWorkgroup: 1024,
            maxComputeWorkgroupSizeX: 1024,
            maxStorageBufferBindingSize: 1 << 30,
            maxBufferSize: 1 << 30,
          },
          info: { vendor: 'test' },
          requestDevice: async (d: GPUDeviceDescriptor) => {
            asked = d;
            return { id: 'device' };
          },
        };
      },
    } as unknown as GPU;
    const r = await requestSolverDevice(gpu);
    expect(r.info.vendor).toBe('test');
    expect(asked?.requiredLimits?.maxComputeInvocationsPerWorkgroup).toBe(1024);
  });

  it('uploads the seeded CPU state and encodes one command buffer per substep', async () => {
    const g = fakeGpu();
    const sim = new GpuSimulation3D(g.device, small());
    expect(sim.threads).toBe(256);
    expect(g.calls).toContain('module:solver');
    expect(g.calls).toContain('module:pcg');
    const { pos, status } = await sim.readParticles();
    expect(pos[0]).toBeCloseTo(sim.cpu.x[0], 6);
    expect(pos[4 * 5 + 2]).toBeCloseTo(sim.cpu.z[5], 6);
    expect(status.every((s) => s === 0)).toBe(true);
    expect(sim.dischargedFractions()).toBeNull();
    g.dispatches.length = 0;
    await sim.step();
    expect(sim.steps).toBe(1);
    expect(sim.time).toBeCloseTo(1 / 200, 9);
    const names = g.dispatches.map((d) => d.name);
    expect(names.slice(0, 3)).toEqual(['markOccupied', 'classify', 'compactCount']);
    expect(names.filter((n) => n === 'pcg')).toHaveLength(2);
    expect(names.at(-1)).toBe('advect');
    // The stats block came back through the readback buffer: all parcels still in the pot.
    expect(sim.stats.counts[0]).toBe(sim.n);
    const d = await sim.advance(0.02);
    expect(d.inPotMl).toBeCloseTo(1500, 6);
    expect(d.grid).toEqual([sim.cpu.nx, sim.cpu.ny, sim.cpu.nz]);
    sim.stats.dischargedByOrigin = [1, 2, 1];
    expect(sim.dischargedFractions()).toEqual([0.25, 0.5, 0.25]);
  });

  it('pipelines the stats readback: a substep sees the stats of the one before the last', async () => {
    const g = fakeGpu();
    const sim = new GpuSimulation3D(g.device, small());
    const ints = g.buffers.find((b) => b.label === 'ints') as FakeBuffer;
    const statsAt = sim.layout.params.aStats * 4;
    const setInPot = (k: number) => new DataView(ints.data.buffer).setInt32(statsAt, k, true);
    setInPot(11);
    await sim.step(); // submitted; nothing older to wait for
    expect(sim.stats.counts[0]).toBe(sim.n);
    setInPot(22);
    await sim.step(); // now holds the stats copied by the first substep
    expect(sim.stats.counts[0]).toBe(11);
    await sim.sync();
    expect(sim.stats.counts[0]).toBe(22);
    await sim.sync(); // nothing pending: no change
    expect(sim.stats.counts[0]).toBe(22);
  });

  it('lets readbacks in flight end quietly when the run is stopped, and reports other failures', async () => {
    const g = fakeGpu();
    const sim = new GpuSimulation3D(g.device, small());
    await sim.step();
    const before = sim.stats;
    const reading = sim.readRenderPositions();
    sim.destroy();
    await sim.sync();
    expect(sim.stats).toEqual(before);
    expect((await reading).length).toBe(0);
    const h = fakeGpu();
    const other = new GpuSimulation3D(h.device, small());
    await other.readRenderPositions(); // creates the render buffers
    for (const b of h.buffers) b.failMap = true;
    await other.step();
    await expect(other.sync()).rejects.toThrow('mapping failed');
    await expect(other.readRenderPositions()).rejects.toThrow('mapping failed');
  });

  it('reads back render positions (both halves) and reuses its buffers', async () => {
    const g = fakeGpu();
    const sim = new GpuSimulation3D(g.device, small());
    const a = await sim.readRenderPositions();
    expect(a.length * 4).toBe(sim.renderBytes);
    await sim.readRenderPositions();
    expect(g.dispatches.filter((d) => d.name === 'render')).toHaveLength(2);
    expect(g.buffers.filter((b) => b.label === 'renderRead')).toHaveLength(1);
    sim.destroy();
    expect(g.buffers.filter((b) => b.label === 'pos').every((b) => b.destroyed)).toBe(true);
  });
});

describe('gpu3d verification harness', () => {
  it('compares the GPU parcels with the CPU solver step by step', async () => {
    const g = fakeGpu();
    const r = await compareSteps(g.device, small(), 3);
    // The fake runs no kernels, so the GPU parcels stay at the seeded positions.
    expect(r.steps).toBe(3);
    expect(r.parcels).toBeGreaterThan(1000);
    expect(r.rmsPositionCells).toBeGreaterThan(0);
    expect(r.maxPositionCells).toBeGreaterThanOrEqual(r.rmsPositionCells);
    expect(r.statusMismatches).toBe(0);
    expect(r.relativeVelocityRms).toBeGreaterThan(0);
  });

  it('runs a whole pour and reports the real-time factor', async () => {
    const g = fakeGpu();
    const seen: number[] = [];
    const r = await runPour(g.device, 10, 0.6, (d) => seen.push(d.time));
    expect(r.simulatedSeconds).toBeCloseTo(0.6, 6);
    expect(seen.length).toBe(2);
    expect(r.dischargedFractions).toBeNull();
    expect(r.realTimeFactor).toBeGreaterThan(0);
  });
});

describe('gpu3d check page', () => {
  const page = () => {
    document.body.innerHTML =
      '<aside id="webgpuHelp" hidden></aside><p id="gpuActions" hidden></p><p id="adapter"></p><button id="compare" disabled></button><button id="pour" disabled></button><pre id="out"></pre>';
  };

  it('explains the fallback without WebGPU or without an adapter', async () => {
    page();
    await startGpuCheck(document, undefined);
    expect(document.getElementById('adapter')?.textContent).toContain('WebGPU is not enabled or available');
    expect(document.getElementById('webgpuHelp')?.hidden).toBe(false);
    expect(document.getElementById('gpuActions')?.hidden).toBe(true);
    await startGpuCheck(document, { requestAdapter: async () => null } as unknown as GPU);
    expect(document.getElementById('adapter')?.textContent).toContain(
      'WebGPU unavailable: no WebGPU adapter',
    );
  });

  it('enables the checks and logs their results', async () => {
    page();
    const g = fakeGpu();
    const listeners: ((e: unknown) => void)[] = [];
    (g.device as unknown as { addEventListener: unknown }).addEventListener = (
      _: string,
      f: (e: unknown) => void,
    ) => listeners.push(f);
    const gpu = {
      requestAdapter: async () => ({
        limits: g.device.limits,
        info: { vendor: 'fake', architecture: '', description: '' },
        requestDevice: async () => g.device,
      }),
    } as unknown as GPU;
    await startGpuCheck(document, gpu);
    expect(document.getElementById('adapter')?.textContent).toBe('WebGPU adapter: fake');
    expect(document.getElementById('webgpuHelp')?.hidden).toBe(true);
    expect(document.getElementById('gpuActions')?.hidden).toBe(false);
    const api = (globalThis as unknown as { pourlabGpu: Record<string, unknown> }).pourlabGpu;
    listeners[0]({ error: { message: 'boom' } });
    expect(document.getElementById('out')?.textContent).toContain('GPU error: boom');
    api.compare = async () => ({
      steps: 40,
      simulatedSeconds: 0.2,
      parcels: 10,
      rmsPositionCells: 1e-5,
      maxPositionCells: 2e-5,
      relativeVelocityRms: 1e-6,
      statusMismatches: 0,
    });
    api.pour = async () => ({
      dischargedMl: 405.8,
      dischargedFractions: [0.28, 0.52, 0.2],
      lostMl: 0,
      realTimeFactor: 1.2,
    });
    const out = document.getElementById('out') as HTMLElement;
    (document.getElementById('compare') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(out.textContent).toContain('40 substeps');
    (document.getElementById('pour') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(out.textContent).toContain(`Poured 405.8 mL (CPU ${CPU_5MM.dischargedMl} mL)`);
    expect(out.textContent).toContain('1.20x real time');
  });
});
