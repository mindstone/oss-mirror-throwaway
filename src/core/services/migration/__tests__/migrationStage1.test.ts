import { describe, expect, it } from 'vitest';
import { ALL_STORE_VERSIONS } from '@core/constants';
import {
  MIGRATION_CLASSIFICATION_BY_STORE_NAME,
  MIGRATION_CLASSIFICATION_BY_VERSION_KEY,
  MIGRATION_CLASSIFICATIONS,
} from '../migrationClassification';
import {
  MIGRATION_BUNDLE_MANIFEST_SCHEMA_VERSION,
  parseMigrationBundleManifest,
  type MigrationBundleManifest,
} from '../migrationManifest';
import { isBundleCompatible } from '../migrationCompatibility';
import { sanitizeAppSettingsForMigration } from '../appSettingsMigrationSanitizer';
import type { AppSettings } from '@shared/types/settings';

function validManifest(): MigrationBundleManifest {
  return {
    schemaVersion: MIGRATION_BUNDLE_MANIFEST_SCHEMA_VERSION,
    createdAt: '2026-06-09T13:00:00.000Z',
    importId: 'a89ebd43-7c41-4a30-b81b-b8cc886b9824',
    sourceAppVersion: '0.4.46',
    sourceDataSchemaEpoch: 123,
    oldPaths: {
      userDataPath: '/Users/example/Library/Application Support/mindstone-rebel',
      coreDirectory: '/Users/example/Rebel',
      mcpConfigFile: '/Users/example/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json',
    },
    spaces: [{
      name: 'Exec',
      relPath: 'work/Exec',
      classification: 'cloud-backed',
      provider: 'google_drive',
      detectionEvidence: {
        inputPath: '/Users/example/Library/CloudStorage/GoogleDrive-user/Exec',
        resolvedPath: '/Users/example/Library/CloudStorage/GoogleDrive-user/Exec',
        provider: 'google_drive',
        relativeSuffix: 'Exec',
        readmeSha256: 'a'.repeat(64),
        coreDirectoryIsCloudBacked: false,
        isSymlink: true,
      },
    }],
    entries: [{
      relPath: 'sessions/index.json',
      sha256: 'b'.repeat(64),
      bytes: 42,
    }],
    exclusions: {
      derived: ['Cache'],
      keychain: ['auth-tokens.json'],
      cloud: ['cloud-service-client-id.json'],
      transient: ['logs'],
    },
    reAuthChecklist: {
      providerKeys: ['openai'],
      connectors: ['google-workspace'],
      cloudRepairRequired: true,
    },
  };
}

