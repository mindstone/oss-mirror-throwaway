import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { flyExtendVolume, flyFetch, getFlyVolume } from '../flyApiClient';
import { pollCloudHealth } from '../cloudUpdateService';
import { acquireFlyOperationLock } from './flyOperationLock';

const log = createScopedLogger({ service: 'cloud-volume' });

const HEALTH_POLL_TIMEOUT_MS = 120_000;
const BYTES_PER_GIB = 1024 ** 3;
const SIZE_VERIFY_RATIO = 0.9;
const CLOUD_STORAGE_ENDPOINT_NOT_FOUND = 'CLOUD_STORAGE_ENDPOINT_NOT_FOUND';

export type VolumeStatusOutcome =
  | {
    kind: 'ok';
    sizeGb: number;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    lastCheckedAt: number;
  }
  | {
    kind: 'cloud_unreachable';
    sizeGb?: number;
    reason?: 'endpoint_missing' | 'network';
    error: string;
    lastCheckedAt: number;
  }
  | { kind: 'fly_token_missing' }
  | { kind: 'not_applicable'; reason: 'managed' | 'non_fly' | 'not_byok' | 'not_connected' };

export interface CloudVolumeConfig {
  mode?: 'local' | 'cloud';
  cloudUrl?: string;
  cloudToken?: string;
  providerId?: 'fly' | 'digitalocean' | 'hetzner' | 'mindstone';
  provisionMode?: 'byok' | 'managed' | 'manual';
  flyAppName?: string;
  flyMachineId?: string;
  flyVolumeId?: string;
  flyVolumeSizeGb?: number;
}

export interface GetVolumeStatusParams {
  cloudInstance?: CloudVolumeConfig;
  flyApiToken?: string | null;
}

export interface ResizeVolumeParams {
  cloudInstance?: CloudVolumeConfig;
  flyApiToken?: string | null;
  targetSizeGb: number;
  getActiveTurnCount?: () => number;
}

export interface ResizeVolumeResult {
  success: boolean;
  applied?: boolean;
  healthVerified?: boolean;
  sizeVerified?: boolean;
  sizeGbBefore?: number;
  sizeGbAfter?: number;
  error?: string;
  helpKey?: 'billing_required' | 'capacity' | 'in_flight_conflict';
}

interface StorageUsageResponse {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  dataPath?: string;
  generatedAt: number;
}

function isManagedInstance(cloudInstance: CloudVolumeConfig | undefined): boolean {
  return Boolean(
    cloudInstance
    && (cloudInstance.provisionMode === 'managed' || cloudInstance.providerId === 'mindstone'),
  );
}

