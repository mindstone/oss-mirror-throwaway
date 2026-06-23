/**
 * Fly.io API Client
 *
 * Shared primitives for interacting with the Fly Machines REST API and
 * GraphQL API. Extracted from flyProvisioningService.ts and
 * cloudUpdateService.ts to eliminate duplication and provide reusable
 * building blocks for subsequent cloud continuity features.
 *
 * Zero Electron imports — lives in src/core/ as a boundary-clean service.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'fly-api-client' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FLY_MACHINES_BASE = 'https://api.machines.dev';
export const FLY_GRAPHQL_URL = 'https://api.fly.io/graphql';
/** Fly.io machine wait API accepts timeouts in [1s, 60s]. */
export const FLY_MACHINE_WAIT_MAX_SECONDS = 60;

// ---------------------------------------------------------------------------
// Low-level API helpers
// ---------------------------------------------------------------------------

/**
 * Authenticated fetch against the Fly Machines REST API.
 * Injects Authorization header, JSON content-type, and a 30 s default timeout.
 */
export async function flyFetch(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const resp = await fetch(`${FLY_MACHINES_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  return resp;
}

/**
 * Authenticated request to the Fly GraphQL API.
 * Returns parsed JSON with optional `data` and `errors` fields.
 */
export async function flyGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }> {
  const resp = await fetch(FLY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw Object.assign(new Error(`GraphQL request failed: HTTP ${resp.status}`), { status: resp.status });
  }

  return resp.json() as Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
}

/**
 * Parse a non-OK Fly API response into a structured error.
 */
export function parseFlyError(resp: Response, body?: string): { status: number; message: string } {
  return { status: resp.status, message: body ?? `HTTP ${resp.status}` };
}

// ---------------------------------------------------------------------------
// Higher-level primitives
// ---------------------------------------------------------------------------

interface IpAddress {
  id: string;
  address: string;
  type: string;
}

/**
 * List all IP addresses allocated to a Fly app.
 */
export async function listIpAddresses(
  token: string,
  appName: string,
): Promise<Array<IpAddress>> {
  const result = await flyGraphQL(token, `
    query($appName: String!) {
      app(name: $appName) {
        ipAddresses {
          nodes {
            id
            address
            type
          }
        }
      }
    }
  `, { appName });

  if (result.errors?.length) {
    const msg = result.errors.map(e => e.message).join('; ');
    throw new Error(`Failed to list IP addresses for ${appName}: ${msg}`);
  }

  const app = result.data?.app as { ipAddresses?: { nodes?: IpAddress[] } } | undefined;
  return app?.ipAddresses?.nodes ?? [];
}

/**
 * Ensure a shared IPv4 address exists for a Fly app.
 *
 * Checks existing IPs first because the `allocateIpAddress(shared_v4)`
 * mutation is **not idempotent** — it errors when one already exists.
 */
export async function allocateSharedIpv4(
  token: string,
  appName: string,
): Promise<{ success: boolean; address?: string; alreadyExists?: boolean; error?: string }> {
  try {
    const existingIps = await listIpAddresses(token, appName);
    const sharedV4 = existingIps.find(ip => ip.type === 'shared_v4');

    if (sharedV4) {
      log.info({ appName, address: sharedV4.address }, 'Shared IPv4 already exists');
      return { success: true, address: sharedV4.address, alreadyExists: true };
    }

    const result = await flyGraphQL(token, `
      mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          ipAddress {
            address
            type
          }
        }
      }
    `, { input: { appId: appName, type: 'shared_v4' } });

    if (result.errors?.length) {
      const msg = result.errors.map(e => e.message).join('; ');
      log.error({ appName, errors: result.errors }, 'Failed to allocate shared IPv4');
      return { success: false, error: msg };
    }

    const allocated = result.data?.allocateIpAddress as { ipAddress?: { address?: string } } | undefined;
    const address = allocated?.ipAddress?.address;

    log.info({ appName, address }, 'Shared IPv4 allocated');
    return { success: true, address };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName }, 'allocateSharedIpv4 failed');
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Machine lifecycle primitives
// ---------------------------------------------------------------------------

export interface FlyMachineState {
  id: string;
  state: string;
  config: Record<string, unknown>;
  version: string;
  region: string;
  updatedAt: string;
  checks?: Array<{ name: string; status: string; output?: string }>;
  events?: Array<{ type: string; timestamp: number; status: string }>;
}

export interface FlyVolumeState {
  id: string;
  name?: string;
  state?: string;
  sizeGb?: number;
  region?: string;
  zone?: string;
  app?: string;
  machineId?: string;
  createdAt?: string;
}

function parseFlyVolume(raw: Record<string, unknown>): FlyVolumeState {
  return {
    id: String(raw.id ?? ''),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    state: typeof raw.state === 'string' ? raw.state : undefined,
    sizeGb: typeof raw.size_gb === 'number'
      ? raw.size_gb
      : typeof raw.sizeGb === 'number'
        ? raw.sizeGb
        : undefined,
    region: typeof raw.region === 'string' ? raw.region : undefined,
    zone: typeof raw.zone === 'string' ? raw.zone : undefined,
    app: typeof raw.app === 'string' ? raw.app : undefined,
    machineId: typeof raw.machine_id === 'string'
      ? raw.machine_id
      : typeof raw.machineId === 'string'
        ? raw.machineId
        : undefined,
    createdAt: typeof raw.created_at === 'string'
      ? raw.created_at
      : typeof raw.createdAt === 'string'
        ? raw.createdAt
        : undefined,
  };
}

export async function getFlyVolume(
  token: string,
  appName: string,
  volumeId: string,
): Promise<{ success: boolean; volume?: FlyVolumeState; error?: string }> {
  try {
    const resp = await flyFetch(token, `/v1/apps/${appName}/volumes/${volumeId}`);
    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `HTTP ${resp.status}: ${body}` };
    }
    const raw = await resp.json() as Record<string, unknown>;
    const volume = parseFlyVolume(raw);
    if (!volume.id) {
      return { success: false, error: 'Fly volume response missing id.' };
    }
    return { success: true, volume };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName, volumeId }, 'getFlyVolume failed');
    return { success: false, error: message };
  }
}

/**
 * Extend a Fly volume to a new total size.
 *
 * Spike: `tmp/agent-tests/fly-extend-spike.ts` attempted to load the local Fly
 * token but could not access one from this non-Electron context, and live
 * probing was intentionally skipped because the only named app in the
 * assignment (`rebel-cloud-test`) must not be mutated without an explicit user
 * check-in. Behaviour is therefore assumed from Fly's documented Machines API
 * surface, not exercised live yet:
 *
 *   POST /v1/apps/{app_name}/volumes/{volume_id}/extend
 *   body `{ size_gb: number }`
 *   response: Fly Volume object, including `size_gb`
 *
 * The caller restarts the machine unconditionally after a successful extend so
 * the guest remounts `/data` and observes the new filesystem size even if Fly
 * eventually makes online resize visible without a restart.
 */
export async function flyExtendVolume(
  token: string,
  appName: string,
  volumeId: string,
  sizeGb: number,
): Promise<{ success: boolean; volume?: FlyVolumeState; status?: number; error?: string; helpKey?: 'billing_required' | 'capacity' }> {
  try {
    const resp = await flyFetch(token, `/v1/apps/${appName}/volumes/${volumeId}/extend`, {
      method: 'POST',
      body: JSON.stringify({ size_gb: sizeGb }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const lower = text.toLowerCase();
      const helpKey = resp.status === 402 || (resp.status === 422 && /payment method|billing required|add (a )?(credit )?card/i.test(text))
        ? 'billing_required'
        : resp.status === 422 && lower.includes('capacity')
          ? 'capacity'
          : undefined;
      return {
        success: false,
        status: resp.status,
        helpKey,
        error: resp.status === 409
          ? 'Cloud may be updating right now — try again in a minute.'
          : `Volume extend failed: HTTP ${resp.status} ${text}`,
      };
    }
    const raw = text ? JSON.parse(text) as Record<string, unknown> : {};
    const volume = parseFlyVolume(raw);
    log.info({ appName, volumeId, sizeGb, responseSizeGb: volume.sizeGb }, 'Fly volume extend accepted');
    return { success: true, volume };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName, volumeId, sizeGb }, 'flyExtendVolume failed');
    return { success: false, error: message };
  }
}

/**
 * Get the current state and config of a Fly Machine.
 */
export async function getMachineState(
  token: string,
  appName: string,
  machineId: string,
): Promise<{ success: boolean; machine?: FlyMachineState; error?: string }> {
  try {
    const resp = await flyFetch(token, `/v1/apps/${appName}/machines/${machineId}`);
    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `HTTP ${resp.status}: ${body}` };
    }

    const raw = await resp.json() as Record<string, unknown>;
    const machine: FlyMachineState = {
      id: String(raw.id ?? ''),
      state: String(raw.state ?? 'unknown'),
      config: (raw.config as Record<string, unknown>) ?? {},
      version: String(raw.version ?? ''),
      region: String(raw.region ?? ''),
      updatedAt: String(raw.updated_at ?? ''),
      checks: raw.checks as FlyMachineState['checks'],
      events: raw.events as FlyMachineState['events'],
    };

    return { success: true, machine };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName, machineId }, 'getMachineState failed');
    return { success: false, error: message };
  }
}

/**
 * Force-destroy a Fly Machine. Works even on machines stuck in `starting`.
 */
export async function destroyMachine(
  token: string,
  appName: string,
  machineId: string,
  force = true,
): Promise<{ success: boolean; error?: string }> {
  try {
    const query = force ? '?force=true' : '';
    const resp = await flyFetch(token, `/v1/apps/${appName}/machines/${machineId}${query}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `HTTP ${resp.status}: ${body}` };
    }

    log.info({ appName, machineId, force }, 'Machine destroyed');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName, machineId }, 'destroyMachine failed');
    return { success: false, error: message };
  }
}