function settingsFixture(): AppSettings {
  return {
    coreDirectory: '/old/Rebel',
    mcpConfigFile: '/old/userData/mcp/super-mcp-router.json',
    onboardingCompleted: true,
    userEmail: 'user@example.com',
    userFirstName: 'Sam',
    onboardingFirstCompletedAt: 123,
    voice: {
      provider: 'custom-openai',
      openaiApiKey: 'voice-openai-secret',
      elevenlabsApiKey: 'voice-elevenlabs-secret',
      model: 'gpt-4o-mini-transcribe',
      ttsVoice: 'nova',
      activationHotkey: 'Ctrl+Alt+Space',
      activationHotkeyVoiceMode: true,
      inlineVoiceHotkey: 'Ctrl+Shift+V',
      autoSpeak: false,
      customProfiles: [{
        id: 'voice-profile',
        name: 'Voice Gateway',
        sttBaseUrl: 'https://user:pass@voice.example.com/v1',
        sttModel: 'voice-model',
        apiKey: 'voice-profile-secret',
        createdAt: 1,
      }],
      activeCustomProfileId: 'voice-profile',
    },
    providerKeys: {
      openai: 'openai-secret',
      google: 'google-secret',
    },
    customProviders: [{
      id: 'custom',
      name: 'Custom',
      serverUrl: 'https://user:pass@models.example.com/v1',
      apiKey: 'custom-provider-secret',
      createdAt: 1,
    }],
    models: {
      apiKey: 'anthropic-secret',
      oauthToken: 'oauth-secret',
      oauthRefreshToken: 'refresh-secret',
      oauthTokenExpiresAt: 999,
      authMethod: 'oauth-token',
      model: 'claude-sonnet-4-5',
      permissionMode: 'plan',
      executablePath: '/usr/bin/claude',
      planMode: true,
      thinkingModel: 'claude-opus-4-7',
      thinkingProfileId: 'profile-secret-ref',
      workingProfileId: 'profile-secret-ref',
      extendedContext: true,
      thinkingEffort: 'high',
      oauthProfile: { email: 'oauth@example.com' },
    },
    diagnostics: {
      debugBreadcrumbsUntil: null,
      developerMode: true,
    },
    googleWorkspace: {
      enabled: true,
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
    },
    hubspot: {
      enabled: true,
      clientId: 'hubspot-client-id',
      clientSecret: 'hubspot-client-secret',
    },
    salesforce: {
      enabled: true,
      clientId: 'salesforce-client-id',
      clientSecret: 'salesforce-client-secret',
    },
    gamma: {
      enabled: true,
      apiKey: 'gamma-secret',
    },
    openRouter: {
      enabled: true,
      oauthToken: 'openrouter-token',
      oauthRefreshToken: 'openrouter-refresh',
      selectedModel: 'openai/gpt-5.5',
    },
    activeProvider: 'openrouter',
    managedProviderDeactivated: true,
    experimental: {
      routerEnabled: true,
      mcpAppsEnabled: true,
      agentInstanceId: 'shared-device-id',
      inboundAuthorPolicy: { mode: 'allow_known' } as unknown as NonNullable<AppSettings['experimental']>['inboundAuthorPolicy'],
      inboundAuthorPolicyBackup: { raw: true },
      inboundAuthorPolicyBypassActive: true,
      cloudSlackWorkspace: {
        teamId: 'T1',
        teamName: 'Workspace',
        status: 'connected',
      },
    },
    calendar: {
      useOtherCalendarProvider: true,
      selectedCalendars: { 'google:user@example.com': ['primary'] },
    },
    companyName: 'Example Co',
    spaces: [{
      name: 'Exec',
      path: 'work/Exec',
      type: 'team',
      isSymlink: true,
      sourcePath: '/old/Drive/Exec',
      storageProvider: 'google_drive',
      createdAt: 1,
    }],
    googleDriveLinks: [{
      driveName: 'Drive',
      sourcePath: '/old/Drive',
      symlinkPath: 'work/Drive',
      createdAt: 1,
    }],
    googleDriveInstalled: true,
    personalizedUseCases: [{
      id: 'case',
      title: 'Prep',
      description: 'Meeting prep',
      prompt: 'Prep me',
      generatedAt: 1,
    }],
    memoryUpdateEnabled: true,
    trustedTools: [{
      toolId: 'read_file' as never,
      addedAt: 1,
    }],
    trustedPreviewDomains: ['https://cdn.example.com'],
    theme: 'light',
    accentColor: 'teal',
    fontScale: 'large',
    uiDensity: 'compact',
    conversationWidth: 'wide',
    inboxLayoutMode: 'list',
    alwaysAutoMarkDone: true,
    timeSavedEstimation: { enabled: true },
    streaming: { enabled: true },
    localModel: {
      activeProfileId: 'local-secret-profile',
      profiles: [{
        id: 'local-secret-profile',
        name: 'Local Gateway',
        providerType: 'other',
        serverUrl: 'https://user:pass@local.example.com/v1',
        model: 'model',
        apiKey: 'profile-secret',
        createdAt: 1,
      }],
    },
    behindTheScenesModel: 'claude-haiku-4-5',
    heroChoiceRunMode: 'ask',
    dailySparkMode: 'subtle',
    meetingBot: {
      enabled: true,
      rebelAvatar: 'spark',
      firefliesApiKey: 'fireflies-secret',
      fathomApiKey: 'fathom-secret',
      recallApiKey: 'recall-secret',
      joinMode: 'ask',
      promptMinutesBefore: 5,
      triggerPhrase: 'Rebel',
      respondViaVoice: false,
      plaud: {
        userEmail: 'plaud@example.com',
        userId: 'plaud-user-id',
      },
    },
    meetingBotUnlocked: true,
    telemetry: {
      enabled: true,
      sentryDsn: 'sentry-secret',
      rudderWriteKey: 'rudder-secret',
      rudderDataPlaneUrl: 'https://rudder.example.com',
    },
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://cloud.example.com',
      cloudToken: 'cloud-secret',
    },
    managedCloudEnabled: true,
    mcpServerEnabled: true,
    exposeProviderKeysInShell: true,
    showDirectMcpSetupUi: true,
    enforceSoftwareEngineerEvidence: true,
    sessionLogRetentionDays: 14,
  };
}

