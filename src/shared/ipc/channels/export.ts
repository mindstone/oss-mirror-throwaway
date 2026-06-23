import { z } from 'zod';
import { defineInvokeChannel, ElectronFileFilterSchema } from '../schemas';

export const exportChannels = {
  'export:to-pdf': defineInvokeChannel({
    channel: 'export:to-pdf',
    request: z.object({
      html: z.string(),
      fileName: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      filePath: z.string().nullable().optional(),
      error: z.string().optional(),
      cancelled: z.boolean().optional(),
    }),
    description: 'Export pre-rendered HTML content to PDF',
  }),

  'export:save-file': defineInvokeChannel({
    channel: 'export:save-file',
    request: z.object({
      data: z.instanceof(ArrayBuffer),
      fileName: z.string(),
      filters: z.array(ElectronFileFilterSchema),
      title: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      filePath: z.string().nullable().optional(),
      error: z.string().optional(),
      cancelled: z.boolean().optional(),
    }),
    description: 'Save file data with a native save dialog',
  }),
} as const;
