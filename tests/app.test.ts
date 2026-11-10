// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type AppDeps, type WorkerLike } from '../src/ui/app';
import { SimulationHost, type FromWorker, type ToWorker } from '../src/worker/host';
import { fakeAudio, fakeCtx } from './helpers';
import type { AudioCtxLike } from '../src/audio/soundscape';

/** In-process worker: the real SimulationHost, asynchronous delivery like postMessage. */
class FakeWorker implements WorkerLike {
  host = new SimulationHost('test');
  onmessage: ((e: { data: FromWorker }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: ToWorker[] = [];
  queue: Promise<void> = Promise.resolve();
  clock = 0;
  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
    // Emulate the worker's background stepping loop: 100 ms of wall time per frame request.
    if (msg.type === 'frame') {
      this.host.pump(this.clock);
      this.clock += 100;
      this.host.pump(this.clock, Infinity);
    }
    const out = this.host.handle(msg);
    this.queue = this.queue.then(() => {
      for (const o of out) this.onmessage?.({ data: o });
    });
  }
}

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

function setup(
  search = '?preset=tank-tilt&duration=2',
  ctxOk = true,
  audioOk = true,
  stored: [string, string][] = [],
) {
  const audio = fakeAudio();
  const viewer3d = {
    frames: 50,
    frame: 0,
    time: 0,
    playing: true,
    speed: 1,
    onFrame: null as ((f: number) => void) | null,
    seek(f: number) {
      this.frame = f;
      this.onFrame?.(f);
    },
    resetView() {
      this.reset = true;
    },
    reset: false,
    resize() {},
    poured: () => [100, 200, 100],
    angleDeg: () => 25,
    applyTheme() {
      viewer3d.themed++;
    },
    themed: 0,
  };
  const live3d = {
    live: true,
    manual: false,
    finished: false,
    frames: 1,
    frame: 0,
    time: 2,
    playing: true,
    speed: 1,
    onFrame: null as ((f: number) => void) | null,
    restarts: [] as (string | undefined)[],
    tilts: [] as number[],
    disposed: 0,
    seek() {},
    resetView() {},
    resize() {},
    poured: () => [0, 0, 0],
    angleDeg: () => 5,
    applyTheme() {},
    restart(p?: string) {
      this.restarts.push(p);
      this.manual = p === 'manual-5';
    },
    setTilt(a: number) {
      this.tilts.push(a);
    },
    realTimeFactor: () => 1,
    dispose() {
      this.disposed++;
    },
  };
  (viewer3d as unknown as { dispose: () => void }).dispose = () => undefined;
  const prefs = new Map<string, string>(stored);
  document.body.innerHTML = body;
  const worker = new FakeWorker();
  let frameCb: ((t: number) => void) | null = null;
  const downloads: string[] = [];
  const replaced: string[] = [];
  const copied: string[] = [];
  let clock = 0;
  const deps: AppDeps = {
    doc: document,
    worker,
    getContext: () => (ctxOk ? fakeCtx() : null),
    schedule: (cb) => {
      frameCb = cb;
    },
    now: () => clock,
    location: { search, pathname: '/app/', origin: 'https://example.test' },
    history: { replaceState: (_a, _b, url) => replaced.push(url) },
    download: (name) => downloads.push(name),
    copy: async (t) => {
      copied.push(t);
    },
    reducedMotion: true,
    version: '1.2.3',
    audio: () => (audioOk ? (audio as unknown as AudioCtxLike) : null),
    open3d: async () => {
      if (search.includes('no3d')) throw new Error('WebGL is not available in this browser');
      return viewer3d;
    },
    open3dLive: async (_c, _t, preset) => {
      if (search.includes('nolive')) throw new Error('no WebGPU adapter');
      live3d.manual = preset === 'manual-5';
      return live3d;
    },
    webgpu: !search.includes('nowebgpu'),
    prefs: { get: (k) => prefs.get(k) ?? null, set: (k, v) => void prefs.set(k, v) },
  };
  const app = new App(deps);
  app.start();
  const tick = async (ms = 50) => {
    clock += ms;
    frameCb?.(clock);
    void ms;
    await worker.queue;
  };
  return {
    app,
    deps,
    worker,
    tick,
    downloads,
    replaced,
    copied,
    audio,
    prefs,
    viewer3d,
    live3d,
    settle: () => worker.queue,
  };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

describe('App (integration with the real simulation host)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('initialises from the URL and shows ready state, legend and limits', async () => {
    const t = setup();
    await t.settle();
    expect($('version').textContent).toBe('v1.2.3');
    expect($('status').textContent).toMatch(/Ready: \d+ parcels/);
    expect($('status').textContent).toMatch(/Reduced motion/);
    expect($('legend').children).toHaveLength(4);
    expect($('legend').textContent).toMatch(/hollow ring/);
    // Every control and every settings field has an explanatory tooltip.
    expect($('pour').title).toMatch(/Start the experiment/);
    expect($('set-ppc').title).toMatch(/parcels per grid cell/);
    expect($('set-ppc').parentElement!.title).toBe($('set-ppc').title);
    expect($('set-quality').getAttribute('aria-description')).toMatch(/Resolution/);
    for (const el of Array.from(document.querySelectorAll('button, select, input')))
      expect((el as HTMLElement).title, (el as HTMLElement).id).not.toBe('');
    expect($('limits').children.length).toBeGreaterThan(5);
    expect($('pour').textContent).toBe('Tilt and return');
    expect(($('preset') as HTMLSelectElement).value).toBe('tank-tilt');
    expect(($('set-duration') as HTMLInputElement).value).toBe('2');
  });

