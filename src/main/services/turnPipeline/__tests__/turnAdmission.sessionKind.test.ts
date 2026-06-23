 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { AdmissionInput } from '../turnAdmission';

const {
  getSettingsMock,
  codexIsConnectedMock,
  hasValidAuthMock,
  listSessionsMock,
  setTurnCategoryMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  startCheckpointingMock,
  getTurnCheckpointManagerMock,
  stripDesignContextCommandMock,
  stripOurComponentsCommandMock,
} = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  codexIsConnectedMock: vi.fn(),
  hasValidAuthMock: vi.fn(),
  listSessionsMock: vi.fn(),
  setTurnCategoryMock: vi.fn(),
  dispatchAgentEventMock: vi.fn(),
  dispatchAgentErrorEventMock: vi.fn(),
  startCheckpointingMock: vi.fn(),
  getTurnCheckpointManagerMock: vi.fn(),
  stripDesignContextCommandMock: vi.fn(),
  stripOurComponentsCommandMock: vi.fn(),
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

vi.mock('../../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    recordSessionTurn: vi.fn(),
    hasSessionHadTurns: vi.fn(() => false),
    setRendererSession: vi.fn(),
    clearExtendedContextFailed: vi.fn(),
    setTurnPrivateMode: vi.fn(),
    setTurnCategory: setTurnCategoryMock,
    setTurnLogger: vi.fn(),
  },
}));

vi.mock('../../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('../../agentTurnCleanup', () => ({
  makeSyntheticResult: vi.fn(() => ({ type: 'result' })),
}));

vi.mock('../../../tracking', () => ({
  mainTracking: {
    chatSessionCreated: vi.fn(),
  },
}));

vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    listSessions: listSessionsMock,
  })),
}));

vi.mock('../../../utils/authEnvUtils', () => ({
  hasValidAuth: hasValidAuthMock,
}));

vi.mock('../../toolSafetyService', () => ({
  cleanupSessionPendingApprovals: vi.fn(),
}));

vi.mock('../../schemaGateHook', () => ({
  clearSchemaGateSession: vi.fn(),
}));

vi.mock('../../designContextService', () => ({
  stripDesignContextCommand: stripDesignContextCommandMock,
}));

vi.mock('../../ourComponentsContextService', () => ({
  stripOurComponentsCommand: stripOurComponentsCommandMock,
}));

import { admit } from '../turnAdmission';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/core',
    activeProvider: 'anthropic',
    claude: {
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
    },
    models: { apiKey: 'test-key' },
    localModel: {
      profiles: [],
      activeProfileId: null,
    },
    ...overrides,
  } as unknown as AppSettings;
}

function makeInput(sessionId: string): AdmissionInput {
  return {
    turnId: 'turn-1',
    win: null,
    prompt: 'Hello',
    abortController: new AbortController(),
    rendererSessionId: sessionId,
    turnOptions: {
      sessionId,
      resetConversation: false,
    },
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettingsMock.mockReturnValue(makeSettings());
  codexIsConnectedMock.mockReturnValue(true);
  hasValidAuthMock.mockReturnValue(true);
  listSessionsMock.mockReturnValue([]);
  stripDesignContextCommandMock.mockImplementation((prompt: string) => ({
    explicitRequested: false,
    sanitizedPrompt: prompt,
  }));
  stripOurComponentsCommandMock.mockImplementation((prompt: string) => ({
    explicitRequested: false,
    sanitizedPrompt: prompt,
  }));
  getTurnCheckpointManagerMock.mockReturnValue({ startCheckpointing: startCheckpointingMock });
});

describe('turnAdmission session-kind routing parity', () => {
  it.each([
    { sessionId: 'automation-sync--abc123', expectedCategory: 'automation' },
    { sessionId: 'automation-insight-foo123', expectedCategory: 'automation' },
    { sessionId: 'memory-update-turn-1', expectedCategory: 'memory' },
    { sessionId: 'meeting-qa-abc123', expectedCategory: 'conversation' },
    { sessionId: 'calendar-sync', expectedCategory: 'conversation' },
    { sessionId: 'normal-conversation-123', expectedCategory: 'conversation' },
  ])(
    'maps $sessionId to $expectedCategory',
    async ({ sessionId, expectedCategory }) => {
      const input = makeInput(sessionId);
      const result = await admit(input, input.abortController.signal, makeLogger() as never);

      expect(result.status).toBe('ok');
      expect(setTurnCategoryMock).toHaveBeenCalledWith('turn-1', expectedCategory);
    },
  );

  it('routes automation-insight sessions through automation cost category', async () => {
    const input = makeInput('automation-insight-foo123');
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(setTurnCategoryMock).toHaveBeenCalledWith('turn-1', 'automation');
    expect(setTurnCategoryMock).not.toHaveBeenCalledWith('turn-1', 'conversation');
  });

  it('skips checkpointing for meeting-qa sessions via classifier gating', async () => {
    const input = makeInput('meeting-qa-abc123');
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(startCheckpointingMock).not.toHaveBeenCalled();
  });

  it('starts checkpointing for conversation sessions', async () => {
    const input = makeInput('normal-conversation-123');
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(startCheckpointingMock).toHaveBeenCalledWith('turn-1', 'normal-conversation-123');
  });
});
