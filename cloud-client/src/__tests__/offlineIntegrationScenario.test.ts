import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS_BEFORE_PERMANENT, MAX_BACKOFF_MS } from '../offlineQueue/OfflineQueue';
import { QueueFullError } from '../offlineQueue/errors';
import { _resetOfflineQueueStore, initOfflineQueueStore, useOfflineQueueStore } from '../offlineQueue/offlineQueueStore';
import type { QueueStatusInputs } from '../offlineQueue/useQueueStatus';
import { useQueueStatus } from '../offlineQueue/useQueueStatus';
import type {
  QueueConsumer,
  QueueConsumerResult,
  QueueItem,
  QueueStorageAdapter,
  QueueTransitionEvent,
} from '../offlineQueue/types';

class InMemoryStorage implements QueueStorageAdapter {
  items: QueueItem[] = [];
  payloads: Map<string, string> = new Map();
  jsonPayloads: Map<string, unknown> = new Map();

  async saveSnapshot(items: QueueItem[]): Promise<void> {
    this.items = JSON.parse(JSON.stringify(items));
  }

  async loadSnapshot(): Promise<QueueItem[]> {
    return JSON.parse(JSON.stringify(this.items));
  }

  async savePayloadFromUri(id: string, _sourceUri: string, ext: string): Promise<string> {
    const persistedUri = `persisted://${id}.${ext}`;
    this.payloads.set(id, persistedUri);
    return persistedUri;
  }

  async getPayloadUri(id: string): Promise<string | null> {
    return this.payloads.get(id) ?? null;
  }

  async deletePayload(id: string): Promise<void> {
    this.payloads.delete(id);
  }

  async listPayloadIds(): Promise<string[]> {
    return Array.from(new Set([...this.payloads.keys(), ...this.jsonPayloads.keys()]));
  }

  async saveJsonPayload(id: string, payload: unknown): Promise<void> {
    this.jsonPayloads.set(id, JSON.parse(JSON.stringify(payload)));
  }

  async loadJsonPayload<T = unknown>(id: string): Promise<T | null> {
    const value = this.jsonPayloads.get(id);
    return value === undefined ? null : JSON.parse(JSON.stringify(value)) as T;
  }

  async deleteJsonPayload(id: string): Promise<void> {
    this.jsonPayloads.delete(id);
  }
}

const OFFLINE_INPUTS: QueueStatusInputs = {
  isOnline: false,
  isInternetReachable: false,
  wsReconnecting: false,
};

const ONLINE_INPUTS: QueueStatusInputs = {
  isOnline: true,
  isInternetReachable: true,
  wsReconnecting: false,
};

