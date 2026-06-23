import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { buildSettings } from '@core/__tests__/builders/settingsBuilder';
import type { HandlerRegistry, IpcHandler } from '@core/handlerRegistry';
import { setHandlerRegistry } from '@core/handlerRegistry';
import { agentTurnRegistry } from '../../services/agentTurnRegistry';

const testState = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
  sendToAllWindows: vi.fn(),
  codexConnected: vi.fn(() => true),
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  cloudRouter: {
    isDualWrite: vi.fn(() => false),
    shouldRouteToCloud: vi.fn(() => false),
    forward: vi.fn(),
  },
}));


vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    testState.registeredHandlers.set(channel, handler);
  }),
}));


vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: testState.sendToAllWindows });
});


vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: () => ({
    isConnected: testState.codexConnected,
  }),
}));


vi.mock('electron', () => ({
  ipcMain: testState.ipcMain,
}));


vi.mock('../../services/cloud/cloudRouter', () => ({
  cloudRouter: testState.cloudRouter,
}));

function makeRegistry(invokeWithRouting: HandlerRegistry['invokeWithRouting']): HandlerRegistry {
  const handlers = new Map<string, IpcHandler>();
  return {
    register: (channel, handler) => {
      handlers.set(channel, handler);
    },
    remove: (channel) => {
      handlers.delete(channel);
    },
    get: (channel) => handlers.get(channel),
    listRegisteredChannels: () => Array.from(handlers.keys()),
    invokeWithRouting,
  };
}

function getApplyResolutionHandler() {
  const handler = testState.registeredHandlers.get('error:apply-resolution');
  if (!handler) {
    throw new Error('error:apply-resolution handler was not registered');
  }
  return handler;
}

