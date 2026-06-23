import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

/**
 * Identity domain — OSS lead-capture egress.
 *
 * DESKTOP-ONLY by design: this channel must NEVER be cloud-routable. It is
 * deliberately absent from `CLOUD_CHANNEL_POLICIES` (and therefore from
 * CLOUD_ROUTABLE_CHANNELS / DUAL_WRITE_CHANNELS / CLOUD_IPC_ALLOWLIST). The
 * lead-capture POST is the only Mindstone egress in the analytics-dark OSS
 * build; routing it through the cloud surface would leak that egress
 * cross-surface. See docs/plans/260623_oss-identity-ask-lead-capture/PLAN.md.
 *
 * The renderer payload carries ONLY user-typed identity. `appVersion`/`platform`
 * are sourced in the main handler via getPlatformConfig() — never trusted from
 * the renderer.
 */
export const identityChannels = {
  'identity:capture-oss-lead': defineInvokeChannel({
    channel: 'identity:capture-oss-lead',
    request: z.object({
      firstName: z.string().optional(),
      email: z.string(),
    }),
    response: z.void(),
    description:
      'Fire-and-forget best-effort POST of optional OSS onboarding identity (name + email) to Mindstone lead capture',
  }),
} as const;

export type IdentityChannelName = keyof typeof identityChannels;
