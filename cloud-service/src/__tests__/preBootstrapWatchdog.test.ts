import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runPreBootstrapWatchdog,
  MAX_ROLLBACK_ATTEMPTS,
  type WatchdogEvent,
  type WatchdogOutcome,
} from '../preBootstrapWatchdog';
import {
  createBootStateStore,
  type BootStateStore,
} from '../services/bootStateStore';
import {
  createLastKnownGoodImageTagStore,
  LKG_RECORD_VERSION,
  type LkgRecord,
} from '../services/lastKnownGoodImageTagStore';
import { createQuarantinedTagsStore } from '../services/quarantinedTagsStore';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const CURRENT_IMAGE = 'ghcr.io/mindstone/rebel-cloud:dev-bad';
const LKG_IMAGE = 'ghcr.io/mindstone/rebel-cloud:dev-good';

const FLY_ENV = {
  FLY_API_TOKEN: 'fake-token',
  FLY_APP_NAME: 'rebel-cloud-test',
  FLY_MACHINE_ID: 'mach-1',
  FLY_IMAGE_REF: CURRENT_IMAGE,
} as NodeJS.ProcessEnv;

function makeLkg(imageTag: string = LKG_IMAGE): LkgRecord {
  return {
    version: LKG_RECORD_VERSION,
    imageTag,
    buildCommit: 'good-commit',
    schemaFingerprint: 'a'.repeat(64),
    recordedAt: 1_700_000_000_000,
    previousLastKnownGood: null,
  };
}

function captureLog(): { events: WatchdogEvent[]; log: (e: WatchdogEvent) => void } {
  const events: WatchdogEvent[] = [];
  return { events, log: (e) => events.push(e) };
}

