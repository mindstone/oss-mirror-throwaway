import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

export const FileConversationLinkSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  timestamp: z.number(),
  source: z.enum(['write', 'open']),
});

export type FileConversationLink = z.infer<typeof FileConversationLinkSchema>;

export const fileConversationChannels = {
  'file-conversation:track': defineInvokeChannel({
    channel: 'file-conversation:track',
    request: z.object({
      filePath: z.string(),
      sessionId: z.string(),
      sessionTitle: z.string(),
      source: z.enum(['write', 'open']),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Track a file-conversation association',
  }),

  'file-conversation:get-for-file': defineInvokeChannel({
    channel: 'file-conversation:get-for-file',
    request: z.object({
      filePath: z.string(),
    }),
    response: z.object({
      links: z.array(FileConversationLinkSchema),
      mostRecent: FileConversationLinkSchema.nullable(),
    }),
    description: 'Get conversation links for a specific file',
  }),
};
