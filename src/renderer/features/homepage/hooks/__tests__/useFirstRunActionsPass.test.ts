// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { AppSettings } from '@shared/types';
import type { UseMeetingCacheResult } from '../../../usecases/hooks/useMeetingCache';
import {
  buildFirstRunMeetingCandidates,
  filterFirstRunCandidates,
  isFirstRunActionsPassStale,
  normalizeFirstRunActionTitle,
  shouldStartFirstRunActionsPass,
  useFirstRunActionsPass,
} from '../useFirstRunActionsPass';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

function makeMeetingCache(meetings: UseMeetingCacheResult['meetings']): UseMeetingCacheResult {
  return {
    meetings,
    isLoading: false,
    isStale: false,
    syncWarnings: [],
    populatedAt: Date.now(),
    refresh: vi.fn(async () => undefined),
  };
}

function makeMeeting(id: string, title: string, startOffsetMs: number, participantEmails = ['[Mindstone-email]', 'client@example.com']) {
  return {
    id,
    calendarEventId: `event-${id}`,
    calendarSource: 'google' as const,
    title,
    startTime: new Date(Date.now() + startOffsetMs).toISOString(),
    endTime: new Date(Date.now() + startOffsetMs + 30 * 60 * 1000).toISOString(),
    participants: [],
    participantEmails,
  };
}

