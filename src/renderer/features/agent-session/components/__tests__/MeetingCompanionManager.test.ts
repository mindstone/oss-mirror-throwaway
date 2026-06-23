// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingStatus } from '@renderer/hooks/useMeetingStatus';
import type { AgentSessionSummary } from '@shared/types';
import { COMPANION_REUSE_WINDOW_MS } from '../resolveReusableCompanion';

const mocks = vi.hoisted(() => {
  const addOrUpdateHistorySession = vi.fn();
  const buildRuntimeFromSnapshot = vi.fn(() => ({ runtime: true }));
  const createId = vi.fn(() => 'generated-session-id');
  return {
    meetingStatus: { state: 'no_meetings' } as MeetingStatus,
    sessionStoreState: {
      sessionSummaries: [] as AgentSessionSummary[],
      addOrUpdateHistorySession,
    },
    addOrUpdateHistorySession,
    buildRuntimeFromSnapshot,
    createId,
  };
});

 
vi.mock('@renderer/hooks/useMeetingStatus', () => ({
  useMeetingStatus: () => mocks.meetingStatus,
}));

 
vi.mock('../../store', () => ({
  getSessionStoreState: () => mocks.sessionStoreState,
  buildRuntimeFromSnapshot: mocks.buildRuntimeFromSnapshot,
}));

 
vi.mock('@shared/utils/id', () => ({
  createId: () => mocks.createId(),
}));

import { MeetingCompanionManager, getMeetingKey } from '../MeetingCompanionManager';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_778_503_600_000;
const BASE_MEETING_URL = 'https://us02web.zoom.us/j/85014715189?pwd=abc';
const BASE_MEETING_KEY = getMeetingKey(BASE_MEETING_URL);

type MountedManager = {
  updateMeetingStatus: (status: MeetingStatus) => Promise<void>;
  getCompanionMap: () => Record<string, string>;
  showToast: ReturnType<typeof vi.fn>;
  handleUserMessage: ReturnType<typeof vi.fn>;
  unmount: () => void;
};

function makeSummary(
  overrides: Partial<AgentSessionSummary> & Pick<AgentSessionSummary, 'id'>,
): AgentSessionSummary {
  return {
    id: overrides.id,
    title: overrides.title ?? null,
    createdAt: overrides.createdAt ?? NOW - 60_000,
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    resolvedAt: overrides.resolvedAt ?? null,
    doneAt: overrides.doneAt ?? null,
    starredAt: overrides.starredAt ?? null,
    deletedAt: overrides.deletedAt ?? null,
    origin: overrides.origin ?? 'manual',
    isCorrupted: overrides.isCorrupted ?? false,
    preview: overrides.preview ?? '',
    messageCount: overrides.messageCount ?? 0,
    hasDraft: overrides.hasDraft ?? false,
    draftPreview: overrides.draftPreview ?? null,
    draftUpdatedAt: overrides.draftUpdatedAt ?? null,
    usage: overrides.usage ?? {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
    },
    activeTurnId: overrides.activeTurnId ?? null,
    isBusy: overrides.isBusy ?? false,
    lastError: overrides.lastError ?? null,
    meetingCompanion: overrides.meetingCompanion,
  };
}

