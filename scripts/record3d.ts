// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Record the offline 3D reference pour for interactive browser playback (public/data/pour3d.bin.gz).
// Every `stride`-th parcel is kept, 10 frames per simulated second.
// Usage: npx tsx scripts/record3d.ts [cellMm] [stride] [out]
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { gentlePour3D } from '../src/sim3d/presets3d';
import { Simulation3D } from '../src/sim3d/solver3d';
import { encodeRecording, type RecordingHeader } from '../src/view3d/format';

const [cellArg = '5', strideArg = '3', out = 'public/data/pour3d.bin.gz'] = process.argv.slice(2);
const stride = Number(strideArg);
const fps = 10;
const sim = new Simulation3D(gentlePour3D(Number(cellArg), 14));
const keep: number[] = [];
for (let p = 0; p < sim.n; p += stride) keep.push(p);
const P = keep.length;
const frames: Float32Array[] = [];
const angles: number[] = [];
const poured: number[][] = [];
const perParcelMl = sim.parcelVolume * 2 * 1e6;
const capture = () => {
  const f = new Float32Array(3 * P);
  keep.forEach((p, k) => {
    f[3 * k] = sim.x[p];
    f[3 * k + 1] = sim.y[p];
    f[3 * k + 2] = sim.z[p];
  });
  frames.push(f);
  angles.push(sim.controller.angleDeg);
  const c = [0, 0, 0];
  for (const p of sim.dischargeOrder) c[sim.origin[p]]++;
  poured.push(c.map((n) => n * perParcelMl));
};
const t0 = performance.now();
let doneAt = -1;
capture();
while (!sim.finished) {
  sim.advance(1 / fps);
  capture();
  if (sim.controller.phase === 'done' && doneAt < 0) doneAt = sim.time;
  if (doneAt >= 0 && sim.time > doneAt + 1.5) break;
  if (frames.length % 10 === 0)
    process.stderr.write(
      `t=${sim.time.toFixed(1)} poured=${sim.diagnostics().dischargedMl.toFixed(0)} mL ${((performance.now() - t0) / 1000).toFixed(0)}s\n`,
    );
}
const shares = sim.dischargedFractions() ?? [0, 0, 0];
const header: RecordingHeader = {
  version: 1,
  frames: frames.length,
  parcels: P,
  fps,
  quantum: 0.00025,
  cellMm: Number(cellArg),
  simulatedParcels: sim.n,
  teapot: sim.pot.cfg,
  pivot: sim.cfg.pivot,
  pivotWorld: sim.pivotWorld,
  zOffset: sim.h,
  domain: [sim.nx * sim.h, sim.ny * sim.h, sim.nz * sim.h],
  angles,
  poured,
  finalShares: shares,
  label: `Recorded offline 3D simulation (${Number(cellArg)} mm cells, ${sim.n} parcels in the half pot); every ${stride}th parcel shown.`,
};
const origin = Uint8Array.from(keep.map((p) => sim.origin[p]));
const raw = encodeRecording(header, origin, frames);
const gz = gzipSync(raw, { level: 9 });
writeFileSync(out, gz);
console.log(
  `wrote ${out}: ${frames.length} frames, ${P} parcels, ${(raw.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(1)} MB gzip; poured ${sim.diagnostics().dischargedMl.toFixed(1)} mL, shares ${shares.map((s) => (s * 100).toFixed(1)).join('/')} %`,
);