async function flushAsyncWork(): Promise<void> {
  await reactAct(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('first-run actions pass helpers', () => {
  it('builds at most three upcoming meeting prep candidates', () => {
    const candidates = buildFirstRunMeetingCandidates(makeMeetingCache([
      makeMeeting('past', 'Already happened', -60_000),
      makeMeeting('solo', 'Focus block', 30 * 60_000, []),
      makeMeeting('one', 'Customer sync', 10 * 60_000),
      makeMeeting('two', 'Renewal review', 20 * 60_000),
      makeMeeting('three', 'Launch planning', 30 * 60_000),
      makeMeeting('four', 'Budget check', 40 * 60_000),
    ]));

    expect(candidates.map((candidate) => candidate.title)).toEqual([
      'Prep for Customer sync',
      'Prep for Renewal review',
      'Prep for Launch planning',
    ]);
  });

  it('dedupes against existing action titles without touching unrelated later actions', () => {
    const candidates = [
      { id: '1', title: 'Prep for Customer sync', text: 'Context' },
      { id: '2', title: 'Prep for Renewal review', text: 'Context' },
      { id: '3', title: 'Prep for Launch planning', text: 'Context' },
      { id: '4', title: 'Prep for Budget check', text: 'Context' },
    ];
    const existingTitles = new Set([
      normalizeFirstRunActionTitle('Prepare Customer sync'),
      normalizeFirstRunActionTitle('Follow up with Anna about contract'),
    ]);

    expect(filterFirstRunCandidates(candidates, existingTitles).map((candidate) => candidate.id)).toEqual([
      '2',
      '3',
      '4',
    ]);
    expect(existingTitles.has(normalizeFirstRunActionTitle('Follow up with Anna about contract'))).toBe(true);
  });

  it('does not automatically rerun a completed or failed pass for the same activation', () => {
    const base = {
      onboardingCompleted: true,
      onboardingFirstCompletedAt: 1,
    } as AppSettings;

    expect(shouldStartFirstRunActionsPass(base, 'onboarding:1')).toBe(true);
    expect(shouldStartFirstRunActionsPass({
      ...base,
      firstRunActionsPass: { status: 'pending', activationId: 'onboarding:1' },
    }, 'onboarding:1')).toBe(true);
    expect(shouldStartFirstRunActionsPass({
      ...base,
      firstRunActionsPass: { status: 'failed', activationId: 'onboarding:1' },
    }, 'onboarding:1')).toBe(false);
    expect(shouldStartFirstRunActionsPass({
      ...base,
      firstRunActionsPass: { status: 'completed', activationId: 'onboarding:1' },
    }, 'onboarding:1')).toBe(false);
    expect(shouldStartFirstRunActionsPass({
      ...base,
      firstRunActionsPass: { status: 'completed', activationId: 'onboarding:old' },
    }, 'onboarding:1')).toBe(true);
  });

  it('identifies stale running passes so Home does not check forever after a reload', () => {
    const now = 1_000_000;

    expect(isFirstRunActionsPassStale({
      status: 'running',
      activationId: 'onboarding:1',
      startedAt: now - 46 * 1000,
    }, now)).toBe(true);
    expect(isFirstRunActionsPassStale({
      status: 'running',
      activationId: 'onboarding:1',
      startedAt: now - 10 * 1000,
    }, now)).toBe(false);
    expect(isFirstRunActionsPassStale({
      status: 'pending',
      activationId: 'onboarding:1',
      startedAt: now - 46 * 1000,
    }, now)).toBe(false);
    expect(isFirstRunActionsPassStale({
      status: 'failed',
      activationId: 'onboarding:1',
      startedAt: now - 46 * 1000,
    }, now)).toBe(false);
  });

  it('settles connected-tool first-run passes when Home data loads empty', async () => {
    let settingsState = {
      onboardingCompleted: true,
      onboardingFirstCompletedAt: 1,
    } as AppSettings;
    const saveSettingsWith = vi.fn(async (updater?: (draft: AppSettings) => AppSettings) => {
      if (updater) {
        settingsState = updater(settingsState);
      }
    });

    function Harness({ settings }: { settings: AppSettings }) {
      useFirstRunActionsPass({
        settings,
        saveSettingsWith,
        enabled: true,
        connectedConnectorCount: 2,
        meetingCache: makeMeetingCache([]),
        inboxResult: {
          items: [],
          isLoading: false,
        },
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    reactAct(() => {
      root.render(React.createElement(Harness, { settings: settingsState }));
    });
    await flushAsyncWork();

    expect(saveSettingsWith).toHaveBeenCalledTimes(2);
    expect(settingsState.firstRunActionsPass).toMatchObject({
      status: 'completed',
      activationId: 'onboarding:1',
      itemsCreated: 0,
      createdItemIds: [],
      sourceResults: [
        { source: 'connectors', status: 'checked' },
        { source: 'calendar', status: 'checked', itemsCreated: 0 },
        { source: 'inbox', status: 'checked' },
      ],
    });

    root.unmount();
    document.body.innerHTML = '';
  });

  it('rechecks an empty zero-connector pass once connectors are added', async () => {
    let settingsState = {
      onboardingCompleted: true,
      onboardingFirstCompletedAt: 1,
      firstRunActionsPass: {
        status: 'completed',
        activationId: 'onboarding:1',
        itemsCreated: 0,
        completedAt: Date.now(),
        sourceResults: [
          { source: 'connectors', status: 'not_available' },
          { source: 'calendar', status: 'not_available' },
          { source: 'inbox', status: 'checked' },
        ],
      },
    } as AppSettings;
    const saveSettingsWith = vi.fn(async (updater?: (draft: AppSettings) => AppSettings) => {
      if (updater) {
        settingsState = updater(settingsState);
      }
    });

    function Harness({ settings }: { settings: AppSettings }) {
      useFirstRunActionsPass({
        settings,
        saveSettingsWith,
        enabled: true,
        connectedConnectorCount: 2,
        meetingCache: makeMeetingCache([]),
        inboxResult: {
          items: [],
          isLoading: false,
        },
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    reactAct(() => {
      root.render(React.createElement(Harness, { settings: settingsState }));
    });
    await flushAsyncWork();

    expect(saveSettingsWith).toHaveBeenCalledTimes(2);
    expect(settingsState.firstRunActionsPass).toMatchObject({
      status: 'completed',
      activationId: 'onboarding:1',
      itemsCreated: 0,
      createdItemIds: [],
      sourceResults: [
        { source: 'connectors', status: 'checked' },
        { source: 'calendar', status: 'checked', itemsCreated: 0 },
        { source: 'inbox', status: 'checked' },
      ],
    });

    root.unmount();
    document.body.innerHTML = '';
  });

  it('creates first-run action items from loaded upcoming meetings', async () => {
    let settingsState = {
      onboardingCompleted: true,
      onboardingFirstCompletedAt: 1,
    } as AppSettings;
    const saveSettingsWith = vi.fn(async (updater?: (draft: AppSettings) => AppSettings) => {
      if (updater) {
        settingsState = updater(settingsState);
      }
    });
    const addedItems: Array<{ id: string; title: string; text?: string }> = [];
    const add = vi.fn(async (item: { id: string; title: string; text?: string }) => {
      addedItems.push(item);
      return {
        version: 1,
        items: addedItems.map((added) => ({
          id: added.id,
          title: added.title,
          text: added.text ?? added.title,
          references: [],
          addedAt: Date.now(),
        })),
        history: [],
      };
    });
    Object.defineProperty(window, 'inboxApi', {
      configurable: true,
      value: { add },
    });

    function Harness({ settings }: { settings: AppSettings }) {
      useFirstRunActionsPass({
        settings,
        saveSettingsWith,
        enabled: true,
        connectedConnectorCount: 1,
        meetingCache: makeMeetingCache([
          makeMeeting('one', 'Customer sync', 10 * 60_000),
          makeMeeting('two', 'Renewal review', 20 * 60_000),
        ]),
        inboxResult: {
          items: [],
          isLoading: false,
        },
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    reactAct(() => {
      root.render(React.createElement(Harness, { settings: settingsState }));
    });
    await flushAsyncWork();

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: 'Prep for Customer sync',
      category: 'follow-up',
      tags: ['first-run'],
      important: true,
      urgent: false,
    }));
    expect(settingsState.firstRunActionsPass).toMatchObject({
      status: 'completed',
      activationId: 'onboarding:1',
      itemsCreated: 2,
      createdItemIds: addedItems.map((item) => item.id),
      sourceResults: [
        { source: 'connectors', status: 'checked' },
        { source: 'calendar', status: 'checked', itemsCreated: 2 },
        { source: 'inbox', status: 'checked' },
      ],
    });

    root.unmount();
    document.body.innerHTML = '';
  });

  it('dedupes first-run meeting actions against existing inbox titles', async () => {
    let settingsState = {
      onboardingCompleted: true,
      onboardingFirstCompletedAt: 1,
    } as AppSettings;
    const saveSettingsWith = vi.fn(async (updater?: (draft: AppSettings) => AppSettings) => {
      if (updater) {
        settingsState = updater(settingsState);
      }
    });
    const addedItems: Array<{ id: string; title: string; text?: string }> = [];
    const add = vi.fn(async (item: { id: string; title: string; text?: string }) => {
      addedItems.push(item);
      return {
        version: 1,
        items: addedItems.map((added) => ({
          id: added.id,
          title: added.title,
          text: added.text ?? added.title,
          references: [],
          addedAt: Date.now(),
        })),
        history: [],
      };
    });
    Object.defineProperty(window, 'inboxApi', {
      configurable: true,
      value: { add },
    });

    function Harness({ settings }: { settings: AppSettings }) {
      useFirstRunActionsPass({
        settings,
        saveSettingsWith,
        enabled: true,
        connectedConnectorCount: 1,
        meetingCache: makeMeetingCache([
          makeMeeting('one', 'Customer sync', 10 * 60_000),
          makeMeeting('two', 'Renewal review', 20 * 60_000),
        ]),
        inboxResult: {
          items: [{
            id: 'existing',
            title: 'Prepare Customer sync',
            text: 'Existing action',
            references: [],
            addedAt: Date.now(),
          }],
          isLoading: false,
        },
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    reactAct(() => {
      root.render(React.createElement(Harness, { settings: settingsState }));
    });
    await flushAsyncWork();

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Prep for Renewal review',
    }));
    expect(settingsState.firstRunActionsPass).toMatchObject({
      status: 'completed',
      itemsCreated: 1,
      createdItemIds: addedItems.map((item) => item.id),
    });

    root.unmount();
    document.body.innerHTML = '';
  });

  it('progresses a pending pass once Home data becomes available', async () => {
    let settingsState = {
      onboardingCompleted: true,
      onboardingFirstCompletedAt: 1,
      firstRunActionsPass: {
        status: 'pending',
        activationId: 'onboarding:1',
        startedAt: Date.now() - 60 * 1000,
        itemsCreated: 0,
        createdItemIds: [],
      },
    } as unknown as AppSettings;
    const saveSettingsWith = vi.fn(async (updater?: (draft: AppSettings) => AppSettings) => {
      if (updater) {
        settingsState = updater(settingsState);
      }
    });
    const addedItems: Array<{ id: string; title: string; text?: string }> = [];
    const add = vi.fn(async (item: { id: string; title: string; text?: string }) => {
      addedItems.push(item);
      return {
        version: 1,
        items: addedItems.map((added) => ({
          id: added.id,
          title: added.title,
          text: added.text ?? added.title,
          references: [],
          addedAt: Date.now(),
        })),
        history: [],
      };
    });
    Object.defineProperty(window, 'inboxApi', {
      configurable: true,
      value: { add },
    });

    function Harness({ settings }: { settings: AppSettings }) {
      useFirstRunActionsPass({
        settings,
        saveSettingsWith,
        enabled: true,
        connectedConnectorCount: 1,
        meetingCache: makeMeetingCache([
          makeMeeting('one', 'Customer sync', 10 * 60_000),
        ]),
        inboxResult: {
          items: [],
          isLoading: false,
        },
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    reactAct(() => {
      root.render(React.createElement(Harness, { settings: settingsState }));
    });
    await flushAsyncWork();

    expect(add).toHaveBeenCalledTimes(1);
    expect(settingsState.firstRunActionsPass).toMatchObject({
      status: 'completed',
      activationId: 'onboarding:1',
      itemsCreated: 1,
      createdItemIds: addedItems.map((item) => item.id),
    });

    root.unmount();
    document.body.innerHTML = '';
  });

  it('persists failed state and clears in-flight when the initial running save fails', async () => {
    let settingsState = {
      onboardingCompleted: true,
      onboardingFirstCompletedAt: 1,
    } as AppSettings;
    let saveCalls = 0;
    const saveSettingsWith = vi.fn(async (updater?: (draft: AppSettings) => AppSettings) => {
      saveCalls += 1;
      if (saveCalls === 1) {
        throw new Error('settings write failed');
      }
      if (updater) {
        settingsState = updater(settingsState);
      }
    });
    const loadIndex = vi.fn(async () => ({ entries: [], history: [] }));
    const add = vi.fn();
    Object.defineProperty(window, 'inboxApi', {
      configurable: true,
      value: { loadIndex, add },
    });

    function Harness({ settings }: { settings: AppSettings }) {
      useFirstRunActionsPass({
        settings,
        saveSettingsWith,
        enabled: true,
        connectedConnectorCount: 1,
        meetingCache: makeMeetingCache([
          makeMeeting('one', 'Customer sync', 10 * 60_000),
        ]),
        inboxResult: {
          items: [],
          isLoading: false,
        },
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    reactAct(() => {
      root.render(React.createElement(Harness, { settings: settingsState }));
    });
    await flushAsyncWork();

    expect(saveSettingsWith).toHaveBeenCalledTimes(2);
    expect(settingsState.firstRunActionsPass).toMatchObject({
      status: 'failed',
      activationId: 'onboarding:1',
      itemsCreated: 0,
      error: 'settings write failed',
    });
    expect(loadIndex).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();

    root.unmount();
    document.body.innerHTML = '';
  });
});
