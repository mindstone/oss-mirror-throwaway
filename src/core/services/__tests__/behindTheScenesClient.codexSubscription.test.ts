 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { CODEX_BTS_PROFILE_ID, CODEX_WORKING_PROFILE_ID } from '@shared/utils/codexDefaults';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { createAuthEnvUtilsMock } from '@core/utils/__tests__/authEnvUtilsMock';
import {
  expectCodexBlockedLedgerOnly,
  installCaptureAndBreadcrumbRecorder,
  resetErrorReporter,
} from './testUtils/errorReporterCapture';

const logInfoMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: logInfoMock,
    debug: logDebugMock,
    warn: logWarnMock,
    error: logErrorMock,
  }),
  // P2 fix: throwCodexDisconnectedBtsError reads turn-context sessionId for
  // per-session dedupe. Default mock returns undefined (no turn context).
  // Tests can override per-case via vi.mocked(getTurnContext).mockReturnValue(...).
  getTurnContext: vi.fn(() => undefined),
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('../codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

// F1 (plan 260422 routing-follow-ups): mock shape centralised in
// `createAuthEnvUtilsMock`. Codex tests use `hasValidAuth: false` as the
// baseline (no direct Anthropic API key configured) and
// `isDirectAnthropicConfig: true` so existing Codex-profile tests — which
// exercise the profile branch BEFORE the direct-Anthropic shortcut — keep
// working.
vi.mock('@core/utils/authEnvUtils', () =>
  createAuthEnvUtilsMock({ hasValidAuth: false, isDirectAnthropicConfig: true }),
);

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

import {
  callBehindTheScenes,
  callBehindTheScenesWithAuth,
  callWithModelAuthAware,
  CODEX_BTS_DISCONNECTED_ERROR,
  CodexDisconnectedBtsError,
  registerBtsProxyProviders,
  _resetCodexBtsCaptureDedupeForTests,
} from '../behindTheScenesClient';
// Import after vi.mock to avoid hoisting cycle: vi.mock factories are
// hoisted above imports, so importing hasValidAuth before the factory
// reference triggers "Cannot access '__vi_import_N__' before initialization".
// See behindTheScenesClient.test.ts (src/main/services/__tests__) for the
// same pattern.
import { hasValidAuth } from '@core/utils/authEnvUtils';

function createCodexProxyResponse(): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: 'response' }],
    model: 'gpt-5.4-mini',
    usage: { input_tokens: 8, output_tokens: 3 },
  }), { status: 200 });
}

function createDirectProfileResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: 'response' }, finish_reason: 'stop' }],
    model: 'gpt-5.4-mini',
    usage: { prompt_tokens: 8, completion_tokens: 3 },
  }), { status: 200 });
}

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const settings = {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    models: {
      apiKey: null,
      model: 'claude-sonnet-4-6',
    },
    behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
    providerKeys: { openai: 'fake-shared-openai' },
    localModel: {
      activeProfileId: null,
      profiles: [
        {
          id: CODEX_WORKING_PROFILE_ID,
          name: 'GPT-5.5 (ChatGPT Pro)',
          authSource: 'codex-subscription',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.5',
          createdAt: 0,
        },
        {
          id: CODEX_BTS_PROFILE_ID,
          name: 'GPT-5.4 mini (ChatGPT Pro)',
          authSource: 'codex-subscription',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.4-mini',
          createdAt: 0,
        },
      ],
    },
    ...overrides,
  } as AppSettings;

  setSettingsStoreAdapter({
    getSettings: () => settings,
    updateSettings: () => {},
    updateSettingsAtomic: () => {},
  });

  return settings;
}

