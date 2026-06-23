import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OfflineQueue,
  computeBackoff,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_ATTEMPTS_BEFORE_PERMANENT,
  DEFER_DELAY_MS,
  MEETING_CHUNK_DRAIN_BUDGET,
  QUEUE_MAX_SIZE,
  DEFAULT_PROCESSING_TIMEOUT_MS,
} from '../offlineQueue/OfflineQueue';
import type { QueueItem, QueueStorageAdapter, QueueConsumer, QueueConsumerResult, QueueStateSnapshot, QueueFullRejection } from '../offlineQueue/types';

/** Type guard: narrows enqueue result to QueueItem (not a rejection). */
function assertQueueItem<M extends Record<string, unknown>>(
  result: QueueItem<M> | QueueFullRejection,
): asserts result is QueueItem<M> {
  if ('accepted' in result && result.accepted === false) {
    throw new Error(`Expected QueueItem but got QueueFullRejection: ${result.reason}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory mock storage adapter
// ---------------------------------------------------------------------------

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

  async savePayloadFromUri(id: string, sourceUri: string, ext: string): Promise<string> {
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
    // Combine media and JSON payload IDs, deduplicated
    const ids = new Set<string>([
      ...this.payloads.keys(),
      ...this.jsonPayloads.keys(),
    ]);
    return Array.from(ids);
  }

  async saveJsonPayload(id: string, payload: unknown): Promise<void> {
    this.jsonPayloads.set(id, JSON.parse(JSON.stringify(payload)));
  }

  async loadJsonPayload<T = unknown>(id: string): Promise<T | null> {
    const data = this.jsonPayloads.get(id);
    return data !== undefined ? (JSON.parse(JSON.stringify(data)) as T) : null;
  }

  async deleteJsonPayload(id: string): Promise<void> {
    this.jsonPayloads.delete(id);
  }
}

// ---------------------------------------------------------------------------
// computeBackoff
// ---------------------------------------------------------------------------

describe('computeBackoff', () => {
  it('returns 2s for first failure', () => {
    expect(computeBackoff(1)).toBe(2_000);
  });

  it('doubles each attempt', () => {
    expect(computeBackoff(2)).toBe(4_000);
    expect(computeBackoff(3)).toBe(8_000);
    expect(computeBackoff(4)).toBe(16_000);
    expect(computeBackoff(5)).toBe(32_000);
  });

  it('caps at 60s', () => {
    expect(computeBackoff(6)).toBe(60_000);
    expect(computeBackoff(7)).toBe(60_000);
    expect(computeBackoff(20)).toBe(60_000);
  });

  it('exports correct constants', () => {
    expect(BASE_BACKOFF_MS).toBe(2_000);
    expect(MAX_BACKOFF_MS).toBe(60_000);
    expect(MAX_ATTEMPTS_BEFORE_PERMANENT).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// OfflineQueue
// ---------------------------------------------------------------------------

describe('OfflineQueue', () => {
  let storage: InMemoryStorage;
  let consumer: ReturnType<typeof vi.fn<QueueConsumer>>;
  let queue: OfflineQueue;

  beforeEach(() => {
    storage = new InMemoryStorage();
    consumer = vi.fn<QueueConsumer>().mockResolvedValue({ success: true });
    queue = new OfflineQueue(storage, consumer);
  });

  afterEach(() => {
    queue.dispose();
  });

  // -----------------------------------------------------------------------
  // init
  // -----------------------------------------------------------------------

  describe('init', () => {
    it('loads persisted items', async () => {
      storage.items = [
        {
          id: 'a',
          type: 'voice-transcription',
          status: 'pending',
          enqueuedAt: 1000,
          attempts: 0,
          nextRetryAt: 0,
          isPermanentFailure: false,
          metadata: {},
        },
      ];

      await queue.init();
      expect(queue.getItems()).toHaveLength(1);
      expect(queue.getItems()[0].id).toBe('a');
    });

    it('recovers processing items to pending', async () => {
      storage.items = [
        {
          id: 'stale',
          type: 'voice-transcription',
          status: 'processing',
          enqueuedAt: 1000,
          attempts: 1,
          nextRetryAt: 0,
          isPermanentFailure: false,
          metadata: {},
        },
      ];

      await queue.init();
      const items = queue.getItems();
      expect(items[0].status).toBe('pending');
      // Should also persist the recovery
      expect(storage.items[0].status).toBe('pending');
    });

    it('repairs historical terminalized session-state items to retryable pending', async () => {
      const beforeInit = Date.now();
      storage.items = [
        {
          id: 'stuck-session-state',
          type: 'voice-transcription',
          status: 'pending',
          enqueuedAt: 1000,
          attempts: MAX_ATTEMPTS_BEFORE_PERMANENT,
          nextRetryAt: 0,
          lastError: 'Session is busy',
          errorCategory: 'session-state',
          isPermanentFailure: true,
          metadata: {},
        },
      ];

      await queue.init();

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(0);
      expect(items[0].lastError).toBe('Session is busy');
      expect(items[0].errorCategory).toBe('session-state');
      expect(items[0].nextRetryAt).toBeGreaterThanOrEqual(beforeInit + DEFER_DELAY_MS - 100);
      expect(items[0].isPermanentFailure).toBe(false);
      expect(storage.items[0].isPermanentFailure).toBe(false);
    });

    it('is idempotent', async () => {
      await queue.init();
      await queue.init(); // should not throw or duplicate
      expect(queue.getItems()).toHaveLength(0);
    });

    it('cleans up orphaned payload files during init', async () => {
      storage.items = [
        {
          id: 'indexed-item',
          type: 'voice-transcription',
          status: 'pending',
          enqueuedAt: 1000,
          attempts: 0,
          nextRetryAt: 0,
          isPermanentFailure: false,
          metadata: {},
        },
      ];
      storage.payloads.set('indexed-item', 'persisted://indexed-item.m4a');
      storage.payloads.set('orphan-item', 'persisted://orphan-item.m4a');

      await queue.init();

      expect(storage.payloads.has('indexed-item')).toBe(true);
      expect(storage.payloads.has('orphan-item')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // enqueue
  // -----------------------------------------------------------------------

  describe('enqueue', () => {
    it('creates a pending item with correct metadata', async () => {
      await queue.init();
      const item = await queue.enqueue('voice-transcription', 'file:///tmp/audio.m4a', 'm4a', { sessionId: 's1' });
      assertQueueItem(item);

      expect(item.type).toBe('voice-transcription');
      expect(item.status).toBe('pending');
      expect(item.attempts).toBe(0);
      expect(item.nextRetryAt).toBe(0);
      expect(item.isPermanentFailure).toBe(false);
      expect(item.payloadExt).toBe('m4a');
      expect(item.metadata).toEqual({ sessionId: 's1' });
      expect(item.payloadUri).toMatch(/^persisted:\/\//);
    });

    it('persists item to storage', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/audio.m4a', 'm4a', {});

      expect(storage.items).toHaveLength(1);
      expect(storage.payloads.size).toBe(1);
    });

    it('persists payload via savePayloadFromUri', async () => {
      await queue.init();
      const item = await queue.enqueue('voice-transcription', 'file:///tmp/audio.m4a', 'm4a', {});
      assertQueueItem(item);

      const payloadUri = await storage.getPayloadUri(item.id);
      expect(payloadUri).toBe(item.payloadUri);
    });

    it('rolls back on saveSnapshot failure — removes item from memory and deletes payload', async () => {
      await queue.init();
      const deletePayloadSpy = vi.spyOn(storage, 'deletePayload');
      vi.spyOn(storage, 'saveSnapshot').mockRejectedValueOnce(new Error('IO error'));

      await expect(
        queue.enqueue('voice-transcription', 'file:///tmp/audio.m4a', 'm4a', { sessionId: 's1' }),
      ).rejects.toThrow('IO error');

      expect(queue.getItems()).toHaveLength(0);
      expect(deletePayloadSpy).toHaveBeenCalled();
    });

    it('supports enqueue without payload for text items', async () => {
      await queue.init();
      const savePayloadSpy = vi.spyOn(storage, 'savePayloadFromUri');
      const item = await queue.enqueue('text-message', null, null, {
        sessionId: 's1',
        prompt: 'Hello from offline mode',
      });
      assertQueueItem(item);

      expect(savePayloadSpy).not.toHaveBeenCalled();
      expect(item.payloadUri).toBeUndefined();
      expect(item.payloadExt).toBeUndefined();
      expect(item.type).toBe('text-message');
    });

    it('notifies listeners', async () => {
      await queue.init();
      const listener = vi.fn();
      queue.subscribe(listener);

      await queue.enqueue('voice-transcription', 'file:///tmp/audio.m4a', 'm4a', {});
      expect(listener).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: 'voice-transcription', status: 'pending' }),
        ]),
        expect.objectContaining({ items: expect.any(Array) }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // drain
  // -----------------------------------------------------------------------

  describe('drain', () => {
    it('processes pending items through consumer', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', { sessionId: 's1' });

      await queue.drain(true);

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(consumer).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'voice-transcription', status: 'processing' }),
        expect.stringMatching(/^persisted:\/\//),
        expect.any(AbortSignal),
      );
    });

    it('removes item and payload on success', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      await queue.drain(true);

      expect(queue.getItems()).toHaveLength(0);
      expect(storage.items).toHaveLength(0);
      expect(storage.payloads.size).toBe(0);
    });

    it('skips when offline', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      await queue.drain(false);

      expect(consumer).not.toHaveBeenCalled();
      expect(queue.getItems()).toHaveLength(1);
    });

    it('skips items not yet due (nextRetryAt in future)', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      // Manually set nextRetryAt to near future (below clock-jump anomaly threshold)
      const items = queue.getItems();
      items[0].nextRetryAt = Date.now() + 30_000;
      // We need to manipulate internal state for this test.
      // Set via storage and re-init.
      storage.items = items;
      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      await queue.drain(true);

      expect(consumer).not.toHaveBeenCalled();
      expect(queue.getItems()).toHaveLength(1);
    });

    it('skips permanently failed items', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      // Mark as permanent failure via storage
      storage.items[0].isPermanentFailure = true;
      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      await queue.drain(true);

      expect(consumer).not.toHaveBeenCalled();
    });

    it('processes multiple items sequentially', async () => {
      await queue.init();
      const order: string[] = [];
      consumer.mockImplementation(async (item) => {
        order.push(item.id);
        return { success: true };
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', { n: 1 });
      await queue.enqueue('voice-transcription', 'file:///tmp/b.m4a', 'm4a', { n: 2 });
      await queue.enqueue('voice-transcription', 'file:///tmp/c.m4a', 'm4a', { n: 3 });

      await queue.drain(true);

      expect(order).toHaveLength(3);
      expect(consumer).toHaveBeenCalledTimes(3);
    });

    it('skips payload lookups and deletion for text items', async () => {
      await queue.init();
      const getPayloadUriSpy = vi.spyOn(storage, 'getPayloadUri');
      const deletePayloadSpy = vi.spyOn(storage, 'deletePayload');

      await queue.enqueue('text-message', null, null, {
        sessionId: 's1',
        prompt: 'Offline hello',
      });
      await queue.drain(true);

      expect(getPayloadUriSpy).not.toHaveBeenCalled();
      expect(deletePayloadSpy).not.toHaveBeenCalled();
      expect(consumer).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'text-message' }),
        null,
        expect.any(AbortSignal),
      );
    });

    it('limits each drain cycle to the meeting chunk budget without starving other item types', async () => {
      await queue.init();
      const processedTypes: string[] = [];

      consumer.mockImplementation(async (item) => {
        processedTypes.push(item.type);
        return { success: true };
      });

      for (let index = 0; index < MEETING_CHUNK_DRAIN_BUDGET + 2; index += 1) {
        await queue.enqueue('meeting-chunk', `file:///tmp/chunk-${index}.m4a`, 'm4a', { chunkIndex: index });
      }
      await queue.enqueue('text-message', null, null, {
        sessionId: 'session-1',
        prompt: 'Do not starve me',
      });

      await queue.drain(true);

      expect(processedTypes).toEqual([
        'meeting-chunk',
        'meeting-chunk',
        'meeting-chunk',
        'text-message',
      ]);
      expect(queue.getItems()).toHaveLength(2);
      expect(queue.getItems().every((item) => item.type === 'meeting-chunk')).toBe(true);
    });

    it('resets the meeting chunk budget on the next drain cycle', async () => {
      await queue.init();

      for (let index = 0; index < MEETING_CHUNK_DRAIN_BUDGET + 1; index += 1) {
        await queue.enqueue('meeting-chunk', `file:///tmp/budget-${index}.m4a`, 'm4a', { chunkIndex: index });
      }

      await queue.drain(true);
      expect(queue.getItems()).toHaveLength(1);

      await queue.drain(true);
      expect(queue.getItems()).toHaveLength(0);
    });

    // -------------------------------------------------------------------
    // drain options: background-drain contract
    // -------------------------------------------------------------------

    it('returns a DrainSummary with attempted/drained counts and duration', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      await queue.enqueue('voice-transcription', 'file:///tmp/b.m4a', 'm4a', {});

      const summary = await queue.drain(true);

      expect(summary.attempted).toBe(2);
      expect(summary.drained).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.skippedOffline).toBe(false);
      expect(summary.skippedAlreadyDraining).toBe(false);
      expect(summary.budgetExceeded).toBe(false);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('reports skippedOffline in the summary when offline', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      const summary = await queue.drain(false);
      expect(summary.skippedOffline).toBe(true);
      expect(summary.attempted).toBe(0);
      expect(summary.drained).toBe(0);
    });

    it('reports skippedAlreadyDraining when a drain is in flight', async () => {
      await queue.init();
      consumer.mockImplementation(async () => {
        // Long enough to keep the first drain draining
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { success: true };
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      const first = queue.drain(true);
      const second = await queue.drain(true);
      expect(second.skippedAlreadyDraining).toBe(true);
      await first;
    });

    it('restricts drain to itemTypes when provided', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      await queue.enqueue('meeting-chunk', 'file:///tmp/c.m4a', 'm4a', { sessionId: 's1' });

      const summary = await queue.drain(true, { itemTypes: ['meeting-chunk'] });

      expect(summary.attempted).toBe(1);
      expect(summary.drained).toBe(1);
      // voice-transcription item stays in the queue, untouched by this drain.
      const remaining = queue.getItems();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].type).toBe('voice-transcription');
    });

    it('honors maxDurationMs and reports budgetExceeded', async () => {
      await queue.init();
      consumer.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { success: true };
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      await queue.enqueue('voice-transcription', 'file:///tmp/b.m4a', 'm4a', {});
      await queue.enqueue('voice-transcription', 'file:///tmp/c.m4a', 'm4a', {});

      const summary = await queue.drain(true, { maxDurationMs: 50 });

      // First item processes successfully; budget exceeded before we get to
      // item 2 or 3. Exact counts depend on timing, but we should have
      // drained at least one and not all three, and the flag must be set.
      expect(summary.drained).toBeGreaterThanOrEqual(1);
      expect(summary.drained).toBeLessThan(3);
      expect(summary.budgetExceeded).toBe(true);
    });

    it('uses per-item processingTimeoutMs override', async () => {
      await queue.init();
      // Consumer sleeps 200ms; if we pass a 20ms timeout override, we should
      // get a timeout failure instead of success.
      consumer.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { success: true };
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      const summary = await queue.drain(true, { processingTimeoutMs: 20 });
      expect(summary.failed).toBe(1);
      expect(summary.drained).toBe(0);
      const items = queue.getItems();
      expect(items[0]?.errorCategory).toBe('timeout');
    });

    it('counts terminalized permanent failures in the summary', async () => {
      await queue.init();
      // Consumer returns a permanent failure — applyFailure should mark the
      // item as `isPermanentFailure=true` immediately.
      consumer.mockResolvedValue({
        success: false,
        error: 'corrupt payload',
        errorCategory: 'permanent',
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      const summary = await queue.drain(true);
      expect(summary.attempted).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.terminalized).toBe(1);
      expect(summary.drained).toBe(0);
    });

    it('counts authFailures in the summary', async () => {
      await queue.init();
      consumer.mockResolvedValue({
        success: false,
        error: 'token expired',
        errorCategory: 'auth',
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      const summary = await queue.drain(true);
      expect(summary.failed).toBe(1);
      expect(summary.authFailures).toBe(1);
      expect(summary.terminalized).toBe(0); // auth = transient, not permanent
    });

    // REBEL-6BJ / FOX-3516 regression: a `temporary` failure (e.g. a transient
    // 404 reclassified from `permanent`) must NOT be terminalized on the first
    // attempt — it should increment attempts, schedule a backoff retry, and
    // remain recoverable. `permanent` must still terminalize immediately.
    it('does NOT immediately terminalize a temporary failure (retryable with backoff)', async () => {
      await queue.init();
      consumer.mockResolvedValue({
        success: false,
        error: 'Upload failed (404)',
        errorCategory: 'temporary',
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      const before = Date.now();
      const summary = await queue.drain(true);

      expect(summary.attempted).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.terminalized).toBe(0); // temporary = transient, retryable

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].attempts).toBe(1);
      expect(items[0].isPermanentFailure).toBe(false);
      expect(items[0].errorCategory).toBe('temporary');
      expect(items[0].nextRetryAt).toBeGreaterThan(before); // scheduled for retry
    });

    it('immediately terminalizes a permanent failure on the first attempt', async () => {
      await queue.init();
      consumer.mockResolvedValue({
        success: false,
        error: 'Upload failed (400)',
        errorCategory: 'permanent',
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      const summary = await queue.drain(true);
      expect(summary.terminalized).toBe(1);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].attempts).toBe(1);
      expect(items[0].isPermanentFailure).toBe(true);
      expect(items[0].nextRetryAt).toBe(0); // no retry scheduled
    });

    it('clamps per-item timeout to remaining budget', async () => {
      await queue.init();
      // Consumer takes 100ms. If we set a 50ms budget + 500ms per-item
      // timeout, the effective per-item timeout for the first item should
      // be clamped to ~50ms and cause a timeout failure rather than
      // overshooting the OS budget.
      consumer.mockImplementation(async (_item, _payload, signal) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 100);
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          }
        });
        return { success: true };
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      const start = Date.now();
      const summary = await queue.drain(true, {
        maxDurationMs: 50,
        processingTimeoutMs: 500,
      });
      const elapsed = Date.now() - start;

      expect(summary.attempted).toBe(1);
      expect(summary.failed).toBe(1);
      // Clamp worked: we did not wait the full 500ms per-item timeout.
      expect(elapsed).toBeLessThan(250);
    });
  });

  // -----------------------------------------------------------------------
  // defer (head-of-line blocking mitigation)
  // -----------------------------------------------------------------------

  describe('defer', () => {
    it('resets item to pending with short delay on defer, does NOT increment attempts', async () => {
      await queue.init();
      consumer.mockResolvedValue({ success: false, errorCategory: 'defer' });

      await queue.enqueue('meeting-recording', 'file:///tmp/meeting.m4a', 'm4a', {});
      const beforeDrain = Date.now();
      await queue.drain(true);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(0); // NOT incremented
      expect(items[0].errorCategory).toBe('defer');
      // nextRetryAt should be ~DEFER_DELAY_MS in the future
      expect(items[0].nextRetryAt).toBeGreaterThanOrEqual(beforeDrain + DEFER_DELAY_MS - 100);
      expect(items[0].nextRetryAt).toBeLessThanOrEqual(beforeDrain + DEFER_DELAY_MS + 1000);
      expect(items[0].isPermanentFailure).toBe(false);
    });

    it('keeps session-state attempt-neutral while preserving the diagnostic category', async () => {
      await queue.init();
      consumer.mockResolvedValue({
        success: false,
        error: 'Session is busy',
        errorCategory: 'session-state',
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/voice.m4a', 'm4a', {});
      const beforeDrain = Date.now();
      const summary = await queue.drain(true);

      const items = queue.getItems();
      expect(summary.attempted).toBe(1);
      expect(summary.failed).toBe(0);
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(0);
      expect(items[0].lastError).toBe('Session is busy');
      expect(items[0].errorCategory).toBe('session-state');
      expect(items[0].nextRetryAt).toBeGreaterThanOrEqual(beforeDrain + DEFER_DELAY_MS - 100);
      expect(items[0].isPermanentFailure).toBe(false);
    });

    it('deferred items become eligible again after DEFER_DELAY_MS', async () => {
      await queue.init();

      // First drain: consumer returns defer
      let callCount = 0;
      consumer.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { success: false, errorCategory: 'defer' };
        return { success: true };
      });

      await queue.enqueue('meeting-recording', 'file:///tmp/meeting.m4a', 'm4a', {});
      await queue.drain(true);

      expect(callCount).toBe(1);
      expect(queue.getItems()).toHaveLength(1);

      // Advance time past DEFER_DELAY_MS by re-creating queue with manipulated nextRetryAt
      const items = queue.getItems();
      items[0].nextRetryAt = Date.now() - 1; // Make it due
      storage.items = items;
      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      // Second drain: item is eligible again and succeeds
      await queue.drain(true);

      expect(callCount).toBe(2);
      expect(queue.getItems()).toHaveLength(0);
    });

    it('defer does NOT count toward permanent failure (MAX_ATTEMPTS)', async () => {
      consumer.mockResolvedValue({ success: false, errorCategory: 'defer' });

      // Pre-populate with item that has many "defers" — attempts should stay at 0
      storage.items = [{
        id: 'defer-many',
        type: 'meeting-recording',
        status: 'pending',
        enqueuedAt: Date.now(),
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      }];
      storage.payloads.set('defer-many', 'persisted://defer-many.m4a');

      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      // Drain multiple times — attempts should never increment
      for (let i = 0; i < 15; i++) {
        await queue.drain(true);
        // Reset nextRetryAt to make it eligible again
        const items = queue.getItems();
        if (items.length > 0) items[0].nextRetryAt = 0;
      }

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].attempts).toBe(0);
      expect(items[0].isPermanentFailure).toBe(false);
    });

    it('escalates attempt-neutral defer backoff without incrementing attempts', async () => {
      consumer.mockResolvedValue({
        success: false,
        error: 'Session is busy',
        errorCategory: 'session-state',
      });

      storage.items = [{
        id: 'neutral-backoff',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: Date.now(),
        attempts: 0,
        nextRetryAt: 0,
        neutralDeferBackoffMs: DEFER_DELAY_MS,
        isPermanentFailure: false,
        metadata: {},
      }];
      storage.payloads.set('neutral-backoff', 'persisted://neutral-backoff.m4a');

      let now = 1_000;
      queue = new OfflineQueue(storage, consumer, {
        now: () => now,
        scheduleTimer: (() => 1 as unknown as ReturnType<typeof setTimeout>),
        clearScheduledTimer: vi.fn(),
      });
      await queue.init();

      await queue.drain(true);
      expect(queue.getItems()[0].attempts).toBe(0);
      expect(queue.getItems()[0].neutralDeferBackoffMs).toBe(30_000);
      expect(queue.getItems()[0].nextRetryAt).toBe(now + 30_000);

      storage.items = [{ ...queue.getItems()[0], nextRetryAt: 0 }];
      now += 1_000;
      queue.dispose();
      queue = new OfflineQueue(storage, consumer, {
        now: () => now,
        scheduleTimer: (() => 1 as unknown as ReturnType<typeof setTimeout>),
        clearScheduledTimer: vi.fn(),
      });
      await queue.init();

      await queue.drain(true);
      expect(queue.getItems()[0].attempts).toBe(0);
      expect(queue.getItems()[0].neutralDeferBackoffMs).toBe(60_000);
      expect(queue.getItems()[0].nextRetryAt).toBe(now + 60_000);
      expect(queue.getItems()[0].isPermanentFailure).toBe(false);
    });

    it('continues to next item in same drain cycle after defer', async () => {
      await queue.init();

      const order: string[] = [];
      consumer.mockImplementation(async (item) => {
        order.push(item.id);
        if (item.type === 'meeting-recording') {
          return { success: false, errorCategory: 'defer' };
        }
        return { success: true };
      });

      // Enqueue a meeting recording (will defer) then a voice item (will succeed)
      await queue.enqueue('meeting-recording', 'file:///tmp/meeting.m4a', 'm4a', {});
      await queue.enqueue('voice-transcription', 'file:///tmp/voice.m4a', 'm4a', {});

      await queue.drain(true);

      // Both items were processed — meeting deferred, voice succeeded
      expect(order).toHaveLength(2);
      expect(queue.getItems()).toHaveLength(1); // only meeting remains
      expect(queue.getItems()[0].type).toBe('meeting-recording');
    });

    it('regular failure still works as before (backwards-compatible)', async () => {
      await queue.init();
      consumer.mockResolvedValue({ success: false, error: 'Server error', errorCategory: 'network' });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      await queue.drain(true);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(1); // incremented for regular failures
      expect(items[0].errorCategory).toBe('network');
      expect(items[0].isPermanentFailure).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Self-rearming retry scheduler
  // -----------------------------------------------------------------------

  describe('self-rearming retry scheduler', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-drains an attempt-neutral deferred item without an external drain call', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      let nextHandle = 0;
      const scheduledTimers = new Map<ReturnType<typeof setTimeout>, ReturnType<typeof setTimeout>>();
      const scheduleTimer = (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
        const timer = setTimeout(cb, ms);
        nextHandle += 1;
        const handle = nextHandle as unknown as ReturnType<typeof setTimeout>;
        scheduledTimers.set(handle, timer);
        return handle;
      };
      const clearScheduledTimer = (handle: ReturnType<typeof setTimeout>): void => {
        const timer = scheduledTimers.get(handle);
        if (timer) clearTimeout(timer);
        scheduledTimers.delete(handle);
      };
      queue = new OfflineQueue(storage, consumer, {
        scheduleTimer,
        clearScheduledTimer,
      });
      await queue.init();

      let callCount = 0;
      consumer.mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            success: false,
            error: 'Session is busy',
            errorCategory: 'session-state',
          };
        }
        return { success: true };
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/voice.m4a', 'm4a', {});
      const beforeDrain = Date.now();
      await queue.drain(true);

      let items = queue.getItems();
      expect(callCount).toBe(1);
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(0);
      expect(items[0].nextRetryAt).toBeGreaterThan(beforeDrain);

      await vi.advanceTimersByTimeAsync(DEFER_DELAY_MS + 1);

      expect(callCount).toBe(2);
      items = queue.getItems();
      expect(items).toHaveLength(0);
    });

    it('does not arm when the last drain is offline', async () => {
      const scheduleTimer = vi.fn((() => 1 as unknown as ReturnType<typeof setTimeout>));
      const clearScheduledTimer = vi.fn();
      storage.items = [{
        id: 'future-offline',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: 1_000,
        attempts: 0,
        nextRetryAt: 11_000,
        isPermanentFailure: false,
        metadata: {},
      }];
      queue = new OfflineQueue(storage, consumer, {
        now: () => 1_000,
        scheduleTimer,
        clearScheduledTimer,
      });
      await queue.init();

      await queue.drain(false);

      expect(scheduleTimer).not.toHaveBeenCalled();
      expect(clearScheduledTimer).not.toHaveBeenCalled();
    });

    it('does not arm for permanent-failure items', async () => {
      const scheduleTimer = vi.fn((() => 1 as unknown as ReturnType<typeof setTimeout>));
      storage.items = [{
        id: 'future-permanent',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: 1_000,
        attempts: MAX_ATTEMPTS_BEFORE_PERMANENT,
        nextRetryAt: 11_000,
        isPermanentFailure: true,
        metadata: {},
      }];
      queue = new OfflineQueue(storage, consumer, {
        now: () => 1_000,
        scheduleTimer,
        clearScheduledTimer: vi.fn(),
      });
      await queue.init();

      await queue.drain(true);

      expect(scheduleTimer).not.toHaveBeenCalled();
    });

    it('does not arm for identity-mismatched items', async () => {
      const scheduleTimer = vi.fn((() => 1 as unknown as ReturnType<typeof setTimeout>));
      storage.items = [{
        id: 'future-mismatch',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: 1_000,
        attempts: 0,
        nextRetryAt: 11_000,
        isPermanentFailure: false,
        boundCloudUrl: 'https://other.example.com',
        metadata: {},
      }];
      queue = new OfflineQueue(storage, consumer, {
        now: () => 1_000,
        scheduleTimer,
        clearScheduledTimer: vi.fn(),
      });
      await queue.init();
      queue.bindAuthIdentity('https://current.example.com');

      await queue.drain(true);

      expect(scheduleTimer).not.toHaveBeenCalled();
    });

    it('keeps only one scheduler timer armed when drains re-arm', async () => {
      let nextHandle = 0;
      const activeHandles = new Set<ReturnType<typeof setTimeout>>();
      const scheduleTimer = vi.fn((() => {
        nextHandle += 1;
        const handle = nextHandle as unknown as ReturnType<typeof setTimeout>;
        activeHandles.add(handle);
        return handle;
      }));
      const clearScheduledTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => {
        activeHandles.delete(timer);
      });
      storage.items = [{
        id: 'future-single-timer',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: 1_000,
        attempts: 0,
        nextRetryAt: 11_000,
        isPermanentFailure: false,
        metadata: {},
      }];
      queue = new OfflineQueue(storage, consumer, {
        now: () => 1_000,
        scheduleTimer,
        clearScheduledTimer,
      });
      await queue.init();

      await queue.drain(true);
      await queue.drain(true);

      expect(scheduleTimer).toHaveBeenCalledTimes(2);
      expect(clearScheduledTimer).toHaveBeenCalledTimes(1);
      expect(activeHandles.size).toBe(1);
    });

    it('preserves itemTypes scope when re-arming (excluded types stay excluded)', async () => {
      // A type-scoped (e.g. background meeting-chunk-only) drain must not
      // re-arm an unscoped drain that would later pull in excluded voice items.
      let capturedCb: (() => void) | null = null;
      const scheduleTimer = vi.fn(((cb: () => void) => {
        capturedCb = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }));
      storage.items = [
        {
          id: 'voice-out-of-scope',
          type: 'voice-transcription',
          status: 'pending',
          enqueuedAt: 1_000,
          attempts: 0,
          nextRetryAt: 40_000,
          isPermanentFailure: false,
          metadata: {},
        },
        {
          id: 'chunk-in-scope',
          type: 'meeting-chunk',
          status: 'pending',
          enqueuedAt: 1_000,
          attempts: 0,
          nextRetryAt: 0,
          isPermanentFailure: false,
          metadata: {},
        },
      ];
      storage.payloads.set('chunk-in-scope', 'file:///chunk.m4a');
      consumer.mockResolvedValue({
        success: false,
        error: 'Session is busy',
        errorCategory: 'session-state',
      });

      queue = new OfflineQueue(storage, consumer, {
        now: () => 20_000,
        scheduleTimer,
        clearScheduledTimer: vi.fn(),
      });
      await queue.init();

      await queue.drain(true, { itemTypes: ['meeting-chunk'] });

      // Only the in-scope item was consumed during the scoped drain.
      expect(consumer).toHaveBeenCalledTimes(1);
      expect((consumer.mock.calls[0][0] as { type: string }).type).toBe('meeting-chunk');
      expect(scheduleTimer).toHaveBeenCalledTimes(1);

      // The re-armed drain preserves the meeting-chunk scope — it does NOT
      // call an unscoped drain() that would pull in the excluded voice item.
      const drainSpy = vi.spyOn(queue, 'drain');
      capturedCb!();
      expect(drainSpy).toHaveBeenLastCalledWith(true, { itemTypes: ['meeting-chunk'] });
    });
  });

  // -----------------------------------------------------------------------
  // drain mutex
  // -----------------------------------------------------------------------

  describe('drain mutex', () => {
    it('prevents concurrent drain calls', async () => {
      await queue.init();

      // Consumer that takes a bit to resolve (controlled promise)
      let resolveConsumer!: (value: QueueConsumerResult) => void;
      consumer.mockImplementation(
        () => new Promise<QueueConsumerResult>((resolve) => { resolveConsumer = resolve; }),
      );

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});

      // Start first drain (won't complete until we resolve the consumer)
      const drain1 = queue.drain(true);

      // Flush microtasks so drain1 reaches the consumer callback
      // (saveSnapshot + getPayloadUri are async but resolve immediately in mock)
      await new Promise((r) => setTimeout(r, 0));

      // Start second drain while first is running
      const drain2 = queue.drain(true);

      // Second drain should return immediately (no-op)
      await drain2;

      // First drain is still waiting on consumer
      expect(queue.getIsDraining()).toBe(true);

      // Now resolve the consumer
      resolveConsumer({ success: true });
      await drain1;

      // Consumer called only once (mutex prevented second drain)
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(queue.getIsDraining()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // backoff on failure
  // -----------------------------------------------------------------------

  describe('backoff', () => {
    it('applies backoff on consumer failure', async () => {
      await queue.init();
      consumer.mockResolvedValue({ success: false, error: 'Network error', errorCategory: 'network' });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      const beforeDrain = Date.now();
      await queue.drain(true);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(1);
      expect(items[0].lastError).toBe('Network error');
      expect(items[0].errorCategory).toBe('network');
      expect(items[0].isPermanentFailure).toBe(false);
      // nextRetryAt should be ~2s in the future
      expect(items[0].nextRetryAt).toBeGreaterThanOrEqual(beforeDrain + BASE_BACKOFF_MS - 100);
    });

    it('escalates backoff on repeated failures', async () => {
      consumer.mockResolvedValue({ success: false, error: 'fail' });

      // Pre-populate storage with an item that already has 4 attempts
      storage.items = [{
        id: 'retry-me',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: Date.now(),
        attempts: 4,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      }];
      storage.payloads.set('retry-me', 'persisted://retry-me.m4a');

      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      const beforeDrain = Date.now();
      await queue.drain(true);

      const items = queue.getItems();
      expect(items[0].attempts).toBe(5);
      // 5th attempt backoff: 2000 * 2^4 = 32000
      expect(items[0].nextRetryAt).toBeGreaterThanOrEqual(beforeDrain + 32_000 - 100);
    });

    it('handles consumer throwing error as transient failure', async () => {
      await queue.init();
      consumer.mockRejectedValue(new Error('Unexpected crash'));

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      await queue.drain(true);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(1);
      expect(items[0].lastError).toBe('Unexpected crash');
    });
  });

  // -----------------------------------------------------------------------
  // permanent failure
  // -----------------------------------------------------------------------

  describe('permanent failure', () => {
    it('immediately marks permanent when errorCategory is permanent (no retry)', async () => {
      await queue.init();
      consumer.mockResolvedValue({ success: false, error: 'Payload missing', errorCategory: 'permanent' });

      await queue.enqueue('text-with-attachments', null, null, { sessionId: 's1' });
      await queue.drain(true);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].isPermanentFailure).toBe(true);
      expect(items[0].attempts).toBe(1);
      expect(items[0].lastError).toBe('Payload missing');
      expect(items[0].errorCategory).toBe('permanent');
    });

    it.each(['provider-auth', 'billing'])(
      'immediately marks non-retryable %s category permanent while preserving category',
      async (errorCategory) => {
        await queue.init();
        consumer.mockResolvedValue({
          success: false,
          error: 'Voice provider needs attention',
          errorCategory,
        });

        await queue.enqueue('voice-transcription', 'file:///tmp/voice.m4a', 'm4a', {});
        await queue.drain(true);

        const items = queue.getItems();
        expect(items).toHaveLength(1);
        expect(items[0].isPermanentFailure).toBe(true);
        expect(items[0].attempts).toBe(1);
        expect(items[0].lastError).toBe('Voice provider needs attention');
        expect(items[0].errorCategory).toBe(errorCategory);
      },
    );

    it('keeps provider-error retryable while preserving category', async () => {
      await queue.init();
      consumer.mockResolvedValue({
        success: false,
        error: 'Voice provider is having trouble',
        errorCategory: 'provider-error',
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/voice.m4a', 'm4a', {});
      await queue.drain(true);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].isPermanentFailure).toBe(false);
      expect(items[0].attempts).toBe(1);
      expect(items[0].lastError).toBe('Voice provider is having trouble');
      expect(items[0].errorCategory).toBe('provider-error');
    });

    it('marks as permanent after MAX_ATTEMPTS_BEFORE_PERMANENT failures', async () => {
      consumer.mockResolvedValue({ success: false, error: 'Server error' });

      // Pre-populate with item at MAX_ATTEMPTS - 1 (one more failure → permanent)
      storage.items = [{
        id: 'perm-fail',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: Date.now(),
        attempts: MAX_ATTEMPTS_BEFORE_PERMANENT - 1,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      }];
      storage.payloads.set('perm-fail', 'persisted://perm-fail.m4a');

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.drain(true);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].isPermanentFailure).toBe(true);
      expect(items[0].attempts).toBe(MAX_ATTEMPTS_BEFORE_PERMANENT);
      expect(items[0].lastError).toBe('Server error');
    });

    it('permanently failed items are not processed on subsequent drains', async () => {
      consumer.mockResolvedValue({ success: false, error: 'fail' });

      storage.items = [{
        id: 'perm',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: Date.now(),
        attempts: MAX_ATTEMPTS_BEFORE_PERMANENT,
        nextRetryAt: 0,
        isPermanentFailure: true,
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.drain(true);

      expect(consumer).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // retryItem (manual retry)
  // -----------------------------------------------------------------------

  describe('retryItem', () => {
    it('resets backoff, attempts, and permanent failure flag', async () => {
      const originalEnqueuedAt = Date.now() - 49 * 3600_000;
      const retryStartedAfter = Date.now();
      storage.items = [{
        id: 'retry-target',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: originalEnqueuedAt,
        attempts: 8,
        nextRetryAt: Date.now() + 60_000,
        isPermanentFailure: true,
        processingStartedAt: Date.now() - 60_000,
        lastError: 'Server error',
        errorCategory: 'temporary',
        metadata: {},
      }];
      storage.payloads.set('retry-target', 'persisted://retry-target.m4a');

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.retryItem('retry-target');

      const items = queue.getItems();
      expect(items[0].attempts).toBe(0);
      expect(items[0].nextRetryAt).toBe(0);
      expect(items[0].isPermanentFailure).toBe(false);
      expect(items[0].lastError).toBeUndefined();
      expect(items[0].errorCategory).toBeUndefined();
      expect(items[0].status).toBe('pending');
      expect(items[0].processingStartedAt).toBeUndefined();
      expect(items[0].enqueuedAt).toBe(originalEnqueuedAt);
      expect(items[0].staleSweepAnchorAt).toBeGreaterThanOrEqual(retryStartedAfter);
    });

    it('makes item eligible for immediate drain after retry', async () => {
      consumer.mockResolvedValue({ success: true });

      storage.items = [{
        id: 'retry-drain',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: Date.now(),
        attempts: 5,
        nextRetryAt: Date.now() + 999_999,
        isPermanentFailure: true,
        lastError: 'old error',
        metadata: {},
      }];
      storage.payloads.set('retry-drain', 'persisted://retry-drain.m4a');

      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      // Before retry: drain should skip (permanent failure)
      await queue.drain(true);
      expect(consumer).not.toHaveBeenCalled();

      // After retry: drain should process
      await queue.retryItem('retry-drain');
      await queue.drain(true);
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(queue.getItems()).toHaveLength(0);
    });

    it('lets old permanently failed items process after manual retry', async () => {
      consumer.mockResolvedValue({ success: true });

      storage.items = [{
        id: 'old-retry-drain',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: Date.now() - 13 * 24 * 3600_000,
        attempts: MAX_ATTEMPTS_BEFORE_PERMANENT,
        nextRetryAt: 0,
        isPermanentFailure: true,
        lastError: 'Item could not be sent after 48 hours',
        errorCategory: 'timeout',
        metadata: {},
      }];
      storage.payloads.set('old-retry-drain', 'persisted://old-retry-drain.m4a');

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.retryItem('old-retry-drain');
      await queue.drain(true);

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(queue.getItems()).toHaveLength(0);
    });

    it('no-ops for non-existent id', async () => {
      await queue.init();
      await queue.retryItem('non-existent'); // should not throw
    });
  });

  // -----------------------------------------------------------------------
  // removeItem
  // -----------------------------------------------------------------------

  describe('removeItem', () => {
    it('removes item and deletes payload', async () => {
      await queue.init();
      const item = await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      assertQueueItem(item);

      await queue.removeItem(item.id);

      expect(queue.getItems()).toHaveLength(0);
      expect(storage.items).toHaveLength(0);
      expect(storage.payloads.size).toBe(0);
    });

    it('no-ops for non-existent id', async () => {
      await queue.init();
      await queue.removeItem('non-existent'); // should not throw
    });

    it('notifies listeners', async () => {
      await queue.init();
      const item = await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      assertQueueItem(item);

      const listener = vi.fn();
      queue.subscribe(listener);

      await queue.removeItem(item.id);
      expect(listener).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ items: [] }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // clearAll
  // -----------------------------------------------------------------------

  describe('clearAll', () => {
    it('removes all items and payloads', async () => {
      await queue.init();
      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      await queue.enqueue('voice-transcription', 'file:///tmp/b.m4a', 'm4a', {});
      await queue.enqueue('voice-transcription', 'file:///tmp/c.m4a', 'm4a', {});

      expect(queue.getItems()).toHaveLength(3);

      await queue.clearAll();

      expect(queue.getItems()).toHaveLength(0);
      expect(storage.items).toHaveLength(0);
      expect(storage.payloads.size).toBe(0);
    });

    it('works when queue is already empty', async () => {
      await queue.init();
      await queue.clearAll(); // should not throw
      expect(queue.getItems()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // subscribe
  // -----------------------------------------------------------------------

  describe('subscribe', () => {
    it('notifies on enqueue, drain, remove', async () => {
      await queue.init();
      const listener = vi.fn();
      queue.subscribe(listener);

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      const enqueueCallCount = listener.mock.calls.length;
      expect(enqueueCallCount).toBeGreaterThan(0);

      await queue.drain(true);
      expect(listener.mock.calls.length).toBeGreaterThan(enqueueCallCount);
    });

    it('unsubscribe stops notifications', async () => {
      await queue.init();
      const listener = vi.fn();
      const unsub = queue.subscribe(listener);

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      const callCount = listener.mock.calls.length;

      unsub();
      await queue.enqueue('voice-transcription', 'file:///tmp/b.m4a', 'm4a', {});
      expect(listener.mock.calls.length).toBe(callCount);
    });
  });

  // -----------------------------------------------------------------------
  // getIsDraining
  // -----------------------------------------------------------------------

  describe('getIsDraining', () => {
    it('is false when not draining', async () => {
      await queue.init();
      expect(queue.getIsDraining()).toBe(false);
    });

    it('is true during drain', async () => {
      await queue.init();
      let wasDraining = false;

      consumer.mockImplementation(async () => {
        wasDraining = queue.getIsDraining();
        return { success: true };
      });

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', {});
      await queue.drain(true);

      expect(wasDraining).toBe(true);
      expect(queue.getIsDraining()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // item removed during drain
  // -----------------------------------------------------------------------

  describe('item removed during drain', () => {
    it('skips item that was removed while drain is iterating', async () => {
      await queue.init();

      await queue.enqueue('voice-transcription', 'file:///tmp/a.m4a', 'm4a', { n: 1 });
      await queue.enqueue('voice-transcription', 'file:///tmp/b.m4a', 'm4a', { n: 2 });

      let firstCall = true;
      consumer.mockImplementation(async (item) => {
        if (firstCall) {
          firstCall = false;
          // While processing item 1, remove item 2
          const allItems = queue.getItems();
          const item2 = allItems.find(i => (i.metadata as Record<string, unknown>).n === 2);
          if (item2) await queue.removeItem(item2.id);
        }
        return { success: true };
      });

      await queue.drain(true);

      // Consumer called once (item 2 was removed before its turn)
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(queue.getItems()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Queue size cap
  // -----------------------------------------------------------------------

  describe('queue size cap', () => {
    it('rejects enqueue when queue is at max size', async () => {
      await queue.init();

      // Fill queue to cap
      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        await queue.enqueue('text-message', null, null, { n: i });
      }
      expect(queue.getItems()).toHaveLength(QUEUE_MAX_SIZE);

      // Next enqueue should be rejected
      const result = await queue.enqueue('text-message', null, null, { n: 'overflow' });
      expect('accepted' in result && result.accepted === false).toBe(true);
      if ('reason' in result) {
        expect(result.reason).toBe('queue-full');
        expect(result.maxSize).toBe(QUEUE_MAX_SIZE);
      }

      // Queue size unchanged
      expect(queue.getItems()).toHaveLength(QUEUE_MAX_SIZE);
    });

    it('sets queueFullAt on rejection', async () => {
      await queue.init();

      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        await queue.enqueue('text-message', null, null, { n: i });
      }

      const before = Date.now();
      await queue.enqueue('text-message', null, null, { overflow: true });
      expect(queue.queueFullAt).toBeGreaterThanOrEqual(before);
    });

    it('clears queueFullAt after drain reduces items below cap', async () => {
      await queue.init();

      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        await queue.enqueue('text-message', null, null, { n: i });
      }
      await queue.enqueue('text-message', null, null, { overflow: true });
      expect(queue.queueFullAt).not.toBeNull();

      // Drain all items
      await queue.drain(true);
      expect(queue.queueFullAt).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Drain jitter
  // -----------------------------------------------------------------------

  describe('drain jitter', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('delays drain start when jitterMs is configured', async () => {
      vi.useFakeTimers();

      const jitterStorage = new InMemoryStorage();
      const jitterConsumer = vi.fn<QueueConsumer>().mockResolvedValue({ success: true });
      const jitterQueue = new OfflineQueue(jitterStorage, jitterConsumer, { jitterMs: 100 });
      await jitterQueue.init();

      await jitterQueue.enqueue('text-message', null, null, { msg: 'test' });

      // Start drain — consumer should not be called immediately due to jitter
      const drainPromise = jitterQueue.drain(true);

      // Consumer should not have been called yet (still in jitter delay)
      expect(jitterConsumer).not.toHaveBeenCalled();

      // Advance past jitter
      await vi.advanceTimersByTimeAsync(200);
      await drainPromise;

      expect(jitterConsumer).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Per-item processing timeout
  // -----------------------------------------------------------------------

  describe('processing timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('times out after DEFAULT_PROCESSING_TIMEOUT_MS', async () => {
      vi.useFakeTimers();

      const timeoutStorage = new InMemoryStorage();
      // Consumer that never resolves
      const hangingConsumer = vi.fn<QueueConsumer>().mockImplementation(
        () => new Promise<QueueConsumerResult>(() => {}),
      );
      const timeoutQueue = new OfflineQueue(timeoutStorage, hangingConsumer);
      await timeoutQueue.init();

      await timeoutQueue.enqueue('text-message', null, null, { msg: 'timeout-test' });

      const drainPromise = timeoutQueue.drain(true);

      // Advance past the processing timeout
      await vi.advanceTimersByTimeAsync(DEFAULT_PROCESSING_TIMEOUT_MS + 1000);
      await drainPromise;

      const items = timeoutQueue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].attempts).toBe(1);
      expect(items[0].errorCategory).toBe('timeout');
      expect(items[0].lastError).toContain('timed out');
    });

    it('uses custom processingTimeoutMs when configured', async () => {
      vi.useFakeTimers();

      const timeoutStorage = new InMemoryStorage();
      const hangingConsumer = vi.fn<QueueConsumer>().mockImplementation(
        () => new Promise<QueueConsumerResult>(() => {}),
      );
      // Short timeout for test speed
      const timeoutQueue = new OfflineQueue(timeoutStorage, hangingConsumer, {
        processingTimeoutMs: 500,
      });
      await timeoutQueue.init();

      await timeoutQueue.enqueue('text-message', null, null, { msg: 'custom-timeout' });

      const drainPromise = timeoutQueue.drain(true);
      await vi.advanceTimersByTimeAsync(600);
      await drainPromise;

      const items = timeoutQueue.getItems();
      expect(items[0].errorCategory).toBe('timeout');
    });
  });

  // -----------------------------------------------------------------------
  // Clock-jump guard
  // -----------------------------------------------------------------------

  describe('clock-jump guard', () => {
    it('recomputes nextRetryAt for items with far-future timestamps', async () => {
      const farFuture = Date.now() + MAX_BACKOFF_MS + 120_000; // way past threshold

      storage.items = [{
        id: 'clock-jumped',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: Date.now() - 5000,
        attempts: 2,
        nextRetryAt: farFuture,
        isPermanentFailure: false,
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      await queue.drain(true);

      // Item should have been recomputed and processed
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(queue.getItems()).toHaveLength(0);
    });

    it('makes items with future enqueuedAt immediately eligible', async () => {
      const farFuture = Date.now() + MAX_BACKOFF_MS + 120_000;

      storage.items = [{
        id: 'future-enqueued',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: farFuture, // enqueuedAt is also in the future
        attempts: 1,
        nextRetryAt: farFuture + 60_000,
        isPermanentFailure: false,
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      await queue.drain(true);

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(queue.getItems()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Stuck-processing sweep (age-based: >48h enqueued → permanent)
  // -----------------------------------------------------------------------

  describe('stuck-processing sweep', () => {
    it('sweeps items enqueued >48h ago as permanent failure', async () => {
      const oldTime = Date.now() - (49 * 3600_000); // 49 hours ago

      storage.items = [{
        id: 'stuck-item',
        type: 'meeting-chunk',
        status: 'pending',
        enqueuedAt: oldTime,
        attempts: 3,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.drain(true);

      const items = queue.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].isPermanentFailure).toBe(true);
      expect(items[0].errorCategory).toBe('timeout');
      expect(items[0].lastError).toContain('48 hours');
      // Consumer should NOT have been called — item was swept before processing
      expect(consumer).not.toHaveBeenCalled();
    });

    it('does not sweep items enqueued <48h ago', async () => {
      const recentTime = Date.now() - (47 * 3600_000 + 59 * 60_000); // 47h59m ago

      storage.items = [{
        id: 'recent-item',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: recentTime,
        attempts: 3,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.drain(true);

      const items = queue.getItems();
      // Item should have been processed by consumer, not swept
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(items).toHaveLength(0); // processed successfully
    });

    it('uses staleSweepAnchorAt instead of original enqueuedAt', async () => {
      const oldTime = Date.now() - (13 * 24 * 3600_000);
      const recentRetryWindow = Date.now() - 60_000;

      storage.items = [{
        id: 'recent-anchor',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: oldTime,
        staleSweepAnchorAt: recentRetryWindow,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      }];
      storage.payloads.set('recent-anchor', 'persisted://recent-anchor.m4a');

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.drain(true);

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(queue.getItems()).toHaveLength(0);
    });

    it('sweeps retried items after the refreshed stale window expires', async () => {
      const oldTime = Date.now() - (13 * 24 * 3600_000);
      const expiredRetryWindow = Date.now() - (49 * 3600_000);

      storage.items = [{
        id: 'expired-anchor',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: oldTime,
        staleSweepAnchorAt: expiredRetryWindow,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.drain(true);

      const items = queue.getItems();
      expect(consumer).not.toHaveBeenCalled();
      expect(items).toHaveLength(1);
      expect(items[0].isPermanentFailure).toBe(true);
      expect(items[0].errorCategory).toBe('timeout');
      expect(items[0].enqueuedAt).toBe(oldTime);
    });

    it('does not sweep items outside a type-scoped drain', async () => {
      const oldTime = Date.now() - (49 * 3600_000);

      storage.items = [
        {
          id: 'old-voice',
          type: 'voice-transcription',
          status: 'pending',
          enqueuedAt: oldTime,
          attempts: 0,
          nextRetryAt: 0,
          isPermanentFailure: false,
          metadata: {},
        },
        {
          id: 'old-meeting',
          type: 'meeting-chunk',
          status: 'pending',
          enqueuedAt: oldTime,
          attempts: 0,
          nextRetryAt: 0,
          isPermanentFailure: false,
          metadata: {},
        },
      ];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      const summary = await queue.drain(true, { itemTypes: ['meeting-chunk'] });

      const itemsById = new Map(queue.getItems().map((item) => [item.id, item]));
      expect(consumer).not.toHaveBeenCalled();
      expect(summary.terminalized).toBe(1);
      expect(itemsById.get('old-voice')?.isPermanentFailure).toBe(false);
      expect(itemsById.get('old-meeting')?.isPermanentFailure).toBe(true);
    });

    it('does not re-sweep already permanent items', async () => {
      const oldTime = Date.now() - (49 * 3600_000);

      storage.items = [{
        id: 'already-perm',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: oldTime,
        attempts: 5,
        nextRetryAt: 0,
        isPermanentFailure: true,
        errorCategory: 'permanent',
        lastError: 'Previously failed',
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      await queue.drain(true);

      const items = queue.getItems();
      expect(items[0].errorCategory).toBe('permanent'); // unchanged
      expect(items[0].lastError).toBe('Previously failed'); // unchanged
    });

    it('init recovery: processing items are reset to pending', async () => {
      const oldTime = Date.now() - (49 * 3600_000);

      storage.items = [{
        id: 'init-recover',
        type: 'meeting-chunk',
        status: 'processing',
        enqueuedAt: oldTime,
        attempts: 1,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      // Init should have recovered it to pending
      const items = queue.getItems();
      expect(items[0].status).toBe('pending');
    });
  });

  // -----------------------------------------------------------------------
  // Auth-identity binding
  // -----------------------------------------------------------------------

  describe('auth-identity binding', () => {
    it('drains only items matching current bound identity', async () => {
      await queue.init();
      queue.bindAuthIdentity('https://cloud-a.example.com');

      // Enqueue items — one bound to cloud-a, one to cloud-b
      await queue.enqueue('text-message', null, null, { msg: 'a' }, 'https://cloud-a.example.com');
      await queue.enqueue('text-message', null, null, { msg: 'b' }, 'https://cloud-b.example.com');

      const processed: string[] = [];
      consumer.mockImplementation(async (item) => {
        processed.push((item.metadata as Record<string, unknown>).msg as string);
        return { success: true };
      });

      await queue.drain(true);

      // Only cloud-a item should have been processed
      expect(processed).toEqual(['a']);
      expect(queue.getItems()).toHaveLength(1);
      expect(queue.getItems()[0].boundCloudUrl).toBe('https://cloud-b.example.com');

      // Now rebind to cloud-b
      queue.bindAuthIdentity('https://cloud-b.example.com');
      await queue.drain(true);

      expect(processed).toEqual(['a', 'b']);
      expect(queue.getItems()).toHaveLength(0);
    });

    it('drains unbound (legacy) items regardless of current identity', async () => {
      // Legacy items have no boundCloudUrl — they should always drain
      storage.items = [{
        id: 'legacy',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: Date.now() - 1000,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
        // No boundCloudUrl
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      queue.bindAuthIdentity('https://cloud-x.example.com');

      await queue.drain(true);

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(queue.getItems()).toHaveLength(0);
    });

    it('auto-tags items with current bound identity when not explicitly provided', async () => {
      await queue.init();
      queue.bindAuthIdentity('https://cloud-auto.example.com');

      const item = await queue.enqueue('text-message', null, null, { msg: 'auto' });
      // Should not be a rejection
      expect('id' in item).toBe(true);
      if ('id' in item) {
        expect(item.boundCloudUrl).toBe('https://cloud-auto.example.com');
      }
    });

    it('logs a warning when the active identity mismatches queued items', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await queue.init();
      await queue.enqueue('text-message', null, null, { msg: 'stale' }, 'https://cloud-a.example.com');

      queue.bindAuthIdentity('https://cloud-b.example.com');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queue has items bound to a different identity'),
      );

      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Stuck-drain detection
  // -----------------------------------------------------------------------

  describe('stuck-drain detection', () => {
    it('sets limitedConnectivityAt after 3 consecutive network errors across drains', async () => {
      consumer.mockResolvedValue({ success: false, error: 'Network error', errorCategory: 'network' });

      await queue.init();
      expect(queue.limitedConnectivityAt).toBeNull();

      // Enqueue 3 items — all will fail with network error in one drain cycle.
      // Each failure tracks a 'network' error category, so after 3 we hit the threshold.
      await queue.enqueue('text-message', null, null, { n: 1 });
      await queue.enqueue('text-message', null, null, { n: 2 });
      await queue.enqueue('text-message', null, null, { n: 3 });

      await queue.drain(true);

      // 3 consecutive network errors in one drain → should be flagged
      expect(queue.limitedConnectivityAt).not.toBeNull();
    });

    it('clears limitedConnectivityAt on successful drain', async () => {
      await queue.init();

      // First: cause limited connectivity detection with 3 network failures
      consumer.mockResolvedValue({ success: false, error: 'Network error', errorCategory: 'network' });
      await queue.enqueue('text-message', null, null, { n: 1 });
      await queue.enqueue('text-message', null, null, { n: 2 });
      await queue.enqueue('text-message', null, null, { n: 3 });
      await queue.drain(true);

      expect(queue.limitedConnectivityAt).not.toBeNull();

      // Now switch consumer to success and make items eligible again
      consumer.mockResolvedValue({ success: true });
      const items = queue.getItems();
      for (const item of items) {
        item.nextRetryAt = 0;
      }
      // We must manipulate the internal items directly via storage
      // but keep the same queue instance to preserve recentErrorCategories.
      // The getItems() returns a copy, so we need to update storage and re-init.
      // Actually, easier: just use a fresh storage + queue since we need to test
      // that success clears the flag.
      storage.items = items;
      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      // Need to first set up the limited connectivity state
      // Since this is a fresh queue, we need 3 network errors first, then success
      consumer.mockResolvedValue({ success: false, error: 'Network error', errorCategory: 'network' });
      await queue.drain(true);
      // Items are now in backoff. Make them eligible again
      for (const item of queue.getItems()) {
        item.nextRetryAt = 0;
      }
      await queue.drain(true);
      for (const item of queue.getItems()) {
        item.nextRetryAt = 0;
      }
      await queue.drain(true);

      // Now should be flagged
      expect(queue.limitedConnectivityAt).not.toBeNull();

      // Switch to success
      consumer.mockResolvedValue({ success: true });
      for (const item of queue.getItems()) {
        item.nextRetryAt = 0;
        item.isPermanentFailure = false;
        item.attempts = 0;
      }
      await queue.drain(true);

      expect(queue.limitedConnectivityAt).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Listener payload shape
  // -----------------------------------------------------------------------

  describe('listener state snapshot', () => {
    it('passes QueueStateSnapshot as second arg to listeners', async () => {
      await queue.init();

      const snapshots: QueueStateSnapshot[] = [];
      queue.subscribe((_items, state) => {
        if (state) snapshots.push(state);
      });

      await queue.enqueue('text-message', null, null, { msg: 'test' });

      expect(snapshots.length).toBeGreaterThan(0);
      const latest = snapshots[snapshots.length - 1];
      expect(latest).toHaveProperty('items');
      expect(latest).toHaveProperty('queueFullAt');
      expect(latest).toHaveProperty('limitedConnectivityAt');
      expect(latest).toHaveProperty('authExpiredAt');
      expect(latest).toHaveProperty('boundCloudUrl');
      expect(latest.items).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // authExpiredItems
  // -----------------------------------------------------------------------

  describe('authExpiredItems', () => {
    it('returns items with auth error matching current identity', async () => {
      const cloudUrl = 'https://cloud.example.com';

      storage.items = [
        {
          id: 'auth-expired-1',
          type: 'text-message',
          status: 'pending',
          enqueuedAt: 1000,
          attempts: 1,
          nextRetryAt: 0,
          isPermanentFailure: false,
          errorCategory: 'auth',
          lastError: '401 Unauthorized',
          boundCloudUrl: cloudUrl,
          metadata: {},
        },
        {
          id: 'auth-expired-other',
          type: 'text-message',
          status: 'pending',
          enqueuedAt: 2000,
          attempts: 1,
          nextRetryAt: 0,
          isPermanentFailure: false,
          errorCategory: 'auth',
          lastError: '401 Unauthorized',
          boundCloudUrl: 'https://other.example.com',
          metadata: {},
        },
        {
          id: 'network-error',
          type: 'text-message',
          status: 'pending',
          enqueuedAt: 3000,
          attempts: 1,
          nextRetryAt: 0,
          isPermanentFailure: false,
          errorCategory: 'network',
          boundCloudUrl: cloudUrl,
          metadata: {},
        },
      ];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      queue.bindAuthIdentity(cloudUrl);

      const expired = queue.authExpiredItems();
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe('auth-expired-1');
    });

    it('returns empty array when no identity is bound', async () => {
      storage.items = [{
        id: 'auth-item',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 1000,
        attempts: 1,
        nextRetryAt: 0,
        isPermanentFailure: false,
        errorCategory: 'auth',
        boundCloudUrl: 'https://cloud.example.com',
        metadata: {},
      }];

      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      // Don't bind — boundCloudUrl is null

      expect(queue.authExpiredItems()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // AbortSignal on timeout
  // -----------------------------------------------------------------------

  describe('AbortSignal on timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('aborts signal when processing times out', async () => {
      vi.useFakeTimers();

      const timeoutStorage = new InMemoryStorage();
      let receivedSignal: AbortSignal | undefined;
      const signalConsumer = vi.fn<QueueConsumer>().mockImplementation(
        async (_item, _payload, signal) => {
          receivedSignal = signal;
          // Never resolves within timeout
          await new Promise<QueueConsumerResult>(() => {});
          return { success: true };
        },
      );
      const timeoutQueue = new OfflineQueue(timeoutStorage, signalConsumer, {
        processingTimeoutMs: 500,
      });
      await timeoutQueue.init();

      await timeoutQueue.enqueue('text-message', null, null, { msg: 'abort-test' });

      const drainPromise = timeoutQueue.drain(true);
      await vi.advanceTimersByTimeAsync(600);
      await drainPromise;

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(true);
    });

    it('does not abort signal when consumer completes before timeout', async () => {
      vi.useFakeTimers();

      const fastStorage = new InMemoryStorage();
      let receivedSignal: AbortSignal | undefined;
      const fastConsumer = vi.fn<QueueConsumer>().mockImplementation(
        async (_item, _payload, signal) => {
          receivedSignal = signal;
          return { success: true };
        },
      );
      const fastQueue = new OfflineQueue(fastStorage, fastConsumer, {
        processingTimeoutMs: 5000,
      });
      await fastQueue.init();

      await fastQueue.enqueue('text-message', null, null, { msg: 'fast-test' });
      await fastQueue.drain(true);

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(false);
    });

    it('passes signal as third argument to consumer', async () => {
      await queue.init();
      await queue.enqueue('text-message', null, null, { msg: 'signal-arg-test' });
      await queue.drain(true);

      expect(consumer).toHaveBeenCalledTimes(1);
      const call = consumer.mock.calls[0];
      expect(call).toHaveLength(3);
      expect(call[2]).toBeInstanceOf(AbortSignal);
    });
  });

  // -----------------------------------------------------------------------
  // Legacy one-arg listener backward compat
  // -----------------------------------------------------------------------

  describe('listener backward compat', () => {
    it('supports legacy one-arg listeners (items only)', async () => {
      await queue.init();
      const listener = vi.fn();
      queue.subscribe(listener);

      await queue.enqueue('text-message', null, null, { msg: 'compat' });

      expect(listener).toHaveBeenCalled();
      // First arg is items array
      const firstArg = listener.mock.calls[0][0];
      expect(Array.isArray(firstArg)).toBe(true);
      expect(firstArg.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // bindAuthIdentity lifecycle
  // -----------------------------------------------------------------------

  describe('bindAuthIdentity lifecycle', () => {
    it('re-pair to same cloudUrl resumes queue', async () => {
      await queue.init();
      queue.bindAuthIdentity('https://cloud-a');
      await queue.enqueue('voice-transcription', null, null, {});

      queue.bindAuthIdentity(null); // simulate 401 unbind
      await queue.drain(true); // should not drain (no identity bound, but legacy items still drain)

      // Items without explicit cloudUrl drain even with null identity — legacy compat.
      // Test with explicitly bound items instead.
      consumer.mockClear();

      // Re-init with explicitly bound item
      storage.items = [];
      queue = new OfflineQueue(storage, consumer);
      await queue.init();
      queue.bindAuthIdentity('https://cloud-a');
      await queue.enqueue('voice-transcription', null, null, {}, 'https://cloud-a');

      queue.bindAuthIdentity(null);
      consumer.mockClear();
      await queue.drain(true);
      expect(consumer).not.toHaveBeenCalled();

      queue.bindAuthIdentity('https://cloud-a'); // re-pair same url
      await queue.drain(true);
      expect(consumer).toHaveBeenCalledTimes(1);
    });

    it('re-pair to different cloudUrl leaves old items dormant', async () => {
      await queue.init();
      queue.bindAuthIdentity('https://cloud-a');
      await queue.enqueue('voice-transcription', null, null, {}, 'https://cloud-a');

      queue.bindAuthIdentity('https://cloud-b');
      await queue.drain(true);
      expect(consumer).not.toHaveBeenCalled();

      // switch back
      queue.bindAuthIdentity('https://cloud-a');
      await queue.drain(true);
      expect(consumer).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Jitter — deterministic test
  // -----------------------------------------------------------------------

  describe('drain jitter deterministic', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('applies deterministic jitter when Math.random is stubbed', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // 50% → jitterMs/2 = 50ms

      const jitterStorage = new InMemoryStorage();
      const jitterConsumer = vi.fn<QueueConsumer>().mockResolvedValue({ success: true });
      const jitterQueue = new OfflineQueue(jitterStorage, jitterConsumer, { jitterMs: 100 });
      await jitterQueue.init();

      await jitterQueue.enqueue('text-message', null, null, { msg: 'jitter-test' });

      const drainPromise = jitterQueue.drain(true);

      // At 49ms: still in jitter
      await vi.advanceTimersByTimeAsync(49);
      expect(jitterConsumer).not.toHaveBeenCalled();

      // At 51ms: past jitter, consumer should run
      await vi.advanceTimersByTimeAsync(10);
      await drainPromise;

      expect(jitterConsumer).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // processingStartedAt field
  // -----------------------------------------------------------------------

  describe('processingStartedAt', () => {
    it('sets processingStartedAt when item enters processing', async () => {
      await queue.init();
      let capturedItem: QueueItem | undefined;
      consumer.mockImplementation(async (item) => {
        capturedItem = item;
        return { success: true };
      });

      await queue.enqueue('text-message', null, null, { msg: 'test' });
      const beforeDrain = Date.now();
      await queue.drain(true);

      expect(capturedItem).toBeDefined();
      expect(capturedItem!.processingStartedAt).toBeDefined();
      expect(capturedItem!.processingStartedAt).toBeGreaterThanOrEqual(beforeDrain - 100);
    });
  });

  // -----------------------------------------------------------------------
  // enqueueOrThrow (via offlineQueueStore)
  // -----------------------------------------------------------------------

  describe('queue-full rejection', () => {
    it('enqueue returns QueueFullRejection when at capacity', async () => {
      await queue.init();
      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        await queue.enqueue('text-message', null, null, { n: i });
      }

      const result = await queue.enqueue('text-message', null, null, { overflow: true });
      expect('accepted' in result).toBe(true);
      if ('accepted' in result) {
        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('queue-full');
        expect(result.maxSize).toBe(QUEUE_MAX_SIZE);
      }
    });
  });

  // -----------------------------------------------------------------------
  // enqueueWithJsonPayload
  // -----------------------------------------------------------------------

  describe('enqueueWithJsonPayload', () => {
    it('persists JSON via saveJsonPayload and creates queue item', async () => {
      await queue.init();
      const payload = { prompt: 'Hello', attachments: [{ type: 'image', data: 'base64...' }] };
      const item = await queue.enqueueWithJsonPayload(
        'text-with-attachments',
        payload,
        { sessionId: 's1', prompt: 'Hello', attachmentCount: 1 },
      );
      assertQueueItem(item);

      expect(item.type).toBe('text-with-attachments');
      expect(item.status).toBe('pending');
      expect(item.attempts).toBe(0);
      expect(item.payloadUri).toBeUndefined();
      expect(item.payloadExt).toBeUndefined();
      expect(item.metadata).toEqual({ sessionId: 's1', prompt: 'Hello', attachmentCount: 1 });

      // JSON payload should be persisted
      expect(storage.jsonPayloads.has(item.id)).toBe(true);
      const stored = await storage.loadJsonPayload(item.id);
      expect(stored).toEqual(payload);
    });

    it('rejects at queue cap', async () => {
      await queue.init();
      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        await queue.enqueue('text-message', null, null, { n: i });
      }

      const result = await queue.enqueueWithJsonPayload(
        'text-with-attachments',
        { prompt: 'overflow', attachments: [] },
        { sessionId: 's1', prompt: 'overflow', attachmentCount: 0 },
      );

      expect('accepted' in result && result.accepted === false).toBe(true);
      if ('reason' in result) {
        expect(result.reason).toBe('queue-full');
      }
    });

    it('tags item with bound auth identity', async () => {
      await queue.init();
      queue.bindAuthIdentity('https://cloud.example.com');

      const item = await queue.enqueueWithJsonPayload(
        'text-with-attachments',
        { prompt: 'test', attachments: [] },
        { sessionId: 's1', prompt: 'test', attachmentCount: 0 },
      );
      assertQueueItem(item);

      expect(item.boundCloudUrl).toBe('https://cloud.example.com');
    });

    it('drain passes null payloadUri for JSON-payload items', async () => {
      await queue.init();
      const getPayloadUriSpy = vi.spyOn(storage, 'getPayloadUri');

      await queue.enqueueWithJsonPayload(
        'text-with-attachments',
        { prompt: 'test', attachments: [] },
        { sessionId: 's1', prompt: 'test', attachmentCount: 0 },
      );
      await queue.drain(true);

      // Should not call getPayloadUri since item has no payloadUri/payloadExt
      expect(getPayloadUriSpy).not.toHaveBeenCalled();
      expect(consumer).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'text-with-attachments' }),
        null,
        expect.any(AbortSignal),
      );
    });

    it('removeItem deletes JSON payload', async () => {
      await queue.init();
      const deleteJsonSpy = vi.spyOn(storage, 'deleteJsonPayload');

      const item = await queue.enqueueWithJsonPayload(
        'text-with-attachments',
        { prompt: 'test', attachments: [] },
        { sessionId: 's1', prompt: 'test', attachmentCount: 0 },
      );
      assertQueueItem(item);

      await queue.removeItem(item.id);

      expect(deleteJsonSpy).toHaveBeenCalledWith(item.id);
      expect(storage.jsonPayloads.has(item.id)).toBe(false);
    });

    it('successful drain deletes JSON payload', async () => {
      await queue.init();
      const deleteJsonSpy = vi.spyOn(storage, 'deleteJsonPayload');

      const item = await queue.enqueueWithJsonPayload(
        'text-with-attachments',
        { prompt: 'test', attachments: [{ type: 'image', data: 'base64...' }] },
        { sessionId: 's1', prompt: 'test', attachmentCount: 1 },
      );
      assertQueueItem(item);

      await queue.drain(true);

      expect(deleteJsonSpy).toHaveBeenCalledWith(item.id);
      expect(storage.jsonPayloads.has(item.id)).toBe(false);
      expect(queue.getItems()).toHaveLength(0);
    });

    it('loadJsonPayload returns persisted data', async () => {
      await queue.init();
      const payload = { prompt: 'Hello', attachments: [{ type: 'doc', data: 'pdf-base64' }] };

      const item = await queue.enqueueWithJsonPayload(
        'text-with-attachments',
        payload,
        { sessionId: 's1', prompt: 'Hello', attachmentCount: 1 },
      );
      assertQueueItem(item);

      const loaded = await queue.loadJsonPayload(item.id);
      expect(loaded).toEqual(payload);
    });

    it('loadJsonPayload returns null for missing payload', async () => {
      await queue.init();
      const loaded = await queue.loadJsonPayload('nonexistent');
      expect(loaded).toBeNull();
    });

    it('rolls back on saveJsonPayload failure — no item appended, no orphan JSON', async () => {
      await queue.init();
      vi.spyOn(storage, 'saveJsonPayload').mockRejectedValueOnce(new Error('Disk full'));

      await expect(
        queue.enqueueWithJsonPayload(
          'text-with-attachments',
          { prompt: 'fail', attachments: [] },
          { sessionId: 's1', prompt: 'fail', attachmentCount: 0 },
        ),
      ).rejects.toThrow('Disk full');

      expect(queue.getItems()).toHaveLength(0);
      expect(storage.items).toHaveLength(0);
    });

    it('rolls back on saveSnapshot failure after JSON succeeds — removes item and JSON', async () => {
      await queue.init();
      const deleteJsonSpy = vi.spyOn(storage, 'deleteJsonPayload');
      vi.spyOn(storage, 'saveSnapshot').mockRejectedValueOnce(new Error('IO error'));

      await expect(
        queue.enqueueWithJsonPayload(
          'text-with-attachments',
          { prompt: 'rollback', attachments: [] },
          { sessionId: 's1', prompt: 'rollback', attachmentCount: 0 },
        ),
      ).rejects.toThrow('IO error');

      expect(queue.getItems()).toHaveLength(0);
      expect(deleteJsonSpy).toHaveBeenCalled();
    });

    it('orphan cleanup includes JSON payload IDs', async () => {
      // Pre-populate with an orphaned JSON payload (no matching queue item)
      storage.jsonPayloads.set('orphan-json-id', { prompt: 'orphan', attachments: [] });
      storage.items = [];

      const deletePayloadSpy = vi.spyOn(storage, 'deletePayload');

      queue = new OfflineQueue(storage, consumer);
      await queue.init();

      // Orphan cleanup should have been called for the orphaned JSON ID
      expect(deletePayloadSpy).toHaveBeenCalledWith('orphan-json-id');
    });
  });
});
