/**
 * Cloud Update Service
 *
 * Platform-agnostic logic for:
 * - Checking GHCR for the latest production cloud image tag
 * - Comparing it against the running cloud instance version header
 * - Updating Fly Machines to the latest image
 */

import { createScopedLogger } from '@core/logger';
import { flyFetch, flyGraphQL, updateMachineConfig } from './flyApiClient';

const log = createScopedLogger({ service: 'cloud-update-service' });

export type CloudUpdateChannel = 'stable' | 'beta';

/**
 * Derive the cloud update channel from the desktop build channel.
 * Stable builds default to 'stable' cloud images; beta/dev builds default to 'beta'.
 * This is the fallback when the user hasn't explicitly set a channel override.
 */
export function getCloudUpdateChannel(buildChannel: 'stable' | 'beta' | 'dev'): CloudUpdateChannel {
  return buildChannel === 'stable' ? 'stable' : 'beta';
}

const CHANNEL_TAG_PREFIX: Record<CloudUpdateChannel, string> = {
  stable: 'prod',
  beta: 'dev',
};

const GHCR_TOKEN_URL = 'https://ghcr.io/token?scope=repository:mindstone/rebel-cloud:pull';
const GHCR_TAGS_URL = 'https://ghcr.io/v2/mindstone/rebel-cloud/tags/list';
const GHCR_MANIFEST_URL_PREFIX = 'https://ghcr.io/v2/mindstone/rebel-cloud/manifests/';
const GHCR_BLOB_URL_PREFIX = 'https://ghcr.io/v2/mindstone/rebel-cloud/blobs/';
const CLOUD_IMAGE_REPO = 'ghcr.io/mindstone/rebel-cloud';
const HEALTH_PATH = '/api/health';
const HEALTH_POLL_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 3_000;

interface GhcrPackageVersion {
  metadata?: {
    container?: {
      tags?: string[];
    };
  };
}

interface FlyMachine {
  state?: string;
  version?: number;
  config?: Record<string, unknown> & {
    image?: string;
  };
}

export interface LatestTagResult {
  tag?: string;
  rateLimited?: boolean;
  error?: string;
}

export interface CheckForCloudUpdateParams {
  cloudUrl: string;
  flyAppName?: string;
  channel?: CloudUpdateChannel;
}

export interface CloudUpdateCheckResult {
  success: boolean;
  updateAvailable: boolean;
  latestTag?: string;
  latestImage?: string;
  runningVersion?: string;
  rateLimited?: boolean;
  error?: string;
}

export interface ApplyCloudUpdateParams {
  flyApiToken: string;
  flyAppName: string;
  flyMachineId: string;
  cloudUrl: string;
  latestTag?: string;
  channel?: CloudUpdateChannel;
}

export interface CloudUpdateApplyResult {
  success: boolean;
  updated: boolean;
  latestTag?: string;
  targetImage?: string;
  machineStateBefore?: string;
  startedMachine?: boolean;
  runningVersion?: string;
  rateLimited?: boolean;
  error?: string;
}

function normalizeCloudUrl(cloudUrl: string): string {
  return cloudUrl.replace(/\/+$/, '');
}

function getCloudHealthUrl(cloudUrl: string): string {
  return `${normalizeCloudUrl(cloudUrl)}${HEALTH_PATH}`;
}

function normalizeVersion(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') {
    return null;
  }
  return normalized;
}

export function extractCommitFromTag(tag: string): string | null {
  const normalized = normalizeVersion(tag);
  if (!normalized) {
    return null;
  }

  const match = /^(?:prod|dev)-(.+)$/i.exec(normalized);
  return match?.[1] ?? null;
}

/**
 * Returns true when the running cloud version should be considered current for the target tag.
 * Supports short/long SHA comparisons and both raw commit/hash and `prod-*`/`dev-*` header formats.
 */
