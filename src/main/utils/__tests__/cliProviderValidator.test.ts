import { afterEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { ActiveProvider } from '@shared/types/settings';
import { validateProviderCredentials } from '@core/utils/validateProviderCredentials';
import { buildSettingsWithOverride } from '@main/services/turnPipeline/turnAdmission';
import { validateProviderFlag } from '../cliProviderValidator';

const makeSettings = (overrides: Partial<AppSettings> = {}): AppSettings =>
  ({
    coreDirectory: '/workspace',
    activeProvider: 'anthropic',
    claude: { apiKey: null },
    models: { apiKey: null },
    localModel: { profiles: [], activeProfileId: null },
    openRouter: { enabled: false, oauthToken: null },
    ...overrides,
  }) as AppSettings;

describe('validateProviderFlag', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it.each([
    ['anthropic', makeSettings({ models: { apiKey: 'fake-anthropic-key' } as AppSettings['models'] }), false, true],
    ['anthropic', makeSettings({ claude: { apiKey: null } as AppSettings['claude'] }), false, false],
    [
      'openrouter',
      makeSettings({ openRouter: { enabled: false, oauthToken: 'or-token' } as AppSettings['openRouter'] }),
      false,
      true,
    ],
    [
      'openrouter',
      makeSettings({ openRouter: { enabled: false, oauthToken: null } as AppSettings['openRouter'] }),
      false,
      false,
    ],
    ['codex', makeSettings(), true, true],
    ['codex', makeSettings(), false, false],
  ] as Array<[ActiveProvider, AppSettings, boolean, boolean]>)(
    'validates %s credential shape',
    (provider, rawSettings, codexConnected, expectedOk) => {
      const result = validateProviderFlag({ provider, rawSettings, codexConnected });

      expect(result.ok).toBe(expectedOk);
      if (result.ok === false) {
        expect(result.reason).toContain('Settings → AI & Models');
      }
    },
  );

  it('matches admission credential validation after applying provider override settings transform', () => {
    const rawSettings = makeSettings({
      activeProvider: 'anthropic',
      models: { apiKey: 'fake-anthropic-key' } as AppSettings['models'],
      openRouter: { enabled: false, oauthToken: null } as AppSettings['openRouter'],
    });

    const transformed = buildSettingsWithOverride(rawSettings, 'openrouter');
    const admissionState = validateProviderCredentials(transformed, false);
    const cliState = validateProviderFlag({
      provider: 'openrouter',
      rawSettings,
      codexConnected: false,
    });

    expect(admissionState).toEqual({ kind: 'openrouter', status: 'missing' });
    expect(cliState.ok).toBe(false);
  });
});
