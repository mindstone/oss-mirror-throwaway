// @vitest-environment happy-dom

import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionSummary } from '@shared/types';

const { mockSessionState } = vi.hoisted(() => ({
  mockSessionState: {
    sessionSummaries: [] as AgentSessionSummary[],
    currentSessionId: null as string | null,
  },
}));

vi.mock('../HomepageChat.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('@renderer/components/ui', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
    React.createElement('button', props, children),
  ConversationPill: ({ title, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) =>
    React.createElement('button', { ...props, title }, title),
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock('../../../agent-session/store/sessionStore', () => ({
  useSessionStore: <T,>(selector: (state: typeof mockSessionState) => T): T => selector(mockSessionState),
}));

vi.mock('../../../composer/components/MentionHeroInput', () => ({
  MentionHeroInput: (props: { value: string; onChange: (value: string) => void; onSubmit: () => void }) =>
    React.createElement('input', {
      'aria-label': 'Message input',
      value: props.value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => props.onChange(event.currentTarget.value),
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') props.onSubmit();
      },
    }),
}));

vi.mock('../../../composer/hooks/useFileAttachments', () => ({
  useFileAttachments: () => ({
    attachments: [],
    addFromClipboard: vi.fn(),
    addFromFileList: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    canAddMore: true,
    isDragging: false,
    handleDragEnter: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
  }),
}));

vi.mock('../../../composer/hooks/useTranscriptionMic', () => ({
  useTranscriptionMic: () => ({
    isRecording: false,
    isProcessing: false,
    toggleRecording: vi.fn(),
    stopAndSend: vi.fn(),
    audioLevel: 0,
  }),
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    homepage: {
      messageSubmitted: vi.fn(),
      recentSessionClicked: vi.fn(),
      historyLinkClicked: vi.fn(),
    },
  },
}));

import { HomepageChat } from '../HomepageChat';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSummary(overrides: Partial<AgentSessionSummary>): AgentSessionSummary {
  const now = Date.now();
  return {
    id: 'conversation-1',
    title: 'Conversation',
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    preview: '',
    messageCount: 1,
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    ...overrides,
  };
}

function renderHomepageChat() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(
      <HomepageChat
        onSubmit={vi.fn()}
        onNavigateToSessions={vi.fn()}
        onOpenSession={vi.fn()}
        mentionResultsForQuery={() => []}
        ensureLibraryIndex={vi.fn()}
        getRelativeLibraryPath={vi.fn()}
        hasWorkspace={false}
        hasConversations
        coreDirectory={null}
        libraryIndex={null}
        libraryIndexLoading={false}
        libraryIndexError={null}
        refreshLibraryIndex={vi.fn()}
      />,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('HomepageChat', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    mockSessionState.currentSessionId = null;
    mockSessionState.sessionSummaries = [];
  });

  it('excludes background sessions from recent pills by id kind', () => {
    const now = Date.now();
    mockSessionState.sessionSummaries = [
      makeSummary({ id: 'automation-source-capture--manual-origin', title: 'Manual-origin automation', origin: 'manual', updatedAt: now + 60 }),
      makeSummary({ id: 'meeting-analysis-1', title: 'Meeting analysis', origin: 'manual', updatedAt: now + 50 }),
      makeSummary({ id: 'use-case-discovery-1', title: 'Use-case discovery', origin: 'manual', updatedAt: now + 40 }),
      makeSummary({ id: 'automation-source-capture--1', title: 'Automation', origin: 'automation', updatedAt: now + 30 }),
      makeSummary({ id: 'conversation-1', title: 'Conversation', origin: 'manual', updatedAt: now + 20 }),
      makeSummary({ id: 'automation-insight-1', title: 'Automation insight', origin: 'automation', updatedAt: now + 10 }),
    ];

    const mounted = renderHomepageChat();
    const pillTitles = Array.from(mounted.container.querySelectorAll('button[title]'))
      .map((button) => button.getAttribute('title'));

    expect(pillTitles).toContain('Conversation');
    expect(pillTitles).toContain('Automation insight');
    expect(pillTitles).not.toContain('Manual-origin automation');
    expect(pillTitles).not.toContain('Meeting analysis');
    expect(pillTitles).not.toContain('Use-case discovery');
    expect(pillTitles).not.toContain('Automation');

    mounted.unmount();
  });
});
