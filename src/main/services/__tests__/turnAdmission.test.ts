 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { AdmissionInput } from '../turnPipeline/turnAdmission';

const {
  getSettingsMock,
  codexIsConnectedMock,
  listSessionsMock,
  recordSessionTurnMock,
  hasSessionHadTurnsMock,
  setRendererSessionMock,
  clearExtendedContextFailedMock,
  setTurnPrivateModeMock,
  setTurnCategoryMock,
  setTurnLoggerMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  chatSessionCreatedMock,
  startCheckpointingMock,
  getTurnCheckpointManagerMock,
  clearPendingApprovalsForSessionMock,
  clearSchemaGateSessionMock,
  stripDesignContextCommandMock,
  stripOurComponentsCommandMock,
  makeSyntheticResultMock,
} = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  codexIsConnectedMock: vi.fn(),
  listSessionsMock: vi.fn(),
  recordSessionTurnMock: vi.fn(),
  hasSessionHadTurnsMock: vi.fn(),
  setRendererSessionMock: vi.fn(),
  clearExtendedContextFailedMock: vi.fn(),
  setTurnPrivateModeMock: vi.fn(),
  setTurnCategoryMock: vi.fn(),
  setTurnLoggerMock: vi.fn(),
  dispatchAgentEventMock: vi.fn(),
  dispatchAgentErrorEventMock: vi.fn(),
  chatSessionCreatedMock: vi.fn(),
  startCheckpointingMock: vi.fn(),
  getTurnCheckpointManagerMock: vi.fn(),
  clearPendingApprovalsForSessionMock: vi.fn(),
  clearSchemaGateSessionMock: vi.fn(),
  stripDesignContextCommandMock: vi.fn(),
  stripOurComponentsCommandMock: vi.fn(),
  makeSyntheticResultMock: vi.fn(),
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ surface: 'desktop' })),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: getSettingsMock,
}));

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: codexIsConnectedMock,
  })),
}));

vi.mock('@core/services/turnCheckpointService', () => ({
  getTurnCheckpointManager: getTurnCheckpointManagerMock,
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    recordSessionTurn: recordSessionTurnMock,
    hasSessionHadTurns: hasSessionHadTurnsMock,
    setRendererSession: setRendererSessionMock,
    clearExtendedContextFailed: clearExtendedContextFailedMock,
    setTurnPrivateMode: setTurnPrivateModeMock,
    setTurnCategory: setTurnCategoryMock,
    setTurnLogger: setTurnLoggerMock,
  },
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('../agentTurnCleanup', () => ({
  makeSyntheticResult: makeSyntheticResultMock,
}));

vi.mock('../../tracking', () => ({
  mainTracking: {
    chatSessionCreated: chatSessionCreatedMock,
  },
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    listSessions: listSessionsMock,
  })),
}));

vi.mock('../toolSafetyService', () => ({
  cleanupSessionPendingApprovals: clearPendingApprovalsForSessionMock,
}));

vi.mock('../schemaGateHook', () => ({
  clearSchemaGateSession: clearSchemaGateSessionMock,
}));

vi.mock('../designContextService', () => ({
  stripDesignContextCommand: stripDesignContextCommandMock,
}));

vi.mock('../ourComponentsContextService', () => ({
  stripOurComponentsCommand: stripOurComponentsCommandMock,
}));

import { admit, buildSettingsWithOverride } from '../turnPipeline/turnAdmission';
import { classifyErrorUx } from '@rebel/shared/utils/classifyErrorUx';
import type { AgentErrorKind } from '@rebel/shared/utils/agentErrorCatalog';

/**
 * Reads the `errorKindOverride` actually dispatched by admission for the most
 * recent `dispatchAgentErrorEvent` call, then renders the user-facing toast via
 * the real `classifyErrorUx`. The whole point of these tests is to assert on the
 * STRING THE USER SEES, not the internal errorKind literal — the bug shipped
 * precisely because the only tests pinned the internal token.
 */