export function isCloudVersionCurrent(
  runningVersion: string | null | undefined,
  latestTag: string,
): boolean {
  const normalizedRunning = normalizeVersion(runningVersion);
  if (!normalizedRunning) {
    return false;
  }

  const normalizedTag = normalizeVersion(latestTag);
  if (!normalizedTag) {
    return false;
  }

  const latestCommit = extractCommitFromTag(normalizedTag);
  if (!latestCommit) {
    return false;
  }

  if (normalizedRunning === normalizedTag || normalizedRunning === latestCommit) {
    return true;
  }

  if (normalizedRunning.startsWith(latestCommit) || latestCommit.startsWith(normalizedRunning)) {
    return true;
  }

  const runningCommit = extractCommitFromTag(normalizedRunning);
  if (!runningCommit) {
    return false;
  }

  return (
    runningCommit === latestCommit ||
    runningCommit.startsWith(latestCommit) ||
    latestCommit.startsWith(runningCommit)
  );
}

export function extractLatestProdTag(versions: GhcrPackageVersion[]): string | null {
  for (const version of versions) {
    const tags = version.metadata?.container?.tags ?? [];
    if (!tags.includes('prod-latest')) {
      continue;
    }

    const prodShaTag = tags.find((tag) => /^prod-(?!latest$).+/i.test(tag));
    if (prodShaTag) {
      return prodShaTag;
    }
  }

  return null;
}

type GhcrTokenResult =
  | { token: string }
  | { error: string };

async function fetchGhcrAnonymousToken(): Promise<GhcrTokenResult> {
  try {
    const resp = await fetch(GHCR_TOKEN_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const bodySnippet = body.slice(0, 200);
      log.warn(
        { status: resp.status, statusText: resp.statusText, bodySnippet },
        'GHCR anonymous token endpoint returned non-OK status',
      );
      const rateLimited = resp.status === 429 || resp.status === 403;
      return {
        error: rateLimited
          ? `GHCR rate-limited the token request (HTTP ${resp.status}). Try again in a few minutes.`
          : `GHCR token request failed: HTTP ${resp.status}${bodySnippet ? ` — ${bodySnippet}` : ''}`,
      };
    }
    let data: { token?: string };
    try {
      data = (await resp.json()) as { token?: string };
    } catch (parseErr) {
      log.warn({ err: parseErr }, 'GHCR token response was not valid JSON');
      return { error: 'GHCR token response was not valid JSON.' };
    }
    if (!data.token) {
      log.warn(
        { keys: Object.keys(data) },
        'GHCR token response missing token field',
      );
      return { error: 'GHCR token response was missing the token field.' };
    }
    return { token: data.token };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, isTimeout }, 'GHCR anonymous token fetch failed');
    return {
      error: isTimeout
        ? 'GHCR token request timed out after 10 seconds (likely transient network issue).'
        : `GHCR token request failed: ${message}`,
    };
  }
}

/**
 * Resolve the abbreviated build commit that `{prefix}-latest` points to by
 * inspecting the OCI image manifest and reading the image config labels.
 *
 * Prefers the `org.opencontainers.image.version` label, which docker/metadata-action
 * sets to the exact primary tag (e.g. `dev-e79a95f2`). Its SHA suffix carries the
 * EXACT git abbreviation length CI used. We must NOT reconstruct the SHA by slicing
 * the full 40-char `revision` label to a fixed length: `git rev-parse --short` grows
 * the abbreviation as the repo accumulates objects (7 -> 8 -> 9 chars), so a fixed
 * 7-char slice produces non-existent tags like `dev-e79a95f` that 404 against the
 * real `dev-e79a95f2`. See docs-private/investigations/260531_cloud_self_update_sha_length_mismatch.md.
 */
