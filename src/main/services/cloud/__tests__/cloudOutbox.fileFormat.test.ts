import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-file-format',
}));

import { CloudOutbox } from '../cloudOutbox';

const OUTBOX_PATH = path.join(
  '/tmp/test-cloud-outbox-file-format',
  'sessions',
  'cloud-outbox.json',
);

function readOutboxFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) as Record<string, unknown>;
}

function writeOutboxFile(payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
  fs.writeFileSync(OUTBOX_PATH, JSON.stringify(payload), 'utf8');
}

function populateAllStage4Fields(outbox: CloudOutbox, sessionId = 'session-a'): void {
  outbox.recordLastPushedSeq(sessionId, 42);
  outbox.recordLastPushedMetadataDigest(sessionId, 'metadata-digest-a');
  outbox.recordLastPushedMessageIds(sessionId, ['message-1', 'message-2']);
  outbox.incrementDeltaCount(sessionId);
  outbox.recordFullPut(sessionId, 1_700_000_000_000);
  outbox.incrementDeltaCount(sessionId);
  outbox.bumpEntryGeneration('entry-a');
  outbox.recordOversizedEvent(sessionId, 'turn-a:seq:42', 'content-hash-a', 5_100_000);
}

describe('CloudOutbox Stage 4 file format', () => {
  let outbox: CloudOutbox;

  beforeEach(() => {
    outbox = new CloudOutbox();
    try { fs.rmSync(path.dirname(OUTBOX_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    try { fs.rmSync(path.dirname(OUTBOX_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('defaults missing Stage 4 fields when loading a pre-Stage-4 file', () => {
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-a': {
        id: 'session-a:upsert:1',
        sessionId: 'session-a',
        op: 'upsert',
        enqueuedAt: 0,
        attempts: 0,
        nextRetryAt: 0,
        status: 'pending',
      },
    });

    outbox.load();

    expect(outbox.getLastPushedSeq('session-a')).toBeUndefined();
    expect(outbox.getLastPushedMetadataDigest('session-a')).toBeUndefined();
    expect(outbox.getLastPushedMessageIds('session-a')).toEqual([]);
    expect(outbox.getDeltaCount('session-a')).toBe(0);
    expect(outbox.getLastFullPutAt('session-a')).toBe(0);
    expect(outbox.getEntryGeneration('session-a:upsert:1')).toBe(0);
    expect(outbox.getOversizedEvents('session-a')).toEqual([]);
    expect(outbox.getAll()).toHaveLength(1);
  });

  it('persists all Stage 4 fields across save/load round trips', () => {
    outbox.onConnectionChanged('https://test.example.com');
    populateAllStage4Fields(outbox);
    outbox.flush();

    const raw = readOutboxFile();
    expect(raw._lastPushedSeqTracker).toEqual({ 'session-a': 42 });
    expect(raw._lastPushedMetadataDigest).toEqual({ 'session-a': 'metadata-digest-a' });
    expect(raw._lastPushedMessageIds).toEqual({ 'session-a': ['message-1', 'message-2'] });
    expect(raw._deltaCountSinceFullPut).toEqual({ 'session-a': 1 });
    expect(raw._lastFullPutAt).toEqual({ 'session-a': 1_700_000_000_000 });
    expect(raw._entryGeneration).toEqual({ 'entry-a': 1 });
    expect(raw._oversizedEventIds).toEqual({
      'session-a': [{ eventIdentity: 'turn-a:seq:42', contentHash: 'content-hash-a', gzipBytes: 5_100_000 }],
    });

    const fresh = new CloudOutbox();
    fresh.load();
    expect(fresh.getLastPushedSeq('session-a')).toBe(42);
    expect(fresh.getLastPushedMetadataDigest('session-a')).toBe('metadata-digest-a');
    expect(fresh.getLastPushedMessageIds('session-a')).toEqual(['message-1', 'message-2']);
    expect(fresh.getDeltaCount('session-a')).toBe(1);
    expect(fresh.getLastFullPutAt('session-a')).toBe(1_700_000_000_000);
    expect(fresh.getEntryGeneration('entry-a')).toBe(1);
    expect(fresh.getOversizedEvents('session-a')).toEqual([
      { eventIdentity: 'turn-a:seq:42', contentHash: 'content-hash-a', gzipBytes: 5_100_000 },
    ]);
    fresh._resetForTesting();
  });

  it('clearAll clears every Stage 4 field', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-a', 'upsert');
    const entryId = outbox.getAll()[0].id;
    populateAllStage4Fields(outbox);
    outbox.flush();

    outbox.clearAll();

    expect(readOutboxFile()).toEqual({ _cloudUrl: 'https://test.example.com' });
    expect(outbox.getLastPushedSeq('session-a')).toBeUndefined();
    expect(outbox.getLastPushedMetadataDigest('session-a')).toBeUndefined();
    expect(outbox.getLastPushedMessageIds('session-a')).toEqual([]);
    expect(outbox.getDeltaCount('session-a')).toBe(0);
    expect(outbox.getLastFullPutAt('session-a')).toBeUndefined();
    expect(outbox.getEntryGeneration(entryId)).toBe(0);
    expect(outbox.getOversizedEvents('session-a')).toEqual([]);
  });

  it('suppressTombstonedUpserts removes all per-session Stage 4 fields', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-a', 'upsert');
    const entryId = outbox.getAll()[0].id;
    populateAllStage4Fields(outbox, 'session-a');

    expect(outbox.suppressTombstonedUpserts((sessionId) => sessionId === 'session-a')).toEqual(['session-a']);

    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getLastPushedSeq('session-a')).toBeUndefined();
    expect(outbox.getLastPushedMetadataDigest('session-a')).toBeUndefined();
    expect(outbox.getLastPushedMessageIds('session-a')).toEqual([]);
    expect(outbox.getDeltaCount('session-a')).toBe(0);
    expect(outbox.getLastFullPutAt('session-a')).toBeUndefined();
    expect(outbox.getEntryGeneration(entryId)).toBe(0);
    expect(outbox.getOversizedEvents('session-a')).toEqual([]);
  });

  it('onConnectionChanged clears Stage 4 fields when the cloud URL changes', () => {
    outbox.onConnectionChanged('https://cloud-a.example.com');
    outbox.enqueue('session-a', 'upsert');
    populateAllStage4Fields(outbox, 'session-a');

    outbox.onConnectionChanged('https://cloud-b.example.com');

    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getLastPushedSeq('session-a')).toBeUndefined();
    expect(outbox.getLastPushedMetadataDigest('session-a')).toBeUndefined();
    expect(outbox.getLastPushedMessageIds('session-a')).toEqual([]);
    expect(outbox.getDeltaCount('session-a')).toBe(0);
    expect(outbox.getLastFullPutAt('session-a')).toBeUndefined();
    expect(outbox.getOversizedEvents('session-a')).toEqual([]);
  });

  it('persists Stage 4 format after loading and updating a pre-Stage-4 file', () => {
    writeOutboxFile({ _cloudUrl: 'https://test.example.com' });

    outbox.load();
    outbox.recordLastPushedSeq('session-a', 7);
    outbox.recordLastPushedMessageIds('session-a', ['message-a']);
    outbox.flush();

    expect(readOutboxFile()).toMatchObject({
      _cloudUrl: 'https://test.example.com',
      _lastPushedSeqTracker: { 'session-a': 7 },
      _lastPushedMessageIds: { 'session-a': ['message-a'] },
    });
  });

  it('loads Stage 4 files through a simulated pre-Stage-4 reader without requiring schema changes', () => {
    outbox.onConnectionChanged('https://test.example.com');
    populateAllStage4Fields(outbox, 'session-a');
    outbox.flush();

    const raw = readOutboxFile();
    const v1RecognizedEntries = Object.entries(raw)
      .filter(([key]) => !key.startsWith('_'))
      .map(([, value]) => value);

    expect(() => {
      for (const value of v1RecognizedEntries) {
        if (value && typeof value === 'object') {
          void (value as { sessionId?: unknown }).sessionId;
        }
      }
    }).not.toThrow();
  });

  it('increments entry generation on each enqueue mutation and persists it', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-a', 'upsert');
    const entryId = outbox.getAll()[0].id;
    expect(outbox.getEntryGeneration(entryId)).toBe(1);

    outbox.enqueue('session-a', 'upsert');
    expect(outbox.getEntryGeneration(entryId)).toBe(2);
    outbox.flush();

    const fresh = new CloudOutbox();
    fresh.load();
    expect(fresh.getEntryGeneration(entryId)).toBe(2);
    fresh._resetForTesting();
  });

  it('keeps entry generations distinct across entry ids', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-a', 'upsert');
    outbox.enqueue('session-b', 'upsert');
    const [entryA, entryB] = outbox.getAll();

    outbox.enqueue('session-a', 'upsert');

    expect(outbox.getEntryGeneration(entryA.id)).toBe(2);
    expect(outbox.getEntryGeneration(entryB.id)).toBe(1);
  });

  it('drops the replaced entry generation when a new op replaces an entry', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-a', 'upsert');
    const replacedEntryId = outbox.getAll()[0].id;

    outbox.enqueue('session-a', 'delete');
    const replacementEntryId = outbox.getAll()[0].id;

    expect(replacementEntryId).not.toBe(replacedEntryId);
    expect(outbox.getEntryGeneration(replacedEntryId)).toBe(0);
    expect(outbox.getEntryGeneration(replacementEntryId)).toBe(1);
  });

  it('markSucceeded leaves a newer generation entry in the queue', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-a', 'upsert');
    const entryId = outbox.getAll()[0].id;
    const staleGeneration = outbox.getEntryGeneration(entryId);
    outbox.enqueue('session-a', 'upsert');
    const currentGeneration = outbox.getEntryGeneration(entryId);

    outbox.markSucceeded('session-a', staleGeneration);
    expect(outbox.getAll()).toHaveLength(1);
    expect(outbox.getEntryGeneration(entryId)).toBe(currentGeneration);

    outbox.markSucceeded('session-a', currentGeneration);
    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getEntryGeneration(entryId)).toBe(0);
  });

  it('keeps oversized event ids separate from the drain queue', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.recordOversizedEvent('session-a', 'turn-a:seq:42', 'content-hash-a', 5_100_000);
    outbox.flush();

    expect(outbox.getDueEntries()).toEqual([]);
    expect(outbox.getAll()).toEqual([]);
    expect(readOutboxFile()).toMatchObject({
      _oversizedEventIds: {
        'session-a': [{ eventIdentity: 'turn-a:seq:42', contentHash: 'content-hash-a', gzipBytes: 5_100_000 }],
      },
    });
  });

  it('clears oversized event ids when content changes or the event disappears', () => {
    outbox.recordOversizedEvent('session-a', 'turn-a:seq:42', 'content-hash-a', 5_100_000);
    outbox.recordOversizedEvent('session-a', 'turn-a:seq:43', 'content-hash-b', 5_200_000);
    outbox.recordOversizedEvent('session-a', 'turn-a:seq:44', 'content-hash-c', 5_300_000);

    outbox.clearOversizedEventsByContentChange('session-a', [
      { identity: 'turn-a:seq:42', contentHash: 'content-hash-a' },
      { identity: 'turn-a:seq:43', contentHash: 'content-hash-changed' },
    ]);

    expect(outbox.getOversizedEvents('session-a')).toEqual([
      { eventIdentity: 'turn-a:seq:42', contentHash: 'content-hash-a', gzipBytes: 5_100_000 },
    ]);
  });

  it('recordFullPut resets the delta counter and records the full-PUT timestamp', () => {
    outbox.incrementDeltaCount('session-a');
    outbox.incrementDeltaCount('session-a');
    expect(outbox.getDeltaCount('session-a')).toBe(2);

    outbox.recordFullPut('session-a', 1_700_000_000_000);

    expect(outbox.getDeltaCount('session-a')).toBe(0);
    expect(outbox.getLastFullPutAt('session-a')).toBe(1_700_000_000_000);
  });
});