function renderToastForLatestDispatch(
  rawMessage: string,
  settingsContext?: Parameters<typeof classifyErrorUx>[0]['settingsContext'],
) {
  const calls = dispatchAgentErrorEventMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const opts = calls[calls.length - 1][3] as { errorKindOverride?: AgentErrorKind } | undefined;
  const errorKind: AgentErrorKind = opts?.errorKindOverride ?? 'unknown';
  return classifyErrorUx({ errorKind, rawMessage, settingsContext });
}

type AdmissionMatrixScenario = {
  provider: NonNullable<AppSettings['activeProvider']>;
  credentials: 'valid' | 'missing' | 'n/a';
  codexConnected: boolean;
  profile?: 'local';
  expected: 'admit' | 'missing-auth' | 'openrouter-not-connected' | 'codex-not-connected';
};

const SCENARIOS: AdmissionMatrixScenario[] = [
  { provider: 'anthropic', credentials: 'valid', codexConnected: false, expected: 'admit' },
  { provider: 'anthropic', credentials: 'missing', codexConnected: false, expected: 'missing-auth' },
  { provider: 'openrouter', credentials: 'valid', codexConnected: false, expected: 'admit' },
  { provider: 'openrouter', credentials: 'missing', codexConnected: false, expected: 'openrouter-not-connected' },
  { provider: 'codex', credentials: 'n/a', codexConnected: true, expected: 'admit' },
  { provider: 'codex', credentials: 'n/a', codexConnected: false, expected: 'codex-not-connected' },
  // local-profile scenarios — admits regardless
  { provider: 'codex', credentials: 'n/a', codexConnected: false, profile: 'local', expected: 'admit' },
  { provider: 'anthropic', credentials: 'missing', codexConnected: false, profile: 'local', expected: 'admit' },
];

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const base = {
    coreDirectory: '/core',
    activeProvider: 'anthropic',
    claude: {
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      workingProfileId: 'codex-working',
      thinkingProfileId: 'codex-thinking',
    },
    models: {
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      workingProfileId: 'codex-working',
      thinkingProfileId: 'codex-thinking',
    },
    localModel: {
      profiles: [{ id: 'legacy-profile', name: 'Legacy', model: 'legacy-model', provider: 'anthropic' }],
      activeProfileId: 'legacy-profile',
    },
    openRouter: {
      enabled: false,
      oauthToken: 'openrouter-token',
    },
    ...overrides,
  } as unknown as AppSettings;

  if (Object.hasOwn(overrides, 'claude') && overrides.claude && !Object.hasOwn(overrides, 'models')) {
    base.models = { ...base.models, ...overrides.claude } as AppSettings['models'];
  }

  return base;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  const abortController = overrides.abortController ?? new AbortController();
  return {
    turnId: 'turn-1',
    win: null,
    prompt: 'Hello',
    abortController,
    rendererSessionId: 'session-1',
    turnOptions: { sessionId: 'session-1', resetConversation: false },
    ...overrides,
  };
}

async function runAdmission(inputOverrides: Partial<AdmissionInput> = {}) {
  const input = makeInput(inputOverrides);
  const logger = makeLogger();
  const result = await admit(input, input.abortController.signal, logger as never);
  return { input, logger, result };
}

