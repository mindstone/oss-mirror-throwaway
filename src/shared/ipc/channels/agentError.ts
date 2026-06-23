import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const AgentErrorResolutionActionSchema = z.enum([
  'switch-model',
  'switch-provider',
  'open-settings',
  'retry',
  // 260622 Stage 4 Chief-of-Staff recovery verbs. `recreate-chief-of-staff`
  // re-provisions the README from the starter template main-side then retries;
  // `proceed-without-chief-of-staff` is a renderer-side, logged template-bypass
  // retry (the main handler just acknowledges it). Kept in lockstep with the
  // `AgentErrorResolutionAction.action` union in
  // `packages/shared/src/utils/classifyErrorUx.ts`.
  'recreate-chief-of-staff',
  'proceed-without-chief-of-staff',
]);

export const agentErrorChannels = {
  'error:apply-resolution': defineInvokeChannel({
    channel: 'error:apply-resolution',
    request: z.object({
      turnId: z.string(),
      action: AgentErrorResolutionActionSchema,
      payload: z.object({
        model: z.string().optional(),
        provider: z.enum(['codex', 'anthropic', 'openrouter', 'openai']).optional(),
        settingsSection: z.string().optional(),
        // FOX-3494: the route role whose model the switch-model action should
        // repair. `planning` repairs the thinking slot (thinkingModel /
        // thinkingProfileId) so a planning-role failure doesn't immediately retry
        // back into the same Claude planning terminal; otherwise the working slot.
        failedRole: z.enum(['execution', 'planning', 'bts', 'subagent']).optional(),
      }).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      appliedAction: AgentErrorResolutionActionSchema,
      nextTurnId: z.string().optional(),
      reason: z.enum(['turn_alive', 'invalid_payload', 'stale_turn', 'in_flight']).optional(),
    }),
  }),
} as const;
