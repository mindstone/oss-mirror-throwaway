/**
 * Embedding Worker (utilityProcess)
 *
 * Runs the transformers.js embedding model in a separate OS process to isolate
 * native module crashes (onnxruntime) from the main Electron process.
 *
 * Communication protocol:
 * - init: Initialize the pipeline with cache directory
 * - embed: Generate embedding for single text
 * - embedBatch: Generate embeddings for multiple texts
 * - dispose: Clean up resources
 */

// MUST be the very first import — see docs/plans/260428_graceful_fs_emfile_fix.md
import '../startup/installGracefulFs';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { createRequire } from 'node:module';
import path from 'node:path';
/* eslint-disable no-console -- worker thread: no structured logger available */

type UtilityProcessParentPort = {
  postMessage: (message: unknown) => void;
  on: (event: 'message', listener: (event: { data: WorkerMessage }) => void) => void;
};

const _parentPort = (process as unknown as { parentPort?: UtilityProcessParentPort }).parentPort;
if (!_parentPort) {
  throw new Error('Embedding worker must be spawned via utilityProcess');
}
const parentPort: UtilityProcessParentPort = _parentPort;

let nativeRequire: NodeRequire | null = null;

// BGE model is optimized for retrieval tasks (query → document matching)
// Uses query prefix for better retrieval - see embeddingService.ts
export const MODEL_NAME = 'Xenova/bge-small-en-v1.5';

// Memory monitoring: log heap usage every N batches to help diagnose OOM issues (REBEL-KK)
const MEMORY_LOG_INTERVAL = 50;
let batchCount = 0;

type EmbeddingPipelineResult = {
  tolist: () => unknown;
  dispose?: () => void | Promise<void>;
};
type EmbeddingPipeline = {
  (input: string | string[], options: { pooling: 'mean'; normalize: true }): Promise<EmbeddingPipelineResult>;
  dispose?: () => void | Promise<void>;
};
let embeddingPipeline: EmbeddingPipeline | null = null;

interface WorkerMessage {
  type: 'init' | 'embed' | 'embedBatch' | 'dispose';
  id?: string;
  text?: string;
  texts?: string[];
  cacheDir?: string;
  unpackedNodeModules?: string;
  onnxIntraOpThreads?: number;
  priority?: boolean; // Priority requests (user-facing queries) process before normal requests (background indexing)
}

interface WorkerResponse {
  type: 'ready' | 'embedding' | 'embeddings' | 'error' | 'disposed';
  id?: string;
  vector?: number[];
  vectors?: number[][];
  error?: string;
}

function sendResponse(response: WorkerResponse): void {
  parentPort.postMessage(response);
}

function createNativeRequire(unpackedNodeModules?: string): NodeRequire {
  if (unpackedNodeModules) {
    const unpackedPath = path.join(unpackedNodeModules, '.package-lock.json');
    return createRequire(unpackedPath);
  }
  return createRequire(__filename);
}

async function initPipeline(
  cacheDir: string,
  unpackedNodeModules?: string,
  onnxIntraOpThreads?: number
): Promise<void> {
  const ompThreads = process.env.OMP_NUM_THREADS;
  console.log(
    `[embeddingWorker] init: platform=${process.platform}, OMP_NUM_THREADS=${ompThreads ?? 'unset'}, ` +
      `intraOpNumThreads=${onnxIntraOpThreads ?? 'default'}, cacheDir=${cacheDir}`
  );

  nativeRequire = createNativeRequire(unpackedNodeModules);

  const { pipeline, env } = nativeRequire('@huggingface/transformers') as typeof import('@huggingface/transformers');

  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  // Note: interOpNumThreads is intentionally NOT set — BGE-small is a dense encoder with a
  // sequential forward pass (no independent subgraph branches), so interOp parallelism is
  // effectively a no-op. Only intraOp parallelism affects performance here.
  // See plan § Stage 2 and reviewer-opus4.7-thinking Stage 2 review.
  const sessionOptions: Record<string, unknown> = {};
  if (typeof onnxIntraOpThreads === 'number' && onnxIntraOpThreads >= 1) {
    sessionOptions.intraOpNumThreads = onnxIntraOpThreads;
  }

  embeddingPipeline = (await pipeline('feature-extraction', MODEL_NAME, {
    dtype: 'fp32',
    device: 'cpu',
    session_options: sessionOptions
  })) as unknown as EmbeddingPipeline;

  // Log initial memory baseline after model load
  const mem = process.memoryUsage();
  console.log(
    `[embeddingWorker] model loaded: heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB, ` +
      `external=${Math.round(mem.external / 1024 / 1024)}MB, rss=${Math.round(mem.rss / 1024 / 1024)}MB`
  );
}

