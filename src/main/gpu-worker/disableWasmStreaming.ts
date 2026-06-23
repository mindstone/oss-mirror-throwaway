/**
 * Disable WebAssembly streaming compilation in the gpu-worker main world.
 *
 * WHY (REBEL-68M / REBEL-68Q): on Electron 42.4.0 / Node 24 (shipped in app
 * 0.4.47 via the Electron 39→42 upgrade, FOX-3487) the embedding worker crashes
 * during WebAssembly *streaming* compilation — native stack
 * `node::wasm_web_api::WasmStreamingObject::Initialize` → `StartStreamingCompilation`,
 * `exitCode:11` (mac EXC_BAD_ACCESS) / EXCEPTION_ACCESS_VIOLATION (Windows). The
 * crash is in the runtime's streaming-compile path, not in our code.
 *
 * onnxruntime-web (loaded by `@huggingface/transformers`) only ever takes the
 * streaming path when `typeof WebAssembly.instantiateStreaming === 'function'`,
 * and otherwise falls back to `fetch → arrayBuffer → WebAssembly.instantiate`
 * (verified in node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded[.jsep].mjs;
 * both the WebGPU/jsep and CPU/non-jsep glue share the identical guard). Removing
 * `instantiateStreaming` therefore routes the loader to the ArrayBuffer path by
 * construction, sidestepping the crash while keeping embeddings working. The
 * only cost is that the (small) wasm binary is fully fetched before compiling
 * instead of compiling as it streams — negligible next to the model download.
 *
 * `compileStreaming` is nulled too as belt-and-suspenders (it shares the same
 * native impl); onnxruntime-web does not call it today.
 *
 * MUST run in the worker **main world** (where `renderer.js` and transformers
 * execute) — not the preload (separate isolated world under contextIsolation)
 * and not an inline `<script>` (blocked by the index.html CSP). It is therefore
 * invoked as the first statement of `renderer.ts`'s module body, before the
 * dynamic `import('@huggingface/transformers')`.
 *
 * Always-on (not Electron-version-gated): the ArrayBuffer path is onnxruntime's
 * own documented fallback and is behaviourally equivalent on older runtimes, so
 * gating would only add a brittle version branch.
 */

import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

let alreadyDisabled = false;

/**
 * Remove `WebAssembly.instantiateStreaming` / `WebAssembly.compileStreaming` so
 * downstream wasm loaders fall back to non-streaming ArrayBuffer instantiation.
 *
 * Idempotent and defensive: no-ops if `WebAssembly` is absent, swallows the
 * (theoretical) non-writable-property case so a hardening tweak can never throw
 * during worker bootstrap.
 */
export function disableWasmStreamingCompilation(): void {
  if (alreadyDisabled) return;

  if (typeof WebAssembly === 'undefined') {
    alreadyDisabled = true;
    return;
  }

  const wasm = WebAssembly as unknown as Record<string, unknown>;
  let removed = false;

  for (const method of ['instantiateStreaming', 'compileStreaming'] as const) {
    if (typeof wasm[method] !== 'function') continue;
    try {
      wasm[method] = undefined;
      removed = true;
    } catch (error) {
      // Property is non-configurable/non-writable on this runtime — extremely
      // unlikely for these standard writable V8 globals, but never let bootstrap
      // hardening throw. Surfaced (not silently swallowed) for observability.
      ignoreBestEffortCleanup(error, {
        operation: 'gpuWorker.disableWasmStreaming',
        reason: 'WebAssembly streaming method not writable; left as-is',
        severity: 'warn',
      });
    }
  }

  alreadyDisabled = true;

  if (removed) {
    console.warn(
      '[GPU Worker] WASM streaming compilation disabled (REBEL-68M/68Q: Electron 42 StartStreamingCompilation crash workaround)',
    );
  }
}
