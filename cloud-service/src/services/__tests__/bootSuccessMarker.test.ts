import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scheduleBootSuccessMarker,
  DEFAULT_BOOT_GRACE_MS,
  type BootSuccessMarkerEvent,
} from '../bootSuccessMarker';
import {
  createLastKnownGoodImageTagStore,
  LKG_RECORD_VERSION,
  type LkgRecord,
} from '../lastKnownGoodImageTagStore';
import { createBootStateStore } from '../bootStateStore';

const FIXED_FINGERPRINT = 'a'.repeat(64);
const PRIOR_FINGERPRINT = 'b'.repeat(64);

function createFakeSchedule() {
  let pending: { cb: () => void; ms: number; cancelled: boolean } | null = null;
  const schedule = (cb: () => void, ms: number) => {
    pending = { cb, ms, cancelled: false };
    return {
      cancel(): void {
        if (pending) pending.cancelled = true;
      },
    };
  };
  return {
    schedule,
    fire(): void {
      if (!pending) throw new Error('No pending schedule to fire');
      if (pending.cancelled) return;
      pending.cb();
    },
    get pendingMs(): number | undefined {
      return pending?.ms;
    },
    get cancelled(): boolean {
      return pending?.cancelled === true;
    },
  };
}

describe('scheduleBootSuccessMarker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-marker-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('schedules using the configured graceMs and writes LKG after firing', () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const fakeSchedule = createFakeSchedule();
    const events: BootSuccessMarkerEvent[] = [];

    scheduleBootSuccessMarker({
      imageTag: 'ghcr.io/mindstone/rebel-cloud:dev-1234567',
      buildCommit: 'dev-1234567',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore,
      bootStateStore,
      graceMs: 30_000,
      schedule: fakeSchedule.schedule,
      now: () => 1_700_000_000_000,
      log: (event) => events.push(event),
    });

    expect(fakeSchedule.pendingMs).toBe(30_000);
    expect(events[0]).toEqual({
      kind: 'scheduled',
      graceMs: 30_000,
      imageTag: 'ghcr.io/mindstone/rebel-cloud:dev-1234567',
    });

    fakeSchedule.fire();

    const record = lkgStore.read();
    expect(record).not.toBeNull();
    expect(record!.imageTag).toBe('ghcr.io/mindstone/rebel-cloud:dev-1234567');
    expect(record!.schemaFingerprint).toBe(FIXED_FINGERPRINT);
    expect(record!.recordedAt).toBe(1_700_000_000_000);
    expect(record!.previousLastKnownGood).toBeNull();
    expect(events[events.length - 1]).toEqual({
      kind: 'marker-written',
      imageTag: 'ghcr.io/mindstone/rebel-cloud:dev-1234567',
    });
  });

  it('uses DEFAULT_BOOT_GRACE_MS when graceMs is unset', () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const fakeSchedule = createFakeSchedule();

    scheduleBootSuccessMarker({
      imageTag: 'img:tag',
      buildCommit: 'abc',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore,
      bootStateStore,
      schedule: fakeSchedule.schedule,
    });

    expect(fakeSchedule.pendingMs).toBe(DEFAULT_BOOT_GRACE_MS);
  });

  it('clamps negative graceMs to 0', () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const fakeSchedule = createFakeSchedule();

    scheduleBootSuccessMarker({
      imageTag: 'img:tag',
      buildCommit: 'abc',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore,
      bootStateStore,
      graceMs: -1,
      schedule: fakeSchedule.schedule,
    });

    expect(fakeSchedule.pendingMs).toBe(0);
  });

  it('cancel() stops the pending marker; cancel after fire is a no-op', () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const fakeSchedule = createFakeSchedule();
    const events: BootSuccessMarkerEvent[] = [];

    const handle = scheduleBootSuccessMarker({
      imageTag: 'img:tag',
      buildCommit: 'abc',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore,
      bootStateStore,
      graceMs: 30_000,
      schedule: fakeSchedule.schedule,
      log: (event) => events.push(event),
    });

    handle.cancel();
    expect(fakeSchedule.cancelled).toBe(true);
    expect(events.some((e) => e.kind === 'cancelled')).toBe(true);

    fakeSchedule.fire();
    expect(lkgStore.read()).toBeNull();

    handle.cancel();
    expect(events.filter((e) => e.kind === 'cancelled')).toHaveLength(1);
  });

  it('runNow() executes synchronously, cancels the timer, and writes the marker', () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const fakeSchedule = createFakeSchedule();

    const handle = scheduleBootSuccessMarker({
      imageTag: 'img:tag',
      buildCommit: 'abc',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore,
      bootStateStore,
      schedule: fakeSchedule.schedule,
      now: () => 42,
    });

    handle.runNow();
    expect(fakeSchedule.cancelled).toBe(true);
    expect(lkgStore.read()?.recordedAt).toBe(42);

    handle.runNow();
    expect(lkgStore.read()?.recordedAt).toBe(42);
  });

  it('rotates the prior LKG into previousLastKnownGood when imageTag differs', () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const priorRecord: LkgRecord = {
      version: LKG_RECORD_VERSION,
      imageTag: 'img:old',
      buildCommit: 'old-commit',
      schemaFingerprint: PRIOR_FINGERPRINT,
      recordedAt: 1_600_000_000_000,
      previousLastKnownGood: null,
    };
    lkgStore.write(priorRecord);
    const fakeSchedule = createFakeSchedule();

    scheduleBootSuccessMarker({
      imageTag: 'img:new',
      buildCommit: 'new-commit',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore,
      bootStateStore,
      schedule: fakeSchedule.schedule,
      now: () => 1_700_000_000_000,
    });
    fakeSchedule.fire();

    const record = lkgStore.read();
    expect(record?.imageTag).toBe('img:new');
    expect(record?.previousLastKnownGood).toEqual({
      imageTag: 'img:old',
      schemaFingerprint: PRIOR_FINGERPRINT,
      recordedAt: 1_600_000_000_000,
    });
  });

  it('preserves the existing previousLastKnownGood when re-stamping the same imageTag', () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const priorPrevious = {
      imageTag: 'img:older',
      schemaFingerprint: PRIOR_FINGERPRINT,
      recordedAt: 1_500_000_000_000,
    };
    lkgStore.write({
      version: LKG_RECORD_VERSION,
      imageTag: 'img:current',
      buildCommit: 'current',
      schemaFingerprint: FIXED_FINGERPRINT,
      recordedAt: 1_600_000_000_000,
      previousLastKnownGood: priorPrevious,
    });
    const fakeSchedule = createFakeSchedule();

    scheduleBootSuccessMarker({
      imageTag: 'img:current',
      buildCommit: 'current',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore,
      bootStateStore,
      schedule: fakeSchedule.schedule,
      now: () => 1_700_000_000_000,
    });
    fakeSchedule.fire();

    const record = lkgStore.read();
    expect(record?.previousLastKnownGood).toEqual(priorPrevious);
  });

  it('clears boot-pending in the bootStateStore after firing', () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart('img:tag', 100);
    expect(bootStateStore.read()?.bootPending).toBe(true);
    const fakeSchedule = createFakeSchedule();

    scheduleBootSuccessMarker({
      imageTag: 'img:tag',
      buildCommit: 'abc',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore,
      bootStateStore,
      schedule: fakeSchedule.schedule,
      now: () => 200,
    });
    fakeSchedule.fire();

    const state = bootStateStore.read();
    expect(state?.bootPending).toBe(false);
    expect(state?.attempt).toBe(0);
    expect(state?.lastCleanAt).toBe(200);
  });

  it('reports marker-failed when the LKG write throws, without crashing', () => {
    const failingLkgStore = {
      read: () => null,
      write: () => {
        throw new Error('disk full');
      },
      clear: () => {},
      filePath: () => path.join(tmpDir, 'lkg.json'),
    };
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const fakeSchedule = createFakeSchedule();
    const events: BootSuccessMarkerEvent[] = [];

    scheduleBootSuccessMarker({
      imageTag: 'img:tag',
      buildCommit: 'abc',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore: failingLkgStore,
      bootStateStore,
      schedule: fakeSchedule.schedule,
      log: (event) => events.push(event),
    });
    fakeSchedule.fire();

    const failed = events.find((e) => e.kind === 'marker-failed');
    expect(failed).toBeDefined();
    expect(failed && 'error' in failed && failed.error).toContain('disk full');
  });

  it('does NOT clear boot-pending if the LKG write threw', () => {
    const failingLkgStore = {
      read: () => null,
      write: () => {
        throw new Error('disk full');
      },
      clear: () => {},
      filePath: () => path.join(tmpDir, 'lkg.json'),
    };
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart('img:tag', 100);
    const fakeSchedule = createFakeSchedule();

    scheduleBootSuccessMarker({
      imageTag: 'img:tag',
      buildCommit: 'abc',
      schemaFingerprint: FIXED_FINGERPRINT,
      lkgStore: failingLkgStore,
      bootStateStore,
      schedule: fakeSchedule.schedule,
    });
    fakeSchedule.fire();

    expect(bootStateStore.read()?.bootPending).toBe(true);
  });
});
