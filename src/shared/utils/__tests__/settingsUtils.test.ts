import { describe, it, expect } from 'vitest';
import {
  normalizeSettings,
  getThinkingProfile,
  getWorkingProfile,
  setLocalInferenceCloudFallback,
} from '../settingsUtils';
import { MODEL_SETTINGS_FIELD_KEYS } from '../modelSettingsResolver';
import { getWorkingModelProfile } from '../../types';
import { PREFERRED_PLANNING_MODEL, DEFAULT_MODEL } from '../modelNormalization';
import { OR_DEFAULT_WORKING_MODEL } from '../openRouterDefaults';
import type { AppSettings } from '../../types';

describe('settingsUtils', () => {
  describe('normalizeSettings', () => {
    it('defaults Slack inbound thread history pre-fetch to enabled', () => {
      const result = normalizeSettings({} as unknown as AppSettings);

      expect(result.experimental?.slackInboundThreadHistory).toBe(true);
    });

    it('preserves an explicit Slack inbound thread history disable', () => {
      const result = normalizeSettings({
        experimental: { slackInboundThreadHistory: false },
      } as unknown as AppSettings);

      expect(result.experimental?.slackInboundThreadHistory).toBe(false);
    });

    it('defaults Slack desktop thread continuity to enabled', () => {
      const result = normalizeSettings({} as unknown as AppSettings);

      expect(result.experimental?.slackDesktopThreadContinuity).toBe(true);
    });

    it('preserves an explicit Slack desktop thread continuity disable', () => {
      const result = normalizeSettings({
        experimental: { slackDesktopThreadContinuity: false },
      } as unknown as AppSettings);

      expect(result.experimental?.slackDesktopThreadContinuity).toBe(false);
    });

    describe('legacy reasoningDisabled migration (REBEL-5RJ)', () => {
      // The manual "Off" thinking level (reasoningDisabled) was removed 2026-06-18.
      // normalizeSettings migrates legacy reasoningDisabled:true profiles to the
      // auto-detected thinkingCompatibility:'incompatible' so their suppression
      // survives — otherwise a manually-"Off" profile that was never Test-probed
      // (thinkingCompatibility:'unknown') would resume sending reasoning_effort and
      // re-break the gateways the flag protected.
      const migrate = (profile: Record<string, unknown>) => {
        const result = normalizeSettings({
          localModel: { profiles: [{ ...profile }] },
        } as unknown as AppSettings);
        return result.localModel?.profiles?.find((p) => p.id === 'gw') as
          | (Record<string, unknown> & { thinkingCompatibility?: string; reasoningEffort?: string })
          | undefined;
      };
      const base = {
        id: 'gw',
        name: 'Gateway',
        providerType: 'other',
        serverUrl: 'https://gateway.example.com/v1',
        model: 'claude-opus-4-8',
        createdAt: 1_700_000_000_000,
      };

      it('migrates reasoningDisabled:true → thinkingCompatibility:incompatible, drops the field + effort', () => {
        const profile = migrate({ ...base, reasoningDisabled: true, reasoningEffort: 'high' });
        expect(profile).toBeDefined();
        expect(profile?.thinkingCompatibility).toBe('incompatible');
        expect(profile).not.toHaveProperty('reasoningDisabled');
        expect(profile?.reasoningEffort).toBeUndefined();
      });

      it('is idempotent when the profile is already thinkingCompatibility:incompatible', () => {
        const profile = migrate({ ...base, reasoningDisabled: true, thinkingCompatibility: 'incompatible' });
        expect(profile?.thinkingCompatibility).toBe('incompatible');
        expect(profile).not.toHaveProperty('reasoningDisabled');
      });

      it('overwrites a contradictory thinkingCompatibility:compatible to preserve the "off" behaviour', () => {
        // A profile manually set "Off" whose probe said compatible: the user's intent
        // was no-thinking. Migration preserves that (marks incompatible); a fresh Test
        // can bring thinking back if the gateway really is compatible.
        const profile = migrate({ ...base, reasoningDisabled: true, thinkingCompatibility: 'compatible' });
        expect(profile?.thinkingCompatibility).toBe('incompatible');
        expect(profile).not.toHaveProperty('reasoningDisabled');
      });

      it('drops a stray reasoningDisabled:false without marking incompatible or clearing effort', () => {
        const profile = migrate({ ...base, reasoningDisabled: false, reasoningEffort: 'high' });
        expect(profile).not.toHaveProperty('reasoningDisabled');
        expect(profile?.thinkingCompatibility).toBeUndefined();
        expect(profile?.reasoningEffort).toBe('high');
      });

      it('leaves a profile without the legacy field untouched (effort preserved)', () => {
        const profile = migrate({ ...base, reasoningEffort: 'high' });
        expect(profile?.reasoningEffort).toBe('high');
        expect(profile?.thinkingCompatibility).toBeUndefined();
      });
    });

    describe('inbound author policy migration scaffolding (Stage 0)', () => {
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      function withCloudRuntime<T>(fn: () => T): T {
        const previous = process.env.IS_CLOUD_SERVICE;
        process.env.IS_CLOUD_SERVICE = '1';
        try {
          return fn();
        } finally {
          if (previous === undefined) {
            delete process.env.IS_CLOUD_SERVICE;
          } else {
            process.env.IS_CLOUD_SERVICE = previous;
          }
        }
      }

      it('seeds a strict ownerOnly inbound policy on fresh desktop settings', () => {
        const result = normalizeSettings({} as unknown as AppSettings);
        expect(result.experimental?.inboundAuthorPolicy).toEqual({
          inboundAuthorPolicySchemaVersion: 1,
          policyRevision: 0,
          mode: 'ownerOnly',
          allowlist: {},
          blocklist: {},
          surfaceTrusted: {},
          agentAllowlist: {},
          notices: {
            upgradeReviewPending: false,
          },
        });
      });

      it('seeds legacyPermissive + upgrade notice when cloud Slack workspace already exists', () => {
        const result = normalizeSettings({
          experimental: {
            cloudSlackWorkspace: {
              teamId: 'T123',
              teamName: 'Acme',
              status: 'connected',
              lastSeenAt: 1_714_000_000_000,
            },
          },
        } as unknown as AppSettings);

        expect(result.experimental?.inboundAuthorPolicy?.mode).toBe('legacyPermissive');
        expect(result.experimental?.inboundAuthorPolicy?.notices.upgradeReviewPending).toBe(true);
      });

      it('seeds legacyPermissive when cloud-side normalization sees no existing policy', () => {
        const result = withCloudRuntime(() => normalizeSettings({} as unknown as AppSettings));
        expect(result.experimental?.inboundAuthorPolicy?.mode).toBe('legacyPermissive');
        expect(result.experimental?.inboundAuthorPolicy?.notices.upgradeReviewPending).toBe(true);
      });

      it('re-seeds corrupted schema-v1 policy to safe legacyPermissive + upgrade notice', () => {
        const corruptedSchemaV1 = {
          inboundAuthorPolicySchemaVersion: 1,
          policyRevision: 9,
          mode: 'ownerOnly',
          blocklist: {},
          surfaceTrusted: {},
          agentAllowlist: {},
          notices: {
            upgradeReviewPending: false,
          },
        };
        const result = normalizeSettings({
          experimental: {
            inboundAuthorPolicy: corruptedSchemaV1 as unknown,
          },
        } as unknown as AppSettings);

        expect(result.experimental?.inboundAuthorPolicy).toEqual({
          inboundAuthorPolicySchemaVersion: 1,
          policyRevision: 0,
          mode: 'legacyPermissive',
          allowlist: {},
          blocklist: {},
          surfaceTrusted: {},
          agentAllowlist: {},
          notices: {
            upgradeReviewPending: true,
          },
        });
        expect(result.experimental?.inboundAuthorPolicyBackup).toEqual(corruptedSchemaV1);
      });

      it('re-seeds unknown object policy shape to safe legacyPermissive + upgrade notice', () => {
        const result = normalizeSettings({
          experimental: {
            inboundAuthorPolicy: {},
          },
        } as unknown as AppSettings);

        expect(result.experimental?.inboundAuthorPolicy).toEqual({
          inboundAuthorPolicySchemaVersion: 1,
          policyRevision: 0,
          mode: 'legacyPermissive',
          allowlist: {},
          blocklist: {},
          surfaceTrusted: {},
          agentAllowlist: {},
          notices: {
            upgradeReviewPending: true,
          },
        });
      });

      it('re-seeds unknown schema version policy shape to safe legacyPermissive + upgrade notice', () => {
        const result = normalizeSettings({
          experimental: {
            inboundAuthorPolicy: {
              inboundAuthorPolicySchemaVersion: 999,
            },
          },
        } as unknown as AppSettings);

        expect(result.experimental?.inboundAuthorPolicy).toEqual({
          inboundAuthorPolicySchemaVersion: 1,
          policyRevision: 0,
          mode: 'legacyPermissive',
          allowlist: {},
          blocklist: {},
          surfaceTrusted: {},
          agentAllowlist: {},
          notices: {
            upgradeReviewPending: true,
          },
        });
      });

      it('re-seeds non-object policy values to safe legacyPermissive + upgrade notice', () => {
        const result = normalizeSettings({
          experimental: {
            inboundAuthorPolicy: 'not an object',
          },
        } as unknown as AppSettings);

        expect(result.experimental?.inboundAuthorPolicy).toEqual({
          inboundAuthorPolicySchemaVersion: 1,
          policyRevision: 0,
          mode: 'legacyPermissive',
          allowlist: {},
          blocklist: {},
          surfaceTrusted: {},
          agentAllowlist: {},
          notices: {
            upgradeReviewPending: true,
          },
        });
        expect(result.experimental?.inboundAuthorPolicyBackup).toBe('not an object');
      });

      it('keeps only a single inboundAuthorPolicyBackup slot (latest corruption wins)', () => {
        const firstPass = normalizeSettings({
          experimental: {
            inboundAuthorPolicy: {},
          },
        } as unknown as AppSettings);
        expect(firstPass.experimental?.inboundAuthorPolicyBackup).toEqual({});

        const secondPass = normalizeSettings({
          ...firstPass,
          experimental: {
            ...(firstPass.experimental ?? {}),
            inboundAuthorPolicy: {
              inboundAuthorPolicySchemaVersion: 999,
              stale: true,
            },
          },
        } as unknown as AppSettings);

        expect(secondPass.experimental?.inboundAuthorPolicyBackup).toEqual({
          inboundAuthorPolicySchemaVersion: 999,
          stale: true,
        });
      });

      it('mints and persists a stable agentInstanceId', () => {
        const firstPass = normalizeSettings({} as unknown as AppSettings);
        expect(firstPass.experimental?.agentInstanceId).toMatch(uuidV4Regex);

        const secondPass = normalizeSettings(firstPass);
        expect(secondPass.experimental?.agentInstanceId).toBe(firstPass.experimental?.agentInstanceId);
      });

      const persistedStateFixtures: Array<{ name: string; input: AppSettings }> = [
        {
          name: 'fresh settings',
          input: {} as unknown as AppSettings,
        },
        {
          name: 'desktop upgrade with connected cloud workspace',
          input: {
            experimental: {
              cloudSlackWorkspace: {
                teamId: 'T123',
                teamName: 'Acme',
                status: 'connected',
                lastSeenAt: 1_714_000_000_000,
              },
            },
          } as unknown as AppSettings,
        },
        {
          name: 'existing strict policy and fixed agent id',
          input: {
            experimental: {
              agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
              inboundAuthorPolicy: {
                inboundAuthorPolicySchemaVersion: 1,
                policyRevision: 5,
                mode: 'allowlist',
                allowlist: { slack: ['U123'] },
                blocklist: {},
                surfaceTrusted: {},
                agentAllowlist: {},
                notices: {
                  upgradeReviewPending: false,
                },
              },
            },
          } as unknown as AppSettings,
        },
      ];

      it.each(persistedStateFixtures)(
        'is persistence-stable for inbound policy fixture: $name',
        ({ input }) => {
          const normalized = normalizeSettings(input);
          const persisted = JSON.parse(JSON.stringify(normalized));
          const reNormalized = normalizeSettings(persisted as AppSettings);
          expect(reNormalized).toEqual(persisted);
        },
      );
    });

    describe('Claude OAuth → API key migration', () => {
      const createMinimalSettings = (claudeOverrides: Partial<AppSettings['claude']> = {}): AppSettings =>
        ({
          claude: {
            apiKey: 'fake-existing-key',
            oauthToken: null,
            authMethod: 'api-key',
            model: null,
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
            ...claudeOverrides,
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
          },
        }) as unknown as AppSettings;

      it('should migrate authMethod oauth-token + oauthToken to api-key + cleared tokens', () => {
        const settings = createMinimalSettings({
          authMethod: 'oauth-token',
          oauthToken: 'test-oauth-token',
          oauthRefreshToken: 'test-refresh-token',
          oauthTokenExpiresAt: 1234567890,
          oauthProfile: { displayName: 'Test', email: 'test@example.com' },
          usageData: { fiveHour: { utilization: 0.5, resetsAt: '' }, sevenDay: { utilization: 0.3, resetsAt: '' }, sevenDaySonnet: { utilization: 0.1, resetsAt: '' }, fetchedAt: 123 },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.authMethod).toBe('api-key');
        expect(result.models?.oauthToken).toBeNull();
        expect(result.models?.oauthRefreshToken).toBeNull();
        expect(result.models?.oauthTokenExpiresAt).toBeNull();
        expect(result.models?.oauthProfile).toBeUndefined();
        expect(result.models?.usageData).toBeUndefined();
        // oauthMigratedAt is set by migrateOAuthTimestampIfNeeded() at startup, not normalizeSettings()
      });

      it('should migrate stale state: authMethod oauth-token + null oauthToken', () => {
        const settings = createMinimalSettings({
          authMethod: 'oauth-token',
          oauthToken: null,
        });
        const result = normalizeSettings(settings);
        expect(result.models?.authMethod).toBe('api-key');
        expect(result.models?.oauthToken).toBeNull();
      });

      it('should migrate when oauthToken is truthy but authMethod is api-key (lingering token)', () => {
        const settings = createMinimalSettings({
          authMethod: 'api-key',
          oauthToken: 'lingering-token',
        });
        const result = normalizeSettings(settings);
        expect(result.models?.authMethod).toBe('api-key');
        expect(result.models?.oauthToken).toBeNull();
      });

      it('should migrate when oauthRefreshToken is truthy but authMethod is api-key', () => {
        const settings = createMinimalSettings({
          authMethod: 'api-key',
          oauthToken: null,
          oauthRefreshToken: 'lingering-refresh-token',
        });
        const result = normalizeSettings(settings);
        expect(result.models?.authMethod).toBe('api-key');
        expect(result.models?.oauthRefreshToken).toBeNull();
      });

      it('should not touch settings when no OAuth artifacts exist', () => {
        const settings = createMinimalSettings({
          authMethod: 'api-key',
          oauthToken: null,
          oauthRefreshToken: null,
          apiKey: 'fake-my-key',
        });
        const result = normalizeSettings(settings);
        expect(result.models?.authMethod).toBe('api-key');
        expect(result.models?.apiKey).toBe('fake-my-key');
      });

      it('should preserve existing apiKey during migration', () => {
        const settings = createMinimalSettings({
          authMethod: 'oauth-token',
          oauthToken: 'test-token',
          apiKey: 'fake-preserve-this',
        });
        const result = normalizeSettings(settings);
        expect(result.models?.apiKey).toBe('fake-preserve-this');
        expect(result.models?.authMethod).toBe('api-key');
      });

      it('should be idempotent — applying twice produces the same result', () => {
        const settings = createMinimalSettings({
          authMethod: 'oauth-token',
          oauthToken: 'test-token',
        });
        const once = normalizeSettings(settings);
        const twice = normalizeSettings(once);
        expect(twice.models).toEqual(once.models);
      });
    });

    describe('voiceInputLanguage', () => {
      const createMinimalSettings = (voiceOverrides: Partial<AppSettings['voice']> = {}): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: null,
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: true,
            extendedContext: true,
            thinkingEffort: 'high',
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
            ...voiceOverrides,
          },
        }) as unknown as AppSettings;

      it('should default to "auto" when voiceInputLanguage is not set', () => {
        const settings = createMinimalSettings({});
        const result = normalizeSettings(settings);
        expect(result.voice.voiceInputLanguage).toBe('auto');
      });

      it('should preserve valid language code "en"', () => {
        const settings = createMinimalSettings({ voiceInputLanguage: 'en' });
        const result = normalizeSettings(settings);
        expect(result.voice.voiceInputLanguage).toBe('en');
      });

      it('should preserve valid language code "fr"', () => {
        const settings = createMinimalSettings({ voiceInputLanguage: 'fr' });
        const result = normalizeSettings(settings);
        expect(result.voice.voiceInputLanguage).toBe('fr');
      });

      it('should preserve valid language code "zh"', () => {
        const settings = createMinimalSettings({ voiceInputLanguage: 'zh' });
        const result = normalizeSettings(settings);
        expect(result.voice.voiceInputLanguage).toBe('zh');
      });

      it('should preserve "auto" explicitly set', () => {
        const settings = createMinimalSettings({ voiceInputLanguage: 'auto' });
        const result = normalizeSettings(settings);
        expect(result.voice.voiceInputLanguage).toBe('auto');
      });

      it('should fall back to "auto" for invalid language code', () => {
        const settings = createMinimalSettings({ voiceInputLanguage: 'invalid-code' });
        const result = normalizeSettings(settings);
        expect(result.voice.voiceInputLanguage).toBe('auto');
      });

      it('should fall back to "auto" for empty string', () => {
        const settings = createMinimalSettings({ voiceInputLanguage: '' });
        const result = normalizeSettings(settings);
        expect(result.voice.voiceInputLanguage).toBe('auto');
      });

      it('should fall back to "auto" for unsupported language code "xyz"', () => {
        const settings = createMinimalSettings({ voiceInputLanguage: 'xyz' });
        const result = normalizeSettings(settings);
        expect(result.voice.voiceInputLanguage).toBe('auto');
      });
    });

    describe('voice model defaults', () => {
      const createMinimalSettings = (voiceOverrides: Partial<AppSettings['voice']> = {}): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: null,
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: true,
            extendedContext: true,
            thinkingEffort: 'high',
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
            ...voiceOverrides,
          },
        }) as unknown as AppSettings;

      it('should default new users to gpt-4o-mini-transcribe-2025-12-15', () => {
        const settings = createMinimalSettings({});
        const result = normalizeSettings(settings);
        expect(result.voice.model).toBe('gpt-4o-mini-transcribe-2025-12-15');
      });

      it('should auto-migrate gpt-4o-transcribe to gpt-4o-mini-transcribe', () => {
        const settings = createMinimalSettings({ model: 'gpt-4o-transcribe' });
        const result = normalizeSettings(settings);
        expect(result.voice.model).toBe('gpt-4o-mini-transcribe-2025-12-15');
      });

      it('should preserve whisper-1 if user explicitly selected it', () => {
        const settings = createMinimalSettings({ model: 'whisper-1' });
        const result = normalizeSettings(settings);
        expect(result.voice.model).toBe('whisper-1');
      });

      it('should fall back to gpt-4o-mini-transcribe for invalid openai model', () => {
        const settings = createMinimalSettings({ model: 'scribe_v2' });
        const result = normalizeSettings(settings);
        expect(result.voice.model).toBe('gpt-4o-mini-transcribe-2025-12-15');
      });

      it('should preserve parakeet-v3 for local-parakeet provider', () => {
        const settings = createMinimalSettings({
          provider: 'local-parakeet',
          model: 'parakeet-v3'
        });
        const result = normalizeSettings(settings);

        expect(result.voice.provider).toBe('local-parakeet');
        expect(result.voice.model).toBe('parakeet-v3');
      });

      it('should migrate legacy local-moonshine provider to local-parakeet (desktop Moonshine removed — Sentry REBEL-1FP)', () => {
        const settings = createMinimalSettings({
          provider: 'local-moonshine',
          model: 'moonshine-base'
        });
        const result = normalizeSettings(settings);

        expect(result.voice.provider).toBe('local-parakeet');
        expect(result.voice.model).toBe('parakeet-v3');
      });

      it('should migrate local-moonshine with empty model to local-parakeet', () => {
        const settings = createMinimalSettings({
          provider: 'local-moonshine',
          model: ''
        });
        const result = normalizeSettings(settings);

        expect(result.voice.provider).toBe('local-parakeet');
        expect(result.voice.model).toBe('parakeet-v3');
      });
    });

    describe('custom-openai voice profile normalization', () => {
      const createMinimalSettings = (voiceOverrides: Partial<AppSettings['voice']> = {}): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: null,
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
          voice: {
            provider: 'custom-openai',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
            ...voiceOverrides,
          },
        }) as unknown as AppSettings;

      it('preserves custom-openai as a valid provider', () => {
        const settings = createMinimalSettings({ provider: 'custom-openai' });
        const result = normalizeSettings(settings);
        expect(result.voice.provider).toBe('custom-openai');
      });

      it('cleans stale activeCustomProfileId when profile does not exist', () => {
        const settings = createMinimalSettings({
          customProfiles: [
            {
              id: 'profile-1',
              name: 'Primary',
              sttBaseUrl: 'https://speech.example.com',
              sttModel: 'whisper-custom',
              createdAt: 1,
            },
          ],
          activeCustomProfileId: 'missing-profile',
        });

        const result = normalizeSettings(settings);
        expect(result.voice.activeCustomProfileId).toBeNull();
      });

      it('defaults customProfiles to an empty array when undefined', () => {
        const settings = createMinimalSettings({ customProfiles: undefined });
        const result = normalizeSettings(settings);

        expect(result.voice.customProfiles).toEqual([]);
        expect(result.voice.activeCustomProfileId).toBeNull();
      });

      it('preserves existing customProfiles through normalization', () => {
        const profiles = [
          {
            id: 'profile-1',
            name: 'Work',
            sttBaseUrl: 'https://speech.work.example',
            sttModel: 'whisper-work',
            ttsBaseUrl: 'https://speech.work.example',
            ttsModel: 'tts-work',
            ttsVoice: 'alloy',
            apiKey: 'key-1',
            createdAt: 1,
          },
          {
            id: 'profile-2',
            name: 'Lab',
            sttBaseUrl: 'https://speech.lab.example',
            sttModel: 'whisper-lab',
            createdAt: 2,
          },
        ];

        const settings = createMinimalSettings({
          customProfiles: profiles,
          activeCustomProfileId: 'profile-1',
        });
        const result = normalizeSettings(settings);

        expect(result.voice.customProfiles).toEqual(profiles);
        expect(result.voice.activeCustomProfileId).toBe('profile-1');
      });
    });

    describe('providerKeys migration', () => {
      const createMinimalSettings = (overrides: {
        providerKeys?: AppSettings['providerKeys'];
        voiceOpenaiApiKey?: string | null;
      } = {}): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: null,
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: overrides.voiceOpenaiApiKey ?? null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
          },
          providerKeys: overrides.providerKeys,
        }) as unknown as AppSettings;

      it('should migrate voice.openaiApiKey to providerKeys.openai when providerKeys.openai is absent', () => {
        const settings = createMinimalSettings({ voiceOpenaiApiKey: 'fake-from-voice' });
        const result = normalizeSettings(settings);
        expect(result.providerKeys?.openai).toBe('fake-from-voice');
      });

      it('should not clobber existing providerKeys.openai even if voice.openaiApiKey differs', () => {
        const settings = createMinimalSettings({
          providerKeys: { openai: 'fake-existing-provider-key' },
          voiceOpenaiApiKey: 'fake-different-voice-key',
        });
        const result = normalizeSettings(settings);
        expect(result.providerKeys?.openai).toBe('fake-existing-provider-key');
      });

      it('should derive voice.openaiApiKey from providerKeys.openai', () => {
        const settings = createMinimalSettings({
          providerKeys: { openai: 'fake-provider-key' },
          voiceOpenaiApiKey: null,
        });
        const result = normalizeSettings(settings);
        expect(result.voice.openaiApiKey).toBe('fake-provider-key');
      });

      it('should normalize empty string keys to null in derivation', () => {
        const settings = createMinimalSettings({
          providerKeys: { openai: '' },
          voiceOpenaiApiKey: '   ',
        });
        const result = normalizeSettings(settings);
        expect(result.voice.openaiApiKey).toBeNull();
      });

      it('should trim whitespace during migration', () => {
        const settings = createMinimalSettings({ voiceOpenaiApiKey: '  fake-trimmed  ' });
        const result = normalizeSettings(settings);
        expect(result.providerKeys?.openai).toBe('fake-trimmed');
      });

      it('should preserve providerKeys.google when present', () => {
        const settings = createMinimalSettings({
          providerKeys: { google: 'AIzaTestKey' },
        });
        const result = normalizeSettings(settings);
        expect(result.providerKeys?.google).toBe('AIzaTestKey');
      });

      it('should return empty providerKeys when no keys exist', () => {
        const settings = createMinimalSettings({});
        const result = normalizeSettings(settings);
        expect(result.providerKeys).toEqual({});
      });
    });

    describe('behindTheScenesModel migration and cleanup', () => {
      const createSettingsWithLocalModel = (overrides: {
        behindTheScenesModel?: string;
        activeProfileId?: string | null;
        workingProfileId?: string;
        profiles?: Array<{ id: string; name: string; providerType: string; serverUrl: string; model: string; apiKey: string; createdAt: number }>;
      } = {}): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: null,
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
            workingProfileId: overrides.workingProfileId,
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
          },
          behindTheScenesModel: overrides.behindTheScenesModel,
          localModel: {
            profiles: overrides.profiles ?? [],
            activeProfileId: overrides.activeProfileId ?? null,
          },
        }) as unknown as AppSettings;

      it('should migrate "use-alternative" to profile:<workingProfileId> when working profile exists', () => {
        const settings = createSettingsWithLocalModel({
          behindTheScenesModel: 'use-alternative',
          workingProfileId: 'p1',
          profiles: [{ id: 'p1', name: 'OpenAI', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'fake-test', createdAt: 1 }],
        });
        const result = normalizeSettings(settings);
        expect(result.behindTheScenesModel).toBe('profile:p1');
      });

      it('should migrate "use-alternative" to profile:<activeProfileId> via fallback when no workingProfileId', () => {
        const settings = createSettingsWithLocalModel({
          behindTheScenesModel: 'use-alternative',
          activeProfileId: 'p1',
          profiles: [{ id: 'p1', name: 'OpenAI', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'fake-test', createdAt: 1 }],
        });
        const result = normalizeSettings(settings);
        // activeProfileId gets migrated to workingProfileId, which getWorkingModelProfile resolves
        expect(result.behindTheScenesModel).toBe('profile:p1');
      });

      it('should clear "use-alternative" to undefined when no working profile exists', () => {
        const settings = createSettingsWithLocalModel({
          behindTheScenesModel: 'use-alternative',
          activeProfileId: null,
          profiles: [{ id: 'p1', name: 'OpenAI', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'fake-test', createdAt: 1 }],
        });
        const result = normalizeSettings(settings);
        expect(result.behindTheScenesModel).toBeUndefined();
      });

      it('should clean up stale profile:<deletedId> to undefined', () => {
        const settings = createSettingsWithLocalModel({
          behindTheScenesModel: 'profile:deleted-profile',
          profiles: [{ id: 'p1', name: 'OpenAI', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'fake-test', createdAt: 1 }],
        });
        const result = normalizeSettings(settings);
        expect(result.behindTheScenesModel).toBeUndefined();
      });

      it('should preserve valid profile:<id> when profile exists', () => {
        const settings = createSettingsWithLocalModel({
          behindTheScenesModel: 'profile:p1',
          profiles: [{ id: 'p1', name: 'OpenAI', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'fake-test', createdAt: 1 }],
        });
        const result = normalizeSettings(settings);
        expect(result.behindTheScenesModel).toBe('profile:p1');
      });

      it('should not clear Claude model values when no active profile', () => {
        const settings = createSettingsWithLocalModel({
          behindTheScenesModel: 'claude-haiku-4-5-20251001',
          activeProfileId: null,
        });
        const result = normalizeSettings(settings);
        expect(result.behindTheScenesModel).toBe('claude-haiku-4-5-20251001');
      });

      it('should not auto-default BTS when working profile is active but BTS is unset', () => {
        // Unlike the old behavior, we no longer auto-set BTS when a working profile exists
        const settings = createSettingsWithLocalModel({
          behindTheScenesModel: undefined,
          workingProfileId: 'p1',
          profiles: [{ id: 'p1', name: 'OpenAI', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'fake-test', createdAt: 1 }],
        });
        const result = normalizeSettings(settings);
        expect(result.behindTheScenesModel).toBeUndefined();
      });
    });

    describe('provider invariants and fallback cleanup', () => {
      const openAiProfile = {
        id: 'prof_gpt',
        name: 'OpenAI GPT-5.5',
        providerType: 'openai' as const,
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.5',
        createdAt: 1,
      };

      const createProviderSettings = (overrides: {
        activeProvider?: AppSettings['activeProvider'];
        openRouter?: AppSettings['openRouter'];
        providerKeys?: AppSettings['providerKeys'];
        claude?: Partial<AppSettings['claude']>;
        localModel?: Partial<AppSettings['localModel']>;
        behindTheScenesModel?: string;
        backgroundFallback?: string;
        localInferenceCloudFallback?: string;
        behindTheScenesOverrides?: AppSettings['behindTheScenesOverrides'];
      } = {}): AppSettings =>
        ({
          activeProvider: overrides.activeProvider,
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
            ...overrides.claude,
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
          },
          openRouter: overrides.openRouter,
          providerKeys: overrides.providerKeys,
          localModel: {
            profiles: [],
            activeProfileId: null,
            ...overrides.localModel,
          },
          behindTheScenesModel: overrides.behindTheScenesModel,
          backgroundFallback: overrides.backgroundFallback,
          localInferenceCloudFallback: overrides.localInferenceCloudFallback,
          behindTheScenesOverrides: overrides.behindTheScenesOverrides,
        }) as unknown as AppSettings;

      it('does NOT rewrite Claude model choices when activeProvider is codex', () => {
        const settings = createProviderSettings({
          activeProvider: 'codex',
          claude: {
            model: 'claude-opus-4-7',
            thinkingModel: 'claude-sonnet-4-6',
          },
          behindTheScenesModel: 'claude-haiku-4-5',
        });

        const result = normalizeSettings(settings);

        expect(result.models?.model).toBe('claude-opus-4-7');
        expect(result.models?.workingProfileId).toBe('__virtual-working');
        expect(result.models?.thinkingProfileId).toBe('__virtual-thinking');
        expect(result.models?.thinkingModel).toBeUndefined();
        expect(result.localModel?.profiles.find((p) => p.id === '__virtual-working')?.model).toBe('claude-opus-4-7');
        expect(result.localModel?.profiles.find((p) => p.id === '__virtual-thinking')?.model).toBe('claude-sonnet-4-6');
        expect(result.behindTheScenesModel).toBe('claude-haiku-4-5');
      });

      it('preserves a valid Codex thinkingModel when activeProvider is codex', () => {
        const settings = createProviderSettings({
          activeProvider: 'codex',
          claude: {
            model: 'claude-opus-4-7',
            thinkingModel: 'gpt-5.5',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingModel).toBe('gpt-5.5');
      });

      it('clears a deny-listed Codex thinkingModel (gpt-5.5-pro) under codex', () => {
        const settings = createProviderSettings({
          activeProvider: 'codex',
          claude: {
            model: 'claude-opus-4-7',
            thinkingModel: 'gpt-5.5-pro',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingModel).toBeUndefined();
      });

      it('clears an unknown bare thinkingModel under codex', () => {
        const settings = createProviderSettings({
          activeProvider: 'codex',
          claude: {
            model: 'claude-opus-4-7',
            thinkingModel: 'gpt-9000',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingModel).toBeUndefined();
      });

      // REBEL-5JN: a valid Codex bare model ID (GPT-5.5) chosen as the thinking
      // model must survive even when the active provider is NOT codex (e.g. the
      // user runs GPT-5.5 thinking via a supplemental Codex connection while
      // working on Anthropic-direct). Previously this branch validated only
      // against the Anthropic catalog, so 'gpt-5.5' was cleared on every save.
      //
      // The supplemental-Codex connection seeds the auto Codex working profile
      // (`codex-gpt-5.5`, model `gpt-5.5`), which is what makes the bare thinking
      // model actually routable at runtime (resolveProfileFromModelString matches
      // it). The Phase-6 refinement tightened acceptance to require this routable
      // profile, so model it explicitly here.
      it('preserves a valid Codex thinkingModel (gpt-5.5) when activeProvider is anthropic and a routable Codex profile exists', () => {
        const settings = createProviderSettings({
          activeProvider: 'anthropic',
          claude: {
            model: 'claude-opus-4-7',
            thinkingModel: 'gpt-5.5',
          },
          localModel: {
            profiles: [
              {
                id: 'codex-gpt-5.5',
                name: 'GPT-5.5 (ChatGPT Pro)',
                model: 'gpt-5.5',
                providerType: 'openai',
                serverUrl: 'https://api.openai.com/v1',
                createdAt: 0,
              },
            ],
            activeProfileId: null,
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingModel).toBe('gpt-5.5');
      });

      // Phase-6 refinement (GPT-5.5 F1): a supported Codex catalog ID with NO
      // matching routable profile (e.g. `gpt-5.4`, which has no auto Codex profile)
      // must be CLEARED under a non-Codex active provider. Before Stage 1 it was
      // cleared; Stage 1 over-relaxed to preserve any deny-list-passing catalog ID,
      // which would persist-and-misroute through direct Anthropic. isCodexModelSupported
      // is a support deny-list, not a routing/reachability check.
      it('clears a supported Codex thinkingModel (gpt-5.4) when activeProvider is anthropic and no routable profile exists', () => {
        const settings = createProviderSettings({
          activeProvider: 'anthropic',
          claude: {
            model: 'claude-opus-4-7',
            thinkingModel: 'gpt-5.4',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingModel).toBeUndefined();
      });

      // A distinct Claude thinking model under Anthropic working provider is
      // retained, but moved into the __virtual-thinking profile rather than left
      // as a top-level bare thinkingModel. Asserting it survives (in either form)
      // guards against the validation accidentally rejecting a valid Anthropic ID.
      it('preserves an Anthropic thinkingModel (claude-opus-4-7) when activeProvider is anthropic', () => {
        const settings = createProviderSettings({
          activeProvider: 'anthropic',
          claude: {
            model: 'claude-sonnet-4-6',
            thinkingModel: 'claude-opus-4-7',
          },
        });

        const result = normalizeSettings(settings);

        const virtualThinking = result.localModel?.profiles.find((p) => p.id === '__virtual-thinking');
        expect(result.models?.thinkingProfileId).toBe('__virtual-thinking');
        expect(virtualThinking?.model).toBe('claude-opus-4-7');
      });

      it('clears an unknown bare thinkingModel when activeProvider is anthropic', () => {
        const settings = createProviderSettings({
          activeProvider: 'anthropic',
          claude: {
            model: 'claude-opus-4-7',
            thinkingModel: 'gpt-9000',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingModel).toBeUndefined();
      });

      it('clears a deny-listed Codex thinkingModel (gpt-5.5-pro) when activeProvider is anthropic', () => {
        const settings = createProviderSettings({
          activeProvider: 'anthropic',
          claude: {
            model: 'claude-opus-4-7',
            thinkingModel: 'gpt-5.5-pro',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingModel).toBeUndefined();
      });

      it('does NOT coerce BTS to minimax when OpenRouter is active', () => {
        const settings = createProviderSettings({
          activeProvider: 'openrouter',
          openRouter: {
            enabled: true,
            oauthToken: 'or-token',
            selectedModel: 'openai/gpt-5.5',
          },
          behindTheScenesModel: 'claude-haiku-4-5',
        });

        const result = normalizeSettings(settings);

        expect(result.behindTheScenesModel).toBe('claude-haiku-4-5');
      });

      it('disables OpenRouter when Anthropic is active even if OpenRouter.enabled was true', () => {
        const settings = createProviderSettings({
          activeProvider: 'anthropic',
          openRouter: {
            enabled: true,
            oauthToken: 'or-token',
            selectedModel: 'openai/gpt-5.5',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.openRouter?.enabled).toBe(false);
      });

      it('enables OpenRouter when it is active and an OAuth token exists', () => {
        const settings = createProviderSettings({
          activeProvider: 'openrouter',
          openRouter: {
            enabled: false,
            oauthToken: 'or-token',
            selectedModel: 'openai/gpt-5.5',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.openRouter?.enabled).toBe(true);
      });

      it('disables OpenRouter when it is active but the OAuth token is missing', () => {
        const settings = createProviderSettings({
          activeProvider: 'openrouter',
          openRouter: {
            enabled: true,
            oauthToken: null,
            selectedModel: 'openai/gpt-5.5',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.openRouter?.enabled).toBe(false);
      });

      it('preserves legacy auto-derive when activeProvider is undefined and OpenRouter is already enabled', () => {
        const settings = createProviderSettings({
          openRouter: {
            enabled: true,
            oauthToken: 'or-token',
            selectedModel: 'openai/gpt-5.5',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.activeProvider).toBe('openrouter');
        expect(result.openRouter?.enabled).toBe(true);
      });

      // Stage 0 characterization (multi-provider foundation, seam 7): pin the
      // FULL `activeProvider` derivation table in `normalizeSettings`
      // (settingsUtils.ts:~1295). Existing tests only pinned the legacy
      // auto-derive→'openrouter' output (above). The Stage 1–2 restructure must
      // preserve every leg: explicit passthroughs, the legacy auto-derive, and
      // the fresh-user → undefined default. Asserts CURRENT behaviour.
      describe('activeProvider derivation table — Stage 0 characterization', () => {
        it('explicit "codex" passes through unchanged', () => {
          const result = normalizeSettings(createProviderSettings({ activeProvider: 'codex' }));
          expect(result.activeProvider).toBe('codex');
        });

        it('explicit "mindstone" passes through unchanged', () => {
          const result = normalizeSettings(createProviderSettings({ activeProvider: 'mindstone' }));
          expect(result.activeProvider).toBe('mindstone');
        });

        it('explicit "anthropic" passes through unchanged', () => {
          const result = normalizeSettings(createProviderSettings({ activeProvider: 'anthropic' }));
          expect(result.activeProvider).toBe('anthropic');
        });

        it('explicit "openrouter" passes through unchanged (with a token)', () => {
          const result = normalizeSettings(createProviderSettings({
            activeProvider: 'openrouter',
            openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'openai/gpt-5.5' },
          }));
          expect(result.activeProvider).toBe('openrouter');
        });

        it('explicit "openrouter" WITHOUT a token still passes through as "openrouter" (explicit passthrough precedes the token check; only enabled is recomputed false)', () => {
          // F4 from GPT review: the explicit passthrough (settingsUtils.ts:1295-1308)
          // happens BEFORE the token-driven enabled recompute. So a misconfigured
          // tokenless explicit OpenRouter user keeps activeProvider 'openrouter'
          // even though openRouter.enabled is forced false.
          const result = normalizeSettings(createProviderSettings({
            activeProvider: 'openrouter',
            openRouter: { enabled: true, oauthToken: null, selectedModel: 'openai/gpt-5.5' },
          }));
          expect(result.activeProvider).toBe('openrouter');
          expect(result.openRouter?.enabled).toBe(false);
        });

        it('fresh user (undefined + no OpenRouter credentials) stays undefined — no pre-selection for onboarding', () => {
          const result = normalizeSettings(createProviderSettings({ activeProvider: undefined }));
          expect(result.activeProvider).toBeUndefined();
        });

        it('undefined + OpenRouter enabled but NO oauth token stays undefined (auto-derive requires a token)', () => {
          const result = normalizeSettings(createProviderSettings({
            activeProvider: undefined,
            openRouter: { enabled: true, oauthToken: null, selectedModel: 'openai/gpt-5.5' },
          }));
          expect(result.activeProvider).toBeUndefined();
        });

        it('undefined + OpenRouter oauth token present but NOT enabled stays undefined (auto-derive requires enabled)', () => {
          const result = normalizeSettings(createProviderSettings({
            activeProvider: undefined,
            openRouter: { enabled: false, oauthToken: 'or-token', selectedModel: 'openai/gpt-5.5' },
          }));
          expect(result.activeProvider).toBeUndefined();
        });
      });

      describe('Mindstone BTS preservation', () => {
        it('preserves slash-form BTS for Mindstone managed mode without an OpenRouter token', () => {
          const result = normalizeSettings(createProviderSettings({
            activeProvider: 'mindstone',
            behindTheScenesModel: 'deepseek/deepseek-v4-flash',
            openRouter: undefined,
          }));

          expect(result.behindTheScenesModel).toBe('deepseek/deepseek-v4-flash');
        });

        it('preserves slash-form BTS for Mindstone when an OpenRouter token is also present', () => {
          const result = normalizeSettings(createProviderSettings({
            activeProvider: 'mindstone',
            behindTheScenesModel: 'deepseek/deepseek-v4-flash',
            openRouter: {
              enabled: true,
              oauthToken: 'fake',
              selectedModel: 'deepseek/deepseek-v4-flash',
            },
          }));

          expect(result.behindTheScenesModel).toBe('deepseek/deepseek-v4-flash');
        });

        it('still strips slash-form BTS for non-Mindstone providers without an OpenRouter token', () => {
          const result = normalizeSettings(createProviderSettings({
            activeProvider: 'anthropic',
            behindTheScenesModel: 'deepseek/deepseek-v4-flash',
            openRouter: undefined,
          }));

          expect(result.behindTheScenesModel).toBeUndefined();
        });

        it('preserves bare BTS for Mindstone managed mode without an OpenRouter token', () => {
          const result = normalizeSettings(createProviderSettings({
            activeProvider: 'mindstone',
            behindTheScenesModel: 'claude-opus-4-7',
            openRouter: undefined,
          }));

          expect(result.behindTheScenesModel).toBe('claude-opus-4-7');
        });

        it('does not synthesize BTS for Mindstone managed mode when none is configured', () => {
          const result = normalizeSettings(createProviderSettings({
            activeProvider: 'mindstone',
            behindTheScenesModel: undefined,
            openRouter: undefined,
          }));

          expect(result.behindTheScenesModel).toBeUndefined();
        });
      });

      it('preserves slash-form BTS overrides for mindstone without a personal OpenRouter token', () => {
        const settings = createProviderSettings({
          activeProvider: 'mindstone',
          behindTheScenesOverrides: {
            search: 'openai/gpt-5.5',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.behindTheScenesOverrides).toEqual({ search: 'openai/gpt-5.5' });
      });

      it('preserves slash-form BTS model for mindstone without a personal OpenRouter token', () => {
        const settings = createProviderSettings({
          activeProvider: 'mindstone',
          behindTheScenesModel: 'deepseek/deepseek-v4-flash',
        });

        const result = normalizeSettings(settings);

        expect(result.behindTheScenesModel).toBe('deepseek/deepseek-v4-flash');
      });

      it('preserves slash-form fallback fields for mindstone without a personal OpenRouter token', () => {
        const settings = createProviderSettings({
          activeProvider: 'mindstone',
          claude: {
            thinkingFallback: 'model:openai/gpt-5.5',
            workingFallback: 'model:openai/gpt-5.5',
          },
          backgroundFallback: 'model:openai/gpt-5.5',
          localInferenceCloudFallback: 'model:openai/gpt-5.5',
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingFallback).toBe('model:openai/gpt-5.5');
        expect(result.models?.workingFallback).toBe('model:openai/gpt-5.5');
        expect(result.backgroundFallback).toBe('model:openai/gpt-5.5');
        expect(result.localInferenceCloudFallback).toBe('model:openai/gpt-5.5');
      });

      it.each<AppSettings['activeProvider']>(['anthropic', 'codex', undefined])(
        'clears slash-form BTS model and overrides when activeProvider is %s without a personal OpenRouter token',
        (activeProvider) => {
          const settings = createProviderSettings({
            activeProvider,
            behindTheScenesModel: 'deepseek/deepseek-v4-flash',
            behindTheScenesOverrides: {
              search: 'openai/gpt-5.5',
            },
          });

          const result = normalizeSettings(settings);

          expect(result.behindTheScenesModel).toBeUndefined();
          expect(result.behindTheScenesOverrides).toBeUndefined();
        },
      );

      it.each<AppSettings['activeProvider']>(['anthropic', 'codex', undefined])(
        'clears slash-form fallback fields when activeProvider is %s without a personal OpenRouter token',
        (activeProvider) => {
          const settings = createProviderSettings({
            activeProvider,
            claude: {
              thinkingFallback: 'model:openai/gpt-5.5',
              workingFallback: 'model:openai/gpt-5.5',
            },
            backgroundFallback: 'model:openai/gpt-5.5',
            localInferenceCloudFallback: 'model:openai/gpt-5.5',
          });

          const result = normalizeSettings(settings);

          expect(result.models?.thinkingFallback).toBeUndefined();
          expect(result.models?.workingFallback).toBeUndefined();
          expect(result.backgroundFallback).toBeUndefined();
          expect(result.localInferenceCloudFallback).toBeUndefined();
        },
      );

      it('clears an OpenRouter fallback when no OpenRouter token remains', () => {
        const settings = createProviderSettings({
          claude: {
            thinkingFallback: 'model:openai/gpt-5.5',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingFallback).toBeUndefined();
      });

      it('clears an Anthropic fallback when neither an Anthropic key nor OpenRouter token exists', () => {
        const settings = createProviderSettings({
          claude: {
            workingFallback: 'model:claude-opus-4-7',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.workingFallback).toBeUndefined();
      });

      it('clears an OpenAI fallback when neither an OpenAI key nor OpenRouter token exists', () => {
        const settings = createProviderSettings({
          backgroundFallback: 'model:gpt-5.5',
        });

        const result = normalizeSettings(settings);

        expect(result.backgroundFallback).toBeUndefined();
      });

      it('preserves fallbacks when credentials still exist', () => {
        const settings = createProviderSettings({
          providerKeys: { openai: 'fake-openai' },
          openRouter: {
            enabled: false,
            oauthToken: 'or-token',
            selectedModel: 'openai/gpt-5.5',
          },
          claude: {
            apiKey: 'fake-anthropic',
            thinkingFallback: 'model:openai/gpt-5.5',
            workingFallback: 'model:claude-opus-4-7',
            longContextFallbackModel: 'claude-opus-4-7',
            longContextFallbackProfileId: 'prof_gpt',
          },
          localModel: {
            profiles: [openAiProfile],
            activeProfileId: null,
          },
          behindTheScenesOverrides: {
            search: 'openai/gpt-5.5',
          },
        });

        const result = normalizeSettings(settings);

        expect(result.models?.thinkingFallback).toBe('model:openai/gpt-5.5');
        expect(result.models?.workingFallback).toBe('model:claude-opus-4-7');
        expect(result.models?.longContextFallbackModel).toBe('claude-opus-4-7');
        expect(result.models?.longContextFallbackProfileId).toBe('prof_gpt');
        expect(result.behindTheScenesOverrides).toEqual({ search: 'openai/gpt-5.5' });
      });
    });

    describe('planMode and extendedContext defaults', () => {
      const createSettingsWithUndefinedClaude = (claudeOverrides: Partial<AppSettings['claude']> = {}): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: null,
            permissionMode: 'bypassPermissions',
            executablePath: null,
            thinkingEffort: 'high',
            ...claudeOverrides,
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
          },
        }) as unknown as AppSettings;

      it('should default planMode to false when undefined', () => {
        const settings = createSettingsWithUndefinedClaude({ planMode: undefined });
        const result = normalizeSettings(settings);
        expect(result.models?.planMode).toBe(false);
      });

      it('should default extendedContext to true when undefined and using api-key', () => {
        const settings = createSettingsWithUndefinedClaude({ extendedContext: undefined, authMethod: 'api-key' });
        const result = normalizeSettings(settings);
        expect(result.models?.extendedContext).toBe(true);
      });

      it('should default extendedContext to true when undefined and using oauth-token', () => {
        const settings = createSettingsWithUndefinedClaude({ extendedContext: undefined, authMethod: 'oauth-token' });
        const result = normalizeSettings(settings);
        expect(result.models?.extendedContext).toBe(true);
      });

      it('should preserve explicit false for planMode', () => {
        const settings = createSettingsWithUndefinedClaude({ planMode: false });
        const result = normalizeSettings(settings);
        expect(result.models?.planMode).toBe(false);
      });

      it('should normalize explicit false for extendedContext to true', () => {
        const settings = createSettingsWithUndefinedClaude({ extendedContext: false });
        const result = normalizeSettings(settings);
        expect(result.models?.extendedContext).toBe(true);
      });

      it('should normalize explicit planMode true through the virtual thinking profile migration', () => {
        const settings = createSettingsWithUndefinedClaude({ planMode: true, extendedContext: true });
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingProfileId).toBe('__virtual-thinking');
        expect(result.models?.planMode).toBe(false);
        expect(result.models?.extendedContext).toBe(true);
      });
    });

    describe('thinkingModel migration', () => {
      const createSettingsForMigration = (claudeOverrides: Partial<AppSettings['claude']> = {}): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
            ...claudeOverrides,
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
          },
        }) as unknown as AppSettings;

      const expectVirtualThinkingProfile = (result: AppSettings, expectedModel: string) => {
        const profile = result.localModel?.profiles.find((p) => p.id === '__virtual-thinking');
        expect(result.models?.thinkingProfileId).toBe('__virtual-thinking');
        expect(result.models?.thinkingModel).toBeUndefined();
        expect(profile).toMatchObject({
          id: '__virtual-thinking',
          name: 'Claude (Thinking)',
          model: expectedModel,
          providerType: 'anthropic',
          serverUrl: '',
          enabled: true,
          isVirtual: true,
        });
        expect(typeof profile?.createdAt).toBe('number');
      };

      it('should migrate planMode:true to a virtual thinking profile', () => {
        const settings = createSettingsForMigration({ planMode: true, model: 'claude-sonnet-4-6' });
        const result = normalizeSettings(settings);
        expectVirtualThinkingProfile(result, PREFERRED_PLANNING_MODEL);
      });

      it('should normalize working model to Sonnet when planMode was true with Opus model', () => {
        const settings = createSettingsForMigration({ planMode: true, model: PREFERRED_PLANNING_MODEL });
        const result = normalizeSettings(settings);
        expectVirtualThinkingProfile(result, PREFERRED_PLANNING_MODEL);
        expect(result.models?.model).toBe(DEFAULT_MODEL);
      });

      it('should not set thinkingModel when planMode is false', () => {
        const settings = createSettingsForMigration({ planMode: false });
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingModel).toBeUndefined();
        expect(result.models?.planMode).toBe(false);
      });

      it('should not double-migrate when thinkingModel is already set', () => {
        const settings = createSettingsForMigration({
          planMode: true,
          thinkingModel: 'claude-opus-4-7',
          model: 'claude-sonnet-4-6',
        });
        const result = normalizeSettings(settings);
        expectVirtualThinkingProfile(result, 'claude-opus-4-7');
        expect(result.models?.model).toBe('claude-sonnet-4-6');
      });

      it('should normalize OR-format working model to SDK format when not on OpenRouter', () => {
        const settings = createSettingsForMigration({
          model: 'anthropic/claude-opus-4.7',
        });
        settings.activeProvider = 'anthropic';
        const result = normalizeSettings(settings);
        expect(result.models?.model).toBe('claude-opus-4-7');
      });

      it('should normalize OR-format working model when activeProvider is undefined and no OR credentials', () => {
        const settings = createSettingsForMigration({
          model: 'anthropic/claude-opus-4.7',
        });
        settings.activeProvider = undefined;
        // No OR credentials — genuine legacy Anthropic user
        const result = normalizeSettings(settings);
        expect(result.models?.model).toBe('claude-opus-4-7');
      });

      it('should preserve OR-format working model when activeProvider is undefined but OR credentials exist', () => {
        const settings = createSettingsForMigration({
          model: 'openai/gpt-5.5',
        });
        settings.activeProvider = undefined;
        settings.openRouter = {
          enabled: true,
          oauthToken: 'or-token',
          selectedModel: 'openai/gpt-5.5',
        };
        const result = normalizeSettings(settings);
        // OR credentials present → user is effectively on OpenRouter → preserve OR-format
        expect(result.models?.model).toBe('openai/gpt-5.5');
      });

      // Stage 2 of docs/plans/260428_kw_eval_infra_and_model_registry.md:
      // symmetric registry-aware check for claude.model on the OR provider.
      // Pre-Stage-2, claude.model on the OR provider had NO catalog check —
      // any OR-format string was passed through, which is how DeepSeek-V4
      // (missing from OR_MODEL_MAP) silently broke evals.
      it('Stage 2: should preserve a valid OR-format working model on OR provider (DeepSeek V4 Pro)', () => {
        const settings = createSettingsForMigration({
          model: 'deepseek/deepseek-v4-pro',
        });
        settings.activeProvider = 'openrouter';
        const result = normalizeSettings(settings);
        expect(result.models?.model).toBe('deepseek/deepseek-v4-pro');
      });

      it('Stage 2: should reset an unknown OR-format working model to OR_DEFAULT_WORKING_MODEL on OR provider', () => {
        const settings = createSettingsForMigration({
          model: 'bogus/some-model-not-in-catalog',
        });
        settings.activeProvider = 'openrouter';
        const result = normalizeSettings(settings);
        expect(result.models?.model).toBe(OR_DEFAULT_WORKING_MODEL);
      });

      it('Stage 2: should preserve a newly-added catalog OR working model without a code change here (DeepSeek V4 Flash)', () => {
        // This test enforces the "add once, available everywhere" goal: a
        // model that is in MODEL_CATALOG with provider:'openrouter' and a
        // populated openRouter block must validate without any per-model
        // code in this file.
        const settings = createSettingsForMigration({
          model: 'deepseek/deepseek-v4-flash',
        });
        settings.activeProvider = 'openrouter';
        const result = normalizeSettings(settings);
        expect(result.models?.model).toBe('deepseek/deepseek-v4-flash');
      });

      // Profile-backed exception: a slashed model ID that matches a local
      // profile is a custom-provider model (Together, Cerebras, custom
      // OpenAI-compatible endpoints), not an OR-format leak. Without this
      // exception, normalizeSettings used to drop the slashed working/thinking
      // model and silently fall back to DEFAULT_MODEL — which broke the
      // first end-to-end Together eval attempt (260429 spike).
      it('should preserve a slashed working model when a matching local profile exists (Together pattern)', () => {
        const settings = createSettingsForMigration({
          model: 'deepseek-ai/DeepSeek-V4-Pro',
        });
        // anthropic provider, NO OR credentials — i.e. NOT effectively-OR
        settings.activeProvider = 'anthropic';
        settings.localModel = {
          ...(settings.localModel ?? {}),
          activeProfileId: settings.localModel?.activeProfileId ?? null,
          profiles: [{
            id: 'together-deepseek',
            name: 'DeepSeek V4 Pro (Together)',
            providerType: 'together',
            serverUrl: 'https://api.together.xyz/v1',
            model: 'deepseek-ai/DeepSeek-V4-Pro',
            apiKey: 'tgp_test',
            createdAt: 1,
            enabled: true,
           
          } as any],
        };
        const result = normalizeSettings(settings);
        expect(result.models?.model).toBe('deepseek-ai/DeepSeek-V4-Pro');
      });

      it('should still drop a slashed working model when NO matching local profile exists', () => {
        // Regression guard for the profile-backed exception: a slashed model
        // with no profile match must still fall back to DEFAULT_MODEL on the
        // anthropic provider (the original FOX-3096 protection).
        const settings = createSettingsForMigration({
          model: 'someorg/some-unrelated-model',
        });
        settings.activeProvider = 'anthropic';
        settings.localModel = { profiles: [], activeProfileId: null };
        const result = normalizeSettings(settings);
        expect(result.models?.model).toBe(DEFAULT_MODEL);
      });

      it('should preserve a slashed thinking model when a matching local profile exists (Together pattern)', () => {
        const settings = createSettingsForMigration({
          model: 'deepseek-ai/DeepSeek-V4-Pro',
          thinkingModel: 'deepseek-ai/DeepSeek-V4-Pro',
        });
        settings.activeProvider = 'anthropic';
        settings.localModel = {
          ...(settings.localModel ?? {}),
          activeProfileId: settings.localModel?.activeProfileId ?? null,
          profiles: [{
            id: 'together-deepseek',
            name: 'DeepSeek V4 Pro (Together)',
            providerType: 'together',
            serverUrl: 'https://api.together.xyz/v1',
            model: 'deepseek-ai/DeepSeek-V4-Pro',
            apiKey: 'tgp_test',
            createdAt: 1,
            enabled: true,
           
          } as any],
        };
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingModel).toBe('deepseek-ai/DeepSeek-V4-Pro');
      });

      it('should reset invalid thinkingModel to undefined', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'invalid-model-name',
          model: 'claude-sonnet-4-6',
        });
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingModel).toBeUndefined();
        expect(result.models?.planMode).toBe(false);
      });

      it('should normalize OR-format Anthropic thinkingModel when provider is not OpenRouter', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'anthropic/claude-opus-4-6',
          model: 'claude-sonnet-4-6',
        });
        settings.activeProvider = 'anthropic';
        settings.openRouter = {
          enabled: true,
          oauthToken: 'or-token',
          selectedModel: 'openai/gpt-5.5',
        };

        const result = normalizeSettings(settings);
        expectVirtualThinkingProfile(result, 'claude-opus-4-6');
      });

      it('should convert valid non-OR thinkingModel to a virtual profile', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'claude-opus-4-7',
          model: 'claude-sonnet-4-6',
        });
        const result = normalizeSettings(settings);
        expectVirtualThinkingProfile(result, 'claude-opus-4-7');
      });

      it('should preserve valid OR thinkingModel for OpenRouter models', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'openai/gpt-5.5',
          model: 'claude-sonnet-4-6',
        });
        settings.activeProvider = 'openrouter';
        settings.openRouter = {
          enabled: true,
          oauthToken: 'or-token',
          selectedModel: 'openai/gpt-5.5',
        };

        const result = normalizeSettings(settings);
        expect(result.models?.thinkingModel).toBe('openai/gpt-5.5');
      });

      it('should normalize OR-format Anthropic thinkingModel for Opus 4.7', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'anthropic/claude-opus-4-7',
          model: 'claude-sonnet-4-6',
        });
        settings.activeProvider = 'anthropic';
        settings.openRouter = {
          enabled: true,
          oauthToken: 'or-token',
          selectedModel: 'openai/gpt-5.5',
        };

        const result = normalizeSettings(settings);
        expectVirtualThinkingProfile(result, 'claude-opus-4-7');
      });

      it('should normalize OR-format thinkingModel when activeProvider is undefined and no OR credentials (legacy Anthropic)', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'anthropic/claude-opus-4.7',
          model: 'claude-sonnet-4-6',
        });
        settings.activeProvider = undefined;
        // No OR credentials — genuine legacy Anthropic user
        const result = normalizeSettings(settings);
        expectVirtualThinkingProfile(result, 'claude-opus-4-7');
      });

      it('should preserve OR-format thinkingModel when activeProvider is undefined but OR credentials exist (legacy OR)', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'anthropic/claude-opus-4-7',
          model: 'claude-sonnet-4-6',
        });
        settings.activeProvider = undefined;
        settings.openRouter = {
          enabled: true,
          oauthToken: 'or-token',
          selectedModel: 'openai/gpt-5.5',
        };
        const result = normalizeSettings(settings);
        // OR credentials present → user is effectively on OpenRouter → preserve OR-format
        expect(result.models?.thinkingModel).toBe('anthropic/claude-opus-4-7');
      });

      it('should preserve OR-format Anthropic thinkingModel for OpenRouter-only users', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'anthropic/claude-opus-4-6',
          model: 'openai/gpt-5.5',
        });
        settings.activeProvider = 'openrouter';
        settings.openRouter = {
          enabled: true,
          oauthToken: 'or-token',
          selectedModel: 'openai/gpt-5.5',
        };

        const result = normalizeSettings(settings);
        expect(result.models?.thinkingModel).toBe('anthropic/claude-opus-4-6');
      });

      it('should migrate deprecated thinkingModel to successor', () => {
        const settings = createSettingsForMigration({
          thinkingModel: 'claude-opus-4-5',
          model: 'claude-sonnet-4-6',
        });
        const result = normalizeSettings(settings);
        expectVirtualThinkingProfile(result, 'claude-opus-4-8');
      });

      it('should derive planMode as false when thinkingModel equals working model', () => {
        const settings = createSettingsForMigration({
          thinkingModel: PREFERRED_PLANNING_MODEL,
          model: PREFERRED_PLANNING_MODEL,
        });
        const result = normalizeSettings(settings);
        expect(result.models?.planMode).toBe(false);
      });
    });

    describe('thinkingProfileId / workingProfileId migration', () => {
      const testProfile = {
        id: 'prof_gpt',
        name: 'OpenAI GPT-5.2',
        providerType: 'openai' as const,
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.2',
        apiKey: 'fake-test',
        createdAt: 1,
      };
      const localProfile = {
        id: 'local-qwen',
        name: 'Local Qwen',
        providerType: 'local' as const,
        serverUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen3.5:9b',
        createdAt: 2,
      };

      const createSettingsWithProfiles = (overrides: {
        claude?: Partial<AppSettings['claude']>;
        localModel?: Partial<AppSettings['localModel']>;
        experimental?: Partial<NonNullable<AppSettings['experimental']>>;
        providerKeys?: AppSettings['providerKeys'];
        localInferenceCloudFallback?: string;
      } = {}): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
            ...overrides.claude,
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
          },
          localModel: {
            profiles: [testProfile],
            activeProfileId: null,
            ...overrides.localModel,
          },
          ...(overrides.experimental !== undefined ? { experimental: overrides.experimental } : {}),
          ...(overrides.providerKeys !== undefined ? { providerKeys: overrides.providerKeys } : {}),
          ...(overrides.localInferenceCloudFallback !== undefined
            ? { localInferenceCloudFallback: overrides.localInferenceCloudFallback }
            : {}),
        }) as unknown as AppSettings;

      it('should migrate activeProfileId to workingProfileId when workingProfileId is absent', () => {
        const settings = createSettingsWithProfiles({
          localModel: { profiles: [testProfile], activeProfileId: 'prof_gpt' },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.workingProfileId).toBe('prof_gpt');
      });

      it('should keep activeProfileId intact during migration', () => {
        const settings = createSettingsWithProfiles({
          localModel: { profiles: [testProfile], activeProfileId: 'prof_gpt' },
        });
        const result = normalizeSettings(settings);
        expect(result.localModel?.activeProfileId).toBe('prof_gpt');
      });

      it('should clear thinkingModel when thinkingProfileId is set', () => {
        const settings = createSettingsWithProfiles({
          claude: { thinkingProfileId: 'prof_gpt', thinkingModel: PREFERRED_PLANNING_MODEL },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingModel).toBeUndefined();
        expect(result.models?.thinkingProfileId).toBe('prof_gpt');
      });

      it('creates an idempotent virtual thinking profile from a bare Claude thinking model', () => {
        const settings = createSettingsWithProfiles({
          claude: { thinkingModel: 'claude-opus-4-7' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });

        const result = normalizeSettings(settings);
        const profile = result.localModel?.profiles.find((p) => p.id === '__virtual-thinking');

        expect(result.models?.thinkingProfileId).toBe('__virtual-thinking');
        expect(result.models?.thinkingModel).toBeUndefined();
        expect(profile).toMatchObject({
          id: '__virtual-thinking',
          name: 'Claude (Thinking)',
          model: 'claude-opus-4-7',
          providerType: 'anthropic',
          serverUrl: '',
          enabled: true,
          isVirtual: true,
        });
        expect(typeof profile?.createdAt).toBe('number');
        expect(normalizeSettings(result)).toEqual(result);
      });

      it('updates an existing virtual thinking profile model without changing its stable id', () => {
        const settings = createSettingsWithProfiles({
          claude: { thinkingModel: 'claude-opus-4-7' },
          localModel: {
            profiles: [
              testProfile,
              {
                id: '__virtual-thinking',
                name: 'Claude (Thinking)',
                model: 'claude-sonnet-4-6',
                providerType: 'anthropic',
                serverUrl: '',
                enabled: true,
                isVirtual: true,
                createdAt: 123,
              },
            ],
            activeProfileId: null,
          },
        });

        const result = normalizeSettings(settings);
        const profile = result.localModel?.profiles.find((p) => p.id === '__virtual-thinking');

        expect(result.models?.thinkingProfileId).toBe('__virtual-thinking');
        expect(profile?.model).toBe('claude-opus-4-7');
        expect(profile?.createdAt).toBe(123);
      });

      it('creates a virtual working profile for a bare Claude working model under a non-Anthropic provider', () => {
        const settings = createSettingsWithProfiles({
          claude: { model: 'claude-opus-4-7' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        settings.activeProvider = 'codex';

        const result = normalizeSettings(settings);
        const profile = result.localModel?.profiles.find((p) => p.id === '__virtual-working');

        expect(result.models?.workingProfileId).toBe('__virtual-working');
        expect(profile).toMatchObject({
          id: '__virtual-working',
          name: 'Claude (Working)',
          model: 'claude-opus-4-7',
          providerType: 'anthropic',
          serverUrl: '',
          enabled: true,
          isVirtual: true,
        });
        expect(normalizeSettings(result)).toEqual(result);
      });

      it('does not create a virtual working profile for direct Anthropic', () => {
        const settings = createSettingsWithProfiles({
          claude: { model: 'claude-opus-4-7' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        settings.activeProvider = 'anthropic';

        const result = normalizeSettings(settings);

        expect(result.models?.workingProfileId).toBeUndefined();
        expect(result.localModel?.profiles.some((p) => p.id === '__virtual-working')).toBe(false);
      });

      it('should reset stale thinkingProfileId when profile is deleted', () => {
        const settings = createSettingsWithProfiles({
          claude: { thinkingProfileId: 'deleted_profile_id' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingProfileId).toBeUndefined();
      });

      it('should reset stale workingProfileId when profile is deleted', () => {
        const settings = createSettingsWithProfiles({
          claude: { workingProfileId: 'deleted_profile_id' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.workingProfileId).toBeUndefined();
      });

      it('should reset stale longContextFallbackProfileId when profile is deleted', () => {
        const settings = createSettingsWithProfiles({
          claude: { longContextFallbackProfileId: 'deleted_profile_id' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.longContextFallbackProfileId).toBeUndefined();
      });

      it('should reset stale thinkingFallback profile references when profile is deleted', () => {
        const settings = createSettingsWithProfiles({
          claude: { thinkingFallback: 'profile:deleted_profile_id' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingFallback).toBeUndefined();
      });

      it('should reset stale workingFallback profile references when profile is deleted', () => {
        const settings = createSettingsWithProfiles({
          claude: { workingFallback: 'profile:deleted_profile_id' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.workingFallback).toBeUndefined();
      });

      it('should reset stale backgroundFallback profile references when profile is deleted', () => {
        const settings = createSettingsWithProfiles({
          localModel: { profiles: [testProfile], activeProfileId: null },
          claude: {},
        });
        settings.backgroundFallback = 'profile:deleted_profile_id';
        const result = normalizeSettings(settings);
        expect(result.backgroundFallback).toBeUndefined();
      });

      it('should clear empty longContextFallbackModel to undefined', () => {
        const settings = createSettingsWithProfiles({
          claude: { longContextFallbackModel: '  ' },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.longContextFallbackModel).toBeUndefined();
      });

      it('should preserve long-context fallback settings when valid', () => {
        const settings = createSettingsWithProfiles({
          claude: {
            apiKey: 'fake-anthropic',
            longContextFallbackModel: 'claude-opus-4-6',
            longContextFallbackProfileId: 'prof_gpt',
          },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        settings.providerKeys = { openai: 'fake-openai' };
        const result = normalizeSettings(settings);
        expect(result.models?.longContextFallbackModel).toBe('claude-opus-4-6');
        expect(result.models?.longContextFallbackProfileId).toBe('prof_gpt');
      });

      it('does not registry-stamp profile contextWindow values (Stage 2a)', () => {
        // Stage 2 (260503_unify_learned_limits_into_profiles.md) stopped
        // stamping known context windows during normalization. The
        // resolveModelLimits cascade now reads the registry at call time, so
        // the stored profile must NOT carry a registry-derived value (otherwise
        // the source guard cannot tell registry-derived values apart from
        // user overrides).
        const settings = createSettingsWithProfiles({
          localModel: {
            profiles: [
              {
                id: 'known-claude',
                name: 'Known Claude',
                providerType: 'anthropic',
                serverUrl: '',
                model: 'claude-opus-4-7',
                createdAt: 1,
              },
              {
                id: 'unknown-model',
                name: 'Unknown Model',
                providerType: 'other',
                serverUrl: 'https://example.test',
                model: 'not-in-the-catalog',
                createdAt: 2,
              },
            ],
            activeProfileId: null,
          },
        });

        const result = normalizeSettings(settings);
        expect(result.localModel?.profiles.find((profile) => profile.id === 'known-claude')).not.toHaveProperty('contextWindow');
        expect(result.localModel?.profiles.find((profile) => profile.id === 'unknown-model')).not.toHaveProperty('contextWindow');
      });

      it('should preserve configured model and profile tier fallbacks when valid', () => {
        const settings = createSettingsWithProfiles({
          claude: {
            apiKey: 'fake-anthropic',
            thinkingFallback: 'model:claude-sonnet-4-6',
            workingFallback: 'profile:prof_gpt',
          },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        settings.providerKeys = { openai: 'fake-openai' };
        settings.backgroundFallback = 'model:claude-haiku-4-5';
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingFallback).toBe('model:claude-sonnet-4-6');
        expect(result.models?.workingFallback).toBe('profile:prof_gpt');
        expect(result.backgroundFallback).toBe('model:claude-haiku-4-5');
      });

      it('should migrate deprecated model in tier fallbacks', () => {
        const settings = createSettingsWithProfiles({
          claude: {
            apiKey: 'fake-anthropic',
            thinkingFallback: 'model:claude-opus-4-5',
          },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingFallback).toBe('model:claude-opus-4-8');
      });

      it('should migrate deprecated longContextFallbackModel', () => {
        const settings = createSettingsWithProfiles({
          claude: {
            apiKey: 'fake-anthropic',
            longContextFallbackModel: 'claude-opus-4-5',
          },
          localModel: { profiles: [testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.longContextFallbackModel).toBe('claude-opus-4-8');
      });

      it('should clear thinkingModel to single-model mode when activeProfileId migrates to workingProfileId', () => {
        const settings = createSettingsWithProfiles({
          claude: { thinkingModel: PREFERRED_PLANNING_MODEL },
          localModel: { profiles: [testProfile], activeProfileId: 'prof_gpt' },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.workingProfileId).toBe('prof_gpt');
        expect(result.models?.thinkingModel).toBeUndefined();
      });

      it('should not overwrite existing workingProfileId during activeProfileId migration', () => {
        const secondProfile = { ...testProfile, id: 'prof_gemini', name: 'Google Gemini', model: 'gemini-3-pro' };
        const settings = createSettingsWithProfiles({
          claude: { workingProfileId: 'prof_gemini' },
          localModel: { profiles: [testProfile, secondProfile], activeProfileId: 'prof_gpt' },
        });
        const result = normalizeSettings(settings);
        expect(result.models?.workingProfileId).toBe('prof_gemini');
      });

      it('substitutes a pruned local workingProfileId with localInferenceCloudFallback', () => {
        const settings = createSettingsWithProfiles({
          claude: { workingProfileId: localProfile.id },
          localModel: { profiles: [localProfile, testProfile], activeProfileId: null },
          localInferenceCloudFallback: 'profile:prof_gpt',
        });
        const result = normalizeSettings(settings);
        expect(result.models?.workingProfileId).toBe('prof_gpt');
        expect(result.localInferenceCloudFallback).toBe('profile:prof_gpt');
      });

      it('substitutes a pruned local thinkingProfileId with localInferenceCloudFallback', () => {
        const settings = createSettingsWithProfiles({
          claude: { thinkingProfileId: localProfile.id },
          localModel: { profiles: [localProfile, testProfile], activeProfileId: null },
          localInferenceCloudFallback: 'profile:prof_gpt',
        });
        const result = normalizeSettings(settings);
        expect(result.models?.thinkingProfileId).toBe('prof_gpt');
        expect(result.localInferenceCloudFallback).toBe('profile:prof_gpt');
      });

      it('does not substitute local profiles when localInferenceEnabled is true', () => {
        const settings = createSettingsWithProfiles({
          claude: { workingProfileId: localProfile.id },
          localModel: { profiles: [localProfile, testProfile], activeProfileId: null },
          experimental: { localInferenceEnabled: true },
          localInferenceCloudFallback: 'profile:prof_gpt',
        });
        const result = normalizeSettings(settings);
        expect(result.models?.workingProfileId).toBe(localProfile.id);
        expect(result.localInferenceCloudFallback).toBe('profile:prof_gpt');
      });

      it('clears localInferenceCloudFallback when it points to a deleted profile', () => {
        const settings = createSettingsWithProfiles({
          claude: { workingProfileId: localProfile.id },
          localModel: { profiles: [localProfile, testProfile], activeProfileId: null },
          localInferenceCloudFallback: 'profile:deleted_profile_id',
        });
        const result = normalizeSettings(settings);
        expect(result.localInferenceCloudFallback).toBeUndefined();
        expect(result.models?.workingProfileId).toBeUndefined();
      });

      it('clears localInferenceCloudFallback when it points to another local profile', () => {
        const secondLocalProfile = {
          ...localProfile,
          id: 'local-llama',
          name: 'Local Llama',
          model: 'llama3.2:3b',
          createdAt: 3,
        };
        const settings = createSettingsWithProfiles({
          claude: { workingProfileId: localProfile.id },
          localModel: { profiles: [localProfile, secondLocalProfile, testProfile], activeProfileId: null },
          experimental: { localInferenceEnabled: true },
          localInferenceCloudFallback: 'profile:local-llama',
        });
        const result = normalizeSettings(settings);
        expect(result.localInferenceCloudFallback).toBeUndefined();
        expect(result.models?.workingProfileId).toBe(localProfile.id);
      });

      it.each([
        {
          label: 'working surface + providerType other + routeSurface local',
          claude: { workingProfileId: localProfile.id },
          fallbackProfile: {
            ...testProfile,
            id: 'byo-route-local',
            providerType: 'other' as const,
            routeSurface: 'local' as const,
            serverUrl: 'https://api.example.com/v1',
          } as unknown as typeof testProfile,
        },
        {
          label: 'thinking surface + providerType other + routeSurface local',
          claude: { thinkingProfileId: localProfile.id },
          fallbackProfile: {
            ...testProfile,
            id: 'byo-route-local-thinking',
            providerType: 'other' as const,
            routeSurface: 'local' as const,
            serverUrl: 'https://api.example.com/v1',
          } as unknown as typeof testProfile,
        },
        {
          label: 'working surface + providerType other + loopback URL',
          claude: { workingProfileId: localProfile.id },
          fallbackProfile: {
            ...testProfile,
            id: 'byo-loopback-working',
            providerType: 'other' as const,
            routeSurface: undefined,
            serverUrl: 'http://127.0.0.1:8000/v1',
          } as unknown as typeof testProfile,
        },
        {
          label: 'thinking surface + providerType other + loopback URL',
          claude: { thinkingProfileId: localProfile.id },
          fallbackProfile: {
            ...testProfile,
            id: 'byo-loopback-thinking',
            providerType: 'other' as const,
            routeSurface: undefined,
            serverUrl: 'http://localhost:8000/v1',
          } as unknown as typeof testProfile,
        },
      ])('clears localInferenceCloudFallback for loopback-routable BYO profiles (%s)', ({ claude, fallbackProfile }) => {
        const settings = createSettingsWithProfiles({
          claude,
          localModel: { profiles: [localProfile, fallbackProfile, testProfile], activeProfileId: null },
          experimental: { localInferenceEnabled: true },
          localInferenceCloudFallback: `profile:${fallbackProfile.id}`,
        });

        const result = normalizeSettings(settings);
        expect(result.localInferenceCloudFallback).toBeUndefined();
      });

      it('setLocalInferenceCloudFallback rejects loopback-routable fallback profiles', () => {
        const loopbackByoProfile = {
          ...testProfile,
          id: 'byo-loopback',
          providerType: 'other' as const,
          routeSurface: 'local' as const,
          serverUrl: 'http://127.0.0.1:8000/v1',
        } as unknown as typeof testProfile;
        const settings = createSettingsWithProfiles({
          localModel: { profiles: [testProfile, loopbackByoProfile], activeProfileId: null },
        });

        expect(() => setLocalInferenceCloudFallback(settings, 'profile:byo-loopback')).toThrow(
          'cloud-routable profile',
        );
      });

      it('clears localInferenceCloudFallback when fallback credentials are missing', () => {
        const credentiallessProfile = {
          ...testProfile,
          id: 'prof_gpt_no_key',
          name: 'OpenAI GPT-5.2 (No Key)',
          apiKey: undefined,
          createdAt: 4,
        };
        const settings = createSettingsWithProfiles({
          claude: { workingProfileId: localProfile.id },
          localModel: { profiles: [localProfile, credentiallessProfile], activeProfileId: null },
          localInferenceCloudFallback: 'profile:prof_gpt_no_key',
        });
        const result = normalizeSettings(settings);
        expect(result.localInferenceCloudFallback).toBeUndefined();
        expect(result.models?.workingProfileId).toBeUndefined();
      });

      it('preserves existing behavior when no localInferenceCloudFallback is set', () => {
        const settings = createSettingsWithProfiles({
          claude: { workingProfileId: localProfile.id },
          localModel: { profiles: [localProfile, testProfile], activeProfileId: null },
        });
        const result = normalizeSettings(settings);
        expect(result.localInferenceCloudFallback).toBeUndefined();
        expect(result.models?.workingProfileId).toBeUndefined();
      });
    });

    describe('localModel normalization', () => {
      const createMinimalSettings = (): AppSettings =>
        ({
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: null,
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            ttsVoice: 'nova',
            activationHotkey: 'CommandOrControl+Shift+Space',
            activationHotkeyVoiceMode: true,
          },
        }) as unknown as AppSettings;

      it('should populate localModel when missing from input', () => {
        const settings = createMinimalSettings();
        // Ensure localModel is truly undefined
        expect(settings.localModel).toBeUndefined();
        const result = normalizeSettings(settings);
        expect(result.localModel).toEqual({ profiles: [], activeProfileId: null });
      });

      it('should preserve existing localModel when present', () => {
        const settings = {
          ...createMinimalSettings(),
          localModel: {
            profiles: [{ id: 'p1', name: 'Test', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'fake-test', createdAt: 1 }],
            activeProfileId: 'p1',
          },
        } as unknown as AppSettings;
        const result = normalizeSettings(settings);
        expect(result.localModel?.profiles).toHaveLength(1);
        expect(result.localModel?.profiles[0].id).toBe('p1');
        expect(result.localModel?.activeProfileId).toBe('p1');
      });

      it('coerces presetKey local profiles to providerType other and routeSurface local', () => {
        const settings = {
          ...createMinimalSettings(),
          localModel: {
            profiles: [{
              id: 'p-local-preset',
              name: 'Local preset profile',
              providerType: 'local',
              routeSurface: 'api-key',
              serverUrl: 'http://127.0.0.1:8000/v1',
              model: 'deepseek-v4-flash',
              presetKey: 'local:ds4',
              createdAt: 1,
            }],
            activeProfileId: null,
          },
        } as unknown as AppSettings;

        const result = normalizeSettings(settings);
        const profile = result.localModel?.profiles[0] as { providerType?: string; routeSurface?: string };
        expect(profile.providerType).toBe('other');
        expect(profile.routeSurface).toBe('local');
      });

      it('stamps routeSurface local when presetKey local profile omits routeSurface', () => {
        const settings = {
          ...createMinimalSettings(),
          localModel: {
            profiles: [{
              id: 'p-local-stamp',
              name: 'Local preset profile (missing routeSurface)',
              providerType: 'other',
              serverUrl: 'http://localhost:8000/v1',
              model: 'deepseek-v4-flash',
              presetKey: 'local:ds4',
              createdAt: 1,
            }],
            activeProfileId: null,
          },
        } as unknown as AppSettings;

        const result = normalizeSettings(settings);
        const profile = result.localModel?.profiles[0] as { providerType?: string; routeSurface?: string };
        expect(profile.providerType).toBe('other');
        expect(profile.routeSurface).toBe('local');
      });

      it('does not back-fill stored profile contextWindow from the registry (Stage 2a)', () => {
        // The cascade in resolveModelLimits reads the registry at call time;
        // normalizeSettings must not stamp profiles with registry values
        // (otherwise the source guard cannot distinguish them from user
        // overrides). See Finding M / Stage 2a in the planning doc.
        const settings = {
          ...createMinimalSettings(),
          localModel: {
            profiles: [{ id: 'p1', name: 'Test', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'fake-test', createdAt: 1 }],
            activeProfileId: 'p1',
          },
        } as unknown as AppSettings;
        const result = normalizeSettings(settings);
        expect(result.localModel?.profiles[0]).not.toHaveProperty('contextWindow');
      });
    });
  });

  describe('getThinkingProfile', () => {
    const testProfile = {
      id: 'prof_gpt',
      name: 'OpenAI GPT-5.2',
      providerType: 'openai' as const,
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      apiKey: 'fake-test',
      createdAt: 1,
    };

    const createSettings = (overrides: {
      thinkingProfileId?: string;
      profiles?: typeof testProfile[];
    } = {}): AppSettings =>
      ({
        models: {
          thinkingProfileId: overrides.thinkingProfileId,
        },
        localModel: {
          profiles: overrides.profiles ?? [testProfile],
          activeProfileId: null,
        },
      }) as unknown as AppSettings;

    it('should return profile when thinkingProfileId matches', () => {
      const settings = createSettings({ thinkingProfileId: 'prof_gpt' });
      const result = getThinkingProfile(settings);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('prof_gpt');
      expect(result!.model).toBe('gpt-5.2');
    });

    it('should return null when thinkingProfileId is undefined', () => {
      const settings = createSettings({ thinkingProfileId: undefined });
      const result = getThinkingProfile(settings);
      expect(result).toBeNull();
    });

    it('should return null when profile does not exist', () => {
      const settings = createSettings({ thinkingProfileId: 'nonexistent_id' });
      const result = getThinkingProfile(settings);
      expect(result).toBeNull();
    });

    it('should return null when profiles array is empty', () => {
      const settings = createSettings({ thinkingProfileId: 'prof_gpt', profiles: [] });
      const result = getThinkingProfile(settings);
      expect(result).toBeNull();
    });
  });

  describe('getWorkingProfile', () => {
    const testProfile = {
      id: 'prof_deepseek',
      name: 'Together DeepSeek R1',
      providerType: 'together' as const,
      serverUrl: 'https://api.together.xyz/v1',
      model: 'deepseek-r1',
      apiKey: 'fake-together',
      createdAt: 1,
    };

    const createSettings = (overrides: {
      workingProfileId?: string;
      profiles?: typeof testProfile[];
    } = {}): AppSettings =>
      ({
        models: {
          workingProfileId: overrides.workingProfileId,
        },
        localModel: {
          profiles: overrides.profiles ?? [testProfile],
          activeProfileId: null,
        },
      }) as unknown as AppSettings;

    it('should return profile when workingProfileId matches', () => {
      const settings = createSettings({ workingProfileId: 'prof_deepseek' });
      const result = getWorkingProfile(settings);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('prof_deepseek');
      expect(result!.model).toBe('deepseek-r1');
    });

    it('should return null when workingProfileId is undefined', () => {
      const settings = createSettings({ workingProfileId: undefined });
      const result = getWorkingProfile(settings);
      expect(result).toBeNull();
    });

    it('should return null when profile does not exist', () => {
      const settings = createSettings({ workingProfileId: 'nonexistent_id' });
      const result = getWorkingProfile(settings);
      expect(result).toBeNull();
    });
  });

  describe('getWorkingModelProfile', () => {
    const testProfile = {
      id: 'prof_gpt',
      name: 'OpenAI GPT-5.2',
      providerType: 'openai' as const,
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      apiKey: 'fake-test',
      createdAt: 1,
    };

    const secondProfile = {
      id: 'prof_gemini',
      name: 'Google Gemini',
      providerType: 'google' as const,
      serverUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3-pro',
      apiKey: 'key-test',
      createdAt: 2,
    };

    const createSettings = (overrides: {
      workingProfileId?: string;
      activeProfileId?: string | null;
      profiles?: typeof testProfile[];
    } = {}): Pick<AppSettings, 'models' | 'localModel'> => ({
      models: {
        workingProfileId: overrides.workingProfileId,
      } as AppSettings['models'],
      localModel: {
        profiles: overrides.profiles ?? [testProfile, secondProfile],
        activeProfileId: overrides.activeProfileId ?? null,
      },
    });

    it('should return profile when workingProfileId matches', () => {
      const settings = createSettings({ workingProfileId: 'prof_gpt' });
      const result = getWorkingModelProfile(settings);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('prof_gpt');
    });

    it('should fall back to activeProfileId when workingProfileId is not set', () => {
      const settings = createSettings({ activeProfileId: 'prof_gemini' });
      const result = getWorkingModelProfile(settings);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('prof_gemini');
    });

    it('should prefer workingProfileId over activeProfileId', () => {
      const settings = createSettings({
        workingProfileId: 'prof_gpt',
        activeProfileId: 'prof_gemini',
      });
      const result = getWorkingModelProfile(settings);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('prof_gpt');
    });

    it('should return null when neither workingProfileId nor activeProfileId is set', () => {
      const settings = createSettings({});
      const result = getWorkingModelProfile(settings);
      expect(result).toBeNull();
    });

    it('should return null when workingProfileId references a deleted profile', () => {
      const settings = createSettings({ workingProfileId: 'deleted_id' });
      const result = getWorkingModelProfile(settings);
      expect(result).toBeNull();
    });

    it('should fall back to activeProfileId when workingProfileId references a deleted profile', () => {
      const settings = createSettings({
        workingProfileId: 'deleted_id',
        activeProfileId: 'prof_gpt',
      });
      const result = getWorkingModelProfile(settings);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('prof_gpt');
    });

    it('should return null when profiles array is empty', () => {
      const settings = createSettings({
        workingProfileId: 'prof_gpt',
        profiles: [],
      });
      const result = getWorkingModelProfile(settings);
      expect(result).toBeNull();
    });
  });

  describe('normalizeSettings BTS with workingProfileId', () => {
    const testProfile = {
      id: 'prof_gpt',
      name: 'OpenAI GPT-5.2',
      providerType: 'openai' as const,
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      apiKey: 'fake-test',
      createdAt: 1,
    };

    const createSettingsWithProfile = (overrides: Partial<{
      workingProfileId: string;
      activeProfileId: string | null;
      behindTheScenesModel: string;
    }> = {}): AppSettings =>
      ({
        claude: {
          apiKey: null,
          oauthToken: null,
          authMethod: 'api-key',
          model: 'claude-sonnet-4-6',
          permissionMode: 'bypassPermissions',
          executablePath: null,
          planMode: false,
          extendedContext: true,
          thinkingEffort: 'high',
          workingProfileId: overrides.workingProfileId,
        },
        localModel: {
          profiles: [testProfile],
          activeProfileId: overrides.activeProfileId ?? null,
        },
        behindTheScenesModel: overrides.behindTheScenesModel,
        voice: {
          provider: 'openai-whisper',
          openaiApiKey: null,
          elevenlabsApiKey: null,
          model: 'gpt-4o-transcribe',
          ttsVoice: 'nova',
          activationHotkey: 'CommandOrControl+Shift+Space',
          activationHotkeyVoiceMode: true,
        },
      }) as unknown as AppSettings;

    it('should migrate use-alternative to profile:<workingProfileId> when workingProfileId is set', () => {
      const settings = createSettingsWithProfile({
        workingProfileId: 'prof_gpt',
        behindTheScenesModel: 'use-alternative',
      });
      const result = normalizeSettings(settings);
      expect(result.behindTheScenesModel).toBe('profile:prof_gpt');
    });

    it('should clear stale use-alternative when no working profile is active', () => {
      const settings = createSettingsWithProfile({ behindTheScenesModel: 'use-alternative' });
      const result = normalizeSettings(settings);
      expect(result.behindTheScenesModel).toBeUndefined();
    });

    it('should preserve explicit BTS model even when working profile is active', () => {
      const settings = createSettingsWithProfile({
        workingProfileId: 'prof_gpt',
        behindTheScenesModel: 'claude-haiku-4-20250514',
      });
      const result = normalizeSettings(settings);
      expect(result.behindTheScenesModel).toBe('claude-haiku-4-20250514');
    });

    it('should preserve valid profile:<id> BTS model when profile exists', () => {
      const settings = createSettingsWithProfile({
        workingProfileId: 'prof_gpt',
        behindTheScenesModel: 'profile:prof_gpt',
      });
      const result = normalizeSettings(settings);
      expect(result.behindTheScenesModel).toBe('profile:prof_gpt');
    });

    it('should not auto-default BTS when working profile is set but BTS is unset', () => {
      const settings = createSettingsWithProfile({ workingProfileId: 'prof_gpt' });
      const result = normalizeSettings(settings);
      expect(result.behindTheScenesModel).toBeUndefined();
    });
  });

  describe('normalizeSettings activeProfileId → workingProfileId bridge', () => {
    const testProfile = {
      id: 'prof_gpt',
      name: 'OpenAI GPT-5.2',
      providerType: 'openai' as const,
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      apiKey: 'fake-test',
      createdAt: 1,
    };

    const createSettingsForBridge = (overrides: Partial<{
      workingProfileId: string;
      activeProfileId: string | null;
    }> = {}): AppSettings =>
      ({
        claude: {
          apiKey: null,
          oauthToken: null,
          authMethod: 'api-key',
          model: 'claude-sonnet-4-6',
          permissionMode: 'bypassPermissions',
          executablePath: null,
          planMode: false,
          extendedContext: true,
          thinkingEffort: 'high',
          workingProfileId: overrides.workingProfileId,
        },
        localModel: {
          profiles: [testProfile],
          activeProfileId: overrides.activeProfileId ?? null,
        },
        voice: {
          provider: 'openai-whisper',
          openaiApiKey: null,
          elevenlabsApiKey: null,
          model: 'gpt-4o-transcribe',
          ttsVoice: 'nova',
          activationHotkey: 'CommandOrControl+Shift+Space',
          activationHotkeyVoiceMode: true,
        },
      }) as unknown as AppSettings;

    it('should migrate activeProfileId to workingProfileId when workingProfileId is absent', () => {
      const settings = createSettingsForBridge({ activeProfileId: 'prof_gpt' });
      const result = normalizeSettings(settings);
      expect(result.models?.workingProfileId).toBe('prof_gpt');
    });

    it('should not overwrite existing workingProfileId during migration', () => {
      const secondProfile = { ...testProfile, id: 'prof_gemini', name: 'Gemini', model: 'gemini-3-pro' };
      const settings = {
        ...createSettingsForBridge({
          workingProfileId: 'prof_gemini',
          activeProfileId: 'prof_gpt',
        }),
        localModel: { profiles: [testProfile, secondProfile], activeProfileId: 'prof_gpt' },
      } as unknown as AppSettings;
      const result = normalizeSettings(settings);
      expect(result.models?.workingProfileId).toBe('prof_gemini');
    });

    it('should keep activeProfileId intact during migration', () => {
      const settings = createSettingsForBridge({ activeProfileId: 'prof_gpt' });
      const result = normalizeSettings(settings);
      expect(result.localModel?.activeProfileId).toBe('prof_gpt');
    });
  });

  describe('meetingBotUnlocked', () => {
    const createSettingsForMeetingBot = (overrides: Partial<AppSettings> = {}): AppSettings =>
      ({
        claude: {
          apiKey: null,
          oauthToken: null,
          authMethod: 'api-key',
          model: null,
          permissionMode: 'bypassPermissions',
          executablePath: null,
          planMode: false,
          extendedContext: true,
          thinkingEffort: 'high',
        },
        ...overrides,
      }) as unknown as AppSettings;

    it('should set meetingBotUnlocked to false for new user with default meetingBot settings', () => {
      const settings = createSettingsForMeetingBot({
        meetingBotUnlocked: undefined,
        meetingBot: { enabled: true, joinMode: 'never', rebelAvatar: 'spark', promptMinutesBefore: 5, respondViaVoice: true },
      });
      const result = normalizeSettings(settings);
      expect(result.meetingBotUnlocked).toBe(false);
    });

    it('should set meetingBotUnlocked to true for existing user with joinMode !== never', () => {
      const settings = createSettingsForMeetingBot({
        meetingBotUnlocked: undefined,
        meetingBot: { enabled: true, joinMode: 'prompt', rebelAvatar: 'spark', promptMinutesBefore: 5, respondViaVoice: true },
      });
      const result = normalizeSettings(settings);
      expect(result.meetingBotUnlocked).toBe(true);
    });

    it('should reactively upgrade meetingBotUnlocked from false to true when meetingBot settings show usage', () => {
      const settings = createSettingsForMeetingBot({
        meetingBotUnlocked: false,
        meetingBot: { enabled: true, joinMode: 'prompt', rebelAvatar: 'spark', promptMinutesBefore: 5, respondViaVoice: true },
      });
      const result = normalizeSettings(settings);
      expect(result.meetingBotUnlocked).toBe(true);
    });

    it('should not downgrade meetingBotUnlocked from true to false', () => {
      const settings = createSettingsForMeetingBot({
        meetingBotUnlocked: true,
        meetingBot: { enabled: true, joinMode: 'never', rebelAvatar: 'spark', promptMinutesBefore: 5, respondViaVoice: true },
      });
      const result = normalizeSettings(settings);
      expect(result.meetingBotUnlocked).toBe(true);
    });

    it('should keep meetingBotUnlocked false when meetingBot has no usage signals', () => {
      const settings = createSettingsForMeetingBot({
        meetingBotUnlocked: false,
        meetingBot: { enabled: true, joinMode: 'never', rebelAvatar: 'spark', promptMinutesBefore: 5, respondViaVoice: true },
      });
      const result = normalizeSettings(settings);
      expect(result.meetingBotUnlocked).toBe(false);
    });

    it('should keep meetingBotUnlocked false after explicit opt-out even with historical API keys', () => {
      const settings = createSettingsForMeetingBot({
        meetingBotUnlocked: false,
        meetingBot: {
          enabled: true,
          joinMode: 'never',
          rebelAvatar: 'spark',
          promptMinutesBefore: 5,
          respondViaVoice: true,
          firefliesApiKey: 'ff-key-123',
        } as AppSettings['meetingBot'],
      });
      const result = normalizeSettings(settings);
      expect(result.meetingBotUnlocked).toBe(false);
    });
  });

  describe('normalizeSettings idempotency', () => {
    it('should be stable when applied twice (normalizing normalized settings produces same result)', () => {
      const once = normalizeSettings({} as unknown as AppSettings);
      const twice = normalizeSettings(once);
      expect(twice).toEqual(once);
    });

    it('should default theme to dark', () => {
      const result = normalizeSettings({} as unknown as AppSettings);
      expect(result.theme).toBe('dark');
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 2a: normalize round-trip invariant. normalizeSettings MUST NOT emit
  // `{ key: undefined }` for any field — JSON persistence strips these keys,
  // but `fast-deep-equal` sees the pre-persist shape and diffs unequal on every
  // `ensureNormalizedSettings()` call, driving a write + fsync per call.
  //
  // Contract: normalize(JSON.parse(JSON.stringify(normalize(fixture)))) deep-
  // equals JSON.parse(JSON.stringify(normalize(fixture))). See
  // docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 2a.
  // ---------------------------------------------------------------------------
  describe('normalizeSettings JSON round-trip invariant (Stage 2a)', () => {
    // Recursive helper: assert no nested object has `key: undefined`. We only
    // inspect plain objects, so arrays-of-primitives, Date, etc. are skipped.
    const assertNoUndefinedValuedKeys = (obj: unknown, path: string = ''): void => {
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
      for (const [key, value] of Object.entries(obj)) {
        const keyPath = path ? `${path}.${key}` : key;
        expect(
          value,
          `Expected no undefined-valued keys after normalize, but found "${keyPath}"`,
        ).not.toBeUndefined();
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          assertNoUndefinedValuedKeys(value, keyPath);
        }
      }
    };

    const fixtures: Array<{ name: string; settings: AppSettings }> = [
      {
        name: 'empty input',
        settings: {} as unknown as AppSettings,
      },
      {
        name: 'minimal input (only activeProvider)',
        settings: { activeProvider: 'anthropic' } as unknown as AppSettings,
      },
      {
        name: 'OAuth-migrated (claude.oauthToken + oauthMigratedAt)',
        settings: {
          claude: {
            apiKey: 'fake-existing-key',
            oauthToken: 'lingering-oauth-token',
            oauthRefreshToken: 'lingering-refresh',
            oauthTokenExpiresAt: 1234567890,
            oauthProfile: { displayName: 'Test', email: 'test@example.com' },
            oauthMigratedAt: '2026-04-01T00:00:00.000Z',
            usageData: {
              fiveHour: { utilization: 0.5, resetsAt: '' },
              sevenDay: { utilization: 0.3, resetsAt: '' },
              sevenDaySonnet: { utilization: 0.1, resetsAt: '' },
              fetchedAt: 123,
            },
            authMethod: 'oauth-token',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
        } as unknown as AppSettings,
      },
      {
        name: 'OpenRouter-enabled (activeProvider + oauthToken)',
        settings: {
          activeProvider: 'openrouter',
          openRouter: {
            enabled: true,
            oauthToken: 'or-token',
            selectedModel: 'openai/gpt-5.5',
          },
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
        } as unknown as AppSettings,
      },
      {
        name: 'Codex-active (triggers claude-model-repair branch)',
        settings: {
          activeProvider: 'codex',
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            // Stale Anthropic model — migration at ~L710 clears this to 'gpt-5.5'
            model: 'claude-sonnet-4-6',
            thinkingModel: 'claude-opus-4-7',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: true,
            extendedContext: true,
            thinkingEffort: 'high',
          },
        } as unknown as AppSettings,
      },
      {
        name: 'stale profile references (workingProfileId / thinkingProfileId not in profiles)',
        settings: {
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
            thinkingProfileId: 'deleted-profile',
            workingProfileId: 'also-deleted',
            longContextFallbackProfileId: 'gone-too',
            thinkingFallback: 'profile:missing',
            workingFallback: 'profile:missing-2',
          },
          localModel: { profiles: [], activeProfileId: null },
          backgroundFallback: 'profile:missing-3',
        } as unknown as AppSettings,
      },
      {
        name: 'thinkingModel + behindTheScenesModel combos (thinkingModel set, BTS unset)',
        settings: {
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            thinkingModel: 'claude-opus-4-7',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: true,
            extendedContext: true,
            thinkingEffort: 'high',
          },
        } as unknown as AppSettings,
      },
      {
        name: 'BTS = profile:<deleted> (cleanup-to-undefined emitter)',
        settings: {
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
          behindTheScenesModel: 'profile:deleted',
          localModel: { profiles: [], activeProfileId: null },
        } as unknown as AppSettings,
      },
      {
        name: 'trustedTools + openRouter + firstTimeTooltips present',
        settings: {
          trustedTools: [
            { type: 'all', toolId: 'bash', rememberedAt: 1 },
          ],
          openRouter: {
            enabled: true,
            oauthToken: 'or-token',
            selectedModel: 'openai/gpt-5.5',
          },
          firstTimeTooltips: { memoryFirstSave: true },
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
        } as unknown as AppSettings,
      },
      {
        name: 'localModel with unknown-context-window profile',
        settings: {
          localModel: {
            profiles: [
              {
                id: 'p1',
                name: 'Some Unknown Provider',
                providerType: 'openai-compat',
                serverUrl: 'https://unknown.example.com/v1',
                model: 'totally-unknown-model',
                apiKey: 'fake-test',
                createdAt: 1,
              },
            ],
            activeProfileId: null,
          },
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
        } as unknown as AppSettings,
      },
      {
        // REBEL-5MJ / FOX-3096 — Path B codec-clear scrub fixture.
        // The model-choice codec emits explicit `undefined` for cleared dual
        // fields. After JSON persistence the own-prop is stripped, so on the
        // next normalize call the resolver would otherwise fall back to the
        // stale legacy claude.X and resurrect it. The scrub at L358-398 mirrors
        // the clear onto the legacy claude namespace so the round-trip holds.
        name: 'codec-cleared thinkingModel + thinkingProfileId (Path B scrub)',
        settings: {
          models: {
            thinkingModel: undefined,
            thinkingProfileId: undefined,
            thinkingFallback: undefined,
          },
          claude: {
            apiKey: null,
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            thinkingModel: 'claude-haiku-4-5',
            thinkingProfileId: 'stale-thinking-profile',
            thinkingFallback: 'profile:stale-thinking-fallback',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: false,
            extendedContext: true,
            thinkingEffort: 'high',
          },
        } as unknown as AppSettings,
      },
    ];

    for (const fixture of fixtures) {
      it(`round-trip invariant holds for: ${fixture.name}`, () => {
        const normalized = normalizeSettings(fixture.settings);
        const afterPersist = JSON.parse(JSON.stringify(normalized));
        // After JSON persistence, re-normalizing must produce the same shape.
        // If it doesn't, fast-deep-equal diffs every call and triggers a write.
        const reNormalized = normalizeSettings(afterPersist);
        expect(reNormalized).toEqual(afterPersist);
      });

      it(`no-undefined-valued-keys after normalize: ${fixture.name}`, () => {
        const normalized = normalizeSettings(fixture.settings);
        assertNoUndefinedValuedKeys(normalized);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Stage 2a: field-presence contract. Snapshot the sorted top-level keys for
  // one representative fixture per emitter site. A future regression that emits
  // a new `undefined` key will change the snapshot and fail — making it easy to
  // catch "I added a new field that emits undefined" at review time.
  // ---------------------------------------------------------------------------
  describe('normalizeSettings field-presence contract (Stage 2a)', () => {
    it('empty input: top-level keys match snapshot (no undefined-valued keys)', () => {
      const result = normalizeSettings({} as unknown as AppSettings);
      const keys = Object.keys(result).sort();
      // Snapshot of sorted top-level keys for an empty-input normalize call.
      // Note: sometimes-undefined emitter fields (activeProvider, openRouter,
      // trustedTools, managedCloudEnabled, cloudUpdateChannel, firstTimeTooltips,
      // behindTheScenesModel, backgroundFallback, behindTheScenesOverrides,
      // onboardingChecklist, memorySafetyPrivate, memorySafetyShared,
      // memorySafetyBySharing, spaceSafetyOverrides) MUST NOT appear here
      // because their values are undefined for empty input. A future regression
      // that adds a new undefined-emitting field will change this snapshot.
      //
      // `spaceSafetyLevels: {}` IS included — migrateToSpaceSafetyLevels runs
      // for every call and returns `{}` for fresh installs (a migration-marker).
      // `enforceSoftwareEngineerEvidence: false` is also included (Stage 3
      // contribution gate default-off setting).
      expect(keys).toMatchInlineSnapshot(`
        [
          "actionsFirstVisitedAt",
          "chatIntentRulePersistence",
          "diagnostics",
          "dismissedAnnouncements",
          "dismissedWhatsNewHighlights",
          "enforceSoftwareEngineerEvidence",
          "experimental",
          "favoriteFilePaths",
          "inboxLayoutMode",
          "lastSeenChangelogVersion",
          "localModel",
          "mcpConfigFile",
          "mcpServerEnabled",
          "meetingBotUnlocked",
          "models",
          "nps",
          "onboardingCompleted",
          "onboardingFirstCompletedAt",
          "providerKeys",
          "safetyEvalBlockConsensus",
          "safetyEvalMemoization",
          "safetyEvalSessionIntent",
          "safetyEvalUserIntentFence",
          "scratchpad",
          "sessionLogRetentionDays",
          "showDirectMcpSetupUi",
          "spaceSafetyLevels",
          "spaces",
          "surveys",
          "theme",
          "voice",
        ]
      `);
    });

    describe('safety-eval kill-switch round-trip (Phase 4 fix)', () => {
      it('safetyEvalMemoization defaults to true on empty settings', () => {
        const result = normalizeSettings({} as unknown as AppSettings);
        expect(result.safetyEvalMemoization).toBe(true);
      });

      it('safetyEvalSessionIntent defaults to true on empty settings', () => {
        const result = normalizeSettings({} as unknown as AppSettings);
        expect(result.safetyEvalSessionIntent).toBe(true);
      });

      it('safetyEvalBlockConsensus defaults to true on empty settings', () => {
        const result = normalizeSettings({} as unknown as AppSettings);
        expect(result.safetyEvalBlockConsensus).toBe(true);
      });

      it('safetyEvalUserIntentFence defaults to true on empty settings', () => {
        const result = normalizeSettings({} as unknown as AppSettings);
        expect(result.safetyEvalUserIntentFence).toBe(true);
      });

      it('safetyEvalMemoization=false survives a normalize round-trip', () => {
        const input = { safetyEvalMemoization: false } as unknown as AppSettings;
        const out = normalizeSettings(input);
        expect(out.safetyEvalMemoization).toBe(false);
        const reNormalized = normalizeSettings(JSON.parse(JSON.stringify(out)));
        expect(reNormalized.safetyEvalMemoization).toBe(false);
      });

      it('safetyEvalSessionIntent=false survives a normalize round-trip', () => {
        const input = { safetyEvalSessionIntent: false } as unknown as AppSettings;
        const out = normalizeSettings(input);
        expect(out.safetyEvalSessionIntent).toBe(false);
        const reNormalized = normalizeSettings(JSON.parse(JSON.stringify(out)));
        expect(reNormalized.safetyEvalSessionIntent).toBe(false);
      });

      it('safetyEvalBlockConsensus=false survives a normalize round-trip', () => {
        const input = { safetyEvalBlockConsensus: false } as unknown as AppSettings;
        const out = normalizeSettings(input);
        expect(out.safetyEvalBlockConsensus).toBe(false);
        const reNormalized = normalizeSettings(JSON.parse(JSON.stringify(out)));
        expect(reNormalized.safetyEvalBlockConsensus).toBe(false);
      });

      it('safetyEvalUserIntentFence=false survives a normalize round-trip', () => {
        const input = { safetyEvalUserIntentFence: false } as unknown as AppSettings;
        const out = normalizeSettings(input);
        expect(out.safetyEvalUserIntentFence).toBe(false);
        const reNormalized = normalizeSettings(JSON.parse(JSON.stringify(out)));
        expect(reNormalized.safetyEvalUserIntentFence).toBe(false);
      });

      it('IPC AppSettingsSchema declares all four safety-eval flags as optional booleans', async () => {
        const { AppSettingsSchema } = await import('@shared/ipc/schemas/settings');
        const internal = (AppSettingsSchema as unknown as { _def?: { schema?: unknown }; shape?: Record<string, unknown> });
        const shape =
          (internal.shape as Record<string, unknown> | undefined) ??
          ((internal._def?.schema as { shape?: Record<string, unknown> } | undefined)?.shape ??
            (AppSettingsSchema as unknown as { _def: { shape: () => Record<string, unknown> } })._def
              .shape());
        expect(shape).toBeDefined();
        expect(shape).toHaveProperty('safetyEvalMemoization');
        expect(shape).toHaveProperty('safetyEvalSessionIntent');
        expect(shape).toHaveProperty('safetyEvalBlockConsensus');
        expect(shape).toHaveProperty('safetyEvalUserIntentFence');
      });
    });

    it('models sub-object: keys are stable and legacy claude is not emitted', () => {
      const result = normalizeSettings({} as unknown as AppSettings);
      const claudeKeys = Object.keys(result.models ?? {}).sort();
      // Required keys must be present; optional cleanup-to-undefined keys
      // (thinkingModel, thinkingProfileId, workingProfileId, thinkingFallback,
      // workingFallback, longContextFallbackModel, longContextFallbackProfileId)
      // MUST NOT be present when their values are undefined.
      expect(claudeKeys).toContain('model');
      expect(claudeKeys).toContain('permissionMode');
      expect(claudeKeys).toContain('planMode');
      expect(claudeKeys).toContain('extendedContext');
      expect(claudeKeys).toContain('oauthToken');
      expect(claudeKeys).toContain('authMethod');
      // Cleanup-to-undefined claude fields must be absent for empty input:
      expect(claudeKeys).not.toContain('thinkingModel');
      expect(claudeKeys).not.toContain('thinkingProfileId');
      expect(claudeKeys).not.toContain('workingProfileId');
      expect(claudeKeys).not.toContain('thinkingFallback');
      expect(claudeKeys).not.toContain('workingFallback');
      expect(claudeKeys).not.toContain('longContextFallbackModel');
      expect(claudeKeys).not.toContain('longContextFallbackProfileId');
      expect(result).not.toHaveProperty('claude');
    });

    it('materializes legacy claude-only input into complete models without emitting claude', () => {
      expect(MODEL_SETTINGS_FIELD_KEYS).toContain('learnedContextWindowEnabled');
      expect(MODEL_SETTINGS_FIELD_KEYS).toHaveLength(23);

      const input = {
        activeProvider: 'anthropic',
        claude: {
          apiKey: 'fake-ant-test-key',
          oauthToken: null,
          oauthRefreshToken: null,
          oauthTokenExpiresAt: null,
          authMethod: 'api-key',
          model: 'claude-opus-4-7',
          permissionMode: 'plan',
          executablePath: '/tmp/fake-claude',
          planMode: true,
          thinkingModel: 'deepseek-ai/DeepSeek-V4-Pro',
          workingProfileId: 'profile-working',
          thinkingFallback: 'profile:profile-thinking',
          workingFallback: 'profile:profile-working',
          extendedContext: true,
          learnedContextWindowEnabled: true,
          longContextFallbackModel: 'claude-sonnet-4-6',
          longContextFallbackProfileId: 'profile-thinking',
          thinkingEffort: 'medium',
          modelEfforts: { 'claude-opus-4-7': 'high' },
          oauthProfile: { email: 'test@example.com', displayName: 'Test User', tier: 'max' },
          usageData: {
            fiveHour: { utilization: 0.1, resetsAt: '2026-05-01T00:00:00.000Z' },
            sevenDay: { utilization: 0.2, resetsAt: '2026-05-08T00:00:00.000Z' },
            sevenDaySonnet: { utilization: 0.3, resetsAt: '2026-05-08T00:00:00.000Z' },
            fetchedAt: 1_725_000_000_000,
          },
        },
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'profile-working',
              name: 'Working Profile',
              providerType: 'anthropic',
              model: 'claude-opus-4-7',
              createdAt: 1,
            },
            {
              id: 'profile-thinking',
              name: 'Thinking Profile',
              providerType: 'custom',
              serverUrl: 'https://example.test/v1',
              model: 'deepseek-ai/DeepSeek-V4-Pro',
              createdAt: 2,
            },
          ],
        },
      } as unknown as AppSettings;

      const normalized = normalizeSettings(input);
      expect(normalized).not.toHaveProperty('claude');
      expect(normalized.models).toEqual(expect.objectContaining({
        apiKey: 'fake-ant-test-key',
        oauthToken: null,
        authMethod: 'api-key',
        model: 'claude-opus-4-7',
        permissionMode: 'plan',
        executablePath: '/tmp/fake-claude',
        planMode: true,
        extendedContext: true,
        learnedContextWindowEnabled: true,
        thinkingEffort: 'medium',
        thinkingModel: 'deepseek-ai/DeepSeek-V4-Pro',
        workingProfileId: 'profile-working',
        thinkingFallback: 'profile:profile-thinking',
        workingFallback: 'profile:profile-working',
        longContextFallbackModel: 'claude-sonnet-4-6',
        longContextFallbackProfileId: 'profile-thinking',
        modelEfforts: { 'claude-opus-4-7': 'high' },
      }));
      expect(normalized.models?.learnedContextWindowEnabled).toBe(true);
      expect(normalized.models?.thinkingModel).toBe('deepseek-ai/DeepSeek-V4-Pro');
      expect(normalized.models?.workingProfileId).toBe('profile-working');
      expect(normalized.models?.longContextFallbackProfileId).toBe('profile-thinking');

      const reNormalized = normalizeSettings(JSON.parse(JSON.stringify(normalized)) as AppSettings);
      expect(reNormalized).toEqual(normalized);
      expect(reNormalized.models?.learnedContextWindowEnabled).toBe(true);
      expect(reNormalized).not.toHaveProperty('claude');
    });

    it('preserves explicit learnedContextWindowEnabled=false from models over legacy true', () => {
      const normalized = normalizeSettings({
        models: { learnedContextWindowEnabled: false },
        claude: { learnedContextWindowEnabled: true },
      } as unknown as AppSettings);

      expect(normalized.models?.learnedContextWindowEnabled).toBe(false);
      expect(normalizeSettings(normalized).models?.learnedContextWindowEnabled).toBe(false);
    });

    it('localModel.profiles[]: contextWindow absent when unknown (not undefined-valued)', () => {
      const result = normalizeSettings({
        localModel: {
          profiles: [
            {
              id: 'p1',
              name: 'Mystery Provider',
              // Use a provider type that doesn't map to any known preset and
              // a model string that the context-window lookup won't recognize.
              providerType: 'custom',
              serverUrl: 'https://mystery.example.com/v1',
              model: 'definitely-not-a-known-model-xyz-9999',
              apiKey: 'fake-test',
              createdAt: 1,
            },
          ],
          activeProfileId: null,
        },
      } as unknown as AppSettings);
      const profile = result.localModel!.profiles[0];
      expect(profile).toBeDefined();
      // Unknown context window → key should be absent, not `contextWindow: undefined`.
      expect('contextWindow' in profile).toBe(false);
    });

    it('openRouter/trustedTools/firstTimeTooltips absent when undefined in emitter output', () => {
      const result = normalizeSettings({} as unknown as AppSettings);
      expect('openRouter' in result).toBe(false);
      expect('trustedTools' in result).toBe(false);
      expect('firstTimeTooltips' in result).toBe(false);
      expect('cloudUpdateChannel' in result).toBe(false);
      expect('activeProvider' in result).toBe(false);
      expect('managedCloudEnabled' in result).toBe(false);
      expect('behindTheScenesModel' in result).toBe(false);
      expect('backgroundFallback' in result).toBe(false);
      expect('behindTheScenesOverrides' in result).toBe(false);
      expect('onboardingChecklist' in result).toBe(false);
      expect('memorySafetyBySharing' in result).toBe(false);
      expect('spaceSafetyOverrides' in result).toBe(false);
      expect('memorySafetyPrivate' in result).toBe(false);
      expect('memorySafetyShared' in result).toBe(false);
      // NOTE: `spaceSafetyLevels` IS present (as `{}`) — `migrateToSpaceSafetyLevels`
      // runs on every call and returns a defined (possibly empty) object.
      // It is not an undefined-emitter site.
      expect(result.spaceSafetyLevels).toEqual({});
    });

    it('seededBundledPluginIds emits [] and values, but omits undefined', () => {
      const withEmpty = normalizeSettings({
        seededBundledPluginIds: [],
      } as unknown as AppSettings);
      expect(withEmpty.seededBundledPluginIds).toEqual([]);
      expect('seededBundledPluginIds' in withEmpty).toBe(true);

      const withValue = normalizeSettings({
        seededBundledPluginIds: ['pomodoro-timer'],
      } as unknown as AppSettings);
      expect(withValue.seededBundledPluginIds).toEqual(['pomodoro-timer']);
      expect('seededBundledPluginIds' in withValue).toBe(true);

      const withUndefined = normalizeSettings({
        seededBundledPluginIds: undefined,
      } as unknown as AppSettings);
      expect('seededBundledPluginIds' in withUndefined).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 2a: affected-fields safety test. For each of the 13 top-level fields
  // whose emitter now drops the key when undefined, verify that setting the
  // field to `undefined` in the input produces the same observable output as
  // omitting the field entirely. This confirms no consumer relies on
  // presence-vs-absence semantics for these fields (they all use ??/?.).
  // ---------------------------------------------------------------------------
  describe('normalizeSettings affected-fields safety (Stage 2a)', () => {
    const baseFixture: AppSettings = {
      claude: {
        apiKey: null,
        oauthToken: null,
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: true,
        thinkingEffort: 'high',
      } as AppSettings['claude'],
      voice: {
        provider: 'openai-whisper',
        openaiApiKey: null,
        elevenlabsApiKey: null,
        model: 'gpt-4o-mini-transcribe-2025-12-15',
        ttsVoice: 'nova',
        activationHotkey: 'CommandOrControl+Shift+Space',
        activationHotkeyVoiceMode: true,
      } as AppSettings['voice'],
    } as unknown as AppSettings;

    const affectedFields = [
      'activeProvider',
      'memorySafetyPrivate',
      'memorySafetyShared',
      'memorySafetyBySharing',
      'spaceSafetyOverrides',
      'spaceSafetyLevels',
      'onboardingChecklist',
      'behindTheScenesModel',
      'backgroundFallback',
      'behindTheScenesOverrides',
      'managedCloudEnabled',
      'cloudUpdateChannel',
      'firstTimeTooltips',
    ] as const;

    for (const field of affectedFields) {
      it(`setting "${field}" to undefined produces same output as omitting it`, () => {
        const withUndefined = normalizeSettings({
          ...baseFixture,
          [field]: undefined,
        } as unknown as AppSettings);
        const withoutField = normalizeSettings(baseFixture);
        expect(withUndefined).toEqual(withoutField);
      });
    }

    it('setting "openRouter" to undefined produces same output as omitting it', () => {
      const withUndefined = normalizeSettings({
        ...baseFixture,
        openRouter: undefined,
      } as unknown as AppSettings);
      const withoutField = normalizeSettings(baseFixture);
      expect(withUndefined).toEqual(withoutField);
    });

    it('setting "trustedTools" to undefined produces same output as omitting it', () => {
      const withUndefined = normalizeSettings({
        ...baseFixture,
        trustedTools: undefined,
      } as unknown as AppSettings);
      const withoutField = normalizeSettings(baseFixture);
      expect(withUndefined).toEqual(withoutField);
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 1 (260503_unify_learned_limits_into_profiles): provenance sidecar
  // fields on `ModelProfile` and migration-guard fields on `LocalModelSettings`
  // must survive `normalizeSettings()` round-trip. Pure additive schema test —
  // no consumer behavior changes yet.
  // ---------------------------------------------------------------------------
  describe('learned-limits provenance sidecar fields (Stage 1)', () => {
    const baseFixture = {
      claude: {
        apiKey: null,
        oauthToken: null,
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: true,
        thinkingEffort: 'high',
      },
      voice: {
        provider: 'openai-whisper',
        openaiApiKey: null,
        elevenlabsApiKey: null,
        model: 'gpt-4o-mini-transcribe-2025-12-15',
        ttsVoice: 'nova',
        activationHotkey: 'CommandOrControl+Shift+Space',
        activationHotkeyVoiceMode: true,
      },
    } as unknown as AppSettings;

    it('preserves contextWindowSource/OverflowCount/LearnedAt/lastLearned on a profile through normalizeSettings()', () => {
      const settings: AppSettings = {
        ...baseFixture,
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
        },
      } as unknown as AppSettings;

      const result = normalizeSettings(settings);
      const profile = result.localModel?.profiles.find((p) => p.id === 'auto:mystery-model-9999');

      expect(profile).toBeDefined();
      expect(profile?.contextWindow).toBe(880_000);
      expect(profile?.contextWindowSource).toBe('auto');
      expect(profile?.contextWindowOverflowCount).toBe(2);
      expect(profile?.contextWindowLearnedAt).toBe(1_700_000_000_000);
      expect(profile?.lastLearnedContextWindow).toBe(880_000);
      // Idempotent: a second normalize is a no-op on these fields.
      expect(normalizeSettings(result)).toEqual(result);
    });

    it('preserves outputTokensSource/OverflowCount/LearnedAt/lastLearned on a profile through normalizeSettings()', () => {
      const settings: AppSettings = {
        ...baseFixture,
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
      } as unknown as AppSettings;

      const result = normalizeSettings(settings);
      const profile = result.localModel?.profiles.find((p) => p.id === 'auto:output-cap-model');

      expect(profile).toBeDefined();
      expect(profile?.maxOutputTokens).toBe(8_192);
      expect(profile?.outputTokensSource).toBe('auto');
      expect(profile?.outputTokensOverflowCount).toBe(3);
      expect(profile?.outputTokensLearnedAt).toBe(1_700_000_002_000);
      expect(profile?.lastLearnedOutputTokens).toBe(8_192);
      expect(normalizeSettings(result)).toEqual(result);
    });

    it("preserves user-source provenance with a divergent lastLearnedContextWindow sidecar", () => {
      const settings: AppSettings = {
        ...baseFixture,
        localModel: {
          profiles: [
            {
              id: 'user-tweaked',
              name: 'User Tweaked',
              providerType: 'other',
              serverUrl: 'https://example.test/v1',
              model: 'mystery-model-zzzzz',
              contextWindow: 1_200_000,
              contextWindowSource: 'user',
              contextWindowOverflowCount: 3,
              contextWindowLearnedAt: 1_700_000_000_000,
              lastLearnedContextWindow: 880_000,
              createdAt: 1,
            },
          ],
          activeProfileId: null,
        },
      } as unknown as AppSettings;

      const result = normalizeSettings(settings);
      const profile = result.localModel?.profiles.find((p) => p.id === 'user-tweaked');

      expect(profile).toBeDefined();
      expect(profile?.contextWindow).toBe(1_200_000);
      expect(profile?.contextWindowSource).toBe('user');
      expect(profile?.contextWindowOverflowCount).toBe(3);
      expect(profile?.contextWindowLearnedAt).toBe(1_700_000_000_000);
      expect(profile?.lastLearnedContextWindow).toBe(880_000);
      expect(normalizeSettings(result)).toEqual(result);
    });

    it("preserves a partial 'auto' provenance state where overflowCount and learnedAt are absent (legacy/edge case)", () => {
      const settings: AppSettings = {
        ...baseFixture,
        localModel: {
          profiles: [
            {
              id: 'auto:partial-state',
              name: 'partial-state (auto, sparse)',
              providerType: 'other',
              serverUrl: '',
              model: 'partial-state',
              contextWindow: 720_000,
              contextWindowSource: 'auto',
              lastLearnedContextWindow: 720_000,
              createdAt: 1,
            },
          ],
          activeProfileId: null,
        },
      } as unknown as AppSettings;

      const result = normalizeSettings(settings);
      const profile = result.localModel?.profiles.find((p) => p.id === 'auto:partial-state');

      expect(profile).toBeDefined();
      expect(profile?.contextWindow).toBe(720_000);
      expect(profile?.contextWindowSource).toBe('auto');
      expect(profile?.lastLearnedContextWindow).toBe(720_000);
      expect(profile?.contextWindowOverflowCount).toBeUndefined();
      expect(profile?.contextWindowLearnedAt).toBeUndefined();
      expect(normalizeSettings(result)).toEqual(result);
    });

    it('preserves localModel.learnedLimitsMigratedAt and registryStampMigratedAt through normalizeSettings()', () => {
      const settings: AppSettings = {
        ...baseFixture,
        localModel: {
          profiles: [],
          activeProfileId: null,
          learnedLimitsMigratedAt: 1_700_000_000_000,
          registryStampMigratedAt: 1_700_000_001_000,
        },
      } as unknown as AppSettings;

      const result = normalizeSettings(settings);

      expect(result.localModel?.learnedLimitsMigratedAt).toBe(1_700_000_000_000);
      expect(result.localModel?.registryStampMigratedAt).toBe(1_700_000_001_000);
      expect(normalizeSettings(result)).toEqual(result);
    });
  });

  // ---------------------------------------------------------------------------
  // klavisMigrationPending strip + dismissal-state migration.
  //
  // The legacy `klavisMigrationPending` field is removed from `AppSettings` (and
  // its Zod schema) — but persisted settings on disk for users who upgraded
  // through earlier builds may still carry the value. The normalizer must:
  //   1. Drop the field from the normalised output (so it doesn't keep getting
  //      re-persisted as schema drift).
  //   2. If the legacy value was `false` (user dismissed the banner), preserve
  //      that intent by setting `dismissedAnnouncements['klavis-migration']: true`.
  // ---------------------------------------------------------------------------
  describe('normalizeSettings — klavisMigrationPending field removal', () => {
    const minimal = {
      claude: {
        apiKey: null,
        oauthToken: null,
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: true,
        thinkingEffort: 'high',
      } as AppSettings['claude'],
      voice: {
        provider: 'openai-whisper',
        openaiApiKey: null,
        elevenlabsApiKey: null,
        model: 'gpt-4o-mini-transcribe-2025-12-15',
        ttsVoice: 'nova',
        activationHotkey: 'CommandOrControl+Shift+Space',
        activationHotkeyVoiceMode: true,
      } as AppSettings['voice'],
    } as unknown as AppSettings;

    it('strips legacy klavisMigrationPending=true from the normalized output', () => {
      const input = { ...minimal, klavisMigrationPending: true } as unknown as AppSettings;
      const result = normalizeSettings(input) as Record<string, unknown>;
      expect('klavisMigrationPending' in result).toBe(false);
    });

    it('strips legacy klavisMigrationPending=false from the normalized output', () => {
      const input = { ...minimal, klavisMigrationPending: false } as unknown as AppSettings;
      const result = normalizeSettings(input) as Record<string, unknown>;
      expect('klavisMigrationPending' in result).toBe(false);
    });

    it('migrates klavisMigrationPending=false into dismissedAnnouncements', () => {
      const input = { ...minimal, klavisMigrationPending: false } as unknown as AppSettings;
      const result = normalizeSettings(input);
      expect(result.dismissedAnnouncements?.['klavis-migration']).toBe(true);
    });

    it('does NOT add klavis-migration dismissal when klavisMigrationPending=true', () => {
      const input = { ...minimal, klavisMigrationPending: true } as unknown as AppSettings;
      const result = normalizeSettings(input);
      expect(result.dismissedAnnouncements?.['klavis-migration']).toBeUndefined();
    });

    it('preserves an existing klavis-migration dismissal when migrating from false', () => {
      const input = {
        ...minimal,
        klavisMigrationPending: false,
        dismissedAnnouncements: { 'klavis-migration': true, 'other-banner': true },
      } as unknown as AppSettings;
      const result = normalizeSettings(input);
      expect(result.dismissedAnnouncements?.['klavis-migration']).toBe(true);
      expect(result.dismissedAnnouncements?.['other-banner']).toBe(true);
    });

    it('idempotency: normalizing twice produces the same result', () => {
      const input = { ...minimal, klavisMigrationPending: false } as unknown as AppSettings;
      const first = normalizeSettings(input);
      const second = normalizeSettings(first);
      expect(second).toEqual(first);
    });
  });
});