function makeRecordingStatus({
  meetingUrl = BASE_MEETING_URL,
  title = 'Meeting',
  botId = 'bot-1',
  startTime = '2026-05-11T12:00:00.000Z',
}: {
  meetingUrl?: string;
  title?: string;
  botId?: string;
  startTime?: string;
} = {}): MeetingStatus {
  return {
    state: 'recording',
    botId,
    meeting: {
      id: 'meeting-1',
      title,
      startTime,
      meetingUrl,
    },
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountManager({
  initialMeetingStatus = { state: 'no_meetings' } as MeetingStatus,
  sessionSummaries = [],
}: {
  initialMeetingStatus?: MeetingStatus;
  sessionSummaries?: AgentSessionSummary[];
} = {}): Promise<MountedManager> {
  mocks.meetingStatus = initialMeetingStatus;
  mocks.sessionStoreState.sessionSummaries = sessionSummaries;

  let companionMap: Record<string, string> = {};
  const setCompanionSessionByMeetingUrl: React.Dispatch<React.SetStateAction<Record<string, string>>> = (updater) => {
    companionMap = typeof updater === 'function' ? updater(companionMap) : updater;
  };

  const showToast = vi.fn();
  const navigateToConversation = vi.fn(async () => true);
  const handleUserMessage = vi.fn(async () => undefined);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const render = () => {
    act(() => {
      root.render(React.createElement(MeetingCompanionManager, {
        companionSessionByMeetingUrl: companionMap,
        setCompanionSessionByMeetingUrl,
        navigateToConversation,
        showToast,
        handleUserMessageRef: {
          current: handleUserMessage,
        },
      }));
    });
  };

  render();
  await flushEffects();

  return {
    updateMeetingStatus: async (status: MeetingStatus) => {
      mocks.meetingStatus = status;
      render();
      await flushEffects();
    },
    getCompanionMap: () => companionMap,
    showToast,
    handleUserMessage,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('getMeetingKey', () => {
  it('normalizes Zoom URLs with different subdomains to the same key', () => {
    const full = 'https://us02web.zoom.us/j/85854749726?pwd=BAaPQ7jsv5WU9VLWaw0W1OOiBWBNxQ.1&jst=2';
    const short = 'https://zoom.us/j/85854749726/';
    expect(getMeetingKey(full)).toBe('zoom:85854749726');
    expect(getMeetingKey(short)).toBe('zoom:85854749726');
    expect(getMeetingKey(full)).toBe(getMeetingKey(short));
  });

  it('normalizes Zoom URLs with /s/ path', () => {
    expect(getMeetingKey('https://zoom.us/s/98765432100')).toBe('zoom:98765432100');
  });

  it('normalizes Google Meet URLs with query params', () => {
    const bare = 'https://meet.google.com/abc-defg-hij';
    const withAuth = 'https://meet.google.com/abc-defg-hij?authuser=0';
    expect(getMeetingKey(bare)).toBe('meet:abc-defg-hij');
    expect(getMeetingKey(withAuth)).toBe('meet:abc-defg-hij');
    expect(getMeetingKey(bare)).toBe(getMeetingKey(withAuth));
  });

  it('normalizes Teams URLs', () => {
    const url = 'https://teams.live.com/meet/abc123';
    expect(getMeetingKey(url)).toBe('teams:live:abc123');
  });

  it('falls back to raw URL for unknown platforms', () => {
    const url = 'https://custom-meet.example.com/room/42';
    expect(getMeetingKey(url)).toBe('other:https://custom-meet.example.com/room/42');
  });

  it('falls back to raw URL for malformed input', () => {
    expect(getMeetingKey('not-a-url')).toBe('not-a-url');
    expect(getMeetingKey('')).toBe('');
  });

  it('deduplicates the exact URL pair from the production bug', () => {
    const url1 = 'https://us02web.zoom.us/j/85854749726?pwd=BAaPQ7jsv5WU9VLWaw0W1OOiBWBNxQ.1&jst=2';
    const url2 = 'https://zoom.us/j/85854749726/';
    expect(getMeetingKey(url1)).toBe(getMeetingKey(url2));
  });
});

describe('MeetingCompanionManager companion reuse behavior', () => {
  const mountedManagers: MountedManager[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.meetingStatus = { state: 'no_meetings' };
    mocks.sessionStoreState.sessionSummaries = [];
  });

  afterEach(() => {
    for (const manager of mountedManagers) {
      manager.unmount();
    }
    mountedManagers.length = 0;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reuses existing summary when botId matches and still fires ready toast + prep prompt', async () => {
    const existing = makeSummary({
      id: 'existing-session',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        botId: 'bot-restart',
        startedAt: NOW - 120_000,
      },
    });
    const manager = await mountManager({ sessionSummaries: [existing] });
    mountedManagers.push(manager);

    await manager.updateMeetingStatus(makeRecordingStatus({ botId: 'bot-restart' }));
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(mocks.addOrUpdateHistorySession).not.toHaveBeenCalled();
    expect(manager.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Meeting companion ready' }),
    );
    expect(manager.handleUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("I'm joining a meeting"),
      'text',
      undefined,
      { targetSessionId: 'existing-session' },
    );
    expect(manager.getCompanionMap()[BASE_MEETING_KEY]).toBe('existing-session');
  });

  it('creates new companion when botId differs even if meeting key matches', async () => {
    mocks.createId.mockReturnValueOnce('new-session-id');
    const stale = makeSummary({
      id: 'stale-session',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        botId: 'bot-old',
        startedAt: NOW - 120_000,
      },
    });
    const manager = await mountManager({ sessionSummaries: [stale] });
    mountedManagers.push(manager);

    await manager.updateMeetingStatus(makeRecordingStatus({ botId: 'bot-new' }));
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(mocks.addOrUpdateHistorySession).toHaveBeenCalledTimes(1);
    expect(mocks.addOrUpdateHistorySession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-session-id',
        meetingCompanion: expect.objectContaining({
          meetingUrl: BASE_MEETING_URL,
          botId: 'bot-new',
          startedAt: NOW,
        }),
      }),
      true,
    );
    expect(manager.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Meeting companion ready' }),
    );
    expect(manager.handleUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("I'm joining a meeting"),
      'text',
      undefined,
      { targetSessionId: 'new-session-id' },
    );
    expect(manager.getCompanionMap()[BASE_MEETING_KEY]).toBe('new-session-id');
  });

  it('reuses legacy summary within recency window', async () => {
    const legacyRecent = makeSummary({
      id: 'legacy-recent',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        startedAt: NOW - (COMPANION_REUSE_WINDOW_MS - 1_000),
      },
    });
    const manager = await mountManager({ sessionSummaries: [legacyRecent] });
    mountedManagers.push(manager);

    await manager.updateMeetingStatus(makeRecordingStatus({ botId: 'bot-new' }));

    expect(mocks.addOrUpdateHistorySession).not.toHaveBeenCalled();
    expect(manager.getCompanionMap()[BASE_MEETING_KEY]).toBe('legacy-recent');
  });

  it('creates new companion for legacy summary outside recency window', async () => {
    mocks.createId.mockReturnValueOnce('new-from-legacy');
    const legacyOld = makeSummary({
      id: 'legacy-old',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        startedAt: NOW - (COMPANION_REUSE_WINDOW_MS + 1_000),
      },
    });
    const manager = await mountManager({ sessionSummaries: [legacyOld] });
    mountedManagers.push(manager);

    await manager.updateMeetingStatus(makeRecordingStatus({ botId: 'bot-new' }));

    expect(mocks.addOrUpdateHistorySession).toHaveBeenCalledTimes(1);
    expect(manager.getCompanionMap()[BASE_MEETING_KEY]).toBe('new-from-legacy');
  });

  it('reuses URL variants for the same active bot occurrence', async () => {
    const variantSummary = makeSummary({
      id: 'variant-session',
      meetingCompanion: {
        meetingUrl: 'https://zoom.us/j/85014715189/',
        botId: 'bot-variant',
        startedAt: NOW - 10_000,
      },
    });
    const manager = await mountManager({ sessionSummaries: [variantSummary] });
    mountedManagers.push(manager);

    await manager.updateMeetingStatus(
      makeRecordingStatus({
        meetingUrl: 'https://us02web.zoom.us/j/85014715189?pwd=abc&jst=3',
        botId: 'bot-variant',
      }),
    );

    expect(mocks.addOrUpdateHistorySession).not.toHaveBeenCalled();
    expect(manager.getCompanionMap()[BASE_MEETING_KEY]).toBe('variant-session');
  });

  it('cancels pending cleanup timer when recording restarts on same key', async () => {
    mocks.createId
      .mockReturnValueOnce('session-first')
      .mockReturnValueOnce('session-second');
    const manager = await mountManager();
    mountedManagers.push(manager);

    await manager.updateMeetingStatus(makeRecordingStatus({ botId: 'bot-first' }));
    expect(manager.getCompanionMap()[BASE_MEETING_KEY]).toBe('session-first');

    await manager.updateMeetingStatus({ state: 'done' });
    await manager.updateMeetingStatus(makeRecordingStatus({ botId: 'bot-second' }));

    expect(mocks.addOrUpdateHistorySession).toHaveBeenCalledTimes(2);
    expect(manager.getCompanionMap()[BASE_MEETING_KEY]).toBe('session-second');

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(manager.getCompanionMap()[BASE_MEETING_KEY]).toBe('session-second');
  });
});
