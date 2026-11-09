// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Compact binary format for a recorded 3D pour (playback in the browser).
// Layout (little endian):
//   u32 headerLength | header JSON (UTF-8) | u8 origin[P] | u16 frame0[3P] | i16 delta[F-1][3P]
// Positions are quantised to `quantum` metres relative to (0, 0, 0) of the simulation domain and
// stored as deltas to the previous frame (small numbers that gzip compresses well).

import type { Teapot3DConfig } from '../sim3d/vessel3d';

export interface RecordingHeader {
  version: 1;
  frames: number;
  parcels: number;
  fps: number;
  quantum: number;
  cellMm: number;
  /** Parcels simulated in the half pot (the recording is a subsample). */
  simulatedParcels: number;
  teapot: Teapot3DConfig;
  pivot: [number, number];
  pivotWorld: [number, number];
  /** Offset of local z (the symmetry plane is at world z = zOffset). */
  zOffset: number;
  domain: [number, number, number];
  /** Tilt angle (degrees, positive toward the spout) per frame. */
  angles: number[];
  /** Poured millilitres per starting layer [bottom, middle, top] per frame. */
  poured: number[][];
  /** Final shares of the poured tea per layer (whole run, all simulated parcels). */
  finalShares: number[];
  label: string;
}

export interface Recording {
  header: RecordingHeader;
  origin: Uint8Array;
  /** positions[frame] = Float32Array(3P) in metres (world frame of the simulation). */
  positions: Float32Array[];
}

const MAX_U16 = 65535;

export function encodeRecording(
  header: RecordingHeader,
  origin: Uint8Array,
  frames: Float32Array[],
): Uint8Array {
  const P = header.parcels;
  const q = header.quantum;
  const head = new TextEncoder().encode(JSON.stringify(header));
  const size = 4 + head.length + P + frames.length * 3 * P * 2;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, head.length, true);
  buf.set(head, 4);
  let o = 4 + head.length;
  buf.set(origin, o);
  o += P;
  let prev = new Int32Array(3 * P);
  frames.forEach((f, k) => {
    const cur = new Int32Array(3 * P);
    for (let i = 0; i < 3 * P; i++) cur[i] = Math.max(0, Math.min(MAX_U16, Math.round(f[i] / q)));
    for (let i = 0; i < 3 * P; i++) {
      if (k === 0) dv.setUint16(o, cur[i], true);
      else dv.setInt16(o, Math.max(-32768, Math.min(32767, cur[i] - prev[i])), true);
      o += 2;
    }
    // Deltas are clamped to int16; keep the decoder in step with what was written.
    if (k > 0)
      for (let i = 0; i < 3 * P; i++) cur[i] = prev[i] + Math.max(-32768, Math.min(32767, cur[i] - prev[i]));
    prev = cur;
  });
  return buf;
}

export function decodeRecording(buf: Uint8Array): Recording {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hl = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl))) as RecordingHeader;
  if (header.version !== 1) throw new Error(`Unsupported recording version ${header.version}`);
  const P = header.parcels;
  let o = 4 + hl;
  const origin = buf.slice(o, o + P);
  o += P;
  const positions: Float32Array[] = [];
  const cur = new Int32Array(3 * P);
  for (let k = 0; k < header.frames; k++) {
    const f = new Float32Array(3 * P);
    for (let i = 0; i < 3 * P; i++) {
      cur[i] = k === 0 ? dv.getUint16(o, true) : cur[i] + dv.getInt16(o, true);
      o += 2;
      f[i] = cur[i] * header.quantum;
    }
    positions.push(f);
  }
  return { header, origin, positions };
}

/** Gunzip with the browser's (and Node's) native DecompressionStream. */
export async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
