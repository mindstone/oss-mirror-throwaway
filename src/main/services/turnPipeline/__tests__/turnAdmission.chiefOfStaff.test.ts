/**
 * Stage 3 (260622 render-preview-cloud-hang) — the turn-admission Chief-of-Staff
 * gate. THE caller/surface matrix is the core test target (PLAN Verification Notes):
 *
 *  - Desktop (win !== null) reconnecting / unreadable / missing-after-setup
 *      → terminal block + a `chief-of-staff-unavailable` error event carrying the
 *        correct `reason`; turn does NOT proceed (NOT a silent degrade).
 *  - Desktop absent-but-NOT-onboarded → admit (legit first-run; template path).
 *  - Desktop ok → admit, and the read content is threaded forward (F2).
 *  - Cloud / headless (win === null) → ADMIT + structured WARN, NEVER block
 *      (the single most important safety property — a cloud no-op fs returns
 *      `reconnecting` for every read, so blocking would be a fleet outage).
 *  - reconnecting STRICTLY outranks the onboarding gate.
 *
 * The gate's outcome→verdict mapping (`evaluateChiefOfStaffAdmission`) is driven
 * via the wired executor in the real-reader integration test
 * (`chiefOfStaffAdmission.test.ts` + the Stage-1 reader test); here we mock the
 * helper so the matrix focuses on the GATE's dispatch/block/admit/thread behaviour.
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
  evaluateChiefOfStaffAdmissionMock,
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
  evaluateChiefOfStaffAdmissionMock: vi.fn(),
  // Mutable so each test can drive the platform surface (desktop/cloud/mobile/cli).
  surfaceRef: { current: 'desktop' as 'desktop' | 'cloud' | 'mobile' | 'cli' },
}));

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

vi.mock('@core/services/turnPipeline/chiefOfStaffAdmission', async () => {
  const actual = await vi.importActual<
    typeof import('@core/services/turnPipeline/chiefOfStaffAdmission')
  >('@core/services/turnPipeline/chiefOfStaffAdmission');
  return {
    ...actual,
    evaluateChiefOfStaffAdmission: evaluateChiefOfStaffAdmissionMock,
  };
});

import { admit } from '../turnAdmission';

// A fake desktop window — only `win !== null` matters to the gate.
const FAKE_WIN = { isDestroyed: () => false } as never;

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/core',
    activeProvider: 'anthropic',
    claude: { apiKey: 'test-key', model: 'claude-sonnet-4-5' },
    models: { apiKey: 'test-key' },
    localModel: { profiles: [], activeProfileId: null },
    ...overrides,
  } as unknown as AppSettings;
}

function makeInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  const sessionId = overrides.rendererSessionId ?? 'cos-gate-session';
  return {
    turnId: 'turn-1',
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
  // Default: admit with no prefetch (overridden per-test).
  evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'admit', outcome: 'absent' });
});

describe('turnAdmission — Chief-of-Staff gate (desktop)', () => {
  it('reconnecting → terminal block + chief-of-staff-unavailable error event (reason reconnecting)', async () => {
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const input = makeInput();
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('terminal');
    if (result.status !== 'terminal') return;
    expect(result.reason).toBe('chief-of-staff-unavailable');

    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const [win, turnId, error, opts] = dispatchAgentErrorEventMock.mock.calls[0];
    expect(win).toBe(FAKE_WIN);
    expect(turnId).toBe('turn-1');
    expect(opts.errorKindOverride).toBe('chief-of-staff-unavailable');
    expect((error as { __chiefOfStaffReason?: string }).__chiefOfStaffReason).toBe('reconnecting');
  });

  it('unreadable → terminal block + error event (reason unreadable)', async () => {
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'unreadable' });
    const input = makeInput();
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('terminal');
    if (result.status !== 'terminal') return;
    expect(result.reason).toBe('chief-of-staff-unavailable');
    const error = dispatchAgentErrorEventMock.mock.calls[0][2];
    expect((error as { __chiefOfStaffReason?: string }).__chiefOfStaffReason).toBe('unreadable');
  });

  it('missing-after-setup → terminal block + error event (reason missing-after-setup)', async () => {
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'missing-after-setup' });
    const input = makeInput();
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('terminal');
    if (result.status !== 'terminal') return;
    expect(result.reason).toBe('chief-of-staff-unavailable');
    const error = dispatchAgentErrorEventMock.mock.calls[0][2];
    expect((error as { __chiefOfStaffReason?: string }).__chiefOfStaffReason).toBe('missing-after-setup');
  });

  it('absent + NOT onboarded → admit (legit first-run; template path)', async () => {
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'admit', outcome: 'absent' });
    const input = makeInput();
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.prefetchedChiefOfStaffContent).toBeUndefined();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('ok → admit AND threads the prefetched Chief-of-Staff content forward (F2)', async () => {
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({
      decision: 'admit',
      content: '# Chief of Staff body',
      outcome: 'ok',
    });
    const input = makeInput();
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.prefetchedChiefOfStaffContent).toBe('# Chief of Staff body');
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });
});

describe('turnAdmission — Chief-of-Staff gate off-desktop (surface !== desktop) NEVER blocks', () => {
  it('off-desktop + reconnecting verdict path is NEVER consulted → admit, no block, no error event', async () => {
    // The gate keys on `surface === 'desktop'`, NOT window presence. Off-desktop
    // (cloud here) it must short-circuit BEFORE evaluating the verdict, even with
    // a null window. (The window-presence proxy was the old, leaky predicate.)
    surfaceRef.current = 'cloud';
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const input = makeInput({ win: null });
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // No CoS read at all off-desktop; no block, no error event.
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    expect(result.value.prefetchedChiefOfStaffContent).toBeUndefined();
  });

  it('emits an observable WARN when the gate is skipped (never silent)', async () => {
    surfaceRef.current = 'cloud';
    const logger = makeLogger();
    const input = makeInput({ win: null });
    await admit(input, input.abortController.signal, logger as never);

    const warnedAboutGate = logger.warn.mock.calls.some(
      (call) => typeof call[1] === 'string' && /not a user-initiated desktop interactive turn/i.test(call[1]),
    );
    expect(warnedAboutGate).toBe(true);
  });
});

// ===========================================================================
// REVIEW-ROUND-2 REFINEMENT (Decision Log 2026-06-22 14:10): the gate predicate
// is now `surface === 'desktop' AND interactive policy AND NOT (nonInteractive |
// systemContinuation)`. The OLD `win !== null` predicate was leaky on both ends:
//   • cloud passes a NON-NULL virtual window → would block the whole fleet;
//   • desktop background/proactive/system turns carry a real window but are not
//     user-initiated → would wrongly block + pop recovery UI.
// These tests close that false-green (GPT-F3) and prove never-block for each
// enumerated caller, including a red→green check against the old predicate.
// ===========================================================================
describe('turnAdmission — Chief-of-Staff gate NEVER blocks off-desktop / non-interactive turns', () => {
  it('cloud submission path (surface=cloud, NON-NULL virtual window, blocking verdict) → admit, never blocks [FLEET-OUTAGE guard]', async () => {
    // The exact shape of the cloud submission path: cloud passes
    // `cloudEventBroadcaster.virtualWindow` (a NON-NULL window) into startAgentTurn.
    // Under the OLD `win !== null` predicate this would have terminally blocked
    // EVERY cloud turn. The verdict is a block — but it must NEVER be consulted.
    surfaceRef.current = 'cloud';
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const virtualWindow = { isDestroyed: () => false } as never; // non-null, like virtualWindow
    const input = makeInput({ win: virtualWindow });

    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('RED→GREEN vs the OLD `win !== null` predicate: the cloud virtual window WOULD have blocked, the new gate admits', async () => {
    // Documents the exact regression the refinement fixes. The cloud submission
    // path passes a NON-NULL virtual window, so the OLD predicate (`win !== null`)
    // would have evaluated the CoS verdict and terminally blocked — a fleet
    // outage. The NEW predicate keys on surface, so cloud admits.
    surfaceRef.current = 'cloud';
    const virtualWindow = { isDestroyed: () => false } as never;
    const oldPredicateWouldEvaluate = virtualWindow !== null; // the old `win !== null`
    expect(oldPredicateWouldEvaluate).toBe(true); // RED: old code reaches the block path

    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const input = makeInput({ win: virtualWindow });
    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    // GREEN: the new gate never consulted the verdict and admitted.
    expect(result.status).toBe('ok');
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('mobile surface (non-null window, blocking verdict) → admit, never blocks', async () => {
    surfaceRef.current = 'mobile';
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'unreadable' });
    const input = makeInput({ win: { isDestroyed: () => false } as never });

    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('renderer-originated background automation (real window, sessionType=automation, blocking verdict) → admit, never blocks', async () => {
    // Onboarding discovery dispatches a background automation turn through the
    // normal renderer agent:turn IPC → the sender window is REAL (non-null), but
    // sessionType:'automation' makes origin 'automation' → excluded.
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const input = makeInput({
      win: FAKE_WIN,
      turnOptions: { sessionId: 'cos-gate-session', resetConversation: false, sessionType: 'automation' },
    });

    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('live-meeting coach proactive turn (real window, nonInteractiveTurn=true, blocking verdict) → admit, never blocks', async () => {
    // The proactive coaching check runs on a REAL desktop window with interactive
    // policy (no sessionType), so policy alone can't distinguish it — the live
    // coach sets nonInteractiveTurn:true at its call site.
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const input = makeInput({
      win: FAKE_WIN,
      turnOptions: { sessionId: 'cos-gate-session', resetConversation: false, nonInteractiveTurn: true },
    });

    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('background memory-update turn (desktop, memory-update-* session id, real window, blocking verdict) → admit, never blocks', async () => {
    // The desktop memory-update wrapper runs on the main process (surface=desktop)
    // with interactive policy and no per-call flag — it relies on the session-kind
    // gate: a `memory-update-*` session id classifies as `memory-update`, not
    // `conversation`, so it is excluded.
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const input = makeInput({
      win: FAKE_WIN,
      rendererSessionId: 'memory-update-abc',
      turnOptions: { sessionId: 'memory-update-abc', resetConversation: true },
    });

    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('system continuation (real window, isSystemContinuation=true, blocking verdict) → admit, never blocks', async () => {
    // A tool/memory approval retry the app dispatches on the user's behalf: real
    // window, interactive policy, but isSystemContinuation:true → excluded.
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'missing-after-setup' });
    const input = makeInput({
      win: FAKE_WIN,
      turnOptions: { sessionId: 'cos-gate-session', resetConversation: false, isSystemContinuation: true },
    });

    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('ok');
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  // STAGE 4 (260622): the "Run without my instructions" recovery escape.
  it('proceedWithoutChiefOfStaff=true on a desktop user turn → admit on template, never blocks, verdict NOT consulted, observable WARN', async () => {
    surfaceRef.current = 'desktop';
    // Even with a hard blocking verdict, the escape must SKIP the block entirely
    // (the verdict is never even evaluated) and admit on the template.
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const logger = makeLogger();
    const input = makeInput({
      win: FAKE_WIN,
      turnOptions: {
        sessionId: 'cos-gate-session',
        resetConversation: false,
        proceedWithoutChiefOfStaff: true,
      },
    });

    const result = await admit(input, input.abortController.signal, logger as never);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // No CoS read at all — the escape short-circuits BEFORE the verdict.
    expect(evaluateChiefOfStaffAdmissionMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    // No template content prefetched (we deliberately skip the read).
    expect(result.value.prefetchedChiefOfStaffContent).toBeUndefined();
    // Observable, never silent: a structured WARN naming the user's choice.
    const warnedAboutEscape = logger.warn.mock.calls.some(
      (call) =>
        typeof call[1] === 'string' &&
        /proceed without Chief-of-Staff instructions/i.test(call[1]),
    );
    expect(warnedAboutEscape).toBe(true);
  });

  it('RED→GREEN: a desktop user turn (real window, interactive) STILL blocks — the surface gate did not over-broaden', async () => {
    // The complement of the fleet-outage guard: a genuine desktop user turn must
    // still block. (If the predicate had collapsed to "never block", this would
    // fail — it is the green half of the discrimination.)
    surfaceRef.current = 'desktop';
    evaluateChiefOfStaffAdmissionMock.mockResolvedValue({ decision: 'block', reason: 'reconnecting' });
    const input = makeInput({ win: FAKE_WIN });

    const result = await admit(input, input.abortController.signal, makeLogger() as never);

    expect(result.status).toBe('terminal');
    if (result.status !== 'terminal') return;
    expect(result.reason).toBe('chief-of-staff-unavailable');
    expect(evaluateChiefOfStaffAdmissionMock).toHaveBeenCalledTimes(1);
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
  });
});
