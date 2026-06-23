// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { CachedMeeting } from '@shared/ipc/channels/calendar';
import type { UseMeetingCacheResult } from '../../../usecases/hooks/useMeetingCache';
import type { UseHomepageInboxResult } from '../useHomepageInboxItems';

vi.mock('../useRecentAutomationRuns', () => ({
  useRecentAutomationRuns: () => ({
    items: [],
    isLoading: false,
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { useTodayStream } from '../useTodayStream';
import type { InboxItem } from '@shared/types';

function renderHook<T>(hookFn: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: undefined as unknown as T };

  const TestComponent = () => {
    result.current = hookFn();
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: { render: (node: React.ReactNode) => void; unmount: () => void };

  reactAct(() => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(TestComponent));
  });

  return {
    result,
    unmount: () => {
      reactAct(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

function makeMeeting(overrides: Partial<CachedMeeting> = {}): CachedMeeting {
  return {
    id: 'google:event-1',
    calendarEventId: 'event-1',
    calendarSource: 'google',
    title: 'Meeting',
    startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    participants: ['Alex', 'Taylor'],
    participantEmails: ['[Mindstone-email]', '[external-email]'],
    ...overrides,
  };
}

function makeMeetingCache(meetings: CachedMeeting[]): UseMeetingCacheResult {
  return {
    meetings,
    isLoading: false,
    isStale: false,
    syncWarnings: [],
    populatedAt: Date.now(),
    refresh: vi.fn(async () => undefined),
  };
}

function makeInboxResult(): UseHomepageInboxResult {
  return {
    items: [],
    isLoading: false,
  };
}

function makeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-1',
    title: 'Follow up',
    text: 'Please review this',
    addedAt: Date.now(),
    references: [],
    status: 'active',
    ...overrides,
  };
}

describe('useTodayStream', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('excludes meetings where the user is effectively the only attendee', () => {
    const soloMeeting = makeMeeting({
      id: 'google:solo',
      calendarEventId: 'solo',
      title: 'Focus block',
      participants: [],
      participantEmails: [],
    });
    const externalMeeting = makeMeeting({
      id: 'google:external',
      calendarEventId: 'external',
      title: 'Client review',
    });

    const { result, unmount } = renderHook(() =>
      useTodayStream({
        dismissedIds: new Set(),
        meetingCache: makeMeetingCache([soloMeeting, externalMeeting]),
        inboxResult: makeInboxResult(),
        enabled: false,
      }),
    );

    const renderedTitles = [...result.current.items, ...result.current.suggestions].map((item) => item.title);

    expect(renderedTitles).toContain('Client review');
    expect(renderedTitles).not.toContain('Focus block');
    unmount();
  });

  it('time-gates low-importance internal meetings that are too far away', () => {
    const lowValueInternalMeeting = makeMeeting({
      id: 'google:internal',
      calendarEventId: 'internal',
      title: 'Team sync',
      startTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
      participantEmails: ['[Mindstone-email]', '[Mindstone-email]'],
    });

    const { result, unmount } = renderHook(() =>
      useTodayStream({
        dismissedIds: new Set(),
        meetingCache: makeMeetingCache([lowValueInternalMeeting]),
        inboxResult: makeInboxResult(),
        enabled: false,
      }),
    );

    expect(result.current.items).toHaveLength(0);
    expect(result.current.suggestions).toHaveLength(0);
    unmount();
  });

  it('backfills from active inbox items so Today can still reach five cards', () => {
    const primaryItems = [
      makeInboxItem({ id: 'inbox-1', title: 'Action 1' }),
      makeInboxItem({ id: 'inbox-2', title: 'Action 2' }),
      makeInboxItem({ id: 'inbox-3', title: 'Action 3' }),
    ];
    const meetingActionBackfill = [
      makeInboxItem({
        id: 'inbox-4',
        title: 'Review agenda updates',
        category: 'meeting-action',
        source: { kind: 'meeting', label: 'Calendar' },
      }),
      makeInboxItem({
        id: 'inbox-5',
        title: 'Send recap note',
        category: 'meeting-action',
        source: { kind: 'meeting', label: 'Calendar' },
      }),
    ];

    const { result, unmount } = renderHook(() =>
      useTodayStream({
        dismissedIds: new Set(),
        meetingCache: makeMeetingCache([]),
        inboxResult: {
          items: [...primaryItems, ...meetingActionBackfill],
          isLoading: false,
        },
        enabled: false,
      }),
    );

    expect(result.current.items.length + result.current.suggestions.length).toBe(5);
    const renderedTitles = [...result.current.items, ...result.current.suggestions].map((item) => item.title);
    expect(renderedTitles).toContain('Action 1');
    expect(renderedTitles).toContain('Review agenda updates');
    expect(renderedTitles).toContain('Send recap note');
    unmount();
  });

  it('keeps wins and learnings out of Today even when backfilling from Actions', () => {
    const actionable = makeInboxItem({ id: 'inbox-action', title: 'Review customer renewal' });
    const coachItems = [
      makeInboxItem({ id: 'inbox-win', title: 'Win: Big renewal closed' }),
      makeInboxItem({ id: 'inbox-learning', title: 'Learning: The team needs calmer handoffs' }),
      makeInboxItem({
        id: 'inbox-source-win',
        title: 'Share ROI alpha customer-comms leverage win',
        source: {
          kind: 'automation',
          automationId: 'automation-wins-learnings-uncover',
          automationName: 'Wins & Learnings Coach',
          label: 'Exec coach scan — 2026-05-18',
        },
      }),
    ];

    const { result, unmount } = renderHook(() =>
      useTodayStream({
        dismissedIds: new Set(),
        meetingCache: makeMeetingCache([]),
        inboxResult: {
          items: [actionable, ...coachItems],
          isLoading: false,
        },
        enabled: false,
      }),
    );

    const renderedTitles = [...result.current.items, ...result.current.suggestions].map((item) => item.title);
    expect(renderedTitles).toContain('Review customer renewal');
    expect(renderedTitles).not.toContain('Win: Big renewal closed');
    expect(renderedTitles).not.toContain('Learning: The team needs calmer handoffs');
    expect(renderedTitles).not.toContain('Share ROI alpha customer-comms leverage win');
    expect(result.current.totalCount).toBe(1);
    unmount();
  });
});
