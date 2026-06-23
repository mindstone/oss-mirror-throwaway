import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import { migrateClaudeToModelsNamespace } from '../settingsStore';
import { getApiKey, getWorkingProfileId } from '@core/rebelCore/settingsAccessors';

describe('settingsStore models namespace migration cross-surface matrix', () => {
  it('row (a): fresh models.* install', () => {
    const settings: AppSettings = {
      modelsNamespaceSchemaVersion: 1,
      models: {
        apiKey: 'fake-ant-key',
        workingProfileId: 'profile-models-working',
      }
    } as unknown as AppSettings;
    
    const { migrated, changes } = migrateClaudeToModelsNamespace(settings);
    expect(migrated).toBe(true);
    expect(changes.modelsNamespaceSchemaVersion).toBe(2);
    expect(changes.models?.apiKey).toBe('fake-ant-key');
    expect(changes.models?.workingProfileId).toBe('profile-models-working');
    expect(getApiKey(settings)).toBe('fake-ant-key');
  });

  it('row (b): post-migration claude.* -> models.*', () => {
    const settings: AppSettings = {
      claude: {
        apiKey: 'fake-legacy-key',
        workingProfileId: 'profile-legacy-working',
      }
    } as unknown as AppSettings;
    
    const { migrated, changes } = migrateClaudeToModelsNamespace(settings);
    expect(migrated).toBe(true);
    expect(changes.modelsNamespaceSchemaVersion).toBe(2);
    expect(changes.models?.apiKey).toBe('fake-legacy-key');
    expect(changes.models?.workingProfileId).toBe('profile-legacy-working');
    
    const nextSettings = { ...settings, ...changes };
    expect(getApiKey(nextSettings)).toBe('fake-legacy-key');
  });

  it('row (c): divergent activeProvider + persisted profile shapes', () => {
    const settings: AppSettings = {
      activeProvider: 'codex', // Differs from migrated namespaces
      claude: {
        apiKey: 'fake-ant-key',
      }
    } as unknown as AppSettings;
    
    const { migrated, changes } = migrateClaudeToModelsNamespace(settings);
    expect(migrated).toBe(true);
    expect(changes.models?.apiKey).toBe('fake-ant-key');
    
    const nextSettings = { ...settings, ...changes };
    expect(nextSettings.activeProvider).toBe('codex'); // Provider unchanged
    expect(getApiKey(nextSettings)).toBe('fake-ant-key');
  });

  it('row (d): cloud-only models.* (desktop receives cloud settings with models but no claude)', () => {
    const settings: AppSettings = {
      modelsNamespaceSchemaVersion: 1,
      models: {
        apiKey: 'fake-cloud-key',
      }
    } as unknown as AppSettings;
    
    const { migrated, changes } = migrateClaudeToModelsNamespace(settings);
    expect(migrated).toBe(true);
    expect(changes.modelsNamespaceSchemaVersion).toBe(2);
    expect(changes.models?.apiKey).toBe('fake-cloud-key');
    expect(getApiKey(settings)).toBe('fake-cloud-key');
  });

  it('row (e): desktop-only models.* (desktop has models, cloud has only claude, merged into desktop)', () => {
    // Note: if desktop has models.* and schema version 1, the migration returns no changes.
    // The accessors should prefer models over claude.
    const settings: AppSettings = {
      modelsNamespaceSchemaVersion: 1,
      models: {
        apiKey: 'fake-desktop-key',
      },
      claude: {
        apiKey: 'fake-cloud-legacy-key',
      }
    } as unknown as AppSettings;
    
    const { migrated, changes } = migrateClaudeToModelsNamespace(settings);
    expect(migrated).toBe(true);
    expect(changes.modelsNamespaceSchemaVersion).toBe(2);
    expect(changes.models?.apiKey).toBe('fake-desktop-key');
    expect(getApiKey({ ...settings, ...changes })).toBe('fake-desktop-key'); // Accessor prioritizes models
  });

  it('row (f): already-v2 models namespace is a no-op', () => {
    const settings: AppSettings = {
      modelsNamespaceSchemaVersion: 2,
      models: {
        apiKey: 'fake-v2-key',
      },
      claude: {
        apiKey: 'fake-legacy-key',
      }
    } as unknown as AppSettings;

    const { migrated, changes } = migrateClaudeToModelsNamespace(settings);
    expect(migrated).toBe(false);
    expect(changes).toEqual({});
  });
});
