import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { StoreFactory } from '@core/storeFactory';
import { hashTeamId } from '@shared/utils/teamIdHash';
import {
  CLAIMED_IN_PROGRESS_TTL_MS,
  createSlackPendingInboundLog,
  MAX_LOG_AGE_MS,
  MAX_LOG_ENTRIES,
  PENDING_INBOUND_DEFERRED_TTL_MS,
  PROCESSED_TOMBSTONE_TTL_MS,
} from '../slackPendingInboundLog';
import type { Logger } from '@core/logger';
import type { PendingInboundEntry, PendingInboundLog } from '../slackPendingInboundLog';

describe('slackPendingInboundLog', () => {
  let tempDir: string;
  let storeFactory: StoreFactory;

  function expectAcquired(result: ReturnType<PendingInboundLog['claimEventProcessing']>): asserts result is Extract<ReturnType<PendingInboundLog['claimEventProcessing']>, { acquired: true }> {
    expect(result.acquired).toBe(true);
  }
  let now: number;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-pending-inbound-'));
    now = Date.parse('2026-05-23T00:00:00.000Z');
    storeFactory = ((opts) => ({
      path: path.join(tempDir, `${opts.name}.json`),
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined,
      clear: () => undefined,
      store: {},
    })) as StoreFactory;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('enqueue, markProcessed, and drain round-trip', () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{"ok":true}', receivedAt: 1 });
    expect(log.drainUnprocessed()).toHaveLength(1);
    log.markProcessed('E1');
    expect(log.drainUnprocessed()).toEqual([]);
  });

  it('replays unprocessed entries after restart', () => {
    createSlackPendingInboundLog({ storeFactory, now: () => now }).enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{"ok":true}', receivedAt: 1 });
    const restarted = createSlackPendingInboundLog({ storeFactory, now: () => now });
    expect(restarted.drainUnprocessed()).toEqual([expect.objectContaining({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{"ok":true}', receivedAt: 1, state: 'pending' })]);
  });

  it('markProcessed after restart prevents redrain', () => {
    createSlackPendingInboundLog({ storeFactory, now: () => now }).enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{"ok":true}', receivedAt: 1 });
    createSlackPendingInboundLog({ storeFactory, now: () => now }).markProcessed('E1');
    expect(createSlackPendingInboundLog({ storeFactory, now: () => now }).drainUnprocessed()).toEqual([]);
  });

  it('concurrent enqueue calls preserve both entries', async () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    await Promise.all([
      Promise.resolve().then(() => log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash-1', rawBody: '{"one":true}', receivedAt: 1 })),
      Promise.resolve().then(() => log.enqueue({ eventId: 'E2', teamId: 'T1', payloadHash: 'hash-2', rawBody: '{"two":true}', receivedAt: 2 })),
    ]);

    expect(log.drainUnprocessed().map((entry) => entry.eventId).sort()).toEqual(['E1', 'E2']);
  });

  it('claimEventProcessing creates a claimed-in-progress entry when none exists', () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });

    const claim = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });

    expectAcquired(claim);
    expect(claim.ownerToken).toEqual(expect.any(String));
    expect(log.drainUnprocessed()).toEqual([expect.objectContaining({
      eventId: 'E1',
      teamId: 'T1',
      state: 'claimed-in-progress',
      ownerToken: claim.ownerToken,
      claimedAt: now,
    })]);
  });

  it('claimEventProcessing takes over pending and broadcast-deferred entries', () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });
    const first = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });
    expectAcquired(first);
    log.markBroadcastDeferred({ teamId: 'T1', eventId: 'E1', ownerToken: first.ownerToken });

    now += 1;
    const resumed = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });

    expect(resumed).toMatchObject({ acquired: true, priorState: 'deferred' });
    expectAcquired(resumed);
    expect(resumed.ownerToken).not.toBe(first.ownerToken);
  });

  it('claimEventProcessing skips fresh claimed-in-progress and processed entries', () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });
    const first = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });
    expectAcquired(first);

    expect(log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' })).toEqual({ acquired: false, priorState: 'in-progress' });

    log.releaseAfterSuccess({ teamId: 'T1', eventId: 'E1', ownerToken: first.ownerToken });
    expect(log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' })).toEqual({ acquired: false, priorState: 'processed' });
  });

  it('claimEventProcessing recovers stale claimed-in-progress entries after the TTL', () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });
    const first = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });
    expectAcquired(first);
    now += CLAIMED_IN_PROGRESS_TTL_MS + 1;

    const second = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });

    expect(second.acquired).toBe(true);
    expectAcquired(second);
    expect(second.ownerToken).not.toBe(first.ownerToken);
  });

  it('releaseAfterSuccess is idempotent and preserves a 24h processed tombstone', () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });
    const claim = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });
    expectAcquired(claim);

    log.releaseAfterSuccess({ teamId: 'T1', eventId: 'E1', ownerToken: claim.ownerToken });
    log.releaseAfterSuccess({ teamId: 'T1', eventId: 'E1', ownerToken: claim.ownerToken });

    expect(log.drainUnprocessed()).toEqual([]);
    const persisted = JSON.parse(fs.readFileSync(path.join(tempDir, 'slack/pendingInbound.json'), 'utf8')) as { entries: PendingInboundEntry[] };
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({ eventId: 'E1', state: 'processed', ownerToken: null, claimedAt: null });
  });

  it('markBroadcastDeferred then tryResumeClaim is replay-resumable', () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });
    const claim = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });
    expectAcquired(claim);
    log.markBroadcastDeferred({ teamId: 'T1', eventId: 'E1', ownerToken: claim.ownerToken });

    const resumed = log.tryResumeClaim({ teamId: 'T1', eventId: 'E1' });

    expect(resumed).toMatchObject({ acquired: true, priorState: 'deferred' });
    expectAcquired(resumed);
    expect(log.drainUnprocessed()[0]).toMatchObject({ state: 'claimed-in-progress', ownerToken: resumed.ownerToken });
  });

  it('concurrent same-event claim attempts allow exactly one owner', async () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });

    const results = await Promise.all([
      Promise.resolve().then(() => log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' })),
      Promise.resolve().then(() => log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' })),
    ]);

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.filter((result) => !result.acquired)).toEqual([{ acquired: false, priorState: 'in-progress' }]);
  });

  it('corrupt JSON read returns empty and emits a structured error log', () => {
    const errors: unknown[] = [];
    const logger = {
      error: (...args: unknown[]) => errors.push(args),
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    fs.mkdirSync(path.join(tempDir, 'slack'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'slack/pendingInbound.json'), '{not-json', 'utf8');

    expect(createSlackPendingInboundLog({ storeFactory, log: logger, now: () => now }).drainUnprocessed()).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toContain('Slack pending inbound log is unreadable');
    expect(JSON.stringify(errors[0])).toContain('filePath');
  });

  it('drops oversized payloads', () => {
    const warns: unknown[] = [];
    const logger = {
      error: () => undefined,
      warn: (...args: unknown[]) => warns.push(args),
      info: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    const log = createSlackPendingInboundLog({ storeFactory, log: logger, maxRawBodyBytes: 4, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: 'too-large', receivedAt: 1 });
    expect(log.drainUnprocessed()).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toEqual([
      expect.objectContaining({
        eventId: 'E1',
        teamIdHash: hashTeamId('T1'),
      }),
      'Dropping oversized Slack pending inbound entry',
    ]);
    expect(JSON.stringify(warns[0])).not.toContain('"teamId":"T1"');
  });

  it('markProcessed prunes processed entries older than 24 hours', () => {
    const storePath = path.join(tempDir, 'slack/pendingInbound.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const now = Date.now();
    const oldEntries: PendingInboundEntry[] = Array.from({ length: 100 }, (_, index) => ({
      eventId: `old-${index}`,
      teamId: 'T1',
      payloadHash: `old-hash-${index}`,
      rawBody: '{}',
      receivedAt: now - MAX_LOG_AGE_MS - 10_000 - index,
      state: 'processed',
      ownerToken: null,
      claimedAt: null,
      processedAt: now - PROCESSED_TOMBSTONE_TTL_MS - 5_000 - index,
    }));
    fs.writeFileSync(storePath, JSON.stringify({ entries: [
      ...oldEntries,
      { eventId: 'fresh', teamId: 'T1', payloadHash: 'fresh-hash', rawBody: '{}', receivedAt: now, state: 'pending', ownerToken: null, claimedAt: null },
    ] }), 'utf8');

    createSlackPendingInboundLog({ storeFactory, now: () => now }).markProcessed('fresh');

    const retained = createSlackPendingInboundLog({ storeFactory }).drainUnprocessed();
    expect(retained).toEqual([]);
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { entries: PendingInboundEntry[] };
    expect(persisted.entries.map((entry) => entry.eventId)).toEqual(['fresh']);
    expect(persisted.entries[0].processedAt).toBeGreaterThanOrEqual(now);
  });

  function createCapturingLogger(): { logger: Logger; warns: unknown[][]; errors: unknown[][] } {
    const warns: unknown[][] = [];
    const errors: unknown[][] = [];
    const logger = {
      error: (...args: unknown[]) => { errors.push(args); },
      warn: (...args: unknown[]) => { warns.push(args); },
      info: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    return { logger, warns, errors };
  }

  it('drainUnprocessed drops past-TTL pending entries and emits slack_replay_skipped_expired', () => {
    const { logger, warns } = createCapturingLogger();
    const log = createSlackPendingInboundLog({ storeFactory, log: logger, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });

    now += PENDING_INBOUND_DEFERRED_TTL_MS + 1;
    expect(log.drainUnprocessed()).toEqual([]);
    const matchingWarn = warns.find((entry) => {
      const payload = entry[0] as { event?: string };
      return payload.event === 'slack_replay_skipped_expired';
    });
    expect(matchingWarn).toBeDefined();
    expect(matchingWarn?.[0]).toMatchObject({
      event: 'slack_replay_skipped_expired',
      eventId: 'E1',
      teamIdHash: hashTeamId('T1'),
      state: 'pending',
      ttlMs: PENDING_INBOUND_DEFERRED_TTL_MS,
    });
    expect((matchingWarn?.[0] as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(PENDING_INBOUND_DEFERRED_TTL_MS);
    expect(JSON.stringify(matchingWarn)).not.toContain('"teamId":"T1"');
  });

  it('drainUnprocessed drops past-TTL broadcast-deferred entries with the right state', () => {
    const { logger, warns } = createCapturingLogger();
    const log = createSlackPendingInboundLog({ storeFactory, log: logger, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });
    const claim = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });
    expectAcquired(claim);
    log.markBroadcastDeferred({ teamId: 'T1', eventId: 'E1', ownerToken: claim.ownerToken });

    now += PENDING_INBOUND_DEFERRED_TTL_MS + 1;
    expect(log.drainUnprocessed()).toEqual([]);
    const matchingWarn = warns.find((entry) => {
      const payload = entry[0] as { event?: string };
      return payload.event === 'slack_replay_skipped_expired';
    });
    expect(matchingWarn?.[0]).toMatchObject({
      event: 'slack_replay_skipped_expired',
      state: 'broadcast-deferred',
      ttlMs: PENDING_INBOUND_DEFERRED_TTL_MS,
    });
  });

  it('claimed-in-progress entries become reclaimable after CLAIMED_IN_PROGRESS_TTL_MS but the entry stays in the log until the deferred TTL expires', () => {
    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    log.enqueue({ eventId: 'E1', teamId: 'T1', payloadHash: 'hash', rawBody: '{}', receivedAt: now });
    const claim = log.claimEventProcessing({ teamId: 'T1', eventId: 'E1' });
    expectAcquired(claim);

    now += CLAIMED_IN_PROGRESS_TTL_MS + 1;
    expect(log.drainUnprocessed()).toHaveLength(1);

    now += PENDING_INBOUND_DEFERRED_TTL_MS;
    expect(log.drainUnprocessed()).toEqual([]);
  });

  it('legacy entries without expiresAt fall back to receivedAt + PENDING_INBOUND_DEFERRED_TTL_MS', () => {
    const storePath = path.join(tempDir, 'slack/pendingInbound.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const legacyEntry: PendingInboundEntry = {
      eventId: 'E-legacy',
      teamId: 'T1',
      payloadHash: 'hash',
      rawBody: '{}',
      receivedAt: now,
      state: 'pending',
      ownerToken: null,
      claimedAt: null,
    };
    fs.writeFileSync(storePath, JSON.stringify({ entries: [legacyEntry] }), 'utf8');

    const log = createSlackPendingInboundLog({ storeFactory, now: () => now });
    expect(log.drainUnprocessed().map((entry) => entry.eventId)).toEqual(['E-legacy']);

    now += PENDING_INBOUND_DEFERRED_TTL_MS + 1;
    expect(log.drainUnprocessed()).toEqual([]);
  });

  it('writePruned emits pending_inbound_expired with structured fields', () => {
    const storePath = path.join(tempDir, 'slack/pendingInbound.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const stale: PendingInboundEntry = {
      eventId: 'E-stale',
      teamId: 'T1',
      payloadHash: 'hash',
      rawBody: '{}',
      receivedAt: now,
      state: 'pending',
      ownerToken: null,
      claimedAt: null,
      expiresAt: now + 1,
    };
    fs.writeFileSync(storePath, JSON.stringify({ entries: [stale] }), 'utf8');

    const { logger, warns } = createCapturingLogger();
    now += 5;
    const log = createSlackPendingInboundLog({ storeFactory, log: logger, now: () => now });
    log.enqueue({ eventId: 'E-fresh', teamId: 'T1', payloadHash: 'hash2', rawBody: '{}', receivedAt: now });

    const matchingWarn = warns.find((entry) => {
      const payload = entry[0] as { event?: string };
      return payload.event === 'pending_inbound_expired';
    });
    expect(matchingWarn?.[0]).toMatchObject({
      event: 'pending_inbound_expired',
      eventId: 'E-stale',
      teamIdHash: hashTeamId('T1'),
      state: 'pending',
      ttlMs: PENDING_INBOUND_DEFERRED_TTL_MS,
    });
  });

  it('SLACK_PENDING_INBOUND_DEFERRED_TTL_MS env override is honored', async () => {
    const previousCanonical = process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
    const previousLegacy = process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
    process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS = '5000';
    delete process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
    try {
      vi.resetModules();
      const mod = await import('../slackPendingInboundLog');
      expect(mod.PENDING_INBOUND_DEFERRED_TTL_MS).toBe(5000);
    } finally {
      if (previousCanonical === undefined) {
        delete process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
      } else {
        process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS = previousCanonical;
      }
      if (previousLegacy === undefined) {
        delete process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
      } else {
        process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS = previousLegacy;
      }
      vi.resetModules();
    }
  });

  it('legacy REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS env override is still accepted', async () => {
    const previousCanonical = process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
    const previousLegacy = process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
    delete process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
    process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS = '7000';
    try {
      vi.resetModules();
      const mod = await import('../slackPendingInboundLog');
      expect(mod.PENDING_INBOUND_DEFERRED_TTL_MS).toBe(7000);
    } finally {
      if (previousCanonical === undefined) {
        delete process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
      } else {
        process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS = previousCanonical;
      }
      if (previousLegacy === undefined) {
        delete process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
      } else {
        process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS = previousLegacy;
      }
      vi.resetModules();
    }
  });

  it('markProcessed caps the persisted log at MAX_LOG_ENTRIES newest entries', () => {
    const storePath = path.join(tempDir, 'slack/pendingInbound.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const now = Date.now();
    const entries: PendingInboundEntry[] = Array.from({ length: 11_000 }, (_, index) => ({
      eventId: `entry-${index}`,
      teamId: 'T1',
      payloadHash: `hash-${index}`,
      rawBody: '{}',
      receivedAt: now - (11_000 - index),
      state: 'processed',
      ownerToken: null,
      claimedAt: null,
      processedAt: now - (11_000 - index),
    }));
    entries.push({ eventId: 'fresh', teamId: 'T1', payloadHash: 'fresh-hash', rawBody: '{}', receivedAt: now, state: 'pending', ownerToken: null, claimedAt: null });
    fs.writeFileSync(storePath, JSON.stringify({ entries }), 'utf8');

    createSlackPendingInboundLog({ storeFactory, now: () => now }).markProcessed('fresh');

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { entries: PendingInboundEntry[] };
    expect(persisted.entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(persisted.entries[0].eventId).toBe('entry-1001');
    expect(persisted.entries.at(-1)?.eventId).toBe('fresh');
  });
});