describe('runPreBootstrapWatchdog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('skips when FLY_IMAGE_REF is missing', async () => {
    const { events, log } = captureLog();
    const apply = vi.fn();
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: { ...FLY_ENV, FLY_IMAGE_REF: undefined as unknown as string },
      applyImageRollbackImpl: apply,
      log,
    });
    expect(outcome).toEqual({ kind: 'skipped-no-fly-env' });
    expect(apply).not.toHaveBeenCalled();
    expect(events[0]?.kind).toBe('skipped-no-fly-env');
  });

  it('returns no-recovery-needed when boot-state is absent (fresh machine)', async () => {
    const { events, log } = captureLog();
    const apply = vi.fn();
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      log,
    });
    expect(outcome).toEqual({ kind: 'no-recovery-needed', reason: 'no-prior-state' });
    expect(apply).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'no-prior-boot-state')).toBe(true);

    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    expect(bootStateStore.read()?.bootPending).toBe(true);
    expect(bootStateStore.read()?.imageTag).toBe(CURRENT_IMAGE);
  });

  it('returns no-recovery-needed when prior boot was clean', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    bootStateStore.clearBootPending(CURRENT_IMAGE, 200);

    const { events, log } = captureLog();
    const apply = vi.fn();
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      log,
    });
    expect(outcome).toEqual({ kind: 'no-recovery-needed', reason: 'prior-clean' });
    expect(apply).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'prior-boot-clean')).toBe(true);
  });

  it('returns no-recovery-needed when prior boot crashed on a DIFFERENT image', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart('ghcr.io/mindstone/rebel-cloud:dev-other', 100);

    const { events, log } = captureLog();
    const apply = vi.fn();
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      log,
    });
    expect(outcome).toEqual({ kind: 'no-recovery-needed', reason: 'different-image' });
    expect(apply).not.toHaveBeenCalled();
    expect(bootStateStore.read()?.attempt).toBe(1);
  });

  it('triggers recovery when prior boot crashed on the same image (attempt=1)', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const { events, log } = captureLog();
    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });

    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      log,
    });

    expect(outcome).toEqual({ kind: 'recovered', targetImage: LKG_IMAGE });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0][3]).toBe(LKG_IMAGE);
    expect(apply.mock.calls[0][4]).toEqual({ writerTag: 'pre-bootstrap-watchdog' });
    expect(events.some((e) => e.kind === 'attempting-rollback')).toBe(true);
    expect(events.some((e) => e.kind === 'quarantine-added')).toBe(true);
  });

  it('writes a quarantine entry for the current image after a successful rollback', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });

    await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      now: () => 1_800_000_000_000,
    });

    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });
    const active = quarantineStore.readActive(1_800_000_000_000);
    expect(active).toHaveLength(1);
    expect(active[0].imageTag).toBe(CURRENT_IMAGE);
  });

  it('returns cap-exceeded when attempt count exceeds MAX_ROLLBACK_ATTEMPTS', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    // Simulate MAX prior crashes on the same image
    for (let i = 0; i < MAX_ROLLBACK_ATTEMPTS; i++) {
      bootStateStore.writeStart(CURRENT_IMAGE, 100 + i);
    }
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const { events, log } = captureLog();
    const apply = vi.fn();
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      log,
    });

    expect(outcome).toEqual({ kind: 'cap-exceeded' });
    expect(apply).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'cap-exceeded')).toBe(true);
  });

  it('returns skipped-no-fly-env when FLY_API_TOKEN is missing (but FLY_IMAGE_REF present)', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const apply = vi.fn();
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: { ...FLY_ENV, FLY_API_TOKEN: undefined as unknown as string },
      applyImageRollbackImpl: apply,
    });
    expect(outcome).toEqual({ kind: 'skipped-no-fly-env' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns skipped-no-lkg when neither LKG record nor fallback exists', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);

    const apply = vi.fn();
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
    });
    expect(outcome).toEqual({ kind: 'skipped-no-lkg' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('reads the baked fallback LKG when no main record exists', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const fallbackPath = path.join(tmpDir, 'default-lkg.json');
    fs.writeFileSync(
      fallbackPath,
      JSON.stringify({
        ...makeLkg(),
        isBootstrapFallback: true,
      }),
    );

    const { events, log } = captureLog();
    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });

    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      fallbackLkgPath: fallbackPath,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      log,
    });

    expect(outcome).toEqual({ kind: 'recovered', targetImage: LKG_IMAGE });
    expect(events.some((e) => e.kind === 'using-fallback-lkg')).toBe(true);
  });

  it('skips anti-self-rollback when LKG image == current image', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg(CURRENT_IMAGE));

    const { events, log } = captureLog();
    const apply = vi.fn();
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      log,
    });

    expect(outcome).toEqual({ kind: 'skipped-anti-self-rollback' });
    expect(apply).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'anti-self-rollback')).toBe(true);
  });

  it('emits schema-fingerprint-mismatch warning but still rolls back', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const { events, log } = captureLog();
    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      bakedSchemaFingerprint: 'b'.repeat(64),
      log,
    });

    expect(outcome.kind).toBe('recovered');
    expect(apply).toHaveBeenCalledOnce();
    const mismatch = events.find((e) => e.kind === 'schema-fingerprint-mismatch');
    expect(mismatch).toBeDefined();
  });

  it('returns rollback-failed when applyImageRollback returns fly-error', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const apply = vi.fn().mockResolvedValue({ outcome: 'fly-error', error: 'HTTP 500' });
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
    });

    expect(outcome).toEqual({ kind: 'rollback-failed', outcome: 'fly-error', error: 'HTTP 500' });
    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });
    expect(quarantineStore.readActive(Date.now())).toHaveLength(0);
  });

  it('returns rollback-failed when applyImageRollback returns image-invalid (Fly cannot pull)', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const apply = vi.fn().mockResolvedValue({ outcome: 'image-invalid', error: 'not found' });
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
    });

    expect(outcome.kind).toBe('rollback-failed');
    if (outcome.kind === 'rollback-failed') {
      expect(outcome.outcome).toBe('image-invalid');
    }
  });

  it('catches synchronous throws from applyImageRollback and returns fly-error', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const apply = vi.fn().mockRejectedValue(new Error('network down'));
    const outcome: WatchdogOutcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
    });

    expect(outcome.kind).toBe('rollback-failed');
    if (outcome.kind === 'rollback-failed') {
      expect(outcome.outcome).toBe('fly-error');
      expect(outcome.error).toContain('network down');
    }
  });

  it('still returns recovered when quarantine write fails (best-effort)', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const failingQuarantineStore = {
      readActive: () => [],
      addRejected: () => {
        throw new Error('disk full');
      },
      clear: () => {},
      filePath: () => path.join(tmpDir, 'q.json'),
    };

    const { events, log } = captureLog();
    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
      quarantineStoreImpl: failingQuarantineStore,
      log,
    });

    expect(outcome.kind).toBe('recovered');
    const failedEvent = events.find((e) => e.kind === 'quarantine-add-failed');
    expect(failedEvent).toBeDefined();
  });

  it('treats no-op-same-image from applyImageRollback as rollback-failed (defensive)', async () => {
    const bootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const apply = vi.fn().mockResolvedValue({ outcome: 'no-op-same-image' });
    const outcome = await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
    });

    expect(outcome.kind).toBe('rollback-failed');
    if (outcome.kind === 'rollback-failed') {
      expect(outcome.outcome).toBe('no-op-same-image');
    }
  });

  it('writeStart increments attempt counter on a repeated crash of the same image', async () => {
    const bootStateStore: BootStateStore = createBootStateStore({ dataPath: tmpDir });
    bootStateStore.writeStart(CURRENT_IMAGE, 100);
    const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    lkgStore.write(makeLkg());

    const apply = vi.fn().mockResolvedValue({ outcome: 'rolled-back' });
    await runPreBootstrapWatchdog({
      dataDir: tmpDir,
      env: FLY_ENV,
      applyImageRollbackImpl: apply,
    });

    expect(bootStateStore.read()?.attempt).toBe(2);
  });
});
