import { createScopedLogger } from '@core/logger';
import { flyFetch, updateMachineConfig } from '../flyApiClient';
import { pollCloudHealth } from '../cloudUpdateService';
import { getTierFromGuest, toFlyGuestConfig, type VmTier } from './vmTierCatalog';
import { acquireFlyOperationLock } from './flyOperationLock';

const log = createScopedLogger({ service: 'cloud-vm-tier' });

const HEALTH_POLL_TIMEOUT_MS = 120_000;

interface FlyMachine {
  state?: string;
  config?: Record<string, unknown> & {
    guest?: Record<string, unknown> & {
      cpu_kind?: string;
      cpus?: number;
      memory_mb?: number;
      cpuKind?: string;
      memoryMb?: number;
    };
  };
}

interface MachineGuest {
  cpuKind: string;
  cpus: number;
  memoryMb: number;
}

function extractMachineGuest(machine: FlyMachine): MachineGuest | undefined {
  const guest = machine.config?.guest;
  if (!guest) return undefined;

  const cpuKind = typeof guest.cpu_kind === 'string'
    ? guest.cpu_kind
    : typeof guest.cpuKind === 'string'
      ? guest.cpuKind
      : undefined;
  const cpus = typeof guest.cpus === 'number' && Number.isFinite(guest.cpus)
    ? guest.cpus
    : undefined;
  const memoryMb = typeof guest.memory_mb === 'number' && Number.isFinite(guest.memory_mb)
    ? guest.memory_mb
    : typeof guest.memoryMb === 'number' && Number.isFinite(guest.memoryMb)
      ? guest.memoryMb
      : undefined;

  if (!cpuKind || cpus === undefined || memoryMb === undefined) {
    return undefined;
  }

  return { cpuKind, cpus, memoryMb };
}

export interface ChangeVmTierParams {
  flyApiToken: string;
  flyAppName: string;
  flyMachineId: string;
  cloudUrl: string;
  tier: VmTier;
  /**
   * Optional active-turn count probe. When provided, the service re-evaluates
   * it after acquiring the per-machine lock and immediately before issuing the
   * Fly write — closing the TOCTOU window between the IPC handler's pre-flight
   * check and the actual machine restart. The handler should already have run
   * the same check earlier; this is a defence-in-depth step for the small
   * window where a turn can start in the few hundred ms it takes to reach
   * here.
   */
  getActiveTurnCount?: () => number;
}

export interface ChangeVmTierResult {
  success: boolean;
  updated: boolean;
  /**
   * Set to true if Fly accepted the guest config write. May be true even when
   * `success` is false (e.g. health verification failed afterwards). This lets
   * callers convey "the cloud is changing but we couldn't verify it" instead of
   * the more misleading "nothing happened".
   */
  applied?: boolean;
  /** True only when post-change health poll succeeded. */
  healthVerified?: boolean;
  startedMachine?: boolean;
  machineStateBefore?: string;
  error?: string;
}

/**
 * Per-machine in-flight tier-change guard. Backed by the shared Fly operation
 * lock so tier changes and volume resizes cannot overlap on the same machine.
 */