async function resolveLatestCommitViaManifest(
  token: string,
  prefix: string,
): Promise<{ commit: string } | { error: string } | { rateLimited: true }> {
  const tag = `${prefix}-latest`;

  // 1. Fetch manifest (accept both single-platform and manifest list/index)
  const manifestResp = await fetch(`${GHCR_MANIFEST_URL_PREFIX}${tag}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: [
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
      ].join(', '),
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (manifestResp.status === 403 || manifestResp.status === 429) {
    return { rateLimited: true };
  }
  if (manifestResp.status === 404) {
    return { error: `Tag ${tag} not found in GHCR registry.` };
  }
  if (!manifestResp.ok) {
    return { error: `Manifest fetch failed: HTTP ${manifestResp.status}` };
  }

  let manifest = await manifestResp.json() as Record<string, unknown>;

  // If manifest list/index, follow the first platform reference
  const manifests = manifest.manifests as Array<{ digest?: string }> | undefined;
  if (Array.isArray(manifests)) {
    const first = manifests[0];
    if (!first?.digest) return { error: 'Manifest list has no entries' };

    const platformResp = await fetch(`${GHCR_MANIFEST_URL_PREFIX}${first.digest}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!platformResp.ok) {
      return { error: `Platform manifest fetch failed: HTTP ${platformResp.status}` };
    }
    manifest = await platformResp.json() as Record<string, unknown>;
  }

  // 2. Extract config blob digest
  const config = manifest.config as { digest?: string } | undefined;
  const configDigest = config?.digest;
  if (!configDigest) return { error: 'Manifest missing config digest' };

  // 3. Fetch config blob to read labels
  const configResp = await fetch(`${GHCR_BLOB_URL_PREFIX}${configDigest}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!configResp.ok) {
    return { error: `Config blob fetch failed: HTTP ${configResp.status}` };
  }

  const imageConfig = await configResp.json() as {
    config?: { Labels?: Record<string, string> };
  };
  const labels = imageConfig.config?.Labels ?? {};
  const version = labels['org.opencontainers.image.version'];
  const revision = labels['org.opencontainers.image.revision'];

  // Primary: extract the SHA suffix from the exact tag in the `version` label.
  // The hex suffix (e.g. `e79a95f2` in `dev-e79a95f2`) is the exact abbreviation
  // CI used, and is identical across every tag of that build — so re-applying the
  // channel prefix (`${prefix}-${sha}`) yields a tag that actually exists for both
  // the `dev` and `prod` channels.
  const versionSha = version ? /-([0-9a-f]{7,40})$/i.exec(version)?.[1] : undefined;
  if (versionSha) {
    return { commit: versionSha.toLowerCase() };
  }

  // Fallback: we have the full 40-char revision but cannot know the abbreviation
  // length CI used, so reconstructing the tag from a fixed-length slice is unsafe
  // (that was the original bug). Signal an error so fetchLatestTag falls through to
  // the tag-list path, which only returns tags that actually exist in the registry.
  if (revision) {
    return {
      error: `Image config has revision (${revision.slice(0, 12)}) but no usable version label; deferring to tag-list fallback.`,
    };
  }

  return { error: 'Image config missing org.opencontainers.image.version and revision labels' };
}

/**
 * Fallback: list all tags and pick the last alphabetically-sorted SHA tag.
 * This is unreliable (hex sort != chronological order) but serves as a
 * last resort when manifest inspection fails.
 */
async function fetchLatestTagByTagList(token: string, prefix: string): Promise<LatestTagResult> {
  const resp = await fetch(GHCR_TAGS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (resp.status === 403 || resp.status === 429) {
    return { rateLimited: true };
  }
  if (!resp.ok) {
    const body = await resp.text();
    return { error: `GHCR tags request failed: HTTP ${resp.status} ${body}` };
  }

  const data = await resp.json() as { tags?: string[] };
  const tags = data.tags ?? [];

  const shaTagPattern = new RegExp('^' + prefix + '-(?!latest$).+', 'i');
  const shaTags = tags.filter((tag) => shaTagPattern.test(tag)).sort();

  if (shaTags.length === 0) {
    return { error: `No ${prefix}-* tags found in GHCR registry.` };
  }

  return { tag: shaTags[shaTags.length - 1] };
}

export async function fetchLatestTag(channel: CloudUpdateChannel = 'stable'): Promise<LatestTagResult> {
  const prefix = CHANNEL_TAG_PREFIX[channel];

  try {
    const tokenResult = await fetchGhcrAnonymousToken();
    if ('error' in tokenResult) {
      return { error: tokenResult.error };
    }
    const token = tokenResult.token;

    // Primary: resolve {prefix}-latest manifest to find the exact build commit
    const resolved = await resolveLatestCommitViaManifest(token, prefix);
    if ('rateLimited' in resolved) return { rateLimited: true };
    if ('commit' in resolved) return { tag: `${prefix}-${resolved.commit}` };

    // Fallback: tag list (unreliable alphabetical sort, but better than nothing)
    log.warn({ channel, error: resolved.error }, 'Manifest resolution failed; falling back to tag list');
    return fetchLatestTagByTagList(token, prefix);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch GHCR tags: ${message}` };
  }
}

