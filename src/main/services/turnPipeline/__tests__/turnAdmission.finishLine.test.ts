 
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
    hasSessionHadTurns: vi.fn(() => true),
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

function makeInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  const sessionId = overrides.rendererSessionId ?? 'role-finish-line-checkin';
  return {
    turnId: 'turn-1',
    win: null,
    prompt: 'Reply prompt',
    abortController: new AbortController(),
    rendererSessionId: sessionId,
    turnOptions: {
      sessionId,
      resetConversation: false,
    },
    ...overrides,
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

describe('turnAdmission finishLine session-fallback resolution', () => {
  it('resolves admission finishLine from sessionFinishLine when turnOptions omits it (user-reply path)', async () => {
    const input = makeInput({ sessionFinishLine: 'The brief is ready to send' });
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.finishLine).toBe('The brief is ready to send');
  });

  it('per-turn turnOptions.finishLine overrides sessionFinishLine fallback', async () => {
    const input = makeInput({
      sessionFinishLine: 'Role-seeded criterion',
      turnOptions: {
        sessionId: 'role-finish-line-checkin',
        resetConversation: false,
        finishLine: 'Per-turn override',
      },
    });
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.finishLine).toBe('Per-turn override');
  });

  it('leaves finishLine undefined when neither turnOptions nor session has one', async () => {
    const input = makeInput();
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.finishLine).toBeUndefined();
  });

  it('normalizes a whitespace-only sessionFinishLine to undefined', async () => {
    const input = makeInput({ sessionFinishLine: '   \n\t  ' });
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.finishLine).toBeUndefined();
  });
});
