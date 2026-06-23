import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from '@core/store';
import { setStoreFactory, type StoreFactoryOptions } from '@core/storeFactory';
import type { TranscriptSavedEvent, TranscriptSourceSystem } from '@shared/types/transcript';

vi.mock('@main/services/meetingCacheStore', () => ({
  getCachedMeetings: () => null,
  onMeetingCacheUpdated: () => () => {},
}));

import {
  clearMeetingHistory,
  getAllMeetingEntries,
  initializeMeetingHistoryStore,
  shutdownMeetingHistoryStore,
} from '@main/services/meetingHistoryStore';
import { emitTranscriptSaved } from '@main/services/meetingBot/transcriptEventBus';

const FIXED_START = '2026-05-19T10:00:00.000Z';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createMemoryStore<T extends Record<string, unknown>>(
  options: StoreFactoryOptions<T>,
): KeyValueStore<T> {
  const defaults = clone((options.defaults ?? {}) as T);
  let state = clone(defaults);

  const get = ((key: string, defaultValue?: unknown) => {
    if (key in state) {
      return state[key as keyof T];
    }
    return defaultValue;
  }) as KeyValueStore<T>['get'];

  const set = ((keyOrValues: unknown, maybeValue?: unknown) => {
    if (typeof keyOrValues === 'string') {
      state = { ...state, [keyOrValues]: maybeValue as T[keyof T] };
      return;
    }

    state = { ...state, ...(keyOrValues as Partial<T>) };
  }) as KeyValueStore<T>['set'];

  const store: KeyValueStore<T> = {
    get,
    set,
    has(key) {
      return key in state;
    },
    delete(key) {
      const next = { ...state };
      delete next[key as keyof T];
      state = next;
    },
    clear() {
      state = clone(defaults);
    },
    get store() {
      return state;
    },
    set store(nextStore: T) {
      state = nextStore;
    },
    path: '/tmp/meeting-history-store.test.json',
  };

  return store;
}

function emitEvent(sourceSystem: TranscriptSourceSystem): void {
  const event: TranscriptSavedEvent = {
    sourceSystem,
    sourceUid: `uid-${sourceSystem}`,
    filePath: `/tmp/${sourceSystem}.md`,
    meetingTitle: `Meeting (${sourceSystem})`,
    startTime: FIXED_START,
    participants: ['User'],
    duration: 1200,
    alreadyExists: false,
    timestamp: Date.now(),
  };
  emitTranscriptSaved(event);
}

describe('saveMeetingSource source mapping contract', () => {
  beforeEach(() => {
    setStoreFactory(<T extends Record<string, unknown>>(options: StoreFactoryOptions<T>) =>
      createMemoryStore(options),
    );
    initializeMeetingHistoryStore();
    clearMeetingHistory();
  });

  afterEach(() => {
    shutdownMeetingHistoryStore();
    clearMeetingHistory();
    vi.clearAllMocks();
  });

  it('(l) maps each TranscriptSourceSystem to the expected TranscriptSource label', () => {
    const scenarios: Array<{
      sourceSystem: TranscriptSourceSystem;
      expectedTranscriptSource:
        | 'recall'
        | 'local'
        | 'fireflies'
        | 'fathom'
        | 'plaud'
        | 'limitless'
        | 'manual';
    }> = [
      { sourceSystem: 'recall', expectedTranscriptSource: 'recall' },
      { sourceSystem: 'desktop_sdk', expectedTranscriptSource: 'local' },
      { sourceSystem: 'fireflies', expectedTranscriptSource: 'fireflies' },
      { sourceSystem: 'fathom', expectedTranscriptSource: 'fathom' },
      { sourceSystem: 'plaud', expectedTranscriptSource: 'plaud' },
      { sourceSystem: 'limitless', expectedTranscriptSource: 'limitless' },
      { sourceSystem: 'quick_capture', expectedTranscriptSource: 'local' },
      { sourceSystem: 'mobile-recording', expectedTranscriptSource: 'manual' },
    ];

    for (const scenario of scenarios) {
      clearMeetingHistory();
      emitEvent(scenario.sourceSystem);

      const entries = getAllMeetingEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].transcriptSource, scenario.sourceSystem).toBe(
        scenario.expectedTranscriptSource,
      );
    }
  });
});