export async function changeVmTier(params: ChangeVmTierParams): Promise<ChangeVmTierResult> {
  const { flyApiToken, flyAppName, flyMachineId, cloudUrl, tier, getActiveTurnCount } = params;
  const targetGuest = toFlyGuestConfig(tier);
  const lock = acquireFlyOperationLock({ flyAppName, flyMachineId, kind: 'tier-change' });
  if (!lock) {
    return {
      success: false,
      updated: false,
      error: 'A tier change is already in progress for this cloud. Wait for it to finish before trying again.',
    };
  }

  try {
    // Defence-in-depth re-check: the IPC handler ran the same active-turn check
    // before invoking us, but a turn can start in the few hundred ms between
    // there and here. Re-checking inside the per-machine lock collapses the
    // TOCTOU window to a single tick — far smaller than the network-round-trip
    // window the handler-only check left open.
    if (getActiveTurnCount) {
      const activeTurns = getActiveTurnCount();
      if (activeTurns > 0) {
        return {
          success: false,
          updated: false,
          error: 'Can\'t change tiers while a conversation is active. Wait for the current response to finish.',
        };
      }
    }
    const machineResp = await flyFetch(
      flyApiToken,
      `/v1/apps/${flyAppName}/machines/${flyMachineId}`,
    );

    if (!machineResp.ok) {
      const body = await machineResp.text();
      return {
        success: false,
        updated: false,
        error: `Failed to load Fly machine: HTTP ${machineResp.status} ${body}`,
      };
    }

    const machine = await machineResp.json() as FlyMachine;
    const machineStateBefore = machine.state ?? 'unknown';
    const currentGuest = extractMachineGuest(machine);

    // Fail-closed if we cannot parse the current guest — writing blindly would
    // trigger an unnecessary machine restart with no confidence that the target
    // wasn't already in place.
    if (!currentGuest) {
      log.warn(
        { flyAppName, flyMachineId, tierId: tier.id },
        'Could not parse current Fly machine guest config; refusing to apply tier change',
      );
      return {
        success: false,
        updated: false,
        applied: false,
        machineStateBefore,
        error: 'Unable to read the cloud machine\'s current size before changing it. Try again in a moment, or contact support if this keeps happening.',
      };
    }

    if (
      currentGuest.cpuKind === targetGuest.cpu_kind
      && currentGuest.cpus === targetGuest.cpus
      && currentGuest.memoryMb === targetGuest.memory_mb
    ) {
      return {
        success: true,
        updated: false,
        machineStateBefore,
      };
    }

    const updateResult = await updateMachineConfig(
      flyApiToken,
      flyAppName,
      flyMachineId,
      (config) => ({
        ...config,
        guest: targetGuest,
      }),
    );

    if (!updateResult.success) {
      // Map Fly's optimistic-concurrency conflict into a friendlier message.
      // The cloud-side self-updater (selfUpdateScheduler) writes the same
      // machine config on its 6h cycle and during admin-triggered updates,
      // so a 409 here usually means we lost a race against the auto-updater
      // — not an internal error worth surfacing as raw API text.
      const lowerErr = updateResult.error?.toLowerCase() ?? '';
      const isVersionConflict = lowerErr.includes('version conflict')
        || lowerErr.includes('http 409');
      return {
        success: false,
        updated: false,
        applied: false,
        machineStateBefore,
        error: isVersionConflict
          ? 'Cloud may be updating right now — try again in a minute.'
          : updateResult.error ?? 'Machine config update failed.',
      };
    }

    const updatedMachineResp = await flyFetch(
      flyApiToken,
      `/v1/apps/${flyAppName}/machines/${flyMachineId}`,
    );

    if (!updatedMachineResp.ok) {
      const body = await updatedMachineResp.text();
      return {
        success: false,
        updated: true,
        applied: true,
        healthVerified: false,
        machineStateBefore,
        error: `Tier change applied but failed to refresh machine state: HTTP ${updatedMachineResp.status} ${body}`,
      };
    }

    const updatedMachine = await updatedMachineResp.json() as FlyMachine;
    const machineStateAfterUpdate = updatedMachine.state ?? 'unknown';

    let startedMachine = false;
    if (machineStateAfterUpdate !== 'started') {
      const startResp = await flyFetch(
        flyApiToken,
        `/v1/apps/${flyAppName}/machines/${flyMachineId}/start`,
        { method: 'POST' },
      );

      if (!startResp.ok && startResp.status !== 409) {
        const body = await startResp.text();
        return {
          success: false,
          updated: true,
          applied: true,
          healthVerified: false,
          machineStateBefore,
          error: `Tier change applied but failed to start machine: HTTP ${startResp.status} ${body}`,
        };
      }

      startedMachine = startResp.ok;
    }

    const health = await pollCloudHealth(cloudUrl, HEALTH_POLL_TIMEOUT_MS);
    if (!health.healthy) {
      return {
        success: false,
        updated: true,
        applied: true,
        healthVerified: false,
        machineStateBefore,
        startedMachine,
        error: health.error
          ? `Tier change applied but cloud did not become healthy: ${health.error}`
          : 'Tier change applied but cloud did not become healthy after tier change.',
      };
    }

    // Post-poll guest verification: confirm Fly's persisted config still
    // matches what we requested. Catches the rare case where another caller
    // raced and overwrote the guest config between our write and our poll.
    const verifyResp = await flyFetch(
      flyApiToken,
      `/v1/apps/${flyAppName}/machines/${flyMachineId}`,
    );
    if (!verifyResp.ok) {
      const body = await verifyResp.text().catch(() => '<unreadable>');
      return {
        success: false,
        updated: true,
        applied: true,
        healthVerified: true,
        machineStateBefore,
        startedMachine,
        error: `Tier change applied and cloud became healthy, but post-change verification fetch failed: HTTP ${verifyResp.status} ${body}`,
      };
    }
    const verifyMachine = await verifyResp.json() as FlyMachine;
    const verifyGuest = extractMachineGuest(verifyMachine);
    if (!verifyGuest) {
      return {
        success: false,
        updated: true,
        applied: true,
        healthVerified: true,
        machineStateBefore,
        startedMachine,
        error: 'Tier change applied and cloud became healthy, but the post-change guest config could not be parsed for verification.',
      };
    }
    if (
      verifyGuest.cpuKind !== targetGuest.cpu_kind
      || verifyGuest.cpus !== targetGuest.cpus
      || verifyGuest.memoryMb !== targetGuest.memory_mb
    ) {
      return {
        success: false,
        updated: true,
        applied: true,
        healthVerified: true,
        machineStateBefore,
        startedMachine,
        error: 'Tier change applied and cloud became healthy, but the final guest config did not match — another tier change may have raced.',
      };
    }

    log.info(
      { flyAppName, flyMachineId, tierId: tier.id, machineStateBefore, startedMachine },
      'Cloud VM tier change applied successfully',
    );

    return {
      success: true,
      updated: true,
      applied: true,
      healthVerified: true,
      machineStateBefore,
      startedMachine,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, flyAppName, flyMachineId, tierId: tier.id },
      'Failed to change cloud VM tier',
    );
    return {
      success: false,
      updated: false,
      error: message,
    };
  } finally {
    lock.release();
  }
}

export interface GetCurrentVmTierResult {
  success: boolean;
  tier?: VmTier;
  raw?: { cpuKind: string; cpus: number; memoryMb: number };
  error?: string;
}

export async function getCurrentVmTier(params: {
  flyApiToken: string;
  flyAppName: string;
  flyMachineId: string;
}): Promise<GetCurrentVmTierResult> {
  const { flyApiToken, flyAppName, flyMachineId } = params;

  try {
    const machineResp = await flyFetch(
      flyApiToken,
      `/v1/apps/${flyAppName}/machines/${flyMachineId}`,
    );

    if (!machineResp.ok) {
      const body = await machineResp.text();
      return {
        success: false,
        error: `Failed to load Fly machine: HTTP ${machineResp.status} ${body}`,
      };
    }

    const machine = await machineResp.json() as FlyMachine;
    const raw = extractMachineGuest(machine);
    if (!raw) {
      return {
        success: false,
        error: 'Fly machine guest configuration is missing or invalid.',
      };
    }

    return {
      success: true,
      tier: getTierFromGuest(raw),
      raw,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, flyAppName, flyMachineId }, 'Failed to read current cloud VM tier');
    return {
      success: false,
      error: message,
    };
  }
}
