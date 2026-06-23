import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setTracker, type Tracker } from '@core/tracking';
import {
  turnObservability,
  classifyTerminalKind,
  TURN_TERMINAL_EVENT,
  TURN_TERMINAL_SCHEMA_VERSION,
} from '../turnObservability';

interface Captured {
  event: string;
  props?: Record<string, unknown>;
}

function installCapturingTracker(): { events: Captured[] } {
  const events: Captured[] = [];
  const tracker: Tracker = {
    track: (event, props) => {
      events.push({ event, props });
    },
    identify: () => {},
    getAnonymousId: () => 'anon',
    isAvailable: () => true,
  };
  setTracker(tracker);
  return { events };
}

const NOOP_TRACKER: Tracker = {
  track: () => {},
  identify: () => {},
  getAnonymousId: () => '',
  isAvailable: () => false,
};

const baseStart = () => ({
  startedAt: Date.now() - 1234,
  origin: 'manual' as const,
  sessionKind: 'conversation' as string | null,
  requestedProvider: 'anthropic',
  rendererSessionId: null,
  surface: 'desktop' as const,
});

describe('turnObservability', () => {
  beforeEach(() => {
    turnObservability.__resetForTest();
  });

  afterEach(() => {
    turnObservability.__resetForTest();
    setTracker(NOOP_TRACKER);
  });

  it('emits exactly one terminal event with the expected dimensions', () => {
    const { events } = installCapturingTracker();
    turnObservability.startTurn('t1', baseStart());
    turnObservability.completeTurn('t1', { reason: 'completed' });

    expect(events).toHaveLength(1);
    const { event, props } = events[0];
    expect(event).toBe(TURN_TERMINAL_EVENT);
    expect(props).toMatchObject({
      schemaVersion: TURN_TERMINAL_SCHEMA_VERSION,
      turnId: 't1',
      surface: 'desktop',
      origin: 'manual',
      turnCategory: 'conversation',
      requestedProvider: 'anthropic',
      terminalKind: 'success',
      cleanupReason: 'completed',
      appRetryCount: 0,
      offlineDetected: false,
    });
    expect(typeof props?.durationMs).toBe('number');
    expect(props?.durationMs as number).toBeGreaterThanOrEqual(0);
    // Registry enrichment (resolved provider/auth/model) is intentionally NOT
    // emitted by the thin slice — deferred to a later stage (PLAN Appendix).
    expect(props).not.toHaveProperty('resolvedProvider');
    expect(props).not.toHaveProperty('authMethod');
    expect(props).not.toHaveProperty('resolvedModel');
    // Entry dropped after emit.
    expect(turnObservability.__activeCountForTest()).toBe(0);
  });

  it('is idempotent — a repeated terminal call emits at most once', () => {
    const { events } = installCapturingTracker();
    turnObservability.startTurn('t1', baseStart());
    turnObservability.completeTurn('t1', { reason: 'completed' });
    turnObservability.completeTurn('t1', { reason: 'completed' });
    expect(events).toHaveLength(1);
  });

  it('no-ops when completing an unobserved turn (and does not throw)', () => {
    const { events } = installCapturingTracker();
    expect(() => turnObservability.completeTurn('never-started', { reason: 'completed' })).not.toThrow();
    expect(events).toHaveLength(0);
  });

  it('accumulates app retries and the offline flag', () => {
    const { events } = installCapturingTracker();
    turnObservability.startTurn('t1', baseStart());
    turnObservability.recordAppRetry('t1');
    turnObservability.recordAppRetry('t1');
    turnObservability.recordOfflineDetected('t1');
    turnObservability.completeTurn('t1', { reason: 'message_timeout' });

    expect(events[0].props).toMatchObject({
      appRetryCount: 2,
      offlineDetected: true,
      terminalKind: 'error',
    });
  });

  it('startTurn is first-wins: fallback re-entry preserves startedAt and accumulated counts', () => {
    const { events } = installCapturingTracker();
    const first = { ...baseStart(), requestedProvider: 'anthropic' };
    turnObservability.startTurn('t1', first);
    turnObservability.recordAppRetry('t1');

    // Fallback re-enters admission with the same turnId but a different provider.
    turnObservability.startTurn('t1', { ...baseStart(), requestedProvider: 'openrouter', startedAt: Date.now() });
    turnObservability.recordAppRetry('t1');

    turnObservability.completeTurn('t1', { reason: 'completed' });

    expect(events[0].props).toMatchObject({
      requestedProvider: 'anthropic', // first-wins (NOT the re-entry's 'openrouter')
      appRetryCount: 2, // preserved across re-entry
    });
  });

  it('fails open when the tracker throws — no entry leak, no propagation', () => {
    const throwingTracker: Tracker = {
      track: () => {
        throw new Error('analytics down');
      },
      identify: () => {},
      getAnonymousId: () => '',
      isAvailable: () => true,
    };
    setTracker(throwingTracker);
    turnObservability.startTurn('t1', baseStart());
    expect(() => turnObservability.completeTurn('t1', { reason: 'completed' })).not.toThrow();
    // Entry still dropped despite the throw (once-only guaranteed).
    expect(turnObservability.__activeCountForTest()).toBe(0);
  });

  it('record* are safe with an undefined or unknown turnId', () => {
    installCapturingTracker();
    expect(() => turnObservability.recordAppRetry(undefined)).not.toThrow();
    expect(() => turnObservability.recordOfflineDetected(undefined)).not.toThrow();
    expect(() => turnObservability.recordAppRetry('unknown')).not.toThrow();
    expect(turnObservability.__activeCountForTest()).toBe(0);
  });

  it('hashes the renderer session id and never leaks raw session/PII keys', () => {
    const { events } = installCapturingTracker();
    turnObservability.startTurn('t1', { ...baseStart(), rendererSessionId: 'sess-secret-123' });
    turnObservability.completeTurn('t1', { reason: 'completed' });

    const props = events[0].props ?? {};
    expect(props.sessionIdHash).toBeDefined();
    expect(props.sessionIdHash).not.toBe('sess-secret-123');
    // No raw session id, prompt, path, or email-shaped values anywhere.
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain('sess-secret-123');
    expect(props).not.toHaveProperty('rendererSessionId');
    expect(props).not.toHaveProperty('prompt');
  });

  it('maps sessionKind to the coarse turnCategory dimension', () => {
    const cases: Array<[string | null, string]> = [
      ['automation', 'automation'],
      ['automation-insight', 'automation'],
      ['memory-update', 'memory'],
      ['conversation', 'conversation'],
      ['meeting-qa', 'conversation'],
      ['calendar-sync', 'conversation'],
      [null, 'conversation'],
    ];
    for (const [sessionKind, expected] of cases) {
      turnObservability.__resetForTest();
      const { events } = installCapturingTracker();
      turnObservability.startTurn('t1', { ...baseStart(), sessionKind });
      turnObservability.completeTurn('t1', { reason: 'completed' });
      expect(events[0].props?.turnCategory).toBe(expected);
    }
  });

  it('omits sessionIdHash when there is no renderer session, and maps terminalKind', () => {
    const { events } = installCapturingTracker();
    turnObservability.startTurn('t1', baseStart()); // rendererSessionId: null
    turnObservability.completeTurn('t1', { reason: 'aborted' });
    const props = events[0].props ?? {};
    expect(props).not.toHaveProperty('sessionIdHash');
    expect(props.terminalKind).toBe('aborted');
  });

  it('surfaces a pre-dispatch wedge as its own alertable terminalKind', () => {
    // The previously-invisible failure: a turn that wedged before reaching the
    // model (dead cloud mount starving the libuv pool). The Stage-2 liveness
    // guard ends it via completeTurnCleanup(turnId, 'pre_turn_setup_timeout', …),
    // which flows here — it must NOT be lumped into the generic 'error' bucket.
    const { events } = installCapturingTracker();
    turnObservability.startTurn('t1', baseStart());
    turnObservability.completeTurn('t1', { reason: 'pre_turn_setup_timeout' });
    expect(events[0].props).toMatchObject({
      terminalKind: 'pre_dispatch_setup_timeout',
      cleanupReason: 'pre_turn_setup_timeout',
    });
  });

  // The client retry seam calls `recordAppRetry(getTurnContext()?.turnId)`. The
  // ALS turn-context plumbing lives in `@core/logger` (globally mocked here —
  // see `vitest.setup.ts`) and the production wrap is at `agentTurnExecute.ts`
  // (`runWithTurnContext`), so this test exercises the service's contract with
  // the resolved turnId rather than re-testing the mocked ALS.
  it('records retries/offline for the resolved turn id (client-seam contract)', () => {
    const { events } = installCapturingTracker();
    const resolvedTurnId: string | undefined = 'tctx'; // what getTurnContext()?.turnId yields in prod
    turnObservability.startTurn('tctx', baseStart());
    turnObservability.recordAppRetry(resolvedTurnId);
    turnObservability.recordOfflineDetected(resolvedTurnId);
    turnObservability.completeTurn('tctx', { reason: 'message_timeout' });
    expect(events[0].props).toMatchObject({ appRetryCount: 1, offlineDetected: true });
  });
});

