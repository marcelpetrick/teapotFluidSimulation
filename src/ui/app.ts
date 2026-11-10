// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Main-thread application: settings form, playback, rendering, charts, tables, exports.
// Dependencies (worker, canvas context, frame scheduler, clock) are injected for testing.

import {
  LIMITS,
  PRESETS,
  QUALITY_LADDER,
  configFromSettings,
  parseShape,
  presetById,
  referenceFillHeight,
  shapeToString,
  fitFillToVessel,
  vesselFromProfile,
  settingsFromQuery,
  settingsToQuery,
  validateSettings,
  type UserSettings,
} from '../sim/config';
import { showWebgpuHelp } from './webgpuHelp';
import { modelLimitations } from '../sim/experiment';
import { STATUS_DISCHARGED, type Diagnostics, type RenderSnapshot } from '../sim/types';
import { summarize } from '../sim/metrics';
import type { FrameMetrics, FromWorker, StaticInfo, ToWorker } from '../worker/host';
import {
  drawArrows,
  drawGlass,
  drawInitialMap,
  drawParcels,
  drawPathlines,
  drawVessel,
  fitViewport,
  type ColourMode,
  type Ctx2D,
  type Theme,
} from '../render/scene';
import { chartBox, drawBiasChart, drawBinsChart, drawTimeSeries } from '../render/charts';
import { ShapeEditor } from './shapeEditor';
import { CONTROL_HELP, SETTING_HELP } from './help';
import { Soundscape, pourIntensity, type AudioFactory } from '../audio/soundscape';

export interface WorkerLike {
  postMessage(msg: ToWorker): void;
  onmessage: ((e: { data: FromWorker }) => void) | null;
  onerror?: ((e: unknown) => void) | null;
}

export interface AppDeps {
  doc: Document;
  worker: WorkerLike;
  getContext: (c: HTMLCanvasElement) => Ctx2D | null;
  schedule: (cb: (t: number) => void) => void;
  now: () => number;
  location: { search: string; pathname: string; origin: string };
  history: { replaceState: (a: unknown, b: string, url: string) => void };
  download: (name: string, data: string | Blob) => void;
  copy: (text: string) => Promise<void>;
  reducedMotion: boolean;
  version: string;
  /** Creates the Web Audio context on demand (null when unsupported). */
  audio: AudioFactory;
  /** Lazily opens the recorded 3D view in a canvas (loads three.js and the recording on demand). */
  open3d?: (canvas: HTMLCanvasElement, theme: Viewer3DTheme) => Promise<Viewer3D>;
  /** Lazily starts the live WebGPU 3D run (loads three.js and the GPU solver on demand). */
  open3dLive?: (canvas: HTMLCanvasElement, theme: Viewer3DTheme, preset: string) => Promise<Viewer3D>;
  /** Whether the browser exposes WebGPU at all (the live 3D run needs it). */
  webgpu?: boolean;
  /** Per-viewer preferences (e.g. the chosen look); may fail silently. */
  prefs: { get(key: string): string | null; set(key: string, value: string): void };
}

interface StoredFrame {
  time: number;
  angleDeg: number;
  positions: Float32Array;
  status: Uint8Array;
  speed: Float32Array;
  temperature: Float32Array | null;
}

export interface RunSummary {
  name: string;
  seed: number;
  quality: number;
  dischargedMl: number;
  targetMl: number;
  composition: string;
  segregationNow: string;
  segregationSurvivorInitial: string;
  pressureFailures: number;
}

/** What the App needs from the 3D viewer (kept structural so three.js stays out of the main bundle). */
export interface Viewer3DTheme {
  background: string;
  wall: string;
  layers: [string, string, string];
}
export interface Viewer3D {
  readonly frames: number;
  readonly frame: number;
  readonly time: number;
  playing: boolean;
  speed: number;
  onFrame: ((frame: number) => void) | null;
  seek(frame: number): void;
  resetView(): void;
  resize(width: number, height: number): void;
  poured(): number[];
  angleDeg(): number;
  applyTheme(theme: Viewer3DTheme): void;
  dispose?(): void;
  /** Live WebGPU runs only. */
  onError?: ((message: string) => void) | null;
  readonly live?: boolean;
  readonly manual?: boolean;
  readonly finished?: boolean;
  restart?(preset?: string): void;
  setTilt?(angleDeg: number): void;
  realTimeFactor?(): number;
}

const MAX_STORED_FRAMES = 900;
/** Memory budget for stored timeline frames (bytes); high resolutions keep fewer frames. */
const FRAME_STORE_BYTES = 150e6;

/** "Change the pot" cycles through the pot models: spout teapot -> glass pot -> pitcher. */
const NEXT_POT: Record<string, string> = {
  teapot: 'glass-gentle',
  glass: 'pitcher-gentle',
  pitcher: 'teapot-gentle',
};

export class App {
  private d: AppDeps;
  settings: UserSettings;
  info: StaticInfo | null = null;
  snapshot: RenderSnapshot | null = null;
  diagnostics: Diagnostics | null = null;
  metrics: FrameMetrics | null = null;
  arrows: Float32Array = new Float32Array(0);
  running = false;
  finished = false;
  realtimeFactor = 1;
  pending = false;
  frames: StoredFrame[] = [];
  scrubIndex = -1;
  runs: RunSummary[] = [];
  private loopStarted = false;
  private recorded = false;
  private initialMapInfo: StaticInfo | null = null;
  private initialMapStatus = new Uint8Array(0);
  private initialMapTheme = '';
  lastError = '';

  readonly sound: Soundscape;
  private lastPour = { time: -1, volume: 0 };

  constructor(deps: AppDeps) {
    this.d = deps;
    this.sound = new Soundscape(deps.audio);
    this.settings = settingsFromQuery(deps.location.search);
    deps.worker.onmessage = (e) => this.onMessage(e.data);
    deps.worker.onerror = () => {
      this.pending = false;
      this.setRunning(false);
      this.setStatus('The simulation worker failed. Reload the page to retry.');
    };
  }

  el<T extends HTMLElement>(id: string): T {
    const e = this.d.doc.getElementById(id);
    if (!e) throw new Error(`Missing element #${id}`);
    return e as T;
  }

