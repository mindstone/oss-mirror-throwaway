// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AutomationRun, AutomationStoreState } from '@shared/types';
import { act, renderHook } from '@renderer/test-utils/hookTestHarness';
import {
  sessionStateKeyFromRuns,
  terminalRunStateKeyFromRuns,
  useAutomationsAppState,
} from '../useAutomationsAppState';

const makeSession = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 'automation-session-1',
  title: 'Automation session',
  createdAt: 1000,
  updatedAt: 1000,
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: null,
  origin: 'automation',
  ...overrides,
});

const makeRun = (overrides: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'run-1',
  automationId: 'automation-1',
  startedAt: 1000,
  status: 'running',
  trigger: 'manual',
  sessionId: 'automation-session-1',
  session: makeSession({ isBusy: true, activeTurnId: 'turn-1' }),
  ...overrides,
});

const makeState = (runs: AutomationRun[]): AutomationStoreState => ({
  version: 1,
  definitions: [],
  runs,
  quarantined: [],
  sessionTypeFilter: 'all',
});

let automationStateHandler: ((state: AutomationStoreState) => void) | null = null;

beforeEach(() => {
  automationStateHandler = null;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onAutomationState: vi.fn((handler: (state: AutomationStoreState) => void) => {
        automationStateHandler = handler;
        return vi.fn();
      }),
    },
  });
  Object.defineProperty(window, 'automationsApi', {
    configurable: true,
    value: {
      state: vi.fn().mockResolvedValue(makeState([])),
      setSessionTypeFilter: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Partial<Window>).api;
  delete (window as Partial<Window>).automationsApi;
});

describe('sessionStateKeyFromRuns', () => {
  it('changes when an automation reaches a terminal status even if session busy state is already unchanged', () => {
    const staleRunningKey = sessionStateKeyFromRuns([
      makeRun({
        status: 'running',
        session: makeSession({ isBusy: false, activeTurnId: null }),
      }),
    ]);

    const completedKey = sessionStateKeyFromRuns([
      makeRun({
        status: 'success',
        completedAt: 2000,
        session: makeSession({ isBusy: false, activeTurnId: null, updatedAt: 2000 }),
      }),
    ]);

    expect(completedKey).not.toBe(staleRunningKey);
  });
});

describe('terminalRunStateKeyFromRuns', () => {
  it('tracks completed run sessions for sidebar summary backfill', () => {
    const key = terminalRunStateKeyFromRuns([
      makeRun({
        status: 'running',
        sessionId: 'running-session',
        session: makeSession({ id: 'running-session' }),
      }),
      makeRun({
        status: 'completed_with_blocks',
        completedAt: 3000,
        sessionId: 'completed-session',
        session: null,
      }),
      makeRun({
        status: 'blocked_by_security',
        completedAt: 4000,
        sessionId: 'blocked-session',
        session: null,
      }),
    ]);

    expect(key).toBe('blocked-session:blocked_by_security:4000,completed-session:completed_with_blocks:3000');
  });
});

describe('useAutomationsAppState', () => {
  it('returns a fresh automation session snapshot when a run completes with unchanged busy state', () => {
    const { result, unmount } = renderHook(() => useAutomationsAppState());

    act(() => {
      automationStateHandler?.(makeState([
        makeRun({
          status: 'running',
          session: makeSession({
            title: 'Running snapshot',
            isBusy: false,
            activeTurnId: null,
          }),
        }),
      ]));
    });

    const runningSessions = result.current.automationSessions;
    expect(runningSessions[0]?.title).toBe('Running snapshot');

    act(() => {
      automationStateHandler?.(makeState([
        makeRun({
          status: 'success',
          completedAt: 2000,
          session: makeSession({
            title: 'Completed snapshot',
            updatedAt: 2000,
            isBusy: false,
            activeTurnId: null,
          }),
        }),
      ]));
    });

    expect(result.current.automationSessions).not.toBe(runningSessions);
    expect(result.current.automationSessions[0]?.title).toBe('Completed snapshot');
    expect(result.current.terminalRunStateKey).toBe('automation-session-1:success:2000');

    unmount();
  });
});
