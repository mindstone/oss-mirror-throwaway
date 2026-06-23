/**
 * IPC Channel Definitions for Local Inference (Bundled Ollama)
 *
 * Follows the localStt.ts pattern: defineInvokeChannel with Zod schemas.
 * Progress events are broadcast (not invoke) via `local-inference:download-progress`.
 *
 * Security: pull-model validates ollamaTag against the curated LOCAL_MODEL_CATALOG.
 */

import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const OllamaRuntimeStatusSchema = z.enum([
  'not_installed',
  'downloading',
  'installed',
  'running',
  'error',
]);

const OllamaCapabilitiesSchema = z.object({
  version: z.string(),
  turboQuantSupported: z.boolean(),
  kvCacheTypes: z.array(z.string()),
});

const InstalledModelSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
});

/** Full status response for the local inference subsystem. */
const LocalInferenceStatusSchema = z.object({
  runtimeStatus: OllamaRuntimeStatusSchema,
  runtimeVersion: z.string().optional(),
  capabilities: OllamaCapabilitiesSchema.optional(),
  installedModels: z.array(InstalledModelSchema),
  systemRAMGB: z.number(),
  arch: z.string(),
  error: z.string().optional(),
});

export type LocalInferenceStatusIpc = z.infer<typeof LocalInferenceStatusSchema>;

// ---------------------------------------------------------------------------
// Channel definitions
// ---------------------------------------------------------------------------

export const localInferenceChannels = {
  'local-inference:get-status': defineInvokeChannel({
    channel: 'local-inference:get-status',
    request: z.void(),
    response: LocalInferenceStatusSchema,
    description: 'Get full local inference status: runtime, models, system info',
  }),

  'local-inference:activate': defineInvokeChannel({
    channel: 'local-inference:activate',
    request: z.void(),
    response: z.object({
      started: z.boolean(),
      alreadyInstalled: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Download Ollama runtime on-demand (Phase 1 activation)',
  }),

  'local-inference:deactivate': defineInvokeChannel({
    channel: 'local-inference:deactivate',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove Ollama runtime, all local profiles, and downloaded models',
  }),

  'local-inference:pull-model': defineInvokeChannel({
    channel: 'local-inference:pull-model',
    request: z.object({ ollamaTag: z.string() }),
    response: z.object({
      started: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Start downloading a model from the curated catalog (progress via broadcast)',
  }),

  'local-inference:cancel-pull': defineInvokeChannel({
    channel: 'local-inference:cancel-pull',
    request: z.void(),
    response: z.void(),
    description: 'Cancel in-progress model download',
  }),

  'local-inference:delete-model': defineInvokeChannel({
    channel: 'local-inference:delete-model',
    request: z.object({ modelName: z.string() }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a downloaded model and its corresponding profile',
  }),
} as const;