function makeSettingsForScenario(scenario: AdmissionMatrixScenario): AppSettings {
  const localProfile = {
    id: 'local-profile',
    name: 'Local profile',
    model: 'llama-local',
    providerType: 'local',
    serverUrl: 'http://localhost:11434/v1',
    createdAt: 0,
  };
  const usesLocalProfile = scenario.profile === 'local';
  const base = makeSettings();

  return makeSettings({
    activeProvider: scenario.provider,
    claude: {
      ...base.claude,
      apiKey: scenario.credentials === 'missing' ? null : 'test-key',
      workingProfileId: usesLocalProfile ? localProfile.id : undefined,
      thinkingProfileId: undefined,
    },
    localModel: usesLocalProfile
      ? { profiles: [localProfile], activeProfileId: localProfile.id }
      : { profiles: [], activeProfileId: null },
    openRouter: {
      enabled: scenario.provider === 'openrouter',
      oauthToken: scenario.credentials === 'missing' ? null : 'openrouter-token',
      selectedModel: 'openrouter/test-model',
    },
  } as Partial<AppSettings>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  getSettingsMock.mockReturnValue(makeSettings());
  codexIsConnectedMock.mockReturnValue(false);
  listSessionsMock.mockReturnValue([]);
  hasSessionHadTurnsMock.mockReturnValue(false);
  getTurnCheckpointManagerMock.mockReturnValue(null);
  makeSyntheticResultMock.mockImplementation((turnId: string, text: string, turnEndReason?: string) => ({
    type: 'result',
    turnId,
    text,
    turnEndReason,
    isSynthetic: true,
  }));
  stripDesignContextCommandMock.mockImplementation((prompt: string) => ({
    explicitRequested: false,
    sanitizedPrompt: prompt,
  }));
  stripOurComponentsCommandMock.mockImplementation((prompt: string) => ({
    explicitRequested: false,
    sanitizedPrompt: prompt,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('admit()', () => {
  describe.each(SCENARIOS)(
    'admission for $provider × $credentials × codexConnected=$codexConnected',
    (scenario) => {
      it(`returns ${scenario.expected}`, async () => {
        getSettingsMock.mockReturnValue(makeSettingsForScenario(scenario));
        codexIsConnectedMock.mockReturnValue(scenario.codexConnected);

        const { result } = await runAdmission();

        if (scenario.expected === 'admit') {
          expect(result.status).toBe('ok');
          expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
        } else {
          expect(result).toEqual({ status: 'terminal', reason: scenario.expected });
          expect(dispatchAgentErrorEventMock).toHaveBeenCalled();
        }
      });
    },
  );

  it("returns terminal 'missing-core-directory' when settings.coreDirectory is empty", async () => {
    getSettingsMock.mockReturnValue(makeSettings({ coreDirectory: '' }));

    const { result, logger } = await runAdmission();

    expect(result).toEqual({ status: 'terminal', reason: 'missing-core-directory' });
    expect(logger.warn).toHaveBeenCalledWith('Core directory not configured');
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({ message: 'Core directory is not configured.' }),
      { humanizedOverride: 'Core directory is not configured.' },
    );
    expect(stripDesignContextCommandMock).not.toHaveBeenCalled();
  });

  it("returns terminal 'openrouter-not-connected' when OpenRouter oauthToken is null", async () => {
    getSettingsMock.mockReturnValue(makeSettings({
      activeProvider: 'openrouter',
      openRouter: { enabled: true, oauthToken: null, selectedModel: 'openrouter/test-model' },
    }));

    const { result, logger } = await runAdmission();

    expect(result).toEqual({ status: 'terminal', reason: 'openrouter-not-connected' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ oauthTokenType: 'null', activeProvider: 'openrouter' }),
      'OpenRouter selected but not connected (no oauthToken) — failing closed',
    );
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        message: 'OpenRouter is disconnected. Reconnect it in Settings, or switch to another provider.',
      }),
      {
        // A never-connected provider was never contacted: not-configured, not rejected.
        errorKindOverride: 'connection-not-configured',
        humanizedOverride: 'OpenRouter is disconnected. Reconnect it in Settings, or switch to another provider.',
      },
    );
  });

  it("returns terminal 'missing-auth' when provider credentials are missing", async () => {
    getSettingsMock.mockReturnValue(makeSettings({
      claude: { ...makeSettings().models, apiKey: null, workingProfileId: undefined },
      localModel: { profiles: [], activeProfileId: null },
      openRouter: { enabled: false, oauthToken: null, selectedModel: '' },
    }));

    const { result, logger } = await runAdmission();

    expect(result).toEqual({ status: 'terminal', reason: 'missing-auth' });
    expect(logger.warn).toHaveBeenCalledWith('Authentication missing');
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({ message: 'Authentication is missing. Please add an API key in Settings.' }),
      // A *missing* key is not-configured, not rejected.
      { errorKindOverride: 'connection-not-configured' },
    );
  });

  it("returns terminal 'aborted' when AbortController fires before keyword strip", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const { result, logger } = await runAdmission({ abortController });

    expect(result).toEqual({ status: 'terminal', reason: 'aborted' });
    expect(logger.info).toHaveBeenCalledWith('Turn aborted during setup');
    expect(makeSyntheticResultMock).toHaveBeenCalledWith('turn-1', '', 'user_stopped');
    expect(dispatchAgentEventMock).toHaveBeenLastCalledWith(
      null,
      'turn-1',
      expect.objectContaining({ turnEndReason: 'user_stopped' }),
    );
    expect(stripDesignContextCommandMock).not.toHaveBeenCalled();
  });

  it("returns terminal 'aborted' with turnEndReason='superseded' when signal.reason is superseded", async () => {
    const abortController = new AbortController();
    abortController.abort('superseded');

    const { result } = await runAdmission({ abortController });

    expect(result).toEqual({ status: 'terminal', reason: 'aborted' });
    expect(makeSyntheticResultMock).toHaveBeenCalledWith('turn-1', '', 'superseded');
  });

  it('happy path: returns ok with full AdmittedTurn for new conversation with no rendererSessionId', async () => {
    const { result } = await runAdmission({
      rendererSessionId: null,
      turnOptions: undefined,
    });

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        turnId: 'turn-1',
        win: null,
        rendererSessionId: null,
        effectiveResetConversation: true,
        unleashedMode: false,
        councilModeRequested: false,
        prompts: {
          promptForContext: 'Hello',
          promptWithoutOurComponents: 'Hello',
          promptWithoutOurComponentsOrUnleashed: 'Hello',
          explicitDesignContextRequested: false,
          explicitOurComponentsRequested: false,
        },
      },
    });
    expect(recordSessionTurnMock).not.toHaveBeenCalled();
    expect(dispatchAgentEventMock).not.toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({ type: 'turn_started' }),
    );
    expect(chatSessionCreatedMock).not.toHaveBeenCalled();
  });

  it('happy path: returns ok for continuation when hasSessionHadTurns is true', async () => {
    hasSessionHadTurnsMock.mockReturnValue(true);

    const { result } = await runAdmission({
      turnOptions: { sessionId: 'session-1' },
    });

    expect(result).toMatchObject({
      status: 'ok',
      value: { effectiveResetConversation: false },
    });
    expect(recordSessionTurnMock).toHaveBeenCalledWith('session-1');
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({ type: 'turn_started' }),
    );
    expect(chatSessionCreatedMock).not.toHaveBeenCalled();
  });

  it('caller-explicit reset=true overrides session state without tracking chatSessionCreated', async () => {
    hasSessionHadTurnsMock.mockReturnValue(true);

    const { result } = await runAdmission({
      turnOptions: { sessionId: 'session-1', resetConversation: true },
    });

    expect(result).toMatchObject({
      status: 'ok',
      value: { effectiveResetConversation: true },
    });
    expect(clearExtendedContextFailedMock).toHaveBeenCalledWith('session-1');
    expect(chatSessionCreatedMock).not.toHaveBeenCalled();
  });

  it('caller-explicit reset=false preserves false even on fresh session', async () => {
    const { result } = await runAdmission({
      turnOptions: { sessionId: 'session-1', resetConversation: false },
    });

    expect(result).toMatchObject({
      status: 'ok',
      value: { effectiveResetConversation: false },
    });
    expect(hasSessionHadTurnsMock).not.toHaveBeenCalled();
    expect(listSessionsMock).not.toHaveBeenCalled();
  });

  it('activeProviderOverride rebuilds settings without mutating the original settings object', async () => {
    const rawSettings = makeSettings({
      activeProvider: 'codex',
      openRouter: { enabled: false, oauthToken: 'or-token', selectedModel: 'openrouter/test-model' },
    });
    getSettingsMock.mockReturnValue(rawSettings);

    const { result } = await runAdmission({
      turnOptions: {
        sessionId: 'session-1',
        resetConversation: false,
        activeProviderOverride: 'openrouter',
      },
    });

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        settings: {
          activeProvider: 'openrouter',
          models: {
            workingProfileId: undefined,
            thinkingProfileId: undefined,
          },
          localModel: {
            activeProfileId: null,
          },
          openRouter: {
            enabled: true,
            oauthToken: 'or-token',
          },
        },
      },
    });
    expect(rawSettings.activeProvider).toBe('codex');
    expect(rawSettings.claude!.workingProfileId).toBe('codex-working');
    expect(rawSettings.localModel?.activeProfileId).toBe('legacy-profile');
  });

  it('characterizes buildSettingsWithOverride for rate-limit provider retry targets', () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    // The Codex rate-limit waterfall feeds activeProviderOverride here; this
    // rewrite clears profile routing for every override and only force-enables
    // OpenRouter for the OpenRouter retry target.
    const rawSettings = makeSettings({
      activeProvider: 'codex',
      openRouter: { enabled: false, oauthToken: 'or-token', selectedModel: 'openrouter/test-model' },
    });

    expect((['anthropic', 'openrouter', 'mindstone'] as const).map((override) => {
      const rewritten = buildSettingsWithOverride(rawSettings, override);
      return {
        override,
        activeProvider: rewritten.activeProvider,
        model: rewritten.models?.model,
        workingProfileId: rewritten.models?.workingProfileId,
        thinkingProfileId: rewritten.models?.thinkingProfileId,
        activeProfileId: rewritten.localModel?.activeProfileId,
        openRouterEnabled: rewritten.openRouter?.enabled,
        openRouterToken: rewritten.openRouter?.oauthToken,
        originalActiveProvider: rawSettings.activeProvider,
        originalWorkingProfileId: rawSettings.claude!.workingProfileId,
      };
    })).toMatchInlineSnapshot(`
      [
        {
          "activeProfileId": null,
          "activeProvider": "anthropic",
          "model": "claude-sonnet-4-5",
          "openRouterEnabled": false,
          "openRouterToken": "or-token",
          "originalActiveProvider": "codex",
          "originalWorkingProfileId": "codex-working",
          "override": "anthropic",
          "thinkingProfileId": undefined,
          "workingProfileId": undefined,
        },
        {
          "activeProfileId": null,
          "activeProvider": "openrouter",
          "model": "claude-sonnet-4-5",
          "openRouterEnabled": true,
          "openRouterToken": "or-token",
          "originalActiveProvider": "codex",
          "originalWorkingProfileId": "codex-working",
          "override": "openrouter",
          "thinkingProfileId": undefined,
          "workingProfileId": undefined,
        },
        {
          "activeProfileId": null,
          "activeProvider": "mindstone",
          "model": "claude-sonnet-4-5",
          "openRouterEnabled": false,
          "openRouterToken": "or-token",
          "originalActiveProvider": "codex",
          "originalWorkingProfileId": "codex-working",
          "override": "mindstone",
          "thinkingProfileId": undefined,
          "workingProfileId": undefined,
        },
      ]
    `);
  });

  it("returns terminal 'codex-not-connected' when Codex is selected but disconnected (fail-closed)", async () => {
    getSettingsMock.mockReturnValue(makeSettings({ activeProvider: 'codex' }));

    const { result, logger } = await runAdmission({
      rendererSessionId: null,
      turnOptions: undefined,
    });

    expect(result).toEqual({ status: 'terminal', reason: 'codex-not-connected' });
    expect(logger.warn).toHaveBeenCalledWith(
      { activeProvider: 'codex', surface: 'desktop', hasAnthropicKey: true },
      'Codex selected but not connected — failing closed',
    );
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        message: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
      }),
      {
        // Codex was never connected, so nothing was ever contacted or rejected.
        errorKindOverride: 'connection-not-configured',
        humanizedOverride: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
      },
    );
  });

  it("returns terminal 'codex-not-connected' when disconnected Codex has stale OpenRouter credentials", async () => {
    getSettingsMock.mockReturnValue(makeSettings({
      activeProvider: 'codex',
      openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'openrouter/test-model' },
    }));

    const { result, logger } = await runAdmission({
      rendererSessionId: null,
      turnOptions: undefined,
    });

    expect(result).toEqual({ status: 'terminal', reason: 'codex-not-connected' });
    expect(logger.warn).toHaveBeenCalledWith(
      { activeProvider: 'codex', surface: 'desktop', hasAnthropicKey: true },
      'Codex selected but not connected — failing closed',
    );
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        message: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
      }),
      {
        // Codex was never connected, so nothing was ever contacted or rejected.
        errorKindOverride: 'connection-not-configured',
        humanizedOverride: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
      },
    );
  });

  describe('FOX-3494: ChatGPT Pro reconnect restores a working session (regression guard)', () => {
    // The incident: a user's ChatGPT Pro disconnected; they reconnected
    // (Settings showed "connected"); but the NEXT conversation turn still
    // failed "not connected" — a state divergence between where reconnect
    // wrote the credential and where turn-admission read connectivity.
    //
    // The fix has two load-bearing parts, both exercised here against the SAME
    // admission machinery (no rebuild between attempts — that is the point):
    //   (1) admission reads CURRENT codex connectivity every turn via
    //       getCodexAuthProvider().isConnected() (turnAdmission.ts ~L186-187),
    //       not a cached/stale "disconnected" snapshot; and
    //   (2) reconnect's END heals activeProvider→'codex' (codexHandlers.ts
    //       defaultHealCodexProviderAfterReconnect) so a stranded user lands
    //       back on the usable provider.
    //
    // We drive the real user journey: block while disconnected → simulate the
    // reconnect's END (write tokens + apply the activeProvider heal, skipping
    // the browser/OAuth) → admit on the SAME machinery. `codexIsConnectedMock`
    // is the test seam for getCodexAuthProvider().isConnected(); on the real
    // path DEFAULT_CODEX_AUTH_PROVIDER.isConnected() reads hasCodexTokens(), so
    // flipping it models saveCodexTokens() having landed (see
    // defaultCodexAuthProvider.test.ts).
    it('blocks while disconnected, then admits after reconnect — no stale disconnected state', async () => {
      // ── Pre-reconnect: activeProvider 'codex', codex DISCONNECTED ───────────
      // Mimic the stranded state: the disconnect can heal activeProvider away
      // from codex, but the canonical bug presents with activeProvider 'codex'
      // and no tokens. Admission must fail CLOSED here.
      getSettingsMock.mockReturnValue(makeSettings({ activeProvider: 'codex' }));
      codexIsConnectedMock.mockReturnValue(false);

      const before = await runAdmission({ rendererSessionId: null, turnOptions: undefined });

      expect(before.result).toEqual({ status: 'terminal', reason: 'codex-not-connected' });
      // Critically: NOT a silent pass and NOT a fallback to Anthropic-with-no-key.
      expect(before.result.status).not.toBe('ok');
      const blockToast = renderToastForLatestDispatch(
        'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
        {
          activeProvider: 'codex',
          hasAnthropicCredentials: false,
          hasOpenRouterCredentials: false,
          hasCodexSubscription: false,
        },
      );
      // Disconnected ≠ rejected: nothing was ever contacted.
      expect(blockToast.kind).toBe('connection-not-configured');
      expect(blockToast.body).not.toMatch(/rejected the credentials/i);

      // ── Reconnect (END only — skip browser/OAuth) ──────────────────────────
      // (1) tokens land: DEFAULT_CODEX_AUTH_PROVIDER.isConnected() now reads
      //     hasCodexTokens()===true, so the connectivity seam flips to true.
      // (2) activeProvider heal: reconnect's END heals back to 'codex'. Here
      //     activeProvider was already 'codex', so the heal is a no-op — but we
      //     keep it explicit to mirror defaultHealCodexProviderAfterReconnect
      //     and prove the post-heal provider is the usable one.
      codexIsConnectedMock.mockReturnValue(true);
      getSettingsMock.mockReturnValue(makeSettings({ activeProvider: 'codex' }));
      // Clear the dispatched-error log so the post-reconnect assertion below
      // can't be satisfied by the pre-reconnect block's dispatch.
      dispatchAgentErrorEventMock.mockClear();

      // ── Post-reconnect: SAME admission machinery, no rebuild ────────────────
      const after = await runAdmission({ rendererSessionId: null, turnOptions: undefined });

      // The fix: admission read the CURRENT (connected) state, not a stale
      // cached "disconnected" — so the turn is admitted and proceeds.
      expect(after.result.status).toBe('ok');
      expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    });

    it('heals a stranded activeProvider back to codex on reconnect, then admits', async () => {
      // The disconnect strands the user on an unusable provider (activeProvider
      // 'anthropic' with NO anthropic key). Pre-reconnect this would block on
      // missing-auth. Reconnect's END heals activeProvider→'codex' (modelled
      // here by writing the healed settings, as applyCodexProviderHeal does),
      // and tokens land (connectivity flips true) — so admission then proceeds.
      getSettingsMock.mockReturnValue(makeSettings({
        activeProvider: 'anthropic',
        claude: { ...makeSettings().models, apiKey: null, workingProfileId: undefined },
        localModel: { profiles: [], activeProfileId: null },
        openRouter: { enabled: false, oauthToken: null, selectedModel: '' },
      }));
      codexIsConnectedMock.mockReturnValue(false);

      const before = await runAdmission({ rendererSessionId: null, turnOptions: undefined });
      // Stranded on key-less anthropic → blocked (fail-closed, not silent pass).
      expect(before.result).toEqual({ status: 'terminal', reason: 'missing-auth' });

      // Reconnect's END: heal activeProvider→'codex' + tokens land.
      getSettingsMock.mockReturnValue(makeSettings({ activeProvider: 'codex' }));
      codexIsConnectedMock.mockReturnValue(true);
      dispatchAgentErrorEventMock.mockClear();

      const after = await runAdmission({ rendererSessionId: null, turnOptions: undefined });
      expect(after.result.status).toBe('ok');
      expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    });
  });

  describe('user-facing toast for not-connected / not-configured admission failures (REBEL: disconnected-provider-toast)', () => {
    // RED→GREEN repro for the incident: a codex-disconnected turn produced the
    // toast "Your AI provider rejected the credentials" — a lie, since no
    // provider was ever contacted. The fix reclassifies these admission states
    // to `connection-not-configured`. We assert the rendered toast BODY (the
    // string the user reads), NOT the internal errorKind literal.
    it('codex disconnected does NOT tell the user their credentials were rejected', async () => {
      getSettingsMock.mockReturnValue(makeSettings({ activeProvider: 'codex' }));

      await runAdmission({ rendererSessionId: null, turnOptions: undefined });

      const toast = renderToastForLatestDispatch(
        'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
        {
          activeProvider: 'codex',
          hasAnthropicCredentials: true,
          hasOpenRouterCredentials: false,
          hasCodexSubscription: false,
        },
      );

      expect(toast.body).not.toMatch(/rejected the credentials/i);
      expect(toast.kind).toBe('connection-not-configured');
      // Stage 2: provider-aware copy names ChatGPT Pro and offers reconnect/switch.
      expect(toast.title).toBe('ChatGPT Pro is disconnected.');
      expect(toast.body).toMatch(
        /reconnect it in settings, or switch to another provider\. your message is safe\./i,
      );
    });

    it('openrouter not connected does NOT tell the user their credentials were rejected', async () => {
      getSettingsMock.mockReturnValue(makeSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: null, selectedModel: 'openrouter/test-model' },
      }));

      await runAdmission({ rendererSessionId: null, turnOptions: undefined });

      const toast = renderToastForLatestDispatch(
        'OpenRouter is disconnected. Reconnect it in Settings, or switch to another provider.',
        {
          activeProvider: 'openrouter',
          hasAnthropicCredentials: false,
          hasOpenRouterCredentials: false,
          hasCodexSubscription: false,
        },
      );

      expect(toast.body).not.toMatch(/rejected the credentials/i);
      expect(toast.kind).toBe('connection-not-configured');
    });

    it('anthropic missing key does NOT tell the user their credentials were rejected', async () => {
      getSettingsMock.mockReturnValue(makeSettings({
        claude: { ...makeSettings().models, apiKey: null, workingProfileId: undefined },
        localModel: { profiles: [], activeProfileId: null },
        openRouter: { enabled: false, oauthToken: null, selectedModel: '' },
      }));

      await runAdmission({ rendererSessionId: null, turnOptions: undefined });

      const toast = renderToastForLatestDispatch(
        'Authentication is missing. Please add an API key in Settings.',
        {
          activeProvider: 'anthropic',
          hasAnthropicCredentials: false,
          hasOpenRouterCredentials: false,
          hasCodexSubscription: false,
        },
      );

      expect(toast.body).not.toMatch(/rejected the credentials/i);
      expect(toast.kind).toBe('connection-not-configured');
    });
  });

  it('keyword strip: //unleashed enables unleashedMode and cleans prompt', async () => {
    const { result, logger } = await runAdmission({
      prompt: 'Please //unleashed finish this',
    });

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        unleashedMode: true,
        prompts: {
          promptWithoutOurComponentsOrUnleashed: 'Please finish this',
        },
      },
    });
    expect(logger.info).toHaveBeenCalledWith(
      { promptLength: 'Please finish this'.length, source: 'keyword' },
      'Unleashed mode activated - using persistent continuation',
    );
  });

  it('keyword strip: //council enables councilModeRequested and cleans promptForContext', async () => {
    const { result } = await runAdmission({
      prompt: 'Please //council compare options',
    });

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        councilModeRequested: true,
        prompts: {
          promptForContext: 'Please compare options',
          promptWithoutOurComponents: 'Please compare options',
        },
      },
    });
  });

  it('mainTracking.chatSessionCreated fires for derived fresh renderer sessions', async () => {
    listSessionsMock.mockReturnValue([{ id: 'session-1', messageCount: 0 }]);

    const { result } = await runAdmission({
      turnOptions: { sessionId: 'session-1' },
    });

    expect(result).toMatchObject({
      status: 'ok',
      value: { effectiveResetConversation: true },
    });
    expect(chatSessionCreatedMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      origin: 'manual',
      isFirstSession: true,
    });
  });

  it('turn_started dispatch failure is non-fatal and the phase continues to ok', async () => {
    dispatchAgentEventMock.mockImplementationOnce(() => {
      throw new Error('renderer closed');
    });

    const { result, logger } = await runAdmission();

    expect(result.status).toBe('ok');
    expect(logger.warn).toHaveBeenCalledWith(
      { turnId: 'turn-1', err: expect.any(Error) },
      'turn_started dispatch failed — renderer may show delayed spinner',
    );
  });

  it('starts checkpointing when a checkpoint manager is available', async () => {
    getTurnCheckpointManagerMock.mockReturnValue({ startCheckpointing: startCheckpointingMock });

    const { result } = await runAdmission();

    expect(result.status).toBe('ok');
    expect(startCheckpointingMock).toHaveBeenCalledWith('turn-1', 'session-1');
  });

  it('does not start checkpointing for delete-eligible sessions', async () => {
    getTurnCheckpointManagerMock.mockReturnValue({ startCheckpointing: startCheckpointingMock });

    const { result } = await runAdmission({
      rendererSessionId: 'memory-update-turn-1',
      turnOptions: {
        sessionId: 'memory-update-turn-1',
        resetConversation: false,
      },
    });

    expect(result.status).toBe('ok');
    expect(startCheckpointingMock).not.toHaveBeenCalled();
  });

  describe('finishLine resolution', () => {
    it('uses sessionFinishLine as fallback when turnOptions.finishLine is absent', async () => {
      const { result } = await runAdmission({
        sessionFinishLine: 'brief is ready to send',
        turnOptions: { sessionId: 'session-1' },
      });

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.finishLine).toBe('brief is ready to send');
      }
    });

    it('per-turn finishLine override beats sessionFinishLine', async () => {
      const { result } = await runAdmission({
        sessionFinishLine: 'session-level criterion',
        turnOptions: { sessionId: 'session-1', finishLine: 'turn-level criterion' },
      });

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.finishLine).toBe('turn-level criterion');
      }
    });

    it('normalizes whitespace-only sessionFinishLine to undefined', async () => {
      const { result } = await runAdmission({
        sessionFinishLine: '   ',
        turnOptions: { sessionId: 'session-1' },
      });

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.finishLine).toBeUndefined();
      }
    });

    it('resolves to undefined when both turnOptions.finishLine and sessionFinishLine are absent', async () => {
      const { result } = await runAdmission({
        turnOptions: { sessionId: 'session-1' },
      });

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.finishLine).toBeUndefined();
      }
    });
  });
});