describe('agentErrorHandlers', () => {
  let settings: AppSettings;
  let invokeWithRouting: ReturnType<typeof vi.fn<HandlerRegistry['invokeWithRouting']>>;

  beforeEach(async () => {
    testState.registeredHandlers.clear();
    testState.sendToAllWindows.mockClear();
    testState.codexConnected.mockClear();
    testState.ipcMain.handle.mockClear();
    testState.ipcMain.removeHandler.mockClear();
    testState.cloudRouter.isDualWrite.mockReset().mockReturnValue(false);
    testState.cloudRouter.shouldRouteToCloud.mockReset().mockReturnValue(false);
    testState.cloudRouter.forward.mockReset().mockResolvedValue({ ok: true });

    for (const turnId of agentTurnRegistry.getActiveTurnIds()) {
      agentTurnRegistry.cleanupTurn(turnId);
    }

    settings = buildSettings({ activeProvider: 'codex' });
    invokeWithRouting = vi.fn<HandlerRegistry['invokeWithRouting']>(async (
      _channel: string,
      _event: unknown,
      nextSettings: unknown,
    ) => {
      settings = nextSettings as AppSettings;
      return nextSettings;
    });
    setHandlerRegistry(makeRegistry(invokeWithRouting));

    const { registerAgentErrorHandlers } = await import('../agentErrorHandlers');
    registerAgentErrorHandlers({ getSettings: () => settings });
  });

  afterEach(() => {
    for (const turnId of agentTurnRegistry.getActiveTurnIds()) {
      agentTurnRegistry.cleanupTurn(turnId);
    }
  });

  it('deduplicates identical apply-resolution requests while the first is in flight', async () => {
    let resolveSettingsWrite: ((settings: AppSettings) => void) | undefined;
    invokeWithRouting.mockImplementationOnce(
      async (_channel: string, _event: unknown, nextSettings: unknown) => new Promise<AppSettings>((resolve) => {
        resolveSettingsWrite = resolve;
        settings = nextSettings as AppSettings;
      }),
    );

    const handler = getApplyResolutionHandler();
    const request = {
      turnId: 'failed-turn',
      action: 'switch-model',
      payload: { model: 'gpt-5.5' },
    };

    const first = handler(undefined, request);
    const second = await handler(undefined, request);

    expect(second).toEqual({
      ok: false,
      appliedAction: 'switch-model',
      reason: 'in_flight',
    });

    resolveSettingsWrite?.(settings);
    await expect(first).resolves.toEqual({
      ok: true,
      appliedAction: 'switch-model',
    });
  });

  it('returns turn_alive when the failed turn is still active', async () => {
    agentTurnRegistry.setActiveTurnController('failed-turn', new AbortController());

    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'retry',
    });

    expect(result).toEqual({
      ok: false,
      appliedAction: 'retry',
      reason: 'turn_alive',
    });
  });

  it('returns stale_turn when another turn is active for retryable actions', async () => {
    agentTurnRegistry.setActiveTurnController('newer-turn', new AbortController());

    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'retry',
    });

    expect(result).toEqual({
      ok: false,
      appliedAction: 'retry',
      reason: 'stale_turn',
    });
  });

  it('does NOT stale_turn the Chief-of-Staff recovery verbs when an unrelated turn is active (F3 — never dead-end recovery)', async () => {
    agentTurnRegistry.setActiveTurnController('unrelated-turn', new AbortController());

    const proceed = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'proceed-without-chief-of-staff',
    });
    expect(proceed).toEqual({ ok: true, appliedAction: 'proceed-without-chief-of-staff' });
  });

  it('returns invalid_payload when a switch-model action omits the model', async () => {
    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'switch-model',
      payload: {},
    });

    expect(result).toEqual({
      ok: false,
      appliedAction: 'switch-model',
      reason: 'invalid_payload',
    });
    expect(invokeWithRouting).not.toHaveBeenCalled();
  });

  it('writes settings through invokeWithRouting so settings:update preserves cloud routing', async () => {
    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'switch-model',
      payload: { model: 'gpt-5.5' },
    });

    expect(result).toEqual({
      ok: true,
      appliedAction: 'switch-model',
    });
    expect(invokeWithRouting).toHaveBeenCalledWith(
      'settings:update',
      undefined,
      expect.objectContaining({
        models: expect.objectContaining({ model: 'gpt-5.5' }),
      }),
    );
    expect(invokeWithRouting.mock.calls[0]?.[2]).not.toHaveProperty('claude');
  });

  // FOX-3494 (F1): a PLANNING-role failure means the offending claude-* model came
  // from the thinking slot. The switch-model recovery must repair the thinking slot
  // (clear thinkingModel/thinkingProfileId + disable plan mode) and switch the
  // working model, so the immediate retry routes to GPT instead of looping back
  // into the same Claude planning terminal.
  it('switch-model with failedRole=planning repairs the thinking slot (clears thinkingModel/thinkingProfileId, planMode off)', async () => {
    settings = buildSettings({
      activeProvider: 'codex',
      models: {
        ...buildSettings().models,
        model: 'gpt-5.5',
        thinkingModel: 'claude-opus-4-8',
        thinkingProfileId: 'claude-planning-profile',
        planMode: true,
      },
    });

    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'switch-model',
      payload: { model: 'gpt-5.5', failedRole: 'planning' },
    });

    expect(result).toEqual({ ok: true, appliedAction: 'switch-model' });
    const written = invokeWithRouting.mock.calls[0]?.[2] as AppSettings;
    expect(written.models).toMatchObject({
      model: 'gpt-5.5',
      thinkingModel: undefined,
      thinkingProfileId: undefined,
      planMode: false,
      workingProfileId: undefined,
    });
  });

  // FOX-3494 (round-2 M1): `failedRole` is set ONLY by the claude-under-ChatGPT-Pro
  // recovery, where Anthropic is unavailable. An EXECUTION-role failure must ALSO
  // collapse BOTH model slots to the GPT model — preserving the Claude thinking
  // model would let the retry re-enable planning from it (resolveModelSettings
  // keeps bare claude-* thinking under codex) and loop straight back into the
  // same Claude planning terminal. Both roles collapse to single-model GPT mode.
  it('switch-model with failedRole=execution also collapses the thinking slot (no Claude can survive)', async () => {
    settings = buildSettings({
      activeProvider: 'codex',
      models: {
        ...buildSettings().models,
        model: 'claude-opus-4-8',
        thinkingModel: 'claude-sonnet-4-6',
        thinkingProfileId: 'thinking-profile',
        planMode: true,
      },
    });

    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'switch-model',
      payload: { model: 'gpt-5.5', failedRole: 'execution' },
    });

    expect(result).toEqual({ ok: true, appliedAction: 'switch-model' });
    const written = invokeWithRouting.mock.calls[0]?.[2] as AppSettings;
    expect(written.models).toMatchObject({
      model: 'gpt-5.5',
      thinkingModel: undefined,
      thinkingProfileId: undefined,
      planMode: false,
      workingProfileId: undefined,
    });
  });

  // FOX-3494 (round-2 M1): a LEGACY switch-model action (no failedRole — e.g. the
  // generic "this model isn't on your subscription" recovery) keeps the previous
  // working-model-only behaviour and does NOT clobber a deliberate thinking model.
  it('switch-model without failedRole preserves the thinking slot (legacy behaviour)', async () => {
    settings = buildSettings({
      activeProvider: 'codex',
      models: {
        ...buildSettings().models,
        model: 'gpt-5.5-pro',
        thinkingModel: 'gpt-5.5',
        thinkingProfileId: 'thinking-profile',
        planMode: true,
      },
    });

    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'switch-model',
      payload: { model: 'gpt-5.5' },
    });

    expect(result).toEqual({ ok: true, appliedAction: 'switch-model' });
    const written = invokeWithRouting.mock.calls[0]?.[2] as AppSettings;
    expect(written.models.model).toBe('gpt-5.5');
    expect(written.models.thinkingModel).toBe('gpt-5.5');
    expect(written.models.thinkingProfileId).toBe('thinking-profile');
  });

  // Gateway-profile recovery: a switch-model action whose model is a `profile:<id>`
  // ref pins the working (and, with failedRole, thinking) model to that profile so the
  // turn routes through the profile's provider (e.g. a custom OpenAI-compatible gateway)
  // — instead of clearing workingProfileId and routing the bare model to the active provider.
  it('switch-model with a profile:<id> model pins workingProfileId to that profile', async () => {
    settings = buildSettings({
      activeProvider: 'anthropic',
      models: {
        ...buildSettings().models,
        apiKey: null,
        model: 'claude-opus-4-8',
      },
      localModel: {
        activeProfileId: null,
        profiles: [
          {
            id: 'test-gw',
            name: 'Test Gateway',
            providerType: 'other',
            customProviderId: 'cp-1',
            serverUrl: 'https://gateway.example.com/v1',
            model: 'claude-opus-4-8',
            enabled: true,
            createdAt: 1,
          },
        ],
      },
    });

    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'switch-model',
      payload: { model: 'profile:test-gw', failedRole: 'execution' },
    });

    expect(result).toEqual({ ok: true, appliedAction: 'switch-model' });
    const written = invokeWithRouting.mock.calls[0]?.[2] as AppSettings;
    expect(written.models).toMatchObject({
      model: 'claude-opus-4-8',
      workingProfileId: 'test-gw',
      thinkingProfileId: 'test-gw',
    });
  });

  // Review F2: an unknown profile id (deleted between rendering the banner and the click)
  // must fail closed, not persist a bare 'profile:<id>' in the model field.
  it('switch-model with an unknown profile:<id> fails closed (invalid_payload) and writes nothing', async () => {
    settings = buildSettings({
      activeProvider: 'anthropic',
      localModel: { activeProfileId: null, profiles: [] },
    });

    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'switch-model',
      payload: { model: 'profile:ghost', failedRole: 'execution' },
    });

    expect(result).toEqual({ ok: false, appliedAction: 'switch-model', reason: 'invalid_payload' });
    expect(invokeWithRouting).not.toHaveBeenCalled();
  });

  it('does not broadcast settings:open-requested for open-settings actions', async () => {
    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'open-settings',
      payload: { settingsSection: 'providerKeys' },
    });

    expect(result).toEqual({
      ok: true,
      appliedAction: 'open-settings',
    });
    expect(testState.sendToAllWindows).not.toHaveBeenCalledWith(
      'settings:open-requested',
      expect.anything(),
    );
  });

  // 260622 Stage 4: Chief-of-Staff recovery verbs.
  it('proceed-without-chief-of-staff is acknowledged ok (the bypass + retry happen renderer-side)', async () => {
    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'proceed-without-chief-of-staff',
    });
    expect(result).toEqual({ ok: true, appliedAction: 'proceed-without-chief-of-staff' });
  });

  it('recreate-chief-of-staff with no provisioning dep wired fails closed (invalid_payload), never silent ok', async () => {
    // The default beforeEach registration omits `recreateChiefOfStaff`.
    const result = await getApplyResolutionHandler()(undefined, {
      turnId: 'failed-turn',
      action: 'recreate-chief-of-staff',
    });
    expect(result).toEqual({ ok: false, appliedAction: 'recreate-chief-of-staff', reason: 'invalid_payload' });
  });
});

