/**
 * Silent-Boot-Crash Auto-Recovery Regression Test
 *
 * Simulates the full Stage C lifecycle in-process:
 *   1. "Boot 1" — a healthy boot that reaches the success-marker grace
 *      expiry, writes a Last-Known-Good record + clears bootPending.
 *   2. "Boot 2" — a boot that records writeStart but never clears
 *      bootPending (the silent-crash mode from dev-37738d9).
 *   3. "Boot 3" — the pre-bootstrap watchdog runs, detects the stuck
 *      bootPending, reads the LKG record Boot 1 wrote, and triggers
 *      applyImageRollback with the correct target. The image-tag of the
 *      crashed Boot 2 lands in the quarantine store.
 *
 * This is the structural invariant the user asked us to defend: a future
 * bad cloud image cannot silently brick a customer's cloud, because the
 * NEXT boot will roll it back automatically.
 *
 * Stage C3 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
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
const FINGERPRINT = 'a'.repeat(64);

describe('Silent-boot-crash auto-recovery (Stages 0+B+C1+C2+C3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-crash-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rolls back from a silently-crashing image to the last-known-good image on the next boot', async () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });

    // ---- Boot 1: healthy boot of GOOD_IMAGE ----
    bootStateStore.writeStart(GOOD_IMAGE, 1_000);
    let pendingMarker: { fire(): void } | undefined;
    const handle1 = scheduleBootSuccessMarker({
      imageTag: GOOD_IMAGE,
      buildCommit: 'good-commit',
      schemaFingerprint: FINGERPRINT,
      lkgStore,
      bootStateStore,
      schedule: (cb) => {
        pendingMarker = { fire: cb };
        return { cancel(): void {} };
      },
      now: () => 2_000,
    });
    pendingMarker!.fire();
    handle1.cancel();

    expect(lkgStore.read()?.imageTag).toBe(GOOD_IMAGE);
    expect(bootStateStore.read()?.bootPending).toBe(false);

    // ---- Boot 2: silently-crashing boot of BAD_IMAGE ----
    // The success marker is scheduled but NEVER fires (process exits first).
    // Stores the writeStart record with bootPending=true on disk.
    bootStateStore.writeStart(BAD_IMAGE, 3_000);
    scheduleBootSuccessMarker({
      imageTag: BAD_IMAGE,
      buildCommit: 'bad-commit',
      schemaFingerprint: FINGERPRINT,
      lkgStore,
      bootStateStore,
      schedule: () => ({ cancel(): void {} }),
      now: () => 4_000,
    });
    // (the would-be crash happens here — we never .fire())

    expect(bootStateStore.read()?.bootPending).toBe(true);
    expect(bootStateStore.read()?.imageTag).toBe(BAD_IMAGE);
    // LKG record from Boot 1 must still be on disk for the watchdog to find.
    expect(lkgStore.read()?.imageTag).toBe(GOOD_IMAGE);

    // ---- Boot 3: watchdog detects the stuck bootPending and rolls back ----
    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: {
        FLY_API_TOKEN: 'fake-token',
        FLY_APP_NAME: 'rebel-cloud-test',
        FLY_MACHINE_ID: 'mach-1',
        FLY_IMAGE_REF: BAD_IMAGE,
      } as NodeJS.ProcessEnv,
      applyImageRollbackImpl: apply,
      now: () => 5_000,
    });

    expect(outcome).toEqual({ kind: 'recovered', targetImage: GOOD_IMAGE });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0][3]).toBe(GOOD_IMAGE);
    expect(apply.mock.calls[0][4]).toEqual({ writerTag: 'pre-bootstrap-watchdog' });

    // BAD_IMAGE should land in the quarantine list so the scheduler does not
    // immediately re-install it (Stage F's concern).
    const active = quarantineStore.readActive(5_000);
    expect(active.map((e) => e.imageTag)).toContain(BAD_IMAGE);
  });

  it('triple-crash on the same image hits the rollback cap and gives up', async () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    lkgStore.write({
      version: 1,
      imageTag: GOOD_IMAGE,
      buildCommit: 'good-commit',
      schemaFingerprint: FINGERPRINT,
      recordedAt: 1_000,
      previousLastKnownGood: null,
    });

    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });
    const env = {
      FLY_API_TOKEN: 'fake-token',
      FLY_APP_NAME: 'rebel-cloud-test',
      FLY_MACHINE_ID: 'mach-1',
      FLY_IMAGE_REF: BAD_IMAGE,
    } as NodeJS.ProcessEnv;

    // Boot 2: crashes (writeStart, no clear)
    bootStateStore.writeStart(BAD_IMAGE, 2_000);

    // Boot 3: watchdog fires, increments attempt to 2 → still under cap.
    const o2 = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env,
      applyImageRollbackImpl: apply,
    });
    expect(o2.kind).toBe('recovered');

    // Pretend Fly didn't honor the rollback (Boot 4: same bad image,
    // bootPending still true → attempt=3 → over cap).
    bootStateStore.writeStart(BAD_IMAGE, 3_000);
    const o3 = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env,
      applyImageRollbackImpl: apply,
    });
    expect(o3.kind).toBe('cap-exceeded');

    // applyImageRollback was called exactly once across the two attempts.
    expect(apply).toHaveBeenCalledOnce();
  });

  it('successful boot 4 (after rollback) resets attempt counter and does not trigger recovery', async () => {
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    lkgStore.write({
      version: 1,
      imageTag: GOOD_IMAGE,
      buildCommit: 'good-commit',
      schemaFingerprint: FINGERPRINT,
      recordedAt: 1_000,
      previousLastKnownGood: null,
    });

    // Boot 2: crashes
    bootStateStore.writeStart(BAD_IMAGE, 2_000);

    // Boot 3: watchdog detects + rolls back
    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });
    const o3 = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: {
        FLY_API_TOKEN: 'fake-token',
        FLY_APP_NAME: 'rebel-cloud-test',
        FLY_MACHINE_ID: 'mach-1',
        FLY_IMAGE_REF: BAD_IMAGE,
      } as NodeJS.ProcessEnv,
      applyImageRollbackImpl: apply,
    });
    expect(o3.kind).toBe('recovered');

    // Boot 4: Fly restarts with GOOD_IMAGE; watchdog sees different image, no recovery.
    const apply4 = vi.fn();
    const o4 = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: {
        FLY_API_TOKEN: 'fake-token',
        FLY_APP_NAME: 'rebel-cloud-test',
        FLY_MACHINE_ID: 'mach-1',
        FLY_IMAGE_REF: GOOD_IMAGE,
      } as NodeJS.ProcessEnv,
      applyImageRollbackImpl: apply4,
    });
    expect(o4).toEqual({ kind: 'no-recovery-needed', reason: 'different-image' });
    expect(apply4).not.toHaveBeenCalled();
    expect(bootStateStore.read()?.attempt).toBe(1);
  });
});
