/**
 * Analytics anonymousId — reconciled with the existing install id.
 *
 * The RudderStack anonymousId MUST be the SAME persisted install id that
 * cloud-client already uses for device scoping (`rebel_client_id`, written via
 * `secureTokenStorage` / `expo-secure-store`). We deliberately do NOT mint a
 * fresh UUID independently: a second id would fragment a single device's
 * identity across the analytics product (anonymous events under one id,
 * server-scoped device activity under another) and break any future join
 * between mobile behaviour and the cloud instance that actually executes work.
 *
 * SINGLE SOURCE OF TRUTH (F3): rather than duplicating cloud-client's
 * read→generate→write, this delegates to cloud-client's exported
 * `getOrCreateClientId()` — the exact same helper the auth store uses. Both
 * subsystems therefore run the identical id-resolution logic against the same
 * `rebel_client_id` secure-store key, and that helper is first-writer-wins
 * (it re-reads after writing and adopts whatever landed), so a concurrent
 * first launch cannot leave analytics and cloud-client on diverging ids.
 */

import type { TokenStorage } from '@rebel/cloud-client';
import { getOrCreateClientId } from '@rebel/cloud-client';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { secureTokenStorage } from '../storage/secureTokenStorage';

/**
 * Resolve the analytics anonymousId, reconciled with `rebel_client_id`.
 *
 * Delegates entirely to cloud-client's `getOrCreateClientId()` (the SSOT id
 * helper) against the app's `secureTokenStorage` adapter — the same adapter
 * and key cloud-client uses. Best-effort: any storage failure inside the helper
 * degrades to an in-memory id rather than throwing. If the helper returns
 * `undefined` (storage adapter cannot read ids at all), we still degrade to a
 * generated in-memory id so analytics never blocks on identity resolution.
 */
export async function resolveAnonymousId(
  storage: TokenStorage = secureTokenStorage,
): Promise<string> {
  try {
    const id = await getOrCreateClientId(storage);
    if (typeof id === 'string' && id.trim().length > 0) {
      return id.trim();
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'analytics.mobile.anonymousId.resolve',
      reason: 'id resolution is best-effort; analytics identity must never block boot',
      severity: 'debug',
    });
  }

  // Storage adapter could not provide an id (no getClientId, or helper failed).
  // Degrade to an in-memory id so analytics reconciliation is best-effort.
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (typeof randomUuid === 'string' && randomUuid.length > 0) {
    return randomUuid;
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