  it('runs to completion through frames, records the run and allows scrubbing', async () => {
    const t = setup();
    await t.settle();
    $('pour').click();
    expect(t.app.running).toBe(true);
    expect($('prompt').hidden).toBe(true);
    for (let k = 0; k < 80 && !t.app.finished; k++) await t.tick(100);
    expect(t.app.finished).toBe(true);
    expect($('status').textContent).toMatch(/finished/);
    expect($('play').getAttribute('aria-pressed')).toBe('false');
    expect(t.app.runs).toHaveLength(1);
    expect($('comparison').textContent).toMatch(/Tilting open tank/);
    expect($('tables').textContent).toMatch(/Segregation S/);
    expect($('diagList').textContent).toMatch(/Pressure residual/);
    expect($('summary').children.length).toBeGreaterThan(0);
    t.app.metrics!.bins = [{ from: 0, to: 5e-5, byOrigin: [1e-5, 2e-5, 2e-5], partial: true }];
    t.app.metrics!.composition.bias = [1.2, 0.9, 0.8];
    expect(t.app.chartTooltip('binsChart', 0.05)).toMatch(/0-50 mL \(partial\): bottom 20%/);
    expect(t.app.chartTooltip('biasChart', 0.1)).toBe('bottom: B = 1.20');
    const scrub = $('scrub') as HTMLInputElement;
    expect(scrub.disabled).toBe(false);
    scrub.value = '0';
    scrub.dispatchEvent(new Event('input'));
    expect($('scrubTime').textContent).toMatch(/stored frame/);
    // Pour again after finishing resets the experiment.
    $('pour').click();
    await t.settle();
    expect(t.app.finished).toBe(false);
  });

