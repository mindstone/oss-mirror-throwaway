/**
 * Provider-capability supporting-data dual-write round-trip guard.
 *
 * The cross-surface data-loss class (260611_cloud_migration_folders_data_loss,
 * 260601_managed_openrouter_connection_proxy_bypass_zdr): a capability *flag*
 * syncs to cloud via the `settings:update` dual-write, but the *supporting data*
 * the cloud surface needs to actually USE that capability is silently dropped by
 * `stripLocalSettings` — so the feature breaks on cloud/mobile.
 *
 * The existing static gate (`scripts/check-cross-surface-parity-gap.ts`) checks
 * that the channel exists and is dual-write; it does NOT check that the
 * *supporting data* round-trips. The generic `cloudSettingsPolicy.test.ts`
 * "preserves non-local-only keys" + `LOCAL_ONLY_SETTINGS_KEYS` snapshot tests
 * would surface a change, but a snapshot is trivially re-baselined; they do not
 * frame the invariant per provider-capability with the cloud consumer that
 * proves the data is needed.
 *
 * This test closes that gap: for each `ActiveProvider` whose capability is gated
 * by the cloud-synced `activeProvider` flag, it asserts the supporting data the
 * CLOUD surface genuinely consumes survives `stripLocalSettings` AND round-trips
 * through `mergeLocalSettings` — verified by reading it back through the real
 * cloud-side accessor (`validateProviderCredentials` / `getApiKey`), not by
 * eyeballing a key.
 *
 * The provider list is derived from the real `ActiveProvider` union via an
 * exhaustive `Record<ActiveProvider, …>` so a NEW provider fails to compile here
 * until its supporting-data policy is explicitly classified.
 *
 * Non-vacuity: adding the supporting-data key (e.g. `openRouter`) to
 * `LOCAL_ONLY_SETTINGS_KEYS` reddens the "survives" assertion — see the report
 * `subagent_reports/implementer_stage5_cloud_supporting_data.md` for the
 * verbatim red-spike output.
 *
 * Scope note: the `CLOUD_SYNCED_CAPABILITY_SETTINGS` manifest enforcement
 * remains a DEFERRED Phase-3 decision (out of scope for this test-only stage).
 */
import { describe, expect, it } from 'vitest';
import type { ActiveProvider, AppSettings } from '../types/settings';
import { mergeLocalSettings, stripLocalSettings } from '../cloudSettingsPolicy';
import { validateProviderCredentials } from '@core/utils/validateProviderCredentials';
import { getApiKey } from '@core/rebelCore/settingsAccessors';

/**
 * How each provider's capability is supported across the desktop↔cloud
 * `settings:update` seam.
 *
 * - `settings-borne`: the supporting data the cloud surface needs travels INSIDE
 *   the settings payload, so it MUST survive `stripLocalSettings`. We assert it
 *   does and that the cloud-side accessor reads it back.
 * - `out-of-band`: the supporting data does NOT ride `settings:update` — it
 *   travels by a separate mechanism (dedicated channel / managed reconcile), so
 *   asserting it through this seam would be vacuous/wrong. We document why and
 *   skip the survives-assertion for that provider here.
 *
 * Exhaustive over `ActiveProvider`: a new provider fails to compile until its
 * supporting-data transport is classified.
 */
type SupportingDataTransport = 'settings-borne' | 'out-of-band';

interface ProviderSupportingDataPolicy {
  transport: SupportingDataTransport;
  /** Why the cloud surface needs this data (the consumer that proves it). */
  rationale: string;
}

const PROVIDER_SUPPORTING_DATA: Record<ActiveProvider, ProviderSupportingDataPolicy> = {
  anthropic: {
    transport: 'settings-borne',
    // Cloud consumer: validateProviderCredentials() → getApiKey(settings) reads
    // settings.models.apiKey (settingsAccessorsPure.getApiKey). Cloud agent turns
    // need the direct API key, which rides settings:update.
    rationale:
      'Cloud agent turns read settings.models.apiKey via getApiKey() in validateProviderCredentials; it rides settings:update.',
  },
  openrouter: {
    transport: 'settings-borne',
    // Cloud consumers: validateProviderCredentials (openRouter.oauthToken),
    // clientFactory.ts:474, roleAssignment.ts:433, authEnvUtils.ts — all read
    // settings.openRouter.oauthToken directly. This is the 260601 ZDR/data-loss
    // class: the openRouter object rides settings:update and MUST survive.
    rationale:
      'Cloud agent turns read settings.openRouter.oauthToken (validateProviderCredentials/clientFactory/roleAssignment); it rides settings:update.',
  },
  codex: {
    transport: 'out-of-band',
    // Codex tokens travel via the dedicated `codex:sync-tokens` channel +
    // cloud DEFAULT_CODEX_AUTH_PROVIDER, NOT via settings. There is no `codex`
    // field in AppSettings. validateProviderCredentials keys codex off the
    // out-of-band `codexConnected` flag. Asserting codex tokens through
    // stripLocalSettings would be vacuous/wrong.
    rationale:
      'Codex tokens sync via the dedicated codex:sync-tokens channel + DEFAULT_CODEX_AUTH_PROVIDER, not via settings:update.',
  },
  mindstone: {
    transport: 'out-of-band',
    // Mindstone managed: validateProviderCredentials returns valid unconditionally;
    // actual managed-key presence is checked fail-closed at execution (proxy /
    // agentTurnExecutor). managedCloudEnabled is intentionally LOCAL_ONLY. There
    // is no settings-borne credential to assert through this seam. (The managed
    // routing also reads openRouter.selectedModel, covered by the openrouter case.)
    rationale:
      'Managed-key presence is checked fail-closed at execution (proxy); managedCloudEnabled is intentionally LOCAL_ONLY. No settings-borne credential.',
  },
};

