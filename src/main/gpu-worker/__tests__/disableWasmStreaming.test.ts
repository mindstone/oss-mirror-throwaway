import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Red→green coverage for the REBEL-68M/68Q workaround: the helper must remove
 * `WebAssembly.instantiateStreaming` / `compileStreaming` so onnxruntime-web's
 * loader (`typeof WebAssembly.instantiateStreaming === 'function'` guard) takes
 * its non-streaming ArrayBuffer fallback and never invokes the crashing
 * Electron-42 `StartStreamingCompilation` path.
 *
 * The helper carries module-level idempotency state, so each case re-imports a
 * fresh module via `vi.resetModules()`.
 */

const realWasm = globalThis.WebAssembly;

async function freshHelper() {
  vi.resetModules();
  const mod = await import('../disableWasmStreaming');
  return mod.disableWasmStreamingCompilation;
}

beforeEach(() => {
  // A WebAssembly stub whose streaming methods are present (the "red" state on
  // an unfixed Electron-42 runtime).
  (globalThis as unknown as { WebAssembly: unknown }).WebAssembly = {
    instantiateStreaming: () => Promise.resolve(),
    compileStreaming: () => Promise.resolve(),
    instantiate: () => Promise.resolve(),
    compile: () => Promise.resolve(),
  };
});

afterEach(() => {
  (globalThis as unknown as { WebAssembly: unknown }).WebAssembly = realWasm;
  vi.restoreAllMocks();
});

describe('disableWasmStreamingCompilation', () => {
  it('removes both streaming-compile entry points (red→green)', async () => {
    const disable = await freshHelper();

    // Red baseline: streaming compile is available.
    expect(typeof WebAssembly.instantiateStreaming).toBe('function');
    expect(typeof WebAssembly.compileStreaming).toBe('function');

    disable();

    // Green: the loader's `typeof … === 'function'` guard now fails → fallback.
    expect(typeof WebAssembly.instantiateStreaming).not.toBe('function');
    expect(typeof WebAssembly.compileStreaming).not.toBe('function');
  });

  it('leaves the non-streaming instantiate/compile paths intact', async () => {
    const disable = await freshHelper();
    disable();
    // The ArrayBuffer fallback the loader falls through to must still exist.
    expect(typeof WebAssembly.instantiate).toBe('function');
    expect(typeof WebAssembly.compile).toBe('function');
  });

  it('is idempotent (second call does not throw)', async () => {
    const disable = await freshHelper();
    disable();
    expect(() => disable()).not.toThrow();
    expect(typeof WebAssembly.instantiateStreaming).not.toBe('function');
  });

  it('no-ops without throwing when WebAssembly is undefined', async () => {
    (globalThis as unknown as { WebAssembly: unknown }).WebAssembly =
      undefined as unknown;
    const disable = await freshHelper();
    expect(() => disable()).not.toThrow();
  });

  it('does not throw (routes through ignoreBestEffortCleanup) when a streaming method is non-writable', async () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, 'instantiateStreaming', {
      value: () => Promise.resolve(),
      writable: false,
      configurable: false,
    });
    (globalThis as unknown as { WebAssembly: unknown }).WebAssembly = obj;
    const disable = await freshHelper();
    expect(() => disable()).not.toThrow();
  });
});

/**
 * Structural regression guard for the load-order invariant. The fix only works
 * if `disableWasmStreamingCompilation()` runs before onnxruntime-web compiles
 * WASM — which holds because (a) the disable is a top-level statement and
 * (b) `@huggingface/transformers` is loaded via a *dynamic* `import()` inside a
 * function. The dangerous regression is converting that to a STATIC import:
 * ESM hoists static imports above all module-body statements, so transformers
 * (and its WASM compile) would run before the disable call, reopening the crash.
 * These assertions read the source so a future edit that breaks the invariant
 * fails CI rather than silently shipping the crash.
 */
describe('gpu-worker renderer.ts load-order invariant', () => {
  const rendererSource = readFileSync(
    fileURLToPath(new URL('../renderer.ts', import.meta.url)),
    'utf8',
  );

  it('imports @huggingface/transformers only dynamically (never as a hoisted static import)', () => {
    // No `import ... from '@huggingface/transformers'` and no bare/side-effect static import.
    expect(rendererSource).not.toMatch(
      /import\s+[^;]*\bfrom\s*['"]@huggingface\/transformers['"]/,
    );
    expect(rendererSource).not.toMatch(
      /^\s*import\s+['"]@huggingface\/transformers['"]/m,
    );
    // It IS loaded dynamically.
    expect(rendererSource).toMatch(/import\(\s*['"]@huggingface\/transformers['"]\s*\)/);
  });

  it('calls disableWasmStreamingCompilation() before the transformers dynamic import', () => {
    const disableCallIdx = rendererSource.indexOf('disableWasmStreamingCompilation()');
    const dynamicImportIdx = rendererSource.search(
      /import\(\s*['"]@huggingface\/transformers['"]\s*\)/,
    );
    expect(disableCallIdx).toBeGreaterThan(-1);
    expect(dynamicImportIdx).toBeGreaterThan(-1);
    expect(disableCallIdx).toBeLessThan(dynamicImportIdx);
  });
});
