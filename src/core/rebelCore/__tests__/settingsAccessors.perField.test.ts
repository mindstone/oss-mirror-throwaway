import { describe, expect, it } from 'vitest';
import type { ModelSettingsAccessorSettings } from '../settingsAccessors';
import {
  getApiKey,
  getAuthMethod,
  getContextOverflowFallbackModel,
  getContextOverflowFallbackProfileId,
  getCurrentModel,
  getExecutablePath,
  getExtendedContext,
  getOAuthToken,
  getPermissionMode,
  getPlanMode,
  getThinkingFallback,
  resolveModelSettings,
  getThinkingModel,
  getThinkingProfileId,
  getWorkingFallback,
  getWorkingProfileId,
} from '../settingsAccessors';

type AccessorCase = {
  name: string;
  read: (settings: ModelSettingsAccessorSettings) => unknown;
  modelsValue: unknown;
  legacyValue: unknown;
};

const ACCESSOR_CASES: AccessorCase[] = [
  { name: 'model', read: getCurrentModel, modelsValue: 'claude-opus-4-7', legacyValue: 'claude-sonnet-4-6' },
  { name: 'thinkingModel', read: getThinkingModel, modelsValue: 'claude-opus-4-7', legacyValue: 'claude-haiku-4-5' },
  { name: 'workingProfileId', read: getWorkingProfileId, modelsValue: 'profile-new-working', legacyValue: 'profile-old-working' },
  { name: 'thinkingProfileId', read: getThinkingProfileId, modelsValue: 'profile-new-thinking', legacyValue: 'profile-old-thinking' },
  { name: 'thinkingFallback', read: getThinkingFallback, modelsValue: 'model:claude-opus-4-7', legacyValue: 'model:claude-sonnet-4-6' },
  { name: 'workingFallback', read: getWorkingFallback, modelsValue: 'model:claude-sonnet-4-6', legacyValue: 'model:claude-haiku-4-5' },
  { name: 'longContextFallbackModel', read: getContextOverflowFallbackModel, modelsValue: 'claude-opus-4-7', legacyValue: 'claude-sonnet-4-6' },
  { name: 'longContextFallbackProfileId', read: getContextOverflowFallbackProfileId, modelsValue: 'profile-new-long', legacyValue: 'profile-old-long' },
  { name: 'apiKey', read: getApiKey, modelsValue: 'fake-ant-models', legacyValue: 'fake-ant-legacy' },
  { name: 'oauthToken', read: getOAuthToken, modelsValue: 'oauth-models', legacyValue: 'oauth-legacy' },
  { name: 'authMethod', read: getAuthMethod, modelsValue: 'oauth-token', legacyValue: 'api-key' },
  { name: 'permissionMode', read: getPermissionMode, modelsValue: 'plan', legacyValue: 'bypassPermissions' },
  { name: 'planMode', read: getPlanMode, modelsValue: true, legacyValue: false },
  { name: 'executablePath', read: getExecutablePath, modelsValue: '/models/path', legacyValue: '/legacy/path' },
  { name: 'extendedContext', read: getExtendedContext, modelsValue: true, legacyValue: false },
];

const makeSettings = (
  models: Record<string, unknown> | null | undefined,
  claude: Record<string, unknown> | null | undefined,
): ModelSettingsAccessorSettings => ({
  ...(models !== undefined ? { models } : {}),
  ...(claude !== undefined ? { claude } : {}),
});

describe('settingsAccessors per-field models namespace shadowing', () => {
  it('ignores legacy per field when models key is absent', () => {
    for (const testCase of ACCESSOR_CASES) {
      const settings = makeSettings({}, { [testCase.name]: testCase.legacyValue });
      expect(testCase.read(settings), `${testCase.name} should ignore legacy value`).toBeUndefined();
    }
  });

  it('resolves each field independently from partial models docs only', () => {
    const settings = makeSettings(
      { workingProfileId: 'profile-models-only' },
      {
        workingProfileId: 'profile-legacy',
        model: 'claude-sonnet-4-6',
      },
    );

    expect(getWorkingProfileId(settings)).toBe('profile-models-only');
    expect(getCurrentModel(settings)).toBeUndefined();
  });

  it('resolveModelSettings reads partial models docs without legacy fallback', () => {
    const settings = makeSettings(
      {
        workingProfileId: 'profile-models-only',
      },
      {
        workingProfileId: 'profile-legacy',
        model: 'claude-sonnet-4-6',
      },
    );

    expect(resolveModelSettings(settings)).toMatchObject({
      workingProfileId: 'profile-models-only',
    });
    expect(resolveModelSettings(settings).model).toBeUndefined();
  });

  it('invariant 12: present-null in models is authoritative and does not resurrect legacy values', () => {
    const settings = makeSettings(
      { apiKey: null },
      { apiKey: 'fake-ant-legacy-stale' },
    );
    expect(getApiKey(settings)).toBeNull();
  });

  it('resolveModelSettings preserves present-null values from models as authoritative clears', () => {
    const settings = makeSettings(
      { apiKey: null },
      { apiKey: 'fake-ant-legacy-stale' },
    );

    expect(resolveModelSettings(settings).apiKey).toBeNull();
  });

  it('empty models object does not fall through to legacy value', () => {
    const settings = makeSettings(
      {},
      { apiKey: 'fake-ant-legacy' },
    );
    expect(getApiKey(settings)).toBeUndefined();
  });

  it('prefers models value when both namespaces define the same key', () => {
    for (const testCase of ACCESSOR_CASES) {
      const settings = makeSettings(
        { [testCase.name]: testCase.modelsValue },
        { [testCase.name]: testCase.legacyValue },
      );
      expect(testCase.read(settings), `${testCase.name} should prefer models namespace`).toEqual(testCase.modelsValue);
    }
  });

  it('treats malformed models block as absent without falling through to legacy', () => {
    const settings = makeSettings(
      ['malformed'] as unknown as Record<string, unknown>,
      { model: 'claude-sonnet-4-6' },
    );
    expect(getCurrentModel(settings)).toBeUndefined();
  });
});
