// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Dedicated Web Worker entry: forwards messages to SimulationHost and transfers
// freshly allocated snapshot buffers (the solver keeps its own state untouched).

import { SimulationHost, type ToWorker } from './host';

const host = new SimulationHost(__APP_VERSION__);
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  for (const out of host.handle(e.data)) {
    const transfer: Transferable[] = [];
    if (out.type === 'frame' || out.type === 'ready') {
      transfer.push(out.snapshot.positions.buffer, out.snapshot.status.buffer, out.snapshot.speed.buffer);
      if (out.snapshot.temperature) transfer.push(out.snapshot.temperature.buffer);
      if (out.type === 'frame') transfer.push(out.arrows.buffer);
    }
    ctx.postMessage(out, transfer);
  }
};
