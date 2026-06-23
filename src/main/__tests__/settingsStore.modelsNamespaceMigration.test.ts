import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { MODEL_SETTINGS_FIELD_KEYS } from '@shared/utils/modelSettingsResolver';

/**
 * Stage 1 invariants coverage map (docs/plans/260504_unified_provider_model_presentation.md § Invariants):
 * 1. Profile IDs unchanged — this file, test "preserves activeProvider and profile IDs..." (lines ~110-140).
 * 2. activeProvider unchanged — this file, same test as #1 (lines ~110-140).
 * 3. Cost-ledger auth tags unchanged — src/main/services/__tests__/agentTurnExecutor.authTagging.test.ts
 *    (AuthTaggingScenario matrix + tags assertions, lines ~365-466).
 * 4. resolveTurnAuthLabelFromRoutePlan stays route-plan driven — same authTagging suite
 *    (drift cases + resolvedAuthLabel assertions, lines ~500-565).
 * 5. Billing source tags unchanged — src/shared/utils/__tests__/billingSource.test.ts
 *    (resolveBillingSourceForProfile cases, lines ~210-227).
 * 6. Codex repair migration unchanged — src/main/__tests__/settingsStore.codexProviderRepairMigration.test.ts
 *    (existing explicit suite; invariant already covered before this follow-up).
 * 7. __virtual-thinking / __virtual-working IDs preserved — src/shared/utils/__tests__/settingsUtils.test.ts
 *    (virtual-profile migration assertions, lines ~626-630 and ~1328-1332).
 * 8. OAuth deprecation fields migrate unchanged — this file, test "copies OAuth deprecation artifacts..." (lines ~165-210).
 * 9. CLOUD_CHANNEL_POLICIES.settings:update remains dual-write — src/shared/__tests__/cloudChannelPolicies.test.ts
 *    (dual-write channel expectations include settings:update, lines ~58-87).
 * 10. Renderer write paths use models (no claude write-shadow) — src/renderer/features/settings/hooks/__tests__/useSettingsFeature.modelsWriteIsolation.test.ts
 *     (updateClaude mutates models while claude stays unchanged, lines ~80-110).
 */

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};
let storeWriteCount = 0;

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Faithful to electron-store's `conf` bootstrap, which does a SHALLOW top-level
// merge: `Object.assign({}, defaults, fileStore)` (node_modules/conf/dist/source/index.js
// #initializeStore). A top-level key present in the file/seed (e.g. `models`) wins
// ENTIRELY — it is NOT deep-filled from defaults. A previous deep-merge here was
// unfaithful: now that DEFAULT_SETTINGS ships a `models` block, deep-merge would
// back-fill the full default `models` into partial/absent seeded `models`, defeating
// the sparse-models migration fixtures.
const shallowMerge = (
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> => ({ ...base, ...deepClone(overrides) });

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      if (persistedStore === null) {
        persistedStore = shallowMerge(deepClone(opts?.defaults ?? {}), seedStore);
      }
    }

    get store(): Record<string, unknown> {
      return deepClone(persistedStore ?? {});
    }

    set store(value: Record<string, unknown>) {
      storeWriteCount++;
      persistedStore = deepClone(value);
    }

    get(key: string): unknown {
      return (persistedStore ?? {})[key];
    }

    set(key: string, value: unknown): void {
      persistedStore = { ...(persistedStore ?? {}), [key]: deepClone(value) };
      storeWriteCount++;
    }

    delete(key: string): void {
      const next = { ...(persistedStore ?? {}) };
      delete next[key];
      persistedStore = next;
      storeWriteCount++;
    }

    clear(): void {
      persistedStore = {};
      storeWriteCount++;
    }
  },
}));

const loadSettingsStore = async (seed: Partial<AppSettings> = {}) => {
  vi.resetModules();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  storeWriteCount = 0;
  return import('../settingsStore');
};

const reloadSettingsStoreWithExistingDisk = async () => {
  vi.resetModules();
  storeWriteCount = 0;
  return import('../settingsStore');
};