function imageReferencesTag(imageRef: string | undefined, tag: string): boolean {
  if (!imageRef) {
    return false;
  }
  return imageRef === `${CLOUD_IMAGE_REPO}:${tag}` || imageRef.endsWith(`:${tag}`);
}

export async function pollCloudHealth(
  cloudUrl: string,
  timeoutMs: number,
): Promise<{ healthy: boolean; runningVersion?: string; error?: string }> {
  const start = Date.now();
  let lastError = 'Timed out waiting for cloud health check.';

  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(getCloudHealthUrl(cloudUrl), {
        signal: AbortSignal.timeout(5_000),
      });

      if (resp.ok) {
        const runningVersion = resp.headers.get('x-rebel-cloud-version')?.trim() || undefined;
        return { healthy: true, runningVersion };
      }

      lastError = `Health endpoint returned HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  return { healthy: false, error: lastError };
}

export async function checkForCloudUpdate(
  params: CheckForCloudUpdateParams,
): Promise<CloudUpdateCheckResult> {
  const { cloudUrl, flyAppName } = params;

  const latest = await fetchLatestTag(params.channel ?? 'stable');
  if (latest.rateLimited) {
    return { success: true, updateAvailable: false, rateLimited: true };
  }
  if (!latest.tag) {
    log.warn({ error: latest.error, flyAppName }, 'Cloud update check failed during GHCR lookup');
    return { success: false, updateAvailable: false, error: latest.error ?? 'Failed to resolve latest cloud image tag.' };
  }

  try {
    const healthResp = await fetch(getCloudHealthUrl(cloudUrl), {
      signal: AbortSignal.timeout(10_000),
    });

    if (!healthResp.ok) {
      const error = `Cloud health check failed: HTTP ${healthResp.status}`;
      log.warn({ flyAppName, cloudUrl, latestTag: latest.tag, status: healthResp.status }, error);
      return { success: false, updateAvailable: false, latestTag: latest.tag, latestImage: `${CLOUD_IMAGE_REPO}:${latest.tag}`, error };
    }

    const runningVersion = healthResp.headers.get('x-rebel-cloud-version')?.trim();
    if (!runningVersion) {
      const error = 'Cloud health response missing X-Rebel-Cloud-Version header.';
      log.warn({ flyAppName, cloudUrl, latestTag: latest.tag }, error);
      return { success: false, updateAvailable: false, latestTag: latest.tag, latestImage: `${CLOUD_IMAGE_REPO}:${latest.tag}`, error };
    }

    const updateAvailable = !isCloudVersionCurrent(runningVersion, latest.tag);
    log.info({ flyAppName, cloudUrl, runningVersion, latestTag: latest.tag, updateAvailable }, 'Cloud update check complete');

    return {
      success: true,
      updateAvailable,
      latestTag: latest.tag,
      latestImage: `${CLOUD_IMAGE_REPO}:${latest.tag}`,
      runningVersion,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, flyAppName, cloudUrl }, 'Cloud update check failed during health probe');
    return {
      success: false,
      updateAvailable: false,
      latestTag: latest.tag,
      latestImage: `${CLOUD_IMAGE_REPO}:${latest.tag}`,
      error: message,
    };
  }
}

export async function applyCloudUpdate(
  params: ApplyCloudUpdateParams,
): Promise<CloudUpdateApplyResult> {
  const { flyApiToken, flyAppName, flyMachineId, cloudUrl } = params;

  let latestTag = params.latestTag;
  if (!latestTag) {
    const latest = await fetchLatestTag(params.channel ?? 'stable');
    if (latest.rateLimited) {
      return { success: false, updated: false, rateLimited: true, error: 'GHCR request rate-limited.' };
    }
    if (!latest.tag) {
      return { success: false, updated: false, error: latest.error ?? 'Failed to resolve latest cloud image tag.' };
    }
    latestTag = latest.tag;
  }

  const targetImage = `${CLOUD_IMAGE_REPO}:${latestTag}`;

  try {
    const machineResp = await flyFetch(
      flyApiToken,
      `/v1/apps/${flyAppName}/machines/${flyMachineId}`,
    );

    if (!machineResp.ok) {
      const body = await machineResp.text();
      return {
        success: false,
        updated: false,
        latestTag,
        targetImage,
        error: `Failed to load Fly machine: HTTP ${machineResp.status} ${body}`,
      };
    }

    const machine = await machineResp.json() as FlyMachine;
    const machineStateBefore = machine.state ?? 'unknown';
    const currentImage = machine.config?.image;

    if (imageReferencesTag(currentImage, latestTag)) {
      log.info({ flyAppName, flyMachineId, currentImage, latestTag }, 'Fly machine already uses latest cloud image; skipping update');
      return {
        success: true,
        updated: false,
        latestTag,
        targetImage,
        machineStateBefore,
      };
    }

    const updateResult = await updateMachineConfig(
      flyApiToken,
      flyAppName,
      flyMachineId,
      (config) => ({ ...config, image: targetImage }),
    );

    if (!updateResult.success) {
      return {
        success: false,
        updated: false,
        latestTag,
        targetImage,
        machineStateBefore,
        error: updateResult.error ?? 'Machine config update failed.',
      };
    }

    let startedMachine = false;
    if (machineStateBefore !== 'started') {
      const startResp = await flyFetch(
        flyApiToken,
        `/v1/apps/${flyAppName}/machines/${flyMachineId}/start`,
        { method: 'POST' },
      );

      if (!startResp.ok && startResp.status !== 409) {
        const body = await startResp.text();
        return {
          success: false,
          updated: false,
          latestTag,
          targetImage,
          machineStateBefore,
          error: `Failed to start machine after update: HTTP ${startResp.status} ${body}`,
        };
      }

      startedMachine = startResp.ok;
    }

    const health = await pollCloudHealth(cloudUrl, HEALTH_POLL_TIMEOUT_MS);
    if (!health.healthy) {
      return {
        success: false,
        updated: false,
        latestTag,
        targetImage,
        machineStateBefore,
        startedMachine,
        error: health.error ?? 'Cloud did not become healthy after update.',
      };
    }

    if (!isCloudVersionCurrent(health.runningVersion, latestTag)) {
      return {
        success: false,
        updated: false,
        latestTag,
        targetImage,
        machineStateBefore,
        startedMachine,
        runningVersion: health.runningVersion,
        error: `Cloud became healthy but reported version "${health.runningVersion ?? 'unknown'}", expected ${latestTag}.`,
      };
    }

    log.info({ flyAppName, flyMachineId, latestTag, targetImage, machineStateBefore, startedMachine }, 'Cloud update applied successfully');

    return {
      success: true,
      updated: true,
      latestTag,
      targetImage,
      machineStateBefore,
      startedMachine,
      runningVersion: health.runningVersion,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, flyAppName, flyMachineId, latestTag }, 'Failed to apply cloud update');
    return {
      success: false,
      updated: false,
      latestTag,
      targetImage,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Machine-env token repair
// ---------------------------------------------------------------------------

export interface RepairTokenResult {
  success: boolean;
  conflict?: boolean;
  restarted?: boolean;
  alreadyCorrect?: boolean;
  error?: string;
}

/**
 * Repair REBEL_CLOUD_TOKEN in the Fly machine environment.
 *
 * CRITICAL: Fly secrets (set via `setSecrets` GraphQL) are NOT visible in
 * the Machines API `config.env` response. "Absent from config.env" does NOT
 * prove the token is missing — it may exist as a runtime-injected Fly secret.
 * Therefore this function ALWAYS requires the caller to have verified that
 * authenticated requests actually fail before invoking.
 *
 * Token states in config.env:
 * - absent → may be a Fly secret or truly missing. Write requires confirmation.
 * - present and matches localToken → token is configured but may not be active.
 * - present and differs → conflict with another device. Requires force=true.
 */
export async function repairMachineEnvToken(params: {
  flyApiToken: string;
  flyAppName: string;
  flyMachineId: string;
  localToken: string;
  cloudUrl: string;
  force?: boolean;
}): Promise<RepairTokenResult> {
  const { flyApiToken, flyAppName, flyMachineId, localToken, cloudUrl, force } = params;

  try {
    // 1. Fetch current machine config to inspect env
    const getResp = await flyFetch(flyApiToken, `/v1/apps/${flyAppName}/machines/${flyMachineId}`);
    if (!getResp.ok) {
      return { success: false, error: `Failed to fetch machine: HTTP ${getResp.status}` };
    }

    const machine = await getResp.json() as {
      config?: { env?: Record<string, string> };
    };

    const currentEnvToken = machine.config?.env?.REBEL_CLOUD_TOKEN;

    // 2. Check token state
    if (currentEnvToken === localToken) {
      return { success: true, alreadyCorrect: true };
    }

    if (currentEnvToken && currentEnvToken !== localToken && !force) {
      return { success: false, conflict: true, error: 'Remote token differs from local. Another device may be paired. Use force to overwrite.' };
    }

    // 3. Write token via updateMachineConfig
    const result = await updateMachineConfig(
      flyApiToken,
      flyAppName,
      flyMachineId,
      (config) => ({
        ...config,
        env: {
          ...(config.env as Record<string, string> | undefined),
          REBEL_CLOUD_TOKEN: localToken,
        },
      }),
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // 4. Poll authenticated /api/settings to confirm
    const authOk = await pollAuthenticatedHealth(cloudUrl, localToken, 60_000);
    if (!authOk) {
      log.warn({ flyAppName }, 'Token repair succeeded but authenticated check still failing');
    }

    return { success: true, restarted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, flyAppName, flyMachineId }, 'repairMachineEnvToken failed');
    return { success: false, error: message };
  }
}

async function pollAuthenticatedHealth(cloudUrl: string, token: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${cloudUrl}/api/settings`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 3_000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// FLY_API_TOKEN secret repair — bootstrap cloud-side self-update for
// pre-existing instances provisioned before the secret was added.
// ---------------------------------------------------------------------------

export interface SetFlyApiTokenSecretResult {
  success: boolean;
  error?: string;
}

/**
 * Write FLY_API_TOKEN as a Fly secret on the user's cloud app.
 *
 * Why: pre-existing instances provisioned before flyProvisioningService began
 * setting FLY_API_TOKEN can't run their own self-updater (it bails when the
 * env var is missing). The desktop has the user's Fly token in the keychain;
 * this function uses it to bootstrap the cloud-side updater so the cloud can
 * keep itself current without the desktop being online.
 *
 * Idempotent on Fly's side: setSecrets stores the value; if it matches the
 * existing value Fly treats it as a no-op. The new value only becomes visible
 * to the running process on next machine restart — caller is responsible for
 * triggering one (or relying on the next image update's restart).
 */
export async function setFlyApiTokenSecret(params: {
  flyApiToken: string;
  flyAppName: string;
}): Promise<SetFlyApiTokenSecretResult> {
  return setFlyAppSecret({
    flyApiToken: params.flyApiToken,
    flyAppName: params.flyAppName,
    key: 'FLY_API_TOKEN',
    value: params.flyApiToken,
  });
}

/**
 * Write SENTRY_DSN as a Fly secret on the user's cloud app.
 *
 * Why: the OSS content scrub removed the hardcoded cloud Sentry DSN, so
 * instances provisioned before SENTRY_DSN was added to the machine-create env
 * (flyProvisioningService) run with Sentry silently disabled. The desktop's
 * commercial build carries the DSN build-inlined; the update scheduler uses
 * this to backfill the existing fleet. Same activation semantics as
 * setFlyApiTokenSecret: visible to the running process on next restart
 * (e.g. the next image update from either updater).
 */
export async function setSentryDsnSecret(params: {
  flyApiToken: string;
  flyAppName: string;
  sentryDsn: string;
}): Promise<SetFlyApiTokenSecretResult> {
  return setFlyAppSecret({
    flyApiToken: params.flyApiToken,
    flyAppName: params.flyAppName,
    key: 'SENTRY_DSN',
    value: params.sentryDsn,
  });
}

/** Shared setSecrets GraphQL plumbing for the single-secret repair helpers above. */
async function setFlyAppSecret(params: {
  flyApiToken: string;
  flyAppName: string;
  key: string;
  value: string;
}): Promise<SetFlyApiTokenSecretResult> {
  const { flyApiToken, flyAppName, key, value } = params;

  try {
    const result = await flyGraphQL(
      flyApiToken,
      `mutation($input: SetSecretsInput!) {
        setSecrets(input: $input) {
          app { name }
        }
      }`,
      {
        input: {
          appId: flyAppName,
          secrets: [{ key, value }],
        },
      },
    );

    if (result.errors?.length) {
      const errMsg = result.errors.map((e) => e.message).join('; ');
      log.warn({ flyAppName, secretKey: key, errors: result.errors }, `Failed to set ${key} secret on cloud app`);
      return { success: false, error: errMsg };
    }

    log.info({ flyAppName, secretKey: key }, `${key} secret set on cloud app`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, flyAppName, secretKey: key }, 'setFlyAppSecret failed');
    return { success: false, error: message };
  }
}