  it('play/pause, step, speed, view toggles, keyboard, exports, share', async () => {
    const t = setup();
    await t.settle();
    $('play').click();
    expect($('play').textContent).toBe('Pause');
    await t.tick(30);
    $('play').click();
    expect(t.app.running).toBe(false);
    $('step').click();
    await t.settle();
    expect(t.worker.sent.some((m) => m.type === 'step')).toBe(true);
    const speed = $('speed') as HTMLSelectElement;
    speed.value = '0.5';
    speed.dispatchEvent(new Event('change'));
    expect(t.worker.host.speed).toBe(0.5);
    for (const id of ['pathlines', 'arrows', 'markers', 'highlight'])
      $(id).dispatchEvent(new Event('change'));
    // Chart hover tooltips.
    const bins = $('binsChart') as HTMLCanvasElement;
    bins.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 10 }));
    expect($('tooltip').hidden).toBe(true); // no discharge yet: no bins
    const bias = $('biasChart') as HTMLCanvasElement;
    bias.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 10 }));
    expect($('tooltip').hidden).toBe(false);
    expect($('tooltip').textContent).toMatch(/B = n\/a/);
    bias.dispatchEvent(new MouseEvent('mouseleave'));
    expect($('tooltip').hidden).toBe(true);
    expect(t.app.chartTooltip('angleChart', 0.5)).toBeNull();
    expect(t.app.chartTooltip('biasChart', 2)).toBeNull();
    const mode = $('mode') as HTMLSelectElement;
    mode.value = 'speed';
    mode.dispatchEvent(new Event('change'));
    const diag = $('diagToggle') as HTMLInputElement;
    diag.checked = true;
    diag.dispatchEvent(new Event('change'));
    expect(($('diagnostics') as HTMLDetailsElement).open).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(t.app.running).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(t.app.running).toBe(false);
    $('expJson').click();
    await t.settle();
    $('expCsv').click();
    await t.settle();
    expect(t.downloads[0]).toMatch(/\.json$/);
    expect(t.downloads[1]).toMatch(/\.csv$/);
    ($('scene') as HTMLCanvasElement).toDataURL = () => 'data:image/png;base64,AAAA';
    $('expPng').click();
    expect(t.downloads[2]).toBe('pourlab-view.png');
    ($('scene') as HTMLCanvasElement).toDataURL = () => {
      throw new Error('tainted');
    };
    $('expPng').click();
    expect($('status').textContent).toMatch(/PNG export is not available/);
    $('share').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.copied[0]).toMatch(/^https:\/\/example\.test\/app\/\?preset=tank-tilt/);
  });

  it('settings form validates, applies and writes the URL; presets and comparisons load', async () => {
    const t = setup();
    await t.settle();
    ($('set-holdAngle') as HTMLInputElement).value = '500';
    $('settings').dispatchEvent(new Event('submit', { cancelable: true }));
    expect($('errors').textContent).toMatch(/Hold angle/);
    ($('set-holdAngle') as HTMLInputElement).value = '';
    $('settings').dispatchEvent(new Event('submit', { cancelable: true }));
    expect($('errors').textContent).toMatch(/must be a number/);
    ($('set-holdAngle') as HTMLInputElement).value = '10';
    ($('set-seed') as HTMLInputElement).value = '5';
    $('settings').dispatchEvent(new Event('submit', { cancelable: true }));
    await t.settle();
    expect($('errors').textContent).toBe('');
    expect(t.replaced.at(-1)).toMatch(/seed=5/);
    const preset = $('preset') as HTMLSelectElement;
    // The thermal benchmark preset keeps its vessel in the form (the select knows 'cavity').
    preset.value = 'thermal-cavity';
    preset.dispatchEvent(new Event('change'));
    await t.settle();
    expect(($('set-vessel') as HTMLSelectElement).value).toBe('cavity');
    expect(t.app.readForm().vessel).toBe('cavity');
    preset.value = 'teapot-still';
    preset.dispatchEvent(new Event('change'));
    await t.settle();
    expect($('pour').textContent).toBe('Run (no pour)');
    $('cmpSlow').click();
    await t.settle();
    expect(t.app.settings.preset).toBe('teapot-slow');
    $('cmpSpout').click();
    await t.settle();
    expect(t.app.settings.preset).toBe('glass-gentle');
    expect(t.app.info?.config.vessel.kind).toBe('glass');
    $('cmpSpout').click();
    await t.settle();
    expect(t.app.settings.preset).toBe('pitcher-gentle');
    $('cmpSpout').click();
    await t.settle();
    expect(t.app.settings.preset).toBe('teapot-gentle');
    expect($('pour').textContent).toBe('Pour 400 mL');
    $('cmpStill').click();
    $('reset').click();
    await t.settle();
    expect(t.app.info?.config.presetId).toBe('teapot-still');
  });

  it('shows worker errors and failures; tolerates missing canvas contexts', async () => {
    const t = setup('?preset=tank-rest', false);
    await t.settle();
    t.app.onMessage({ type: 'error', message: 'kaput' });
    expect($('status').textContent).toBe('Error: kaput');
    expect(t.app.lastError).toBe('kaput');
    t.worker.onerror?.(new Event('error'));
    expect($('status').textContent).toMatch(/worker failed/);
    t.app.render();
    expect(() => t.app.el('does-not-exist')).toThrow(/Missing element/);
  });

  it('manual tilt mode shows the slider and sends tilt requests; drawn pots apply from the editor', async () => {
    const t = setup('?preset=teapot-gentle&control=manual&duration=3');
    await t.settle();
    expect($('tiltBox').hidden).toBe(false);
    expect($('pour').textContent).toBe('Start (tilt by hand)');
    $('pour').click();
    const slider = $('tiltSlider') as HTMLInputElement;
    slider.value = '40';
    slider.dispatchEvent(new Event('input'));
    expect($('tiltValue').textContent).toBe('40 deg');
    expect(t.worker.sent.some((m) => m.type === 'tilt' && m.angleDeg === 40)).toBe(true);
    for (let k = 0; k < 15; k++) await t.tick(100);
    expect(t.app.diagnostics!.angleDeg).toBeGreaterThan(20);
    // Choosing "Drawn pot" in the form without a stored outline uses the editor's shape.
    ($('set-vessel') as HTMLSelectElement).value = 'custom';
    ($('set-fillMl') as HTMLInputElement).value = '900';
    $('settings').dispatchEvent(new Event('submit', { cancelable: true }));
    await t.settle();
    expect($('errors').textContent).toBe('');
    expect(t.app.info?.config.vessel.kind).toBe('custom');
    // Shape editor: switch to the bowl template and use it.
    $('shape-bowl').click();
    $('shapeUse').click();
    await t.settle();
    expect(t.app.settings.vessel).toBe('custom');
    expect(t.app.info?.config.vessel.kind).toBe('custom');
    expect(t.replaced.at(-1)).toMatch(/vessel=custom/);
    expect(t.replaced.at(-1)).toMatch(/shape=/);
    expect(t.app.editor!.pts.length).toBeGreaterThan(3);
  });

  it('light, dark and auto modes switch, are remembered, and are disabled in cyber neon', async () => {
    const t = setup('?preset=tank-rest', true, true, [['pourlab-mode', 'dark']]);
    await t.settle();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect($('mode-dark').getAttribute('aria-pressed')).toBe('true');
    $('mode-light').click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(t.prefs.get('pourlab-mode')).toBe('light');
    $('mode-auto').click();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect($('mode-auto').getAttribute('aria-pressed')).toBe('true');
    const skin = $('skin') as HTMLSelectElement;
    skin.value = 'cyber';
    skin.dispatchEvent(new Event('change'));
    expect(($('mode-light') as HTMLButtonElement).disabled).toBe(true);
    skin.value = 'lab';
    skin.dispatchEvent(new Event('change'));
    expect(($('mode-light') as HTMLButtonElement).disabled).toBe(false);
  });

  it('switches between the lab and cyber looks and remembers the choice', async () => {
    const t = setup('?preset=tank-rest', true, true, [['pourlab-skin', 'cyber']]);
    await t.settle();
    expect(document.documentElement.getAttribute('data-skin')).toBe('cyber');
    expect(t.app.theme().glow).toBe(true);
    const skin = $('skin') as HTMLSelectElement;
    skin.value = 'lab';
    skin.dispatchEvent(new Event('change'));
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);
    expect(t.prefs.get('pourlab-skin')).toBe('lab');
    expect(t.app.theme().glow).toBe(false);
    skin.value = 'cyber';
    skin.dispatchEvent(new Event('change'));
    expect(t.prefs.get('pourlab-skin')).toBe('cyber');
    document.documentElement.removeAttribute('data-skin');
  });

  it('sound toggles on and off, volume applies, and the pour sound follows the discharge', async () => {
    const t = setup('?preset=teapot-gentle&duration=4');
    await t.settle();
    $('soundToggle').click();
    await new Promise((r) => setTimeout(r, 0));
    expect($('soundToggle').textContent).toBe('Sound: on');
    expect($('soundToggle').getAttribute('aria-pressed')).toBe('true');
    const vol = $('volume') as HTMLInputElement;
    vol.value = '30';
    vol.dispatchEvent(new Event('input'));
    expect(t.app.sound.volume).toBeCloseTo(0.3);
    $('pour').click();
    let maxLevel = 0;
    for (let k = 0; k < 40 && !t.app.finished; k++) {
      await t.tick(100);
      maxLevel = Math.max(maxLevel, t.app.sound.intensity);
      if (maxLevel > 0.3) break; // stop mid-pour
    }
    expect(maxLevel).toBeGreaterThan(0.3); // audible while pouring

    // Reset mid-pour: the pour noise stops at once and the next run tracks its own flow.
    $('reset').click();
    expect(t.app.sound.intensity).toBe(0);
    await t.settle();
    $('pour').click();
    for (let k = 0; k < 40 && t.app.sound.intensity === 0; k++) await t.tick(100);
    expect(t.app.sound.intensity).toBeGreaterThan(0);
    $('play').click(); // pausing silences the pour
    expect(t.app.sound.intensity).toBe(0);
    $('soundToggle').click();
    await new Promise((r) => setTimeout(r, 0));
    expect($('soundToggle').textContent).toBe('Sound: off');
  });

  it('explains when Web Audio is unavailable', async () => {
    const t = setup('?preset=tank-rest', true, false);
    await t.settle();
    $('soundToggle').click();
    await new Promise((r) => setTimeout(r, 0));
    expect($('status').textContent).toMatch(/not supported/);
    expect($('soundToggle').textContent).toBe('Sound: off');
  });

  it('opens the recorded 3D view and wires its playback controls', async () => {
    const t = setup('?preset=tank-rest');
    await t.settle();
    await t.app.open3D();
    expect($('view3dBox').hidden).toBe(false);
    expect($('open3d').hidden).toBe(true);
    expect($('v3status').textContent).toMatch(/Recorded 3D simulation/);
    expect($('v3info').textContent).toMatch(/poured 400 mL: 25 % bottom, 50 % middle, 25 % top/);
    expect(($('v3scrub') as HTMLInputElement).max).toBe('49');
    $('v3play').click();
    expect(t.viewer3d.playing).toBe(false);
    expect($('v3play').textContent).toBe('Play');
    $('v3restart').click();
    expect(t.viewer3d.playing).toBe(true);
    const speed = $('v3speed') as HTMLSelectElement;
    speed.value = '2';
    speed.dispatchEvent(new Event('change'));
    expect(t.viewer3d.speed).toBe(2);
    $('v3reset').click();
    expect(t.viewer3d.reset).toBe(true);
    const scrub = $('v3scrub') as HTMLInputElement;
    scrub.value = '20';
    scrub.dispatchEvent(new Event('input'));
    expect(t.viewer3d.frame).toBe(20);
    $('mode-dark').click();
    expect(t.viewer3d.themed).toBeGreaterThan(0);
    expect(t.app.theme3d().layers).toHaveLength(3);
  });

  it('runs the 3D pour live on the GPU with its own controls and switches back to the recording', async () => {
    const t = setup('?preset=tank-rest');
    await t.settle();
    await t.app.open3D(true);
    expect($('v3status').textContent).toMatch(/Live 3D simulation, computed now on your GPU/);
    expect($('open3dLive').hidden).toBe(true);
    expect($('open3d').hidden).toBe(false);
    expect($('v3scrub').hidden).toBe(true);
    expect($('v3presetBox').hidden).toBe(false);
    expect($('v3tiltBox').hidden).toBe(true);
    expect($('v3info').textContent).toMatch(/^Live: 1.00x real time, t = 2.0 s/);
    t.live3d.finished = true;
    t.live3d.onFrame?.(0);
    expect($('v3info').textContent).toMatch(/finished/);
    const preset = $('v3preset') as HTMLSelectElement;
    preset.value = 'manual-5';
    preset.dispatchEvent(new Event('change'));
    expect(t.live3d.restarts).toEqual(['manual-5']);
    expect($('v3tiltBox').hidden).toBe(false);
    const tilt = $('v3tilt') as HTMLInputElement;
    tilt.value = '40';
    tilt.dispatchEvent(new Event('input'));
    expect(t.live3d.tilts).toEqual([40]);
    const canvas = $('view3dCanvas');
    await t.app.open3D(false);
    expect(t.live3d.disposed).toBe(1);
    expect($('view3dCanvas')).not.toBe(canvas);
    expect($('v3scrub').hidden).toBe(false);
    expect($('v3presetBox').hidden).toBe(true);
    preset.dispatchEvent(new Event('change')); // recording: no restart hook, ignored
    expect(t.live3d.restarts).toHaveLength(1);
  });

  it('disables the live run without WebGPU and explains a failed start', async () => {
    const t = setup('?preset=tank-rest&nowebgpu=1');
    await t.settle();
    const b = $('open3dLive') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toMatch(/no WebGPU/);
    const u = setup('?preset=tank-rest&nolive=1');
    await u.settle();
    await u.app.open3D(true);
    expect($('v3status').textContent).toBe('Live 3D run unavailable: no WebGPU adapter');
  });

  it('explains when the 3D view cannot open', async () => {
    const t = setup('?preset=tank-rest&no3d=1');
    await t.settle();
    $('v3play').click(); // no viewer yet: ignored
    $('open3d').click();
    await new Promise((r) => setTimeout(r, 0));
    expect($('v3status').textContent).toMatch(/3D view unavailable: WebGL is not available/);
    expect($('view3dBox').hidden).toBe(true);
  });

  it('copy failure falls back to showing the link', async () => {
    const t = setup('?preset=tank-rest');
    await t.settle();
    (t.app as unknown as { d: AppDeps }).d.copy = () => Promise.reject(new Error('denied'));
    $('share').click();
    await new Promise((r) => setTimeout(r, 0));
    expect($('status').textContent).toMatch(/^https:\/\/example\.test/);
  });

  it('bounds the stored-frame history', async () => {
    const t = setup('?preset=tank-rest&duration=40');
    await t.settle();
    t.app.setRunning(true);
    const snap = t.app.snapshot!;
    for (let k = 0; k < 950; k++)
      t.app.onMessage({
        type: 'frame',
        snapshot: { ...snap, time: k },
        diagnostics: t.app.diagnostics!,
        metrics: null,
        arrows: new Float32Array(0),
        running: true,
        finished: false,
        realtimeFactor: 0.5,
      });
    expect(t.app.frames.length).toBeLessThanOrEqual(900);
    expect($('status').textContent).toMatch(/computing at 50%/);
    // Large frames: the store is bounded by memory, not only by count.
    const huge = { ...snap, positions: new Float32Array(2_000_000), status: new Uint8Array(1_000_000) };
    for (let k = 0; k < 40; k++)
      t.app.onMessage({
        type: 'frame',
        snapshot: { ...huge, time: 1000 + k },
        diagnostics: t.app.diagnostics!,
        metrics: null,
        arrows: new Float32Array(0),
        running: true,
        finished: false,
        realtimeFactor: 1,
      });
    expect(t.app.frames.length).toBeLessThanOrEqual(30);
  });
});

