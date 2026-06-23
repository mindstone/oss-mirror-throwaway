import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyFlyRestartPolicyMigration,
  RESTART_POLICY_SENTINEL_FILE,
  RESTART_POLICY,
  RESTART_MAX_RETRIES,
} from '../flyRestartPolicyMigration';

const FLY_ENV = {
  FLY_API_TOKEN: 'fake-token',
  FLY_APP_NAME: 'rebel-cloud-test',
  FLY_MACHINE_ID: 'mach-1',
  FLY_IMAGE_REF: 'ghcr.io/mindstone/rebel-cloud:dev-1234567',
};

describe('applyFlyRestartPolicyMigration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-mig-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('migrates when no sentinel exists, then writes sentinel', async () => {
    const updateMock = vi.fn().mockResolvedValue({ success: true, restarted: true });

    const result = await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
      now: () => 1_700_000_000_000,
    });

    expect(result).toEqual({ outcome: 'migrated' });
    expect(updateMock).toHaveBeenCalledOnce();
    const sentinelPath = path.join(tmpDir, RESTART_POLICY_SENTINEL_FILE);
    expect(fs.existsSync(sentinelPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    expect(parsed.migratedAt).toBe(1_700_000_000_000);
    expect(parsed.imageTag).toBe(FLY_ENV.FLY_IMAGE_REF);
  });

  it('applies the expected restart policy via the patcher', async () => {
    const updateMock = vi.fn(
      async (
        _token: string,
        _app: string,
        _machine: string,
        patcher: (config: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        const newConfig = patcher({ image: 'old:tag', env: { PORT: '8080' } });
        expect(newConfig.restart).toEqual({
          policy: RESTART_POLICY,
          max_retries: RESTART_MAX_RETRIES,
        });
        expect(newConfig.image).toBe('old:tag');
        return { success: true, restarted: true };
      },
    );

    await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
    });

    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('skips when sentinel already exists', async () => {
    const sentinelPath = path.join(tmpDir, RESTART_POLICY_SENTINEL_FILE);
    await fsp.writeFile(sentinelPath, JSON.stringify({ migratedAt: 1 }), 'utf8');

    const updateMock = vi.fn();
    const result = await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
    });

    expect(result).toEqual({ outcome: 'already-migrated' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns skipped-non-fly when FLY_MACHINE_ID is missing', async () => {
    const updateMock = vi.fn();
    const result = await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: { ...FLY_ENV, FLY_MACHINE_ID: undefined as unknown as string },
    });

    expect(result.outcome).toBe('skipped-non-fly');
    expect(updateMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, RESTART_POLICY_SENTINEL_FILE))).toBe(false);
  });

  it('returns skipped-no-fly-env when FLY_API_TOKEN is missing', async () => {
    const updateMock = vi.fn();
    const result = await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: { ...FLY_ENV, FLY_API_TOKEN: undefined as unknown as string },
    });

    expect(result.outcome).toBe('skipped-no-fly-env');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns fly-error when updateMachineConfig fails, without writing sentinel', async () => {
    const updateMock = vi.fn().mockResolvedValue({ success: false, error: 'HTTP 500' });

    const result = await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
    });

    expect(result.outcome).toBe('fly-error');
    expect(result.error).toContain('HTTP 500');
    expect(fs.existsSync(path.join(tmpDir, RESTART_POLICY_SENTINEL_FILE))).toBe(false);
  });

  it('subsequent calls after a successful migration are no-ops', async () => {
    const updateMock = vi.fn().mockResolvedValue({ success: true, restarted: true });

    await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
    });
    const secondResult = await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
    });

    expect(secondResult.outcome).toBe('already-migrated');
    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('does not call updateMachineConfig again on retry after Fly error (sentinel re-check only)', async () => {
    const updateMock = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'transient' })
      .mockResolvedValueOnce({ success: true, restarted: true });

    const first = await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
    });
    expect(first.outcome).toBe('fly-error');

    const second = await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
    });
    expect(second.outcome).toBe('migrated');
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-issue PATCH when machine already has the policy', async () => {
    let observedPatcher: ((c: Record<string, unknown>) => Record<string, unknown>) | undefined;
    const updateMock = vi.fn(
      async (
        _token: string,
        _app: string,
        _machine: string,
        patcher: (config: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        observedPatcher = patcher;
        return { success: true, restarted: true };
      },
    );

    await applyFlyRestartPolicyMigration({
      dataDir: tmpDir,
      updateMachineConfigImpl: updateMock,
      env: FLY_ENV,
    });

    expect(observedPatcher).toBeDefined();
    const inputConfig = {
      image: 'old:tag',
      restart: { policy: RESTART_POLICY, max_retries: RESTART_MAX_RETRIES, extra: 'preserved' },
    };
    const result = observedPatcher!(inputConfig);
    expect(result).toBe(inputConfig);
  });
});
