import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_BACKOFF_MS,
  computeBackoff,
  OfflineQueue,
} from '../offlineQueue/OfflineQueue';
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

describe('OfflineQueue extended edge cases', () => {
  let storage: InMemoryStorage;
  let consumer: ReturnType<typeof vi.fn<QueueConsumer>>;
  let transitions: QueueTransitionEvent[];

  beforeEach(() => {
    storage = new InMemoryStorage();
    transitions = [];
    consumer = vi.fn<QueueConsumer>().mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-anchors nextRetryAt when clock jumps backward by >1 hour', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    storage.items = [{
      id: 'backward-jump-item',
      type: 'text-message',
      status: 'pending',
      enqueuedAt: now + 2 * 3600_000,
      attempts: 3,
      nextRetryAt: now + 3 * 3600_000,
      isPermanentFailure: false,
      metadata: {},
    }];

    const queue = new OfflineQueue(storage, consumer, {
      onTransition: (event) => transitions.push(event),
    });
    await queue.init();
    await queue.drain(true);

    const item = queue.getItems()[0];
    const expectedRetryAt = now + computeBackoff(3);
    expect(item.nextRetryAt).toBe(expectedRetryAt);
    expect(item.nextRetryAt - now).toBeGreaterThanOrEqual(BASE_BACKOFF_MS);
    expect(consumer).not.toHaveBeenCalled();

    const guardEvent = transitions.find((event) => event.message === 'clock-jump-guard');
    expect(guardEvent).toBeDefined();
    expect((guardEvent?.data as Record<string, unknown>).itemId).toBe('backward-jump-item');
  });

  it('snaps far-future nextRetryAt to now when clock has jumped forward by >1 hour', async () => {
    let now = 1_700_100_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    storage.items = [{
      id: 'forward-jump-item',
      type: 'text-message',
      status: 'pending',
      enqueuedAt: now - 2 * 3600_000,
      attempts: 2,
      nextRetryAt: now + 2 * 3600_000,
      isPermanentFailure: false,
      metadata: {},
    }];

    const queue = new OfflineQueue(storage, consumer, {
      onTransition: (event) => transitions.push(event),
    });
    await queue.init();
    await queue.drain(true);

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(queue.getItems()).toHaveLength(0);

    const guardEvent = transitions.find((event) => event.message === 'clock-jump-guard');
    expect(guardEvent).toBeDefined();
    expect((guardEvent?.data as Record<string, unknown>).itemId).toBe('forward-jump-item');
  });

  it('logs enriched stuck-drain warning and emits stuck-drain transition after 3+ network failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const queue = new OfflineQueue(storage, consumer, {
      onTransition: (event) => transitions.push(event),
    });
    await queue.init();
    queue.bindAuthIdentity('https://cloud.example.com');

    consumer.mockResolvedValue({
      success: false,
      error: 'network timeout',
      errorCategory: 'network',
    });

    await queue.enqueue('text-message', null, null, { label: 'n1' });
    await queue.enqueue('text-message', null, null, { label: 'n2' });
    await queue.enqueue('text-message', null, null, { label: 'n3' });

    await queue.drain(true);

    expect(queue.limitedConnectivityAt).not.toBeNull();
    const warningLines = warnSpy.mock.calls.map((args) => String(args[0]));
    const stuckDrainLine = warningLines.find((line) => line.includes('Stuck-drain detected: consecutive network errors'));
    expect(stuckDrainLine).toBeDefined();
    expect(stuckDrainLine).toContain('"boundCloudUrl":"https://cloud.example.com"');
    expect(stuckDrainLine).toContain('"pendingCount":3');

    const stuckDrainTransition = transitions.find((event) => event.message === 'stuck-drain');
    expect(stuckDrainTransition).toBeDefined();
    expect((stuckDrainTransition?.data as Record<string, unknown>).pendingCount).toBe(3);
  });

  it('skips cross-identity items and logs mismatch warning once per drain cycle', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const queue = new OfflineQueue(storage, consumer, {
      onTransition: (event) => transitions.push(event),
    });
    await queue.init();
    queue.bindAuthIdentity('https://cloud-a.example.com');
    await queue.enqueue('text-message', null, null, { label: 'a-1' });
    await queue.enqueue('text-message', null, null, { label: 'a-2' });

    queue.bindAuthIdentity('https://cloud-b.example.com');
    warnSpy.mockClear();

    await queue.drain(true);
    expect(consumer).not.toHaveBeenCalled();
    expect(queue.getItems()).toHaveLength(2);

    const firstCycleWarnings = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('Skipping items bound to a different identity during drain'));
    expect(firstCycleWarnings).toHaveLength(1);
    expect(firstCycleWarnings[0]).toContain('"itemCount":2');

    warnSpy.mockClear();
    await queue.drain(true);
    const secondCycleWarnings = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('Skipping items bound to a different identity during drain'));
    expect(secondCycleWarnings).toHaveLength(1);

    const identityMismatchTransitions = transitions.filter((event) => event.message === 'identity-mismatch');
    expect(identityMismatchTransitions.length).toBeGreaterThanOrEqual(2);
    expect((identityMismatchTransitions[0].data as Record<string, unknown>).itemCount).toBe(2);
  });

  it('emits item-permanent-failure transition when sweeping stale processing items', async () => {
    const now = 1_700_500_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const queue = new OfflineQueue(storage, consumer, {
      onTransition: (event) => transitions.push(event),
    });
    await queue.init();

    const enqueued = await queue.enqueue('text-message', null, null, { label: 'stale-item' });
    if ('accepted' in enqueued) {
      throw new Error('Expected enqueue to be accepted in test');
    }

    const staleItem = queue.getItems().find((item) => item.id === enqueued.id);
    if (!staleItem) {
      throw new Error('Expected enqueued item to exist');
    }

    staleItem.status = 'processing';
    staleItem.enqueuedAt = now - 49 * 3600_000;

    await queue.drain(true);

    const permanentFailureEvent = transitions.find(
      (event) =>
        event.message === 'item-permanent-failure' &&
        (event.data as Record<string, unknown>).itemId === enqueued.id,
    );

    expect(permanentFailureEvent).toBeDefined();
    expect((permanentFailureEvent?.data as Record<string, unknown>).errorCategory).toBe('timeout');
    expect(consumer).not.toHaveBeenCalled();

    const sweptItem = queue.getItems().find((item) => item.id === enqueued.id);
    expect(sweptItem?.isPermanentFailure).toBe(true);
    expect(sweptItem?.status).toBe('pending');
  });
});
