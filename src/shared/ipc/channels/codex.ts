import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

/**
 * Shape of the Codex OAuth tokens payload carried across the wire.
 * Matches `CodexTokens` in `@core/services/codexTokenStorage`.
 */
export const CodexTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  accountId: z.string().min(1),
  accountEmail: z.string().optional(),
});

export type CodexTokensPayload = z.infer<typeof CodexTokensSchema>;

export const codexChannels = {
  'codex:login': defineInvokeChannel({
    channel: 'codex:login',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      email: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Start Codex OAuth flow to connect ChatGPT account',
  }),

  'codex:logout': defineInvokeChannel({
    channel: 'codex:logout',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Disconnect ChatGPT account and clear Codex OAuth tokens',
  }),

  'codex:status': defineInvokeChannel({
    channel: 'codex:status',
    request: z.void(),
    response: z.object({
      connected: z.boolean(),
      accountEmail: z.string().optional(),
    }),
    description: 'Get Codex OAuth connection status',
  }),

  /**
   * Desktop → cloud/mobile sync channel for Codex OAuth tokens.
   *
   * Desktop is the only surface that can run the interactive OAuth LOGIN
   * flow (browser + loopback server). Once desktop has tokens it pushes
   * them here to the user's cloud instance so cloud and mobile can also
   * use ChatGPT Pro. Sending `tokens: null` clears cloud tokens (logout).
   *
   * Security: tokens on cloud are stored in the per-user data volume via
   * `@core/storeFactory`. No safeStorage encryption (Electron-only); treat
   * this identically to other user credentials already synced via settings.
   */
  'codex:sync-tokens': defineInvokeChannel({
    channel: 'codex:sync-tokens',
    request: z.object({
      tokens: CodexTokensSchema.nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
    }),
    description: 'Push Codex OAuth tokens from desktop to cloud/mobile (or null to clear).',
  }),
};
