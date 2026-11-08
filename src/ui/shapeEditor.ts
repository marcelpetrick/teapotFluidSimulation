// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Pot shape editor: the user drags the wall outline (centreline) of a pot, from the back rim,
// round the bottom, to the pouring lip. Pure geometry helpers are exported for testing; the
// editor class binds them to a canvas with pointer and keyboard input.

import { buildVessel } from '../sim/vessel';
import { defaultProfile, defaultVessel, validateProfile } from '../sim/config';
import type { Ctx2D, Theme } from '../render/scene';

export type Pt = [number, number];

/** Editor area in metres (x right, y up) and its pixel scale. */
export const AREA = { width: 0.36, height: 0.27, margin: 12 };

export const TEMPLATES: Record<string, () => Pt[]> = {
  glass: () => defaultProfile(),
  pitcher: () => buildVessel(defaultVessel('pitcher')).polylines[0].map(([x, y]) => [x, y] as Pt),
  bowl: () => [
    [0.0, 0.1],
    [0.01, 0.04],
    [0.05, 0.005],
    [0.15, 0.005],
    [0.19, 0.04],
    [0.21, 0.1],
  ],
  jug: () => [
    [0.0, 0.2],
    [0.0, 0.02],
    [0.02, 0.0],
    [0.1, 0.0],
    [0.12, 0.02],
    [0.12, 0.17],
    [0.15, 0.21],
  ],
};