async function expectChatGptProFailClosed(action: Promise<unknown>, fetchSpy: ReturnType<typeof vi.spyOn>) {
  await expect(action).rejects.toThrow(CodexDisconnectedBtsError);
  await expect(action).rejects.toThrow(/ChatGPT Pro/);
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe('CodexDisconnectedBtsError construction', () => {
  it('carries the expected message and name so IPC+UI error surfaces work', () => {
    const err = new CodexDisconnectedBtsError();
    expect(err.message).toBe(CODEX_BTS_DISCONNECTED_ERROR);
    expect(err.message).toMatch(/ChatGPT Pro/);
    expect(err.name).toBe('CodexDisconnectedBtsError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('behindTheScenesClient codex subscription routing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url === 'http://127.0.0.1:9999/v1/messages') {
        return createCodexProxyResponse();
      }
      if (url === 'https://api.anthropic.com/v1/messages') {
        return createCodexProxyResponse();
      }
      return createDirectProfileResponse();
    });
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });
    vi.mocked(hasValidAuth).mockReturnValue(false);
  });

  afterEach(() => {
    resetErrorReporter();
    _resetCodexBtsCaptureDedupeForTests();
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('routes BTS profile calls through the Codex proxy even when providerKeys.openai is set', async () => {
    const settings = createSettings();

    const result = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'connected',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    expect((init?.headers as Record<string, string>)['x-codex-turn']).toBe('true');
    expect(result._resolvedAuth).toBe('codex-subscription');
    // Plan 260429 BTS SSE fix: BTS calls must explicitly send stream:false so
    // the proxy routes through the non-streaming Codex path and returns JSON.
    const fetchBody = JSON.parse(init?.body as string) as { stream?: boolean };
    expect(fetchBody.stream).toBe(false);
  });

  it('routes auth-aware working-profile calls through the Codex proxy even when activeProvider is not codex', async () => {
    const settings = createSettings();

    const result = await callWithModelAuthAware(settings, `profile:${CODEX_WORKING_PROFILE_ID}`, {
      codexConnectivity: 'connected',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'memory' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    expect((init?.headers as Record<string, string>)['x-codex-turn']).toBe('true');
    expect(result._resolvedAuth).toBe('codex-subscription');
    // Plan 260429 BTS SSE fix: BTS calls must explicitly send stream:false.
    const fetchBody = JSON.parse(init?.body as string) as { stream?: boolean };
    expect(fetchBody.stream).toBe(false);
  });

  // REBEL-538: Anthropic-native BTS models must NOT be routed through the
  // Codex proxy — it can only serve ChatGPT/OpenAI models. When Anthropic
  // credentials exist, route through anthropic-direct instead.
  it('routes Claude BTS through Anthropic API when activeProvider=codex and Anthropic key exists (matrix row 19)', async () => {
    const settings = createSettings({
      activeProvider: 'codex' as AppSettings['activeProvider'],
      models: { apiKey: 'fake-ant-lingering-key' } as AppSettings['models'],
      behindTheScenesModel: 'claude-sonnet-4-20250514',
    });

    const result = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'connected',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('fake-ant-lingering-key');
    expect(result._resolvedAuth).toBe('api-key');
  });

  it('omits proxy identity headers for Anthropic-direct BTS dispatches even when proxy auth is available', async () => {
    const settings = createSettings({
      activeProvider: 'codex' as AppSettings['activeProvider'],
      models: { apiKey: 'fake-ant-lingering-key' } as AppSettings['models'],
      behindTheScenesModel: 'claude-sonnet-4-20250514',
    });

    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'connected',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('fake-ant-lingering-key');
    expect(headers['x-proxy-auth']).toBeUndefined();
    expect(headers['x-routed-turn-id']).toBeUndefined();
    expect(headers['x-routed-model']).toBeUndefined();
    expect(headers['x-codex-turn']).toBeUndefined();
  });

  // REBEL-538: auth-aware path — Anthropic-native models route to Anthropic API
  it('routes Claude auth-aware calls through Anthropic API when activeProvider=codex and Anthropic key exists (matrix row 19)', async () => {
    const settings = createSettings({
      activeProvider: 'codex' as AppSettings['activeProvider'],
      models: { apiKey: 'fake-ant-lingering-key' } as AppSettings['models'],
    });

    const result = await callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
      codexConnectivity: 'connected',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'memory' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(result._resolvedAuth).toBe('api-key');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('fake-ant-lingering-key');
  });

  // REBEL-538: legacy callBehindTheScenes() path — Anthropic-native models
  // route to Anthropic API (not Codex proxy) when Anthropic credentials exist.
  // Note: legacy path does NOT populate `_resolvedAuth` (only the *WithAuth /
  // *AuthAware wrappers do). We assert on Anthropic URL + x-api-key + fetch count.
  it('routes Claude BTS through Anthropic API on the legacy callBehindTheScenes() path when activeProvider=codex and Anthropic key exists (matrix row 19 — legacy)', async () => {
    const settings = createSettings({
      activeProvider: 'codex' as AppSettings['activeProvider'],
      models: { apiKey: 'fake-ant-lingering-key' } as AppSettings['models'],
      behindTheScenesModel: 'claude-sonnet-4-20250514',
    });

    await callBehindTheScenes(settings, {
      codexConnectivity: 'connected',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('fake-ant-lingering-key');
  });

  it('throws fail-closed error for a Codex BTS profile when Codex is disconnected', async () => {
    const settings = createSettings();

    await expectChatGptProFailClosed(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' }),
      fetchSpy,
    );
  });

  it('callBehindTheScenesWithAuth throws when a Codex-subscription profile is selected while codexConnected=false (even if providerKeys.openai is set)', async () => {
    const settings = createSettings({
      behindTheScenesOverrides: { safety: `profile:${CODEX_WORKING_PROFILE_ID}` },
    });

    await expectChatGptProFailClosed(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' }),
      fetchSpy,
    );
  });

  it('callWithModelAuthAware throws when a Codex-subscription profile is selected while codexConnected=false (even if providerKeys.openai is set)', async () => {
    const settings = createSettings();

    await expectChatGptProFailClosed(
      callWithModelAuthAware(settings, `profile:${CODEX_WORKING_PROFILE_ID}`, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'memory' }),
      fetchSpy,
    );
  });

  it('callBehindTheScenes throws when a Codex-subscription profile is the global BTS model while codexConnected=false', async () => {
    const settings = createSettings();

    await expectChatGptProFailClosed(
      callBehindTheScenes(settings, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' }),
      fetchSpy,
    );
  });

  it('throwCodexDisconnectedBtsError is ledger-only: no ErrorReporter capture, skip breadcrumb instead', async () => {
    const settings = createSettings();
    const { captured, breadcrumbs } = installCaptureAndBreadcrumbRecorder();
    _resetCodexBtsCaptureDedupeForTests();

    let thrown: Error | null = null;
    try {
      await callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(CodexDisconnectedBtsError);
    expect(thrown?.message).toMatch(/ChatGPT Pro/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // 260610 improve-sentry-noise Stage 4: codex_disconnected_bts is
    // sink: 'ledger-only' in KNOWN_CONDITIONS — the wrapper skips the Sentry
    // capture entirely (no event minted → the 260427 fragmentation/level
    // concerns are moot) and emits a skip breadcrumb + ledger entry instead.
    expectCodexBlockedLedgerOnly(captured, breadcrumbs);
  });

  it('Stage 4 sink policy: throwCodexDisconnectedBtsError flows through captureKnownCondition; the skip breadcrumb carries the extra context', async () => {
    // Successor of the 260427 fingerprint-shape regression test: the wrapper
    // still receives the call (the registry owns the policy), but the
    // ledger-only sink means the observable is the skip breadcrumb, which
    // must carry the caller-supplied `extra` (the ledger keeps only
    // {condition, level}).
    const { getTurnContext } = await import('@core/logger');
    const settings = createSettings();
    const { captured, breadcrumbs } = installCaptureAndBreadcrumbRecorder();
    _resetCodexBtsCaptureDedupeForTests();
    vi.mocked(getTurnContext).mockReturnValue({ sessionId: 's1', turnId: 't1' });

    let thrown: Error | null = null;
    try {
      await callBehindTheScenes(settings, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'memory' });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(CodexDisconnectedBtsError);
    expect(captured).toHaveLength(0);
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]).toEqual({
      category: 'known_condition',
      message: 'codex_disconnected_bts',
      level: 'info',
      data: {
        codexConnected: false,
        sessionId: 's1',
        condition: 'codex_disconnected_bts',
        sink: 'ledger-only',
      },
    });
  });

  it('Stage 4: dedupe gate preserved across the wrapper — unscoped 5-min time-window with mocked clock', async () => {
    // Regression test: shouldCaptureCodexBtsDisconnect must still throttle
    // the wrapper. With the ledger-only sink the per-call observable is the
    // skip breadcrumb. Without a turn-scoped sessionId, the gate uses a
    // 5-min unscoped window. 1st call passes the gate, 2nd within window is
    // suppressed (no wrapper invocation), 3rd after window passes again.
    const { getTurnContext } = await import('@core/logger');
    const settings = createSettings();
    const { captured, breadcrumbs } = installCaptureAndBreadcrumbRecorder();
    _resetCodexBtsCaptureDedupeForTests();
    vi.mocked(getTurnContext).mockReturnValue(undefined);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
      try {
        await callBehindTheScenesWithAuth(settings, {
          codexConnectivity: 'disconnected',
          messages: [{ role: 'user', content: 'test' }],
        }, { category: 'safety' });
      } catch { /* expected throw */ }
      expect(breadcrumbs).toHaveLength(1);

      vi.setSystemTime(new Date('2026-05-03T00:04:00Z'));
      try {
        await callBehindTheScenesWithAuth(settings, {
          codexConnectivity: 'disconnected',
          messages: [{ role: 'user', content: 'test' }],
        }, { category: 'safety' });
      } catch { /* expected throw */ }
      expect(breadcrumbs).toHaveLength(1);

      vi.setSystemTime(new Date('2026-05-03T00:06:00Z'));
      try {
        await callBehindTheScenesWithAuth(settings, {
          codexConnectivity: 'disconnected',
          messages: [{ role: 'user', content: 'test' }],
        }, { category: 'safety' });
      } catch { /* expected throw */ }
      expect(breadcrumbs).toHaveLength(2);

      // Ledger-only: at no point did anything reach the issue stream.
      expect(captured).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('time-based rate limit: repeated disconnects outside a turn context only pass the gate once per window', async () => {
    const settings = createSettings();
    const { captured, breadcrumbs } = installCaptureAndBreadcrumbRecorder();
    _resetCodexBtsCaptureDedupeForTests();

    // Call repeatedly without a turn context (no runWithTurnContext wrapper).
    for (let i = 0; i < 5; i++) {
      try {
        await callBehindTheScenesWithAuth(settings, {
          codexConnectivity: 'disconnected',
          messages: [{ role: 'user', content: 'test' }],
        }, { category: 'safety' });
      } catch { /* expected throw each time */ }
    }

    // First call passes the gate (one skip breadcrumb); subsequent calls
    // within the rate-limit window do not. Nothing ever reaches Sentry.
    expect(breadcrumbs).toHaveLength(1);
    expect(captured).toHaveLength(0);
  });

  it('per-session dedupe: same sessionId passes the gate once, different sessionIds pass separately', async () => {
    // Per GPT-5.5 review: explicit per-session-scope coverage.
    const { getTurnContext } = await import('@core/logger');
    const settings = createSettings();
    const { captured, breadcrumbs } = installCaptureAndBreadcrumbRecorder();
    _resetCodexBtsCaptureDedupeForTests();

    // Session A — call 3 times.
    vi.mocked(getTurnContext).mockReturnValue({ sessionId: 'session-a', turnId: 't1' });
    for (let i = 0; i < 3; i++) {
      try {
        await callBehindTheScenesWithAuth(settings, {
          codexConnectivity: 'disconnected',
          messages: [{ role: 'user', content: 'test' }],
        }, { category: 'safety' });
      } catch { /* expected throw */ }
    }
    expect(breadcrumbs).toHaveLength(1); // only first call within session-a passed the gate

    // Session B — independent pass allowed.
    vi.mocked(getTurnContext).mockReturnValue({ sessionId: 'session-b', turnId: 't2' });
    try {
      await callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' });
    } catch { /* expected throw */ }
    expect(breadcrumbs).toHaveLength(2);

    // Repeat session-b — still deduped.
    try {
      await callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' });
    } catch { /* expected throw */ }
    expect(breadcrumbs).toHaveLength(2);

    // Ledger-only: the issue stream stayed clean throughout.
    expect(captured).toHaveLength(0);
  });

  it('fails closed when activeProvider is codex but codexConnectivity=disconnected in callBehindTheScenesWithAuth', async () => {
    const settings = createSettings();
    settings.activeProvider = 'codex';
    settings.behindTheScenesModel = 'gpt-5.4-mini';
    settings.models!.apiKey = 'fake-ant-fallback';
    vi.mocked(hasValidAuth).mockReturnValue(true);

    await expect(callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' }))
      .rejects.toThrow('ChatGPT Pro is not connected');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when activeProvider is codex but codexConnectivity=disconnected in callWithModelAuthAware', async () => {
    const settings = createSettings();
    settings.activeProvider = 'codex';
    settings.models!.apiKey = 'fake-ant-fallback';
    vi.mocked(hasValidAuth).mockReturnValue(true);

    await expect(callWithModelAuthAware(settings, 'gpt-5.4-mini', {
        codexConnectivity: 'disconnected',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'memory' }))
      .rejects.toThrow('ChatGPT Pro is not connected');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
