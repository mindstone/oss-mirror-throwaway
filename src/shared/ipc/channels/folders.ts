import { z } from 'zod';
import { defineInvokeChannel, defineSyncChannel } from '../schemas';
import { FolderStoreDataSchema } from '../schemas/folders';

export const foldersChannels = {
  'folders:load': defineInvokeChannel({
    channel: 'folders:load',
    request: z.void(),
    response: FolderStoreDataSchema,
    description: 'Load folder state (definitions + session membership)',
  }),

  'folders:save': defineInvokeChannel({
    channel: 'folders:save',
    request: FolderStoreDataSchema,
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Save folder state atomically',
  }),

  'folders:save-sync': defineSyncChannel({
    channel: 'folders:save-sync',
    request: FolderStoreDataSchema,
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Synchronous folder save for app quit flush',
  }),
} as const;
