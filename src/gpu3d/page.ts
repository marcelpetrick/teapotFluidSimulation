// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Entry of verify-gpu.html: runs the GPU-vs-CPU checks in the visitor's browser. The functions are
// also exposed on window.pourlabGpu for the automated browser tests and scripts/verify-gpu.ts.

import { gentlePour3D } from '../sim3d/presets3d';
import { requestSolverDevice } from './solver';
import { compareSteps, runPour } from './verify';

/** The 5 mm CPU reference row of benchmarks/run3d.json. */
export const CPU_5MM = { dischargedMl: 406.78, fractions: [0.2771, 0.5194, 0.2035] };

export async function startGpuCheck(doc: Document, gpu: GPU | undefined): Promise<void> {
  const out = doc.getElementById('out') as HTMLElement;
  const adapterEl = doc.getElementById('adapter') as HTMLElement;
  const log = (s: string) => {
    out.textContent += `${s}\n`;
  };
  if (!gpu) {
    adapterEl.textContent = 'This browser has no WebGPU. The 3D view keeps playing the CPU recording.';
    return;
  }
  let device: GPUDevice;
  try {
    const r = await requestSolverDevice(gpu);
    device = r.device;
    device.addEventListener('uncapturederror', (e) => {
      const msg = (e as GPUUncapturedErrorEvent).error.message;
      console.error(msg);
      log(`GPU error: ${msg}`);
    });
    adapterEl.textContent =
      `WebGPU adapter: ${r.info.vendor || 'unknown vendor'} ${r.info.architecture || ''} ${r.info.description || ''}`.trim();
  } catch (e) {
    adapterEl.textContent = `WebGPU unavailable: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  const api = {
    compare: (cellMm: number, steps: number) => compareSteps(device, gentlePour3D(cellMm, 20), steps),
    pour: (cellMm: number) =>
      runPour(device, cellMm, 20, (d) =>
        log(`t=${d.time.toFixed(1)} s ${d.phase} poured ${d.dischargedMl.toFixed(0)} mL`),
      ),
  };
  (globalThis as unknown as { pourlabGpu: typeof api }).pourlabGpu = api;
  const compareBtn = doc.getElementById('compare') as HTMLButtonElement;
  const pourBtn = doc.getElementById('pour') as HTMLButtonElement;
  compareBtn.disabled = false;
  pourBtn.disabled = false;
  compareBtn.addEventListener('click', async () => {
    compareBtn.disabled = true;
    const r = await api.compare(10, 40);
    log(
      `${r.steps} substeps (${r.simulatedSeconds.toFixed(3)} s), ${r.parcels} parcels: position RMS ${r.rmsPositionCells.toExponential(2)} cells, max ${r.maxPositionCells.toExponential(2)} cells, velocity RMS ${(100 * r.relativeVelocityRms).toFixed(3)} %, status mismatches ${r.statusMismatches}`,
    );
    compareBtn.disabled = false;
  });
  pourBtn.addEventListener('click', async () => {
    pourBtn.disabled = true;
    const r = await api.pour(5);
    const f = (r.dischargedFractions ?? [0, 0, 0]).map((x) => (100 * x).toFixed(1));
    log(
      `Poured ${r.dischargedMl.toFixed(1)} mL (CPU ${CPU_5MM.dischargedMl} mL), shares bottom/middle/top ${f.join(' / ')} % (CPU ${CPU_5MM.fractions.map((x) => (100 * x).toFixed(1)).join(' / ')} %), lost ${r.lostMl.toFixed(1)} mL, ${r.realTimeFactor.toFixed(2)}x real time`,
    );
    pourBtn.disabled = false;
  });
}

if (typeof document !== 'undefined' && document.getElementById('compare'))
  void startGpuCheck(document, (navigator as Navigator & { gpu?: GPU }).gpu);