describe('review regressions', () => {
  it('serializes 3D loading and preserves the selected playback speed', async () => {
    const t = setup();
    await t.settle();
    let resolve!: (v: typeof t.viewer3d) => void;
    t.deps.open3d = vi.fn(
      () =>
        new Promise<typeof t.viewer3d>((r) => {
          resolve = r;
        }),
    );
    const first = t.app.open3D();
    await t.app.open3D();
    expect(t.deps.open3d).toHaveBeenCalledTimes(1);
    expect((document.getElementById('open3d') as HTMLButtonElement).disabled).toBe(true);
    (document.getElementById('v3speed') as HTMLSelectElement).value = '2';
    resolve(t.viewer3d);
    await first;
    expect(t.viewer3d.speed).toBe(2);
    document.getElementById('v3play')!.click();
    document.getElementById('v3restart')!.click();
    expect(document.getElementById('v3play')!.textContent).toBe('Pause');
    t.app.viewer3d!.playing = false;
    t.app.viewer3d!.onError!('device lost');
    expect(document.getElementById('v3status')!.textContent).toContain('device lost');
    expect(document.getElementById('v3play')!.textContent).toBe('Play');
  });

  it('stores speed and temperature with the timeline snapshot', async () => {
    const t = setup('?preset=thermal-stratified&duration=2');
    await t.settle();
    const stored = t.app.frames[0];
    expect(stored.speed).toEqual(t.app.snapshot!.speed);
    expect(stored.speed).not.toBe(t.app.snapshot!.speed);
    expect(stored.temperature).toEqual(t.app.snapshot!.temperature);
    t.app.snapshot!.speed.fill(5);
    expect(stored.speed[0]).toBe(0);
  });
});

