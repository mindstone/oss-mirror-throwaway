/**
 * Managed (Mindstone subscription) OpenRouter key sync route.
 *
 * POST /api/openrouter/managed-key
 *   Body: { apiKey: string | null }
 *   - apiKey string → persist via `saveManagedOpenRouterKey()` (core storage)
 *   - apiKey: null → `clearManagedOpenRouterKey()` (revocation / disconnect)
 *
 * Desktop relays the per-user managed OpenRouter key here whenever its managed
 * subscription state changes (provision, rotation, revocation), so the user's
 * cloud instance can serve `activeProvider: 'mindstone'` turns for mobile / web
 * sessions. Without this bridge the Mindstone managed subscription is
 * unserviceable on cloud — every managed turn collapses to a `missing-mindstone`
 * terminal route decision (no assistant response). This is the cloud half of
 * Layer 3 in docs/plans/260622_mobile-record-recreated-session/PLAN.md; the
 * desktop sender + clear-on-revoke is Stage L3b.
 *
 * Mirrors `routes/codexTokens.ts` exactly in shape, auth (bearer, applied by the
 * server.ts auth gate), and validation. NEVER logs the key (no bytes, no last4).
 * The relay is UNCONDITIONAL — there is no `managedCloudEnabled` gate (per the
 * 2026-06-23 user decision: relay the same desktop key to cloud for both
 * Mindstone-hosted and self-hosted instances).
 */

import http from 'node:http';
import { z } from 'zod';
import { readBody, sendJson, sendRouteError, RouteError } from '../httpUtils';
// The managed OpenRouter key storage lives only in src/main (no @core equivalent);
// the cloud build resolves @main → src/main and the proxy already reads the same
// store out-of-band (localModelProxyServer → loadManagedOpenRouterKey). src/core
// itself imports this same module (turnAdmission.ts, agentTurnExecute.ts). Lifting
// it to @core is the deferred architecture-smell cleanup (PLAN.md L3.5).
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted in scripts/check-cross-surface-imports.ts
import {
  saveManagedOpenRouterKey,
  clearManagedOpenRouterKey,
} from '@main/services/openRouterTokenStorage';

/**
 * Body schema: `{ apiKey: string | null }`. A non-empty string persists the key;
 * `null` clears it. (Mirrors codex's `{ tokens: … | null }` shape/validation.)
 */
const ManagedKeyBodySchema = z.object({
  apiKey: z.union([z.string().min(1), z.null()]),
});

export async function handleOpenRouterManagedKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
  }
  const body = await readBody(req);
  if (!body || typeof body !== 'object') {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object' }));
  }
  const parsed = ManagedKeyBodySchema.safeParse(body);
  if (!parsed.success) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'apiKey must be a non-empty string or null' }));
  }
  if (parsed.data.apiKey === null) {
    clearManagedOpenRouterKey();
    // Presence only — never log the key.
    return sendJson(res, 200, { ok: true, managedKeyPresent: false });
  }
  saveManagedOpenRouterKey(parsed.data.apiKey);
  return sendJson(res, 200, { ok: true, managedKeyPresent: true });
}
