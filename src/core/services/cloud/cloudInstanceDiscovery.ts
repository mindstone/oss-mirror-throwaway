/**
 * Cloud Instance Discovery — Single Source of Truth
 *
 * Checks all relevant cloud status endpoints in parallel to determine
 * what is actually provisioned, regardless of what settings say.
 * Used to detect conflicts (e.g. managed + BYOK both exist).
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'cloud-instance-discovery' });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManagedInstanceInfo {
  exists: boolean;
  status?: string;
  phase?: string;
  cloudUrl?: string;
  cloudToken?: string;
  error?: string;
}

export interface ByokInstanceInfo {
  exists: boolean;
  healthy: boolean;
  cloudUrl?: string;
  providerId?: string;
  provisionMode?: string;
}

export interface DiscoveryResult {
  managed: ManagedInstanceInfo;
  byok: ByokInstanceInfo;
  /** True when both managed and BYOK instances exist simultaneously */
  conflict: boolean;
  /** Which instance is currently active in settings */
  activeInSettings: 'managed' | 'byok' | 'none';
}

// ---------------------------------------------------------------------------
// Dependency injection — no direct imports from authService or settingsStore
// ---------------------------------------------------------------------------

export interface DiscoveryDeps {
  apiUrl: string;
  accessToken: string | null;
  includeManaged?: boolean;
  cloudInstance?: {
    mode?: string;
    cloudUrl?: string;
    cloudToken?: string;
    providerId?: string;
    provisionMode?: string;
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function discoverCloudInstances(deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const { apiUrl, accessToken, cloudInstance, includeManaged = true } = deps;

  // Run managed and BYOK checks in parallel
  const [managed, byok] = await Promise.all([
    includeManaged ? checkManagedInstance(apiUrl, accessToken) : Promise.resolve({ exists: false }),
    checkByokInstance(cloudInstance),
  ]);

  // Determine what's active in settings
  let activeInSettings: DiscoveryResult['activeInSettings'] = 'none';
  if (cloudInstance?.mode === 'cloud' && cloudInstance.cloudUrl) {
    activeInSettings = cloudInstance.provisionMode === 'managed' ? 'managed' : 'byok';
  }

  const conflict = managed.exists && byok.exists;
  if (conflict) {
    log.warn('Cloud conflict detected: both managed and BYOK instances exist');
  }

  return { managed, byok, conflict, activeInSettings };
}

// ---------------------------------------------------------------------------
// Internal checks
// ---------------------------------------------------------------------------

async function checkManagedInstance(
  apiUrl: string,
  accessToken: string | null,
): Promise<ManagedInstanceInfo> {
  // No access token → we CANNOT query the backend, so this is "could not check",
  // NOT an authoritative "confirmed gone". Carry an `error` so consumers that
  // gate on a CLEAN `exists:false` (e.g. the orphan-destroy billing-honesty
  // banner in `handleDestroyOrphanedManaged`) don't mistake an unauthenticated
  // probe for proof the instance was removed (C-F1 edge).
  if (!accessToken) return { exists: false, error: 'Not signed in — could not check managed instance.' };

  try {
    const resp = await fetch(`${apiUrl}/api/cloud/managed/status`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      if (resp.status === 404) return { exists: false };
      return { exists: false, error: `HTTP ${resp.status}` };
    }

    const data = (await resp.json()) as {
      exists?: boolean;
      status?: string;
      phase?: string;
      cloudUrl?: string;
      cloudToken?: string;
      error?: string;
    };

    return {
      exists: data.exists === true,
      status: data.status,
      phase: data.phase,
      cloudUrl: data.cloudUrl,
      cloudToken: data.cloudToken,
      error: data.error,
    };
  } catch (err) {
    log.debug({ err }, 'Managed instance status check failed');
    return { exists: false, error: (err as Error).message };
  }
}

async function checkByokInstance(
  cloudInstance: DiscoveryDeps['cloudInstance'],
): Promise<ByokInstanceInfo> {
  // Only check BYOK instances — managed instances are checked via the status API
  if (
    !cloudInstance?.cloudUrl ||
    cloudInstance.mode !== 'cloud' ||
    cloudInstance.provisionMode === 'managed'
  ) {
    return { exists: false, healthy: false };
  }

  // Ping health endpoint to verify the instance is reachable
  let healthy = false;
  try {
    const resp = await fetch(`${cloudInstance.cloudUrl}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    healthy = resp.ok;
  } catch {
    // Unreachable — still exists in settings, just not healthy
  }

  return {
    exists: true,
    healthy,
    cloudUrl: cloudInstance.cloudUrl,
    providerId: cloudInstance.providerId,
    provisionMode: cloudInstance.provisionMode,
  };
}