  start(): void {
    this.el('version').textContent = `v${this.d.version}`;
    this.buildSettingsForm();
    const mode = this.d.prefs.get('pourlab-mode');
    this.applyMode(mode === 'light' || mode === 'dark' ? mode : 'auto', false);
    this.applySkin(this.d.prefs.get('pourlab-skin') === 'cyber' ? 'cyber' : 'lab', false);
    this.applyHelp();
    this.bindControls();
    this.editor = new ShapeEditor(
      this.d.doc,
      {
        getContext: this.d.getContext,
        theme: () => this.theme(),
        fillHeight: () => referenceFillHeight('custom') * (this.settings.fillMl / 1500),
        onUse: (pts) => {
          const wanted = { ...this.readForm(), vessel: 'custom' as const, shape: shapeToString(pts) };
          const fit = fitFillToVessel(wanted, vesselFromProfile(pts));
          if (this.applySettings(fit.settings) && fit.changed)
            this.setStatus(`Fill lowered to ${fit.settings.fillMl} mL so the drawn pot does not overflow.`);
        },
      },
      parseShape(this.settings.shape),
    );
    this.editor.bind();
    this.applySettings(this.settings, false);
    if (!this.loopStarted) {
      this.loopStarted = true;
      this.d.schedule(() => this.tick());
    }
  }

  // ------------------------------------------------------------ look and sound

  /** Switch between the clean lab look and the cyber neon look (remembered per viewer). */
  applySkin(skin: 'lab' | 'cyber', remember = true): void {
    const root = this.d.doc.documentElement;
    if (skin === 'cyber') root.setAttribute('data-skin', 'cyber');
    else root.removeAttribute('data-skin');
    this.el<HTMLSelectElement>('skin').value = skin;
    // Cyber neon is always dark: the light/dark buttons do not apply there.
    for (const m of ['auto', 'light', 'dark'])
      this.el<HTMLButtonElement>(`mode-${m}`).disabled = skin === 'cyber';
    if (remember) this.d.prefs.set('pourlab-skin', skin);
    this.render();
    this.updatePanels();
    this.editor?.render();
    this.viewer3d?.applyTheme(this.theme3d());
  }

  /** Light, dark, or follow the system ('auto'). Remembered per viewer. */
  applyMode(mode: 'auto' | 'light' | 'dark', remember = true): void {
    const root = this.d.doc.documentElement;
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    for (const m of ['auto', 'light', 'dark'])
      this.el(`mode-${m}`).setAttribute('aria-pressed', String(m === mode));
    if (remember) this.d.prefs.set('pourlab-mode', mode);
    this.render();
    this.updatePanels();
    this.editor?.render();
    this.viewer3d?.applyTheme(this.theme3d());
  }

  async toggleSound(): Promise<void> {
    const b = this.el<HTMLButtonElement>('soundToggle');
    if (this.sound.enabled) {
      await this.sound.disable();
    } else if (!(await this.sound.enable())) {
      this.setStatus('Sound is not supported in this browser.');
      return;
    }
    b.textContent = this.sound.enabled ? 'Sound: on' : 'Sound: off';
    b.setAttribute('aria-pressed', String(this.sound.enabled));
  }

  /** Pouring noise follows the measured discharge rate (mL per simulated second). */
  private updatePourSound(d: Diagnostics): void {
    const dt = d.time - this.lastPour.time;
    let level = 0;
    if (this.running && this.lastPour.time >= 0 && dt > 1e-6)
      level = pourIntensity(((d.volumeDischarged - this.lastPour.volume) * 1e6) / dt);
    if (dt > 1e-6 || !this.running) this.sound.setPourIntensity(level);
    this.lastPour = { time: d.time, volume: d.volumeDischarged };
  }

  // ------------------------------------------------------------ settings

  /** Tooltips: what each control is and what it influences (title + aria-description). */
  applyHelp(): void {
    const set = (el: HTMLElement | null, text: string) => {
      if (!el) return;
      el.title = text;
      el.setAttribute('aria-description', text);
      // The surrounding label shows the same tooltip when hovering its text.
      if (el.parentElement?.tagName === 'LABEL') el.parentElement.title = text;
    };
    for (const [id, text] of Object.entries(CONTROL_HELP)) set(this.d.doc.getElementById(id), text);
    for (const [key, text] of Object.entries(SETTING_HELP))
      set(this.d.doc.getElementById(`set-${key}`), text);
  }

  private numberField(container: HTMLElement, key: keyof typeof LIMITS): void {
    const lim = LIMITS[key];
    const label = this.d.doc.createElement('label');
    label.textContent = `${lim.label}${lim.unit ? ` (${lim.unit})` : ''}`;
    const input = this.d.doc.createElement('input');
    input.type = 'number';
    input.name = key;
    input.id = `set-${key}`;
    input.min = String(lim.min);
    input.max = String(lim.max);
    input.step = String(lim.step);
    label.appendChild(input);
    container.appendChild(label);
  }

  private selectField(container: HTMLElement, name: string, text: string, options: [string, string][]): void {
    const label = this.d.doc.createElement('label');
    label.textContent = text;
    const sel = this.d.doc.createElement('select');
    sel.name = name;
    sel.id = `set-${name}`;
    for (const [v, t] of options) {
      const o = this.d.doc.createElement('option');
      o.value = v;
      o.textContent = t;
      sel.appendChild(o);
    }
    label.appendChild(sel);
    container.appendChild(label);
  }

