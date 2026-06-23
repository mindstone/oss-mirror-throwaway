import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { createCloudRecoveryAdapter } from '../cloudRecoveryAdapter';

describe('cloudRecoveryAdapter models namespace reads', () => {
  it('resolves long-context fallback from models namespace without legacy claude namespace', () => {
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: () => ({
        modelsNamespaceSchemaVersion: 2,
        models: {
          longContextFallbackProfileId: 'profile-models',
          longContextFallbackModel: 'claude-models',
        },
        localModel: {
          activeProfileId: null,
          profiles: [{
            id: 'profile-models',
            name: 'Models Profile',
            model: 'claude-opus-4-7',
            createdAt: 1,
          }],
        },
      } as unknown as AppSettings),
    });

    const target = adapter.resolveLongContextFallbackTarget();
    expect(target).toMatchObject({
      kind: 'profile',
      profileId: 'profile-models',
      modelName: 'claude-opus-4-7',
    });
    
    const pref = adapter.getRecoveryProfilePreference();
    expect(pref).toEqual({ profileId: 'profile-models', configuredId: 'profile-models' });
  });

  it('ignores claude namespace when models namespace is absent', () => {
    const adapter = createCloudRecoveryAdapter({
      win: null,
      executeAgentTurn: vi.fn(),
      getSettings: () => ({
        claude: {
          longContextFallbackProfileId: 'profile-legacy',
          longContextFallbackModel: 'claude-legacy',
        },
        localModel: {
          activeProfileId: null,
          profiles: [{
            id: 'profile-legacy',
            name: 'Legacy Profile',
            model: 'claude-sonnet-4-6',
            createdAt: 1,
          }],
        },
      } as unknown as AppSettings),
    });

    const target = adapter.resolveLongContextFallbackTarget();
    expect(target).toBeNull();
    
    const pref = adapter.getRecoveryProfilePreference();
    expect(pref).toEqual({ profileId: null, configuredId: null });
  });
});
