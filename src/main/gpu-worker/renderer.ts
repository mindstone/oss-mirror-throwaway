/**
 * GPU Embedding Worker Renderer Script
 *
 * Runs transformers.js with WebGPU in a Hidden BrowserWindow.
 * Handles embedding requests from main process via IPC.
 *
 * Key design decisions:
 * - Request queue serializes all operations to prevent dispose racing with embed
 * - Uses WebGPU when available, falls back to CPU (WASM) otherwise
 * - Model is cached locally for offline use
 */

// MUST be the first import + first statement: disables WebAssembly streaming
// compilation before `@huggingface/transformers` (onnxruntime-web) is dynamically
// imported, so the wasm loader takes its ArrayBuffer fallback and never hits the
// Electron 42 `StartStreamingCompilation` crash (REBEL-68M/68Q). See the helper.
import { disableWasmStreamingCompilation } from './disableWasmStreaming';
import { selectEmbeddingDevice } from './embeddingDevice';
import type { GpuEmbedRequest, GpuEmbedResponse } from '@shared/ipc/gpuEmbeddingContract';
import { fireAndForget } from '@shared/utils/fireAndForget';
/* eslint-disable no-console -- GPU worker: runs in isolated renderer, no structured logger */

disableWasmStreamingCompilation();

console.log('[GPU Worker] Renderer script loading...');

// Model configuration - must match CPU worker for embedding compatibility
const MODEL_NAME = 'Xenova/bge-small-en-v1.5';

type EmbeddingPipelineResult = {
  tolist: () => unknown;
  dispose?: () => void | Promise<void>;
};
type EmbeddingPipeline = (
  input: string | string[],
  options: { pooling: 'mean'; normalize: true }
) => Promise<EmbeddingPipelineResult>;

let embeddingPipeline: EmbeddingPipeline | null = null;
let gpuAvailable = false;
let isInitialized = false;

function sendResponse(response: GpuEmbedResponse): void {
  window.gpuEmbeddingApi.sendResponse(response);
}

async function probeWebGPU(): Promise<boolean> {
  try {
    console.log('[GPU Worker] Probing WebGPU...');
    if (!navigator.gpu) {
      console.log('[GPU Worker] navigator.gpu not available');
      return false;
    }
    console.log('[GPU Worker] navigator.gpu exists, requesting adapter...');
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      const adapterWithInfo = adapter as GPUAdapter & {
        requestAdapterInfo?: () => Promise<{ vendor?: string; device?: string; description?: string }>;
      };
      const info = await adapterWithInfo.requestAdapterInfo?.();

      const vendorRaw = info?.vendor ?? '';
      const deviceRaw = info?.device ?? '';
      const descriptionRaw = info?.description ?? '';

      const vendor = vendorRaw.toLowerCase();
      const device = deviceRaw.toLowerCase();
      const description = descriptionRaw.toLowerCase();

      const isMicrosoftVendor =
        vendor.includes('microsoft') || vendor === '0x1414' || vendor === '1414';
      const isWarp =
        description.includes('microsoft basic render driver') ||
        device.includes('microsoft basic render driver') ||
        description.includes('basic render driver') ||
        device.includes('basic render driver') ||
        description.includes('warp') ||
        device.includes('warp') ||
        (vendor === '0x1414' && device === '0x008c');

      // Detect WARP (Microsoft Basic Render Driver) and fall back to CPU/WASM.
      if (isMicrosoftVendor && isWarp) {
        console.log('[GPU Worker] Software renderer detected (WARP), skipping WebGPU:', info);
        return false;
      }

      console.log('[GPU Worker] WebGPU adapter found:', info?.device || 'unknown', info?.vendor || 'unknown');
      return true;
    }
    console.log('[GPU Worker] No WebGPU adapter available');
    return false;
  } catch (error) {
    console.error('[GPU Worker] WebGPU probe error:', error);
    return false;
  }
}