describe('Offline queue integration scenario', () => {
  beforeEach(() => {
    _resetOfflineQueueStore();
  });

  afterEach(() => {
    _resetOfflineQueueStore();
    vi.restoreAllMocks();
  });

  it('handles offline → online → disrupted → auth-expired → resumed lifecycle deterministically', async () => {
    const cloudUrl = 'https://cloud.example.com';
    const storage = new InMemoryStorage();
    const transitions: QueueTransitionEvent[] = [];

    let now = 1_762_400_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    let currentConsumerBehavior: (
      item: QueueItem<Record<string, unknown>>,
    ) => Promise<QueueConsumerResult> = async () => ({ success: true });

    const consumer = vi.fn<QueueConsumer>().mockImplementation(async (item) => {
      return currentConsumerBehavior(item as QueueItem<Record<string, unknown>>);
    });

    const store = initOfflineQueueStore(storage, consumer, {
      onTransition: (event) => transitions.push(event),
    });
    await store.getState().init();
    store.getState().bindAuthIdentity(cloudUrl);

    const { result, rerender } = renderHook(
      ({ inputs }: { inputs: QueueStatusInputs }) => useQueueStatus(inputs),
      { initialProps: { inputs: OFFLINE_INPUTS } },
    );

    const textOne = await store.getState().enqueueOrThrow('text-message', null, null, { label: 'text-1' });
    const textTwo = await store.getState().enqueueOrThrow('text-message', null, null, { label: 'text-2' });
    const textWithAttachments = await store.getState().enqueueWithJsonPayloadOrThrow(
      'text-with-attachments',
      { prompt: 'with files', attachments: [{ mimeType: 'image/png', data: 'base64' }] },
      { label: 'text-attachments' },
    );
    const voice = await store.getState().enqueueOrThrow('voice-transcription', 'file:///tmp/voice.m4a', 'm4a', { label: 'voice-1' });
    const meetingChunk = await store.getState().enqueueOrThrow('meeting-chunk', 'file:///tmp/chunk-1.m4a', 'm4a', { label: 'meeting-1' });

    expect(useOfflineQueueStore.getState().items).toHaveLength(5);
    await waitFor(() => {
      expect(result.current.state).toBe('offline-queued');
      expect(result.current.totalPending).toBe(5);
      expect(result.current.totalFailed).toBe(0);
    });

    const fillerIds: string[] = [];
    for (let i = useOfflineQueueStore.getState().items.length; i < 200; i += 1) {
      const filler = await store.getState().enqueueOrThrow('text-message', null, null, { label: `filler-${i}` });
      fillerIds.push(filler.id);
    }

    await expect(
      store.getState().enqueueOrThrow('text-message', null, null, { label: 'overflow-item' }),
    ).rejects.toBeInstanceOf(QueueFullError);
    expect(useOfflineQueueStore.getState().queueFullAt).toBe(now);

    for (const id of fillerIds) {
      await store.getState().removeItem(id);
    }
    expect(useOfflineQueueStore.getState().items).toHaveLength(5);

    let resolveVoiceDuringDrain: ((result: QueueConsumerResult) => void) | undefined;
    const voiceInFlightResult = new Promise<QueueConsumerResult>((resolve) => {
      resolveVoiceDuringDrain = resolve;
    });

    currentConsumerBehavior = async (item) => {
      const label = item.metadata.label;
      if (label === 'voice-1') {
        return voiceInFlightResult;
      }
      if (label === 'meeting-1') {
        return { success: false, error: 'defer meeting chunk', errorCategory: 'defer' };
      }
      return { success: true };
    };

    rerender({ inputs: ONLINE_INPUTS });
    const firstDrainPromise = store.getState().drain(true);

    await waitFor(() => {
      const sawVoiceConsumerCall = consumer.mock.calls.some(([item]) => {
        return (item as QueueItem<Record<string, unknown>>).id === voice.id;
      });
      expect(sawVoiceConsumerCall).toBe(true);
    });

    rerender({ inputs: OFFLINE_INPUTS });
    if (typeof resolveVoiceDuringDrain !== 'function') {
      throw new Error('Expected voice queue consumer to be waiting during drain');
    }
    resolveVoiceDuringDrain({ success: false, error: 'network offline', errorCategory: 'network' });
    await firstDrainPromise;

    const itemsAfterFirstDrain = useOfflineQueueStore.getState().items;
    expect(itemsAfterFirstDrain).toHaveLength(2);
    expect(itemsAfterFirstDrain.find((item) => item.id === textOne.id)).toBeUndefined();
    expect(itemsAfterFirstDrain.find((item) => item.id === textTwo.id)).toBeUndefined();
    expect(itemsAfterFirstDrain.find((item) => item.id === textWithAttachments.id)).toBeUndefined();

    const voiceAfterFirstDrain = itemsAfterFirstDrain.find((item) => item.id === voice.id);
    const meetingAfterFirstDrain = itemsAfterFirstDrain.find((item) => item.id === meetingChunk.id);
    expect(voiceAfterFirstDrain?.attempts).toBe(1);
    expect(voiceAfterFirstDrain?.errorCategory).toBe('network');
    expect(meetingAfterFirstDrain?.attempts).toBe(0);
    expect(meetingAfterFirstDrain?.errorCategory).toBe('defer');

    expect(useOfflineQueueStore.getState().items).toHaveLength(2);
    await waitFor(() => {
      expect(result.current.state).toBe('offline-queued');
    });

    const voiceForClockJump = useOfflineQueueStore.getState().items.find((item) => item.id === voice.id);
    expect(voiceForClockJump).toBeDefined();
    const oldNextRetryAt = now + 30 * 60_000;
    voiceForClockJump!.nextRetryAt = oldNextRetryAt;
    now += 10 * 60_000;

    currentConsumerBehavior = async () => ({ success: false, error: 'still waiting', errorCategory: 'defer' });
    rerender({ inputs: ONLINE_INPUTS });
    await store.getState().drain(true);

    const voiceAfterClockGuard = useOfflineQueueStore.getState().items.find((item) => item.id === voice.id);
    expect(voiceAfterClockGuard).toBeDefined();
    expect(voiceAfterClockGuard!.nextRetryAt - now).toBeLessThanOrEqual(MAX_BACKOFF_MS);

    const clockJumpEvent = transitions.find((event) => {
      return event.message === 'clock-jump-guard' &&
        (event.data as Record<string, unknown> | undefined)?.itemId === voice.id;
    });
    expect(clockJumpEvent).toBeDefined();
    expect((clockJumpEvent?.data as Record<string, unknown>).oldNextRetryAt).toBe(oldNextRetryAt);

    await store.getState().retryItem(voice.id);
    await store.getState().retryItem(meetingChunk.id);

    currentConsumerBehavior = async () => ({
      success: false,
      error: 'token expired',
      errorCategory: 'auth',
    });
    await store.getState().drain(true);

    expect(useOfflineQueueStore.getState().authExpiredAt).not.toBeNull();
    expect(useOfflineQueueStore.getState().items).toHaveLength(2);
    await waitFor(() => {
      expect(result.current.state).toBe('auth-expired');
    });

    await store.getState().retryItem(voice.id);
    await store.getState().retryItem(meetingChunk.id);
    store.getState().bindAuthIdentity(null);
    consumer.mockClear();
    await store.getState().drain(true);
    expect(consumer).not.toHaveBeenCalled();

    store.getState().bindAuthIdentity(cloudUrl);
    const voiceForPermanentFailure = useOfflineQueueStore.getState().items.find((item) => item.id === voice.id);
    expect(voiceForPermanentFailure).toBeDefined();
    voiceForPermanentFailure!.attempts = MAX_ATTEMPTS_BEFORE_PERMANENT - 1;
    voiceForPermanentFailure!.nextRetryAt = 0;
    await store.getState().retryItem(meetingChunk.id);

    currentConsumerBehavior = async (item) => {
      if (item.id === voice.id) {
        return { success: false, error: 'still failing', errorCategory: 'network' };
      }
      return { success: true };
    };

    consumer.mockClear();
    await store.getState().drain(true);
    expect(consumer).toHaveBeenCalled();

    const permanentFailure = useOfflineQueueStore.getState().items.find((item) => item.id === voice.id);
    expect(permanentFailure).toBeDefined();
    expect(permanentFailure!.isPermanentFailure).toBe(true);
    expect(useOfflineQueueStore.getState().items.find((item) => item.id === meetingChunk.id)).toBeUndefined();

    await waitFor(() => {
      expect(result.current.state).toBe('has-failures');
    });

    await store.getState().retryItem(voice.id);
    currentConsumerBehavior = async () => ({ success: true });
    await store.getState().drain(true);

    expect(useOfflineQueueStore.getState().items).toHaveLength(0);
    await waitFor(() => {
      expect(result.current.state).toBe('online-live');
    });

    const emittedTransitionMessages = new Set(transitions.map((event) => event.message));
    expect(emittedTransitionMessages.has('enqueue')).toBe(true);
    expect(emittedTransitionMessages.has('queue-full')).toBe(true);
    expect(emittedTransitionMessages.has('drain-start')).toBe(true);
    expect(emittedTransitionMessages.has('drain-complete')).toBe(true);
    expect(emittedTransitionMessages.has('clock-jump-guard')).toBe(true);
    expect(emittedTransitionMessages.has('auth-expired')).toBe(true);
    expect(emittedTransitionMessages.has('identity-mismatch')).toBe(true);
    expect(emittedTransitionMessages.has('item-permanent-failure')).toBe(true);
  });
});