  private buildSettingsForm(): void {
    const preset = this.el<HTMLSelectElement>('preset');
    preset.innerHTML = '';
    for (const p of PRESETS) {
      const o = this.d.doc.createElement('option');
      o.value = p.id;
      o.textContent = `${p.label} (${p.status})`;
      preset.appendChild(o);
    }
    const f = this.el('fields');
    f.innerHTML = '';
    this.selectField(f, 'vessel', 'Vessel', [
      ['teapot', 'Teapot (low-inlet spout)'],
      ['glass', 'German glass teapot (cylinder, top lip)'],
      ['pitcher', 'Pitcher (rim lip)'],
      ['tank', 'Open tank (test)'],
      ['custom', 'Drawn pot (shape editor)'],
      ['cavity', 'Heated cavity (thermal test)'],
    ]);
    this.selectField(f, 'control', 'Pouring', [
      ['auto', 'Automatic pour to the target'],
      ['manual', 'Tilt by hand (slider)'],
    ]);
    for (const k of [
      'fillMl',
      'targetMl',
      'tiltDuration',
      'holdAngle',
      'returnDuration',
      'duration',
    ] as const)
      this.numberField(f, k);
    const n = this.el('numFields');
    n.innerHTML = '';
    this.selectField(
      n,
      'quality',
      'Resolution (cells across body)',
      QUALITY_LADDER.map((q) => [
        String(q),
        `${q}${q === 44 ? ' (fast)' : q === 96 ? ' (slow)' : q === 128 ? ' (finest, very slow)' : ''}`,
      ]),
    );
    this.selectField(n, 'ppc', 'Particles per cell', [
      ['2', '4 per cell (fast)'],
      ['3', '9 per cell'],
      ['4', '16 per cell (slow)'],
    ]);
    this.selectField(n, 'transfer', 'Transfer scheme', [
      ['flip', 'PIC/FLIP'],
      ['apic', 'APIC'],
    ]);
    this.numberField(n, 'flipRatio');
    this.numberField(n, 'seed');
    const t = this.el('thermalFields');
    t.innerHTML = '';
    this.selectField(t, 'thermal', 'Thermal mode', [
      ['off', 'Off (uniform)'],
      ['passive', 'Passive colour only (no buoyancy)'],
      ['coupled', 'Coupled buoyancy'],
    ]);
    for (const k of ['topC', 'bottomC', 'coolingWm2K'] as const) this.numberField(t, k);
  }

  private writeForm(s: UserSettings): void {
    this.el<HTMLSelectElement>('preset').value = s.preset;
    this.el('presetPurpose').textContent = presetById(s.preset).purpose;
    for (const [k, v] of Object.entries(s)) {
      const e = this.d.doc.getElementById(`set-${k}`) as HTMLInputElement | HTMLSelectElement | null;
      if (e) e.value = String(v);
    }
  }

  readForm(): UserSettings {
    const s: UserSettings = { ...this.settings };
    s.preset = this.el<HTMLSelectElement>('preset').value;
    const rec = s as unknown as Record<string, string | number>;
    for (const k of Object.keys(s)) {
      if (k === 'preset') continue;
      const e = this.d.doc.getElementById(`set-${k}`) as HTMLInputElement | HTMLSelectElement | null;
      if (!e) continue;
      rec[k] = typeof rec[k] === 'number' ? (e.value.trim() === '' ? NaN : Number(e.value)) : e.value;
    }
    // "Drawn pot" chosen in the form without a stored outline: use the editor's current shape.
    if (s.vessel === 'custom' && !parseShape(s.shape) && this.editor)
      s.shape = shapeToString(this.editor.pts);
    return s;
  }

  applySettings(s: UserSettings, updateUrl = true): boolean {
    const errs = validateSettings(s);
    this.el('errors').textContent = errs.join('\n');
    if (errs.length) return false;
    this.settings = s;
    this.writeForm(s);
    if (updateUrl) this.d.history.replaceState(null, '', `${this.d.location.pathname}?${settingsToQuery(s)}`);
    const cfg = configFromSettings(s);
    this.info = null;
    this.frames = [];
    this.scrubIndex = -1;
    this.running = false;
    // A new experiment starts silent and the pour-rate tracker starts from scratch.
    this.sound.setPourIntensity(0);
    this.lastPour = { time: -1, volume: 0 };
    this.finished = false;
    this.recorded = false;
    this.pending = true;
    this.setStatus('Preparing experiment...');
    const pour = this.el<HTMLButtonElement>('pour');
    const manual = cfg.motion.kind === 'manual';
    this.el('tiltBox').hidden = !manual;
    const slider = this.el<HTMLInputElement>('tiltSlider');
    slider.value = '0';
    this.el('tiltValue').textContent = '0 deg';
    pour.textContent = manual
      ? 'Start (tilt by hand)'
      : cfg.motion.kind === 'pour'
        ? `Pour ${s.targetMl} mL`
        : cfg.motion.kind === 'tilt'
          ? 'Tilt and return'
          : 'Run (no pour)';
    const lim = this.el('limits');
    lim.innerHTML = '';
    for (const l of modelLimitations(cfg)) {
      const li = this.d.doc.createElement('li');
      li.textContent = l;
      lim.appendChild(li);
    }
    this.el('prompt').hidden = false;
    this.d.worker.postMessage({ type: 'init', config: cfg });
    return true;
  }

  private loadPreset(id: string): void {
    const s = settingsFromQuery(
      `preset=${encodeURIComponent(id)}&quality=${this.settings.quality}&seed=${this.settings.seed}`,
    );
    this.applySettings(s);
  }

  // ------------------------------------------------------------ controls

