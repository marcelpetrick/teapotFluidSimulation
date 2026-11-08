// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Render a looping showcase GIF of a preset from the production build. Frames are captured
// deterministically with single simulation steps (4 steps = 1/15 s of simulated time per frame,
// played back at 15 fps = real time), then assembled with ffmpeg using an optimised palette.
// Usage: npm run build && npx tsx scripts/render-gif.ts <presetId> <out.gif> [maxSeconds] [width]
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [preset = 'teapot-gentle', out = 'media/pourlab.gif', maxSecondsArg = '9', widthArg = '960'] =
  process.argv.slice(2);
const maxSeconds = Number(maxSecondsArg);
const width = Number(widthArg);
const dir = mkdtempSync(join(tmpdir(), 'pourlab-gif-'));
const server = spawn('node', ['scripts/serve-subpath.mjs', 'dist', '4176', '/teapotFluidSimulation/'], {
  stdio: 'pipe',
});
await new Promise((r) => server.stdout.once('data', r));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:4176/teapotFluidSimulation/?preset=${preset}`);
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Ready'));
  await page.locator('#prompt').evaluate((e) => ((e as HTMLElement).hidden = true));
  const clip = await page.evaluate(`(() => {
    const a = document.querySelector('.stage canvas').getBoundingClientRect();
    const b = document.getElementById('initialMap').nextElementSibling.getBoundingClientRect();
    const top = document.querySelector('.toolbar').getBoundingClientRect().top;
    return { x: 0, y: Math.max(0, top - 6), width: Math.min(1440, b.right + 12), height: Math.max(a.bottom + 4, b.bottom + 10) - top + 6 };
  })()`);
  const state = () =>
    page.evaluate(
      `(() => { const d = window.pourlab.diagnostics; return { t: d.time, phase: d.phase }; })()`,
    ) as Promise<{
      t: number;
      phase: string;
    }>;
  let frame = 0;
  let doneAt = -1;
  for (;;) {
    await page.screenshot({ path: join(dir, `f${String(frame).padStart(4, '0')}.png`), clip: clip as never });
    frame++;
    for (let k = 0; k < 4; k++) {
      const before = (await state()).t;
      await page.locator('#step').click();
      await page.waitForFunction(`window.pourlab.diagnostics.time > ${before}`);
    }
    const s = await state();
    if (s.phase === 'done' && doneAt < 0) doneAt = s.t;
    if ((doneAt >= 0 && s.t > doneAt + 1.2) || s.t >= maxSeconds) break;
  }
  // Hold the final frame for 1.5 s before looping.
  const last = join(dir, `f${String(frame - 1).padStart(4, '0')}.png`);
  for (let k = 0; k < 22; k++)
    spawnSync('cp', [last, join(dir, `f${String(frame + k).padStart(4, '0')}.png`)]);
  await browser.close();
  const filter = `fps=15,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      '15',
      '-i',
      join(dir, 'f%04d.png'),
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
  console.log(`wrote ${out} (${frame} frames + hold)`);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
