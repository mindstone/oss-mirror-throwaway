import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentChannels } from '@shared/ipc/channels/agent';
import type { AgentTurnRequest } from '@shared/types';
import {
  clearAllPendingPersonalisationPrefixes,
  registerPendingPersonalisationPrefix,
} from '../../services/pendingPersonalisationPrefixes';
import { registerAgentHandlers, type AgentHandlerDeps } from '../agentHandlers';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
}));

const { agentTurnMocks } = vi.hoisted(() => ({
  agentTurnMocks: {
    startAgentTurn: vi.fn(),
    stopAgentTurn: vi.fn(),
  },
}));

const { loggerMocks } = vi.hoisted(() => ({
  loggerMocks: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('@core/logger', () => ({
  logger: loggerMocks,
  createScopedLogger: vi.fn(() => loggerMocks),
}));

vi.mock('../../services/agentTurnService', () => agentTurnMocks);

vi.mock('@core/services/userQuestionResponseHandler', () => ({
  findPersistedUserQuestionProvenance: vi.fn(),
  registerUserQuestionResponseHandler: vi.fn(),
  setUserQuestionProvenanceResolver: vi.fn(),
}));

function makeDeps(): AgentHandlerDeps {
  return {
    getWindowForEvent: vi.fn(() => ({ id: 1 }) as unknown as BrowserWindow),
    executeAgentTurn: vi.fn(async () => undefined),
    dispatchAgentEvent: vi.fn(),
    getActiveTurnController: vi.fn(() => undefined),
    getTurnCloseCallback: vi.fn(() => undefined),
    deleteRendererSessionByTurn: vi.fn(),
    cancelExistingTurnForSession: vi.fn(() => undefined),
    getActiveTurnForSession: vi.fn(() => undefined),
    getSettings: vi.fn(() => ({}) as AgentHandlerDeps['getSettings'] extends () => infer T ? T : never),
  };
}

function makeEvent(): IpcMainInvokeEvent {
  return { sender: { id: 42 } } as unknown as IpcMainInvokeEvent;
}

function makeRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return agentChannels['agent:turn'].request.parse({
    prompt: 'Draft the follow-up note.',
    sessionId: 'session-contract-1',
    clientTurnId: 'client-turn-1',
    resetConversation: true,
    privateMode: true,
    modelOverride: 'claude-test',
    thinkingModelOverride: 'claude-thinking-test',
    workingProfileOverrideId: 'working-profile-1',
    thinkingProfileOverrideId: 'thinking-profile-1',
    thinkingEffortOverride: 'medium',
    unleashedMode: true,
    inputSource: 'text',
    councilMode: true,
    activeSpacePath: '/workspace/Chief-of-Staff',
    origin: 'operator-personalisation',
    supersedePolicy: 'reject',
    continuationContext: {
      alreadyInjected: true,
      meta: {
        headerIncluded: true,
        headerBytes: 17,
        historyIncluded: true,
        historyBytes: 23,
        truncated: false,
      },
    },
    ...overrides,
  });
}

function registerAndGetAgentTurnHandler(): (event: IpcMainInvokeEvent, request: AgentTurnRequest) => Promise<unknown> {
  registerAgentHandlers(makeDeps());
  const handler = registeredHandlers.get('agent:turn');
  expect(handler).toBeDefined();
  return handler as (event: IpcMainInvokeEvent, request: AgentTurnRequest) => Promise<unknown>;
}

describe('agent:turn IPC behavioral contract', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    clearAllPendingPersonalisationPrefixes();
    vi.clearAllMocks();
    agentTurnMocks.startAgentTurn.mockReturnValue({ turnId: 'turn-contract-1' });
  });

  it('registers the real agent:turn handler', () => {
    registerAgentHandlers(makeDeps());

    expect(registeredHandlers.has('agent:turn')).toBe(true);
  });

  it('returns the turnId schema response and forwards request fields through the real handler path', async () => {
    const request = makeRequest();
    const handler = registerAndGetAgentTurnHandler();

    const response = await handler(makeEvent(), request);

    expect(agentChannels['agent:turn'].response.parse(response)).toEqual({ turnId: 'turn-contract-1' });
    expect(agentTurnMocks.startAgentTurn).toHaveBeenCalledTimes(1);
    const [, forwardedRequest, forwardedWindow] = agentTurnMocks.startAgentTurn.mock.calls[0];
    expect(forwardedRequest).toEqual(request);
    expect((forwardedRequest as AgentTurnRequest).continuationContext).toBe(request.continuationContext);
    // supersedePolicy must reach startAgentTurn unchanged — the admission
    // guard reads it there (260610 queue-drain-cancels-turn Stage 2, GPT F5).
    expect((forwardedRequest as AgentTurnRequest).supersedePolicy).toBe('reject');
    expect(forwardedWindow).toEqual({ id: 1 });
  });

  it("forwards an absent supersedePolicy as absent (legacy supersede) and a 'supersede' value unchanged", async () => {
    const handler = registerAndGetAgentTurnHandler();

    const { supersedePolicy: _omit, ...legacyShape } = makeRequest();
    const legacyRequest = agentChannels['agent:turn'].request.parse(legacyShape);
    await handler(makeEvent(), legacyRequest);
    const [, forwardedLegacy] = agentTurnMocks.startAgentTurn.mock.calls[0];
    expect(forwardedLegacy).not.toHaveProperty('supersedePolicy');

    const supersedeRequest = makeRequest({ supersedePolicy: 'supersede' });
    await handler(makeEvent(), supersedeRequest);
    const [, forwardedSupersede] = agentTurnMocks.startAgentTurn.mock.calls[1];
    expect((forwardedSupersede as AgentTurnRequest).supersedePolicy).toBe('supersede');
  });

  it('agent:turn channel schema rejects an invalid supersedePolicy value', () => {
    expect(() => makeRequest({ supersedePolicy: 'cancel-everything' as AgentTurnRequest['supersedePolicy'] })).toThrow();
  });

  it('preserves a trusted systemPromptPrefix before calling startAgentTurn', async () => {
    const trustedPrefix = 'Personalise this Operator carefully.';
    const request = makeRequest({ systemPromptPrefix: trustedPrefix });
    registerPendingPersonalisationPrefix(request.sessionId, trustedPrefix);
    const handler = registerAndGetAgentTurnHandler();

    await handler(makeEvent(), request);

    expect(agentTurnMocks.startAgentTurn).toHaveBeenCalledTimes(1);
    const [, forwardedRequest] = agentTurnMocks.startAgentTurn.mock.calls[0];
    expect(forwardedRequest).toEqual(request);
    expect((forwardedRequest as AgentTurnRequest).systemPromptPrefix).toBe(trustedPrefix);
  });

  it('strips an untrusted systemPromptPrefix before calling startAgentTurn', async () => {
    const request = makeRequest({ systemPromptPrefix: 'Renderer-supplied prefix' });
    registerPendingPersonalisationPrefix(request.sessionId, 'Different trusted prefix');
    const handler = registerAndGetAgentTurnHandler();

    await handler(makeEvent(), request);

    expect(agentTurnMocks.startAgentTurn).toHaveBeenCalledTimes(1);
    const [, forwardedRequest] = agentTurnMocks.startAgentTurn.mock.calls[0];
    const { systemPromptPrefix: _untrustedPrefix, ...requestWithoutPrefix } = request;
    expect(forwardedRequest).toEqual(requestWithoutPrefix);
    expect(forwardedRequest).not.toHaveProperty('systemPromptPrefix');
    expect((forwardedRequest as AgentTurnRequest).continuationContext).toBe(request.continuationContext);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        sessionId: request.sessionId,
        hasTrustedEntry: true,
      },
      'agent:turn systemPromptPrefix did not match the trusted personalisation registry; dropping prefix.',
    );
  });
});
