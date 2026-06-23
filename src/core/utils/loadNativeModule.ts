import { createRequire } from 'node:module';
import path from 'node:path';
import { isPackaged } from '@core/utils/dataPaths';

let cachedNativeRequire: NodeRequire | undefined;

/**
 * Returns a require() function that resolves native-binding npm packages
 * (e.g. `@lancedb/lancedb`, `@huggingface/transformers`, `sherpa-onnx-node`,
 * `onnxruntime-node`) correctly across dev and packaged-Electron builds.
 *
 * In packaged builds, native modules live in `app.asar.unpacked/node_modules`
 * (configured via `forge.config.cjs` `asar.unpack`). ESM `await import(...)`
 * walks node_modules from the importing file's path *inside* `app.asar`, so
 * it never sees the unpacked binaries and fails with "Cannot find package".
 * The fix is `createRequire(unpackedPath)` where `unpackedPath` points at
 * `app.asar.unpacked/node_modules/.package-lock.json` — Node's CJS resolver
 * then walks from that location and finds the binaries.
 *
 * In dev (`npm run dev`), the importing file isn't inside asar; the standard
 * `createRequire(import.meta.url)` works. `import.meta.url` here resolves
 * relative to this helper, but Node walks upward from there to the project
 * root `node_modules/` — same end state as calling from the consumer file.
 *
 * Caches the require function so repeated calls are cheap.
 *
 * Worker threads must NOT use this helper. `worker_threads` cannot share the
 * main process's `app.isPackaged` state (separate V8 isolates, no Electron
 * `app` module). Worker code receives `unpackedNodeModules` via `workerData`
 * and constructs its own `createRequire(<unpackedNodeModules>/.package-lock.json)`
 * — see `src/main/workers/embeddingWorker.ts:75-93` for the canonical worker
 * variant.
 *
 * The companion lint rule `nativeBindingImportGuardSelectors` in
 * `eslint.config.mjs` blocks the dangerous `await import('@lancedb/lancedb')`
 * pattern that would silently break in packaged builds — see the originating
 * postmortem:
 * `docs-private/postmortems/251216_lancedb_huggingface_native_module_asar_resolve_postmortem.md`.
 *
 * @example
 *   const lancedb = loadNativeModule<typeof import('@lancedb/lancedb')>('@lancedb/lancedb');
 *   const table = await lancedb.connect(dbPath).then((db) => db.openTable('files'));
 */
export function loadNativeModule<T>(spec: string): T {
  if (!cachedNativeRequire) {
    cachedNativeRequire = createNativeRequire();
  }
  return cachedNativeRequire(spec) as T;
}

function createNativeRequire(): NodeRequire {
  if (isPackaged()) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- process.resourcesPath is guaranteed set in packaged Electron apps
    const unpackedPath = path.join(process.resourcesPath!, 'app.asar.unpacked', 'node_modules', '.package-lock.json');
    return createRequire(unpackedPath);
  }
  return createRequire(import.meta.url);
}