describe('render cache', () => {
  it('redraws the initial map only when status or theme changes', async () => {
    const t = setup();
    await t.settle();
    const ctx = fakeCtx();
    t.deps.getContext = () => ctx;
    t.app.applySkin('cyber');
    const count = () => ctx.calls.filter((c) => c === 'fillRect').length;
    const first = count();
    t.app.render();
    const unchanged = count() - first;
    const before = count();
    t.app.snapshot!.status[0] = 1;
    t.app.render();
    expect(count() - before).toBeGreaterThan(unchanged + t.app.info!.n / 2);
  });
});

describe('worker request regressions', () => {
  it('keeps export formats with their requests even when clicks overlap', async () => {
    const t = setup();
    await t.settle();
    document.getElementById('expJson')!.click();
    document.getElementById('expCsv')!.click();
    document.getElementById('expCsv')!.click();
    document.getElementById('expJson')!.click();
    await t.settle();
    expect(t.downloads.map((name) => name.slice(name.lastIndexOf('.')))).toEqual([
      '.json',
      '.csv',
      '.csv',
      '.json',
    ]);
  });
  it('matches the no-pour control duration and stops playback after worker failure', async () => {
    const t = setup('?preset=teapot-gentle&duration=25');
    await t.settle();
    document.getElementById('cmpStill')!.click();
    await t.settle();
    expect(t.app.info!.config.duration).toBe(25);
    t.app.setRunning(true);
    t.worker.onerror?.(new Error('crash'));
    expect(t.app.running).toBe(false);
    expect(t.app.pending).toBe(false);
    expect(document.getElementById('status')!.textContent).toContain('worker failed');
  });
});