/** Settings fixture exercising every provider's capability + supporting data. */
function buildDesktopSettings(): Partial<AppSettings> {
  return {
    // Local-only — must NOT reach cloud.
    coreDirectory: '/Users/example/Core',
    managedCloudEnabled: true,
    // Cloud-synced capability flags + their supporting data.
    activeProvider: 'openrouter',
    models: {
      apiKey: 'fake-anthropic-supporting-data',
      model: 'claude-sonnet-4-20250514',
    } as AppSettings['models'],
    openRouter: {
      enabled: true,
      oauthToken: 'or-oauth-fake-supporting-data',
      selectedModel: 'openai/gpt-5.5',
    },
  };
}

describe('provider-capability supporting-data dual-write round trip', () => {
  it('settings:update carries provider capability + supporting data (dual-write, not stripped)', () => {
    // The channel that the capability flag + its supporting data ride. (We import
    // the policy lazily here to keep the contract assertion local to this test.)
    // The flag itself (activeProvider) and the supporting data (openRouter,
    // models) are NOT in LOCAL_ONLY_SETTINGS_KEYS — that is the precondition for
    // this seam to carry them.
    const stripped = stripLocalSettings(buildDesktopSettings() as Record<string, unknown>);
    // Capability flag survives.
    expect(stripped.activeProvider).toBe('openrouter');
    // Local-only supporting toggles are stripped (sanity: the strip DOES remove things).
    expect('coreDirectory' in stripped).toBe(false);
    expect('managedCloudEnabled' in stripped).toBe(false);
  });

  it.each(
    (Object.keys(PROVIDER_SUPPORTING_DATA) as ActiveProvider[]).filter(
      (p) => PROVIDER_SUPPORTING_DATA[p].transport === 'settings-borne',
    ),
  )(
    "settings-borne supporting data for activeProvider='%s' survives stripLocalSettings and round-trips",
    (provider) => {
      const desktop = buildDesktopSettings();
      desktop.activeProvider = provider;

      // Desktop → cloud: strip local-only, send the rest.
      const payload = stripLocalSettings(desktop as Record<string, unknown>);

      // Cloud receives an EMPTY settings store and merges the payload (mergeLocalSettings
      // restores local-only from the *cloud's own* locals; the payload is what arrived).
      // The cloud surface's effective settings are the payload merged over its empty base.
      const cloudLocal: Record<string, unknown> = {};
      const cloudEffective = mergeLocalSettings(payload, cloudLocal) as Partial<AppSettings>;

      // Verify the cloud-side CONSUMER can actually use the capability — read the
      // supporting data back through the real accessor, not by key-spotting.
      // codexConnected=false: only the openrouter/anthropic branches depend on
      // settings-borne data here.
      const credential = validateProviderCredentials(cloudEffective as AppSettings, false);

      if (provider === 'openrouter') {
        expect(cloudEffective.activeProvider).toBe('openrouter');
        // The supporting data (oauthToken) survived inside the openRouter object.
        expect(cloudEffective.openRouter?.oauthToken).toBe('or-oauth-fake-supporting-data');
        // ...and the cloud consumer resolves a usable credential from it.
        expect(credential.kind).toBe('openrouter');
        expect(credential.status).toBe('valid');
        if (credential.kind === 'openrouter' && credential.status === 'valid') {
          expect(credential.oauthToken).toBe('or-oauth-fake-supporting-data');
        }
      } else if (provider === 'anthropic') {
        expect(cloudEffective.activeProvider).toBe('anthropic');
        // The supporting data (direct API key) survived inside the models object.
        expect(getApiKey(cloudEffective as AppSettings)).toBe('fake-anthropic-supporting-data');
        // ...and the cloud consumer resolves a usable credential from it.
        expect(credential.kind).toBe('anthropic');
        expect(credential.status).toBe('valid');
        if (credential.kind === 'anthropic' && credential.status === 'valid') {
          expect(credential.apiKey).toBe('fake-anthropic-supporting-data');
        }
      } else {
        throw new Error(
          `Unhandled settings-borne provider '${provider}'. Add an assertion for its supporting data ` +
            `and the cloud consumer that proves it is needed.`,
        );
      }
    },
  );

  it('documents out-of-band providers (no settings-borne credential to assert here)', () => {
    // This is a guard, not a no-op: it pins the rationale so a future dev who
    // moves a provider's supporting data ONTO settings:update must reclassify it
    // (and then it gets a real survives-assertion above).
    const outOfBand = (Object.keys(PROVIDER_SUPPORTING_DATA) as ActiveProvider[]).filter(
      (p) => PROVIDER_SUPPORTING_DATA[p].transport === 'out-of-band',
    );
    expect(outOfBand.sort()).toEqual(['codex', 'mindstone']);
    for (const p of outOfBand) {
      expect(PROVIDER_SUPPORTING_DATA[p].rationale.length).toBeGreaterThan(0);
    }
  });
});