const FLY_INTERNAL_METADATA_KEYS = [
  'fly_flyctl_version',
  'fly_platform_version',
  'fly_process_group',
  'fly_release_id',
  'fly_release_version',
];

/**
 * Strip Fly-internal metadata fields from a machine config.
 * These reference the old machine and should not be copied to a new one.
 */
export function sanitizeMachineConfig(config: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...config };
  if (cleaned.metadata && typeof cleaned.metadata === 'object') {
    const metadata = { ...(cleaned.metadata as Record<string, unknown>) };
    for (const key of FLY_INTERNAL_METADATA_KEYS) {
      delete metadata[key];
    }
    cleaned.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
  }
  return cleaned;
}

/**
 * Create a new Fly Machine with the given config.
 * Config should include image, env, services, checks, guest, mounts, etc.
 */
export async function createMachine(
  token: string,
  appName: string,
  config: Record<string, unknown>,
  region?: string,
): Promise<{ success: boolean; machineId?: string; state?: string; error?: string }> {
  try {
    const payload: Record<string, unknown> = {
      config: sanitizeMachineConfig(config),
    };
    if (region) payload.region = region;

    const resp = await flyFetch(token, `/v1/apps/${appName}/machines`, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `HTTP ${resp.status}: ${body}` };
    }

    const raw = await resp.json() as { id?: string; state?: string };
    log.info({ appName, machineId: raw.id, state: raw.state, region }, 'Machine created');
    return { success: true, machineId: String(raw.id ?? ''), state: String(raw.state ?? 'unknown') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName }, 'createMachine failed');
    return { success: false, error: message };
  }
}