async function generateEmbedding(text: string): Promise<number[]> {
  if (!embeddingPipeline) {
    throw new Error('Pipeline not initialized');
  }
  const truncated = text.slice(0, 8000);
  const result = await embeddingPipeline(truncated, { pooling: 'mean', normalize: true });
  const output = (result.tolist() as number[][])[0] as number[];
  // Dispose tensor to release ONNX memory and prevent accumulation across batches (REBEL-KK)
  (result as { dispose?: () => void }).dispose?.();
  return output;
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (!embeddingPipeline) {
    throw new Error('Pipeline not initialized');
  }
  const truncated = texts.map((t) => t.slice(0, 8000));
  const result = await embeddingPipeline(truncated, { pooling: 'mean', normalize: true });
  const output = result.tolist() as number[][];
  // Dispose tensor to release ONNX memory and prevent accumulation across batches (REBEL-KK)
  (result as { dispose?: () => void }).dispose?.();

  // Memory monitoring: log heap usage periodically to diagnose OOM issues
  batchCount++;
  if (batchCount % MEMORY_LOG_INTERVAL === 0) {
    const mem = process.memoryUsage();
    // Include external (native/ONNX memory) and arrayBuffers for full picture
    console.log(
      `[embeddingWorker] batch ${batchCount}: heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB, ` +
        `external=${Math.round(mem.external / 1024 / 1024)}MB, rss=${Math.round(mem.rss / 1024 / 1024)}MB`
    );
  }

  return output;
}

async function handleMessage(msg: WorkerMessage): Promise<void> {
  try {
    switch (msg.type) {
      case 'init':
        if (!msg.cacheDir) throw new Error('init message missing cacheDir');
        await initPipeline(msg.cacheDir, msg.unpackedNodeModules, msg.onnxIntraOpThreads);
        sendResponse({ type: 'ready' });
        break;

      case 'embed': {
        if (!msg.text) throw new Error('embed message missing text');
        const vector = await generateEmbedding(msg.text);
        sendResponse({ type: 'embedding', id: msg.id, vector });
        break;
      }

      case 'embedBatch': {
        if (!msg.texts) throw new Error('embedBatch message missing texts');
        const vectors = await generateEmbeddings(msg.texts);
        sendResponse({ type: 'embeddings', id: msg.id, vectors });
        break;
      }

      case 'dispose':
        if (embeddingPipeline) {
          await embeddingPipeline.dispose?.();
          embeddingPipeline = null;
        }
        sendResponse({ type: 'disposed' });
        break;
    }
  } catch (error) {
    sendResponse({
      type: 'error',
      id: msg.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Priority queue system: user-facing queries (priority=true) process before background indexing.
// This prevents file indexing from blocking chat responsiveness.
const priorityQueue: WorkerMessage[] = [];
const normalQueue: WorkerMessage[] = [];
let isProcessing = false;

async function processQueues(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Process all messages until both queues are empty
    while (priorityQueue.length > 0 || normalQueue.length > 0) {
      // Priority queue always processes first
      const msg = priorityQueue.shift() ?? normalQueue.shift();
      if (msg) {
        try {
          await handleMessage(msg);
        } catch (err) {
          console.error('[embeddingWorker] Unexpected error in message handler:', err);
        }
      }
    }
  } finally {
    isProcessing = false;
  }
}

parentPort.on('message', (event: { data: WorkerMessage }) => {
  const msg = event.data;
  // init and dispose are always high priority (system operations)
  if (msg.type === 'init' || msg.type === 'dispose' || msg.priority) {
    priorityQueue.push(msg);
  } else {
    normalQueue.push(msg);
  }
  fireAndForget(processQueues(), 'embeddingWorker.processQueues');
});
