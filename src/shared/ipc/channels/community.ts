import { z } from 'zod';
import {
  defineInvokeChannel,
  CommunityHighlightsStateSchema,
  CommunityShareEligibilitySchema,
  CommunitySharePreviewSchema,
} from '../schemas';
import { AGENT_ERROR_KINDS } from '../../utils/agentErrorCatalog';

export const communityChannels = {
  'community:get-highlights': defineInvokeChannel({
    channel: 'community:get-highlights',
    request: z.void(),
    response: CommunityHighlightsStateSchema,
    description: 'Get cached community highlights from the Rebels forum',
  }),

  'community:refresh-highlights': defineInvokeChannel({
    channel: 'community:refresh-highlights',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Refresh community highlights from the Rebels forum',
  }),

  // ─────────────────────────────────────────────────────────────────────────
  // Community Share Channels
  // ─────────────────────────────────────────────────────────────────────────

  'community:get-share-eligibility': defineInvokeChannel({
    channel: 'community:get-share-eligibility',
    request: z.object({ sessionId: z.string() }),
    response: z.object({ eligibility: CommunityShareEligibilitySchema.nullable() }),
    description: 'Get community share eligibility for a session',
  }),

  'community:compose-share-post': defineInvokeChannel({
    channel: 'community:compose-share-post',
    request: z.object({ sessionId: z.string() }),
    response: z.object({
      preview: CommunitySharePreviewSchema.nullable(),
      error: z.string().optional(),
      errorKind: z.enum(AGENT_ERROR_KINDS).optional(),
    }),
    description: 'Compose anonymized community share post (triggers LLM)',
  }),

  'community:open-discourse-share': defineInvokeChannel({
    channel: 'community:open-discourse-share',
    request: z.object({ sessionId: z.string() }),
    response: z.object({ success: z.boolean(), error: z.string().optional() }),
    description: 'Copy post to clipboard and open Discourse in browser',
  }),

  'community:dismiss-share': defineInvokeChannel({
    channel: 'community:dismiss-share',
    request: z.object({ sessionId: z.string() }),
    response: z.void(),
    description: 'Dismiss community share for a session',
  }),

  'community:opt-out-sharing': defineInvokeChannel({
    channel: 'community:opt-out-sharing',
    request: z.void(),
    response: z.void(),
    description: 'Permanently opt out of community sharing prompts',
  }),
} as const;