describe('classifyTerminalKind', () => {
  it('maps completed* to success', () => {
    expect(classifyTerminalKind('completed')).toBe('success');
    expect(classifyTerminalKind('completed-with-followup')).toBe('success');
  });

  it('maps abort reasons to aborted', () => {
    expect(classifyTerminalKind('aborted')).toBe('aborted');
    expect(classifyTerminalKind('user_stopped')).toBe('aborted');
    expect(classifyTerminalKind('superseded')).toBe('aborted');
  });

  it('maps admission-blocked reasons', () => {
    expect(classifyTerminalKind('missing-auth')).toBe('admission_blocked');
    expect(classifyTerminalKind('codex-not-connected')).toBe('admission_blocked');
    expect(classifyTerminalKind('openrouter-not-connected')).toBe('admission_blocked');
    expect(classifyTerminalKind('mindstone-key-missing')).toBe('admission_blocked');
    expect(classifyTerminalKind('missing-core-directory')).toBe('admission_blocked');
  });

  it('maps watchdog/stall reasons to watchdog_aborted', () => {
    expect(classifyTerminalKind('watchdog-abort')).toBe('watchdog_aborted');
    expect(classifyTerminalKind('aborted-awaiting-api-stall')).toBe('watchdog_aborted');
  });

  it('maps the pre-dispatch liveness-guard reason to its own distinct kind', () => {
    // The exact literal passed to completeTurnCleanup when the guard fires.
    expect(classifyTerminalKind('pre_turn_setup_timeout')).toBe('pre_dispatch_setup_timeout');
    // Must NOT fall into the generic 'error' bucket (the whole point of the split)
    // and must NOT be confused with a post-dispatch watchdog abort.
    expect(classifyTerminalKind('pre_turn_setup_timeout')).not.toBe('error');
    expect(classifyTerminalKind('pre_turn_setup_timeout')).not.toBe('watchdog_aborted');
  });

  it('defaults unknown reasons to error', () => {
    expect(classifyTerminalKind('provider_error')).toBe('error');
    expect(classifyTerminalKind('pre-runtime-failure')).toBe('error');
  });
});

describe('TURN_TERMINAL_SCHEMA_VERSION', () => {
  it('is pinned at 2 (deliberate bump: added the pre_dispatch_setup_timeout terminalKind)', () => {
    // Locks the schema bump so any future dimension change is a conscious edit.
    expect(TURN_TERMINAL_SCHEMA_VERSION).toBe(2);
  });
});
