import { describe, expect, it } from 'vitest';
import { SHARED_CHAT_UI_COPY } from '../copy';
import {
  buildConversationEntries,
  buildConversationNotice,
  mapMessageRole,
  mergeStreamingAssistantText,
  resolveHeaderStatus,
} from '../viewModels';

describe('chatUI view-model helpers', () => {
  it('maps user and assistant message roles into stable render metadata', () => {
    expect(mapMessageRole('user')).toEqual({
      role: 'user',
      direction: 'outgoing',
      speakerLabel: SHARED_CHAT_UI_COPY.userLabel,
    });
    expect(mapMessageRole('assistant')).toEqual({
      role: 'assistant',
      direction: 'incoming',
      speakerLabel: SHARED_CHAT_UI_COPY.assistantLabel,
    });
  });

  it('merges assistant streaming deltas in arrival order', () => {
    expect(
      mergeStreamingAssistantText(['Hello', ' ', '<world>', '!']),
    ).toBe('Hello <world>!');
  });

  it('matches the extension transcript semantics for completed messages plus a streaming draft', () => {
    const now = 10 * 60_000;
    const entries = buildConversationEntries({
      messages: [
        { id: 'user-1', role: 'user', text: 'hello', createdAt: now - 5 * 60_000 },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi there',
          createdAt: now - 60_000,
        },
      ],
      streamingText: 'Working on it…',
      turnStatus: 'running',
      now,
      formatTimestampTitle: (date) => `stamp:${date.getTime()}`,
    });

    expect(entries).toEqual([
      {
        kind: 'message',
        id: 'user-1',
        role: 'user',
        direction: 'outgoing',
        speakerLabel: 'You',
        text: 'hello',
        partial: false,
        partialLabel: null,
        timestamp: {
          value: now - 5 * 60_000,
          relativeLabel: '5m ago',
          title: `stamp:${now - 5 * 60_000}`,
        },
      },
      {
        kind: 'message',
        id: 'assistant-1',
        role: 'assistant',
        direction: 'incoming',
        speakerLabel: 'Rebel',
        text: 'Hi there',
        partial: false,
        partialLabel: null,
        timestamp: {
          value: now - 60_000,
          relativeLabel: '1m ago',
          title: `stamp:${now - 60_000}`,
        },
      },
      {
        kind: 'streaming',
        id: 'streaming-assistant',
        role: 'assistant',
        direction: 'incoming',
        speakerLabel: 'Rebel',
        text: 'Working on it…',
        showCursor: true,
      },
    ]);
  });

  it('marks degraded assistant placeholders with the shared partial-reply label', () => {
    const now = 10 * 60_000;
    const entries = buildConversationEntries({
      messages: [
        {
          id: 'stream-turn-1',
          role: 'assistant',
          text: 'Still working on it',
          createdAt: now - 30_000,
          partial: true,
        },
      ],
      streamingText: '',
      turnStatus: 'idle',
      now,
      formatTimestampTitle: (date) => `stamp:${date.getTime()}`,
    });

    expect(entries).toEqual([
      {
        kind: 'message',
        id: 'stream-turn-1',
        role: 'assistant',
        direction: 'incoming',
        speakerLabel: 'Rebel',
        text: 'Still working on it',
        partial: true,
        partialLabel: SHARED_CHAT_UI_COPY.partialMessageLabel,
        timestamp: {
          value: now - 30_000,
          relativeLabel: 'just now',
          title: `stamp:${now - 30_000}`,
        },
      },
    ]);
  });

  it('matches the Office taskpane semantics for a running turn with no tokens yet', () => {
    expect(
      buildConversationEntries({
        messages: [],
        streamingText: '',
        turnStatus: 'running',
      }),
    ).toEqual([
      {
        kind: 'thinking',
        id: 'thinking-assistant',
        role: 'assistant',
        direction: 'incoming',
        speakerLabel: 'Rebel',
        label: SHARED_CHAT_UI_COPY.thinkingLabel,
      },
    ]);
  });

  it('resolves header-status priority as not-ready > reconnecting > degraded > connected', () => {
    expect(
      resolveHeaderStatus({
        surfaceReady: false,
        connectionHealth: 'healthy',
      }),
    ).toBe('not-ready');
    expect(
      resolveHeaderStatus({
        surfaceReady: true,
        connectionHealth: 'reconnecting',
      }),
    ).toBe('reconnecting');
    expect(
      resolveHeaderStatus({
        surfaceReady: true,
        connectionHealth: 'degraded',
      }),
    ).toBe('degraded');
    expect(
      resolveHeaderStatus({
        surfaceReady: true,
        connectionHealth: 'healthy',
      }),
    ).toBe('connected');
  });

  it('builds state notices for reconnecting, offline, revoked, and generic error states', () => {
    expect(
      buildConversationNotice({
        phase: 'reconnecting',
      }),
    ).toEqual({
      kind: 'reconnecting',
      tone: 'info',
      message: null,
    });
    expect(
      buildConversationNotice({
        phase: 'offline',
        errorMessage: "Rebel isn't responding right now. Try again in a moment.",
      }),
    ).toEqual({
      kind: 'offline',
      tone: 'warning',
      message: "Rebel isn't responding right now. Try again in a moment.",
    });
    expect(
      buildConversationNotice({
        phase: 'revoked',
      }),
    ).toEqual({
      kind: 'revoked',
      tone: 'danger',
      message: null,
    });
    expect(
      buildConversationNotice({
        phase: 'idle',
        errorMessage: 'Something went sideways. Try again in a moment.',
      }),
    ).toEqual({
      kind: 'error',
      tone: 'danger',
      message: 'Something went sideways. Try again in a moment.',
    });
  });
});