async function initPipeline(
  cacheDir: string,
  // Init-only overrides used by the WASM-smoke gate (REBEL-68M/68Q) to load a
  // small locally-vendored model offline in CI; production omits them and gets
  // the default model + fp32. The crash path (onnxruntime-web WASM compile) is
  // identical regardless of which model/dtype is loaded.
  modelNameOverride?: string,
  dtypeOverride?: string,
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- gpu-worker runs in a Chromium renderer/BrowserWindow context (not Node ESM main process); forge.config.cjs:545-554 unpacks gpu-worker/** + @huggingface/transformers from asar so the import resolves correctly here. The asar-resolution bug from 251216_lancedb_huggingface_native_module_asar_resolve_postmortem.md applies to Node ESM main-process / worker-thread contexts only.
  const { pipeline, env } = await import('@huggingface/transformers');

  // Configure transformers.js cache settings
  env.cacheDir = cacheDir;
  env.localModelPath = cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // Allow remote as fallback if local not found
  env.useBrowserCache = false; // Don't use browser cache, use our cache dir

  console.log(`[GPU Worker] Cache directory: ${cacheDir}`);

  // Check WebGPU availability
  gpuAvailable = await probeWebGPU();

  // WebGPU when available, else the WASM execution provider. Typed to 'webgpu'|'wasm'
  // so a regression to the invalid onnxruntime-WEB device 'cpu' can't compile — see
  // ./embeddingDevice.ts (REBEL-68M/68Q follow-up).
  const device = selectEmbeddingDevice(gpuAvailable);
  console.log(`[GPU Worker] Initializing embedding pipeline with device: ${device}`);

  // Configure ONNX Runtime execution providers for WebGPU
  const modelName = modelNameOverride ?? MODEL_NAME;
  const pipelineOptions: Record<string, unknown> = {
    dtype: dtypeOverride ?? 'fp32',
    device,
  };

  if (gpuAvailable) {
    // Explicitly set WebGPU as the preferred execution provider
    pipelineOptions.session_options = {
      executionProviders: ['webgpu'],
    };
  }

  if (modelNameOverride || dtypeOverride) {
    console.log(
      `[GPU Worker] Init override active: model=${modelName} dtype=${String(pipelineOptions.dtype)} (WASM-smoke gate)`,
    );
  }

  embeddingPipeline = (await pipeline('feature-extraction', modelName, pipelineOptions)) as unknown as EmbeddingPipeline;

  isInitialized = true;
  console.log('[GPU Worker] Pipeline initialized successfully');
}

async function generateEmbedding(text: string): Promise<number[]> {
  if (!embeddingPipeline) {
    throw new Error('Pipeline not initialized');
  }
  const truncated = text.slice(0, 8000);
  const result = await embeddingPipeline(truncated, { pooling: 'mean', normalize: true });
  const output = (result.tolist() as number[][])[0] as number[];
  // Dispose tensor to release WebGPU/WASM memory and prevent accumulation (REBEL-KK)
  await result.dispose?.();
  return output;
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (!embeddingPipeline) {
    throw new Error('Pipeline not initialized');
  }
  const truncated = texts.map((t) => t.slice(0, 8000));
  const result = await embeddingPipeline(truncated, { pooling: 'mean', normalize: true });
  const output = result.tolist() as number[][];
  // Dispose tensor to release WebGPU/WASM memory and prevent accumulation (REBEL-KK)
  await result.dispose?.();
  return output;
}

async function handleRequest(request: GpuEmbedRequest): Promise<void> {
  const { id, type } = request;

  try {
    switch (type) {
      case 'probe': {
        const available = await probeWebGPU();
        sendResponse({ id, type: 'probeResult', gpuAvailable: available });
        break;
      }

      case 'init': {
        if (!request.cacheDir) throw new Error('init request missing cacheDir');
        await initPipeline(request.cacheDir, request.modelName, request.dtype);
        sendResponse({ id, type: 'ready', gpuAvailable });
        break;
      }

      case 'embed': {
        if (!isInitialized) {
          throw new Error('Pipeline not initialized');
        }
        if (!request.text) throw new Error('embed request missing text');
        const vector = await generateEmbedding(request.text);
        sendResponse({ id, type: 'embedding', vector });
        break;
      }

      case 'embedBatch': {
        if (!isInitialized) {
          throw new Error('Pipeline not initialized');
        }
        if (!request.texts) throw new Error('embedBatch request missing texts');
        const vectors = await generateEmbeddings(request.texts);
        sendResponse({ id, type: 'embeddings', vectors });
        break;
      }

      case 'dispose': {
        if (embeddingPipeline) {
          await (embeddingPipeline as unknown as { dispose?: () => Promise<void> }).dispose?.();
          embeddingPipeline = null;
          isInitialized = false;
        }
        sendResponse({ id, type: 'disposed' });
        break;
      }
    }
  } catch (error) {
    sendResponse({
      id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Global error handlers
window.onerror = (message, source, lineno, colno, error) => {
  console.error('[GPU Worker] Global error:', message, source, lineno, colno, error);
};
window.onunhandledrejection = (event) => {
  console.error('[GPU Worker] Unhandled rejection:', event.reason);
};

// Dual-queue system for priority handling - matches CPU backend pattern
const priorityQueue: GpuEmbedRequest[] = [];
const normalQueue: GpuEmbedRequest[] = [];
let isProcessing = false;
let disposeRequested = false;

/**
 * Process requests from both queues, prioritizing the priority queue.
 * Ensures serialization of all operations.
 */
async function processQueues(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (priorityQueue.length > 0 || normalQueue.length > 0) {
      // Priority queue always processes first
      const request = priorityQueue.shift() ?? normalQueue.shift();
      if (!request) continue;

      // Reject non-dispose work during shutdown (shouldn't happen since we reject at enqueue,
      // but belt-and-suspenders for requests that were already queued before dispose)
      if (disposeRequested && request.type !== 'dispose') {
        console.log('[GPU Worker] Rejecting queued request during shutdown:', request.type);
        sendResponse({ id: request.id, type: 'error', error: 'GPU worker is shutting down' });
        continue;
      }

      try {
        await handleRequest(request);
      } catch (err) {
        console.error('[GPU Worker] Request processing error:', err);
      }
    }
  } finally {
    isProcessing = false;
  }
}

