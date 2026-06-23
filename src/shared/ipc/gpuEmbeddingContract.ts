/**
 * GPU Embedding IPC Contract
 *
 * Zod schemas for type-safe IPC between main process and GPU embedding worker.
 * The GPU worker runs in a Hidden BrowserWindow to access WebGPU.
 */

import { z } from 'zod';

export const GpuEmbedRequestSchema = z.object({
  id: z.string(),
  type: z.enum(['init', 'probe', 'embed', 'embedBatch', 'dispose']),
  text: z.string().optional(),
  texts: z.array(z.string()).optional(),
  cacheDir: z.string().optional(),
  // Optional init-only overrides. Production callers omit them (the worker uses
  // its default model + fp32). The WASM-smoke gate sets them so CI can load a
  // small, locally-vendored model offline and still exercise the exact
  // onnxruntime-web WASM-compile crash path (REBEL-68M/68Q). See
  // scripts/gpu-worker-wasm-smoke-runner.cjs + private/test-fixtures/gpu-worker-model.
  modelName: z.string().optional(),
  dtype: z.string().optional(),
  // Internal GPU worker queue flag. Public callers use CallerIntent.
  priority: z.boolean().optional(),
});

export type GpuEmbedRequest = z.infer<typeof GpuEmbedRequestSchema>;

export const GpuEmbedResponseSchema = z.object({
  id: z.string(),
  type: z.enum(['ready', 'probeResult', 'embedding', 'embeddings', 'error', 'disposed', 'rendererReady']),
  vector: z.array(z.number()).optional(),
  vectors: z.array(z.array(z.number())).optional(),
  gpuAvailable: z.boolean().optional(),
  error: z.string().optional(),
});

export type GpuEmbedResponse = z.infer<typeof GpuEmbedResponseSchema>;

export const GPU_EMBEDDING_CHANNEL = 'gpu-embedding';
