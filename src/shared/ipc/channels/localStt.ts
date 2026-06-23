import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/** Optional model identifier for multi-model support (defaults to 'parakeet-v3') */
const ModelIdRequestSchema = z.object({
  modelId: z.string().optional(),
}).optional();

/** Model status response schema */
const ModelStatusSchema = z.object({
  installed: z.boolean(),
  downloading: z.boolean(),
  downloadProgress: z.number().optional(), // 0-100
  sizeBytes: z.number().optional(),
  path: z.string().optional(),
  error: z.string().optional(),
  modelId: z.string().optional(),
});

export type LocalSttModelStatus = z.infer<typeof ModelStatusSchema>;

export const localSttChannels = {
  'local-stt:model-status': defineInvokeChannel({
    channel: 'local-stt:model-status',
    request: ModelIdRequestSchema,
    response: ModelStatusSchema,
    description: 'Get the current status of a local STT model (defaults to parakeet-v3)',
  }),

  'local-stt:model-download': defineInvokeChannel({
    channel: 'local-stt:model-download',
    request: ModelIdRequestSchema,
    response: z.object({
      started: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Start downloading a local STT model (runs in background)',
  }),

  'local-stt:model-cancel-download': defineInvokeChannel({
    channel: 'local-stt:model-cancel-download',
    request: ModelIdRequestSchema,
    response: z.void(),
    description: 'Cancel an in-progress model download',
  }),

  'local-stt:model-remove': defineInvokeChannel({
    channel: 'local-stt:model-remove',
    request: ModelIdRequestSchema,
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a downloaded local STT model',
  }),
} as const;
