// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// 3D teapot geometry for the offline reference: a hollow cylindrical body with a floor and an
// inclined round spout tube drilled through the body wall. Local frame: y up, the body axis on
// x = z = 0, inner floor at y = 0, the spout points toward +x. Signed distance is negative inside
// the solid (glass/ceramic) and positive in liquid or air.

export interface Teapot3DConfig {
  /** Inner radius of the cylindrical body (m). */
  radius: number;
  /** Inner height of the body (m). */
  height: number;
  wall: number;
  /** Spout: inlet centre height, inner bore radius, elevation angle (deg) and length (m). */
  inletHeight: number;
  boreRadius: number;
  spoutAngleDeg: number;
  spoutLength: number;
}

export function defaultTeapot3D(): Teapot3DConfig {
  return {
    radius: 0.065,
    height: 0.15,
    wall: 0.008,
    inletHeight: 0.035,
    boreRadius: 0.01,
    spoutAngleDeg: 45,
    spoutLength: 0.14,
  };
}

export interface Teapot3D {
  cfg: Teapot3DConfig;
  /** Spout axis start (inside the body wall) and unit direction. */
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  /** Lip: centre of the spout mouth. */
  tipX: number;
  tipY: number;
}

export function buildTeapot3D(cfg: Teapot3DConfig): Teapot3D {
  const a = (cfg.spoutAngleDeg * Math.PI) / 180;
  const ax = cfg.radius - cfg.wall; // start a little inside the body so the bore cuts the wall cleanly
  const ay = cfg.inletHeight;
  return {
    cfg,
    ax,
    ay,
    dx: Math.cos(a),
    dy: Math.sin(a),
    tipX: ax + Math.cos(a) * cfg.spoutLength,
    tipY: ay + Math.sin(a) * cfg.spoutLength,
  };
}

/** Distance from (x, y, z) to the spout axis segment, and the axial parameter t (m). */
function spoutAxis(t: Teapot3D, x: number, y: number, z: number): [number, number] {
  const px = x - t.ax;
  const py = y - t.ay;
  const s = px * t.dx + py * t.dy; // axial coordinate (unclamped)
  const L = t.cfg.spoutLength;
  const sc = s < 0 ? 0 : s > L ? L : s;
  const qx = px - sc * t.dx;
  const qy = py - sc * t.dy;
  return [Math.sqrt(qx * qx + qy * qy + z * z), s];
}

/** Signed distance to the solid (negative inside the walls). */
export function teapotSdf(t: Teapot3D, x: number, y: number, z: number): number {
  const c = t.cfg;
  const hw = c.wall / 2;
  const r = Math.sqrt(x * x + z * z);
  // Body side wall: an annulus between radius and radius + wall, from the floor to the rim.
  const ring = Math.abs(r - (c.radius + hw)) - hw;
  const yIn = Math.max(-(y + c.wall), y - c.height); // inside the wall's height range when < 0
  const side = Math.max(ring, yIn);
  // Floor disk.
  const floor = Math.max(Math.abs(y + hw) - hw, r - (c.radius + c.wall));
  let solid = Math.min(side, floor);
  // Spout tube shell (between bore radius and bore radius + wall), along the axis segment.
  const [dist, s] = spoutAxis(t, x, y, z);
  const L = c.spoutLength;
  const along = Math.max(-s, s - L);
  const tube = Math.max(Math.abs(dist - (c.boreRadius + hw)) - hw, along);
  // Only the part of the tube outside the body is a wall.
  solid = Math.min(solid, Math.max(tube, c.radius - r));
  // Carve the bore through the body wall (the passage between body and spout).
  const bore = Math.max(dist - c.boreRadius, -s - c.wall, s - L);
  return Math.max(solid, -bore);
}

/** True when a point is in the liquid space: inside the body cavity or the spout bore. */
export function inCavity(t: Teapot3D, x: number, y: number, z: number): boolean {
  const c = t.cfg;
  if (y >= 0 && y <= c.height && x * x + z * z <= c.radius * c.radius) return true;
  const [dist, s] = spoutAxis(t, x, y, z);
  return s >= 0 && s <= c.spoutLength && dist <= c.boreRadius;
}
