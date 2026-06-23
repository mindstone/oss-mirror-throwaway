/**
 * Stage 3 rd3 (F3) — CALL-SITE integration test for the Chief-of-Staff admission
 * gate, driving the REAL `evaluateChiefOfStaffAdmission` (not the mocked helper the
 * predicate-matrix test uses). This catches WIRING DRIFT the direct-`admit()` unit
 * matrix cannot: that an `AgentTurnRequest.isSystemContinuation` flag and the
 * `surface` actually flow through `admit`'s predicate to the real reader/verdict.
 *
 * The complement (a desktop user turn DOES reach + block the real gate) is the
 * green half that proves these never-block cases aren't trivially passing because
 * the gate is dead.
 *
 * The bounded reader + dir scan resolve through the `workspaceFs` LOCAL lane here
 * (node:fs/promises mocked to ENOENT → `absent`), so an onboarded desktop user
 * turn yields `missing-after-setup`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { AdmissionInput } from '../turnAdmission';

const {
  getSettingsMock,
  codexIsConnectedMock,
  listSessionsMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  getTurnCheckpointManagerMock,
  stripDesignContextCommandMock,
  stripOurComponentsCommandMock,
  surfaceRef,
} = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  codexIsConnectedMock: vi.fn(),
  listSessionsMock: vi.fn(),
  dispatchAgentEventMock: vi.fn(),
  dispatchAgentErrorEventMock: vi.fn(),
  getTurnCheckpointManagerMock: vi.fn(),
  stripDesignContextCommandMock: vi.fn(),
  stripOurComponentsCommandMock: vi.fn(),
  surfaceRef: { current: 'desktop' as 'desktop' | 'cloud' | 'mobile' | 'cli' },
}));

// Local-lane fs read/scan for the REAL bounded reader + dir resolver.
const mockReadFile = vi.fn();
const mockReaddir = vi.fn();
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const readFile = (...args: unknown[]) => mockReadFile(...args);
  const readdir = (...args: unknown[]) => mockReaddir(...args);
  return { ...actual, default: { ...actual, readFile, readdir }, readFile, readdir };
});

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ surface: surfaceRef.current })),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: getSettingsMock,
}));

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: vi.fn(() => ({ isConnected: codexIsConnectedMock })),
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
    setTurnCategory: vi.fn(),
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
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({ listSessions: listSessionsMock })),
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

// NOTE: `chiefOfStaffAdmission` is deliberately NOT mocked — that's the whole point
// of a call-site test: the real evaluator + bounded reader run end-to-end.

import { admit } from '../turnAdmission';

const FAKE_WIN = { isDestroyed: () => false } as never;

function makeEnoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/core',
    activeProvider: 'anthropic',
    claude: { apiKey: 'test-key', model: 'claude-sonnet-4-5' },
    models: { apiKey: 'test-key' },
    localModel: { profiles: [], activeProfileId: null },
    spaces: [
      { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 },
    ],
    // Onboarded so a genuine absence blocks (missing-after-setup).
    onboardingFirstCompletedAt: 1_700_000_000_000,
    ...overrides,
  } as unknown as AppSettings;
}

function makeInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  const sessionId = overrides.rendererSessionId ?? 'cos-callsite-session';
  return {
    turnId: 'turn-callsite',
    win: FAKE_WIN,
    prompt: 'Help me prep',
    abortController: new AbortController(),
    rendererSessionId: sessionId,
    turnOptions: { sessionId, resetConversation: false },
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  surfaceRef.current = 'desktop';
  getSettingsMock.mockReturnValue(makeSettings());
  codexIsConnectedMock.mockReturnValue(true);
  listSessionsMock.mockReturnValue([]);
  stripDesignContextCommandMock.mockImplementation((prompt: string) => ({
    explicitRequested: false,
    sanitizedPrompt: prompt,
  }));
  stripOurComponentsCommandMock.mockImplementation((prompt: string) => ({
    explicitRequested: false,
    sanitizedPrompt: prompt,
  }));
  getTurnCheckpointManagerMock.mockReturnValue({ startCheckpointing: vi.fn() });
  // The CoS README is genuinely absent on the local lane → `absent` outcome.
  mockReadFile.mockImplementation(async () => {
    throw makeEnoent();
  });
  mockReaddir.mockResolvedValue([]);
});

describe('turnAdmission — REAL evaluator call-site integration (F3)', () => {
  it('GREEN HALF: a desktop user turn reaches the REAL gate and BLOCKS on a genuinely-missing CoS', async () => {
    // Proves the gate is live: the request options have no system-continuation /
    // non-interactive flag, surface is desktop → the real evaluator runs, reads
    // `absent` (mocked ENOENT), and (onboarded) blocks missing-after-setup.
    const input = makeInput();
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('terminal');
    if (result.status !== 'terminal') return;
    expect(result.reason).toBe('chief-of-staff-unavailable');
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const error = dispatchAgentErrorEventMock.mock.calls[0][2];
    expect((error as { __chiefOfStaffReason?: string }).__chiefOfStaffReason).toBe('missing-after-setup');
  });

  it('isSystemContinuation:true flows from request options → predicate excludes → never blocks (no fs read)', async () => {
    const input = makeInput({
      turnOptions: { sessionId: 'cos-callsite-session', resetConversation: false, isSystemContinuation: true },
    });
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    // The gate short-circuited before any CoS read.
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('cloud submission / virtual-window path (surface=cloud, NON-NULL window) → never blocks [FLEET-OUTAGE guard]', async () => {
    surfaceRef.current = 'cloud';
    const virtualWindow = { isDestroyed: () => false } as never; // like cloudEventBroadcaster.virtualWindow
    const input = makeInput({ win: virtualWindow });
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