export interface RepairFlyApiTokenEagerResult {
  success: boolean;
  alreadyRepaired?: boolean;
  restarted?: boolean;
  error?: string;
}

/**
 * Eager variant for manual repair from the UI: writes the secret AND restarts
 * the machine so the cloud-side self-updater picks it up immediately. The
 * scheduler-driven path (used during automatic updates) skips the restart and
 * lets the in-flight update's own restart serve both purposes.
 */
export async function repairFlyApiTokenSecretEager(params: {
  flyApiToken: string;
  flyAppName: string;
  flyMachineId: string;
}): Promise<RepairFlyApiTokenEagerResult> {
  const { flyApiToken, flyAppName, flyMachineId } = params;

  const setResult = await setFlyApiTokenSecret({ flyApiToken, flyAppName });
  if (!setResult.success) {
    return { success: false, error: setResult.error };
  }

  try {
    const restartResp = await flyFetch(
      flyApiToken,
      `/v1/apps/${flyAppName}/machines/${flyMachineId}/restart`,
      { method: 'POST' },
    );

    if (!restartResp.ok && restartResp.status !== 409) {
      const body = await restartResp.text();
      log.warn(
        { flyAppName, flyMachineId, status: restartResp.status, body },
        'FLY_API_TOKEN secret was set but machine restart failed; secret will only become active on next restart',
      );
      return {
        success: false,
        error: `Secret was set but machine restart failed: HTTP ${restartResp.status} ${body}`,
      };
    }

    log.info({ flyAppName, flyMachineId }, 'FLY_API_TOKEN secret repaired and machine restarted');
    return { success: true, restarted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, flyAppName, flyMachineId }, 'repairFlyApiTokenSecretEager: restart failed');
    return { success: false, error: `Secret was set but restart failed: ${message}` };
  }
}