function resolveApplicability(
  cloudInstance: CloudVolumeConfig | undefined,
): { ok: true; managed: boolean } | { ok: false; outcome: VolumeStatusOutcome } {
  if (!cloudInstance || cloudInstance.mode !== 'cloud' || !cloudInstance.cloudUrl) {
    return { ok: false, outcome: { kind: 'not_applicable', reason: 'not_connected' } };
  }
  if (isManagedInstance(cloudInstance)) {
    return { ok: true, managed: true };
  }
  if (cloudInstance.provisionMode !== 'byok') {
    return { ok: false, outcome: { kind: 'not_applicable', reason: 'not_byok' } };
  }
  const resolvedProviderId = cloudInstance.providerId
    ?? (cloudInstance.flyAppName && cloudInstance.flyMachineId ? 'fly' : undefined);
  if (resolvedProviderId !== 'fly') {
    return { ok: false, outcome: { kind: 'not_applicable', reason: 'non_fly' } };
  }
  if (!cloudInstance.flyAppName || !cloudInstance.flyMachineId || !cloudInstance.flyVolumeId) {
    return { ok: false, outcome: { kind: 'not_applicable', reason: 'non_fly' } };
  }
  return { ok: true, managed: false };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readStorageUsage(
  cloudUrl: string,
  cloudToken: string | undefined,
): Promise<StorageUsageResponse> {
  if (!cloudToken) {
    throw new Error('Cloud token missing; cannot read storage usage.');
  }
  const resp = await fetch(`${cloudUrl}/api/storage/usage`, {
    headers: { Authorization: `Bearer ${cloudToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error(CLOUD_STORAGE_ENDPOINT_NOT_FOUND);
    }
    const body = await resp.text().catch(() => '<unreadable>');
    throw new Error(`Storage usage request failed: HTTP ${resp.status} ${body}`);
  }
  const data = await resp.json() as Partial<StorageUsageResponse>;
  if (
    typeof data.totalBytes !== 'number'
    || typeof data.usedBytes !== 'number'
    || typeof data.availableBytes !== 'number'
  ) {
    throw new Error('Storage usage response missing byte counters.');
  }
  return {
    totalBytes: data.totalBytes,
    usedBytes: data.usedBytes,
    availableBytes: data.availableBytes,
    dataPath: data.dataPath,
    generatedAt: typeof data.generatedAt === 'number' ? data.generatedAt : Date.now(),
  };
}

function captureVolumeFailure(stage: string, error: string, context: Record<string, unknown>): void {
  getErrorReporter().captureMessage('cloud-volume-operation-failed', {
    level: 'warning',
    tags: { area: 'cloud-volume', stage },
    extra: { ...context, error },
  });
}

function isStorageEndpointMissingError(error: unknown): boolean {
  return error instanceof Error && error.message === CLOUD_STORAGE_ENDPOINT_NOT_FOUND;
}

export async function getVolumeStatus(params: GetVolumeStatusParams): Promise<VolumeStatusOutcome> {
  const { cloudInstance: ci, flyApiToken } = params;
  const applicable = resolveApplicability(ci);
  if (!applicable.ok) return applicable.outcome;
  if (!ci) return { kind: 'not_applicable', reason: 'not_connected' };
  const { cloudUrl, cloudToken } = ci;
  if (!cloudUrl) {
    return { kind: 'not_applicable', reason: 'not_connected' };
  }

  if (applicable.managed) {
    let usage: StorageUsageResponse;
    try {
      usage = await readStorageUsage(cloudUrl, cloudToken);
    } catch (err) {
      const error = toErrorMessage(err);
      const endpointMissing = isStorageEndpointMissingError(err);
      if (!endpointMissing) {
        log.warn({ err, cloudUrl }, 'Managed cloud storage usage endpoint unreachable');
      }
      return {
        kind: 'cloud_unreachable',
        reason: endpointMissing ? 'endpoint_missing' : 'network',
        error,
        lastCheckedAt: Date.now(),
      };
    }
    return {
      kind: 'ok',
      sizeGb: Math.ceil(usage.totalBytes / BYTES_PER_GIB),
      totalBytes: usage.totalBytes,
      usedBytes: usage.usedBytes,
      availableBytes: usage.availableBytes,
      lastCheckedAt: Date.now(),
    };
  }

  const { flyAppName, flyVolumeId, flyVolumeSizeGb } = ci;
  if (!flyAppName || !flyVolumeId) {
    return { kind: 'not_applicable', reason: 'non_fly' };
  }
  if (!flyApiToken) return { kind: 'fly_token_missing' };

  let usage: StorageUsageResponse;
  try {
    usage = await readStorageUsage(cloudUrl, cloudToken);
  } catch (err) {
    const error = toErrorMessage(err);
    const endpointMissing = isStorageEndpointMissingError(err);
    if (!endpointMissing) {
      log.warn({ err, cloudUrl, flyAppName }, 'Cloud storage usage endpoint unreachable');
    }
    const volume = await getFlyVolume(flyApiToken, flyAppName, flyVolumeId);
    const sizeGb = volume.success ? volume.volume?.sizeGb : flyVolumeSizeGb;
    return {
      kind: 'cloud_unreachable',
      sizeGb,
      reason: endpointMissing ? 'endpoint_missing' : 'network',
      error,
      lastCheckedAt: Date.now(),
    };
  }

  let sizeGb = flyVolumeSizeGb;
  if (typeof sizeGb !== 'number') {
    const volume = await getFlyVolume(flyApiToken, flyAppName, flyVolumeId);
    if (!volume.success) {
      log.warn(
        { flyAppName, flyVolumeId, error: volume.error },
        'Fly volume metadata unavailable; using storage endpoint total as size fallback',
      );
    }
    sizeGb = volume.volume?.sizeGb;
  }
  sizeGb = sizeGb ?? Math.ceil(usage.totalBytes / BYTES_PER_GIB);
  const totalGbFromDf = Math.ceil(usage.totalBytes / BYTES_PER_GIB);
  if (sizeGb && totalGbFromDf > sizeGb + 1) {
    log.warn(
      { sizeGb, totalGbFromDf, flyVolumeId, flyAppName },
      'Cloud storage divergence: filesystem total exceeds tracked Fly volume size — Fly may have been extended out of band',
    );
  }

  return {
    kind: 'ok',
    sizeGb,
    totalBytes: usage.totalBytes,
    usedBytes: usage.usedBytes,
    availableBytes: usage.availableBytes,
    lastCheckedAt: Date.now(),
  };
}

function resizeGuardError(
  outcome: VolumeStatusOutcome,
): ResizeVolumeResult {
  if (outcome.kind === 'fly_token_missing') {
    return { success: false, applied: false, error: 'Fly API token not found. Link your Fly token first.' };
  }
  if (outcome.kind === 'not_applicable') {
    return { success: false, applied: false, error: 'Storage controls are only available for self-hosted Fly cloud instances.' };
  }
  return { success: false, applied: false, error: 'Storage controls are unavailable for this cloud instance.' };
}

export async function resizeVolume(params: ResizeVolumeParams): Promise<ResizeVolumeResult> {
  const { cloudInstance: ci, flyApiToken, targetSizeGb, getActiveTurnCount } = params;
  const applicable = resolveApplicability(ci);
  if (!applicable.ok) return resizeGuardError(applicable.outcome);
  if (applicable.managed) {
    return { success: false, applied: false, error: 'Storage controls are only available for self-hosted Fly cloud instances.' };
  }
  if (!ci) return { success: false, applied: false, error: 'No cloud instance configured.' };
  const { cloudUrl, cloudToken, flyAppName, flyMachineId, flyVolumeId, flyVolumeSizeGb } = ci;
  if (!cloudUrl || !flyAppName || !flyMachineId || !flyVolumeId) {
    return { success: false, applied: false, error: 'No Fly app configured with volume metadata.' };
  }
  if (!flyApiToken) return { success: false, applied: false, error: 'Fly API token not found. Link your Fly token first.' };

  if (getActiveTurnCount && getActiveTurnCount() > 0) {
    return {
      success: false,
      applied: false,
      error: 'Can\'t resize storage while a conversation is active. Wait for the current response to finish.',
    };
  }

  const lock = acquireFlyOperationLock({
    flyAppName,
    flyMachineId,
    kind: 'volume-resize',
  });
  if (!lock) {
    return {
      success: false,
      applied: false,
      helpKey: 'in_flight_conflict',
      error: 'A capacity change is already in progress. Wait for it to finish.',
    };
  }

  try {
    if (getActiveTurnCount && getActiveTurnCount() > 0) {
      return {
        success: false,
        applied: false,
        error: 'Can\'t resize storage while a conversation is active. Wait for the current response to finish.',
      };
    }

    const before = await getFlyVolume(flyApiToken, flyAppName, flyVolumeId);
    const sizeGbBefore = before.volume?.sizeGb ?? flyVolumeSizeGb;
    if (before.success && typeof sizeGbBefore === 'number' && targetSizeGb <= sizeGbBefore) {
      return {
        success: false,
        applied: false,
        sizeGbBefore,
        error: `New total size must be larger than the current ${sizeGbBefore} GB volume.`,
      };
    }

    const extend = await flyExtendVolume(flyApiToken, flyAppName, flyVolumeId, targetSizeGb);
    if (!extend.success) {
      captureVolumeFailure('extend', extend.error ?? 'Volume extend failed.', {
        flyAppName,
        flyMachineId,
        flyVolumeId,
        targetSizeGb,
        status: extend.status,
      });
      return {
        success: false,
        applied: false,
        sizeGbBefore,
        error: extend.error ?? 'Volume extend failed.',
        helpKey: extend.helpKey,
      };
    }

    const restartResp = await flyFetch(
      flyApiToken,
      `/v1/apps/${flyAppName}/machines/${flyMachineId}/restart`,
      { method: 'POST' },
    );
    if (!restartResp.ok && restartResp.status !== 409) {
      const body = await restartResp.text().catch(() => '<unreadable>');
      const error = `Volume extend applied but machine restart failed: HTTP ${restartResp.status} ${body}`;
      captureVolumeFailure('restart', error, {
        flyAppName,
        flyMachineId,
        flyVolumeId,
        targetSizeGb,
      });
      return {
        success: false,
        applied: true,
        healthVerified: false,
        sizeVerified: false,
        sizeGbBefore,
        sizeGbAfter: extend.volume?.sizeGb ?? targetSizeGb,
        error,
      };
    }

    const health = await pollCloudHealth(cloudUrl, HEALTH_POLL_TIMEOUT_MS);
    if (!health.healthy) {
      const error = health.error
        ? `Storage resize applied but cloud did not become healthy: ${health.error}`
        : 'Storage resize applied but cloud did not become healthy after restart.';
      captureVolumeFailure('health-poll', error, {
        flyAppName,
        flyMachineId,
        flyVolumeId,
        targetSizeGb,
      });
      return {
        success: false,
        applied: true,
        healthVerified: false,
        sizeVerified: false,
        sizeGbBefore,
        sizeGbAfter: extend.volume?.sizeGb ?? targetSizeGb,
        error,
      };
    }

    const after = await getFlyVolume(flyApiToken, flyAppName, flyVolumeId);
    const sizeGbAfter = after.volume?.sizeGb ?? extend.volume?.sizeGb ?? targetSizeGb;
    if (!after.success || sizeGbAfter < targetSizeGb) {
      const error = after.success
        ? 'Storage resize applied and cloud became healthy, but Fly still reports the old volume size.'
        : `Storage resize applied and cloud became healthy, but volume verification failed: ${after.error ?? 'unknown error'}`;
      captureVolumeFailure('verify', error, {
        flyAppName,
        flyMachineId,
        flyVolumeId,
        targetSizeGb,
        sizeGbAfter,
      });
      return {
        success: false,
        applied: true,
        healthVerified: true,
        sizeVerified: false,
        sizeGbBefore,
        sizeGbAfter,
        error,
      };
    }

    try {
      const usage = await readStorageUsage(cloudUrl, cloudToken);
      const minExpectedBytes = targetSizeGb * BYTES_PER_GIB * SIZE_VERIFY_RATIO;
      if (usage.totalBytes < minExpectedBytes) {
        const error = 'Storage resize applied and cloud became healthy, but the guest still reports the old storage size.';
        captureVolumeFailure('verify', error, {
          flyAppName,
          flyMachineId,
          flyVolumeId,
          targetSizeGb,
          totalBytes: usage.totalBytes,
        });
        return {
          success: false,
          applied: true,
          healthVerified: true,
          sizeVerified: false,
          sizeGbBefore,
          sizeGbAfter,
          error,
        };
      }
    } catch (err) {
      const error = `Storage resize applied and cloud became healthy, but storage verification failed: ${toErrorMessage(err)}`;
      captureVolumeFailure('verify', error, {
        flyAppName,
        flyMachineId,
        flyVolumeId,
        targetSizeGb,
      });
      return {
        success: false,
        applied: true,
        healthVerified: true,
        sizeVerified: false,
        sizeGbBefore,
        sizeGbAfter,
        error,
      };
    }

    log.info(
      { flyAppName, flyMachineId, flyVolumeId, targetSizeGb },
      'Cloud storage resize applied successfully',
    );
    return {
      success: true,
      applied: true,
      healthVerified: true,
      sizeVerified: true,
      sizeGbBefore,
      sizeGbAfter,
    };
  } catch (err) {
    const error = toErrorMessage(err);
    log.error(
      { err, flyAppName, flyMachineId, flyVolumeId, targetSizeGb },
      'Cloud storage resize failed',
    );
    captureVolumeFailure('unexpected', error, {
      flyAppName,
      flyMachineId,
      flyVolumeId,
      targetSizeGb,
    });
    return { success: false, applied: false, error };
  } finally {
    lock.release();
  }
}