describe('migration manifest schema', () => {
  it('parses a valid manifest', () => {
    const parsed = parseMigrationBundleManifest(validManifest());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.importId).toBe('a89ebd43-7c41-4a30-b81b-b8cc886b9824');
    }
  });

  it.each([
    ['schemaVersion', { schemaVersion: 2 }],
    ['createdAt', { createdAt: 'not-a-date' }],
    ['importId', { importId: 'not-a-uuid' }],
    ['sourceDataSchemaEpoch', { sourceDataSchemaEpoch: -1 }],
    ['oldPaths', { oldPaths: { userDataPath: '', coreDirectory: null, mcpConfigFile: null } }],
    ['spaces', { spaces: [{ ...validManifest().spaces[0], classification: 'unknown' }] }],
    ['entries', { entries: [{ relPath: '../escape', sha256: 'b'.repeat(64), bytes: 1 }] }],
    ['entries', { entries: [{ relPath: 'ok.json', sha256: 'not-sha', bytes: 1 }] }],
    ['exclusions', { exclusions: { ...validManifest().exclusions, keychain: ['/absolute'] } }],
    ['reAuthChecklist', { reAuthChecklist: { providerKeys: ['openai'], connectors: ['slack'] } }],
  ])('rejects invalid %s shape', (_label: string, patch: Record<string, unknown>) => {
    const parsed = parseMigrationBundleManifest({ ...validManifest(), ...patch });
    expect(parsed.ok).toBe(false);
  });
});

describe('migration compatibility', () => {
  it('accepts equal target epoch', () => {
    expect(isBundleCompatible(10, { sourceDataSchemaEpoch: 10 })).toEqual({ ok: true });
  });

  it('accepts newer target epoch', () => {
    expect(isBundleCompatible(11, { sourceDataSchemaEpoch: 10 })).toEqual({ ok: true });
  });

  it('rejects older target epoch', () => {
    expect(isBundleCompatible(9, { sourceDataSchemaEpoch: 10 })).toEqual({
      ok: false,
      reason: 'source-newer-than-target',
      sourceDataSchemaEpoch: 10,
      targetDataSchemaEpoch: 9,
    });
  });
});

describe('app settings migration sanitizer', () => {
  it('keeps non-secret preferences and strips secret-bearing settings', () => {
    const sanitized = sanitizeAppSettingsForMigration(settingsFixture());

    expect(sanitized.settings.theme).toBe('light');
    expect(sanitized.settings.accentColor).toBe('teal');
    expect(sanitized.settings.voice?.provider).toBe('custom-openai');
    expect(sanitized.settings.voice?.model).toBe('gpt-4o-mini-transcribe');
    expect(sanitized.settings.models?.model).toBe('claude-sonnet-4-5');
    expect(sanitized.settings.models?.authMethod).toBe('api-key');
    expect(sanitized.settings.localModel).toEqual({ profiles: [], activeProfileId: null });
    expect(sanitized.settings.spaces?.[0]?.path).toBe('work/Exec');
    expect(sanitized.settings.meetingBot?.joinMode).toBe('ask');

    expect(sanitized.settings.cloudInstance).toBeUndefined();
    expect(sanitized.settings.providerKeys).toBeUndefined();
    expect(sanitized.settings.customProviders).toBeUndefined();
    expect(sanitized.settings.googleWorkspace).toBeUndefined();
    expect(sanitized.settings.hubspot).toBeUndefined();
    expect(sanitized.settings.salesforce).toBeUndefined();
    expect(sanitized.settings.gamma).toBeUndefined();
    expect(sanitized.settings.openRouter).toBeUndefined();
    expect(sanitized.settings.telemetry).toBeUndefined();
    expect(sanitized.settings.activeProvider).toBeUndefined();
    expect(sanitized.settings.managedProviderDeactivated).toBeUndefined();
    expect(sanitized.settings.experimental?.agentInstanceId).toBeUndefined();
    expect(sanitized.settings.experimental?.inboundAuthorPolicy).toBeUndefined();
    expect(sanitized.settings.experimental?.routerEnabled).toBe(true);
  });

  it('reports removed secret-bearing fields from the actual input', () => {
    const { removedSecretFields } = sanitizeAppSettingsForMigration(settingsFixture());

    expect(removedSecretFields).toEqual(expect.arrayContaining([
      'cloudInstance.cloudToken',
      'customProviders[0].apiKey',
      'customProviders[0].serverUrl',
      'gamma.apiKey',
      'googleWorkspace.clientSecret',
      'hubspot.clientSecret',
      'localModel.profiles[0].apiKey',
      'localModel.profiles[0].serverUrl',
      'meetingBot.firefliesApiKey',
      'meetingBot.fathomApiKey',
      'meetingBot.recallApiKey',
      'models.apiKey',
      'models.oauthToken',
      'models.oauthRefreshToken',
      'openRouter.oauthToken',
      'openRouter.oauthRefreshToken',
      'providerKeys',
      'salesforce.clientSecret',
      'telemetry.rudderWriteKey',
      'voice.customProfiles[0].apiKey',
      'voice.customProfiles[0].sttBaseUrl',
      'voice.elevenlabsApiKey',
      'voice.openaiApiKey',
    ]));
  });

  it('does not leave known secret keys or values in the sanitized payload', () => {
    const { settings } = sanitizeAppSettingsForMigration(settingsFixture());
    const payload = JSON.stringify(settings);

    for (const forbidden of [
      'providerKeys',
      'apiKey',
      'oauthToken',
      'oauthRefreshToken',
      'clientSecret',
      'cloudToken',
      'firefliesApiKey',
      'fathomApiKey',
      'recallApiKey',
      'sentryDsn',
      'rudderWriteKey',
      'voice-openai-secret',
      'openai-secret',
      'anthropic-secret',
      'openrouter-token',
      'cloud-secret',
      'profile-secret',
      'https://user:pass@',
    ]) {
      expect(payload).not.toContain(forbidden);
    }
  });

  it('strips secret-named fields that slip through passthrough sub-sanitizers (M1 backstop)', () => {
    const base = settingsFixture();
    // Simulate future secret-bearing fields added to passthrough subtrees
    // (sanitizeExperimental / sanitizeCalendar / nps / default are structural passthroughs).
    const withFutureSecret = {
      ...base,
      experimental: { ...(base.experimental ?? {}), futureApiKey: 'synthsecret-should-not-survive' },
      calendar: { ...(base.calendar ?? {}), webhookSecret: 'whsec-should-not-survive' },
    } as unknown as Parameters<typeof sanitizeAppSettingsForMigration>[0];

    const { settings, removedSecretFields } = sanitizeAppSettingsForMigration(withFutureSecret);
    const payload = JSON.stringify(settings);
    expect(payload).not.toContain('synthsecret-should-not-survive');
    expect(payload).not.toContain('whsec-should-not-survive');
    expect(removedSecretFields).toEqual(expect.arrayContaining([
      'experimental.futureApiKey',
      'calendar.webhookSecret',
    ]));
  });
});

