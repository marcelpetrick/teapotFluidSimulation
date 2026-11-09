// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Interactive playback of the recorded 3D reference pour (three.js). The viewer rotates, zooms and
// pans freely (orbit controls) while the recorded automatic pour plays. It is a recording of the
// offline 3D solver, not a live simulation. Renderer, controls and scheduler are injected so the
// scene logic can be tested without WebGL.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
  type Camera,
} from 'three';
import type { Recording } from './format';
import { addLights, buildPot, startCamera, disposeObjects } from './scene';

export interface RendererLike {
  setSize(w: number, h: number, updateStyle?: boolean): void;
  setPixelRatio(r: number): void;
  setClearColor(c: Color | string, alpha?: number): void;
  render(scene: Scene, camera: Camera): void;
  dispose(): void;
}

export interface ControlsLike {
  target: Vector3;
  enableDamping: boolean;
  update(): void;
  saveState(): void;
  reset(): void;
  dispose(): void;
}

export interface ViewerDeps {
  createRenderer(canvas: HTMLCanvasElement): RendererLike;
  createControls(camera: PerspectiveCamera, element: HTMLElement): ControlsLike;
  schedule(cb: (t: number) => void): number;
  cancel(id: number): void;
  pixelRatio: number;
}

export interface ViewerTheme {
  background: string;
  wall: string;
  layers: [string, string, string];
}

/** Hidden parcels (fallen out of the recorded domain) are moved far below the view. */
const HIDE_Y = -100;

export class PourViewer {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private renderer: RendererLike;
  private controls: ControlsLike;
  private points: Points;
  private positions: Float32Array;
  private pot: Group;
  private raf = -1;
  private last = -1;
  /** Playback position in frames (fractional). */
  frame = 0;
  playing = true;
  speed = 1;
  onFrame: ((frame: number) => void) | null = null;
  private holdUntil = -1;

  private glass: MeshStandardMaterial | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    readonly rec: Recording,
    theme: ViewerTheme,
    private deps: ViewerDeps,
  ) {
    const h = rec.header;
    this.renderer = deps.createRenderer(canvas);
    this.renderer.setPixelRatio(deps.pixelRatio);
    this.renderer.setClearColor(new Color(theme.background), 1);
    addLights(this.scene);
    // Pot: transparent shell (body, floor, spout) rotating about the recorded pivot.
    const built = buildPot(h, theme.wall);
    this.pot = built.pot;
    this.glass = built.glass;
    this.scene.add(this.pot);

    // Parcels: the recorded half plus its mirror image across the symmetry plane.
    const P = h.parcels;
    this.positions = new Float32Array(6 * P);
    const colors = new Float32Array(6 * P);
    const pal = theme.layers.map((c) => new Color(c));
    for (let k = 0; k < P; k++) {
      const c = pal[rec.origin[k]] ?? pal[0];
      for (const m of [k, k + P]) {
        colors[3 * m] = c.r;
        colors[3 * m + 1] = c.g;
        colors[3 * m + 2] = c.b;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    this.points = new Points(
      geo,
      new PointsMaterial({ size: 0.0035, vertexColors: true, sizeAttenuation: true }),
    );
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    const cam = startCamera(h);
    this.camera = cam.camera;
    const target = cam.target;
    this.controls = deps.createControls(this.camera, canvas);
    this.controls.target.copy(target);
    this.controls.enableDamping = true;
    this.controls.update();
    this.controls.saveState();
    this.seek(0);
  }

  get frames(): number {
    return this.rec.header.frames;
  }

  /** Simulated time (s) of the current playback position. */
  get time(): number {
    return this.frame / this.rec.header.fps;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Jump to a (fractional) frame and update the pot pose and parcels by linear interpolation. */
  seek(frame: number): void {
    const h = this.rec.header;
    const f = Math.max(0, Math.min(h.frames - 1, frame));
    this.frame = f;
    const k = Math.floor(f);
    const k1 = Math.min(h.frames - 1, k + 1);
    const w = f - k;
    const A = this.rec.positions[k];
    const B = this.rec.positions[k1];
    const P = h.parcels;
    const z0 = h.zOffset;
    for (let p = 0; p < P; p++) {
      const x = A[3 * p] + (B[3 * p] - A[3 * p]) * w;
      let y = A[3 * p + 1] + (B[3 * p + 1] - A[3 * p + 1]) * w;
      const z = A[3 * p + 2] + (B[3 * p + 2] - A[3 * p + 2]) * w;
      if (y < 0.0005) y = HIDE_Y; // fell out of the recorded domain
      this.positions[3 * p] = x;
      this.positions[3 * p + 1] = y;
      this.positions[3 * p + 2] = z;
      const m = p + P;
      this.positions[3 * m] = x;
      this.positions[3 * m + 1] = y;
      this.positions[3 * m + 2] = 2 * z0 - z; // mirror image
    }
    (this.points.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    const ang = h.angles[k] + (h.angles[k1] - h.angles[k]) * w;
    this.pot.rotation.z = (-ang * Math.PI) / 180;
    this.onFrame?.(f);
  }

  /** Poured millilitres per starting layer at the current frame. */
  poured(): number[] {
    return this.rec.header.poured[Math.floor(this.frame)];
  }

  angleDeg(): number {
    return this.rec.header.angles[Math.floor(this.frame)];
  }

  /** Re-colour for a new look (background, glass, layer colours). */
  applyTheme(theme: ViewerTheme): void {
    this.renderer.setClearColor(new Color(theme.background), 1);
    this.glass?.color.set(theme.wall);
    const pal = theme.layers.map((c) => new Color(c));
    const col = this.points.geometry.getAttribute('color') as BufferAttribute;
    const P = this.rec.header.parcels;
    for (let k = 0; k < P; k++) {
      const c = pal[this.rec.origin[k]] ?? pal[0];
      col.setXYZ(k, c.r, c.g, c.b);
      col.setXYZ(k + P, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  resetView(): void {
    this.controls.reset();
  }

  /** Advance playback by a wall-clock interval (ms); loops with a short hold at the end. */
  tick(dtMs: number, nowMs: number): void {
    if (this.playing) {
      const end = this.rec.header.frames - 1;
      if (this.frame >= end) {
        if (this.holdUntil < 0) this.holdUntil = nowMs + 1500;
        else if (nowMs >= this.holdUntil) {
          this.holdUntil = -1;
          this.seek(0);
        }
      } else this.seek(this.frame + (dtMs / 1000) * this.rec.header.fps * this.speed);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  start(): void {
    const loop = (t: number) => {
      const dt = this.last < 0 ? 0 : Math.min(100, t - this.last);
      this.last = t;
      this.tick(dt, t);
      this.raf = this.deps.schedule(loop);
    };
    this.raf = this.deps.schedule(loop);
  }

  dispose(): void {
    if (this.raf >= 0) this.deps.cancel(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
    disposeObjects(this.scene);
  }
}