describe('settingsStore models namespace migration bootstrap', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    storeWriteCount = 0;
    vi.resetModules();
  });

  it('migrates legacy claude block to models and stamps schema version', async () => {
    const { getSettings } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      openRouterProviderHealVersion: 1,
      claude: {
        apiKey: 'fake-ant-test-key',
        model: 'claude-opus-4-7',
        thinkingModel: 'claude-sonnet-4-6',
        permissionMode: 'plan',
      } as unknown as AppSettings['claude'],
    });

    const settings = getSettings();

    expect(settings.modelsNamespaceSchemaVersion).toBe(2);
    expect(settings.models?.apiKey).toBe('fake-ant-test-key');
    expect(settings.models?.model).toBe('claude-opus-4-7');
    expect(settings.models?.thinkingModel).toBe('claude-sonnet-4-6');
    expect(settings.models?.permissionMode).toBe('plan');
    expect(settings.settingsMigrationDegraded).toBeUndefined();
    // 3 writes: models namespace + OR profileSource version stamp + BTS auto-profile
    // reroute version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(3);
  });

  it('preserves activeProvider and profile IDs while migrating namespace (invariants 1 + 2)', async () => {
    const { getSettings } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      activeProvider: 'openrouter',
      claude: {
        apiKey: 'fake-ant-test-key',
        model: 'claude-opus-4-7',
      } as unknown as AppSettings['claude'],
      localModel: {
        activeProfileId: 'profile-openai-1',
        profiles: [
          {
            id: 'profile-openai-1',
            name: 'OpenAI profile',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            model: 'gpt-5.5',
            createdAt: 1,
          },
        ],
      } as unknown as AppSettings['localModel'],
    });

    const settings = getSettings();

    expect(settings.activeProvider).toBe('openrouter');
    expect(settings.localModel?.activeProfileId).toBe('profile-openai-1');
    expect(settings.localModel?.profiles.map((profile) => profile.id)).toEqual(['profile-openai-1']);
  });

  it('is idempotent after schema stamp (second load writes nothing)', async () => {
    const firstLoad = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      openRouterProviderHealVersion: 1,
      claude: {
        model: 'claude-opus-4-7',
      } as unknown as AppSettings['claude'],
    });

    const firstSettings = deepClone(firstLoad.getSettings());
    expect(firstSettings.modelsNamespaceSchemaVersion).toBe(2);
    // 3 writes: models namespace + OR profileSource version stamp + BTS auto-profile
    // reroute version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(3);

    const secondLoad = await reloadSettingsStoreWithExistingDisk();
    const secondSettings = deepClone(secondLoad.getSettings());

    expect(secondSettings).toEqual(firstSettings);
    expect(storeWriteCount).toBe(0);
  });

  it('stamps version and keeps normalized defaults when both namespaces are absent', async () => {
    const { getSettings } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      openRouterProviderHealVersion: 1,
      claude: undefined as unknown as AppSettings['claude'],
    });

    const settings = getSettings();
    expect(settings.modelsNamespaceSchemaVersion).toBe(2);
    expect(settings.models?.apiKey).toBeNull();
    expect(settings.models?.authMethod).toBe('api-key');
    expect(typeof settings.models?.model).toBe('string');
    // 3 writes: models namespace + OR profileSource version stamp + BTS auto-profile
    // reroute version stamp (260521 BTS Haiku-fallback A3).
    expect(storeWriteCount).toBe(3);
  });

  it('reruns v1 partial models migration and fills missing fields from legacy claude', async () => {
    const { getSettings } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      openRouterProviderHealVersion: 1,
      modelsNamespaceSchemaVersion: 1,
      models: {
        apiKey: 'fake-models-key',
        learnedContextWindowEnabled: false,
      } as unknown as AppSettings['models'],
      claude: {
        apiKey: 'fake-legacy-key',
        model: 'claude-opus-4-7',
        thinkingModel: 'claude-sonnet-4-6',
        workingProfileId: 'profile-legacy-working',
        learnedContextWindowEnabled: true,
        thinkingEffort: 'medium',
      } as unknown as AppSettings['claude'],
    });

    const settings = getSettings();

    expect(settings.modelsNamespaceSchemaVersion).toBe(2);
    expect(settings.models?.apiKey).toBe('fake-models-key');
    expect(settings.models?.model).toBe('claude-opus-4-7');
    expect(settings.models?.thinkingModel).toBe('claude-sonnet-4-6');
    expect(settings.models?.workingProfileId).toBe('profile-legacy-working');
    expect(settings.models?.learnedContextWindowEnabled).toBe(false);
    expect(settings.models?.thinkingEffort).toBe('medium');
    expect(settings.settingsMigrationDegraded).toBeUndefined();
  });

  it('copies OAuth deprecation artifacts into models unchanged during migration (invariant 8)', async () => {
    const { migrateClaudeToModelsNamespace } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
    });

    const result = migrateClaudeToModelsNamespace({
      claude: {
        apiKey: 'fake-ant-test-key',
        oauthToken: 'oauth-token-test',
        oauthRefreshToken: 'oauth-refresh-test',
        oauthTokenExpiresAt: 1730000000000,
        authMethod: 'oauth-token',
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: true,
        thinkingEffort: 'high',
        oauthProfile: { email: 'test@example.com', displayName: 'Test User', tier: 'max' },
        usageData: {
          fiveHour: { utilization: 0.1, resetsAt: '2026-05-01T00:00:00.000Z' },
          sevenDay: { utilization: 0.2, resetsAt: '2026-05-08T00:00:00.000Z' },
          sevenDaySonnet: { utilization: 0.3, resetsAt: '2026-05-08T00:00:00.000Z' },
          fetchedAt: 1_725_000_000_000,
        },
      } as unknown as AppSettings['claude'],
    } as AppSettings);

    expect(result.migrated).toBe(true);
    expect(result.changes.modelsNamespaceSchemaVersion).toBe(2);
    expect(result.changes.models).toMatchObject({
      oauthToken: 'oauth-token-test',
      oauthRefreshToken: 'oauth-refresh-test',
      oauthTokenExpiresAt: 1730000000000,
      oauthProfile: { email: 'test@example.com', displayName: 'Test User', tier: 'max' },
      usageData: {
        fiveHour: { utilization: 0.1, resetsAt: '2026-05-01T00:00:00.000Z' },
        sevenDay: { utilization: 0.2, resetsAt: '2026-05-08T00:00:00.000Z' },
        sevenDaySonnet: { utilization: 0.3, resetsAt: '2026-05-08T00:00:00.000Z' },
        fetchedAt: 1_725_000_000_000,
      },
    });
  });

  it('materializes every canonical model settings field during direct migration', async () => {
    const { migrateClaudeToModelsNamespace } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
    });

    const result = migrateClaudeToModelsNamespace({
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
        thinkingModel: 'claude-sonnet-4-6',
        thinkingProfileId: 'profile-thinking',
        workingProfileId: 'profile-working',
        thinkingFallback: 'profile:profile-thinking-fallback',
        workingFallback: 'profile:profile-working-fallback',
        extendedContext: true,
        learnedContextWindowEnabled: true,
        longContextFallbackModel: 'claude-haiku-4-5',
        longContextFallbackProfileId: 'profile-long-context',
        thinkingEffort: 'medium',
        modelEfforts: { 'claude-opus-4-7': 'high' },
        oauthProfile: { email: 'test@example.com', displayName: 'Test User', tier: 'max' },
        oauthMigratedAt: '2026-06-07T00:00:00.000Z',
        usageData: {
          fiveHour: { utilization: 0.1, resetsAt: '2026-05-01T00:00:00.000Z' },
          sevenDay: { utilization: 0.2, resetsAt: '2026-05-08T00:00:00.000Z' },
          sevenDaySonnet: { utilization: 0.3, resetsAt: '2026-05-08T00:00:00.000Z' },
          fetchedAt: 1_725_000_000_000,
        },
      } as unknown as AppSettings['claude'],
    } as AppSettings);

    expect(result.migrated).toBe(true);
    expect(result.changes.modelsNamespaceSchemaVersion).toBe(2);
    expect(Object.keys(result.changes.models ?? {}).sort()).toEqual([...MODEL_SETTINGS_FIELD_KEYS].sort());
    expect(result.changes.models?.learnedContextWindowEnabled).toBe(true);

    const second = migrateClaudeToModelsNamespace({
      ...result.changes,
      claude: {
        learnedContextWindowEnabled: false,
      } as unknown as AppSettings['claude'],
    } as AppSettings);
    expect(second).toEqual({ changes: {}, migrated: false });
  });
});