describe('migration classification SSOT', () => {
  it('classifies every ALL_STORE_VERSIONS key exactly once', () => {
    for (const key of Object.keys(ALL_STORE_VERSIONS)) {
      expect(MIGRATION_CLASSIFICATION_BY_VERSION_KEY.get(key as keyof typeof ALL_STORE_VERSIONS), key).toBeDefined();
    }
  });

  it('has no duplicate version keys, store names, or relative paths', () => {
    for (const field of ['versionKeys', 'storeNames', 'relPaths'] as const) {
      const seen = new Set<string>();
      for (const entry of MIGRATION_CLASSIFICATIONS as ReadonlyArray<{
        versionKeys?: readonly string[];
        storeNames?: readonly string[];
        relPaths?: readonly string[];
      }>) {
        for (const value of entry[field] ?? []) {
          expect(seen.has(String(value)), `${field}:${String(value)}`).toBe(false);
          seen.add(String(value));
        }
      }
    }
  });

  it('classifies plan-critical user-state stores as copy', () => {
    for (const storeName of [
      'skill-usage',
      'conversation-feedback',
      'use-case-library',
      'entity-metadata',
      'file-conversation',
      'community-share',
    ]) {
      expect(MIGRATION_CLASSIFICATION_BY_STORE_NAME.get(storeName)?.verdict, storeName).toBe('copy');
    }
  });

  it('classifies token, cloud identity, transient, and special stores by policy', () => {
    expect(MIGRATION_CLASSIFICATION_BY_STORE_NAME.get('codex-oauth-tokens')?.verdict).toBe('exclude-keychain');
    expect(MIGRATION_CLASSIFICATION_BY_STORE_NAME.get('cloud-service-client-id')?.verdict).toBe('exclude-cloud');
    expect(MIGRATION_CLASSIFICATION_BY_STORE_NAME.get('analytics-storage')?.verdict).toBe('exclude-cloud');
    expect(MIGRATION_CLASSIFICATION_BY_STORE_NAME.get('staged-tool-calls')?.verdict).toBe('exclude-transient');
    expect(MIGRATION_CLASSIFICATION_BY_STORE_NAME.get('app-settings')?.verdict).toBe('special');
  });
});
