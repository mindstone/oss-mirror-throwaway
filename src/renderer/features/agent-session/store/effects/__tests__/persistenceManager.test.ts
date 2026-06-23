import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import type { AgentSessionWithRuntime } from '../../../types';
import {
  createSummaryFromSession,
  saveAgentSessions,
  saveSession,
  saveSessionsSync,
} from '../persistenceManager';
import {
  isRendererLocalTerminalEvent,
  isRendererOptimisticTurnStartedEvent,
} from '../../sessionStore';
import {
  createRendererLocalTerminalEvent,
  createRendererOptimisticTurnStartedEvent,
} from '../../rendererLocalEventEgress';

function makeMessage(overrides: Partial<AgentTurnMessage> & Pick<AgentTurnMessage, 'id' | 'turnId' | 'role' | 'text'>): AgentTurnMessage {
  return { createdAt: Date.now(), ...overrides };
}

function makeSession(messages: AgentTurnMessage[]): AgentSessionWithRuntime {
  return {
    id: 'session-1',
    title: 'Test Session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages,
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  };
}

describe('createSummaryFromSession', () => {
  it('uses visible messages for preview when last message is hidden', () => {
    const messages = [
      makeMessage({ id: '1', turnId: 't1', role: 'user', text: 'What color do you prefer?' }),
      makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'I like blue!' }),
      makeMessage({
        id: '3',
        turnId: 't2',
        role: 'user',
        text: '<conversation_history>\ncontext\n</conversation_history>\n\nThe user answered your questions: color=blue',
        isHidden: true,
        messageOrigin: 'system-continuation',
      }),
    ];

    const summary = createSummaryFromSession(makeSession(messages));

    expect(summary.preview).not.toContain('<conversation_history>');
    expect(summary.preview).toContain('I like blue');
    expect(summary.messageCount).toBe(2);
    expect(summary.hasUserMessages).toBe(true);
  });

  it('uses visible messages for preview when hidden message has no isHidden flag (legacy)', () => {
    const messages = [
      makeMessage({ id: '1', turnId: 't1', role: 'user', text: 'Hello there' }),
      makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'Hi!' }),
      makeMessage({
        id: '3',
        turnId: 't2',
        role: 'user',
        text: '<conversation_history>\nold context\n</conversation_history>\n\nThe user answered your questions: answer=yes',
      }),
    ];

    const summary = createSummaryFromSession(makeSession(messages));

    expect(summary.preview).not.toContain('<conversation_history>');
    expect(summary.preview).toContain('Hi');
    expect(summary.messageCount).toBe(2);
  });

  it('uses visible messages for preview when hidden via messageOrigin only', () => {
    const messages = [
      makeMessage({ id: '1', turnId: 't1', role: 'user', text: 'Ask me anything' }),
      makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'What is your name?' }),
      makeMessage({
        id: '3',
        turnId: 't2',
        role: 'user',
        text: 'My name is Alice',
        messageOrigin: 'system-continuation',
      }),
    ];

    const summary = createSummaryFromSession(makeSession(messages));

    expect(summary.preview).toContain('What is your name');
    expect(summary.messageCount).toBe(2);
  });

  it('excludes onboarding system prompts from preview', () => {
    const messages = [
      makeMessage({ id: '1', turnId: 't1', role: 'user', text: '[ONBOARDING CONTEXT] Welcome setup' }),
      makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'Welcome to Rebel!' }),
    ];

    const summary = createSummaryFromSession(makeSession(messages));

    expect(summary.preview).toContain('Welcome to Rebel');
    expect(summary.firstMessagePreview).toContain('Welcome to Rebel');
    expect(summary.messageCount).toBe(1);
    expect(summary.hasUserMessages).toBe(false);
  });

  it('handles session where all messages are hidden', () => {
    const messages = [
      makeMessage({
        id: '1',
        turnId: 't1',
        role: 'user',
        text: '<conversation_history>\ncontext\n</conversation_history>',
        isHidden: true,
      }),
    ];

    const summary = createSummaryFromSession(makeSession(messages));

    expect(summary.preview).toBe('');
    expect(summary.messageCount).toBe(0);
    expect(summary.hasUserMessages).toBe(false);
  });

  it('produces correct firstMessagePreview and lastMessagePreview with hidden messages', () => {
    const messages = [
      makeMessage({ id: '1', turnId: 't1', role: 'user', text: '[ONBOARDING CONTEXT] setup' }),
      makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'First visible response here' }),
      makeMessage({ id: '3', turnId: 't2', role: 'user', text: 'My actual question' }),
      makeMessage({ id: '4', turnId: 't2', role: 'assistant', text: 'And my answer' }),
      makeMessage({
        id: '5',
        turnId: 't3',
        role: 'user',
        text: '<conversation_history>\n</conversation_history>\nThe user answered',
        isHidden: true,
      }),
    ];

    const summary = createSummaryFromSession(makeSession(messages));

    expect(summary.firstMessagePreview).toContain('First visible response');
    expect(summary.lastMessagePreview).toContain('And my answer');
    expect(summary.messageCount).toBe(3);
  });

  it('projects meeting companion botId and startedAt into summary metadata', () => {
    const session = makeSession([]);
    session.meetingCompanion = {
      meetingUrl: 'https://zoom.us/j/123',
      botId: 'bot-123',
      meetingTitle: 'Weekly sync',
      startedAt: 1234,
    };

    const summary = createSummaryFromSession(session);

    expect(summary.meetingCompanion).toEqual({
      meetingUrl: 'https://zoom.us/j/123',
      botId: 'bot-123',
      startedAt: 1234,
    });
  });
});

