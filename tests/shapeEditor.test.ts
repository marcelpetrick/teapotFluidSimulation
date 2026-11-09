// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  AREA,
  ShapeEditor,
  TEMPLATES,
  clampPoint,
  drawEditor,
  editorView,
  hitTest,
  insertPoint,
  placeTemplate,
  removePoint,
  type Pt,
} from '../src/ui/shapeEditor';
import { validateProfile } from '../src/sim/config';
import { fakeCtx } from './helpers';

const theme = {
  surface: '#fff',
  ink: '#000',
  muted: '#555',
  wall: '#333',
  grid: '#ddd',
  dim: '#ccc',
  arrow: '#444',
  origins: ['#0072b2', '#009e73', '#d55e00'],
};

describe('shape editor geometry', () => {
  it('every template is a valid pot once placed', () => {
    for (const make of Object.values(TEMPLATES)) expect(validateProfile(placeTemplate(make()))).toEqual([]);
  });

  it('hit test, insert, remove, clamp', () => {
    const pts: Pt[] = [
      [0, 0.1],
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
    ];
    expect(hitTest(pts, 0.101, 0.001, 0.005)).toBe(2);
    expect(hitTest(pts, 0.05, 0.05, 0.005)).toBe(-1);
    const ins = insertPoint(pts, 0.05, -0.001);
    expect(ins.index).toBe(2);
    expect(ins.pts).toHaveLength(5);
    expect(removePoint(ins.pts, 2)).toEqual(pts);
    expect(removePoint(pts.slice(0, 3), 0)).toHaveLength(3); // keeps at least three points
    expect(removePoint(pts, 9)).toBe(pts);
    expect(clampPoint(-1, 9)).toEqual([0, AREA.height]);
    expect(clampPoint(0.12345, 0.06789)).toEqual([0.123, 0.068]);
  });

  it('view maps world to pixels and back', () => {
    const v = editorView(460, 350);
    const [sx, sy] = v.toPx([0.1, 0.05]);
    const [x, y] = v.toWorld(sx, sy);
    expect(x).toBeCloseTo(0.1, 12);
    expect(y).toBeCloseTo(0.05, 12);
  });

  it('draws grid, wall, fill line and handles', () => {
    const ctx = fakeCtx();
    drawEditor(ctx, 460, 350, placeTemplate(TEMPLATES.glass()), 1, 0.08, theme);
    expect(ctx.calls.filter((c) => c === 'arc').length).toBe(placeTemplate(TEMPLATES.glass()).length);
    expect(ctx.calls).toContain('fillText');
  });
});

describe('ShapeEditor (DOM)', () => {
  function setup() {
    document.body.innerHTML = `
      <button id="shape-glass"></button><button id="shape-pitcher"></button>
      <button id="shape-bowl"></button><button id="shape-jug"></button>
      <button id="shapeNext"></button><button id="shapeAdd"></button><p id="shapePoint"></p><button id="shapeRemove"></button><canvas id="shapeCanvas" tabindex="0" width="460" height="350"></canvas>
      <p id="shapeErrors"></p><button id="shapeUse"></button>`;
    const used: Pt[][] = [];
    const ed = new ShapeEditor(
      document,
      { getContext: () => fakeCtx(), theme: () => theme, fillHeight: () => 0.08, onUse: (p) => used.push(p) },
      null,
    );
    ed.bind();
    const c = document.getElementById('shapeCanvas') as HTMLCanvasElement;
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 460, height: 350 }) as DOMRect;
    return { ed, c, used };
  }
  const at = (ed: ShapeEditor, i: number) => editorView(460, 350).toPx(ed.pts[i]);

  it('drags, inserts, removes, switches templates and uses the shape', () => {
    const { ed, c, used } = setup();
    const n0 = ed.pts.length;
    const [sx, sy] = at(ed, 0);
    c.dispatchEvent(new MouseEvent('pointerdown', { clientX: sx, clientY: sy }));
    expect(ed.selected).toBe(0);
    c.dispatchEvent(new MouseEvent('pointermove', { clientX: sx, clientY: sy - 20 }));
    c.dispatchEvent(new MouseEvent('pointerup'));
    expect(ed.pts[0][1]).toBeGreaterThan(placeTemplate(TEMPLATES.glass())[0][1]);
    c.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0 })); // not dragging: no change
    const [bx, by] = editorView(460, 350).toPx([AREA.width / 2, 0.011]);
    c.dispatchEvent(new MouseEvent('dblclick', { clientX: bx, clientY: by }));
    expect(ed.pts).toHaveLength(n0 + 1);
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(ed.pts).toHaveLength(n0);
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    (document.getElementById('shape-bowl') as HTMLButtonElement).click();
    expect(ed.pts).toHaveLength(TEMPLATES.bowl().length);
    (document.getElementById('shapeUse') as HTMLButtonElement).click();
    expect(used).toHaveLength(1);
    // Break the shape: the lip left of the rim is rejected, Use does nothing.
    ed.pts = ed.pts.map((p, i) => (i === ed.pts.length - 1 ? [0, p[1]] : p));
    ed.render();
    expect(document.getElementById('shapeErrors')!.textContent).toMatch(/back rim/);
    (document.getElementById('shapeUse') as HTMLButtonElement).click();
    expect(used).toHaveLength(1);
    ed.selected = 1;
    ed.render();
    (document.getElementById('shapeRemove') as HTMLButtonElement).click();
    c.dispatchEvent(new MouseEvent('pointerleave'));
  });

  it('supports point controls, keyboard movement and cancellation on touch layouts', () => {
    const { ed, c } = setup();
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 230, height: 175 }) as DOMRect;
    document.getElementById('shapeNext')!.click();
    expect(document.activeElement).toBe(c);
    expect(ed.selected).toBe(0);
    const before = ed.pts[0][1];
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true }));
    expect(ed.pts[0][1]).toBeCloseTo(before + 0.005);
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    expect(ed.selected).toBe(ed.pts.length - 1);
    const count = ed.pts.length;
    document.getElementById('shapeAdd')!.click();
    expect(ed.pts).toHaveLength(count + 1);
    expect(document.getElementById('shapePoint')!.textContent).toContain('cm');
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(ed.selected).toBe(0);
    c.dispatchEvent(new Event('pointercancel'));
  });

  it('starts from a given outline', () => {
    document.body.innerHTML =
      '<canvas id="shapeCanvas"></canvas><p id="shapeErrors"></p><button id="shapeUse"></button><button id="shapeRemove"></button>';
    const ed = new ShapeEditor(
      document,
      { getContext: () => null, theme: () => theme, fillHeight: () => 0.05, onUse: () => {} },
      TEMPLATES.jug(),
    );
    ed.bind();
    expect(ed.pts).toHaveLength(TEMPLATES.jug().length);
  });
});