/** Index of the point within `radius` metres of (x, y), or -1. */
export function hitTest(pts: Pt[], x: number, y: number, radius: number): number {
  let best = -1;
  let bestD = radius;
  pts.forEach(([px, py], i) => {
    const d = Math.hypot(px - x, py - y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** Insert a point into the segment closest to (x, y); returns the new list and the new index. */
export function insertPoint(pts: Pt[], x: number, y: number): { pts: Pt[]; index: number } {
  let bestSeg = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
    const d = Math.hypot(x - (ax + t * ex), y - (ay + t * ey));
    if (d < bestD) {
      bestD = d;
      bestSeg = i;
    }
  }
  const out = pts.slice();
  out.splice(bestSeg + 1, 0, [x, y]);
  return { pts: out, index: bestSeg + 1 };
}

export function removePoint(pts: Pt[], index: number): Pt[] {
  if (pts.length <= 3 || index < 0 || index >= pts.length) return pts;
  return pts.filter((_, i) => i !== index);
}

/** Clamp to the editor area and snap to whole millimetres. */
export function clampPoint(x: number, y: number): Pt {
  const cx = Math.max(0, Math.min(AREA.width, x));
  const cy = Math.max(0, Math.min(AREA.height, y));
  return [Math.round(cx * 1000) / 1000, Math.round(cy * 1000) / 1000];
}

/** Place a template so it sits on the editor floor, horizontally centred. */
export function placeTemplate(pts: Pt[]): Pt[] {
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const dx = (AREA.width - (maxX - minX)) / 2 - minX;
  const dy = 0.01 - minY;
  return pts.map(([x, y]) => clampPoint(x + dx, y + dy));
}

export interface EditorView {
  scale: number;
  toPx: (p: Pt) => [number, number];
  toWorld: (sx: number, sy: number) => Pt;
}

export function editorView(width: number, height: number): EditorView {
  const m = AREA.margin;
  const scale = Math.min((width - 2 * m) / AREA.width, (height - 2 * m) / AREA.height);
  return {
    scale,
    toPx: ([x, y]) => [m + x * scale, height - m - y * scale],
    toWorld: (sx, sy) => [(sx - m) / scale, (height - m - sy) / scale],
  };
}

/** Draw grid, wall outline, fill preview and handles. */
export function drawEditor(
  ctx: Ctx2D,
  width: number,
  height: number,
  pts: Pt[],
  selected: number,
  fillHeight: number,
  theme: Theme,
): void {
  const v = editorView(width, height);
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  for (let g = 0; g <= AREA.width + 1e-9; g += 0.02) {
    const [x0, y0] = v.toPx([g, 0]);
    const [, y1] = v.toPx([g, AREA.height]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.stroke();
  }
  for (let g = 0; g <= AREA.height + 1e-9; g += 0.02) {
    const [x0, y0] = v.toPx([0, g]);
    const [x1] = v.toPx([AREA.width, g]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y0);
    ctx.stroke();
  }
  // Fill preview: the liquid level above the lowest wall point (inner floor).
  const floor = Math.min(...pts.map((p) => p[1])) + 0.005;
  ctx.strokeStyle = theme.origins[0];
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  const [fx0, fy] = v.toPx([0, floor + fillHeight]);
  const [fx1] = v.toPx([AREA.width, floor + fillHeight]);
  ctx.moveTo(fx0, fy);
  ctx.lineTo(fx1, fy);
  ctx.stroke();
  ctx.setLineDash([]);
  // Wall.
  ctx.strokeStyle = theme.wall;
  ctx.lineWidth = Math.max(2, 0.01 * v.scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [sx, sy] = v.toPx(p);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.stroke();
  // Handles.
  pts.forEach((p, i) => {
    const [sx, sy] = v.toPx(p);
    ctx.beginPath();
    ctx.arc(sx, sy, i === selected ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = i === pts.length - 1 ? theme.origins[2] : i === selected ? theme.ink : theme.surface;
    ctx.fill();
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  ctx.fillStyle = theme.muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const [rx, ry] = v.toPx(pts[0]);
  ctx.fillText('back rim', rx + 8, ry);
  const [lx, ly] = v.toPx(pts[pts.length - 1]);
  ctx.fillText('lip (pours here)', Math.min(lx + 8, width - 90), ly);
}

export interface EditorHost {
  getContext: (c: HTMLCanvasElement) => Ctx2D | null;
  theme: () => Theme;
  fillHeight: () => number;
  onUse: (pts: Pt[]) => void;
}

/** Binds the editor to its canvas and buttons. */
export class ShapeEditor {
  pts: Pt[];
  selected = -1;
  private dragging = -1;

  constructor(
    private doc: Document,
    private host: EditorHost,
    initial: Pt[] | null,
  ) {
    this.pts = placeTemplate(initial ?? TEMPLATES.glass());
  }

  private el<T extends HTMLElement>(id: string): T {
    return this.doc.getElementById(id) as T;
  }

  bind(): void {
    const c = this.el<HTMLCanvasElement>('shapeCanvas');
    const pos = (e: MouseEvent): Pt => {
      const r = c.getBoundingClientRect();
      const sx = r.width > 0 ? c.width / r.width : 1;
      const sy = r.height > 0 ? c.height / r.height : 1;
      const v = editorView(c.width, c.height);
      return v.toWorld((e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
    };
    const radius = () => 10 / editorView(c.width, c.height).scale;
    c.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      this.selected = hitTest(this.pts, x, y, radius());
      this.dragging = this.selected;
      this.render();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.dragging < 0) return;
      const [x, y] = pos(e);
      this.pts = this.pts.map((p, i) => (i === this.dragging ? clampPoint(x, y) : p));
      this.render();
    });
    const stop = () => {
      this.dragging = -1;
    };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointerleave', stop);
    c.addEventListener('dblclick', (e) => {
      const [x, y] = pos(e);
      const r = insertPoint(this.pts, ...clampPoint(x, y));
      this.pts = r.pts;
      this.selected = r.index;
      this.render();
    });
    c.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.removeSelected();
      }
    });
    for (const name of Object.keys(TEMPLATES)) {
      this.doc.getElementById(`shape-${name}`)?.addEventListener('click', () => {
        this.pts = placeTemplate(TEMPLATES[name]());
        this.selected = -1;
        this.render();
      });
    }
    this.el('shapeRemove').addEventListener('click', () => this.removeSelected());
    this.el('shapeUse').addEventListener('click', () => {
      if (validateProfile(this.pts).length === 0) this.host.onUse(this.pts);
      else this.render();
    });
    this.render();
  }

  removeSelected(): void {
    this.pts = removePoint(this.pts, this.selected);
    this.selected = -1;
    this.render();
  }

  render(): void {
    const c = this.el<HTMLCanvasElement>('shapeCanvas');
    const ctx = this.host.getContext(c);
    if (ctx)
      drawEditor(ctx, c.width, c.height, this.pts, this.selected, this.host.fillHeight(), this.host.theme());
    const errs = validateProfile(this.pts);
    this.el('shapeErrors').textContent = errs.join(' ');
    this.el<HTMLButtonElement>('shapeUse').disabled = errs.length > 0;
  }
}
