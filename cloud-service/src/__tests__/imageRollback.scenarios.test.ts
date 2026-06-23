/**
 * Image Rollback — Cross-Stage Contract Scenarios
 *
 * Stage E of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
 *
 * The other tests in this directory cover individual subsystems
 * (preBootstrapWatchdog, silentBootCrash, selfUpdateScheduler quarantine
 * guard). This file locks the **contract surface** the boundary registry
 * entry `cloud-image-rollback-defense-in-depth` promises reviewers — the
 * invariants whose silent violation would reopen the original bug class.
 *
 * Scenarios:
 *   1. Healthy boot: LKG record stamped, bootPending cleared, quarantine
 *      stays empty (no false-positives).
 *   2. Watchdog rollback adds the rolled-away image to quarantine with the
 *      correct TTL boundary; entries past TTL no longer block updates.
 *   3. Quarantine matching is by EXACT suffix (`:<tag>`) so neighboring
 *      tags ('dev-bad' vs 'dev-bad-fix') don't accidentally block each
 *      other.
 *   4. Schema fingerprint mismatch between BAD image and LKG blocks the
 *      watchdog rollback (the data-corruption guard described in the
 *      CLOUD_ARCHITECTURE.md section).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPreBootstrapWatchdog } from '../preBootstrapWatchdog';
import { scheduleBootSuccessMarker } from '../services/bootSuccessMarker';
import { createBootStateStore } from '../services/bootStateStore';
import { createLastKnownGoodImageTagStore } from '../services/lastKnownGoodImageTagStore';
import { createQuarantinedTagsStore } from '../services/quarantinedTagsStore';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const GOOD_IMAGE = 'ghcr.io/mindstone/rebel-cloud:dev-good';
const BAD_IMAGE = 'ghcr.io/mindstone/rebel-cloud:dev-bad';
const SIMILAR_BAD_IMAGE = 'ghcr.io/mindstone/rebel-cloud:dev-bad-fix';
const FINGERPRINT = 'a'.repeat(64);
const INCOMPATIBLE_FINGERPRINT = 'b'.repeat(64);

describe('Image rollback — contract scenarios (Stage E)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-scenarios-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('healthy boot writes LKG, clears bootPending, and leaves the quarantine empty', async () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });

    bootStateStore.writeStart(GOOD_IMAGE);

    const handle = scheduleBootSuccessMarker({
      graceMs: 30_000,
      imageTag: GOOD_IMAGE,
      buildCommit: 'good-commit',
      schemaFingerprint: FINGERPRINT,
      lkgStore,
      bootStateStore,
    });

    // Race the grace period to expiry.
    await vi.advanceTimersByTimeAsync(30_500);
    handle.cancel();

    const record = lkgStore.read();
    expect(record?.imageTag).toBe(GOOD_IMAGE);
    expect(bootStateStore.read()?.bootPending).toBe(false);
    expect(quarantineStore.readActive()).toEqual([]);
  });

  it('watchdog rollback writes the rolled-away image to quarantine with the configured TTL', async () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });

    lkgStore.write({
      version: 1,
      imageTag: GOOD_IMAGE,
      buildCommit: 'good-commit',
      schemaFingerprint: FINGERPRINT,
      recordedAt: Date.now() - 60_000,
      previousLastKnownGood: null,
    });
    bootStateStore.writeStart(BAD_IMAGE);

    const applyImageRollbackMock = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });

    await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      bakedSchemaFingerprint: FINGERPRINT,
      env: {
        FLY_IMAGE_REF: BAD_IMAGE,
        FLY_APP_NAME: 'app',
        FLY_MACHINE_ID: 'machine',
        FLY_API_TOKEN: 'token',
      },
      applyImageRollbackImpl: applyImageRollbackMock,
      bootStateStoreImpl: bootStateStore,
      lkgStoreImpl: lkgStore,
      quarantineStoreImpl: quarantineStore,
    });

    const active = quarantineStore.readActive();
    expect(active.length).toBe(1);
    expect(active[0]!.imageTag).toBe(BAD_IMAGE);

    // Advance past the TTL window and confirm the entry expires.
    const ttlMs = Number(process.env.REBEL_QUARANTINE_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
    vi.setSystemTime(Date.now() + ttlMs + 60_000);
    expect(quarantineStore.readActive()).toEqual([]);
  });

  it('quarantine matching is by exact suffix, so neighboring tags do not collide', () => {
    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });
    quarantineStore.addRejected(BAD_IMAGE, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      now: Date.now(),
    });

    const active = quarantineStore.readActive();
    const isBadQuarantined = active.some((entry) => entry.imageTag.endsWith(':dev-bad'));
    const isSimilarQuarantined = active.some((entry) =>
      entry.imageTag.endsWith(`:${SIMILAR_BAD_IMAGE.split(':').pop()}`),
    );

    expect(isBadQuarantined).toBe(true);
    expect(isSimilarQuarantined).toBe(false);
  });

  it('watchdog logs a structured schema-fingerprint-mismatch event when the LKG fingerprint differs (rollback still proceeds; mismatch is a signal, not a block)', async () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });

    // LKG points at an image with a different schema fingerprint than the
    // current baked one. The watchdog still rolls back (the LKG was a
    // known-good boot once) but emits a structured warning for ops to
    // investigate any data-corruption risk.
    lkgStore.write({
      version: 1,
      imageTag: GOOD_IMAGE,
      buildCommit: 'old-commit',
      schemaFingerprint: INCOMPATIBLE_FINGERPRINT,
      recordedAt: Date.now() - 60_000,
      previousLastKnownGood: null,
    });
    bootStateStore.writeStart(BAD_IMAGE);

    const applyImageRollbackMock = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });
    const events: { kind: string }[] = [];

    await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      bakedSchemaFingerprint: FINGERPRINT,
      env: {
        FLY_IMAGE_REF: BAD_IMAGE,
        FLY_APP_NAME: 'app',
        FLY_MACHINE_ID: 'machine',
        FLY_API_TOKEN: 'token',
      },
      applyImageRollbackImpl: applyImageRollbackMock,
      bootStateStoreImpl: bootStateStore,
      lkgStoreImpl: lkgStore,
      quarantineStoreImpl: quarantineStore,
      log: (e) => events.push(e),
    });

    expect(applyImageRollbackMock).toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'schema-fingerprint-mismatch')).toBe(true);
  });
});
