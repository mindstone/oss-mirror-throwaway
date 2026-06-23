import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { setCodexAuthProvider } from '@core/codexAuth';
import { initCliRuntime, runCli } from '../../../src/main/cli';

const makeSettings = (): AppSettings =>
  ({
    coreDirectory: '/tmp/workspace',
    activeProvider: 'anthropic',
    models: { apiKey: 'test-key' },
    claude: { apiKey: 'test-key' },
    openRouter: { enabled: true, oauthToken: 'openrouter-token' },
    localModel: { profiles: [], activeProfileId: null },
  }) as unknown as AppSettings;

describe('standalone Codex chat guard', () => {
  let stderrWrites: string[];

  beforeEach(() => {
    process.env.REBEL_SURFACE = 'cli-standalone';
    process.env.REBEL_CODEX_TOKEN = 'codex-token';
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    setCodexAuthProvider({
      isConnected: () => true,
      getAccessToken: async () => 'codex-token',
      getAccountId: () => null,
      forceRefreshToken: async () => 'codex-token',
      getStatus: () => ({ connected: true }),
    });
  });

  afterEach(() => {
    delete process.env.REBEL_SURFACE;
    delete process.env.REBEL_CODEX_TOKEN;
    vi.restoreAllMocks();
  });

  it('refuses long-running Codex chat in standalone CLI', async () => {
    const runHeadlessTurn = vi.fn();
    initCliRuntime({
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: makeSettings,
      appVersion: 'test',
    });

    const exitCode = await runCli(['chat', '--provider', 'codex']);

    expect(exitCode).toBe(1);
    expect(stderrWrites.join('')).toContain('short-session-only');
    expect(runHeadlessTurn).not.toHaveBeenCalled();
  });
});