  private bindControls(): void {
    const on = (id: string, ev: string, fn: (e: Event) => void) => this.el(id).addEventListener(ev, fn);
    on('pour', 'click', () => {
      if (this.finished) this.applySettings(this.settings, false);
      this.setRunning(true);
    });
    on('play', 'click', () => {
      this.setRunning(!this.running);
      if (!this.running) this.post({ type: 'frame' });
    });
    on('step', 'click', () => {
      this.setRunning(false);
      this.post({ type: 'step' });
    });
    on('reset', 'click', () => this.applySettings(this.settings, false));
    on('open3d', 'click', () => void this.open3D());
    on('open3dLive', 'click', () => void this.open3D(true));
    on('v3preset', 'change', (e) => {
      const v = this.viewer3d;
      if (!v?.restart) return;
      v.restart((e.target as HTMLSelectElement).value);
      this.sync3dControls();
    });
    on('v3tilt', 'input', (e) => this.viewer3d?.setTilt?.(Number((e.target as HTMLInputElement).value)));
    showWebgpuHelp(this.d.doc, !this.d.webgpu || !this.d.open3dLive);
    if (!this.d.webgpu || !this.d.open3dLive) {
      const b = this.el<HTMLButtonElement>('open3dLive');
      b.disabled = true;
      b.title =
        'WebGPU is not enabled or available in this session. See the setup help below, or open the 3D recording.';
    }
    on('v3play', 'click', () => {
      if (!this.viewer3d) return;
      this.viewer3d.playing = !this.viewer3d.playing;
      const b = this.el('v3play');
      b.textContent = this.viewer3d.playing ? 'Pause' : 'Play';
      b.setAttribute('aria-pressed', String(this.viewer3d.playing));
    });
    on('v3restart', 'click', () => {
      this.viewer3d?.seek(0);
      if (this.viewer3d) this.viewer3d.playing = true;
      this.sync3dControls();
    });
    on('v3speed', 'change', (e) => {
      if (this.viewer3d) this.viewer3d.speed = Number((e.target as HTMLSelectElement).value);
    });
    on('v3reset', 'click', () => this.viewer3d?.resetView());
    on('v3scrub', 'input', (e) => this.viewer3d?.seek(Number((e.target as HTMLInputElement).value)));
    on('skin', 'change', (e) =>
      this.applySkin((e.target as HTMLSelectElement).value === 'cyber' ? 'cyber' : 'lab'),
    );
    on('soundToggle', 'click', () => void this.toggleSound());
    for (const m of ['auto', 'light', 'dark'] as const) on(`mode-${m}`, 'click', () => this.applyMode(m));
    on('volume', 'input', (e) => this.sound.setVolume(Number((e.target as HTMLInputElement).value) / 100));
    on('tiltSlider', 'input', (e) => {
      const deg = Number((e.target as HTMLInputElement).value);
      this.el('tiltValue').textContent = `${deg} deg`;
      this.post({ type: 'tilt', angleDeg: deg });
    });
    on('speed', 'change', (e) =>
      this.post({ type: 'speed', value: Number((e.target as HTMLSelectElement).value) }),
    );
    on('preset', 'change', (e) => this.loadPreset((e.target as HTMLSelectElement).value));
    on('settings', 'submit', (e) => {
      e.preventDefault();
      this.applySettings(this.readForm());
    });
    on('share', 'click', () => {
      const url = `${this.d.location.origin}${this.d.location.pathname}?${settingsToQuery(this.settings)}`;
      this.d.copy(url).then(
        () => this.setStatus('Share link copied.'),
        () => this.setStatus(url),
      );
    });
    on('cmpStill', 'click', () =>
      this.applySettings({ ...this.settings, preset: 'teapot-still', control: 'auto', targetMl: 0 }),
    );
    on('cmpSlow', 'click', () => this.loadPreset('teapot-slow'));
    on('cmpSpout', 'click', () => this.loadPreset(NEXT_POT[this.settings.vessel] ?? 'teapot-gentle'));
    for (const id of ['mode', 'highlight', 'pathlines', 'arrows', 'markers'])
      on(id, 'change', () => this.render());
    this.bindChartTooltips();
    on('diagToggle', 'change', (e) => {
      (this.el('diagnostics') as HTMLDetailsElement).open = (e.target as HTMLInputElement).checked;
    });
    on('scrub', 'input', (e) => {
      this.scrubIndex = Number((e.target as HTMLInputElement).value);
      this.render();
    });
    on('expJson', 'click', () => this.post({ type: 'export', format: 'json' }));
    on('expCsv', 'click', () => this.post({ type: 'export', format: 'csv' }));
    on('expPng', 'click', () => {
      const c = this.el<HTMLCanvasElement>('scene');
      try {
        this.d.download('pourlab-view.png', c.toDataURL('image/png'));
      } catch {
        this.setStatus('PNG export is not available in this browser.');
      }
    });
    this.d.doc.addEventListener('keydown', (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (e.key === ' ' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) {
        e.preventDefault();
        this.setRunning(!this.running);
        if (!this.running) this.post({ type: 'frame' });
      }
    });
  }

  editor: ShapeEditor | null = null;
  viewer3d: Viewer3D | null = null;

  /** Colours for the 3D view from the current look. */
  theme3d(): Viewer3DTheme {
    const t = this.theme();
    const bg = this.d.doc.defaultView?.getComputedStyle(this.d.doc.body).backgroundColor || '';
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
    const background = m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : '#fcfcfb';
    return { background, wall: t.wall, layers: [t.origins[0], t.origins[1], t.origins[2]] };
  }

  private opening3d = false;
  private failed3d = false;