/**
 * Wait for a Fly Machine to reach a target state using the built-in wait API.
 * Avoids manual polling — Fly holds the connection until the state is reached or timeout.
 *
 * Fly.io accepts wait timeouts in [1s, 60s]. Values outside that range are
 * clamped automatically to avoid validation errors from the API.
 */
export async function waitForMachineState(
  token: string,
  appName: string,
  machineId: string,
  targetState: string,
  timeoutSeconds = FLY_MACHINE_WAIT_MAX_SECONDS,
): Promise<{ success: boolean; error?: string }> {
  const clamped = Math.max(1, Math.min(timeoutSeconds, FLY_MACHINE_WAIT_MAX_SECONDS));
  if (clamped !== timeoutSeconds) {
    log.warn({ requested: timeoutSeconds, clamped }, 'waitForMachineState timeout clamped to Fly.io limits [1s, 60s]');
  }
  try {
    const resp = await flyFetch(
      token,
      `/v1/apps/${appName}/machines/${machineId}/wait?state=${targetState}&timeout=${clamped}`,
      { signal: AbortSignal.timeout((clamped + 10) * 1000) },
    );

    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `Wait failed: HTTP ${resp.status}: ${body}` };
    }

    log.info({ appName, machineId, targetState }, 'Machine reached target state');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName, machineId, targetState }, 'waitForMachineState failed');
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Machine config update
// ---------------------------------------------------------------------------

/**
 * Generic machine config update with optimistic locking.
 *
 * 1. GETs the current machine state + config + version
 * 2. Applies `patcher(config)` to derive the new config
 * 3. POSTs the updated config with `current_version` for conflict detection
 *
 * Returns `{ success: true, restarted: true }` on success.
 * Returns `{ success: false, error }` on version conflict or other failure.
 */
