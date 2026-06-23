import { describe, expect, it } from 'vitest';
import {
  CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS,
  CLOUD_SYNCED_MEETING_BOT_KEYS,
  LOCAL_ONLY_SETTINGS_KEYS,
  mergeLocalSettings,
  stripLocalSettings,
  stripSensitiveSettingsForClient,
} from '../cloudSettingsPolicy';
import { ActiveProviderSchema, ExperimentalSettingsSchema } from '../ipc/schemas/settings';
import { z } from 'zod';

describe('cloudSettingsPolicy', () => {
  // ---- stripLocalSettings ------------------------------------------------

  describe('stripLocalSettings', () => {
    it('removes all LOCAL_ONLY keys', () => {
      const settings: Record<string, unknown> = {
        cloudInstance: { mode: 'cloud', cloudUrl: 'https://example.fly.dev' },
        coreDirectory: '/Users/me/Documents/Core',
        mcpConfigFile: '/Users/me/Library/rebel/mcp/super-mcp-router.json',
        voice: { provider: 'openai-whisper' },
        userEmail: 'user@example.com',
      };

      const stripped = stripLocalSettings(settings);

      expect(stripped).not.toHaveProperty('cloudInstance');
      expect(stripped).not.toHaveProperty('coreDirectory');
      expect(stripped).not.toHaveProperty('mcpConfigFile');
    });

    it('preserves all non-local-only keys', () => {
      const settings: Record<string, unknown> = {
        cloudInstance: { mode: 'cloud' },
        coreDirectory: '/Users/me/Core',
        mcpConfigFile: '/Users/me/mcp.json',
        voice: { provider: 'openai-whisper' },
        userEmail: 'user@example.com',
        models: { apiKey: 'fake-test', model: 'claude-sonnet-4-20250514' },
        claude: { apiKey: 'fake-test', model: 'claude-sonnet-4-20250514' },
        onboardingCompleted: true,
      };

      const stripped = stripLocalSettings(settings);

      expect(stripped).toEqual({
        voice: { provider: 'openai-whisper' },
        userEmail: 'user@example.com',
        models: { apiKey: 'fake-test', model: 'claude-sonnet-4-20250514' },
        claude: { apiKey: 'fake-test', model: 'claude-sonnet-4-20250514' },
        onboardingCompleted: true,
      });
    });

    it('handles empty input', () => {
      expect(stripLocalSettings({})).toEqual({});
    });

    it('handles input with no local-only keys', () => {
      const settings = { voice: {}, userEmail: '[external-email]' };
      expect(stripLocalSettings(settings)).toEqual(settings);
    });

    // Efficiency Mode (260524_performance_mode): the master toggle, baseline
    // snapshot, persona quips flag, and CPU embedding idle disposal flag are
    // desktop-only. The underlying sub-settings the mode writes through to
    // (heroChoiceRunMode, timeSavedEstimation) intentionally still sync.
    it('strips efficiencyMode, efficiencyModeBaseline, personaQuipsEnabled, cpuEmbeddingIdleDisposalEnabled', () => {
      const settings: Record<string, unknown> = {
        efficiencyMode: 'on',
        efficiencyModeBaseline: {
          dailySparkMode: 'on',
          heroChoiceRunMode: 'ask',
          timeSavedEstimationEnabled: true,
          personaQuipsEnabled: true,
          cpuEmbeddingIdleDisposalEnabled: false,
        },
        personaQuipsEnabled: false,
        cpuEmbeddingIdleDisposalEnabled: true,
        // Underlying sub-settings continue to sync (NOT in LOCAL_ONLY)
        heroChoiceRunMode: 'off',
        timeSavedEstimation: { enabled: false },
      };

      const stripped = stripLocalSettings(settings);

      expect(stripped).not.toHaveProperty('efficiencyMode');
      expect(stripped).not.toHaveProperty('efficiencyModeBaseline');
      expect(stripped).not.toHaveProperty('personaQuipsEnabled');
      expect(stripped).not.toHaveProperty('cpuEmbeddingIdleDisposalEnabled');
      expect(stripped.heroChoiceRunMode).toBe('off');
      expect(stripped.timeSavedEstimation).toEqual({ enabled: false });

      const localOnlyKeys = [...LOCAL_ONLY_SETTINGS_KEYS];
      expect(localOnlyKeys).toContain('efficiencyMode');
      expect(localOnlyKeys).toContain('efficiencyModeBaseline');
      expect(localOnlyKeys).toContain('personaQuipsEnabled');
      expect(localOnlyKeys).toContain('cpuEmbeddingIdleDisposalEnabled');
      // Underlying settings explicitly NOT local-only
      expect(localOnlyKeys).not.toContain('heroChoiceRunMode');
      expect(localOnlyKeys).not.toContain('timeSavedEstimation');
    });

    // B6.a (Stage 3a, 260607_oss-b6-launch-polish): the OSS telemetry creds +
    // opt-in toggle are LOCAL_ONLY — they MUST be stripped before cloud sync so
    // the user's own Sentry DSN / RudderStack keys never leave the device.
    // `telemetry` is top-level precisely because stripLocalSettings is
    // top-level-key-only.
    it('strips the telemetry object (sentryDsn, rudderWriteKey, rudderDataPlaneUrl) before cloud sync', () => {
      const settings: Record<string, unknown> = {
        telemetry: {
          enabled: true,
          sentryDsn: 'https://[external-email]/1',
          rudderWriteKey: 'user-write-key',
          rudderDataPlaneUrl: 'https://user.dataplane.example',
        },
        userEmail: 'user@example.com',
        onboardingCompleted: true,
      };

      const stripped = stripLocalSettings(settings);

      expect(stripped).not.toHaveProperty('telemetry');
      // The individual creds must not survive anywhere in the stripped payload.
      const serialized = JSON.stringify(stripped);
      expect(serialized).not.toContain('user-write-key');
      expect(serialized).not.toContain('user.dataplane.example');
      expect(serialized).not.toContain('[external-email]');
      // Non-local-only siblings still sync.
      expect(stripped.userEmail).toBe('user@example.com');
      expect(stripped.onboardingCompleted).toBe(true);

      expect([...LOCAL_ONLY_SETTINGS_KEYS]).toContain('telemetry');
    });

    // Stage 1 of 260503_unify_learned_limits_into_profiles: the new provenance
    // sidecar fields live inside `localModel.profiles` (already cloud-synced)
    // and the migration-guard timestamps live on `localModel`. None are listed
    // in LOCAL_ONLY_SETTINGS_KEYS — this test pins that contract so a future
    // edit can't silently strip them and break cross-surface auto-learn.
    it('preserves learned-limits provenance fields on localModel.profiles and migration guards on localModel', () => {
      const settings: Record<string, unknown> = {
        localModel: {
          profiles: [
            {
              id: 'auto:mystery-model-9999',
              name: 'mystery-model-9999 (auto-detected)',
              providerType: 'other',
              serverUrl: '',
              model: 'mystery-model-9999',
              contextWindow: 880_000,
              contextWindowSource: 'auto',
              contextWindowOverflowCount: 2,
              contextWindowLearnedAt: 1_700_000_000_000,
              lastLearnedContextWindow: 880_000,
              createdAt: 1,
            },
          ],
          activeProfileId: null,
          learnedLimitsMigratedAt: 1_700_000_000_000,
          registryStampMigratedAt: 1_700_000_001_000,
        },
      };

      const stripped = stripLocalSettings(settings);

      expect(stripped.localModel).toEqual(settings.localModel);
    });

    it('preserves output-cap provenance fields on localModel.profiles and keeps them out of LOCAL_ONLY_SETTINGS_KEYS', () => {
      const settings: Record<string, unknown> = {
        localModel: {
          profiles: [
            {
              id: 'auto:output-cap-model',
              name: 'output-cap-model (auto-detected)',
              providerType: 'other',
              serverUrl: '',
              model: 'output-cap-model',
              maxOutputTokens: 8_192,
              outputTokensSource: 'auto',
              outputTokensOverflowCount: 3,
              outputTokensLearnedAt: 1_700_000_002_000,
              lastLearnedOutputTokens: 8_192,
              createdAt: 1,
            },
          ],
          activeProfileId: null,
        },
      };

      const stripped = stripLocalSettings(settings);
      expect(stripped.localModel).toEqual(settings.localModel);

      const localOnlyKeys = [...LOCAL_ONLY_SETTINGS_KEYS];
      expect(localOnlyKeys).not.toContain('outputTokensSource');
      expect(localOnlyKeys).not.toContain('outputTokensOverflowCount');
      expect(localOnlyKeys).not.toContain('outputTokensLearnedAt');
      expect(localOnlyKeys).not.toContain('lastLearnedOutputTokens');
    });
  });

  // ---- mergeLocalSettings ------------------------------------------------

  describe('mergeLocalSettings', () => {
    it('copies local-only values from localSettings into cloudSettings', () => {
      const cloudSettings: Record<string, unknown> = {
        voice: { provider: 'openai-whisper' },
        coreDirectory: '/data/workspace',
      };
      const localSettings: Record<string, unknown> = {
        cloudInstance: { mode: 'cloud', cloudUrl: 'https://test.fly.dev' },
        coreDirectory: '/Users/me/Documents/Core',
        mcpConfigFile: '/Users/me/mcp.json',
        voice: { provider: 'different' },
      };

      const merged = mergeLocalSettings(cloudSettings, localSettings);

      expect(merged.cloudInstance).toEqual({ mode: 'cloud', cloudUrl: 'https://test.fly.dev' });
      expect(merged.coreDirectory).toBe('/Users/me/Documents/Core');
      expect(merged.mcpConfigFile).toBe('/Users/me/mcp.json');
      // Non-local-only keys should NOT be overwritten
      expect(merged.voice).toEqual({ provider: 'openai-whisper' });
    });

    it('does not set local-only keys that are undefined in localSettings', () => {
      const cloudSettings: Record<string, unknown> = { voice: {} };
      const localSettings: Record<string, unknown> = {
        cloudInstance: { mode: 'cloud' },
        // coreDirectory and mcpConfigFile are undefined
      };

      const merged = mergeLocalSettings(cloudSettings, localSettings);

      expect(merged.cloudInstance).toEqual({ mode: 'cloud' });
      expect(merged).not.toHaveProperty('coreDirectory');
      expect(merged).not.toHaveProperty('mcpConfigFile');
    });

    it('does not mutate the original cloudSettings', () => {
      const cloudSettings: Record<string, unknown> = { voice: {} };
      const localSettings: Record<string, unknown> = { cloudInstance: { mode: 'cloud' } };

      const merged = mergeLocalSettings(cloudSettings, localSettings);

      expect(merged).not.toBe(cloudSettings);
      expect(cloudSettings).not.toHaveProperty('cloudInstance');
    });
  });

  // ---- Round-trip --------------------------------------------------------

  describe('round-trip', () => {
    it('strip then merge preserves local-only values', () => {
      const original: Record<string, unknown> = {
        cloudInstance: { mode: 'cloud', cloudUrl: 'https://test.fly.dev', cloudToken: 'tok' },
        coreDirectory: '/Users/me/Documents/Core',
        mcpConfigFile: '/Users/me/Library/rebel/mcp/super-mcp-router.json',
        voice: { provider: 'openai-whisper' },
        userEmail: 'user@example.com',
      };

      const stripped = stripLocalSettings(original);
      const restored = mergeLocalSettings(stripped, original);

      expect(restored).toEqual(original);
    });

    it('round-trip works with null/falsy local-only values', () => {
      const original: Record<string, unknown> = {
        cloudInstance: null,
        coreDirectory: '',
        mcpConfigFile: null,
        voice: {},
      };

      const stripped = stripLocalSettings(original);
      // null and '' are not undefined, so they should NOT be stripped by mergeLocalSettings
      // but they ARE stripped by stripLocalSettings
      expect(stripped).not.toHaveProperty('cloudInstance');
      expect(stripped).not.toHaveProperty('coreDirectory');
      expect(stripped).not.toHaveProperty('mcpConfigFile');

      // When merging back, null is not undefined so it should be restored
      const restored = mergeLocalSettings(stripped, original);
      expect(restored.cloudInstance).toBeNull();
      expect(restored.coreDirectory).toBe('');
      expect(restored.mcpConfigFile).toBeNull();
    });

    it('preserves cloud-synced meeting trigger settings through strip + merge', () => {
      const original: Record<string, unknown> = {
        meetingBot: {
          triggerPhrase: 'Spark',
          localRecordingTriggerListening: true,
        },
      };

      const stripped = stripLocalSettings(original);
      expect((stripped.meetingBot as Record<string, unknown>).triggerPhrase).toBe('Spark');
      expect((stripped.meetingBot as Record<string, unknown>).localRecordingTriggerListening).toBe(true);

      const restored = mergeLocalSettings(stripped, original);
      expect(restored).toEqual(original);

      expect(CLOUD_SYNCED_MEETING_BOT_KEYS.has('triggerPhrase')).toBe(true);
      expect(CLOUD_SYNCED_MEETING_BOT_KEYS.has('localRecordingTriggerListening')).toBe(true);
    });

    it('keeps Slack cloud workspace local while preserving the user cloud-webhook flag', () => {
      const original: Record<string, unknown> = {
        cloudInstance: { mode: 'cloud', cloudUrl: 'https://test.fly.dev' },
        coreDirectory: '/Users/me/Core',
        mcpConfigFile: '/Users/me/mcp.json',
        experimental: {
          slackCloudWebhookEnabled: true,
          cloudSlackWorkspace: {
            teamId: 'T123',
            teamName: 'Acme',
            status: 'connected',
            lastSeenAt: 1_714_000_000_000,
            lastError: {
              code: 'token_expired',
              message: 'Slack wants a fresh handshake.',
              occurredAt: 1_714_000_001_000,
            },
          },
        },
      };

      const stripped = stripLocalSettings(original);
      expect(stripped.experimental).toEqual({
        slackCloudWebhookEnabled: true,
      });
      const restored = mergeLocalSettings(stripped, original);
      expect(restored.experimental).toEqual(original.experimental);
    });

    it('preserves agentInstanceId and inboundAuthorPolicy through strip + merge', () => {
      const original: Record<string, unknown> = {
        experimental: {
          agentInstanceId: 'b6651a8a-8e0f-4485-aa31-2bcf38ed2796',
          inboundAuthorPolicyBypassActive: true,
          inboundAuthorPolicy: {
            inboundAuthorPolicySchemaVersion: 1,
            policyRevision: 3,
            mode: 'allowlist',
            allowlist: { slack: ['U123'] },
            blocklist: {},
            surfaceTrusted: { slack: ['C123'] },
            agentAllowlist: {},
            notices: {
              upgradeReviewPending: false,
            },
          },
          cloudSlackWorkspace: {
            teamId: 'T123',
            teamName: 'Acme',
            status: 'connected',
            lastSeenAt: 1_714_000_000_000,
          },
        },
      };

      const stripped = stripLocalSettings(original);
      expect(stripped.experimental).toEqual({
        agentInstanceId: 'b6651a8a-8e0f-4485-aa31-2bcf38ed2796',
        inboundAuthorPolicyBypassActive: true,
        inboundAuthorPolicy: {
          inboundAuthorPolicySchemaVersion: 1,
          policyRevision: 3,
          mode: 'allowlist',
          allowlist: { slack: ['U123'] },
          blocklist: {},
          surfaceTrusted: { slack: ['C123'] },
          agentAllowlist: {},
          notices: {
            upgradeReviewPending: false,
          },
        },
      });

      const restored = mergeLocalSettings(stripped, original);
      expect(restored.experimental).toEqual(original.experimental);
    });

    // 260619_cloud-symlink-indexing Stage 11 (cross-surface parity). The
    // `experimental.cloudSymlinkIndexing` flag drives a DESKTOP-only filesystem
    // experiment: the cloud-liveness prober (a `utilityProcess` child) + the 3
    // descent decision points only exist on desktop; cloud/mobile have no FUSE
    // mounts and keep the `@core` `unknown`-returning no-op probe. The flag is
    // being defaulted ON for everyone (with the flag retained as a desktop
    // kill-switch), so it MUST be stripped before cloud sync — a default-ON flag
    // leaking to cloud/mobile is exactly the recurring cross-surface trap (a flag
    // syncs while its supporting service is desktop-only). This pins it closed.
    it('keeps cloudSymlinkIndexing local-only (desktop FUSE experiment — never syncs to cloud/mobile, even when default-ON)', () => {
      const original: Record<string, unknown> = {
        experimental: {
          cloudSymlinkIndexing: true,
          // A cloud-synced experimental sibling must survive untouched.
          multiProviderRoutingEnabled: true,
        },
      };

      const stripped = stripLocalSettings(original);
      expect(stripped.experimental).toEqual({
        multiProviderRoutingEnabled: true,
      });
      expect((stripped.experimental as Record<string, unknown>).cloudSymlinkIndexing).toBeUndefined();

      // The local-only value is restored on merge back (desktop keeps it).
      const restored = mergeLocalSettings(stripped, original);
      expect(restored.experimental).toEqual(original.experimental);

      // And it is NOT in the intentionally-cloud-synced experimental set.
      expect([...CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS]).not.toContain('cloudSymlinkIndexing');
    });

    it('keeps inboundAuthorPolicyBackup local-only while preserving cloud-synced bypass status', () => {
      const original: Record<string, unknown> = {
        experimental: {
          inboundAuthorPolicyBypassActive: true,
          inboundAuthorPolicyBackup: {
            inboundAuthorPolicySchemaVersion: 999,
            mode: 'corrupted',
          },
        },
      };

      const stripped = stripLocalSettings(original);
      expect(stripped.experimental).toEqual({
        inboundAuthorPolicyBypassActive: true,
      });

      const restored = mergeLocalSettings(stripped, original);
      expect(restored.experimental).toEqual({
        inboundAuthorPolicyBypassActive: true,
        inboundAuthorPolicyBackup: {
          inboundAuthorPolicySchemaVersion: 999,
          mode: 'corrupted',
        },
      });
    });
  });

  // ---- stripSensitiveSettingsForClient ------------------------------------

  describe('stripSensitiveSettingsForClient', () => {
    it('nullifies top-level providerKeys', () => {
      const settings = {
        providerKeys: { openai: 'fake-123', anthropic: 'fake-456' },
        theme: 'dark',
      };
      const stripped = stripSensitiveSettingsForClient(settings);
      expect(stripped.providerKeys).toBeNull();
      expect(stripped.theme).toBe('dark');
    });

    it('nullifies nested apiKey, oauthToken, and oauthRefreshToken fields', () => {
      const settings = {
        claude: { apiKey: 'fake-ant-secret', model: 'claude-sonnet-4-20250514', oauthToken: 'tok-123', oauthRefreshToken: 'refresh-abc' },
        openRouter: { oauthToken: 'or-tok', oauthRefreshToken: 'or-refresh', model: 'gpt-4' },
      };
      const stripped = stripSensitiveSettingsForClient(settings);
      expect((stripped.claude as Record<string, unknown>).apiKey).toBeNull();
      expect((stripped.claude as Record<string, unknown>).oauthToken).toBeNull();
      expect((stripped.claude as Record<string, unknown>).oauthRefreshToken).toBeNull();
      expect((stripped.claude as Record<string, unknown>).model).toBe('claude-sonnet-4-20250514');
      expect((stripped.openRouter as Record<string, unknown>).oauthToken).toBeNull();
      expect((stripped.openRouter as Record<string, unknown>).oauthRefreshToken).toBeNull();
      expect((stripped.openRouter as Record<string, unknown>).model).toBe('gpt-4');
    });

    it('nullifies clientSecret in nested objects', () => {
      const settings = {
        googleWorkspace: { enabled: true, clientId: 'public-id', clientSecret: 'super-secret' },
      };
      const stripped = stripSensitiveSettingsForClient(settings);
      expect((stripped.googleWorkspace as Record<string, unknown>).enabled).toBe(true);
      expect((stripped.googleWorkspace as Record<string, unknown>).clientId).toBe('public-id');
      expect((stripped.googleWorkspace as Record<string, unknown>).clientSecret).toBeNull();
    });

    it('handles deeply nested apiKey in voice profiles', () => {
      const settings = {
        voice: {
          provider: 'openai-whisper',
          openaiApiKey: 'fake-voice',
          customProfiles: [
            { id: '1', name: 'Custom', apiKey: 'fake-profile-key' },
          ],
        },
      };
      const stripped = stripSensitiveSettingsForClient(settings);
      const voice = stripped.voice as Record<string, unknown>;
      expect(voice.provider).toBe('openai-whisper');
      expect(voice.openaiApiKey).toBeNull();
      const profiles = voice.customProfiles as Array<Record<string, unknown>>;
      expect(profiles[0].name).toBe('Custom');
      expect(profiles[0].apiKey).toBeNull();
    });

    it('preserves non-sensitive settings unchanged', () => {
      const settings = {
        theme: 'dark',
        onboardingCompleted: true,
        defaultModel: 'claude-sonnet-4-20250514',
        sessions: { maxHistory: 50 },
      };
      const stripped = stripSensitiveSettingsForClient(settings);
      expect(stripped).toEqual(settings);
    });

    it('does not mutate the original settings', () => {
      const original = { claude: { apiKey: 'fake-secret', model: 'test' } };
      stripSensitiveSettingsForClient(original);
      expect(original.claude.apiKey).toBe('fake-secret');
    });

    it('handles empty input', () => {
      expect(stripSensitiveSettingsForClient({})).toEqual({});
    });

    it('handles null and undefined values', () => {
      const settings = { claude: { apiKey: null, model: undefined } };
      const stripped = stripSensitiveSettingsForClient(settings);
      expect((stripped.claude as Record<string, unknown>).apiKey).toBeNull();
    });
  });

  // ---- Snapshot ----------------------------------------------------------

  it('LOCAL_ONLY_SETTINGS_KEYS snapshot', () => {
    expect([...LOCAL_ONLY_SETTINGS_KEYS].sort()).toMatchInlineSnapshot(`
      [
        "cloudInstance",
        "coreDirectory",
        "cpuEmbeddingIdleDisposalEnabled",
        "dailySparkMode",
        "efficiencyMode",
        "efficiencyModeBaseline",
        "enforceSoftwareEngineerEvidence",
        "managedCloudEnabled",
        "mcpConfigFile",
        "personaQuipsEnabled",
        "telemetry",
      ]
    `);
  });

  it('CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS includes inbound author policy fields', () => {
    expect(CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS.has('agentInstanceId')).toBe(true);
    expect(CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS.has('inboundAuthorPolicy')).toBe(true);
    expect(CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS.has('inboundAuthorPolicyBypassActive')).toBe(true);
    expect([...CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS]).not.toContain('inboundAuthorPolicyBackup');
    expect([...CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS]).not.toContain('cloudSlackWorkspace');
  });

  // ---- multi-provider foundation fields cross-surface round-trip (Stage 2/3) ----
  // Stage 2 carry-forward invariant (3): the multi-provider fields must survive
  // the cloud sync round-trip + schema validation. They are INTENTIONALLY synced
  // (not local-only), so the "inert until Stage 6" safety rests on "no writer yet",
  // not on the field being un-persistable — these tests pin that distinction.
  describe('multi-provider foundation fields (enabledProviders + multiProviderRoutingEnabled)', () => {
    it('stripLocalSettings preserves enabledProviders + experimental.multiProviderRoutingEnabled (they cloud-sync)', () => {
      const settings: Record<string, unknown> = {
        activeProvider: 'anthropic',
        enabledProviders: ['openrouter', 'anthropic'],
        experimental: { multiProviderRoutingEnabled: true },
        coreDirectory: '/Users/me/Documents/Core', // local-only — should be stripped
      };
      const stripped = stripLocalSettings(settings);
      expect(stripped.enabledProviders).toEqual(['openrouter', 'anthropic']);
      expect((stripped.experimental as Record<string, unknown>).multiProviderRoutingEnabled).toBe(true);
      expect(stripped.coreDirectory).toBeUndefined();
      expect(LOCAL_ONLY_SETTINGS_KEYS.has('enabledProviders' as never)).toBe(false);
    });

    it('strip→merge round-trip keeps the cloud-authoritative enabledProviders + flag', () => {
      const local: Record<string, unknown> = {
        enabledProviders: ['openrouter', 'anthropic'],
        experimental: { multiProviderRoutingEnabled: true },
        coreDirectory: '/Users/me/Documents/Core',
      };
      // Cloud stores the stripped (synced) view; merging local back must not drop the synced fields.
      const cloud = stripLocalSettings(local);
      const merged = mergeLocalSettings(cloud, local);
      expect(merged.enabledProviders).toEqual(['openrouter', 'anthropic']);
      expect((merged.experimental as Record<string, unknown>).multiProviderRoutingEnabled).toBe(true);
      expect(merged.coreDirectory).toBe('/Users/me/Documents/Core'); // local-only restored on merge
    });

    it('schemas accept + preserve both fields (field-level round-trip)', () => {
      expect(z.array(ActiveProviderSchema).parse(['openrouter', 'anthropic', 'codex', 'mindstone']))
        .toEqual(['openrouter', 'anthropic', 'codex', 'mindstone']);
      const exp = ExperimentalSettingsSchema.parse({ multiProviderRoutingEnabled: true });
      expect(exp?.multiProviderRoutingEnabled).toBe(true);
    });
  });
});
