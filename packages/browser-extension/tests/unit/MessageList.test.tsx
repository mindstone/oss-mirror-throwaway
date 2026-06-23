// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildConversationEntries,
  SHARED_CHAT_UI_COPY,
} from '@rebel/shared/chatUI';
import MessageList from '../../src/sidepanel/components/MessageList';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('MessageList', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('renders completed messages and a streaming assistant draft from the shared chatUI view model', () => {
    const now = Date.now();
    const messages = [
      {
        id: 'user-1',
        role: 'user' as const,
        text: 'Summarise this page.',
        createdAt: now - 5 * 60_000,
      },
      {
        id: 'assistant-1',
        role: 'assistant' as const,
        text: 'Here is the short version.',
        createdAt: now - 60_000,
      },
    ];
    const expectedEntries = buildConversationEntries({
      messages,
      streamingText: 'Working on the rest…',
      turnStatus: 'running',
      now,
      formatTimestampTitle: (date) => date.toLocaleString(),
    });
    const expectedMessageEntries = expectedEntries.filter((entry) => entry.kind === 'message');
    const expectedStreamingEntry = expectedEntries.find((entry) => entry.kind === 'streaming');

    mounted = mount(
      <MessageList
        messages={messages}
        streamingText="Working on the rest…"
        turnStatus="running"
      />,
    );

    const timestamps = Array.from(
      mounted.container.querySelectorAll<HTMLElement>('[data-testid="message-timestamp"]'),
    );
    expect(timestamps.map((node) => node.textContent)).toEqual(
      expectedMessageEntries.map((entry) => entry.timestamp.relativeLabel),
    );
    expect(timestamps.map((node) => node.getAttribute('title'))).toEqual(
      expectedMessageEntries.map((entry) => entry.timestamp.title),
    );
    expect(
      mounted.container.querySelector('[data-testid="streaming-text"]')?.textContent,
    ).toContain(expectedStreamingEntry?.kind === 'streaming' ? expectedStreamingEntry.text : '');
  });

  it('renders the shared thinking copy when the turn is running without streamed tokens', () => {
    mounted = mount(
      <MessageList
        messages={[]}
        streamingText=""
        turnStatus="running"
      />,
    );

    expect(
      mounted.container.querySelector('[data-testid="thinking-indicator"]')?.textContent,
    ).toContain(SHARED_CHAT_UI_COPY.thinkingLabel);
  });

  it('surfaces the shared partial-reply indicator for degraded assistant placeholders', () => {
    const now = Date.now();
    const messages = [
      {
        id: 'stream-turn-1',
        role: 'assistant' as const,
        text: 'Here is the part that made it through.',
        createdAt: now - 5_000,
        partial: true,
      },
    ];

    mounted = mount(
      <MessageList
        messages={messages}
        streamingText=""
        turnStatus="idle"
      />,
    );

    expect(
      mounted.container.querySelector('[data-testid="partial-indicator"]')?.textContent,
    ).toContain(SHARED_CHAT_UI_COPY.partialMessageLabel);
  });
});
