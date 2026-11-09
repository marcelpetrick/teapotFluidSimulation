// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Scene parts shared by the recorded playback and the live WebGPU view: lights, the transparent pot
// shell (body, floor, spout) rotating about the pivot, and the starting camera pose.

import {
  AmbientLight,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  type Object3D,
  PerspectiveCamera,
  Vector3,
  type Scene,
} from 'three';
import type { Teapot3DConfig } from '../sim3d/vessel3d';

/** Where the pot sits in the simulation's world frame. */
export interface PotPlacement {
  teapot: Teapot3DConfig;
  /** Tilt pivot in pot-local x, y (m). */
  pivot: [number, number];
  /** World position of the pivot (m). */
  pivotWorld: [number, number];
  /** World z of the symmetry plane (local z = 0). */
  zOffset: number;
}

export function addLights(scene: Scene): void {
  scene.add(new AmbientLight(0xffffff, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.5, 1, 0.8);
  scene.add(sun);
}

/** Transparent pot shell; rotate the returned group's z to tilt (radians, negative pours). */
export function buildPot(p: PotPlacement, wall: string): { pot: Group; glass: MeshStandardMaterial } {
  const t = p.teapot;
  const glass = new MeshStandardMaterial({
    color: new Color(wall),
    transparent: true,
    opacity: 0.22,
    side: DoubleSide,
    depthWrite: false,
    roughness: 0.15,
    metalness: 0,
  });
  const bodyR = t.radius + t.wall / 2;
  const body = new Mesh(new CylinderGeometry(bodyR, bodyR, t.height + t.wall, 64, 1, true), glass);
  body.position.set(0, (t.height - t.wall) / 2, 0);
  const floor = new Mesh(new CircleGeometry(bodyR, 64), glass);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -t.wall / 2;
  const a = (t.spoutAngleDeg * Math.PI) / 180;
  const spoutLen = t.spoutLength;
  const spout = new Mesh(
    new CylinderGeometry(t.boreRadius + t.wall / 2, t.boreRadius + t.wall / 2, spoutLen, 32, 1, true),
    glass,
  );
  // Cylinder axis is y: rotate so it points along (cos a, sin a, 0), centred mid-way along the spout.
  spout.rotation.z = a - Math.PI / 2;
  const ax = t.radius - t.wall;
  spout.position.set(ax + (Math.cos(a) * spoutLen) / 2, t.inletHeight + (Math.sin(a) * spoutLen) / 2, 0);
  const inner = new Group();
  inner.add(body, floor, spout);
  inner.position.set(-p.pivot[0], -p.pivot[1], 0);
  const pot = new Group();
  pot.add(inner);
  pot.position.set(p.pivotWorld[0], p.pivotWorld[1], p.zOffset);
  return { pot, glass };
}

/** Camera looking at the pot from the front-right, slightly above, and its orbit target. */
export function startCamera(p: PotPlacement): { camera: PerspectiveCamera; target: Vector3 } {
  const camera = new PerspectiveCamera(38, 1, 0.01, 10);
  const target = new Vector3(p.pivotWorld[0] + 0.03, p.pivotWorld[1] + 0.01, p.zOffset);
  camera.position.set(target.x + 0.18, target.y + 0.16, target.z + 0.5);
  return { camera, target };
}

/** Release scene-owned geometry and materials, including shared pot materials only once. */
export function disposeObjects(root: Object3D): void {
  const geometries = new Set<import('three').BufferGeometry>();
  const materials = new Set<import('three').Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof Points)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