window.gpuEmbeddingApi.onRequest((request) => {
  // If shutdown has begun, reject any NEW work immediately (except dispose itself)
  if (disposeRequested && request.type !== 'dispose') {
    console.log('[GPU Worker] Rejecting request during shutdown:', request.type);
    sendResponse({ id: request.id, type: 'error', error: 'GPU worker is shutting down' });
    return;
  }

  // Set dispose flag IMMEDIATELY on enqueue (not on processing)
  // This ensures new requests after dispose is enqueued are rejected immediately,
  // while already-queued requests complete normally
  if (request.type === 'dispose') {
    disposeRequested = true;
    console.log('[GPU Worker] Dispose enqueued, rejecting new requests...');
  }

  // Route to appropriate queue
  // - init and dispose are always priority (system operations)
  // - probe is NOT priority (diagnostic, happens during init)
  // - embed/embedBatch with priority=true go to priority queue (user-facing)
  // - everything else goes to normal queue (background indexing)
  if (request.type === 'init' || request.type === 'dispose' || request.priority) {
    priorityQueue.push(request);
  } else {
    normalQueue.push(request);
  }

  fireAndForget(processQueues(), 'gpuWorker.renderer.processQueues');
});

// Signal that renderer is ready
console.log('[GPU Worker] Renderer loaded, signaling ready...');
sendResponse({ id: 'renderer-ready', type: 'rendererReady' });
