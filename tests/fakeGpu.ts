// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// A recording fake of the WebGPU API subset used by src/gpu3d. Buffers have real backing memory,
// writeBuffer / copyBufferToBuffer / clearBuffer move bytes, compute dispatches are only recorded
// (kernels run in the browser tests, e2e/gpu.spec.ts). Enough to test the host orchestration.

export interface FakeGpu {
  device: GPUDevice;
  calls: string[];
  dispatches: { name: string; x: number; y: number }[];
  buffers: FakeBuffer[];
}

export class FakeBuffer {
  readonly data: Uint8Array;
  destroyed = false;
  mapped = false;
  constructor(
    readonly label: string,
    readonly size: number,
    readonly usage: number,
  ) {
    this.data = new Uint8Array(size);
  }
  async mapAsync(): Promise<void> {
    this.mapped = true;
  }
  getMappedRange(): ArrayBuffer {
    return this.data.buffer.slice(0) as ArrayBuffer;
  }
  unmap(): void {
    this.mapped = false;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export function fakeGpu(
  limits = { maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256 },
): FakeGpu {
  const calls: string[] = [];
  const dispatches: { name: string; x: number; y: number }[] = [];
  const buffers: FakeBuffer[] = [];
  const bytes = (d: BufferSource): Uint8Array =>
    d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  const device = {
    limits,
    queue: {
      writeBuffer(b: FakeBuffer, offset: number, data: BufferSource) {
        b.data.set(bytes(data), offset);
      },
      submit(list: unknown[]) {
        calls.push(`submit:${list.length}`);
      },
    },
    createBuffer(d: { label?: string; size: number; usage: number }) {
      const b = new FakeBuffer(d.label ?? '', d.size, d.usage);
      buffers.push(b);
      return b;
    },
    createShaderModule(d: { label?: string; code: string }) {
      calls.push(`module:${d.label}`);
      return { code: d.code };
    },
    createBindGroupLayout: (d: unknown) => ({ layout: d }),
    createPipelineLayout: (d: unknown) => ({ pipelineLayout: d }),
    createBindGroup: (d: unknown) => ({ group: d }),
    createComputePipeline(d: { label?: string }) {
      return { name: d.label };
    },
    createCommandEncoder() {
      return {
        clearBuffer(b: FakeBuffer, offset = 0, size = b.size - offset) {
          b.data.fill(0, offset, offset + size);
        },
        copyBufferToBuffer(src: FakeBuffer, so: number, dst: FakeBuffer, d0: number, size: number) {
          dst.data.set(src.data.subarray(so, so + size), d0);
        },
        beginComputePass() {
          let current = '';
          return {
            setPipeline(p: { name: string }) {
              current = p.name;
            },
            setBindGroup() {},
            dispatchWorkgroups(x: number, y = 1) {
              dispatches.push({ name: current, x, y });
            },
            end() {},
          };
        },
        finish: () => ({}),
      };
    },
  };
  return { device: device as unknown as GPUDevice, calls, dispatches, buffers };
}