export async function updateMachineConfig(
  token: string,
  appName: string,
  machineId: string,
  patcher: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ success: boolean; restarted?: boolean; error?: string }> {
  try {
    // 1. Fetch current machine state
    const getResp = await flyFetch(token, `/v1/apps/${appName}/machines/${machineId}`);
    if (!getResp.ok) {
      const body = await getResp.text();
      return { success: false, error: `Failed to fetch machine: HTTP ${getResp.status} ${body}` };
    }

    const machine = await getResp.json() as {
      config?: Record<string, unknown>;
      version?: number;
    };

    if (!machine.config) {
      return { success: false, error: 'Machine response missing config; cannot update.' };
    }

    // 2. Apply patcher to derive new config
    const newConfig = patcher(machine.config);

    // 3. POST with optimistic locking
    const payload: Record<string, unknown> = { config: newConfig };
    if (typeof machine.version === 'number') {
      payload.current_version = machine.version;
    }

    const postResp = await flyFetch(token, `/v1/apps/${appName}/machines/${machineId}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!postResp.ok) {
      const body = await postResp.text();
      if (postResp.status === 409) {
        return { success: false, error: 'Version conflict — machine was updated by another process' };
      }
      return { success: false, error: `Machine config update failed: HTTP ${postResp.status} ${body}` };
    }

    return { success: true, restarted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName, machineId }, 'updateMachineConfig failed');
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Image rollback (Stage 0 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md)
// ---------------------------------------------------------------------------

/**
 * Identifies which subsystem initiated an image rollback. Surfaced in structured
 * logs so post-incident telemetry can distinguish `cloud:repair-machine`
 * (destroy+recreate same image) from `cloud:revert-to-last-known-good` (user-
 * driven rollback) from the pre-bootstrap watchdog (cross-boot auto-recovery)
 * from the cloud-side scheduler (forward update, NOT a rollback but uses the
 * same primitive for the no-op-same-image fast path).
 *
 * Required argument on `applyImageRollback` per Decision F9.
 */
export type ImageRollbackWriterTag =
  | 'self-update'
  | 'desktop-repair'
  | 'desktop-revert'
  | 'pre-bootstrap-watchdog';

export type ImageRollbackOutcome =
  | 'rolled-back'
  | 'no-op-same-image'
  | 'conflict'
  | 'image-invalid'
  | 'fly-error';

export interface ApplyImageRollbackOptions {
  writerTag: ImageRollbackWriterTag;
}

export interface ApplyImageRollbackResult {
  outcome: ImageRollbackOutcome;
  error?: string;
}

const IMAGE_REF_PATTERN = /^[a-z0-9./_-]+:[a-z0-9._-]+$/i;

function readMachineImage(config: Record<string, unknown>): string | undefined {
  const image = config.image;
  if (typeof image === 'string' && image.length > 0) return image;
  return undefined;
}

/**
 * Roll back (or forward) the Fly machine's image to `targetImage`, with
 * structured safety checks consumers should not have to open-code:
 *
 * - Refuses if `targetImage` does not match the canonical `repo:tag` shape.
 * - Returns `no-op-same-image` without issuing a PATCH if `targetImage`
 *   matches the machine's current `config.image`. Saves a wasted restart.
 * - Maps `updateMachineConfig` errors into the `ImageRollbackOutcome` union.
 *
 * The `writerTag` argument distinguishes callers in telemetry — see
 * `ImageRollbackWriterTag` for the enum and the planning doc for rationale.
 */
export async function applyImageRollback(
  token: string,
  appName: string,
  machineId: string,
  targetImage: string,
  options: ApplyImageRollbackOptions,
): Promise<ApplyImageRollbackResult> {
  const { writerTag } = options;

  log.info(
    { event: 'image-rollback-attempt', writerTag, appName, machineId, targetImage },
    'image-rollback-attempt',
  );

  if (typeof targetImage !== 'string' || !IMAGE_REF_PATTERN.test(targetImage)) {
    log.warn(
      { event: 'image-rollback-result', writerTag, appName, machineId, targetImage, outcome: 'image-invalid' },
      'image-rollback-result',
    );
    return { outcome: 'image-invalid', error: `Invalid image ref: ${String(targetImage)}` };
  }

  let observedCurrentImage: string | undefined;

  const updateResult = await updateMachineConfig(token, appName, machineId, (config) => {
    observedCurrentImage = readMachineImage(config);
    if (observedCurrentImage === targetImage) {
      return config;
    }
    return { ...config, image: targetImage };
  });

  if (observedCurrentImage === targetImage) {
    log.info(
      { event: 'image-rollback-result', writerTag, appName, machineId, targetImage, outcome: 'no-op-same-image' },
      'image-rollback-result',
    );
    return { outcome: 'no-op-same-image' };
  }

  if (updateResult.success) {
    log.info(
      { event: 'image-rollback-result', writerTag, appName, machineId, targetImage, outcome: 'rolled-back' },
      'image-rollback-result',
    );
    return { outcome: 'rolled-back' };
  }

  const errorMessage = updateResult.error ?? 'unknown failure';
  if (errorMessage.includes('Version conflict')) {
    log.warn(
      { event: 'image-rollback-result', writerTag, appName, machineId, targetImage, outcome: 'conflict' },
      'image-rollback-result',
    );
    return { outcome: 'conflict', error: errorMessage };
  }

  log.warn(
    { event: 'image-rollback-result', writerTag, appName, machineId, targetImage, outcome: 'fly-error', error: errorMessage },
    'image-rollback-result',
  );
  return { outcome: 'fly-error', error: errorMessage };
}
