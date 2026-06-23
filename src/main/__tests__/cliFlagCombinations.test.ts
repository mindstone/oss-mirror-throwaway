import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings } from '@shared/types';
import { setCodexAuthProvider } from '@core/codexAuth';
import { initCliRuntime, runCli } from '../cli';

const makeSettings = (): AppSettings =>
  ({
    coreDirectory: '/tmp/workspace',
    activeProvider: 'anthropic',
    claude: { apiKey: 'test-key' },
    models: { apiKey: 'test-key' },
    openRouter: { enabled: false, oauthToken: 'openrouter-token' },
    localModel: { profiles: [], activeProfileId: null },
  }) as unknown as AppSettings;

describe('CLI flag combinations', () => {
  let stderrWrites: string[];

  beforeEach(() => {
    stderrWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    setCodexAuthProvider({
      isConnected: () => true,
      getAccessToken: async () => 'codex-token',
      getAccountId: () => 'account',
      forceRefreshToken: async () => 'codex-token',
      getStatus: () => ({ connected: true }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [['--council', '--private', '--provider', 'anthropic', '--effort', 'low']],
    [['--unleashed', '--private', '--provider', 'openrouter', '--effort', 'medium']],
    [['--private', '--provider', 'codex', '--effort', 'high']],
    [['--council', '--unleashed', '--provider', 'anthropic', '--effort', 'xhigh']],
  ])('parses valid combination %j', async (flags) => {
    const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
    });
    initCliRuntime({
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: makeSettings,
      appVersion: 'test',
    });

    const exitCode = await runCli(['run', '--prompt', 'Hello', ...flags]);

    expect(exitCode).toBe(0);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
  });

  it('fails invalid effort values at parse time', async () => {
    const runHeadlessTurn = vi.fn();
    initCliRuntime({
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: makeSettings,
      appVersion: 'test',
    });

    const exitCode = await runCli(['run', '--prompt', 'Hello', '--effort', 'extreme']);

    expect(exitCode).not.toBe(0);
    expect(runHeadlessTurn).not.toHaveBeenCalled();
  });

  it('fails council mode with Codex provider with a clear message', async () => {
    const runHeadlessTurn = vi.fn();
    initCliRuntime({
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: makeSettings,
      appVersion: 'test',
    });

    const exitCode = await runCli(['run', '--prompt', 'Hello', '--council', '--provider', 'codex']);

    expect(exitCode).toBe(1);
    expect(stderrWrites.join('')).toContain('--council cannot be combined with --provider codex');
    expect(runHeadlessTurn).not.toHaveBeenCalled();
  });
});
