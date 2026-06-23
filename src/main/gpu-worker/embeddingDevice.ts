/**
 * Device selection for the gpu-worker embedding pipeline.
 *
 * This worker runs in a Chromium renderer using transformers.js / onnxruntime-WEB,
 * whose only valid `device` values are `'webgpu'` and `'wasm'`. Passing `'cpu'`
 * (valid only in the Node worker / onnxruntime-node) makes transformers throw
 * `Unsupported device: "cpu"` at pipeline init — which silently disabled the
 * gpu-worker on every machine WITHOUT WebGPU until it was caught by the CI WASM
 * smoke on a headless Windows runner (REBEL-68M/68Q follow-up).
 *
 * The `WebEmbeddingDevice` union makes that regression a COMPILE error: you cannot
 * return `'cpu'` (or any non-web device) from here.
 */
export type WebEmbeddingDevice = 'webgpu' | 'wasm';

/**
 * Pick the onnxruntime-WEB execution device: WebGPU when available, else the WASM
 * execution provider (NOT 'cpu' — see module doc). Pure + typed so the device
 * contract is enforced by the type system and unit-tested.
 */
export function selectEmbeddingDevice(gpuAvailable: boolean): WebEmbeddingDevice {
  return gpuAvailable ? 'webgpu' : 'wasm';
}
