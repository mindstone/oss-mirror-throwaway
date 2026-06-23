/**
 * Fly.io Auto-Provisioning Service
 *
 * Platform-agnostic orchestration for creating a Fly Machine running the
 * Rebel cloud-service Docker image. Uses the Fly Machines REST API
 * (https://api.machines.dev) and GraphQL API (https://api.fly.io/graphql)
 * for secrets.
 *
 * Zero Electron imports — lives in src/core/ as a boundary-clean service.
 */

import { createScopedLogger } from '@core/logger';
import { randomBytes } from 'crypto';
import { flyFetch, flyGraphQL, parseFlyError } from './flyApiClient';
import { DEFAULT_VOLUME_SIZE_GB } from './cloud/providers/volumeDefaults';
import {
  getDefaultTier,
  getTierById,
  toFlyGuestConfig,
  type VmTier,
} from './cloud/vmTierCatalog';

const log = createScopedLogger({ service: 'fly-provisioning' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOUD_IMAGE = 'ghcr.io/mindstone/rebel-cloud:latest';
const APP_NAME_PREFIX = 'rebel-cloud-';
const DEFAULT_REGION = 'iad';
const VOLUME_NAME = 'rebel_data';
const HEALTH_POLL_TIMEOUT_MS = 90_000;
const HEALTH_POLL_INTERVAL_MS = 3_000;

/**
 * One-shot retry for the machine-create call when the failure looks like
 * a transient network blip between Fly and the container registry CDN
 * (e.g. "connection reset by peer" mid-blob-download). Bounded to a single
 * retry so we don't mask real failures or stretch out a doomed setup.
 */
const MACHINE_CREATE_TRANSIENT_RETRY_DELAY_MS = 8_000;

/** Nanosecond conversions (Fly API uses nanoseconds for health check intervals) */
const SECONDS_TO_NS = 1_000_000_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisionOptions {
  flyApiToken: string;
  region?: string;
  orgSlug?: string;
  onProgress?: (step: ProvisioningStep) => void;
  /**
   * Desired volume size in GB. Defaults to `DEFAULT_VOLUME_SIZE_GB` when
   * omitted. Stage 3 derives this from the user's footprint measurement.
   */
  volumeSizeGb?: number;
  /**
   * Desired VM performance tier for Fly machine guest sizing.
   * Defaults to the catalog default tier when omitted or unknown.
   */
  vmTierId?: string;
  /**
   * Sentry DSN to inject into the machine env (commercial builds thread the
   * desktop's own build-inlined DSN from main via `resolveCommercialCloudSentryDsn()`,
   * which is hard-gated off for OSS builds).
   * When undefined (OSS/dev builds) the env key is omitted entirely —
   * fail-open-to-off is the OSS no-phone-home contract. Kept as a plain
   * parameter so this boundary-clean core module never imports the
   * import.meta-dependent sentryConfig (cloud-service bundles core via esbuild).
   */
  sentryDsn?: string;
}

export interface ProvisioningStep {
  phase: 'validating' | 'creating-app' | 'setting-secrets' | 'creating-volume' | 'creating-machine' | 'waiting' | 'health-check' | 'complete' | 'failed';
  message: string;
  progress: number;
  failedStep?: number;
}

export interface ProvisionResult {
  success: boolean;
  cloudUrl?: string;
  cloudToken?: string;
  appName?: string;
  machineId?: string;
  volumeId?: string;
  region?: string;
  vmTierId?: VmTier['id'];
  error?: string;
  failedStep?: number;
  cleanedUp?: boolean;
  /**
   * Human-readable note shown when a failed provision rolled back a
   * partially-created app. Reassures the user that nothing is left behind
   * to bill for, so they can retry cleanly.
   */
  cleanupMessage?: string;
  /** Optional warning message set on a successful provision (e.g. health check didn't pass). */
  warning?: string;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

let provisioningInProgress = false;

export async function provisionCloudInstance(options: ProvisionOptions): Promise<ProvisionResult> {
  if (provisioningInProgress) {
    return { success: false, error: 'Provisioning is already in progress.' };
  }

  provisioningInProgress = true;
  const { flyApiToken, region = DEFAULT_REGION, orgSlug, onProgress } = options;
  const volumeSizeGb = options.volumeSizeGb ?? DEFAULT_VOLUME_SIZE_GB;
  const selectedTier = getTierById(options.vmTierId) ?? getDefaultTier();
  let appName: string | undefined;
  let currentStep = 0;

  const progress = (phase: ProvisioningStep['phase'], message: string, pct: number) => {
    onProgress?.({ phase, message, progress: pct });
  };

  try {
    // Step 1: Validate Fly PAT and resolve org
    currentStep = 1;
    progress('validating', 'Validating your Fly.io token...', 5);

    // Resolve the org slug: use provided value, or detect from the token
    let resolvedOrgSlug = orgSlug;
    if (!resolvedOrgSlug) {
      log.info('No org slug provided, detecting from token...');
      let orgsResp: { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
      try {
        orgsResp = await flyGraphQL(flyApiToken, `{ organizations { nodes { slug type } } }`, {});
      } catch (fetchErr) {
        const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        log.error({ err: fetchErr }, 'Failed to reach Fly.io GraphQL API');
        return { success: false, error: `Could not reach Fly.io to validate your token. Check your internet connection. (${message})`, failedStep: 1 };
      }
      if (orgsResp.errors?.length) {
        const errMsg = orgsResp.errors.map(e => e.message).join('; ');
        log.error({ errors: orgsResp.errors }, 'Fly GraphQL returned errors during org detection');
        // Fly orgs with SSO enforcement reject personal access tokens with
        // a "Single Sign On" message. Tag the error so the mapper routes
        // it to the dedicated sso_required category with CLI guidance.
        const isSsoError = /single sign[- ]on|sso required|requires sso/i.test(errMsg);
        if (isSsoError) {
          return {
            success: false,
            error: `[cloud:sso_required:fly] Your Fly organization requires SSO, so personal access tokens can\u2019t be created. Run \`fly tokens create org --org <your-org>\` in a terminal and paste the output. (${errMsg})`,
            failedStep: 1,
          };
        }
        return { success: false, error: `Your Fly.io token was rejected: ${errMsg}. Generate a new token at fly.io/user/personal_access_tokens or with "fly tokens create org".`, failedStep: 1 };
      }
      const orgsData = orgsResp?.data?.organizations as { nodes?: Array<{ slug: string; type: string }> } | undefined;
      const orgs = orgsData?.nodes;
      if (!orgs?.length) {
        log.error({ data: orgsResp.data }, 'Token has no organizations');
        return { success: false, error: 'Your Fly.io token does not have access to any organizations. Check that the token is valid and has not been revoked.', failedStep: 1 };
      }
      // Prefer a non-personal org if available, otherwise fall back to personal
      resolvedOrgSlug = orgs.find(o => o.type !== 'PERSONAL')?.slug ?? orgs[0].slug;
      log.info({ resolvedOrgSlug, orgCount: orgs.length, allOrgs: orgs.map(o => `${o.slug} (${o.type})`) }, 'Resolved org from token');
    }

    log.info({ orgSlug: resolvedOrgSlug }, 'Validating token against org...');
    const validateResp = await flyFetch(flyApiToken, `/v1/apps?org_slug=${resolvedOrgSlug}`);
    if (validateResp.status === 401) {
      log.error({ status: validateResp.status, orgSlug: resolvedOrgSlug }, 'Token rejected by Fly Machines API');
      return { success: false, error: `Invalid Fly.io token for org "${resolvedOrgSlug}". Generate a new token at fly.io/user/personal_access_tokens or with "fly tokens create org --org ${resolvedOrgSlug}".`, failedStep: 1 };
    }
    if (!validateResp.ok) {
      const body = await validateResp.text();
      log.error({ status: validateResp.status, body, orgSlug: resolvedOrgSlug }, 'Token validation failed');
      return { success: false, error: `Token validation failed (HTTP ${validateResp.status}): ${body}`, failedStep: 1 };
    }
    log.info({ orgSlug: resolvedOrgSlug }, 'Fly PAT validated');

    // Step 2: Generate app name + bridge token
    currentStep = 2;
    const suffix = randomBytes(4).toString('hex');
    appName = `${APP_NAME_PREFIX}${suffix}`;
    const cloudToken = randomBytes(32).toString('hex');

    // Step 3: Create Fly app
    currentStep = 3;
    log.info({ appName, orgSlug: resolvedOrgSlug, region }, 'Creating Fly app...');
    progress('creating-app', `Creating app ${appName}...`, 15);
    const createAppResp = await flyFetch(flyApiToken, '/v1/apps', {
      method: 'POST',
      body: JSON.stringify({ app_name: appName, org_slug: resolvedOrgSlug }),
    });

    if (!createAppResp.ok) {
      const body = await createAppResp.text();
      log.warn({ status: createAppResp.status, body, appName }, 'App creation failed, checking if retryable');
      if (createAppResp.status === 422 && body.includes('already exists')) {
        // Name collision — retry with new suffix
        const retrySuffix = randomBytes(4).toString('hex');
        appName = `${APP_NAME_PREFIX}${retrySuffix}`;
        log.info({ appName }, 'Retrying with new app name after collision');
        const retryResp = await flyFetch(flyApiToken, '/v1/apps', {
          method: 'POST',
          body: JSON.stringify({ app_name: appName, org_slug: resolvedOrgSlug }),
        });
        if (!retryResp.ok) {
          const retryBody = await retryResp.text();
          const err = parseFlyError(retryResp, retryBody);
          log.error({ status: retryResp.status, body: retryBody, appName }, 'App creation retry also failed');
          return { success: false, error: `Failed to create app in org "${resolvedOrgSlug}": ${err.message}`, failedStep: 3 };
        }
      } else if (createAppResp.status === 403) {
        return { success: false, error: `Your token does not have permission to create apps in org "${resolvedOrgSlug}". Ensure you have an org-scoped token with write access.`, failedStep: 3 };
      } else {
        const err = parseFlyError(createAppResp, body);
        return { success: false, error: `Failed to create app in org "${resolvedOrgSlug}": ${err.message}`, failedStep: 3 };
      }
    }
    log.info({ appName, orgSlug: resolvedOrgSlug }, 'Fly app created');

    // Step 4: Set secrets via GraphQL
    currentStep = 4;
    progress('setting-secrets', 'Setting up secure access...', 30);
    const setSecretsResult = await flyGraphQL(flyApiToken, `
      mutation($input: SetSecretsInput!) {
        setSecrets(input: $input) {
          app { name }
        }
      }
    `, {
      input: {
        appId: appName,
        secrets: [
          { key: 'REBEL_CLOUD_TOKEN', value: cloudToken },
          { key: 'FLY_API_TOKEN', value: flyApiToken },
        ],
      },
    });

    if (setSecretsResult.errors?.length) {
      const errMsg = setSecretsResult.errors.map(e => e.message).join('; ');
      log.error({ errors: setSecretsResult.errors, appName }, 'Failed to set secrets via GraphQL');
      const cleanedUp = await cleanupApp(flyApiToken, appName);
      return {
        success: false,
        error: `Failed to configure cloud access tokens on "${appName}": ${errMsg}. Your Fly token may lack permission to set secrets.`,
        failedStep: 4,
        cleanedUp,
        cleanupMessage: buildCleanupMessage(cleanedUp),
      };
    }
    log.info({ appName }, 'Secrets configured');

    // Step 5: Create volume
    currentStep = 5;
    progress('creating-volume', `Creating ${volumeSizeGb}GB storage volume...`, 45);
    const createVolumeResp = await flyFetch(flyApiToken, `/v1/apps/${appName}/volumes`, {
      method: 'POST',
      body: JSON.stringify({
        name: VOLUME_NAME,
        region,
        size_gb: volumeSizeGb,
        encrypted: true,
      }),
    });

    if (!createVolumeResp.ok) {
      const body = await createVolumeResp.text();
      log.error({ status: createVolumeResp.status, body, appName, region, sizeGb: volumeSizeGb }, 'Failed to create volume');
      const cleanedUp = await cleanupApp(flyApiToken, appName);
      const cleanupMessage = buildCleanupMessage(cleanedUp);
      // Provide specific guidance for common volume errors.
      // Note: the marker carries the org slug so the UI can deep-link to
      // the right billing page via resolveHelpUrl(). Matching is
      // case-insensitive and covers both 402 and 422 to survive minor API
      // wording / status variations from Fly.
      if (
        createVolumeResp.status === 402 ||
        (createVolumeResp.status === 422 && /payment method|billing required|add (a )?(credit )?card/i.test(body))
      ) {
        return {
          success: false,
          error: `[cloud:billing_required:${resolvedOrgSlug}] Fly.io requires a payment method before it can create storage over 20GB. Add a card at fly.io/dashboard/${resolvedOrgSlug}/billing, then try again.`,
          failedStep: 5,
          cleanedUp,
          cleanupMessage,
        };
      }
      // Fly signals "no host in this region can satisfy the request" in two
      // shapes: a 422 mentioning "capacity", and a 412 "insufficient resources
      // to create new machine with existing volume" (host-affinity capacity).
      // Both are the same actionable problem — try a different region.
      if (
        (createVolumeResp.status === 422 || createVolumeResp.status === 412) &&
        /capacity|insufficient resources/i.test(body)
      ) {
        return {
          success: false,
          error: `Not enough capacity in region "${region}" for a ${volumeSizeGb}GB volume. Try a different region.`,
          failedStep: 5,
          cleanedUp,
          cleanupMessage,
        };
      }
      return {
        success: false,
        error: `Failed to create ${volumeSizeGb}GB storage volume in region "${region}": ${body}`,
        failedStep: 5,
        cleanedUp,
        cleanupMessage,
      };
    }

    const volumeData = await createVolumeResp.json() as { id?: string };
    const volumeId = volumeData.id;
    if (!volumeId) {
      log.error({ volumeData }, 'Volume created but no ID returned');
      const cleanedUp = await cleanupApp(flyApiToken, appName);
      return {
        success: false,
        error: 'Volume created but response missing ID',
        failedStep: 5,
        cleanedUp,
        cleanupMessage: buildCleanupMessage(cleanedUp),
      };
    }
    log.info({ appName, volumeId, region }, 'Volume created');

    // Step 6: Create machine
    currentStep = 6;
    progress('creating-machine', 'Launching cloud instance...', 60);
    const machineConfig = {
      image: CLOUD_IMAGE,
      env: {
        PORT: '8080',
        IS_CLOUD_SERVICE: '1',
        NODE_ENV: 'production',
        // Config-env (not a Fly secret) deliberately: visible in the Machines
        // API for debuggability, and a DSN is a public identifier by design.
        // Key omitted when no DSN — OSS builds must never gain the key.
        ...(options.sentryDsn ? { SENTRY_DSN: options.sentryDsn } : {}),
      },
      services: [{
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'] },
        ],
        protocol: 'tcp',
        internal_port: 8080,
        force_instance_key: null,
        concurrency: { type: 'connections', hard_limit: 25, soft_limit: 20 },
        auto_start_machines: true,
        auto_stop_machines: 'off',
        min_machines_running: 1,
      }],
      mounts: [{ volume: volumeId, path: '/data' }],
      guest: toFlyGuestConfig(selectedTier),
      checks: {
        health: {
          type: 'http',
          port: 8080,
          path: '/api/health',
          interval: 15 * SECONDS_TO_NS,
          timeout: 5 * SECONDS_TO_NS,
          grace_period: 10 * SECONDS_TO_NS,
        },
      },
    };

    // Machine create is the most likely place to hit a transient CDN blip
    // (Fly's worker pulling our image from ghcr.io can fail with
    // "connection reset by peer" mid-blob-download). Retry once on those
    // signatures only; non-transient failures (auth, billing, capacity)
    // fall through to the existing error handlers without delay.
    let createMachineResp = await flyFetch(flyApiToken, `/v1/apps/${appName}/machines`, {
      method: 'POST',
      body: JSON.stringify({ name: 'rebel-main', region, config: machineConfig }),
    });
    let createMachineBody: string | undefined;

    if (!createMachineResp.ok) {
      createMachineBody = await createMachineResp.text();
      if (isTransientImagePullError(createMachineResp.status, createMachineBody)) {
        log.warn(
          { status: createMachineResp.status, body: createMachineBody, appName, region },
          'Machine create hit a transient image-pull error — retrying once',
        );
        progress('creating-machine', 'Network glitch — retrying...', 65);
        await new Promise((r) => setTimeout(r, MACHINE_CREATE_TRANSIENT_RETRY_DELAY_MS));
        createMachineResp = await flyFetch(flyApiToken, `/v1/apps/${appName}/machines`, {
          method: 'POST',
          body: JSON.stringify({ name: 'rebel-main', region, config: machineConfig }),
        });
        createMachineBody = createMachineResp.ok ? undefined : await createMachineResp.text();
        if (createMachineResp.ok) {
          log.info({ appName, region }, 'Machine create succeeded on retry');
        } else {
          log.error(
            { status: createMachineResp.status, body: createMachineBody, appName, region },
            'Machine create failed on retry — surfacing original failure',
          );
        }
      }
    }

    if (!createMachineResp.ok) {
      const body = createMachineBody ?? (await createMachineResp.text());
      log.error({ status: createMachineResp.status, body, appName, region }, 'Failed to create machine');
      const cleanedUp = await cleanupApp(flyApiToken, appName);
      const cleanupMessage = buildCleanupMessage(cleanedUp);
      // Fly signals "no host in this region can satisfy the request" in two
      // shapes: a 422 mentioning "capacity", and a 412 "insufficient resources
      // to create new machine with existing volume" — the latter is the
      // volume-host-affinity capacity case (the volume's home host can't fit
      // the machine). Both are the same actionable problem: try a different
      // region. Without the 412 branch this fell through to the generic
      // "Failed to launch" path, which maps to "temporary provider issue, safe
      // to retry" — sending the user straight back into the same wall.
      if (
        (createMachineResp.status === 422 || createMachineResp.status === 412) &&
        /capacity|insufficient resources/i.test(body)
      ) {
        return {
          success: false,
          error: `Not enough capacity in region "${region}" for this machine size. Try a different region.`,
          failedStep: 6,
          cleanedUp,
          cleanupMessage,
        };
      }
      // Some Fly accounts hit the payment-method wall at machine creation
      // rather than volume creation — forward the same billing_required
      // marker so the UI surfaces billing guidance either way. Match
      // case-insensitively and accept both 402 and 422 to cover API wording
      // variations.
      if (
        createMachineResp.status === 402 ||
        /payment method|billing required|add (a )?(credit )?card/i.test(body)
      ) {
        return {
          success: false,
          error: `[cloud:billing_required:${resolvedOrgSlug}] Fly.io requires a payment method before it can launch machines. Add a card at fly.io/dashboard/${resolvedOrgSlug}/billing, then try again.`,
          failedStep: 6,
          cleanedUp,
          cleanupMessage,
        };
      }
      return {
        success: false,
        error: `Failed to launch cloud instance in region "${region}": ${body}`,
        failedStep: 6,
        cleanedUp,
        cleanupMessage,
      };
    }

    const machineData = await createMachineResp.json() as { id?: string };
    const machineId = machineData.id;
    if (!machineId) {
      log.error({ machineData }, 'Machine created but no ID returned');
      const cleanedUp = await cleanupApp(flyApiToken, appName);
      return {
        success: false,
        error: 'Machine created but response missing ID',
        failedStep: 6,
        cleanedUp,
        cleanupMessage: buildCleanupMessage(cleanedUp),
      };
    }
    log.info({ appName, machineId }, 'Machine created');

    // Step 7: Allocate shared IPv4 for .fly.dev routing
    currentStep = 7;
    progress('waiting', 'Configuring network routing...', 72);
    try {
      await flyGraphQL(flyApiToken, `
        mutation($input: AllocateIPAddressInput!) {
          allocateIpAddress(input: $input) {
            ipAddress { address type }
          }
        }
      `, { input: { appId: appName, type: 'shared_v4' } });
      log.info({ appName }, 'Shared IPv4 allocated');
    } catch (ipErr) {
      // Non-fatal — some apps may already have IPs or work without
      log.warn({ err: ipErr, appName }, 'IP allocation failed (non-fatal)');
    }

    // Step 8: Wait for machine to reach started state
    currentStep = 8;
    progress('waiting', 'Waiting for instance to start...', 75);
    const waitResp = await flyFetch(flyApiToken, `/v1/apps/${appName}/machines/${machineId}/wait?state=started&timeout=60`, {
      signal: AbortSignal.timeout(70_000),
    });

    if (!waitResp.ok) {
      log.warn({ status: waitResp.status, appName, machineId }, 'Machine wait returned non-200, checking health anyway');
    } else {
      log.info({ appName, machineId }, 'Machine reached started state');
    }

    // Step 9: Poll health endpoint
    currentStep = 8;
    progress('health-check', 'Checking cloud service health...', 85);
    const cloudUrl = `https://${appName}.fly.dev`;
    log.info({ cloudUrl, timeoutMs: HEALTH_POLL_TIMEOUT_MS }, 'Polling health endpoint...');
    const healthOk = await pollHealth(cloudUrl, HEALTH_POLL_TIMEOUT_MS);

    if (!healthOk) {
      log.warn({ appName }, 'Health check timed out — machine may still be starting');
      // Don't clean up — the machine might just need more time.
      // Still return success so the user gets the connection details,
      // but note that health wasn't confirmed.
    }

    // Step 10: Done
    currentStep = 9;
    progress('complete', healthOk ? 'Cloud instance is ready.' : 'Instance created — still starting up.', 100);
    log.info({ appName, cloudUrl, machineId, volumeId, region, healthOk }, 'Provisioning complete');

    return {
      success: true,
      cloudUrl,
      cloudToken,
      appName,
      machineId,
      volumeId,
      region,
      vmTierId: selectedTier.id,
      ...(!healthOk && { warning: 'Your cloud instance was created but is still starting up. It may take a few more minutes to become fully available.' }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('timeout') || message.includes('abort');
    const isNetwork = message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('fetch failed');
    log.error({ err, step: currentStep, appName, isTimeout, isNetwork }, 'Provisioning failed with exception');

    let cleanedUp = false;
    if (appName && currentStep >= 3) {
      cleanedUp = await cleanupApp(flyApiToken, appName);
    }

    let userMessage = message;
    if (isTimeout) {
      userMessage = `Request to Fly.io timed out at step ${currentStep}. This usually means the Fly API is slow or unreachable. Try again in a few minutes.`;
    } else if (isNetwork) {
      userMessage = `Could not reach Fly.io (${message}). Check your internet connection and try again.`;
    }

    progress('failed', `Provisioning failed: ${userMessage}`, 0);

    return {
      success: false,
      error: userMessage,
      failedStep: currentStep,
      cleanedUp,
      ...(cleanedUp || (appName && currentStep >= 3)
        ? { cleanupMessage: buildCleanupMessage(cleanedUp) }
        : {}),
    };
  } finally {
    provisioningInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Deprovision
// ---------------------------------------------------------------------------

export async function destroyCloudInstance(
  flyApiToken: string,
  appName: string,
): Promise<{ success: boolean; error?: string }> {
  if (!appName.startsWith(APP_NAME_PREFIX)) {
    return { success: false, error: `Safety check failed: app name "${appName}" does not start with "${APP_NAME_PREFIX}"` };
  }

  try {
    log.info({ appName }, 'Destroying cloud instance');
    const resp = await flyFetch(flyApiToken, `/v1/apps/${appName}?force=true`, {
      method: 'DELETE',
    });

    if (!resp.ok && resp.status !== 404) {
      const body = await resp.text();
      return { success: false, error: `Failed to delete app: ${body}` };
    }

    log.info({ appName }, 'Cloud instance destroyed');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appName }, 'Failed to destroy cloud instance');
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getFlyMachineStatus(
  flyApiToken: string,
  appName: string,
  machineId: string,
): Promise<{ state: string; error?: string }> {
  try {
    const resp = await flyFetch(flyApiToken, `/v1/apps/${appName}/machines/${machineId}`);
    if (!resp.ok) {
      return { state: 'unknown', error: `HTTP ${resp.status}` };
    }
    const data = await resp.json() as { state: string };
    return { state: data.state };
  } catch (err) {
    return { state: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Lookup (for linking a Fly token to an already-connected instance)
// ---------------------------------------------------------------------------

export interface LookupResult {
  success: boolean;
  appName?: string;
  machineId?: string;
  volumeId?: string;
  region?: string;
  error?: string;
}

/**
 * Validate a Fly API token and look up machine/volume metadata for an
 * already-connected cloud instance.  Used by the "link Fly token" flow
 * so BYOK features (updates, deprovision) work on manually-connected instances.
 */
export async function lookupFlyInstance(
  flyApiToken: string,
  appName: string,
): Promise<LookupResult> {
  const lookupLog = createScopedLogger({ service: 'fly-lookup', appName });

  // 1. Validate the token
  try {
    const validateResp = await flyFetch(flyApiToken, `/v1/apps/${appName}`);
    if (validateResp.status === 401) {
      return { success: false, error: 'Invalid Fly.io token. Check it at fly.io/user/personal_access_tokens' };
    }
    if (validateResp.status === 404) {
      return { success: false, error: `App "${appName}" not found on Fly.io` };
    }
    if (!validateResp.ok) {
      lookupLog.warn({ status: validateResp.status }, 'Token validation returned non-OK status');
      return { success: false, error: 'Token validation failed. Try generating a new token at fly.io/user/personal_access_tokens' };
    }
    lookupLog.info('Fly PAT validated');
  } catch (err) {
    const _message = err instanceof Error ? err.message : String(err);
    lookupLog.error({ err }, 'Token validation request failed');
    return { success: false, error: 'Could not reach Fly.io. Check your internet connection and try again.' };
  }

  // 2. List machines for the app
  let machineId: string | undefined;
  let region: string | undefined;
  try {
    const machinesResp = await flyFetch(flyApiToken, `/v1/apps/${appName}/machines`);
    if (machinesResp.status === 404) {
      return { success: false, error: `App "${appName}" not found on Fly.io` };
    }
    if (!machinesResp.ok) {
      lookupLog.warn({ status: machinesResp.status }, 'Machine listing returned non-OK status');
      return { success: false, error: `Could not access app "${appName}" on Fly.io. Your token may not have permission.` };
    }

    const machines = (await machinesResp.json()) as Array<{
      id: string;
      state: string;
      region: string;
    }>;

    if (machines.length === 0) {
      return { success: false, error: `App "${appName}" has no machines` };
    }

    // Prefer a started machine; fall back to any
    const started = machines.find((m) => m.state === 'started');
    const picked = started ?? machines[0];
    machineId = picked.id;
    region = picked.region;

    if (machines.length > 1) {
      lookupLog.warn({ count: machines.length, picked: machineId }, 'Multiple machines found — using first match');
    }
    lookupLog.info({ machineId, region, state: picked.state }, 'Machine found');
  } catch (err) {
    const _message = err instanceof Error ? err.message : String(err);
    lookupLog.error({ err }, 'Machine lookup request failed');
    return { success: false, error: 'Could not reach Fly.io. Check your internet connection and try again.' };
  }

  // 3. List volumes (optional — don't fail if none)
  let volumeId: string | undefined;
  try {
    const volumesResp = await flyFetch(flyApiToken, `/v1/apps/${appName}/volumes`);
    if (volumesResp.ok) {
      const volumes = (await volumesResp.json()) as Array<{
        id: string;
        name: string;
      }>;
      const dataVolume = volumes.find((v) => v.name === VOLUME_NAME);
      if (dataVolume) {
        volumeId = dataVolume.id;
        lookupLog.info({ volumeId }, 'Data volume found');
      } else {
        lookupLog.info('No rebel_data volume found (non-fatal)');
      }
    }
  } catch (err) {
    lookupLog.warn({ err }, 'Volume lookup failed (non-fatal)');
  }

  return { success: true, appName, machineId, volumeId, region };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic: did the machine-create call fail because of a transient
 * network glitch between Fly and the container registry (e.g. ghcr.io
 * blob fetch interrupted by "connection reset by peer")? Mirrors the
 * `image_pull_transient` rule in `cloudErrorMapper.ts` — keep them in
 * sync if you change the patterns here.
 *
 * **Status allow-list:** only `400` is treated as retryable. The real-world
 * Fly response for an interrupted image pull is a 400 with the body
 * describing the upstream blob/manifest fetch failure. Other statuses
 * (5xx in particular) are intentionally excluded because they leave the
 * machine-create call in an ambiguous state — the first POST may have
 * partially succeeded, and a retry could create a duplicate machine. If
 * Fly's behavior changes, expand this list deliberately rather than
 * defaulting to permissive.
 */
export function isTransientImagePullError(status: number, body: string): boolean {
  if (status !== 400) return false;
  const isImagePull = /failed to get (blob|manifest)/i.test(body) || /failed to launch/i.test(body);
  if (!isImagePull) return false;
  return (
    /connection reset by peer/i.test(body) ||
    /read tcp [^\n]*: read:/i.test(body) ||
    /i\/o timeout/i.test(body) ||
    /connection refused/i.test(body)
  );
}

async function cleanupApp(token: string, appName: string): Promise<boolean> {
  try {
    log.info({ appName }, 'Cleaning up failed provisioning');
    const resp = await flyFetch(token, `/v1/apps/${appName}?force=true`, { method: 'DELETE' });
    const ok = resp.ok || resp.status === 404;
    if (ok) log.info({ appName }, 'Cleanup successful');
    else log.warn({ appName, status: resp.status }, 'Cleanup returned non-200');
    return ok;
  } catch (err) {
    log.warn({ err, appName }, 'Cleanup failed');
    return false;
  }
}

/**
 * User-facing note describing what we did on failure, so the user knows
 * whether anything is left behind on their cloud account. Keeps tone
 * calm and factual (Rebel voice: useful > reassuring).
 */
function buildCleanupMessage(cleanedUp: boolean): string {
  return cleanedUp
    ? 'We rolled back the half-built app on Fly, so nothing is left to pay for. Safe to retry.'
    : 'Heads up: we could not fully roll back the partial setup. Check fly.io/dashboard for any leftover app starting with "rebel-cloud-" and remove it if you see one.';
}

async function pollHealth(cloudUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${cloudUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (resp.ok) {
        const body = await resp.json() as { status?: string };
        if (body.status === 'ok') return true;
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}
