/**
 * Seam/routing parity test (Layer 3 / DI-05): once the cloud availability seam
 * reads the live store (`() => hasManagedOpenRouterKey()`, the SAME registrant
 * desktop wires in behindTheScenesClient.ts:29) AND the relayed managed key is
 * present in the cloud store, a `mindstone` route resolves to the dispatchable
 * `mindstone-managed-key` credential source — NOT the `missing-mindstone`
 * terminal arm that previously made every mobile/cloud managed turn produce no
 * assistant response.
 *
 * This is the cloud counterpart of the `() => false` regression captured in
 * providerFailover.cloud.test.ts — but here we wire the REAL post-Layer-3 seam.
 */

import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerManagedKeyAvailability,
  __resetManagedKeyAvailabilityForTesting,
} from '@core/rebelCore/managedKeyAvailability';
import { selectProviderMode } from '@core/rebelCore/providerRouting';
import type { ProviderRouteSettings } from '@core/rebelCore/providerRouting';
import { handleOpenRouterManagedKey } from '../routes/openRouterManagedKey';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted in scripts/check-cross-surface-imports.ts
import {
  saveManagedOpenRouterKey,
  clearManagedOpenRouterKey,
  hasManagedOpenRouterKey,
} from '@main/services/openRouterTokenStorage';

function makeMindstoneSettings(): ProviderRouteSettings {
  return {
    coreDirectory: '/tmp/test',
    models: { apiKey: '', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
    openRouter: { enabled: true, oauthToken: null, selectedModel: '' },
    localModel: { profiles: [], activeProfileId: null },
    activeProvider: 'mindstone',
  } as unknown as ProviderRouteSettings;
}

describe('Cloud managed-key routing parity (Layer 3 — real () => hasManagedOpenRouterKey seam)', () => {
  beforeEach(() => {
    __resetManagedKeyAvailabilityForTesting();
    clearManagedOpenRouterKey();
    // The REAL cloud wiring after Layer 3 (bootstrap.ts) — live store read.
    registerManagedKeyAvailability(() => hasManagedOpenRouterKey());
  });

  afterEach(() => {
    __resetManagedKeyAvailabilityForTesting();
    clearManagedOpenRouterKey();
  });

  it('resolves missing-mindstone when no managed key has been relayed (pre-relay state)', () => {
    expect(hasManagedOpenRouterKey()).toBe(false);
    const mode = selectProviderMode(makeMindstoneSettings());
    expect(mode.provider).toBe('openrouter');
    expect(mode.credentialSource).toBe('missing-mindstone');
  });

  it('resolves dispatchable mindstone-managed-key once the relayed key is in the cloud store', () => {
    saveManagedOpenRouterKey('sk-or-managed-relayed');
    expect(hasManagedOpenRouterKey()).toBe(true);

    const mode = selectProviderMode(makeMindstoneSettings());
    expect(mode.provider).toBe('openrouter');
    expect(mode.credentialSource).toBe('mindstone-managed-key');
  });

  it('flips back to missing-mindstone after the key is cleared (revocation)', () => {
    saveManagedOpenRouterKey('sk-or-managed-relayed');
    expect(selectProviderMode(makeMindstoneSettings()).credentialSource).toBe('mindstone-managed-key');

    clearManagedOpenRouterKey();
    expect(selectProviderMode(makeMindstoneSettings()).credentialSource).toBe('missing-mindstone');
  });

  // --- F3: combined relay-body → route → store → routing contract -----------
  //
  // The seam tests above pre-WRITE the store directly. This single test feeds
  // the route the EXACT body shape the desktop relay sends
  // (`pushManagedOpenRouterKey` posts `{ apiKey }`) and then asserts routing
  // resolves dispatchable. It joins relay-body ↔ route-schema ↔ routing so a
  // field rename on EITHER side (relay body field or route Zod schema) fails a
  // test rather than silently re-breaking the managed-subscription path. No
  // live model call. Also satisfies Pathologist prevention rec #2.
  it('POST of the exact relay body shape → store → mindstone resolves dispatchable', async () => {
    // The literal body `cloudRouter.pushManagedOpenRouterKey` sends over HTTP.
    const RELAY_BODY = { apiKey: 'sk-or-managed-relay-body' };

    const req = new http.IncomingMessage(null as never);
    req.method = 'POST';
    req.push(JSON.stringify(RELAY_BODY));
    req.push(null);

    let status = 0;
    const res = {
      writeHead(s: number) { status = s; return this; },
      end() { return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
    } as unknown as http.ServerResponse;

    expect(hasManagedOpenRouterKey()).toBe(false);
    await handleOpenRouterManagedKey(req, res);
    expect(status).toBe(200);
    expect(hasManagedOpenRouterKey()).toBe(true);

    // The relayed key now drives routing through the live seam.
    const mode = selectProviderMode(makeMindstoneSettings());
    expect(mode.provider).toBe('openrouter');
    expect(mode.credentialSource).toBe('mindstone-managed-key');
  });
});
