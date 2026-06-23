import { describe, expect, it } from 'vitest';
import { selectEmbeddingDevice } from '../embeddingDevice';

/**
 * Guards the REBEL-68M/68Q follow-up: the gpu-worker (onnxruntime-WEB) must never
 * use the invalid device 'cpu' — only 'webgpu' (when available) or 'wasm'. The
 * `WebEmbeddingDevice` union already makes 'cpu' a compile error; these tests pin
 * the runtime behaviour of both branches so the no-WebGPU path (the one that
 * regressed) stays 'wasm'.
 */
describe('selectEmbeddingDevice', () => {
  it("uses 'webgpu' when WebGPU is available", () => {
    expect(selectEmbeddingDevice(true)).toBe('webgpu');
  });

  it("falls back to 'wasm' (NOT 'cpu') when WebGPU is unavailable", () => {
    const device = selectEmbeddingDevice(false);
    expect(device).toBe('wasm');
    // The exact regression that silently disabled the gpu-worker on no-WebGPU machines.
    expect(device).not.toBe('cpu');
  });

  it('only ever returns a valid onnxruntime-WEB device', () => {
    for (const gpuAvailable of [true, false]) {
      expect(['webgpu', 'wasm']).toContain(selectEmbeddingDevice(gpuAvailable));
    }
  });
});
