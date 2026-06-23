import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTierById } from '../vmTierCatalog';

const mockFlyFetch = vi.fn();
const mockUpdateMachineConfig = vi.fn();
const mockPollCloudHealth = vi.fn();

 
vi.mock('../../flyApiClient', () => ({
  flyFetch: (...args: unknown[]) => mockFlyFetch(...args),
  updateMachineConfig: (...args: unknown[]) => mockUpdateMachineConfig(...args),
}));

 
vi.mock('../../cloudUpdateService', () => ({
  pollCloudHealth: (...args: unknown[]) => mockPollCloudHealth(...args),
}));

import { changeVmTier, getCurrentVmTier } from '../vmTierService';

const FLY_TOKEN = 'fly-token-test';
const APP_NAME = 'rebel-cloud-test';
const MACHINE_ID = 'machine-123';
const CLOUD_URL = 'https://rebel-cloud-test.fly.dev';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('vmTierService', () => {
  beforeEach(() => {
    mockFlyFetch.mockReset();
    mockUpdateMachineConfig.mockReset();
    mockPollCloudHealth.mockReset();
  });

  it('changeVmTier happy path updates config and polls health', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } },
      }))
      // Post-poll verify fetch (added by Phase 6 fix)
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } },
      }));
    mockUpdateMachineConfig.mockResolvedValue({ success: true });
    mockPollCloudHealth.mockResolvedValue({ healthy: true });

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    expect(mockUpdateMachineConfig).toHaveBeenCalledOnce();
    const patcher = mockUpdateMachineConfig.mock.calls[0][3] as (config: Record<string, unknown>) => Record<string, unknown>;
    expect(patcher({ keep: 'value' })).toEqual({
      keep: 'value',
      guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 },
    });
    expect(mockPollCloudHealth).toHaveBeenCalledWith(CLOUD_URL, 120000);
    expect(result).toMatchObject({
      success: true,
      updated: true,
      applied: true,
      healthVerified: true,
      machineStateBefore: 'started',
    });
  });

  it('changeVmTier is idempotent when machine is already at target tier', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch.mockResolvedValueOnce(jsonResponse({
      state: 'started',
      config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } },
    }));

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    expect(result).toEqual({ success: true, updated: false, machineStateBefore: 'started' });
    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    expect(mockPollCloudHealth).not.toHaveBeenCalled();
  });

  it('changeVmTier starts machine when post-update state is not started', async () => {
    const heavyTier = getTierById('heavy-work');
    if (!heavyTier) throw new Error('Expected heavy-work tier to exist');

    mockFlyFetch
      .mockResolvedValueOnce(jsonResponse({
        state: 'stopped',
        config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        state: 'stopped',
        config: { guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 } },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      // Post-poll verify fetch (added by Phase 6 fix)
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 } },
      }));
    mockUpdateMachineConfig.mockResolvedValue({ success: true });
    mockPollCloudHealth.mockResolvedValue({ healthy: true });

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: heavyTier,
    });

    expect(mockFlyFetch).toHaveBeenNthCalledWith(
      3,
      FLY_TOKEN,
      `/v1/apps/${APP_NAME}/machines/${MACHINE_ID}/start`,
      { method: 'POST' },
    );
    expect(result).toMatchObject({
      success: true,
      updated: true,
      machineStateBefore: 'stopped',
      startedMachine: true,
    });
  });

  it('changeVmTier returns failure when health poll fails', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } },
      }));
    mockUpdateMachineConfig.mockResolvedValue({ success: true });
    mockPollCloudHealth.mockResolvedValue({ healthy: false, error: 'Timed out waiting for cloud health check.' });

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    // Phase 6 fix: post-update health-poll failure should report `applied: true`
    // so the UI can tell users the cloud is changing but couldn't be verified,
    // rather than misleadingly saying nothing happened.
    expect(result.success).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.healthVerified).toBe(false);
    expect(result.error).toContain('Timed out');
  });

  it('changeVmTier holds a per-machine lock — concurrent calls are rejected', async () => {
    const fasterTier = getTierById('faster');
    const heavyTier = getTierById('heavy-work');
    if (!fasterTier || !heavyTier) throw new Error('Expected tiers to exist');

    let firstResolve: (value: Response) => void = () => undefined;
    const firstFetchPromise = new Promise<Response>((resolve) => {
      firstResolve = resolve;
    });

    mockFlyFetch.mockImplementationOnce(() => firstFetchPromise);

    const firstCall = changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    // Yield a microtask so the first call enters the inFlight set before the second.
    await Promise.resolve();

    const secondCall = changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: heavyTier,
    });

    const secondResult = await secondCall;
    expect(secondResult.success).toBe(false);
    expect(secondResult.updated).toBe(false);
    expect(secondResult.error).toContain('already in progress');

    // Resolve the first call so we don't leak a hanging promise. Idempotent
    // path so it returns without further fetches.
    firstResolve(jsonResponse({
      state: 'started',
      config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } },
    }));
    const firstResult = await firstCall;
    expect(firstResult.success).toBe(true);
    expect(firstResult.updated).toBe(false);
  });

  it('changeVmTier post-poll guest mismatch returns failure with applied:true', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } },
      }))
      // Post-poll verify finds mismatched guest (someone else raced)
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 } },
      }));
    mockUpdateMachineConfig.mockResolvedValue({ success: true });
    mockPollCloudHealth.mockResolvedValue({ healthy: true });

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    expect(result.success).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.healthVerified).toBe(true);
    expect(result.error).toContain('did not match');
  });

  it('changeVmTier fails-closed when post-poll verify fetch errors', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } },
      }))
      .mockResolvedValueOnce(new Response('upstream timeout', { status: 504 }));
    mockUpdateMachineConfig.mockResolvedValue({ success: true });
    mockPollCloudHealth.mockResolvedValue({ healthy: true });

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    expect(result.success).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.healthVerified).toBe(true);
    expect(result.error).toContain('verification fetch failed');
    expect(result.error).toContain('504');
  });

  it('changeVmTier fails-closed when post-poll verify returns unparseable guest', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        state: 'started',
        config: {},
      }));
    mockUpdateMachineConfig.mockResolvedValue({ success: true });
    mockPollCloudHealth.mockResolvedValue({ healthy: true });

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    expect(result.success).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.healthVerified).toBe(true);
    expect(result.error).toContain('could not be parsed');
  });

  it('changeVmTier fails-closed (no write) when current guest is unparseable', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch.mockResolvedValueOnce(jsonResponse({
      state: 'started',
      config: {},
    }));

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    expect(result.success).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.error).toContain('current size');
    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    expect(mockPollCloudHealth).not.toHaveBeenCalled();
  });

  it('changeVmTier maps Fly version-conflict error to a friendly cloud-update message', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch.mockResolvedValueOnce(jsonResponse({
      state: 'started',
      config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
    }));
    mockUpdateMachineConfig.mockResolvedValue({ success: false, error: 'Version conflict — machine was updated by another process' });

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    expect(result).toMatchObject({
      success: false,
      updated: false,
      applied: false,
      machineStateBefore: 'started',
    });
    expect(result.error).toBe('Cloud may be updating right now — try again in a minute.');
    expect(mockPollCloudHealth).not.toHaveBeenCalled();
    expect(mockFlyFetch).toHaveBeenCalledTimes(1);
  });

  it('changeVmTier passes through non-conflict update errors verbatim', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    mockFlyFetch.mockResolvedValueOnce(jsonResponse({
      state: 'started',
      config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
    }));
    mockUpdateMachineConfig.mockResolvedValue({ success: false, error: 'Machine config update failed: HTTP 500 internal error' });

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });

  it('changeVmTier honours getActiveTurnCount and refuses when a turn started after the handler check', async () => {
    const fasterTier = getTierById('faster');
    if (!fasterTier) throw new Error('Expected faster tier to exist');

    const result = await changeVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
      cloudUrl: CLOUD_URL,
      tier: fasterTier,
      // Simulates a turn having started between the IPC handler's check and
      // the moment the lock was acquired here.
      getActiveTurnCount: () => 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('conversation is active');
    expect(mockFlyFetch).not.toHaveBeenCalled();
    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
  });

  it('getCurrentVmTier maps machine guest config to known tier', async () => {
    mockFlyFetch.mockResolvedValueOnce(jsonResponse({
      state: 'started',
      config: { guest: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 } },
    }));

    const result = await getCurrentVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
    });

    expect(result.success).toBe(true);
    expect(result.tier?.id).toBe('standard');
    expect(result.raw).toEqual({ cpuKind: 'shared', cpus: 4, memoryMb: 4096 });
  });

  it('getCurrentVmTier returns best-fit tier for an upgraded off-grid machine', async () => {
    mockFlyFetch.mockResolvedValueOnce(jsonResponse({
      state: 'started',
      config: { guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 8192 } },
    }));

    const result = await getCurrentVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
    });

    expect(result.success).toBe(true);
    expect(result.tier?.id).toBe('faster');
    expect(result.raw).toEqual({ cpuKind: 'performance', cpus: 2, memoryMb: 8192 });
  });

  it('getCurrentVmTier returns undefined tier for a below-standard guest config', async () => {
    mockFlyFetch.mockResolvedValueOnce(jsonResponse({
      state: 'started',
      config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 } },
    }));

    const result = await getCurrentVmTier({
      flyApiToken: FLY_TOKEN,
      flyAppName: APP_NAME,
      flyMachineId: MACHINE_ID,
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBeUndefined();
    expect(result.raw).toEqual({ cpuKind: 'shared', cpus: 1, memoryMb: 256 });
  });
});
