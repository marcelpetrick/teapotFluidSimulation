// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// Capture the production UI at simulated-time targets, not wall-clock playback speed.
// Usage: npm run build && npx tsx scripts/render-gif.ts <preset|recording3d> <out.gif> [seconds=12] [width=960] [lab|cyber]
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';

const [
  preset = 'teapot-gentle',
  out = 'media/pourlab.gif',
  secondsArg = '12',
  widthArg = '960',
  skin = 'lab',
] = process.argv.slice(2);
const seconds = Number(secondsArg),
  width = Number(widthArg);
if (
  !Number.isFinite(seconds) ||
  seconds <= 0 ||
  !Number.isInteger(width) ||
  width < 320 ||
  !['lab', 'cyber'].includes(skin)
)
  throw new Error('Expected positive seconds, integer width >= 320, and lab or cyber skin');
const recording = preset === 'recording3d';
const dir = mkdtempSync(join(tmpdir(), 'pourlab-gif-'));
const server = spawn('node', ['scripts/serve-subpath.mjs', 'dist', '4176', '/teapotFluidSimulation/'], {
  stdio: 'pipe',
});
let browser: Browser | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Server exited: ${code}`)));
    server.stdout.once('data', () => resolve());
  });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto(
    `http://127.0.0.1:4176/teapotFluidSimulation/?preset=${encodeURIComponent(recording ? 'teapot-gentle' : preset)}`,
  );
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Ready'));
  await page.locator('#mode-light').click();
  await page.locator('#skin').selectOption(skin);
  await page.locator('#prompt').evaluate((e) => ((e as HTMLElement).hidden = true));
  // Crop to the scene, answer and initial map without leaving a half-visible chart.
  if (!recording) await page.addStyleTag({ content: '.results #initialMap + p ~ * { visibility: hidden; }' });
  let maxTime = seconds;
  let recordingDuration = 0;
  if (recording) {
    await page.locator('#open3d').click();
    await page.waitForFunction('window.pourlab.viewer3d', undefined, { timeout: 120_000 });
    await page.locator('#v3play').click();
    recordingDuration = await page.evaluate(
      `(() => { const v = window.pourlab.viewer3d; v.seek(v.frames - 1); const end = v.time; v.seek(0); return end; })()`,
    );
    maxTime = Math.min(seconds, recordingDuration);
    await page.locator('#v3status').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  }
  const clip = await page.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
    const a = document.querySelector('${recording ? '#v3status' : '.toolbar'}').getBoundingClientRect();
    const b = document.querySelector('${recording ? '.view3d-stage' : '.stage canvas'}').getBoundingClientRect();
    const side = ${recording ? 'b' : "document.getElementById('initialMap').nextElementSibling.getBoundingClientRect()"};
    const y = Math.max(0, a.top - 6);
    return { x: 0, y, width: Math.min(1440, Math.max(b.right, side.right) + 12), height: Math.max(b.bottom, side.bottom) + 10 - y };
  })()`);
  const times: number[] = [];
  const readTime = () =>
    page.evaluate(`window.pourlab.${recording ? 'viewer3d' : 'diagnostics'}.time`) as Promise<number>;
  const frames = Math.ceil(maxTime * 15) + 1;
  for (let frame = 0; frame < frames; frame++) {
    const target = Math.min(frame / 15, maxTime);
    if (recording) {
      await page.evaluate(
        `(() => { const v = window.pourlab.viewer3d; v.seek(${target} * (v.frames - 1) / ${recordingDuration}); })()`,
      );
    } else {
      let t = await readTime();
      while (t < target) {
        await page.locator('#step').evaluate((e) => (e as HTMLButtonElement).click());
        // A duration-limited run may have no next frame. Fail rather than hang silently.
        await page.waitForFunction(`window.pourlab.diagnostics.time > ${t}`, undefined, { timeout: 30_000 });
        t = await readTime();
      }
    }
    // The 3D seek updates geometry synchronously; wait for the native renderer to draw it.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    times.push(await readTime());
    await page.screenshot({ path: join(dir, `f${String(frame).padStart(4, '0')}.png`), clip });
  }
  const last = join(dir, `f${String(frames - 1).padStart(4, '0')}.png`);
  for (let k = 0; k < 22; k++) copyFileSync(last, join(dir, `f${String(frames + k).padStart(4, '0')}.png`));
  const filter = `fps=15,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const result = spawnSync(
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
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('ffmpeg failed');
  writeFileSync(
    `${out}.json`,
    JSON.stringify(
      {
        appVersion: await page.locator('#version').textContent(),
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        sourceChanges: execFileSync(
          'git',
          ['status', '--porcelain', '--', 'src', 'scripts/render-gif.ts', 'package.json'],
          { encoding: 'utf8' },
        ).trim(),
        browser: browser.version(),
        preset,
        skin,
        width,
        frames,
        holdFrames: 22,
        fps: 15,
        mode: recording
          ? 'Offline CPU recording in the browser 3D viewer; not live computation'
          : '2D solver, stepped to 1/15-second targets with whole stable substeps',
        simulationTimes: times,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${out} (${frames} frames + hold)`);
} finally {
  await browser?.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