describe('agentErrorHandlers — recreate-chief-of-staff with provisioning wired', () => {
  beforeEach(() => {
    testState.registeredHandlers.clear();
    for (const turnId of agentTurnRegistry.getActiveTurnIds()) {
      agentTurnRegistry.cleanupTurn(turnId);
    }
  });

  it('calls the provisioning dep and returns ok on success', async () => {
    const recreateChiefOfStaff = vi.fn(async () => {});
    const { registerAgentErrorHandlers } = await import('../agentErrorHandlers');
    registerAgentErrorHandlers({
      getSettings: () => buildSettings({ activeProvider: 'codex' }),
      recreateChiefOfStaff,
    });

    const handler = testState.registeredHandlers.get('error:apply-resolution');
    if (!handler) throw new Error('handler not registered');
    const result = await handler(undefined, { turnId: 'failed-turn', action: 'recreate-chief-of-staff' });

    expect(recreateChiefOfStaff).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, appliedAction: 'recreate-chief-of-staff' });
  });

  it('propagates a provisioning failure (rejects) so the renderer surfaces a "couldn\'t apply" toast', async () => {
    const recreateChiefOfStaff = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { registerAgentErrorHandlers } = await import('../agentErrorHandlers');
    registerAgentErrorHandlers({
      getSettings: () => buildSettings({ activeProvider: 'codex' }),
      recreateChiefOfStaff,
    });

    const handler = testState.registeredHandlers.get('error:apply-resolution');
    if (!handler) throw new Error('handler not registered');
    await expect(
      handler(undefined, { turnId: 'failed-turn', action: 'recreate-chief-of-staff' }),
    ).rejects.toThrow('disk full');
  });
});