describe('adversarial state consistency', () => {
  it('uses stored discharge statuses for the scrubbed collector, while identifying latest charts', async () => {
    const t = setup();
    await t.settle();
    t.app.metrics!.composition.dischargedByOrigin = [100e-6, 200e-6, 100e-6];
    const ctx = fakeCtx();
    const text = vi.fn<(text: string, x: number, y: number) => void>();
    Object.assign(ctx, { fillText: text });
    t.deps.getContext = () => ctx;
    t.app.scrubIndex = 0;
    t.app.render();
    expect(text.mock.calls.some((args) => args[0] === '0 mL')).toBe(true);
    expect(document.getElementById('scrubTime')!.textContent).toContain('charts and tables show latest');
    t.app.frames[0].status[0] = 1;
    text.mockClear();
    t.app.render();
    const ml = (t.app.info!.parcelVolume * 1e6).toFixed(0) + ' mL';
    expect(text.mock.calls.some((args) => args[0] === ml)).toBe(true);
  });
  it('requires a fresh live viewer after failure and re-enables controls on successful startup', async () => {
    const t = setup();
    await t.settle();
    await t.app.open3D(true);
    t.app.viewer3d!.onError!('device lost');
    expect((document.getElementById('v3play') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('v3restart') as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById('open3dLive')!.hidden).toBe(false);
    await t.app.open3D(true);
    expect(t.live3d.disposed).toBe(1);
    expect((document.getElementById('v3play') as HTMLButtonElement).disabled).toBe(false);
  });
});