describe('persistenceManager renderer-only egress stripping', () => {
  const SYNTHETIC_START_TS = 1_900_000_000_111;
  const SYNTHETIC_TERMINAL_TS = 1_900_000_000_222;

  const allEvents = (eventsByTurn: Record<string, unknown[]> | undefined): unknown[] =>
    Object.values(eventsByTurn ?? {}).flat();

  const expectNoRendererSynthetics = (
    eventsByTurn: Record<string, unknown[]> | undefined,
  ): void => {
    const events = allEvents(eventsByTurn);
    expect(
      events.some((event) => isRendererOptimisticTurnStartedEvent(event as AgentEvent)),
    ).toBe(false);
    expect(
      events.some((event) => isRendererLocalTerminalEvent(event as AgentEvent)),
    ).toBe(false);
    expect(
      events.some((event) => (event as { timestamp?: number }).timestamp === SYNTHETIC_START_TS),
    ).toBe(false);
    expect(
      events.some((event) => (event as { timestamp?: number }).timestamp === SYNTHETIC_TERMINAL_TS),
    ).toBe(false);
  };

  const makeSessionWithRendererSynthetics = (): AgentSessionWithRuntime => {
    const session = makeSession([
      makeMessage({ id: 'msg-1', turnId: 'turn-cache', role: 'user', text: 'hello' }),
    ]);
    return {
      ...session,
      activeTurnId: 'turn-cache',
      isBusy: true,
      eventsByTurn: {
        'turn-cache': [
          createRendererOptimisticTurnStartedEvent(SYNTHETIC_START_TS),
          createRendererLocalTerminalEvent(
            SYNTHETIC_TERMINAL_TS,
            'Renderer-only stop marker',
          ),
          { type: 'status', message: 'real-status', timestamp: SYNTHETIC_TERMINAL_TS + 1 },
        ],
      },
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      sessionsApi: {
        save: vi.fn().mockResolvedValue(undefined),
        saveSync: vi.fn().mockReturnValue({ success: true }),
        upsert: vi.fn().mockResolvedValue({ success: true }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('saveSession strips renderer-only events from upsert payload', async () => {
    const session = makeSessionWithRendererSynthetics();

    await saveSession(session);

    const upsertMock = vi.mocked(window.sessionsApi.upsert);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const payload = upsertMock.mock.calls[0]?.[0] as {
      eventsByTurn?: Record<string, unknown[]>;
    };
    expectNoRendererSynthetics(payload.eventsByTurn);
  });

  it('saveAgentSessions/saveSessionsSync strip renderer-only events from bulk payloads', async () => {
    const session = makeSessionWithRendererSynthetics();

    saveAgentSessions([session]);
    await vi.advanceTimersByTimeAsync(350);

    const saveMock = vi.mocked(window.sessionsApi.save);
    expect(saveMock).toHaveBeenCalledTimes(1);
    const asyncPayload = saveMock.mock.calls[0]?.[0] as Array<{
      eventsByTurn?: Record<string, unknown[]>;
    }>;
    expectNoRendererSynthetics(asyncPayload[0]?.eventsByTurn);

    saveSessionsSync([session]);
    const saveSyncMock = vi.mocked(window.sessionsApi.saveSync);
    expect(saveSyncMock).toHaveBeenCalledTimes(1);
    const syncPayload = saveSyncMock.mock.calls[0]?.[0] as Array<{
      eventsByTurn?: Record<string, unknown[]>;
    }>;
    expectNoRendererSynthetics(syncPayload[0]?.eventsByTurn);
  });
});