describe('ElectronHandlerRegistry invokeWithRouting', () => {
  beforeEach(() => {
    testState.ipcMain.handle.mockClear();
    testState.ipcMain.removeHandler.mockClear();
    testState.cloudRouter.isDualWrite.mockReset().mockReturnValue(false);
    testState.cloudRouter.shouldRouteToCloud.mockReset().mockReturnValue(false);
    testState.cloudRouter.forward.mockReset().mockResolvedValue({ ok: true });
  });

  it('runs dual-write cloud forwarding for invokeWithRouting just like renderer IPC', async () => {
    testState.cloudRouter.isDualWrite.mockReturnValue(true);
    const { ElectronHandlerRegistry } = await import('../utils/ElectronHandlerRegistry');
    const registry = new ElectronHandlerRegistry();
    const localHandler = vi.fn(async () => ({ ok: true, source: 'local' }));
    const payload = { theme: 'dark' };

    registry.register('settings:update', localHandler);
    const result = await registry.invokeWithRouting('settings:update', undefined, payload);

    expect(result).toEqual({ ok: true, source: 'local' });
    expect(localHandler).toHaveBeenCalledWith(undefined, payload);
    expect(testState.cloudRouter.forward).toHaveBeenCalledWith('settings:update', [payload]);
  });
});
