// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Offline playback of the 3D reference pour: runs the 3D solver and renders a side view
// (both halves of the pot, parcels coloured by starting layer, depth-shaded, the tilting pot
// outline and an accounting glass bar) every 1/15 s of simulated time, then assembles a looping
// GIF with ffmpeg. It is a recording of a precomputed run, not a live browser simulation.
// Usage: npx tsx scripts/render3d.ts <out.gif> [cellMm] [seconds] [lab|cyber]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gentlePour3D } from '../src/sim3d/presets3d';
import { DISCHARGED, IN_POT, Simulation3D } from '../src/sim3d/solver3d';

const [out = 'media/pourlab-3d.gif', cellArg = '5', secondsArg = '14', look = 'cyber'] =
  process.argv.slice(2);
const cyber = look === 'cyber';
const W = 760;
const H = 560;
const bg: [number, number, number] = cyber ? [6, 9, 18] : [252, 252, 251];
const wallColour: [number, number, number] = cyber ? [125, 249, 255] : [61, 70, 82];
const layers: [number, number, number][] = cyber
  ? [
      [46, 107, 255],
      [40, 176, 48],
      [176, 75, 255],
    ]
  : [
      [0, 114, 178],
      [0, 158, 115],
      [213, 94, 0],
    ];

const sim = new Simulation3D(gentlePour3D(Number(cellArg), Number(secondsArg)));
const glassW = 90;
const scale = Math.min((W - glassW - 30) / (sim.nx * sim.h), (H - 20) / (sim.ny * sim.h));
const ox = 10;
const oy = H - 10;
const px = (x: number) => ox + x * scale;
const py = (y: number) => oy - y * scale;

const img = new Float32Array(W * H * 3);
function clear(): void {
  for (let i = 0; i < W * H; i++) img.set(bg, i * 3);
}
function blend(x: number, y: number, c: [number, number, number], a: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const k = (yi * W + xi) * 3;
  for (let ch = 0; ch < 3; ch++) img[k + ch] = img[k + ch] * (1 - a) + c[ch] * a;
}
function disk(x: number, y: number, r: number, c: [number, number, number], a: number): void {
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 0.5) blend(x + dx, y + dy, c, a);
}
function line(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thick: number,
  c: [number, number, number],
): void {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let t = 0; t <= n; t++) disk(x0 + ((x1 - x0) * t) / n, y0 + ((y1 - y0) * t) / n, thick, c, 0.9);
}
function rect(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void {
  for (let y = Math.round(y0); y <= Math.round(y1); y++)
    for (let x = Math.round(x0); x <= Math.round(x1); x++) blend(x, y, c, 1);
}

/** Pot outline in local coordinates (side view), drawn with the current tilt. */
function drawPot(phi: number): void {
  const t = sim.pot.cfg;
  const p = sim.pot;
  const hw = t.wall / 2;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const [pvx, pvy] = sim.cfg.pivot;
  const [pwx, pwy] = sim.pivotWorld;
  const tw = (lx: number, ly: number): [number, number] => {
    const rx = lx - pvx;
    const ry = ly - pvy;
    return [px(c * rx - s * ry + pwx), py(s * rx + c * ry + pwy)];
  };
  const seg = (a: [number, number], b: [number, number]) => {
    const [x0, y0] = tw(a[0], a[1]);
    const [x1, y1] = tw(b[0], b[1]);
    line(x0, y0, x1, y1, Math.max(1, Math.round(t.wall * scale * 0.5)), wallColour);
  };
  const R = t.radius + hw;
  const nx = -p.dy;
  const ny = p.dx;
  const off = t.boreRadius + hw;
  const lowStart: [number, number] = [R, p.ay + (R - p.ax) * (p.dy / p.dx) - off / p.dx];
  const upStart: [number, number] = [R, p.ay + (R - p.ax) * (p.dy / p.dx) + off / p.dx];
  seg([-R, t.height], [-R, -hw]);
  seg([-R, -hw], [R, -hw]);
  seg([R, -hw], lowStart);
  seg(upStart, [R, t.height]);
  seg(lowStart, [p.tipX - nx * off, p.tipY - ny * off]);
  seg(upStart, [p.tipX + nx * off, p.tipY + ny * off]);
}

function drawFrame(): void {
  clear();
  // Parcels: far ones first (depth = |z|), shaded darker with depth.
  const idx: number[] = [];
  for (let p = 0; p < sim.n; p++) if (sim.status[p] === IN_POT || sim.status[p] === DISCHARGED) idx.push(p);
  idx.sort((a, b) => sim.z[b] - sim.z[a]);
  const zMax = sim.pot.cfg.radius;
  for (const p of idx) {
    const depth = Math.min(1, (sim.z[p] - sim.h) / zMax);
    const shade = 1 - 0.45 * depth;
    const col = layers[sim.origin[p]].map((v) => v * shade) as [number, number, number];
    disk(px(sim.x[p]), py(sim.y[p]), 1, col, 0.55);
  }
  drawPot(-sim.controller.angle);
  // Accounting glass: poured volume by starting layer, bottom layer first.
  const gx0 = W - glassW;
  const gx1 = W - 20;
  const gy1 = H - 40;
  const gy0 = gy1 - 300;
  const cap = 600; // mL
  const byOrigin = [0, 0, 0];
  for (const p of sim.dischargeOrder) byOrigin[sim.origin[p]]++;
  const perParcel = sim.parcelVolume * 2 * 1e6;
  let level = gy1;
  for (let k = 0; k < 3; k++) {
    const hgt = ((byOrigin[k] * perParcel) / cap) * (gy1 - gy0);
    rect(gx0 + 3, level - hgt, gx1 - 3, level, layers[k]);
    level -= hgt;
  }
  line(gx0, gy0, gx0, gy1, 1, wallColour);
  line(gx1, gy0, gx1, gy1, 1, wallColour);
  line(gx0, gy1, gx1, gy1, 1, wallColour);
}

function writePpm(file: string): void {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) buf[i] = Math.max(0, Math.min(255, Math.round(img[i])));
  writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), buf]));
}

const dir = mkdtempSync(join(tmpdir(), 'pourlab-3d-'));
try {
  let frame = 0;
  let doneAt = -1;
  const t0 = performance.now();
  while (!sim.finished) {
    drawFrame();
    writePpm(join(dir, `f${String(frame++).padStart(4, '0')}.ppm`));
    sim.advance(1 / 15);
    if (sim.controller.phase === 'done' && doneAt < 0) doneAt = sim.time;
    if (doneAt >= 0 && sim.time > doneAt + 1.2) break;
    if (frame % 15 === 0)
      process.stderr.write(
        `t=${sim.time.toFixed(1)} poured=${sim.diagnostics().dischargedMl.toFixed(0)} mL wall=${((performance.now() - t0) / 1000).toFixed(0)}s\n`,
      );
  }
  drawFrame();
  for (let k = 0; k < 22; k++) writePpm(join(dir, `f${String(frame++).padStart(4, '0')}.ppm`));
  const filter =
    'fps=15,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      '15',
      '-i',
      join(dir, 'f%04d.ppm'),
      '-vf',
      filter,
      '-loop',
      '0',
      out,
    ],
    {
      stdio: 'inherit',
    },
  );
  if (r.status !== 0) throw new Error('ffmpeg failed');
  const f = sim.dischargedFractions();
  console.log(
    `wrote ${out}: ${frame} frames, poured ${sim.diagnostics().dischargedMl.toFixed(1)} mL, shares ${f ? f.map((x) => (x * 100).toFixed(1)).join('/') : '-'} %`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
