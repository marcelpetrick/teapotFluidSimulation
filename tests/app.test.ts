// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type AppDeps, type WorkerLike } from '../src/ui/app';
import { SimulationHost, type FromWorker, type ToWorker } from '../src/worker/host';
import { fakeCtx } from './helpers';

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

function setup(search = '?preset=tank-tilt&duration=2', ctxOk = true) {
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
  };
  const app = new App(deps);
  app.start();
  const tick = async (ms = 50) => {
    clock += ms;
    frameCb?.(clock);
    void ms;
    await worker.queue;
  };
  return { app, worker, tick, downloads, replaced, copied, settle: () => worker.queue };
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
    expect($('legend').children).toHaveLength(3);
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
  });
});
