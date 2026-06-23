import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope } from '@sentry/core';
import type { Envelope } from '@sentry/core';
import { createCloudSentryOfflineStore } from '../sentryOfflineStore';

/**
 * Stage 5 (docs/plans/260621_monitoring-capture-surface) — the cloud service
 * had no Sentry offline transport, so events were dropped permanently whenever
 * the instance couldn't reach Sentry. This pins the disk-backed store's
 * round-trip + FIFO + boundedness contract.
 */
const makeEnvelope = (tag: string): Envelope =>
  createEnvelope<Envelope>({ event_id: tag, sent_at: new Date().toISOString() }, []);

const eventIdOf = (env: Envelope | undefined): string | undefined =>
  (env?.[0] as { event_id?: string } | undefined)?.event_id;

describe('createCloudSentryOfflineStore', () => {
  let tmpDir: string;
  const prevDataPath = process.env.REBEL_USER_DATA;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-offline-store-'));
    process.env.REBEL_USER_DATA = tmpDir;
  });

  afterEach(() => {
    if (prevDataPath === undefined) {
      delete process.env.REBEL_USER_DATA;
    } else {
      process.env.REBEL_USER_DATA = prevDataPath;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('round-trips an envelope through push → shift', async () => {
    const store = createCloudSentryOfflineStore();
    await store.push(makeEnvelope('evt-1'));
    const popped = await store.shift();
    expect(eventIdOf(popped)).toBe('evt-1');
    // Queue is now empty.
    expect(await store.shift()).toBeUndefined();
  });

  it('preserves FIFO order across multiple pushes', async () => {
    const store = createCloudSentryOfflineStore();
    await store.push(makeEnvelope('a'));
    await store.push(makeEnvelope('b'));
    await store.push(makeEnvelope('c'));
    expect(eventIdOf(await store.shift())).toBe('a');
    expect(eventIdOf(await store.shift())).toBe('b');
    expect(eventIdOf(await store.shift())).toBe('c');
  });

  it('unshift re-queues at the FRONT (retry-failed envelope replayed first)', async () => {
    const store = createCloudSentryOfflineStore();
    await store.push(makeEnvelope('queued'));
    await store.unshift(makeEnvelope('retry-me'));
    expect(eventIdOf(await store.shift())).toBe('retry-me');
    expect(eventIdOf(await store.shift())).toBe('queued');
  });

  it('survives a poison (unparseable) entry without wedging the queue', async () => {
    const store = createCloudSentryOfflineStore();
    await store.push(makeEnvelope('good'));
    // Drop a corrupt file that sorts BEFORE the good one.
    const dir = path.join(tmpDir, 'sentry-offline');
    fs.writeFileSync(path.join(dir, '000000000000000-000000.envelope'), 'not-a-valid-envelope');
    // First shift hits the poison entry → undefined, but removes it.
    const first = await store.shift();
    expect(first).toBeUndefined();
    // The good envelope is still retrievable on the next shift.
    expect(eventIdOf(await store.shift())).toBe('good');
  });

  it('does not throw when the store directory cannot be read for shift', async () => {
    const store = createCloudSentryOfflineStore();
    // Empty store → undefined, no throw.
    await expect(store.shift()).resolves.toBeUndefined();
  });

  it('unshift at the count cap preserves the requeued envelope, evicting the NEWEST (F1 regression)', async () => {
    // The offline transport caps at MAX_QUEUED_ENVELOPES (200). Fill the queue,
    // then unshift a retry envelope: the just-requeued item must survive and be
    // the next shift() result; the eviction must come off the BACK (newest), not
    // delete the front item we just wrote.
    const store = createCloudSentryOfflineStore();
    for (let i = 0; i < 200; i++) {
      await store.push(makeEnvelope(`fill-${i}`));
    }
    await store.unshift(makeEnvelope('retry-me'));

    // Still within cap.
    const dir = path.join(tmpDir, 'sentry-offline');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.envelope')).length).toBe(200);
    // The requeued envelope is the FRONT — it survived the overflow eviction.
    expect(eventIdOf(await store.shift())).toBe('retry-me');
  });
});
