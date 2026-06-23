/* Electron-main RUNNER for the gpu-worker WASM smoke gate (Pathologist rec #2,
 * REBEL-68M/68Q). Intentionally "dumb": it drives the BUILT gpu-worker through
 * init + one embed and prints exactly one JSON result line; ALL pass/fail
 * judgement lives in the pure, unit-tested classifier in
 * scripts/check-gpu-worker-wasm-smoke.ts. Run via that orchestrator, not directly.
 *
 * Why a standalone runner (not the app boot-smoke): the crash locus is the
 * worker's own onnxruntime WASM compile during `initPipeline` (renderer.ts),
 * which happens for BOTH the webgpu and cpu device branches. On headless CI
 * WebGPU is absent, so GpuEmbeddingBackend.initialize() short-circuits before
 * the compile — but the worker's `init` IPC compiles WASM regardless of device.
 * Driving the worker window directly exercises the exact crash point on the
 * target Electron, on CI, with zero production-code changes.
 *
 * Result JSON shape (single line, prefixed RESULT_SENTINEL):
 *   { kind, reachedReady, gpuAvailable, vectorLength, crashed, error,
 *     disableLogSeen, timedOut }
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const RESULT_SENTINEL = '__GPU_WORKER_SMOKE_RESULT__ ';
const CHANNEL = 'gpu-embedding';
const RESPONSE_CHANNEL = `${CHANNEL}:response`;

const WORKER_DIR = process.env.GPU_SMOKE_WORKER_DIR
  ? path.resolve(process.env.GPU_SMOKE_WORKER_DIR)
  : path.resolve(__dirname, '..', 'out', 'main', 'gpu-worker');
const PRELOAD = path.join(WORKER_DIR, 'preload.js');
const HTML = path.join(WORKER_DIR, 'index.html');
const CACHE_DIR = process.env.GPU_SMOKE_CACHE_DIR
  ? path.resolve(process.env.GPU_SMOKE_CACHE_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-worker-smoke-cache-'));
const TIMEOUT_MS = Number(process.env.GPU_SMOKE_RUNNER_TIMEOUT_MS) || 150_000;
// Optional init overrides so the orchestrator can drive the worker against a
// small, locally-vendored model (offline) instead of the default remote-fetched
// one. The crash path (onnxruntime-web WASM compile) is model-agnostic, so a
// tiny model still exercises it — this is what lets the gate run RED-on-crash
// in headless CI where the default model isn't fetchable. Unset → worker default.
const MODEL_NAME_OVERRIDE = process.env.GPU_SMOKE_MODEL_NAME || undefined;
const MODEL_DTYPE_OVERRIDE = process.env.GPU_SMOKE_MODEL_DTYPE || undefined;

// Isolated userData so this never collides with a running app / single-instance lock.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-worker-smoke-ud-')));

const result = {
  kind: 'gpu-worker-smoke-result',
  reachedReady: false,
  gpuAvailable: null,
  embeddingReceived: false, // an `embedding` response arrived (regardless of vector validity)
  vectorLength: null,
  crashed: null, // { reason, exitCode } when the renderer dies (THE crash class)
  error: null, // worker-reported error string (catchable; treated as setup by the classifier)
  disableLogSeen: false,
  timedOut: false,
};

let emitted = false;
function emit(code) {
  if (emitted) return;
  emitted = true;
  process.stdout.write('\n' + RESULT_SENTINEL + JSON.stringify(result) + '\n');
  try { app.exit(code); } catch { process.exit(code); }
}

function preconditionFail(reason) {
  result.error = reason;
  emit(2);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(PRELOAD) || !fs.existsSync(HTML)) {
    return preconditionFail(`built gpu-worker not found in ${WORKER_DIR} (run \`npm run build:worker\`)`);
  }

  const win = new BrowserWindow({
    show: false, width: 1, height: 1,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: false,
      webSecurity: false, backgroundThrottling: false, offscreen: true,
      preload: PRELOAD,
    },
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    if (typeof message === 'string' && message.includes('WASM streaming compilation disabled')) {
      result.disableLogSeen = true;
    }
  });

  // THE crash signal: a render-process-gone during WASM compile is the REBEL-68M/68Q class.
  win.webContents.on('render-process-gone', (_e, details) => {
    result.crashed = { reason: String(details?.reason ?? 'unknown'), exitCode: Number(details?.exitCode ?? -1) };
    emit(1);
  });

  ipcMain.on(RESPONSE_CHANNEL, (_e, resp) => {
    if (!resp || typeof resp !== 'object') return;
    if (resp.type === 'rendererReady') {
      win.webContents.send(CHANNEL, {
        id: 'init',
        type: 'init',
        cacheDir: CACHE_DIR,
        ...(MODEL_NAME_OVERRIDE ? { modelName: MODEL_NAME_OVERRIDE } : {}),
        ...(MODEL_DTYPE_OVERRIDE ? { dtype: MODEL_DTYPE_OVERRIDE } : {}),
      });
    } else if (resp.type === 'ready') {
      result.reachedReady = true;
      result.gpuAvailable = typeof resp.gpuAvailable === 'boolean' ? resp.gpuAvailable : null;
      win.webContents.send(CHANNEL, { id: 'embed', type: 'embed', text: 'gpu worker wasm smoke probe' });
    } else if (resp.type === 'embedding') {
      result.embeddingReceived = true;
      result.vectorLength = Array.isArray(resp.vector) ? resp.vector.length : null;
      emit(0);
    } else if (resp.type === 'error') {
      result.error = String(resp.error ?? 'unknown worker error');
      emit(0); // exit code here is irrelevant — the classifier decides from the JSON.
    }
  });

  try {
    await win.loadFile(HTML);
  } catch (err) {
    preconditionFail(`failed to load gpu-worker index.html: ${err instanceof Error ? err.message : String(err)}`);
  }
});

setTimeout(() => { result.timedOut = true; emit(0); }, TIMEOUT_MS);