  /** Open the 3D view: the recording, or (live) the WebGPU solver computing the pour now. */
  async open3D(live = false): Promise<void> {
    const open = live ? this.d.open3dLive : this.d.open3d;
    if (!open || this.opening3d) return;
    this.opening3d = true;
    this.el<HTMLButtonElement>('open3d').disabled = true;
    this.el<HTMLButtonElement>('open3dLive').disabled = true;
    const status = this.el('v3status');
    status.textContent = live ? 'Starting the live 3D run on your GPU...' : 'Loading the 3D recording...';
    // Each viewer owns its WebGL context. Give replacement viewers a fresh canvas.
    let canvas = this.el<HTMLCanvasElement>('view3dCanvas');
    if (this.viewer3d) {
      this.viewer3d.dispose?.();
      this.viewer3d = null;
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
    this.el('view3dBox').hidden = false;
    try {
      const preset = this.el<HTMLSelectElement>('v3preset').value;
      this.viewer3d = live
        ? await this.d.open3dLive!(canvas, this.theme3d(), preset)
        : await this.d.open3d!(canvas, this.theme3d());
    } catch (e) {
      this.el('view3dBox').hidden = true;
      if (live) showWebgpuHelp(this.d.doc, true);
      status.textContent = `${live ? 'Live 3D run' : '3D view'} unavailable: ${e instanceof Error ? e.message : String(e)}`;
      return;
    } finally {
      this.opening3d = false;
      this.el<HTMLButtonElement>('open3d').disabled = false;
      this.el<HTMLButtonElement>('open3dLive').disabled = !this.d.webgpu || !this.d.open3dLive;
    }
    const v = this.viewer3d;
    this.failed3d = false;
    if (live) showWebgpuHelp(this.d.doc, false);
    v.onError = (message) => {
      this.failed3d = true;
      showWebgpuHelp(this.d.doc, true);
      v.playing = false;
      this.el('open3dLive').hidden = false;
      status.textContent = `Live 3D run stopped: ${message}. Start a new live run to request a fresh GPU device, or open the recording.`;
      this.sync3dControls();
    };
    v.speed = Number(this.el<HTMLSelectElement>('v3speed').value);
    this.el('open3d').hidden = !live;
    this.el('open3dLive').hidden = live;
    status.textContent = live
      ? 'Live 3D simulation, computed now on your GPU (WebGPU port of the 3D solver; half pot simulated and mirrored, 5 or 4 mm cells, no surface tension). Drag to rotate, scroll to zoom, right-drag to pan.'
      : 'Recorded 3D simulation (playback). Drag to rotate, scroll to zoom, right-drag to pan.';
    const scrub = this.el<HTMLInputElement>('v3scrub');
    scrub.max = String(v.frames - 1);
    const rect = canvas.getBoundingClientRect();
    v.resize(Math.max(320, rect.width || canvas.width), Math.max(200, rect.height || canvas.height));
    v.onFrame = (f) => this.update3dInfo(f);
    this.sync3dControls();
    this.update3dInfo(v.frame);
  }

  /** Show the controls that apply to the open 3D mode. */
  private sync3dControls(): void {
    const v = this.viewer3d;
    const live = !!v?.live;
    this.el('v3scrub').hidden = live;
    this.el('v3presetBox').hidden = !live;
    this.el('v3tiltBox').hidden = !(live && v?.manual);
    for (const id of ['v3play', 'v3restart', 'v3preset', 'v3tilt'])
      (this.el(id) as HTMLButtonElement | HTMLSelectElement | HTMLInputElement).disabled = this.failed3d;
    const play = this.el('v3play');
    play.textContent = v?.playing ? 'Pause' : 'Play';
    play.setAttribute('aria-pressed', String(!!v?.playing));
    this.el<HTMLInputElement>('v3tilt').value = '0';
  }

  private update3dInfo(frame: number): void {
    const v = this.viewer3d;
    if (!v) return;
    this.el<HTMLInputElement>('v3scrub').value = String(frame);
    const p = v.poured();
    const total = p[0] + p[1] + p[2];
    const pct = (x: number) => (total > 0 ? (x / total) * 100 : 0);
    const rtf = v.realTimeFactor?.() ?? 0;
    const prefix = v.live
      ? `Live: ${rtf > 0 ? `${rtf.toFixed(2)}x real time, ` : ''}${v.finished ? 'finished, ' : ''}`
      : '';
    this.el('v3info').textContent =
      `${prefix}t = ${v.time.toFixed(1)} s, tilt ${v.angleDeg().toFixed(1)} deg, poured ${total.toFixed(0)} mL` +
      (total > 0
        ? `: ${pct(p[0]).toFixed(0)} % bottom, ${pct(p[1]).toFixed(0)} % middle, ${pct(p[2]).toFixed(0)} % top`
        : '');
    const spans = this.el('v3bar').querySelectorAll('span');
    p.forEach((x, k) => ((spans[k] as HTMLElement).style.width = `${pct(x)}%`));
  }

  /** Text for a hover position on a chart (x as a fraction of the plot width), or null. */
  chartTooltip(id: string, xFrac: number): string | null {
    const m = this.metrics;
    const info = this.info;
    if (!m || !info || xFrac < 0 || xFrac > 1) return null;
    const names = info.bandNames;
    if (id === 'binsChart') {
      const i = Math.floor(xFrac * Math.max(m.bins.length, 8));
      const b = m.bins[i];
      if (!b) return null;
      const tot = b.byOrigin.reduce((a, c) => a + c, 0);
      const parts = b.byOrigin.map((v, k) => `${names[k]} ${((v / tot) * 100).toFixed(0)}%`).join(', ');
      return `${(b.from * 1e6).toFixed(0)}-${(b.to * 1e6).toFixed(0)} mL${b.partial ? ' (partial)' : ''}: ${parts}`;
    }
    if (id === 'biasChart') {
      const k = Math.min(names.length - 1, Math.floor(xFrac * names.length));
      const v = m.composition.bias?.[k];
      return `${names[k]}: B = ${v === null || v === undefined ? 'n/a' : v.toFixed(2)}`;
    }
    return null;
  }

  private bindChartTooltips(): void {
    const tip = this.el('tooltip');
    for (const id of ['binsChart', 'biasChart']) {
      const c = this.el<HTMLCanvasElement>(id);
      c.addEventListener('mousemove', (e: MouseEvent) => {
        const r = c.getBoundingClientRect();
        const box = { left: 40, right: 8 }; // matches chartBox()
        const sx = r.width > 0 ? c.width / r.width : 1;
        const x = (e.clientX - r.left) * sx;
        const text = this.chartTooltip(id, (x - box.left) / (c.width - box.left - box.right));
        tip.hidden = text === null;
        if (text !== null) {
          tip.textContent = text;
          tip.style.left = `${e.clientX + 12}px`;
          tip.style.top = `${e.clientY + 12}px`;
        }
      });
      c.addEventListener('mouseleave', () => {
        tip.hidden = true;
      });
    }
  }

  private post(m: ToWorker): void {
    this.d.worker.postMessage(m);
  }

  setRunning(r: boolean): void {
    if (r && this.finished) return;
    this.running = r;
    this.scrubIndex = -1;
    if (!r) this.sound.setPourIntensity(0);
    this.post({ type: r ? 'play' : 'pause' });
    const b = this.el<HTMLButtonElement>('play');
    b.textContent = r ? 'Pause' : 'Play';
    b.setAttribute('aria-pressed', String(r));
    this.el<HTMLInputElement>('scrub').disabled = r || this.frames.length === 0;
    if (r) this.el('prompt').hidden = true;
  }

  setStatus(text: string): void {
    this.el('status').textContent = text;
  }

  // ------------------------------------------------------------ worker messages

  onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'ready':
        this.info = m.info;
        this.snapshot = m.snapshot;
        this.diagnostics = m.diagnostics;
        this.metrics = m.metrics;
        this.pending = false;
        this.storeFrame(m.snapshot);
        this.buildLegend();
        this.setStatus(
          `Ready: ${m.info.n} parcels, grid ${m.info.nx}x${m.info.ny}, cell ${(m.info.h * 1000).toFixed(1)} mm. ${this.d.reducedMotion ? 'Reduced motion: press Play to start.' : ''}`.trim(),
        );
        this.updatePanels();
        this.render();
        break;
      case 'frame':
        this.pending = false;
        this.snapshot = m.snapshot;
        this.diagnostics = m.diagnostics;
        this.arrows = m.arrows;
        this.realtimeFactor = m.realtimeFactor;
        if (m.metrics) this.metrics = m.metrics;
        if (this.running) this.storeFrame(m.snapshot);
        this.finished = m.finished;
        this.updatePourSound(m.diagnostics);
        if (this.running && !m.running) {
          this.setRunning(false);
          if (m.finished) this.onFinished();
        }
        this.updateStatusLine();
        if (m.metrics) this.updatePanels();
        this.render();
        break;
      case 'export':
        if (m.format === 'csv') this.d.download(`${m.fileStem}.csv`, m.csv);
        else this.d.download(`${m.fileStem}.json`, m.json);
        break;
      case 'error':
        this.lastError = m.message;
        this.pending = false;
        this.setRunning(false);
        this.setStatus(`Error: ${m.message}`);
        break;
    }
  }

  private storeFrame(s: RenderSnapshot): void {
    const bytesPerFrame =
      s.positions.byteLength + s.status.byteLength + s.speed.byteLength + (s.temperature?.byteLength ?? 0);
    const cap = Math.max(30, Math.min(MAX_STORED_FRAMES, Math.floor(FRAME_STORE_BYTES / bytesPerFrame)));
    if (this.frames.length >= cap) {
      // Thin the history by half to stay bounded while keeping the whole run scrubbable.
      this.frames = this.frames.filter((_, i) => i % 2 === 0);
    }
    this.frames.push({
      time: s.time,
      angleDeg: s.angleDeg,
      positions: s.positions.slice(),
      status: s.status.slice(),
      speed: s.speed.slice(),
      temperature: s.temperature?.slice() ?? null,
    });
    const scrub = this.el<HTMLInputElement>('scrub');
    scrub.max = String(this.frames.length - 1);
    if (this.scrubIndex < 0) scrub.value = scrub.max;
  }

  private onFinished(): void {
    if (this.recorded || !this.metrics || !this.info || !this.diagnostics) return;
    this.recorded = true;
    const m = this.metrics;
    const names = this.info.bandNames;
    const comp = m.composition.dischargedFractions
      ? m.composition.dischargedFractions.map((f, k) => `${names[k]} ${(f * 100).toFixed(0)}%`).join(', ')
      : 'none';
    const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
    this.runs.push({
      name: this.info.config.name,
      seed: this.info.config.seed,
      quality: this.info.config.cellsAcrossBody,
      dischargedMl: m.composition.dischargedVolume * 1e6,
      targetMl: this.info.config.motion.targetVolume * 1e6,
      composition: comp,
      segregationNow: fmt(m.mixing.survivorNow[1]),
      segregationSurvivorInitial: fmt(m.mixing.survivorInitial[1]),
      pressureFailures: this.diagnostics.pressureFailures,
    });
    this.renderComparison();
  }

  private updateStatusLine(): void {
    const d = this.diagnostics;
    if (!d || !this.info) return;
    const rt =
      this.running && this.realtimeFactor < 0.95
        ? ` (computing at ${(this.realtimeFactor * 100).toFixed(0)}% of the chosen speed)`
        : '';
    this.setStatus(
      `t = ${d.time.toFixed(2)} s of ${this.info.config.duration} s, tilt ${d.angleDeg.toFixed(1)} deg (${d.phase}), poured ${(d.volumeDischarged * 1e6).toFixed(0)} mL${rt}${this.finished ? ' - finished' : ''}`,
    );
  }

  // ------------------------------------------------------------ rendering

  theme(): Theme {
    const cs = this.d.doc.defaultView?.getComputedStyle(this.d.doc.documentElement);
    const v = (name: string, fb: string) => cs?.getPropertyValue(name).trim() || fb;
    return {
      surface: v('--surface', '#fcfcfb'),
      ink: v('--ink', '#1d1f22'),
      muted: v('--muted', '#5b6068'),
      wall: v('--wall', '#3d4652'),
      grid: v('--grid', '#e1e2de'),
      dim: v('--dim', '#c9ccd1'),
      arrow: v('--arrow', '#444a52'),
      origins: [v('--origin-0', '#0072b2'), v('--origin-1', '#009e73'), v('--origin-2', '#d55e00')],
      glow: this.d.doc.documentElement.getAttribute('data-skin') === 'cyber',
    };
  }

  private buildLegend(): void {
    if (!this.info) return;
    const ul = this.el('legend');
    ul.innerHTML = '';
    const markers = ['circle', 'square', 'triangle'];
    this.info.bandNames.forEach((n, k) => {
      const li = this.d.doc.createElement('li');
      const sw = this.d.doc.createElement('span');
      sw.className = 'swatch';
      sw.style.background = `var(--origin-${k % 3})`;
      li.appendChild(sw);
      li.appendChild(this.d.doc.createTextNode(`started in ${n} third (${markers[k % 3]} marker)`));
      ul.appendChild(li);
    });
    const li = this.d.doc.createElement('li');
    li.className = 'legend-note';
    li.textContent =
      'Pathlines: trails of 30 sample parcels since the start, drawn relative to the pot (they move with it). Solid dot = where the parcel is now; hollow ring = where it left through the lip. The dashed line is the lip section that counts poured liquid.';
    ul.appendChild(li);
  }

  render(): void {
    const info = this.info;
    if (!info) return;
    const canvas = this.el<HTMLCanvasElement>('scene');
    const ctx = this.d.getContext(canvas);
    const frame =
      this.scrubIndex >= 0 && this.scrubIndex < this.frames.length && !this.running
        ? this.frames[this.scrubIndex]
        : null;
    const snap = this.snapshot;
    if (!ctx || !snap) return;
    const theme = this.theme();
    const glassW = 110;
    const vp = fitViewport(
      info.config.domainWidth,
      info.config.domainHeight,
      canvas.width - glassW - 10,
      canvas.height,
    );
    ctx.fillStyle = theme.surface;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const angle = frame ? frame.angleDeg : snap.angleDeg;
    drawVessel(ctx, vp, info, angle, theme);
    const mode = this.el<HTMLSelectElement>('mode').value as ColourMode;
    const opts = {
      mode,
      highlight: Number(this.el<HTMLSelectElement>('highlight').value),
      pathlines: this.el<HTMLInputElement>('pathlines').checked,
      arrows: this.el<HTMLInputElement>('arrows').checked,
      markers: this.el<HTMLInputElement>('markers').checked,
    };
    const shown: RenderSnapshot = frame
      ? {
          ...snap,
          time: frame.time,
          angleDeg: frame.angleDeg,
          positions: frame.positions,
          status: frame.status,
          speed: frame.speed,
          temperature: frame.temperature,
        }
      : snap;
    const tr: [number, number] = [
      Math.min(
        info.config.thermal.bottomTemperature,
        info.config.thermal.topTemperature,
        info.config.thermal.ambientTemperature + 40,
      ),
      Math.max(info.config.thermal.bottomTemperature, info.config.thermal.topTemperature),
    ];
    drawParcels(ctx, vp, info, shown, opts, theme, tr);
    if (opts.pathlines && this.metrics && !frame)
      drawPathlines(ctx, vp, info, this.metrics.pathlines, theme, shown.status, angle);
    if (opts.arrows && !frame) drawArrows(ctx, vp, this.arrows, theme);
    const byOrigin = frame
      ? new Array<number>(info.bandNames.length).fill(0)
      : this.metrics
        ? this.metrics.composition.dischargedByOrigin
        : [0, 0, 0];
    if (frame)
      for (let p = 0; p < frame.status.length; p++)
        if (frame.status[p] === STATUS_DISCHARGED) byOrigin[info.origin[p]] += info.parcelVolume;
    const cap = Math.max(info.config.motion.targetVolume * 1.4, 500e-6);
    drawGlass(
      ctx,
      canvas.width - glassW,
      canvas.height * 0.35,
      glassW - 20,
      canvas.height * 0.45,
      cap,
      byOrigin,
      info.bandNames,
      theme,
    );
    if (frame)
      this.el('scrubTime').textContent =
        `${frame.time.toFixed(2)} s (stored frame; charts and tables show latest results)`;
    else this.el('scrubTime').textContent = `${snap.time.toFixed(2)} s`;

    const im = this.el<HTMLCanvasElement>('initialMap');
    const ictx = this.d.getContext(im);
    const mapTheme = JSON.stringify(theme);
    let mapChanged = this.initialMapInfo !== info || this.initialMapTheme !== mapTheme;
    if (!mapChanged)
      for (let p = 0; p < shown.status.length; p++)
        if (shown.status[p] !== this.initialMapStatus[p]) {
          mapChanged = true;
          break;
        }
    if (ictx && mapChanged) {
      drawInitialMap(ictx, im.width, im.height, info, shown.status, theme);
      this.initialMapInfo = info;
      this.initialMapTheme = mapTheme;
      this.initialMapStatus = shown.status.slice();
    }
  }

  private updatePanels(): void {
    const m = this.metrics;
    const info = this.info;
    if (!m || !info) return;
    const theme = this.theme();
    const names = info.bandNames;
    const sum = this.el('summary');
    sum.innerHTML = '';
    for (const line of summarize(
      m.composition,
      m.mixing,
      names,
      info.config.motion.targetVolume * 1e6,
      this.finished,
    )) {
      const li = this.d.doc.createElement('li');
      li.textContent = line;
      sum.appendChild(li);
    }
    const draw = (id: string, fn: (ctx: Ctx2D, c: HTMLCanvasElement) => void) => {
      const c = this.el<HTMLCanvasElement>(id);
      const ctx = this.d.getContext(c);
      if (ctx) fn(ctx, c);
    };
    draw('binsChart', (ctx, c) => drawBinsChart(ctx, chartBox(c.width, c.height), m.bins, theme));
    draw('biasChart', (ctx, c) =>
      drawBiasChart(ctx, chartBox(c.width, c.height), m.composition.bias, names, theme),
    );
    const target = info.config.motion.targetVolume * 1e6;
    const maxOut = Math.max(target * 1.25, ...m.history.map((h) => h.discharged * 1e6), 50);
    draw('dischargeChart', (ctx, c) =>
      drawTimeSeries(
        ctx,
        chartBox(c.width, c.height),
        m.history,
        (h) => h.discharged * 1e6,
        info.config.duration,
        maxOut,
        ' mL',
        theme,
        target > 0 ? target : null,
      ),
    );
    draw('angleChart', (ctx, c) =>
      drawTimeSeries(
        ctx,
        chartBox(c.width, c.height),
        m.history,
        (h) => h.angleDeg,
        info.config.duration,
        Math.max(10, info.config.motion.maxAngleDeg),
        ' deg',
        theme,
        null,
      ),
    );
    this.renderTables();
    this.renderDiagnostics();
  }

  private table(head: string[], rows: (string | number)[][], caption: string): string {
    const esc = (s: string | number) =>
      String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    return `<table><caption class="hint">${esc(caption)}</caption><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
  }

  private renderTables(): void {
    const m = this.metrics!;
    const names = this.info!.bandNames;
    const c = m.composition;
    const pct = (v: number | null | undefined) =>
      v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;
    let html = this.table(
      ['Layer', 'Initial share F', 'Poured share P', 'B = P/F', 'Poured mL'],
      names.map((n, k) => [
        n,
        pct(c.initialFractions[k]),
        pct(c.dischargedFractions?.[k]),
        c.bias?.[k] === null || c.bias?.[k] === undefined ? 'n/a' : c.bias[k]!.toFixed(2),
        (c.dischargedByOrigin[k] * 1e6).toFixed(1),
      ]),
      `Origin of poured liquid (initially in spout: ${(c.dischargedFromSpout * 1e6).toFixed(1)} mL)`,
    );
    html += this.table(
      ['Bin (mL)', ...names],
      m.bins.map((b) => [
        `${(b.from * 1e6).toFixed(0)}-${(b.to * 1e6).toFixed(0)}${b.partial ? ' (partial)' : ''}`,
        ...b.byOrigin.map((v) => (v * 1e6).toFixed(1)),
      ]),
      'Composition per 50 mL of discharge (2D-equivalent mL)',
    );
    html += this.table(
      ['From layer', ...m.regions.columns],
      m.regions.fractions.map((row, k) => [names[k], ...row.map((v) => `${(v * 100).toFixed(1)}%`)]),
      'Where each starting layer is now (row-normalised; zones use the initial layer heights in pot coordinates)',
    );
    const f = (v: number | null) => (v === null ? 'n/a' : v.toFixed(4));
    html += this.table(
      [
        'Bin size',
        'S remaining now',
        'S initial (all)',
        'Survivors: S initial',
        'Survivors: S now',
        'Excluded',
      ],
      m.mixing.scales.map((s, i) => [
        `${(s * 100).toFixed(0)} cm`,
        f(m.mixing.remainingNow[i]),
        f(m.mixing.initialAll[i]),
        f(m.mixing.survivorInitial[i]),
        f(m.mixing.survivorNow[i]),
        `${(m.mixing.excludedFraction[i] * 100).toFixed(1)}%`,
      ]),
      `Segregation S (lower = more uniform at that scale; bins with < 4 parcels excluded). Survivor cohort: ${m.mixing.survivorCount} parcels.`,
    );
    this.el('tables').innerHTML = html;
  }

  private renderDiagnostics(): void {
    const d = this.diagnostics;
    const info = this.info;
    if (!d || !info) return;
    const ml = (v: number) => `${(v * 1e6).toFixed(1)} mL`;
    const cfg = info.config;
    const rows: [string, string][] = [
      ['Initial volume', ml(d.volumeInitial)],
      ['In pot', ml(d.volumeInPot)],
      ['Discharged', ml(d.volumeDischarged)],
      [
        'Target / overshoot',
        cfg.motion.targetVolume > 0
          ? `${ml(cfg.motion.targetVolume)} / ${ml(d.volumeDischarged - cfg.motion.targetVolume)}`
          : 'no target',
      ],
      ['Spilled', ml(d.volumeSpilled)],
      ['Unaccounted (lost)', ml(d.volumeLost)],
      ['Ledger error', `${(d.ledgerError * 1e6).toExponential(2)} mL`],
      ['Simulated time', `${d.time.toFixed(3)} s`],
      ['Grid / cell size', `${d.gridNx} x ${d.gridNy}, ${(d.cellSize * 1000).toFixed(2)} mm`],
      ['Parcels', `${d.particleCount} (depth b = ${(info.depth * 100).toFixed(2)} cm)`],
      ['Substeps last frame / dt', `${d.substepsLastAdvance} / ${(d.dtLast * 1000).toFixed(2)} ms`],
      ['Pressure iterations (max)', `${d.pressureIterations} (${d.pressureIterationsMax})`],
      [
        'Pressure residual',
        `${d.pressureResidual.toExponential(2)} 1/s ${d.pressureConverged ? '(converged)' : '(NOT converged)'}`,
      ],
      ['Pressure failures', String(d.pressureFailures)],
      [
        'Max divergence before / after',
        `${d.divergenceBefore.toExponential(2)} / ${d.divergenceAfter.toExponential(2)} 1/s`,
      ],
      ['Interior parcel density', d.interiorDensity.toFixed(3)],
      ['Represented-volume drift', `${(d.representedDrift * 100).toFixed(1)}%`],
      ['Transfer', cfg.transfer === 'flip' ? `PIC/FLIP, FLIP fraction ${cfg.flipRatio}` : 'APIC'],
      [
        'Density correction',
        `${cfg.densityCorrection}, moved ${d.densityCorrectionDisplacement.toFixed(3)} m total`,
      ],
      ['Wall collisions', `${d.collisionCorrections}, ${d.collisionDisplacement.toFixed(3)} m total`],
      ['Wall treatment', 'free-slip, voxelised'],
      ['Viscosity', cfg.viscosity ? `${cfg.kinematicViscosity.toExponential(2)} m2/s (explicit)` : 'off'],
      ['Thermal mode', cfg.thermal.mode],
      ['Thermal diffusivity', `${cfg.thermalDiffusivity.toExponential(2)} m2/s`],
      [
        'Mean temperature',
        cfg.thermal.mode === 'off' ? 'n/a' : `${(d.meanTemperature - 273.15).toFixed(2)} degC`,
      ],
      ['Max speed', `${d.maxSpeed.toFixed(3)} m/s`],
      ['Compute per frame', `${d.wallClockMsLastAdvance.toFixed(1)} ms`],
      ['Model version', `app ${this.d.version}`],
    ];
    this.el('diagList').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  private renderComparison(): void {
    this.el('comparison').innerHTML = this.table(
      ['Run', 'Poured mL', 'Composition', 'Survivors S (2 cm) initial -> now', 'Res.', 'Seed'],
      this.runs.map((r) => [
        r.name,
        `${r.dischargedMl.toFixed(0)}${r.targetMl > 0 ? ` / ${r.targetMl.toFixed(0)}` : ''}`,
        r.composition,
        `${r.segregationSurvivorInitial} -> ${r.segregationNow}`,
        r.quality,
        r.seed,
      ]),
      'Finished runs in this session',
    );
  }

  // ------------------------------------------------------------ loop

  tick(): void {
    // At most one frame request in flight; the worker steps the simulation on its own.
    if (this.info && !this.pending && this.running) {
      this.pending = true;
      this.post({ type: 'frame' });
    }
    this.d.schedule(() => this.tick());
  }
}
