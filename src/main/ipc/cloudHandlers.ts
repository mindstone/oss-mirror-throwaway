/**
 * Cloud Domain IPC Handlers
 *
 * Handles cloud management operations called from the Settings UI:
 * connecting/disconnecting cloud mode and migrating data.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { logger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { toPortablePath } from '@core/utils/portablePath';
import { WORKSPACE_CONFLICT_MARKER, deriveOriginalPath } from '@shared/conflictPatterns';
import { registerHandler } from './utils/registerHandler';
import { resolveDigitalOceanCredentials } from '../services/oauthCredentials';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import type { AgentSession, AppSettings, CloudInstanceConfig } from '@shared/types';
import type { DeprovisionResult } from '@shared/ipc/channels/cloud';
import type { MigrationStep } from '@shared/cloudMigrationTypes';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { MINDSTONE_API_URL as API_URL } from '@core/services/mindstoneApiUrl';
import { getCloudUpdateChannel } from '@core/services/cloudUpdateService';
import { getBuildChannel } from '@main/utils/buildChannel';
import { resolveCommercialCloudSentryDsn } from '@main/sentryCloudDsn';
import { cloudConnectionReconciler } from '../services/cloud/cloudConnectionReconcilerSingleton';
import {
  isPathWithinQuarantineRoot,
  listQuarantinedWorkspaceConflicts,
  removeQuarantinedWorkspaceConflict,
} from '../services/cloud/cloudConflictQuarantine';
import { WORKSPACE_SYNC_TEMP_MARKER } from '@shared/workspaceConstants';
import type { ReconcilerWriter } from '@core/services/cloud/cloudConnectionReconcilerTypes';

export interface CloudHandlerDeps {
  getSettings: () => AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  loadAgentSessions?: () => AgentSession[];
}

// ---------------------------------------------------------------------------
// Shared helpers — used by both managed and BYOK paths
// ---------------------------------------------------------------------------

/** Broadcast a provisioning progress step to all renderer windows. */
function broadcastProvisioningProgress(step: { phase: string; message: string; progress: number }): void {
  logger.info({ phase: step.phase, progress: step.progress }, step.message);
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: cloud provisioning progress is a genuine all-window broadcast; migrate later to BroadcastService/cloud event channel.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('cloud:provisioning-progress', step);
      }
    } catch { /* window may close during provisioning */ }
  }
}

/** Settings patch that resets cloudInstance to local-only mode. */
// This is the canonical sole writer of the local-mode cloudInstance record: it
// sets cloudUrl/cloudToken to undefined (full wipe), which is the opposite of
// the drift state the guard forbids, but it still pairs mode:'local' with the
// cloudUrl/cloudToken keys structurally.
// eslint-disable-next-line no-restricted-syntax -- cloud-instance-clear-justified: canonical full-wipe writer; cloudUrl/cloudToken are explicitly undefined (PM 260608)
const CLOUD_INSTANCE_CLEARED_CLOUD_INSTANCE = {
  mode: 'local',
  cloudUrl: undefined,
  cloudToken: undefined,
  providerId: undefined,
  providerMetadata: undefined,
  flyAppName: undefined,
  flyMachineId: undefined,
  flyVolumeId: undefined,
  flyVolumeSizeGb: undefined,
  lastVolumeUsedBytes: undefined,
  lastVolumeAvailableBytes: undefined,
  lastVolumeUsageCheckedAt: undefined,
  flyRegion: undefined,
  vmTierId: undefined,
  provisionedAt: undefined,
  provisionMode: undefined,
  lastKnownStatus: undefined,
  lastError: undefined,
  lastSyncedAt: undefined,
  errorCategory: undefined,
  degradedSince: undefined,
  lastWriter: undefined,
} satisfies Partial<CloudInstanceConfig>;

const CLOUD_INSTANCE_CLEARED = {
  cloudInstance: CLOUD_INSTANCE_CLEARED_CLOUD_INSTANCE,
} satisfies Partial<AppSettings>;

/** Auth-token fetch deadline for remote teardown — bounds the indefinite hang. */
const DEPROVISION_AUTH_TIMEOUT_MS = 10_000;
/** Overall deadline for the BYOK provider deprovision call. */
const DEPROVISION_REMOTE_TIMEOUT_MS = 30_000;

/**
 * Bound a promise with a hard deadline. NOTE: the underlying promise is not
 * cancelled when the deadline wins — callers use this to *abandon* a hung
 * network op (e.g. a token fetch) so teardown can fall through to a local wipe.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Verification helpers for BYOK linking
// ---------------------------------------------------------------------------

const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Type guard for the cloud LKG record returned by `/api/admin/lkg-image`.
 *
 * Stage D of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
 * The Zod schema on the IPC channel validates the shape going to the
 * renderer, but we also need to defend the inbound HTTP body here because
 * a misconfigured/proxied cloud could return arbitrary JSON.
 */
function isLkgRecord(value: unknown): value is {
  imageTag: string;
  buildCommit: string;
  schemaFingerprint: string;
  recordedAt: number;
  isBootstrapFallback?: boolean;
  previousLastKnownGood: {
    imageTag: string;
    schemaFingerprint: string;
    recordedAt: number;
  } | null;
} {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (
    typeof r.imageTag !== 'string' ||
    typeof r.buildCommit !== 'string' ||
    typeof r.schemaFingerprint !== 'string' ||
    typeof r.recordedAt !== 'number'
  ) {
    return false;
  }
  const prev = r.previousLastKnownGood;
  if (prev === null) return true;
  if (!prev || typeof prev !== 'object') return false;
  const p = prev as Record<string, unknown>;
  return (
    typeof p.imageTag === 'string' &&
    typeof p.schemaFingerprint === 'string' &&
    typeof p.recordedAt === 'number'
  );
}

/** Check if the cloud instance health endpoint is reachable (unauthenticated). */
async function verifyHealth(cloudUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${cloudUrl}/api/health`, {
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Check if authenticated requests to the cloud instance succeed. */
async function verifyAuth(cloudUrl: string, cloudToken: string | undefined): Promise<boolean> {
  if (!cloudToken) return false;
  try {
    const resp = await fetch(`${cloudUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const body = JSON.parse(text) as { error?: string };
      return body.error ?? text;
    } catch {
      return text;
    }
  } catch {
    return fallback;
  }
}

/**
 * Normalize error shapes from rebel-platform into a user-friendly string.
 * Handles: plain string, `{ name, message }` (Zod), `{ error: string }`, and unknown.
 */
export function normalizePlatformError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    // Zod-style: { name: "ZodError", message: "..." }
    if (typeof obj.message === 'string') return obj.message;
    // API-style: { error: "..." }
    if (typeof obj.error === 'string') return obj.error;
  }
  return 'An unknown error occurred';
}

// Interval between managed-update status polls in pollManagedUpdateCompletion.
// Production = 3000ms. Overridable ONLY from tests (see
// _setManagedPollIntervalMsForTests) so the managed-update tests don't real-wait
// 3s × poll × test in CI; production behaviour is unchanged. Scoped to this one
// loop (cloudHandlers.ts:295) — the provision poll uses its own 2s interval.
let managedPollIntervalMs = 3_000;
const MANAGED_POLL_TIMEOUT_MS = 120_000;
const OSS_MANAGED_CLOUD_ERROR = 'Mindstone Cloud is not available in the open-source build. Use your own cloud provider instead.';

function isOssBuild(): boolean {
  return getPlatformConfig().isOss;
}

function logManagedCloudOssRefusal(operation: string, context: Record<string, unknown> = {}): void {
  logger.warn(
    { operation, code: 'managed_cloud_unavailable_in_oss', ...context },
    'Managed cloud operation refused in OSS build',
  );
}

function refuseManagedCloudInOss(operation: string, context?: Record<string, unknown>): { success: false; error: string } | null {
  if (!isOssBuild()) return null;
  logManagedCloudOssRefusal(operation, context);
  return { success: false, error: OSS_MANAGED_CLOUD_ERROR };
}

/**
 * Poll rebel-platform `GET /api/cloud/managed/status` until the managed instance
 * finishes an update or channel switch operation.
 *
 * Race-condition guard: the poll must observe `status === 'updating'` at least once
 * before accepting `active` as success — if the first poll returns `active`, the
 * transition may not have started yet.
 *
 * Does NOT overwrite stored cloudToken (status response masks it).
 * Does NOT broadcast provisioning progress (provisioning has its own loop).
 */
export async function pollManagedUpdateCompletion(
  accessToken: string,
  timeoutMs = MANAGED_POLL_TIMEOUT_MS,
): Promise<{ success: boolean; error?: string }> {
  const ossRefusal = refuseManagedCloudInOss('cloud:managed-update-poll');
  if (ossRefusal) return ossRefusal;

  const deadline = Date.now() + timeoutMs;
  let sawUpdating = false;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${API_URL}/api/cloud/managed/status`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });

      // Auth failures: fail fast — don't burn the full timeout
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, error: `Authentication failed (HTTP ${resp.status}). Please sign in again.` };
      }

      if (resp.ok) {
        const data = await resp.json() as {
          exists?: boolean;
          status?: string;
          error?: string;
        };

        if (data.status === 'updating') {
          sawUpdating = true;
        }

        // Terminal success: active AND we've seen updating at least once
        if (data.status === 'active' && sawUpdating) {
          return { success: true };
        }

        // Terminal failures
        if (data.status === 'error') {
          return { success: false, error: normalizePlatformError(data.error) || 'Update failed on the server.' };
        }
        if (data.status === 'deprovisioning' || data.status === 'destroyed' || data.exists === false) {
          return { success: false, error: `Instance entered ${data.status ?? 'unknown'} state during update.` };
        }
      } else {
        logger.debug({ status: resp.status }, 'Managed update poll returned non-OK (transient)');
      }
    } catch (err) {
      // Network errors: log and continue (transient)
      logger.debug({ err }, 'Managed update poll failed (transient)');
    }

    await new Promise<void>(resolve => setTimeout(resolve, managedPollIntervalMs));
  }

  return { success: false, error: 'Update timed out. The instance may still be updating — check back shortly.' };
}

/**
 * Test-only override for the managed-update poll interval. Lets the
 * managed-update tests collapse the real 3s inter-poll wait to 0 without
 * touching the production default or the provision/health poll intervals.
 * Pass no argument to restore the 3000ms production default.
 */
export function _setManagedPollIntervalMsForTests(ms = 3_000): void {
  managedPollIntervalMs = ms;
}

type WorkspaceConflictEntry = {
  localPath: string;
  cloudCopyPath: string;
  relativePath: string;
};

// `WORKSPACE_CONFLICT_MARKER` and `deriveOriginalPath` are imported from
// `@shared/conflictPatterns` — the single source of truth shared with the
// health check and the space-maintenance service. Stage 1 consolidation per
// docs/plans/260411_shared_space_maintenance.md.

function isPathWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedDirectory = path.resolve(directoryPath);
  return resolvedCandidate === resolvedDirectory || resolvedCandidate.startsWith(`${resolvedDirectory}${path.sep}`);
}

/**
 * A conflict's `cloudCopyPath` is safe to READ/UNLINK only if it still resolves
 * either inside the workspace (an in-tree `.conflict-cloud` copy) OR under the
 * quarantine root (a quarantined cloud copy). The value can originate from
 * persisted JSON (the quarantine index), so we re-validate it at every
 * read/unlink site rather than trusting it. Rejects anything else (corrupt or
 * tampered index pointing at an arbitrary file).
 */
function isCloudCopyPathSafe(cloudCopyPath: string, workspaceRoot: string): boolean {
  return (
    isPathWithinDirectory(cloudCopyPath, workspaceRoot)
    || isPathWithinQuarantineRoot(cloudCopyPath)
  );
}

/**
 * A `.conflict-cloud` copy is a LIVE conflict only while its original still
 * exists — that's the file the user is being asked to reconcile against. Once
 * the original is gone (resolved, deleted, or renamed), the conflict copy is an
 * ORPHAN: re-surfacing it in the active dialog every time it opens is a standing
 * false positive (REBEL-696 false-positive follow-up; see Stage 1 of
 * docs/plans/260622_conflict-dialog-false-positives/PLAN.md).
 *
 * We must NOT time-based-delete orphan bytes (they may be the only remaining
 * copy of the cloud side — GPT F3). Instead we DE-SURFACE them from the active
 * list and leave the bytes exactly where they are; the daily maintenance
 * pipeline + `conflictingCopies` health check already own orphan `.conflict-cloud`
 * files behind stability gates and preserve (never time-delete) them.
 */
async function originalStillExists(localPath: string): Promise<boolean> {
  try {
    await fs.access(localPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Only a genuinely-absent original (ENOENT — also ENOTDIR, a missing parent
    // segment) means there's nothing live to reconcile against, so de-surface.
    // Any OTHER fs error (EACCES, EPERM, transient EIO, a dataless placeholder
    // that failed to stat) is AMBIGUOUS: we cannot prove the original is gone, so
    // we must NOT hide a potentially-live conflict. Fail safe — treat it as still
    // present and surface it — but log so the ambiguity is observable.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    logger.warn(
      { localPath, code, err: err instanceof Error ? err.message : String(err) },
      'originalStillExists: ambiguous fs error checking conflict original; treating as still-present (not de-surfacing)',
    );
    return true;
  }
}

// bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
async function listWorkspaceConflicts(coreDirectory: string): Promise<WorkspaceConflictEntry[]> {
  const workspaceRoot = path.resolve(coreDirectory);
  const pendingDirs = [workspaceRoot];
  const conflictsByRelativePath = new Map<string, WorkspaceConflictEntry>();

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) continue;

    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      logger.warn(
        { dir: currentDir, err: err instanceof Error ? err.message : String(err) },
        'Failed reading directory while listing workspace conflicts',
      );
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        pendingDirs.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      // Belt-and-braces: never treat a cloud-pull temp file as a conflict copy.
      // The temp name (`.<base>.<uuid>.rebel-cloud-pull.tmp`) doesn't match the
      // conflict marker today, but a crash-leftover temp must not surface here.
      if (entry.name.includes(WORKSPACE_SYNC_TEMP_MARKER)) {
        continue;
      }
      if (!entry.name.includes(WORKSPACE_CONFLICT_MARKER)) {
        continue;
      }

      const localPath = deriveOriginalPath(path.join(currentDir, entry.name), 'rebel-cloud-conflict');
      if (!localPath) {
        continue;
      }

      if (!isPathWithinDirectory(localPath, workspaceRoot)) {
        continue;
      }

      const relativePath = toPortablePath(path.relative(workspaceRoot, localPath));
      if (
        !relativePath
        || relativePath === '.'
        || relativePath.startsWith('../')
        || relativePath.includes('/../')
        || path.isAbsolute(relativePath)
      ) {
        continue;
      }

      if (conflictsByRelativePath.has(relativePath)) {
        continue;
      }

      // Orphan de-surfacing: the original is gone, so this is not a live conflict
      // the user can reconcile. Leave the conflict-copy bytes in place (the
      // maintenance pipeline / health check preserve + own them) but drop it from
      // the active dialog list so it stops re-appearing as a false positive.
      if (!(await originalStillExists(localPath))) {
        logger.info(
          { relativePath, cloudCopyPath: absolutePath, source: 'in-tree' },
          'Workspace conflict orphan de-surfaced from active list (original missing; bytes preserved for maintenance)',
        );
        continue;
      }

      conflictsByRelativePath.set(relativePath, {
        localPath,
        cloudCopyPath: absolutePath,
        relativePath,
      });
    }
  }

  for (const conflict of listQuarantinedWorkspaceConflicts(workspaceRoot)) {
    if (!isPathWithinDirectory(conflict.localPath, workspaceRoot)) {
      continue;
    }
    // The quarantined cloudCopyPath comes from persisted JSON — only surface it
    // if it still resolves under the quarantine root (defense-in-depth; the
    // store also guards this).
    if (!isCloudCopyPathSafe(conflict.cloudCopyPath, workspaceRoot)) {
      logger.warn(
        { cloudCopyPath: conflict.cloudCopyPath, relativePath: conflict.relativePath },
        'Skipping quarantined conflict with unsafe cloudCopyPath',
      );
      continue;
    }
    const relativePath = normalizeRelativePath(conflict.relativePath);
    if (
      !relativePath
      || relativePath === '.'
      || relativePath.startsWith('../')
      || relativePath.includes('/../')
      || path.isAbsolute(relativePath)
    ) {
      continue;
    }
    if (conflictsByRelativePath.has(relativePath)) {
      continue;
    }

    // Orphan de-surfacing (quarantined side): same rule as the in-tree branch —
    // if the original is gone this is no longer a live conflict. The quarantined
    // cloud bytes stay in the quarantine store (the maintenance pipeline owns
    // their lifecycle and never time-deletes them); we only stop surfacing them
    // in the active dialog.
    if (!(await originalStillExists(conflict.localPath))) {
      logger.info(
        { relativePath, cloudCopyPath: conflict.cloudCopyPath, source: 'quarantine' },
        'Workspace conflict orphan de-surfaced from active list (original missing; bytes preserved in quarantine)',
      );
      continue;
    }

    conflictsByRelativePath.set(relativePath, {
      localPath: conflict.localPath,
      cloudCopyPath: conflict.cloudCopyPath,
      relativePath,
    });
  }

  return Array.from(conflictsByRelativePath.values())
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function normalizeRelativePath(inputPath: string): string {
  const normalized = toPortablePath(path.normalize(inputPath)).replace(/^\/+/, '').replace(/^\.\/+/, '');
  return normalized;
}

function hashWorkspaceContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

async function findWorkspaceConflictByRelativePath(
  coreDirectory: string,
  inputRelativePath: string,
): Promise<WorkspaceConflictEntry | null> {
  const normalizedRelativePath = normalizeRelativePath(inputRelativePath);
  const conflicts = await listWorkspaceConflicts(coreDirectory);
  return conflicts.find((entry) => entry.relativePath === normalizedRelativePath) ?? null;
}

async function removeConflictCopy(conflictPath: string): Promise<void> {
  try {
    await fs.unlink(conflictPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Module-level provisioning state — accessible to quit guard
// ---------------------------------------------------------------------------

/** True while `cloud:provision` handler is executing. */
let provisionInProgress = false;

/** True while `cloud:switch-provider` handler is executing. */
let switchInProgress = false;

/**
 * Monotonic counter bumped every time the local cloud config is torn down
 * (managed/BYOK deprovision or "Forget"). `cloud:reattach-managed` captures
 * this value before its async discovery and re-checks it immediately before
 * writing recovered credentials: if a teardown ran in the window, the captured
 * generation is stale and the reattach aborts rather than resurrecting
 * `mode:'cloud'` creds pointing at a just-destroyed instance. This closes the
 * reattach↔destroy TOCTOU window (mirrors the reconciler's pre-write re-check).
 */
let cloudTeardownGeneration = 0;

/**
 * Bump the teardown generation. MUST be called by every code path that clears /
 * tears down local cloud state BEFORE the settings write, so an in-flight
 * `cloud:reattach-managed` (which captured the pre-teardown generation) aborts
 * instead of resurrecting `mode:'cloud'` creds at a just-destroyed instance.
 * `clearCloudInstanceLocally()` is the canonical chokepoint and calls this; the
 * `cloud:resolve-conflict` direct clears route through the chokepoint too. Keep
 * this the single mutation site for the counter so a future clear can't forget.
 */
function bumpCloudTeardownGeneration(): void {
  cloudTeardownGeneration += 1;
}

/** Check whether any cloud provisioning or provider-switch is active. */
export function isCloudProvisioningActive(): boolean {
  return provisionInProgress || switchInProgress;
}

export function registerCloudHandlers(deps: CloudHandlerDeps): void {
  const { getSettings, updateSettings } = deps;

  const reportCloudStatusFailure = (writer: ReconcilerWriter, rawError: unknown, legacyLastError?: string): Promise<void> => {
    return cloudConnectionReconciler.reportFailure({
      writer,
      rawError,
      legacyLastError,
    });
  };

  // -------------------------------------------------------------------------
  // Extracted functions — reusable by the switch-provider handler (Stage 1)
  // -------------------------------------------------------------------------

  /** Provision a cloud instance — handles both managed (Mindstone) and BYOK paths. */
  async function doProvision(payload: {
    flyApiToken?: string;
    apiToken?: string;
    region?: string;
    providerId?: string;
    volumeSizeGb?: number;
    vmTierId?: string;
  }) {
    // -----------------------------------------------------------------------
    // Managed provisioning (Mindstone Cloud) — handler-direct, no provider
    // -----------------------------------------------------------------------
    if (payload.providerId === 'mindstone') {
      const ossRefusal = refuseManagedCloudInOss('cloud:provision', { providerId: payload.providerId });
      if (ossRefusal) return ossRefusal;

      const accessToken = await getRebelAuthProvider().getAccessToken();
      if (!accessToken) {
        return { success: false, error: 'Not signed in. Please sign in to use Mindstone Cloud.' };
      }

      const provisionDeadline = Date.now() + 180_000;

      let provisionResp: Response;
      try {
        provisionResp = await fetch(`${API_URL}/api/cloud/managed/provision`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ region: payload.region, channel: getSettings().cloudUpdateChannel ?? getCloudUpdateChannel(getBuildChannel()) }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, 'Managed cloud provisioning failed');
        broadcastProvisioningProgress({ phase: 'failed', message, progress: 0 });
        return { success: false, error: `Provisioning failed: ${message}` };
      }

      if (!provisionResp.ok) {
        const errorBody = await extractErrorMessage(provisionResp, 'Provisioning request failed');
        broadcastProvisioningProgress({ phase: 'failed', message: errorBody, progress: 0 });
        return { success: false, error: errorBody };
      }

      let provisionResult: { success: boolean; flyAppName?: string; error?: string };
      try {
        provisionResult = await provisionResp.json() as { success: boolean; flyAppName?: string; error?: string };
      } catch {
        const message = 'Provisioning request returned an invalid response.';
        broadcastProvisioningProgress({ phase: 'failed', message, progress: 0 });
        return { success: false, error: message };
      }

      if (!provisionResult.success) {
        const message = provisionResult.error ?? 'Provisioning failed';
        broadcastProvisioningProgress({ phase: 'failed', message, progress: 0 });
        return { success: false, error: message };
      }

      broadcastProvisioningProgress({ phase: 'creating_app', message: 'creating_app', progress: 5 });

      let appName = provisionResult.flyAppName;
      let cloudUrl: string | undefined;
      let cloudToken: string | undefined;
      let terminalError: string | undefined;

      while (Date.now() < provisionDeadline && !terminalError && (!cloudUrl || !cloudToken)) {
        try {
          const statusResp = await fetch(`${API_URL}/api/cloud/managed/status`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10_000),
          });

          if (!statusResp.ok) {
            logger.debug(
              { status: statusResp.status },
              'Managed provisioning status poll returned non-OK response (transient)',
            );
          } else {
            const statusData = await statusResp.json() as {
              exists?: boolean;
              status?: string;
              phase?: string;
              progress?: number;
              cloudUrl?: string;
              cloudToken?: string;
              flyAppName?: string;
              error?: string;
            };

            broadcastProvisioningProgress({
              phase: statusData.phase ?? 'waiting',
              message: statusData.phase ?? 'waiting',
              progress: statusData.progress ?? 0,
            });

            if (statusData.flyAppName) {
              appName = statusData.flyAppName;
            }

            if (statusData.status === 'active') {
              cloudUrl = statusData.cloudUrl;
              cloudToken = statusData.cloudToken;
              if (!cloudUrl || !cloudToken) {
                terminalError = 'Provisioning completed but managed credentials were missing.';
              }
            } else if (statusData.status === 'error') {
              terminalError = statusData.error ?? 'Provisioning failed';
            } else if (statusData.status === 'deprovisioning' || statusData.status === 'destroyed') {
              terminalError = `Provisioning failed: instance entered ${statusData.status} state`;
            }
          }
        } catch (pollErr) {
          logger.debug({ err: pollErr }, 'Managed provisioning status poll failed (transient)');
        }

        if (terminalError || (cloudUrl && cloudToken)) break;

        await new Promise<void>(resolve => setTimeout(resolve, 2_000));
      }

      if (terminalError || !cloudUrl || !cloudToken) {
        const message = terminalError ??
          'Provisioning timed out after 180 seconds while waiting for managed cloud credentials.';
        broadcastProvisioningProgress({ phase: 'failed', message, progress: 0 });
        return { success: false, error: message };
      }

      const provisionedAt = Date.now();
      // Store result in settings (same shape as BYOK)
      updateSettings({
        cloudInstance: {
          mode: 'cloud',
          cloudUrl,
          cloudToken,
          providerId: 'mindstone',
          flyAppName: appName,
          provisionedAt,
          provisionMode: 'managed',
        },
      });
      await cloudConnectionReconciler.reportSuccess({ writer: 'managed-status', cloudUrl });

      broadcastProvisioningProgress({ phase: 'complete', message: 'Ready', progress: 100 });
      return {
        success: true,
        cloudUrl,
        cloudToken,
        appName,
      };
    }

    // -----------------------------------------------------------------------
    // BYOK provisioning — existing provider-based flow (unchanged)
    // -----------------------------------------------------------------------
    const { getCloudProviderOrDefault } = await import('@core/services/cloud/providers');

    let provider;
    try {
      provider = getCloudProviderOrDefault(payload.providerId);
    } catch {
      return { success: false, error: `Unsupported cloud provider: ${payload.providerId}` };
    }

    let apiToken = payload.apiToken ?? payload.flyApiToken ?? '';
    let tokenFromOAuth = false;

    // For OAuth providers, resolve stored token if no explicit token provided
    if (!apiToken && provider.config.id === 'digitalocean') {
      try {
        const { getValidDigitalOceanToken } = await import('../services/digitalOceanAuthService');
        const oauthToken = await getValidDigitalOceanToken();
        if (oauthToken) {
          apiToken = oauthToken;
          tokenFromOAuth = true;
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'DigitalOceanOAuthExpiredError') {
          return { success: false, error: err.message };
        }
        throw err;
      }
    }

    if (!apiToken) {
      return { success: false, error: 'No API token provided' };
    }

    const result = await provider.provision({
      token: apiToken,
      region: payload.region,
      volumeSizeGb: payload.volumeSizeGb,
      vmTierId: payload.vmTierId,
      // Cloudflare credentials for DO/Hetzner DNS self-registration
      cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID,
      cloudflareDnsToken: process.env.CLOUDFLARE_DNS_TOKEN,
      // Sentry DSN for the cloud instance: commercial packaged builds carry it
      // build-inlined (VITE_SENTRY_DSN). OSS builds resolve undefined BY
      // CONSTRUCTION (the helper gates on PlatformConfig.isOss — never the raw
      // env, which an OSS/dev runtime may have set) → the instance env never
      // gains the key (no phone-home).
      sentryDsn: resolveCommercialCloudSentryDsn(),
      onProgress: broadcastProvisioningProgress,
    });

    if (result.success && result.cloudUrl && result.cloudToken) {
      // Save provider token securely (skip for OAuth — OAuth tokens are already in OAuth storage)
      if (!tokenFromOAuth) {
        try {
          if (provider.config.id === 'fly') {
            const { saveFlyApiToken } = await import('../services/flyTokenStorage');
            saveFlyApiToken(apiToken);
          } else {
            const { saveProviderToken } = await import('../services/providerTokenStorage');
            saveProviderToken(provider.config.id, apiToken);
          }
        } catch (tokenErr) {
          logger.warn({ err: tokenErr, providerId: provider.config.id }, 'Failed to save token securely — provisioning succeeded but token not persisted');
        }
      }

      // Fly-backed providers populate Fly metadata for updates/status
      const isFlyBacked = provider.config.id === 'fly';
      const provisionedAt = Date.now();
      const newCloudConfig = {
        mode: 'cloud' as const,
        cloudUrl: result.cloudUrl,
        cloudToken: result.cloudToken,
        providerId: provider.config.id,
        // Fly-specific fields (backward compat, populated from providerMetadata)
        flyAppName: result.providerMetadata?.appName ?? (isFlyBacked ? result.instanceId : undefined),
        flyMachineId: result.providerMetadata?.machineId,
        flyVolumeId: isFlyBacked ? result.volumeId : undefined,
        flyRegion: isFlyBacked ? result.region : undefined,
        vmTierId: result.vmTierId,
        provisionedAt,
        provisionMode: 'byok' as const,
        // Generic provider metadata (DO/Hetzner store all IDs here)
        providerMetadata: result.providerMetadata,
      };
      updateSettings({ cloudInstance: newCloudConfig });
      await cloudConnectionReconciler.reportSuccess({ writer: 'manual-refresh', cloudUrl: result.cloudUrl });
    }

    // Map back to IPC response shape (backward compat with existing Zod schema)
    return {
      success: result.success,
      cloudUrl: result.cloudUrl,
      cloudToken: result.cloudToken,
      appName: result.providerMetadata?.appName ?? result.instanceId,
      machineId: result.providerMetadata?.machineId,
      volumeId: result.volumeId,
      region: result.region,
      vmTierId: result.vmTierId,
      error: result.error,
      warning: result.warning,
      failedStep: result.failedStep,
      cleanedUp: result.cleanedUp,
      cleanupMessage: result.cleanupMessage,
    };
  }

  // cloud:provision — Auto-provision a cloud instance via the provider registry
  registerHandler('cloud:provision', async (_event, payload: {
    flyApiToken?: string;
    apiToken?: string;
    region?: string;
    providerId?: string;
    volumeSizeGb?: number;
    vmTierId?: string;
  }) => {
    provisionInProgress = true;
    try {
      return await doProvision(payload);
    } finally {
      provisionInProgress = false;
    }
  });

  // cloud:link-fly-token — Link a Fly API token to an already-connected cloud instance
  registerHandler('cloud:link-fly-token', async (_event, payload: { flyApiToken: string; appName: string }) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // Managed instances don't use personal Fly tokens
    if (ci?.provisionMode === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:link-fly-token', { provisionMode: ci.provisionMode });
      if (ossRefusal) return ossRefusal;

      return { success: false, error: 'Cannot link a personal Fly token to a managed instance.' };
    }

    const { lookupFlyInstance } = await import('@core/services/flyProvisioningService');
    const { saveFlyApiToken } = await import('../services/flyTokenStorage');

    if (!ci?.cloudUrl) {
      return { success: false, error: 'No connected cloud instance found.' };
    }

    // Derive appName from cloudUrl when caller didn't provide it (defensive)
    let appName = payload.appName;
    if (!appName) {
      const match = ci.cloudUrl.match(/^https:\/\/([a-z0-9-]+)\.fly\.dev\/?$/i);
      if (match) appName = match[1];
    }
    if (!appName) {
      return { success: false, error: 'Could not determine Fly app name from URL.' };
    }

    const result = await lookupFlyInstance(payload.flyApiToken, appName);

    if (!result.success) {
      return result;
    }

    // Always persist PAT and Fly metadata (even if verification below fails),
    // so repair actions in later stages can use the stored PAT immediately.
    try {
      saveFlyApiToken(payload.flyApiToken);
    } catch (tokenErr) {
      logger.error({ err: tokenErr }, 'Failed to save Fly token securely');
      return { success: false, error: 'Could not save your Fly token securely. Check your system keychain access.' };
    }

    // A newly linked token enables auto-recovery. Reset the trigger guard so
    // the circuit breaker can attempt recovery if already degraded.
    try {
      const { cloudFailureCooldown } = await import('../services/cloud/cloudFailureCooldown');
      cloudFailureCooldown.resetRecoveryTrigger();
    } catch { /* non-critical */ }

    updateSettings({
      cloudInstance: {
        ...ci,
        flyAppName: result.appName,
        flyMachineId: result.machineId,
        flyVolumeId: result.volumeId,
        flyRegion: result.region,
        provisionMode: 'byok',
      },
    });

    // Run health + auth verification in parallel (best-effort, non-blocking)
    let healthOk = false;
    let authOk = false;
    try {
      [healthOk, authOk] = await Promise.all([
        verifyHealth(ci.cloudUrl),
        verifyAuth(ci.cloudUrl, ci.cloudToken),
      ]);
    } catch (verifyErr) {
      logger.warn({ err: verifyErr }, 'Cloud verification checks failed unexpectedly');
    }

    // If health failed, check for public IPv4 (only when Fly API is available)
    let hasPublicIp: boolean | undefined;
    if (!healthOk) {
      try {
        const { listIpAddresses } = await import('@core/services/flyApiClient');
        const ips = await listIpAddresses(payload.flyApiToken, appName);
        hasPublicIp = ips.some(ip => ip.type === 'shared_v4' || ip.type === 'v4');
      } catch {
        // Fly API unavailable — leave hasPublicIp undefined (not false)
        hasPublicIp = undefined;
      }
    }

    return {
      ...result,
      diagnostic: {
        reachable: healthOk,
        authenticated: authOk,
        hasPublicIp,
      },
    };
  });

  /**
   * Canonical local teardown ("forget on this device"). This is the ONLY code
   * path that should transition `cloudInstance` to local mode.
   *
   * It writes the full `CLOUD_INSTANCE_CLEARED` object (never a partial merge —
   * a partial would let a concurrent shallow-merge writer resurrect dropped
   * fields, and would re-create the `mode:'local'` + live-URL drift state) and
   * then VERIFIES the write actually persisted before reporting success. The
   * settings store silently no-ops writes when userData is read-only, so the
   * absence of an exception is not proof the wipe landed — we read it back.
   *
   * Never touches the network, so it always terminates.
   */
  function clearCloudInstanceLocally(): { cleared: boolean; error?: string } {
    // Invalidate any in-flight `cloud:reattach-managed`: a teardown is running,
    // so a reattach that already discovered a (now-doomed) instance must NOT
    // write its recovered creds back. Bump BEFORE the write so the generation
    // moves the instant we commit to tearing down (the reattach re-check below
    // compares against this), independent of whether the persisted read-back
    // confirms — the destroy intent is what makes a concurrent reattach stale.
    bumpCloudTeardownGeneration();
    try {
      updateSettings(CLOUD_INSTANCE_CLEARED);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to persist local cloud teardown');
      return { cleared: false, error: "Couldn't update your settings. Reload Rebel and try again." + ` (${message})` };
    }

    const ci = getSettings().cloudInstance;
    const fullyCleared = (!ci || ci.mode === 'local') && !ci?.cloudUrl && !ci?.cloudToken;
    if (!fullyCleared) {
      logger.error(
        { mode: ci?.mode, hasUrl: !!ci?.cloudUrl },
        'Local cloud teardown did not persist (settings write no-op?)',
      );
      return { cleared: false, error: "Couldn't update your settings. Reload Rebel and try again." };
    }
    return { cleared: true };
  }

  /**
   * Deprovision the cloud instance — handles both managed (Mindstone) and BYOK
   * paths. Reliability contract (Control B "Destroy instance"):
   *  - the auth fetch and the remote call are bounded by deadlines so this can
   *    never hang indefinitely;
   *  - once we have actually *attempted* the remote teardown, we ALWAYS clear
   *    the local config (even on remote failure/timeout) so the user is never
   *    stranded pointing at a dead/unreachable instance — surfaced as
   *    `local-only-remote-uncertain` for the partial-failure UI.
   *  - pre-flight "can't even attempt" errors (not signed in / no token / no
   *    instance) do NOT wipe — the user can fix the precondition and retry, or
   *    use the always-works local "Forget" control instead.
   */
  function preconditionFailed(error: string): DeprovisionResult {
    return { kind: 'precondition-failed', error };
  }

  function remoteRemovedAfterLocalClear(clearResult: { cleared: boolean; error?: string }): DeprovisionResult {
    if (clearResult.cleared) return { kind: 'remote-removed' };
    return {
      kind: 'remote-removed-local-clear-failed',
      error: clearResult.error ?? "The cloud instance was removed, but Rebel couldn't update local settings. Reload Rebel and try again.",
    };
  }

  function remoteUncertainAfterLocalClear(
    clearResult: { cleared: boolean; error?: string },
    localOnlyError: string,
    localClearFailedError?: string,
  ): DeprovisionResult {
    if (clearResult.cleared) {
      return { kind: 'local-only-remote-uncertain', error: localOnlyError };
    }
    return {
      kind: 'remote-uncertain-local-clear-failed',
      error: localClearFailedError ?? clearResult.error ?? localOnlyError,
    };
  }

  async function doDeprovision(opts?: { managed?: boolean }): Promise<DeprovisionResult> {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // -----------------------------------------------------------------------
    // Managed deprovision (Mindstone Cloud) — call rebel-platform directly.
    // `opts.managed` forces this path for an orphaned backend instance whose
    // local config was already wiped by a "Forget" (so provisionMode is gone),
    // since the managed teardown only needs the user's access token.
    // -----------------------------------------------------------------------
    if (ci?.provisionMode === 'managed' || opts?.managed) {
      const ossRefusal = refuseManagedCloudInOss('cloud:deprovision', { providerId: ci?.providerId });
      if (ossRefusal) return preconditionFailed(ossRefusal.error);

      let accessToken: string | null = null;
      try {
        accessToken = await withTimeout(
          getRebelAuthProvider().getAccessToken(),
          DEPROVISION_AUTH_TIMEOUT_MS,
          'Timed out reaching Mindstone Cloud sign-in',
        );
      } catch (err) {
        // Auth hung/timed out — we can't reach the platform to confirm teardown.
        // Clear locally so the user isn't stranded; warn the instance may persist.
        logger.warn({ err }, 'Managed cloud deprovision: auth timed out');
        const clearResult = clearCloudInstanceLocally();
        return remoteUncertainAfterLocalClear(
          clearResult,
          "Cleared on this device, but we couldn't reach Mindstone Cloud to remove the instance. Try again in a minute, and if it keeps failing, contact support.",
          "Couldn't reach Mindstone Cloud to remove the instance. Rebel also couldn't update local settings. Reload Rebel and try again.",
        );
      }

      if (!accessToken) {
        return preconditionFailed('Not signed in. Please sign in to remove Mindstone Cloud.');
      }

      try {
        const res = await fetch(`${API_URL}/api/cloud/managed/provision`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(DEPROVISION_REMOTE_TIMEOUT_MS),
        });

        if (!res.ok) {
          const errorBody = await extractErrorMessage(res, 'Deprovision request failed');
          const clearResult = clearCloudInstanceLocally();
          return remoteUncertainAfterLocalClear(
            clearResult,
            `Cleared on this device, but Mindstone Cloud couldn't remove the instance (${errorBody}). It may still be running — try again, and if it keeps failing, contact support.`,
            errorBody,
          );
        }

        const data = await res.json() as { success: boolean; error?: string };
        if (data.success) {
          return remoteRemovedAfterLocalClear(clearCloudInstanceLocally());
        }

        // HTTP 200 but success:false — treat as a remote refusal; still clear locally.
        return remoteUncertainAfterLocalClear(
          clearCloudInstanceLocally(),
          data.error ?? 'Mindstone Cloud did not confirm the removal.',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, 'Managed cloud deprovision failed');
        return remoteUncertainAfterLocalClear(
          clearCloudInstanceLocally(),
          `Cleared on this device, but we couldn't remove Mindstone Cloud (${message}). It may still be running.`,
          `We couldn't remove Mindstone Cloud (${message}). Rebel also couldn't update local settings. Reload Rebel and try again.`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // BYOK deprovision — provider-based flow
    // -----------------------------------------------------------------------
    const { getCloudProviderOrDefault } = await import('@core/services/cloud/providers');

    const providerId = ci?.providerId ?? 'fly';

    let provider;
    try {
      provider = getCloudProviderOrDefault(providerId);
    } catch {
      return preconditionFailed(`Unsupported cloud provider: ${providerId}`);
    }

    // Use provider-agnostic instanceId from providerMetadata, falling back to flyAppName
    const instanceId = ci?.providerMetadata?.dropletId ?? ci?.providerMetadata?.serverId ?? ci?.flyAppName;
    if (!instanceId) {
      return preconditionFailed('No auto-provisioned instance found.');
    }

    // Load provider token
    let apiToken: string | null = null;
    if (provider.config.id === 'fly') {
      const { loadFlyApiToken } = await import('../services/flyTokenStorage');
      apiToken = loadFlyApiToken();
    } else {
      // Try OAuth token first for DigitalOcean
      if (provider.config.id === 'digitalocean') {
        try {
          const { getValidDigitalOceanToken } = await import('../services/digitalOceanAuthService');
          const oauthToken = await getValidDigitalOceanToken();
          if (oauthToken) {
            apiToken = oauthToken;
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'DigitalOceanOAuthExpiredError') {
            return preconditionFailed(err.message);
          }
          // Fall through to PAT storage
        }
      }

      const { loadProviderToken } = await import('../services/providerTokenStorage');
      if (!apiToken) {
        apiToken = loadProviderToken(provider.config.id);
      }
    }

    if (!apiToken) {
      const helpText = provider.config.id === 'fly'
        ? 'fly.io/dashboard'
        : provider.config.id === 'digitalocean'
          ? 'cloud.digitalocean.com'
          : 'console.hetzner.cloud';
      return preconditionFailed(`API token not found for ${provider.config.name}. You may need to delete the instance manually at ${helpText}.`);
    }

    // Build metadata for deprovision (includes cloudToken for DNS cleanup)
    const deprovisionMetadata: Record<string, string> = {
      ...(ci?.providerMetadata ?? {}),
      ...(ci?.flyMachineId ? { machineId: ci.flyMachineId } : {}),
      ...(ci?.cloudToken ? { cloudToken: ci.cloudToken } : {}),
    };

    let result: { success: boolean; error?: string };
    try {
      result = await withTimeout(
        provider.deprovision(apiToken, instanceId, deprovisionMetadata),
        DEPROVISION_REMOTE_TIMEOUT_MS,
        'Deprovision timed out',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'BYOK deprovision failed');
      return remoteUncertainAfterLocalClear(
        clearCloudInstanceLocally(),
        `Cleared on this device, but we couldn't reach your provider to destroy the instance (${message}). It may still be running — remove it manually from your provider dashboard.`,
        `We couldn't reach your provider to destroy the instance (${message}). Rebel also couldn't update local settings. Reload Rebel and try again.`,
      );
    }

    // Wipe local config first (forget = local clear), then best-effort clear the
    // provider token. Ordering this way means a token-clear failure leaves only a
    // harmless orphaned token, never a forgotten-but-still-cloud-mode state.
    const clearResult = clearCloudInstanceLocally();

    if (result.success) {
      if (provider.config.id === 'fly') {
        const { clearFlyApiToken } = await import('../services/flyTokenStorage');
        clearFlyApiToken();
      } else {
        const { clearProviderToken } = await import('../services/providerTokenStorage');
        clearProviderToken(provider.config.id);
      }
      return remoteRemovedAfterLocalClear(clearResult);
    }

    // Remote refused — config cleared locally so the user isn't stranded.
    return remoteUncertainAfterLocalClear(
      clearResult,
      result.error
        ? `Cleared on this device, but the instance may still be running (${result.error}). Remove it manually from your provider dashboard.`
        : "Cleared on this device, but the instance may still be running. Remove it manually from your provider dashboard.",
      result.error ?? 'The provider did not confirm removal.',
    );
  }

  // cloud:deprovision — Destroy the auto-provisioned cloud instance via provider registry
  registerHandler('cloud:deprovision', async (_event, payload?: { managed?: boolean }) => {
    return doDeprovision({ managed: payload?.managed });
  });

  // cloud:has-fly-token — Check if a Fly API token is stored (without exposing it)
  registerHandler('cloud:has-fly-token', async () => {
    const { hasFlyApiToken } = await import('../services/flyTokenStorage');
    return { hasToken: hasFlyApiToken() };
  });

  registerHandler('cloud:do-start-oauth', async () => {
    // Classify the not-configured case BEFORE calling startDigitalOceanOAuth(): the service's
    // getDigitalOceanCredentialsOrThrow() throws an ad-hoc string we'd otherwise surface as a
    // generic error. Resolving here lets us return the structured setupGuidance instead, while
    // leaving the service's throw contract intact as the internal safety net.
    if (!resolveDigitalOceanCredentials()) {
      const guidance = describeMissingOAuthCredentials('digitalocean');
      return { success: false, error: guidance.message, setupGuidance: guidance };
    }
    const { startDigitalOceanOAuth } = await import('../services/digitalOceanAuthService');
    try {
      await startDigitalOceanOAuth();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerHandler('cloud:do-oauth-status', async () => {
    const { getDigitalOceanOAuthStatus } = await import('../services/digitalOceanAuthService');
    return getDigitalOceanOAuthStatus();
  });

  registerHandler('cloud:do-disconnect-oauth', async () => {
    const { disconnectDigitalOceanOAuth } = await import('../services/digitalOceanAuthService');
    try {
      await disconnectDigitalOceanOAuth();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // cloud:destroy — "Forget cloud on this device".
  // Network-free, guaranteed local teardown: forgets the URL/token/metadata and
  // switches to local mode. It never contacts the network, so it cannot stall and
  // always terminates. The remote cloud keeps running — use cloud:deprovision to
  // tear that down. The `force` param is accepted for backward compatibility but
  // no longer changes behavior (there is nothing left to "force" past — there is
  // no pre-disconnect sync that could fail and bounce the user).
  registerHandler('cloud:destroy', async (_event, _payload?: { force?: boolean }) => {
    const { cleared, error } = clearCloudInstanceLocally();
    if (!cleared) {
      return { success: false, error };
    }
    return { success: true };
  });

  registerHandler('cloud:reconcile', async (_event, payload: {
    writer: ReconcilerWriter;
    cloudUrl?: string;
    mode: 'reconcile' | 'reportSuccess';
  }) => {
    if (payload.mode === 'reportSuccess') {
      await cloudConnectionReconciler.reportSuccess({ writer: payload.writer, cloudUrl: payload.cloudUrl });
      return { ok: true };
    }

    const outcome = await cloudConnectionReconciler.reconcile({ writer: payload.writer, cloudUrl: payload.cloudUrl });
    return { ok: true, outcome };
  });

  // cloud:status — Check cloud service health
  registerHandler('cloud:status', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    if (!ci?.cloudUrl || ci.mode !== 'cloud') {
      return { status: 'not_configured' };
    }

    if (ci.provisionMode === 'managed') {
      if (isOssBuild()) {
        logManagedCloudOssRefusal('cloud:status', { providerId: ci.providerId });
        await reportCloudStatusFailure('managed-status', new Error(OSS_MANAGED_CLOUD_ERROR), OSS_MANAGED_CLOUD_ERROR);
        return { status: 'error' as const, error: OSS_MANAGED_CLOUD_ERROR };
      }

      const accessToken = await getRebelAuthProvider().getAccessToken();
      if (!accessToken) {
        return { status: 'error', error: 'Sign in to check your managed cloud status.' };
      }

      try {
        const resp = await fetch(`${API_URL}/api/cloud/managed/status`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });

        if (resp.status === 401 || resp.status === 403) {
          await reportCloudStatusFailure(
            'managed-status',
            new Error(`Authentication failed (HTTP ${resp.status}). Please sign in again.`),
            `Authentication failed (HTTP ${resp.status}). Please sign in again.`,
          );
          return {
            status: 'error',
            error: `Authentication failed (HTTP ${resp.status}). Please sign in again.`,
          };
        }

        if (!resp.ok) {
          await reportCloudStatusFailure(
            'managed-status',
            new Error(`Managed status check failed: HTTP ${resp.status}`),
            `Managed status check failed: HTTP ${resp.status}`,
          );
          return { status: 'error', error: `Managed status check failed: HTTP ${resp.status}` };
        }

        const data = await resp.json() as {
          exists?: boolean;
          status?: string;
          error?: unknown;
          cloudUrl?: string;
        };

        if (data.exists === false || data.status === 'destroyed') {
          await reportCloudStatusFailure(
            'managed-status',
            new Error('Managed cloud is no longer available.'),
            'Managed cloud is no longer available.',
          );
          return { status: 'error', error: 'Managed cloud is no longer available.' };
        }

        if (data.status === 'active') {
          const activeCloudUrl = data.cloudUrl ?? ci.cloudUrl;
          // Best-effort pressure fetch from the actual cloud (not the Mindstone API).
          let managedPressure: import('@shared/types/cloudHealth').CloudPressureBasic | undefined;
          try {
            const healthResp = await fetch(`${activeCloudUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
            if (healthResp.ok) {
              const healthBody = (await healthResp.json()) as { pressure?: { state?: string; oomRecent?: boolean; recentRestart?: boolean } };
              if (
                healthBody.pressure &&
                typeof healthBody.pressure.state === 'string' &&
                (healthBody.pressure.state === 'ok' || healthBody.pressure.state === 'warning' ||
                  healthBody.pressure.state === 'critical' || healthBody.pressure.state === 'unknown')
              ) {
                managedPressure = {
                  state: healthBody.pressure.state as import('@shared/types/cloudHealth').CloudPressureState,
                  oomRecent: healthBody.pressure.oomRecent ?? false,
                  recentRestart: healthBody.pressure.recentRestart ?? false,
                };
              }
            }
          } catch {
            // Pressure is best-effort; don't block the success path.
          }
          await cloudConnectionReconciler.reportSuccess({
            writer: 'managed-status',
            cloudUrl: activeCloudUrl,
            pressureObservation: managedPressure,
          });
          return { status: 'running', url: activeCloudUrl, pressure: managedPressure };
        }

        if (data.status === 'updating') {
          return { status: 'warm', url: data.cloudUrl ?? ci.cloudUrl };
        }

        if (data.status === 'provisioning') {
          return { status: 'provisioning', url: data.cloudUrl ?? ci.cloudUrl };
        }

        if (data.status === 'error') {
          const message = normalizePlatformError(data.error) || 'Managed cloud reported an error.';
          await reportCloudStatusFailure('managed-status', new Error(message), message);
          return {
            status: 'error',
            error: message,
          };
        }

        if (data.status === 'deprovisioning') {
          await reportCloudStatusFailure(
            'managed-status',
            new Error('Managed cloud is being removed.'),
            'Managed cloud is being removed.',
          );
          return { status: 'error', error: 'Managed cloud is being removed.' };
        }

        await reportCloudStatusFailure(
          'managed-status',
          new Error(`Managed cloud reported unexpected status: ${data.status ?? 'unknown'}`),
          `Managed cloud reported unexpected status: ${data.status ?? 'unknown'}`,
        );
        return {
          status: 'error',
          error: `Managed cloud reported unexpected status: ${data.status ?? 'unknown'}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, 'Managed cloud status check failed');
        await reportCloudStatusFailure('managed-status', err, message);
        return { status: 'error', error: message };
      }
    }

    try {
      const resp = await fetch(`${ci.cloudUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        const body = (await resp.json()) as {
          status?: string;
          pressure?: { state?: string; oomRecent?: boolean; recentRestart?: boolean };
        };
        let byokPressure: import('@shared/types/cloudHealth').CloudPressureBasic | undefined;
        if (
          body.pressure &&
          typeof body.pressure.state === 'string' &&
          (body.pressure.state === 'ok' || body.pressure.state === 'warning' ||
            body.pressure.state === 'critical' || body.pressure.state === 'unknown')
        ) {
          byokPressure = {
            state: body.pressure.state as import('@shared/types/cloudHealth').CloudPressureState,
            oomRecent: body.pressure.oomRecent ?? false,
            recentRestart: body.pressure.recentRestart ?? false,
          };
        }
        await cloudConnectionReconciler.reportSuccess({
          writer: 'managed-status',
          cloudUrl: ci.cloudUrl,
          pressureObservation: byokPressure,
        });
        return { status: 'running', url: ci.cloudUrl, pressure: byokPressure };
      }
      await reportCloudStatusFailure('managed-status', new Error(`HTTP ${resp.status}`), `HTTP ${resp.status}`);
      return { status: 'error', error: `HTTP ${resp.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'Cloud health check failed');
      await reportCloudStatusFailure('managed-status', err, message);
      return { status: 'offline', error: message };
    }
  });

  // cloud:discover-instances — Discover all cloud instances (managed + BYOK) and detect conflicts
  registerHandler('cloud:discover-instances', async () => {
    const { discoverCloudInstances } = await import('@core/services/cloud/cloudInstanceDiscovery');
    const settings = getSettings();
    const accessToken = await getRebelAuthProvider().getAccessToken();
    return discoverCloudInstances({
      apiUrl: API_URL,
      accessToken,
      cloudInstance: settings.cloudInstance,
      includeManaged: !isOssBuild(),
    });
  });

  // cloud:resolve-conflict — Deprovision the unchosen instance when both managed + BYOK exist
  registerHandler('cloud:resolve-conflict', async (_event, payload: { keep: 'managed' | 'byok' }) => {
    const { discoverCloudInstances } = await import('@core/services/cloud/cloudInstanceDiscovery');
    const settings = getSettings();
    const ci = settings.cloudInstance;
    const accessToken = await getRebelAuthProvider().getAccessToken();

    if (payload.keep === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:resolve-conflict', { keep: payload.keep });
      if (ossRefusal) return ossRefusal;
    }

    // Re-run discovery to confirm conflict still exists
    const discovery = await discoverCloudInstances({
      apiUrl: API_URL,
      accessToken,
      cloudInstance: ci,
      includeManaged: !isOssBuild(),
    });

    if (!discovery.conflict) {
      return { success: true }; // No conflict — nothing to resolve
    }

    if (payload.keep === 'managed') {
      // User wants to keep managed — try to deprovision BYOK (best-effort)
      let byokCleanupWarning: string | undefined;

      if (discovery.activeInSettings === 'byok') {
        // Settings point to BYOK — attempt deprovision (may fail if no API token)
        const depResult = await doDeprovision();
        if (depResult.kind === 'remote-removed-local-clear-failed') {
          logger.warn(
            { error: depResult.error },
            'Conflict resolution: BYOK remote removed but local clear failed (settings switch to managed below supersedes it)'
          );
        }
        if (depResult.kind !== 'remote-removed' && depResult.kind !== 'remote-removed-local-clear-failed') {
          // BYOK cleanup failed — not a blocker, user still gets managed
          const providerId = discovery.byok.providerId ?? 'fly';
          byokCleanupWarning = `Your old ${providerId === 'fly' ? 'Fly.io' : providerId} instance is still running. You may need to remove it manually from your provider dashboard.`;
          logger.warn({ error: depResult.error, providerId }, 'Conflict resolution: BYOK deprovision failed (non-blocking)');
        }
      } else {
        // Settings already point to managed — BYOK can't be auto-deprovisioned
        // without provider credentials in settings. Warn user.
        const providerId = discovery.byok.providerId ?? 'fly';
        byokCleanupWarning = `Your old ${providerId === 'fly' ? 'Fly.io' : providerId} instance is still running. You may need to remove it manually from your provider dashboard.`;
        logger.warn('Conflict resolution: keeping managed, BYOK instance requires manual cleanup');
      }

      // Switch settings to managed regardless of BYOK cleanup outcome
      if (discovery.managed.cloudUrl && discovery.managed.cloudToken) {
        updateSettings({
          cloudInstance: {
            ...CLOUD_INSTANCE_CLEARED.cloudInstance,
            mode: 'cloud',
            cloudUrl: discovery.managed.cloudUrl,
            cloudToken: discovery.managed.cloudToken,
            providerId: 'mindstone',
            provisionMode: 'managed',
            provisionedAt: Date.now(),
          },
        });
      } else if (discovery.managed.cloudUrl) {
        logger.warn('Conflict resolution: managed instance has no cloudToken — user may need to re-setup');
        // Route through the canonical local-clear chokepoint so the teardown
        // generation bumps — otherwise an in-flight reattach could resurrect
        // stale creds (the C-F2 TOCTOU class) on this conflict path too.
        clearCloudInstanceLocally();
      }

      return { success: true, warning: byokCleanupWarning };
    } else {
      // User wants to keep BYOK — deprovision managed
      if (!accessToken) {
        return { success: false, error: 'Not signed in. Please sign in to remove Mindstone Cloud.' };
      }

      try {
        const res = await fetch(`${API_URL}/api/cloud/managed/provision`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const errorBody = await extractErrorMessage(res, 'Failed to remove Mindstone Cloud');
          return { success: false, error: errorBody };
        }

        const data = await res.json() as { success: boolean; error?: string };
        if (!data.success) {
          return { success: false, error: data.error ?? 'Failed to remove Mindstone Cloud.' };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to remove Mindstone Cloud: ${message}` };
      }

      // The managed instance was just destroyed. Bump the teardown generation
      // NOW — unconditionally, the instant the DELETE succeeds — so an in-flight
      // `cloud:reattach-managed` whose discovery returned stale managed creds is
      // superseded and cannot write `mode:'cloud'` back (the C-F2 TOCTOU). This
      // must happen even when settings already point to BYOK (the clear below is
      // skipped in that case), because the destroy intent — not the local clear
      // — is what makes a concurrent reattach stale.
      bumpCloudTeardownGeneration();

      // If settings don't already point to BYOK, update them
      if (discovery.activeInSettings !== 'byok' && discovery.byok.cloudUrl) {
        // We need the BYOK cloud token — but we may not have it if settings pointed to managed.
        // In that case the user will need to reconnect manually. Just clear managed settings.
        // Route through the canonical local-clear chokepoint (also bumps the
        // generation; the bump above already covers the activeInSettings==='byok'
        // case where this clear is skipped).
        clearCloudInstanceLocally();
      }
    }

    return { success: true };
  });

  // cloud:reattach-managed — Recover an already-running managed (Mindstone Cloud)
  // instance after a local "Forget" wiped the config. Re-runs discovery and, if
  // the backend still reports a managed instance with usable credentials, writes
  // them back into settings so the app reconnects without re-provisioning (which
  // the backend rejects with "Instance already exists or is being provisioned").
  registerHandler('cloud:reattach-managed', async () => {
    const { discoverCloudInstances } = await import('@core/services/cloud/cloudInstanceDiscovery');

    // Capture the teardown generation BEFORE any async work. If a concurrent
    // managed/BYOK destroy (or "Forget") runs while we await discovery, it bumps
    // the generation; we re-check right before writing creds and abort if it
    // moved — otherwise we'd resurrect `mode:'cloud'` creds at a destroyed
    // instance (the reattach↔destroy TOCTOU this guard closes).
    const reattachGeneration = cloudTeardownGeneration;

    let accessToken: string | null = null;
    try {
      accessToken = await withTimeout(
        getRebelAuthProvider().getAccessToken(),
        DEPROVISION_AUTH_TIMEOUT_MS,
        'Timed out reaching Mindstone Cloud sign-in',
      );
    } catch (err) {
      logger.warn({ err }, 'Managed re-attach: auth timed out');
      return { success: false, error: "Couldn't reach Mindstone Cloud sign-in. Try again in a minute." };
    }

    if (!accessToken) {
      return { success: false, error: 'Not signed in. Please sign in to reconnect Mindstone Cloud.' };
    }

    const discovery = await discoverCloudInstances({
      apiUrl: API_URL,
      accessToken,
      cloudInstance: getSettings().cloudInstance,
    });

    if (!discovery.managed.exists) {
      return { success: false, error: "We couldn't find a Mindstone Cloud instance for your account. Set one up to get started." };
    }

    // Re-attach only works if discovery handed back usable credentials. If the
    // instance exists but its token can't be recovered, the user must destroy
    // and re-provision (a fresh provision is blocked while the orphan exists).
    if (!discovery.managed.cloudUrl || !discovery.managed.cloudToken) {
      logger.warn(
        { hasUrl: !!discovery.managed.cloudUrl },
        'Managed re-attach: instance exists but credentials are not recoverable',
      );
      return {
        success: false,
        needsReprovision: true,
        error: "Your Mindstone Cloud instance is running, but we couldn't recover its access automatically. Destroy it and set up again to continue.",
      };
    }

    // Pre-write TOCTOU re-check (mirrors the reconciler's mode re-read at
    // cloudConnectionReconciler.ts). A managed/BYOK destroy or "Forget" can run
    // between the discovery above and this synchronous write. If the teardown
    // generation moved, the instance we discovered may have just been destroyed
    // — abort rather than write stale `mode:'cloud'` creds. The settings
    // re-read is a cheap belt-and-suspenders: if a concurrent wipe already
    // flipped us out of a clean post-destroy state we also decline. Generation
    // is the SSOT for correctness.
    if (cloudTeardownGeneration !== reattachGeneration) {
      logger.warn(
        { reattachGeneration, currentGeneration: cloudTeardownGeneration },
        'Managed re-attach aborted — cloud instance was torn down while reconnecting',
      );
      return {
        success: false,
        superseded: true,
        error: 'Your Mindstone Cloud instance was removed while reconnecting. Set one up again to continue.',
      };
    }

    updateSettings({
      cloudInstance: {
        ...CLOUD_INSTANCE_CLEARED.cloudInstance,
        mode: 'cloud',
        cloudUrl: discovery.managed.cloudUrl,
        cloudToken: discovery.managed.cloudToken,
        providerId: 'mindstone',
        provisionMode: 'managed',
        provisionedAt: Date.now(),
      },
    });

    return { success: true };
  });

  // cloud:check-update — Check GHCR/latest cloud version against running cloud instance
  registerHandler('cloud:check-update', async (_event, payload?: { channel?: 'stable' | 'beta' }) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // -----------------------------------------------------------------------
    // Managed instances are updated server-side — just report running version
    // -----------------------------------------------------------------------
    if (ci?.provisionMode === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:check-update', { providerId: ci.providerId });
      if (ossRefusal) return { ...ossRefusal, updateAvailable: false };

      if (!ci.cloudUrl || ci.mode !== 'cloud') {
        return { success: false, updateAvailable: false, error: 'Managed cloud instance is not configured.' };
      }
      try {
        const healthResp = await fetch(`${ci.cloudUrl}/api/health?detailed=true`, {
          headers: ci.cloudToken ? { Authorization: `Bearer ${ci.cloudToken}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (healthResp.ok) {
          const health = await healthResp.json() as { version?: string };
          return { success: true, updateAvailable: false, runningVersion: health.version };
        }
        return { success: true, updateAvailable: false, error: `Health check returned HTTP ${healthResp.status}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, updateAvailable: false, error: `Could not reach managed instance: ${message}` };
      }
    }

    // -----------------------------------------------------------------------
    // BYOK update check — existing flow (unchanged)
    // -----------------------------------------------------------------------
    const { checkForCloudUpdate } = await import('@core/services/cloudUpdateService');

    if (
      !ci?.cloudUrl ||
      ci.mode !== 'cloud' ||
      ci.provisionMode !== 'byok' ||
      !ci.flyAppName ||
      !ci.flyMachineId
    ) {
      return {
        success: false,
        updateAvailable: false,
        error: 'BYOK cloud instance is not configured for updates.',
      };
    }

    const channel = payload?.channel ?? settings.cloudUpdateChannel ?? getCloudUpdateChannel(getBuildChannel());

    return checkForCloudUpdate({
      cloudUrl: ci.cloudUrl,
      flyAppName: ci.flyAppName,
      channel,
    });
  });

  // cloud:apply-update — Trigger cloud service self-update via admin endpoint
  registerHandler('cloud:apply-update', async (_event, payload?: { latestTag?: string; channel?: 'stable' | 'beta' }) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // Managed instances: route through rebel-platform endpoints
    if (ci?.provisionMode === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:apply-update', { providerId: ci.providerId });
      if (ossRefusal) return { ...ossRefusal, updated: false };

      const startTime = Date.now();
      const channel = payload?.channel;
      const isChannelSwitch = !!channel && channel !== getSettings().cloudUpdateChannel;

      logger.info(
        { provisionMode: 'managed', hasChannel: !!channel, isChannelSwitch },
        'Managed cloud update requested',
      );

      let accessToken: string | null;
      try {
        accessToken = await getRebelAuthProvider().getAccessToken();
      } catch {
        return { success: false, updated: false, error: 'Failed to retrieve authentication token.' };
      }
      if (!accessToken) {
        return { success: false, updated: false, error: 'Not signed in. Please sign in to update Mindstone Cloud.' };
      }

      // Determine endpoint: channel switch vs pure update
      const endpoint = isChannelSwitch
        ? `${API_URL}/api/cloud/managed/channel`
        : `${API_URL}/api/cloud/managed/update`;
      const body = isChannelSwitch ? JSON.stringify({ channel }) : JSON.stringify({});

      let postResp: Response;
      try {
        postResp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, endpoint }, 'Managed cloud update POST failed');
        return { success: false, updated: false, error: `Failed to reach update service: ${message}` };
      }

      if (!postResp.ok) {
        let errorMsg: string;
        try {
          const errorBody = await postResp.json() as Record<string, unknown>;
          errorMsg = normalizePlatformError(errorBody.error ?? errorBody);
        } catch {
          errorMsg = `Update request failed (HTTP ${postResp.status})`;
        }
        logger.warn({ status: postResp.status, error: errorMsg }, 'Managed cloud update POST returned error');
        return { success: false, updated: false, error: errorMsg };
      }

      // Check POST response — if { success: false }, return failure immediately (don't poll)
      let postResult: { success: boolean; error?: unknown };
      try {
        postResult = await postResp.json() as { success: boolean; error?: unknown };
      } catch {
        return { success: false, updated: false, error: 'Update request returned an invalid response.' };
      }

      if (!postResult.success) {
        const errorMsg = normalizePlatformError(postResult.error);
        logger.warn({ error: errorMsg }, 'Managed cloud update POST returned success:false');
        return { success: false, updated: false, error: errorMsg };
      }

      logger.info({ endpoint }, 'Managed cloud update POST succeeded, starting poll');

      // Poll until the instance completes the update
      const pollResult = await pollManagedUpdateCompletion(accessToken);
      const durationMs = Date.now() - startTime;

      if (!pollResult.success) {
        logger.warn({ error: pollResult.error, durationMs }, 'Managed cloud update poll failed');
        return { success: false, updated: false, error: pollResult.error };
      }

      // On success with channel switch: persist cloudUpdateChannel (handler owns persistence)
      if (isChannelSwitch && channel) {
        updateSettings({ cloudUpdateChannel: channel });
      }

      logger.info({ durationMs, isChannelSwitch }, 'Managed cloud update completed successfully');
      return { success: true, updated: true };
    }

    if (!ci?.cloudUrl || ci.mode !== 'cloud') {
      return {
        success: false,
        updated: false,
        error: 'Cloud instance is not configured.',
      };
    }

    const channel = payload?.channel ?? settings.cloudUpdateChannel ?? getCloudUpdateChannel(getBuildChannel());

    const triggerUrl = `${ci.cloudUrl.replace(/\/+$/, '')}/api/admin/trigger-update`;
    try {
      const resp = await fetch(triggerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ci.cloudToken}`,
        },
        body: JSON.stringify({ channel }),
        signal: AbortSignal.timeout(120_000),
      });

      if (resp.ok) {
        const result = await resp.json() as Record<string, unknown>;
        return {
          success: result.success as boolean ?? false,
          updated: result.updated as boolean ?? false,
          latestTag: result.latestTag as string | undefined,
          rateLimited: result.rateLimited as boolean | undefined,
          error: result.error as string | undefined,
        };
      }

      const body = await resp.text();
      return { success: false, updated: false, error: `Cloud update request failed: HTTP ${resp.status} ${body}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'Cloud trigger-update request failed');
      return { success: false, updated: false, error: `Failed to reach cloud service: ${message}` };
    }
  });

  // cloud:repair-ingress — Allocate shared IPv4 for a canonical *.fly.dev cloud instance missing public IP
  registerHandler('cloud:repair-ingress', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // Managed instances are maintained automatically
    if (ci?.provisionMode === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:repair-ingress', { providerId: ci.providerId });
      if (ossRefusal) return ossRefusal;

      return { success: false, error: 'Your managed cloud is maintained for you — no manual repair needed here.' };
    }

    // Validate scope: only Fly-backed providers with stored Fly PAT
    if (!ci?.cloudUrl || !ci.flyAppName) {
      return { success: false, error: 'No Fly app configured.' };
    }
    if (ci.providerId !== 'fly') {
      return { success: false, error: 'Ingress repair is only available for Fly-backed instances.' };
    }

    const { loadFlyApiToken } = await import('../services/flyTokenStorage');
    const flyApiToken = loadFlyApiToken();
    if (!flyApiToken) {
      return { success: false, error: 'Fly API token not found. Link your Fly token first.' };
    }

    const { allocateSharedIpv4 } = await import('@core/services/flyApiClient');
    const result = await allocateSharedIpv4(flyApiToken, ci.flyAppName);

    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to allocate public IP.' };
    }

    if (result.alreadyExists) {
      return { success: true, address: result.address, alreadyExists: true };
    }

    // Poll /api/health with 60s timeout to confirm DNS propagation
    const POLL_TIMEOUT_MS = 60_000;
    const POLL_INTERVAL_MS = 3_000;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let reachable = false;

    while (Date.now() < deadline) {
      reachable = await verifyHealth(ci.cloudUrl);
      if (reachable) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!reachable) {
      logger.warn({ appName: ci.flyAppName }, 'IPv4 allocated but health check not yet reachable after 60s');
    }

    // Trigger immediate event channel reconnect after successful repair
    try {
      const { cloudEventChannel } = await import('../services/cloud/cloudEventChannel');
      cloudEventChannel.reconnectNow();
    } catch { /* best-effort */ }

    return { success: true, address: result.address };
  });

  // cloud:repair-token — Repair REBEL_CLOUD_TOKEN in the Fly machine environment
  registerHandler('cloud:repair-token', async (_event, payload?: { force?: boolean }) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // Managed instances are maintained automatically
    if (ci?.provisionMode === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:repair-token', { providerId: ci.providerId });
      if (ossRefusal) return ossRefusal;

      return { success: false, error: 'Your managed cloud rotates its own secrets — no manual token repair needed.' };
    }

    if (!ci?.cloudUrl || !ci.cloudToken || !ci.flyAppName || !ci.flyMachineId) {
      return { success: false, error: 'No Fly app configured with machine metadata.' };
    }
    if (ci.providerId !== 'fly') {
      return { success: false, error: 'Token repair is only available for Fly-backed instances.' };
    }

    const { loadFlyApiToken } = await import('../services/flyTokenStorage');
    const flyApiToken = loadFlyApiToken();
    if (!flyApiToken) {
      return { success: false, error: 'Fly API token not found. Link your Fly token first.' };
    }

    // Verify auth actually fails before offering repair
    const authOk = await verifyAuth(ci.cloudUrl, ci.cloudToken);
    if (authOk) {
      return { success: true, alreadyCorrect: true };
    }

    const { repairMachineEnvToken } = await import('@core/services/cloudUpdateService');
    const result = await repairMachineEnvToken({
      flyApiToken,
      flyAppName: ci.flyAppName,
      flyMachineId: ci.flyMachineId,
      localToken: ci.cloudToken,
      cloudUrl: ci.cloudUrl,
      force: payload?.force,
    });

    // Trigger immediate event channel reconnect after successful repair
    if (result.success && !result.alreadyCorrect) {
      try {
        const { cloudEventChannel } = await import('../services/cloud/cloudEventChannel');
        cloudEventChannel.reconnectNow();
      } catch { /* best-effort */ }
    }

    return result;
  });

  // cloud:get-vm-tier — Return the current tier (read-through to Fly machine state).
  registerHandler('cloud:get-vm-tier', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // Resolved provider falls back to 'fly' for legacy BYOK records that pre-date
    // the explicit `providerId` field but still have flyAppName + flyMachineId
    // (the four-field implication is sound: BYOK + Fly app + Fly machine ⇒ Fly).
    const resolvedProviderId = ci?.providerId ?? (ci?.provisionMode === 'byok' && ci?.flyAppName && ci?.flyMachineId ? 'fly' : undefined);
    if (ci?.provisionMode !== 'byok' || resolvedProviderId !== 'fly' || !ci.flyAppName || !ci.flyMachineId) {
      return { success: false, error: 'Tier selection is only available for self-hosted Fly cloud instances.' };
    }

    const { loadFlyApiToken } = await import('../services/flyTokenStorage');
    const flyApiToken = loadFlyApiToken();
    if (!flyApiToken) {
      return { success: false, error: 'Fly API token not found. Link your Fly token first.' };
    }

    const { getCurrentVmTier } = await import('@core/services/cloud/vmTierService');
    return getCurrentVmTier({
      flyApiToken,
      flyAppName: ci.flyAppName,
      flyMachineId: ci.flyMachineId,
    });
  });

  // cloud:get-volume-status — Return inside-VM storage usage (works for managed
  // and Fly BYOK; resize/tier controls are still BYOK-only).
  registerHandler('cloud:get-volume-status', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    const resolvedProviderId = ci?.providerId ?? (ci?.provisionMode === 'byok' && ci?.flyAppName && ci?.flyMachineId ? 'fly' : undefined);
    if (!ci || ci.mode !== 'cloud' || !ci.cloudUrl) {
      return { kind: 'not_applicable' as const, reason: 'not_connected' as const };
    }

    const isManaged = ci.provisionMode === 'managed' || resolvedProviderId === 'mindstone';
    let flyApiToken: string | null = null;

    if (isManaged && isOssBuild()) {
      logManagedCloudOssRefusal('cloud:get-volume-status', { providerId: resolvedProviderId });
      return { kind: 'not_applicable' as const, reason: 'managed' as const };
    }

    if (!isManaged) {
      if (ci.provisionMode !== 'byok') {
        return { kind: 'not_applicable' as const, reason: 'not_byok' as const };
      }
      if (resolvedProviderId !== 'fly') {
        return { kind: 'not_applicable' as const, reason: 'non_fly' as const };
      }
      const { loadFlyApiToken } = await import('../services/flyTokenStorage');
      flyApiToken = loadFlyApiToken();
      if (!flyApiToken) {
        return { kind: 'fly_token_missing' as const };
      }
    }

    const { getVolumeStatus } = await import('@core/services/cloud/cloudVolumeService');
    const result = await getVolumeStatus({
      cloudInstance: ci,
      flyApiToken,
    });

    if (result.kind === 'ok') {
      try {
        const latest = getSettings().cloudInstance;
        if (!latest) return result;
        updateSettings({
          cloudInstance: {
            ...latest,
            flyVolumeSizeGb: result.sizeGb,
            lastVolumeUsedBytes: result.usedBytes,
            lastVolumeAvailableBytes: result.availableBytes,
            lastVolumeUsageCheckedAt: result.lastCheckedAt,
          },
        });
      } catch (err) {
        logger.warn(
          { err, flyAppName: ci.flyAppName, flyMachineId: ci.flyMachineId },
          'Failed to persist cloud volume status cache',
        );
      }
    }

    return result;
  });

  // cloud:resize-volume — Extend Fly storage and verify the guest sees it.
  registerHandler('cloud:resize-volume', async (_event, payload?: { targetSizeGb?: number }) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;
    const rawTargetSizeGb = payload?.targetSizeGb;

    const resolvedProviderId = ci?.providerId ?? (ci?.provisionMode === 'byok' && ci?.flyAppName && ci?.flyMachineId ? 'fly' : undefined);
    if (ci?.provisionMode !== 'byok' || resolvedProviderId !== 'fly') {
      return { success: false, applied: false, error: 'Storage controls are only available for self-hosted Fly cloud instances.' };
    }
    if (!ci.cloudUrl || !ci.flyAppName || !ci.flyMachineId || !ci.flyVolumeId) {
      return { success: false, applied: false, error: 'No Fly app configured with volume metadata.' };
    }
    if (typeof rawTargetSizeGb !== 'number' || !Number.isInteger(rawTargetSizeGb) || rawTargetSizeGb < 10 || rawTargetSizeGb > 500) {
      return { success: false, applied: false, error: 'Choose a new total storage size between 10 GB and 500 GB.' };
    }
    const targetSizeGb = rawTargetSizeGb;

    const { agentTurnRegistry } = await import('@core/services/agentTurnRegistry');
    if (agentTurnRegistry.getActiveTurnCount() > 0) {
      return {
        success: false,
        applied: false,
        error: 'Can\'t resize storage while a conversation is active. Wait for the current response to finish.',
      };
    }

    const { loadFlyApiToken } = await import('../services/flyTokenStorage');
    const flyApiToken = loadFlyApiToken();
    if (!flyApiToken) {
      return { success: false, applied: false, error: 'Fly API token not found. Link your Fly token first.' };
    }

    const { resizeVolume, getVolumeStatus } = await import('@core/services/cloud/cloudVolumeService');
    const result = await resizeVolume({
      cloudInstance: ci,
      flyApiToken,
      targetSizeGb,
      getActiveTurnCount: () => agentTurnRegistry.getActiveTurnCount(),
    });

    let settingsPersisted: boolean | undefined;
    if (result.success) {
      try {
        const status = await getVolumeStatus({ cloudInstance: ci, flyApiToken });
        const latest = getSettings().cloudInstance;
        if (!latest) {
          settingsPersisted = false;
          logger.warn(
            { targetSizeGb, flyAppName: ci.flyAppName, flyMachineId: ci.flyMachineId, flyVolumeId: ci.flyVolumeId },
            'Skipped persisting cloud volume resize result because cloud instance was disconnected',
          );
          return { ...result, settingsPersisted };
        }
        if (status.kind === 'ok') {
          updateSettings({
            cloudInstance: {
              ...latest,
              flyVolumeSizeGb: result.sizeGbAfter ?? targetSizeGb,
              lastVolumeUsedBytes: status.usedBytes,
              lastVolumeAvailableBytes: status.availableBytes,
              lastVolumeUsageCheckedAt: status.lastCheckedAt,
            },
          });
        } else {
          updateSettings({
            cloudInstance: {
              ...latest,
              flyVolumeSizeGb: result.sizeGbAfter ?? targetSizeGb,
              lastVolumeUsageCheckedAt: Date.now(),
            },
          });
        }
        settingsPersisted = true;
      } catch (err) {
        settingsPersisted = false;
        logger.warn(
          { err, targetSizeGb, flyAppName: ci.flyAppName, flyMachineId: ci.flyMachineId, flyVolumeId: ci.flyVolumeId },
          'Failed to persist cloud volume resize result',
        );
      }
    }

    return settingsPersisted === undefined ? result : { ...result, settingsPersisted };
  });

  // cloud:change-vm-tier — Change the tier with active-turn + BYOK guards and health verification.
  registerHandler('cloud:change-vm-tier', async (_event, payload?: { tierId?: string }) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // See cloud:get-vm-tier above for the legacy-providerId fallback rationale.
    const resolvedProviderId = ci?.providerId ?? (ci?.provisionMode === 'byok' && ci?.flyAppName && ci?.flyMachineId ? 'fly' : undefined);
    if (ci?.provisionMode !== 'byok' || resolvedProviderId !== 'fly') {
      return { success: false, error: 'Tier selection is only available for self-hosted Fly cloud instances.' };
    }
    if (!ci.cloudUrl || !ci.flyAppName || !ci.flyMachineId) {
      return { success: false, error: 'No Fly app configured with machine metadata.' };
    }

    const { agentTurnRegistry } = await import('@core/services/agentTurnRegistry');
    if (agentTurnRegistry.getActiveTurnCount() > 0) {
      return {
        success: false,
        error: 'Can\'t change tiers while a conversation is active. Wait for the current response to finish.',
      };
    }

    const { getTierById } = await import('@core/services/cloud/vmTierCatalog');
    const tier = getTierById(payload?.tierId);
    if (!tier) {
      return { success: false, error: `Unknown tier: ${payload?.tierId}` };
    }

    const { loadFlyApiToken } = await import('../services/flyTokenStorage');
    const flyApiToken = loadFlyApiToken();
    if (!flyApiToken) {
      return { success: false, error: 'Fly API token not found. Link your Fly token first.' };
    }

    const { changeVmTier } = await import('@core/services/cloud/vmTierService');
    const result = await changeVmTier({
      flyApiToken,
      flyAppName: ci.flyAppName,
      flyMachineId: ci.flyMachineId,
      cloudUrl: ci.cloudUrl,
      tier,
      getActiveTurnCount: () => agentTurnRegistry.getActiveTurnCount(),
    });

    let settingsPersisted: boolean | undefined;
    if (result.success) {
      try {
        updateSettings({ cloudInstance: { ...ci, vmTierId: tier.id } });
        settingsPersisted = true;
      } catch (err) {
        settingsPersisted = false;
        logger.warn(
          { err, tierId: tier.id, flyAppName: ci.flyAppName, flyMachineId: ci.flyMachineId },
          'Failed to persist vmTierId after successful tier change',
        );
      }
    }

    return settingsPersisted === undefined ? result : { ...result, settingsPersisted };
  });

  // cloud:repair-fly-token — Bootstrap FLY_API_TOKEN as a Fly secret on the
  // user's cloud app so its in-process self-update scheduler can run without
  // the desktop. Eager mode: writes the secret AND restarts the machine.
  registerHandler('cloud:repair-fly-token', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    if (ci?.provisionMode === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:repair-fly-token', { providerId: ci.providerId });
      if (ossRefusal) return ossRefusal;

      return { success: false, error: 'Managed cloud instances are updated automatically — no repair needed.' };
    }

    if (!ci?.flyAppName || !ci.flyMachineId) {
      return { success: false, error: 'No Fly app configured with machine metadata.' };
    }
    if (ci.providerId !== 'fly') {
      return { success: false, error: 'FLY_API_TOKEN repair is only available for Fly-backed instances.' };
    }

    if (ci.flyApiTokenSecretRepairedAt) {
      return { success: true, alreadyRepaired: true };
    }

    const { loadFlyApiToken } = await import('../services/flyTokenStorage');
    const flyApiToken = loadFlyApiToken();
    if (!flyApiToken) {
      return { success: false, error: 'Fly API token not found. Link your Fly token first.' };
    }

    const { repairFlyApiTokenSecretEager } = await import('@core/services/cloudUpdateService');
    const result = await repairFlyApiTokenSecretEager({
      flyApiToken,
      flyAppName: ci.flyAppName,
      flyMachineId: ci.flyMachineId,
    });

    if (result.success) {
      try {
        updateSettings({
          cloudInstance: { ...ci, flyApiTokenSecretRepairedAt: Date.now() },
        });
      } catch (err) {
        logger.warn({ err, flyAppName: ci.flyAppName }, 'Failed to persist flyApiTokenSecretRepairedAt timestamp');
      }
    }

    return result;
  });

  // cloud:machine-state — Get current Fly machine state for update progress monitoring
  registerHandler('cloud:machine-state', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // Only available for Fly BYOK instances
    if (ci?.provisionMode === 'managed' || !ci?.flyAppName || !ci?.flyMachineId) {
      if (ci?.provisionMode === 'managed' && isOssBuild()) {
        logManagedCloudOssRefusal('cloud:machine-state', { providerId: ci.providerId });
      }
      return { success: false, error: 'not_available' };
    }

    const { loadFlyApiToken } = await import('../services/flyTokenStorage');
    const apiToken = loadFlyApiToken();
    if (!apiToken) {
      return { success: false, error: 'not_available' };
    }

    try {
      const { flyFetch } = await import('@core/services/flyApiClient');
      const resp = await flyFetch(apiToken, `/v1/apps/${ci.flyAppName}/machines/${ci.flyMachineId}`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!resp.ok) {
        const body = await resp.text();
        return { success: false, error: `HTTP ${resp.status}: ${body}` };
      }

      const raw = await resp.json() as Record<string, unknown>;
      const checks = Array.isArray(raw.checks)
        ? raw.checks
          .filter((check): check is Record<string, unknown> => check !== null && typeof check === 'object')
          .map((check) => ({
            name: String(check.name ?? ''),
            status: String(check.status ?? ''),
            ...(typeof check.output === 'string' ? { output: check.output } : {}),
          }))
        : undefined;

      return {
        success: true,
        machine: {
          state: String(raw.state ?? 'unknown'),
          checks,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, appName: ci.flyAppName, machineId: ci.flyMachineId }, 'Cloud machine state lookup failed');
      return { success: false, error: message };
    }
  });

  // cloud:auth-relay — Relay OAuth tokens to the cloud service
  registerHandler('cloud:auth-relay', async (_event, payload: { provider: string; tokenData: Record<string, unknown>; accountId?: string }) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;
    if (!ci?.cloudUrl || !ci.cloudToken || ci.mode !== 'cloud') {
      return { success: false, error: 'Cloud not connected' };
    }

    try {
      const resp = await fetch(`${ci.cloudUrl}/api/auth/relay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ci.cloudToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      return { success: resp.ok };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, provider: payload.provider }, 'Auth token relay failed');
      return { success: false, error: message };
    }
  });

  // cloud:wake — Wake a stopped Fly Machine by hitting its health endpoint
  registerHandler('cloud:wake', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    if (!ci?.cloudUrl || ci.mode !== 'cloud') {
      return { success: false, error: 'Cloud instance not configured or not in cloud mode' };
    }

    try {
      logger.info('Waking cloud service via health ping');

      // Fly Machines with auto-start wake on incoming requests.
      // Poll until healthy (up to ~60s).
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const resp = await fetch(`${ci.cloudUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
          if (resp.ok) {
            logger.info({ attempt }, 'Cloud service is healthy');
            return { success: true };
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 3_000));
      }

      return { success: true, warning: 'Cloud service is starting but not yet healthy' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'Failed to wake cloud service');
      return { success: false, error: message };
    }
  });

  // cloud:export-diagnostics — Export a redacted diagnostic bundle
  registerHandler('cloud:export-diagnostics', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    const localMetadata = {
      cloudUrl: ci?.cloudUrl,
      flyAppName: ci?.flyAppName,
      flyMachineId: ci?.flyMachineId,
      flyRegion: ci?.flyRegion,
      providerId: ci?.providerId ?? 'fly',
      provisionMode: ci?.provisionMode,
      mode: ci?.mode,
      lastKnownStatus: ci?.lastKnownStatus,
      lastSyncedAt: ci?.lastSyncedAt,
      cloudToken: ci?.cloudToken ? '***redacted***' : undefined,
    };

    let remoteDiagnostics: Record<string, unknown> | null = null;
    if (ci?.cloudUrl && ci?.cloudToken) {
      try {
        const resp = await fetch(`${ci.cloudUrl}/api/diagnostics`, {
          headers: { Authorization: `Bearer ${ci.cloudToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          remoteDiagnostics = await resp.json() as Record<string, unknown>;
        }
      } catch {
        // Cloud unreachable — include local-only bundle
      }
    }

    const bundle = {
      exportedAt: new Date().toISOString(),
      local: localMetadata,
      remote: remoteDiagnostics ?? { unavailable: true, reason: 'Cloud service unreachable or not configured' },
    };

    return { success: true, bundle };
  });

  // cloud:outbox-status — Get current outbox pending/failed counts (local-only)
  registerHandler('cloud:outbox-status', async () => {
    const { cloudOutbox } = await import('../services/cloud/cloudOutbox');
    return cloudOutbox.getStatus();
  });

  // cloud:workspace-conflict-list — List pending workspace conflict files +
  // pending cloud updates (newer cloud-only versions awaiting a safe apply).
  registerHandler('cloud:workspace-conflict-list', async () => {
    const coreDirectory = getSettings().coreDirectory;
    if (!coreDirectory) {
      logger.warn('Workspace conflict list requested without a configured workspace');
      return { conflicts: [], pendingUpdates: [] };
    }

    const conflicts = await listWorkspaceConflicts(coreDirectory);
    // Pending cloud updates are read straight from the store (no filesystem walk):
    // they are files edited elsewhere whose newer version lives only in the cloud,
    // deliberately NOT written into the OS-synced workspace (REBEL-696 Stage 5).
    // Map to the PUBLIC shape ({ relativePath } only): the store-internal hashes
    // and timestamps stay main-side and never cross the preload boundary — the
    // apply handler reads the baseline FROM the store, not from the renderer.
    const { getPendingCloudUpdates } = await import('../services/cloud/cloudPendingUpdateStore');
    const pendingUpdates = getPendingCloudUpdates(coreDirectory).map((update) => ({
      relativePath: update.relativePath,
    }));
    return { conflicts, pendingUpdates };
  });

  // cloud:workspace-conflict-merge — Generate an LLM merge proposal for one conflict
  registerHandler('cloud:workspace-conflict-merge', async (_event, payload: { relativePath: string }) => {
    const coreDirectory = getSettings().coreDirectory;
    if (!coreDirectory) {
      return { success: false, error: 'Workspace is not configured.' };
    }

    const conflict = await findWorkspaceConflictByRelativePath(coreDirectory, payload.relativePath);
    if (!conflict) {
      return { success: false, error: `No conflict found for ${normalizeRelativePath(payload.relativePath)}.` };
    }

    if (!isCloudCopyPathSafe(conflict.cloudCopyPath, path.resolve(coreDirectory))) {
      logger.warn(
        { relativePath: conflict.relativePath, cloudCopyPath: conflict.cloudCopyPath },
        'Refusing to merge conflict: cloudCopyPath is outside workspace + quarantine roots',
      );
      return { success: false, error: 'Conflict copy path is no longer valid.' };
    }

    try {
      const [localContent, cloudContent] = await Promise.all([
        fs.readFile(conflict.localPath, 'utf8'),
        fs.readFile(conflict.cloudCopyPath, 'utf8'),
      ]);

      const { proposeMerge } = await import('@core/services/workspaceConflictResolver');
      return proposeMerge(getSettings(), localContent, cloudContent, conflict.relativePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { relativePath: conflict.relativePath, err: message },
        'Failed to build workspace conflict merge proposal',
      );
      return { success: false, error: `Failed to merge conflict: ${message}` };
    }
  });

  // cloud:workspace-conflict-resolve — Resolve conflict by selected strategy
  registerHandler('cloud:workspace-conflict-resolve', async (
    _event,
    payload: {
      relativePath: string;
      resolution: 'accept-merge' | 'keep-local' | 'keep-cloud';
      mergedContent?: string;
    },
  ) => {
    const coreDirectory = getSettings().coreDirectory;
    if (!coreDirectory) {
      return { success: false, error: 'Workspace is not configured.' };
    }

    const conflict = await findWorkspaceConflictByRelativePath(coreDirectory, payload.relativePath);
    if (!conflict) {
      return { success: false, error: `No conflict found for ${normalizeRelativePath(payload.relativePath)}.` };
    }

    if (!isCloudCopyPathSafe(conflict.cloudCopyPath, path.resolve(coreDirectory))) {
      logger.warn(
        { relativePath: conflict.relativePath, cloudCopyPath: conflict.cloudCopyPath, resolution: payload.resolution },
        'Refusing to resolve conflict: cloudCopyPath is outside workspace + quarantine roots',
      );
      return { success: false, error: 'Conflict copy path is no longer valid.' };
    }

    try {
      // Read cloud copy content BEFORE deleting it — we need its hash for manifest bookkeeping.
      const cloudCopyContent = await fs.readFile(conflict.cloudCopyPath, 'utf8');
      const cloudCopyHash = hashWorkspaceContent(cloudCopyContent);

      let finalLocalContent = '';

      if (payload.resolution === 'accept-merge') {
        if (typeof payload.mergedContent !== 'string') {
          return { success: false, error: 'Merged content is required for accept-merge resolution.' };
        }

        finalLocalContent = payload.mergedContent;
        await fs.mkdir(path.dirname(conflict.localPath), { recursive: true });
        await fs.writeFile(conflict.localPath, finalLocalContent, 'utf8');
        await removeConflictCopy(conflict.cloudCopyPath);
        removeQuarantinedWorkspaceConflict(coreDirectory, conflict.relativePath);
      } else if (payload.resolution === 'keep-local') {
        finalLocalContent = await fs.readFile(conflict.localPath, 'utf8');
        await removeConflictCopy(conflict.cloudCopyPath);
        removeQuarantinedWorkspaceConflict(coreDirectory, conflict.relativePath);
      } else {
        // keep-cloud: overwrite local with cloud content
        finalLocalContent = cloudCopyContent;
        await fs.mkdir(path.dirname(conflict.localPath), { recursive: true });
        await fs.writeFile(conflict.localPath, finalLocalContent, 'utf8');
        await removeConflictCopy(conflict.cloudCopyPath);
        removeQuarantinedWorkspaceConflict(coreDirectory, conflict.relativePath);
      }

      const stat = await fs.stat(conflict.localPath);
      const { cloudWorkspaceSync } = await import('../services/cloud/cloudWorkspaceSync');

      // For keep-local and accept-merge: record the CLOUD hash as lastPushed.
      // This ensures getChangedFiles() sees local != lastPushed → pushes resolved version,
      // and pullChangedFiles() sees cloud == lastPushed → skips re-pull.
      // For keep-cloud: record the final (cloud) content hash — local now matches cloud.
      const manifestHash = payload.resolution === 'keep-cloud'
        ? hashWorkspaceContent(finalLocalContent)
        : cloudCopyHash;

      cloudWorkspaceSync.recordPulledFile(conflict.relativePath, {
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
        hash: manifestHash,
      });

      cloudWorkspaceSync.clearBroadcastedConflict(conflict.relativePath);

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { relativePath: conflict.relativePath, resolution: payload.resolution, err: message },
        'Failed resolving workspace conflict',
      );
      return { success: false, error: `Failed to resolve conflict: ${message}` };
    }
  });

  // cloud:workspace-pending-update-apply — Apply one pending cloud update.
  // Fast-forwards a single Drive/Dropbox/iCloud-owned file to the newer cloud-only
  // version (edited on phone/web). Keep-cloud semantics, user-initiated one-shot.
  // The router owns the client + workspace lookup; the workspace-sync service does
  // the hash-gated read → atomic write → record → clear. REBEL-696 Stage 5.
  registerHandler('cloud:workspace-pending-update-apply', async (_event, payload: { relativePath: string }) => {
    const { cloudRouter } = await import('../services/cloud/cloudRouter');
    const result = await cloudRouter.applyPendingCloudUpdate(payload.relativePath);
    if (!result.success) {
      logger.warn(
        { relativePath: payload.relativePath, reason: result.reason },
        'Failed to apply pending cloud update',
      );
    }
    return result;
  });

  // cloud:workspace-force-sync — Force an immediate workspace sync to cloud
  registerHandler('cloud:workspace-force-sync', async () => {
    const { cloudRouter } = await import('../services/cloud/cloudRouter');
    return cloudRouter.forceWorkspaceSync();
  });

  // cloud:sync-now — Run a full incremental sync across all domains
  registerHandler('cloud:sync-now', async () => {
    const { cloudRouter } = await import('../services/cloud/cloudRouter');
    return cloudRouter.syncNow();
  });

  // ---------------------------------------------------------------------------
  // Cloud Continuity Channels (local-only — per-session lifecycle management)
  // ---------------------------------------------------------------------------

  registerHandler('cloud-continuity:get-state', async (_event, payload: { sessionId: string }) => {
    const { getContinuityState } = await import('../services/cloud/cloudContinuityMetadata');
    return { state: getContinuityState(payload.sessionId) };
  });

  registerHandler('cloud-continuity:set-state', async (_event, payload: { sessionId: string; state: 'local_only' | 'cloud_active' }) => {
    const { setContinuityState } = await import('../services/cloud/cloudContinuityMetadata');
    setContinuityState(payload.sessionId, payload.state);
    const { getBroadcastService } = await import('@core/broadcastService');
    getBroadcastService().sendToAllWindows('cloud:continuity-changed', {});
    // Immediately sync to cloud: enqueue session data + push continuity map
    const { cloudRouter } = await import('../services/cloud/cloudRouter');
    cloudRouter.syncContinuityChange(payload.sessionId, payload.state).catch((err) => {
      logger.warn({ err }, 'Failed to sync continuity change to cloud');
    });
    return { success: true };
  });

  registerHandler('cloud-continuity:pin', async (_event, payload: { sessionId: string }) => {
    const { pinToCloud } = await import('../services/cloud/cloudContinuityMetadata');
    pinToCloud(payload.sessionId);
    const { getBroadcastService } = await import('@core/broadcastService');
    getBroadcastService().sendToAllWindows('cloud:continuity-changed', {});
    return { success: true };
  });

  registerHandler('cloud-continuity:unpin', async (_event, payload: { sessionId: string }) => {
    const { unpinFromCloud } = await import('../services/cloud/cloudContinuityMetadata');
    unpinFromCloud(payload.sessionId);
    const { getBroadcastService } = await import('@core/broadcastService');
    getBroadcastService().sendToAllWindows('cloud:continuity-changed', {});
    return { success: true };
  });

  registerHandler('cloud-continuity:get-all', async () => {
    const { getAllContinuityStates } = await import('../services/cloud/cloudContinuityMetadata');
    return getAllContinuityStates();
  });

  /** Migrate local data to the cloud service. */
  async function doMigrate() {
    const { migrateToCloud } = await import('../services/cloud/cloudMigrationService');

    const settings = getSettings();
    const ci = settings.cloudInstance;

    if (!ci?.cloudUrl || !ci.cloudToken) {
      return { success: false, error: 'Cloud instance not configured (missing URL or token)' };
    }

    // Flag the in-flight migration so a startup reconcile (after a crash or
    // forced quit) can detect and clean up a partial extract on the cloud side.
    // Cleared in `finally` below.
    updateSettings({
      cloudInstance: { ...ci, migrationInFlight: true },
    });

    try {
      const result = await migrateToCloud({
        cloudUrl: ci.cloudUrl,
        cloudToken: ci.cloudToken,
        getSettings,
        loadSessions: deps.loadAgentSessions ?? (() => []),
        onProgress: (step: MigrationStep) => {
          logger.info(
            {
              phase: step.phase,
              progress: step.progress,
              current: step.current,
              total: step.total,
              runId: step.runId,
              live: step.live,
            },
            step.message,
          );
          // Explicit field-by-field construction so a future MigrationStep
          // extension does not silently drop fields at the IPC boundary.
          // Object spreads + type-punned broadcasts have historically been
          // the failure mode here — see planning doc Stage 5 §5 and the
          // broadcast round-trip test in cloudHandlers.broadcastRoundtrip.test.ts.
          const payload: MigrationStep = {
            phase: step.phase,
            message: step.message,
            progress: step.progress,
            current: step.current,
            total: step.total,
            bytesTotal: step.bytesTotal,
            live: step.live,
            runId: step.runId,
          } satisfies MigrationStep;
          // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: cloud migration progress is a genuine all-window broadcast; migrate later to BroadcastService/cloud event channel.
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('cloud:migration-progress', payload);
          }
        },
      });

      // Full migration supersedes any pending outbox entries — but only
      // clear when there were no errors (partial failures should keep retrying).
      if (result.errors.length === 0) {
        const { cloudOutbox } = await import('../services/cloud/cloudOutbox');
        cloudOutbox.clearAll();
        // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: cloud outbox status is a genuine all-window broadcast; migrate later to BroadcastService/cloud event channel.
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('cloud:outbox-changed', cloudOutbox.getStatus());
        }
      }

      return { success: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Cloud migration failed');
      return { success: false, error: message };
    } finally {
      // Clear the in-flight flag. Re-read settings so we don't clobber
      // concurrent edits (e.g. other provider metadata written mid-migration).
      const latest = getSettings().cloudInstance;
      if (latest) {
        updateSettings({
          cloudInstance: { ...latest, migrationInFlight: false },
        });
      }
    }
  }

  // cloud:migrate — Migrate local data to the cloud service
  registerHandler('cloud:migrate', async () => {
    return doMigrate();
  });

  // cloud:reconcile-migration — Ask the cloud service whether a prior
  // migration extract left a partial directory behind and clean it up if so.
  // Called on startup when `cloudInstance.cloudUrl` is set but we can't be
  // sure the previous migration completed (e.g. the app quit mid-extract).
  // See planning doc Stage 6 (orphan cleanup + reconcile).
  registerHandler(
    'cloud:reconcile-migration',
    async (_event, payload: { target: 'workspace' | 'appdata' }) => {
      const settings = getSettings();
      const ci = settings.cloudInstance;
      if (!ci?.cloudUrl || !ci.cloudToken) {
        return {
          state: 'none' as const,
          error: 'Cloud instance not configured (missing URL or token)',
        };
      }
      try {
        const { CloudServiceClient } = await import('../services/cloud/cloudServiceClient');
        const client = new CloudServiceClient(ci.cloudUrl, ci.cloudToken);
        const res = await client.post('/api/data/reconcile', { target: payload.target });
        const state =
          res && typeof res === 'object' && 'state' in res
            ? (res as { state: 'none' | 'partial_extract' | 'complete' }).state
            : 'none';
        return { state };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, target: payload.target }, 'Reconcile request failed');
        return { state: 'none' as const, error: message };
      }
    },
  );

  // cloud:measure-footprint — Measure total bytes that would be uploaded
  // during cloud migration so the provisioning UI can recommend a
  // right-sized volume. Main-process only: the walker uses fs APIs the
  // renderer can't reach. Never throws — IO errors are folded into
  // `kind: 'unknown_partial'` by the util.
  //
  // See planning doc:
  //   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
  //   (Stage 3 — UI Footprint Measurement + Review-Driven Amendments)
  registerHandler('cloud:measure-footprint', async () => {
    const { getCloudMigrationFootprint } = await import('@core/services/cloud/cloudMigrationFootprint');
    const { getPlatformConfig } = await import('@core/platform');
    const userDataPath = getPlatformConfig().userDataPath;
    const coreDirectory = getSettings().coreDirectory ?? null;
    return getCloudMigrationFootprint({ coreDirectory, userDataPath });
  });

  // ---------------------------------------------------------------------------
  // Provider Switch (non-destructive sequence)
  // ---------------------------------------------------------------------------

  /**
   * Deprovision an old cloud instance using saved config directly.
   * Does NOT update settings (caller is already on the new instance).
   */
  async function deprovisionOldInstance(
    oldConfig: NonNullable<AppSettings['cloudInstance']>,
  ): Promise<void> {
    if (oldConfig.provisionMode === 'managed') {
      if (isOssBuild()) {
        logManagedCloudOssRefusal('cloud:switch-provider.cleanup-old-managed', {
          oldProviderId: oldConfig.providerId,
        });
        throw new Error(OSS_MANAGED_CLOUD_ERROR);
      }

      // Managed: call rebel-platform DELETE
      const accessToken = await getRebelAuthProvider().getAccessToken();
      if (!accessToken) {
        throw new Error('Not signed in — cannot remove old managed instance');
      }
      const res = await fetch(`${API_URL}/api/cloud/managed/provision`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await extractErrorMessage(res, 'DELETE request failed');
        throw new Error(`Failed to remove old managed instance: ${body}`);
      }
      return;
    }

    // BYOK: load provider, get token, deprovision
    const { getCloudProviderOrDefault } = await import('@core/services/cloud/providers');
    const providerId = oldConfig.providerId ?? 'fly';

    const provider = getCloudProviderOrDefault(providerId);

    const instanceId =
      oldConfig.providerMetadata?.dropletId ??
      oldConfig.providerMetadata?.serverId ??
      oldConfig.flyAppName;
    if (!instanceId) {
      throw new Error('No instance ID found in old config');
    }

    // Resolve API token for old provider
    let apiToken: string | null = null;
    if (provider.config.id === 'fly') {
      const { loadFlyApiToken } = await import('../services/flyTokenStorage');
      apiToken = loadFlyApiToken();
    } else {
      if (provider.config.id === 'digitalocean') {
        try {
          const { getValidDigitalOceanToken } = await import('../services/digitalOceanAuthService');
          apiToken = await getValidDigitalOceanToken();
        } catch { /* fall through to PAT storage */ }
      }
      if (!apiToken) {
        const { loadProviderToken } = await import('../services/providerTokenStorage');
        apiToken = loadProviderToken(provider.config.id);
      }
    }

    if (!apiToken) {
      throw new Error(`API token not found for old ${provider.config.name} instance`);
    }

    const deprovisionMetadata: Record<string, string> = {
      ...(oldConfig.providerMetadata ?? {}),
      ...(oldConfig.flyMachineId ? { machineId: oldConfig.flyMachineId } : {}),
      ...(oldConfig.cloudToken ? { cloudToken: oldConfig.cloudToken } : {}),
    };

    const result = await provider.deprovision(apiToken, instanceId, deprovisionMetadata);

    if (!result.success) {
      throw new Error(result.error ?? 'Deprovision of old instance failed');
    }

    // Clear the old provider's token (new provider's token was saved by doProvision)
    if (provider.config.id === 'fly') {
      const { clearFlyApiToken } = await import('../services/flyTokenStorage');
      clearFlyApiToken();
    } else {
      const { clearProviderToken } = await import('../services/providerTokenStorage');
      clearProviderToken(provider.config.id);
    }
  }

  // cloud:switch-provider — Non-destructive provider switch
  registerHandler('cloud:switch-provider', async (_event, payload: {
    targetProviderId: 'fly' | 'digitalocean' | 'hetzner' | 'mindstone';
    region?: string;
    flyApiToken?: string;
    apiToken?: string;
    volumeSizeGb?: number;
  }) => {
    if (switchInProgress) {
      return { success: false, error: 'A provider switch is already in progress.', failedStep: 'preflight' as const };
    }
    switchInProgress = true;

    try {
      return await executeSwitchProvider(payload);
    } finally {
      switchInProgress = false;
    }
  });

  async function executeSwitchProvider(payload: {
    targetProviderId: 'fly' | 'digitalocean' | 'hetzner' | 'mindstone';
    region?: string;
    flyApiToken?: string;
    apiToken?: string;
    volumeSizeGb?: number;
  }): Promise<{
    success: boolean;
    cloudUrl?: string;
    cloudToken?: string;
    error?: string;
    failedStep?: 'preflight' | 'sync' | 'provision' | 'migrate' | 'cleanup';
    warning?: string;
  }> {
    const settings = getSettings();
    const ci = settings.cloudInstance;

    // =====================================================================
    // STEP 1: PREFLIGHT (0–5%)
    // =====================================================================
    broadcastProvisioningProgress({ phase: 'preflight', message: 'Checking prerequisites', progress: 0 });

    // Must be in cloud mode to switch
    if (!ci || ci.mode !== 'cloud' || !ci.cloudUrl) {
      return { success: false, error: 'Not connected to a cloud instance. Provision one first.', failedStep: 'preflight' };
    }

    // Same-provider guard
    if (ci.providerId === payload.targetProviderId) {
      return { success: false, error: `Already using ${payload.targetProviderId}. Nothing to switch.`, failedStep: 'preflight' };
    }

    if (payload.targetProviderId === 'mindstone') {
      const ossRefusal = refuseManagedCloudInOss('cloud:switch-provider', { targetProviderId: payload.targetProviderId });
      if (ossRefusal) return { ...ossRefusal, failedStep: 'preflight' };
    }

    if (ci.provisionMode === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:switch-provider', { currentProviderId: ci.providerId });
      if (ossRefusal) return { ...ossRefusal, failedStep: 'preflight' };
    }

    // Entitlement check for managed target
    if (payload.targetProviderId === 'mindstone' && !settings.managedCloudEnabled) {
      return { success: false, error: 'Mindstone Cloud is not enabled for your account.', failedStep: 'preflight' };
    }

    // Credential check for BYOK target (DO may use OAuth, so skip explicit token check)
    if (
      payload.targetProviderId !== 'mindstone' &&
      payload.targetProviderId !== 'digitalocean' &&
      !payload.flyApiToken &&
      !payload.apiToken
    ) {
      return { success: false, error: 'API token required for the target provider.', failedStep: 'preflight' };
    }

    // Connectivity check — verify old instance is reachable
    const oldHealthy = await verifyHealth(ci.cloudUrl);
    if (!oldHealthy) {
      return {
        success: false,
        error: 'Current cloud instance is unreachable. Cannot safely sync data before switching.',
        failedStep: 'preflight',
      };
    }

    broadcastProvisioningProgress({ phase: 'preflight', message: 'Prerequisites verified', progress: 5 });

    // Save old cloud config for cleanup in step 5
    const oldCloudConfig = { ...ci };

    // =====================================================================
    // STEP 2: SYNC DOWN FROM OLD (5–20%)
    // =====================================================================
    broadcastProvisioningProgress({ phase: 'syncing_down', message: 'Syncing data from current cloud', progress: 5 });

    try {
      const { cloudRouter } = await import('../services/cloud/cloudRouter');
      const syncResult = await cloudRouter.syncNow();
      if (!syncResult.success) {
        logger.warn({ error: syncResult.error }, 'Switch: sync-down returned failure');
        return {
          success: false,
          error: `Sync failed: ${syncResult.error ?? 'Partial sync failure — some data may not have been pulled from your current cloud.'}`,
          failedStep: 'sync',
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'Switch: sync-down from old instance threw');
      return { success: false, error: `Sync failed: ${message}`, failedStep: 'sync' };
    }

    broadcastProvisioningProgress({ phase: 'syncing_down', message: 'Data synced to desktop', progress: 20 });

    // =====================================================================
    // STEP 3: PROVISION NEW (20–65%)
    // =====================================================================
    broadcastProvisioningProgress({ phase: 'provisioning_new', message: 'Setting up new cloud instance', progress: 20 });

    let provisionResult;
    try {
      provisionResult = await doProvision({
        providerId: payload.targetProviderId,
        region: payload.region,
        flyApiToken: payload.flyApiToken,
        apiToken: payload.apiToken,
        volumeSizeGb: payload.volumeSizeGb,
      });
    } catch (err) {
      // Provision threw — restore old settings so the user stays connected
      updateSettings({ cloudInstance: oldCloudConfig });
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Switch: provision of new instance threw');
      return { success: false, error: `Provisioning failed: ${message}`, failedStep: 'provision' };
    }

    if (!provisionResult.success) {
      // Provision returned failure — restore old settings
      updateSettings({ cloudInstance: oldCloudConfig });
      return { success: false, error: provisionResult.error ?? 'Provisioning failed', failedStep: 'provision' };
    }

    // Settings now point to the new instance (doProvision updated them)
    broadcastProvisioningProgress({ phase: 'provisioning_new', message: 'New instance ready', progress: 65 });

    // =====================================================================
    // STEP 4: MIGRATE UP TO NEW (65–85%)
    // =====================================================================
    broadcastProvisioningProgress({ phase: 'migrating_up', message: 'Migrating data to new instance', progress: 65 });

    let migrateResult;
    try {
      migrateResult = await doMigrate();
    } catch (err) {
      // Migration threw — restore settings to old instance so user isn't stranded.
      // Return the new instance details for potential manual recovery.
      const newCi = getSettings().cloudInstance;
      updateSettings({ cloudInstance: oldCloudConfig });
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Switch: migration to new instance threw — rolled back to old instance');
      return {
        success: false,
        error: `Migration failed: ${message}. Your previous cloud is restored. The new instance may need manual cleanup.`,
        failedStep: 'migrate',
        cloudUrl: newCi?.cloudUrl,
        cloudToken: newCi?.cloudToken,
      };
    }

    if (!migrateResult.success) {
      // Migration returned failure — restore settings to old instance.
      const newCi = getSettings().cloudInstance;
      updateSettings({ cloudInstance: oldCloudConfig });
      logger.warn('Switch: migration failed — rolled back to old instance');
      return {
        success: false,
        error: migrateResult.error ?? 'Migration failed. Your previous cloud is restored. The new instance may need manual cleanup.',
        failedStep: 'migrate',
        cloudUrl: newCi?.cloudUrl,
        cloudToken: newCi?.cloudToken,
      };
    }

    let warning: string | undefined;

    // Surface partial migration errors as a warning (don't block the switch)
    const migrationErrors = (migrateResult as { errors?: string[] }).errors;
    if (migrationErrors?.length) {
      logger.warn({ errors: migrationErrors }, 'Switch: migration completed with partial errors');
      warning = `Migration completed with ${migrationErrors.length} error(s). Some data may not have transferred.`;
    }

    broadcastProvisioningProgress({ phase: 'migrating_up', message: 'Data migrated', progress: 85 });

    // =====================================================================
    // STEP 5: CLEANUP OLD (85–100%)
    // =====================================================================
    broadcastProvisioningProgress({ phase: 'cleaning_up', message: 'Removing old cloud instance', progress: 85 });
    try {
      await deprovisionOldInstance(oldCloudConfig);
    } catch (err) {
      // Cleanup failure is non-critical — user is already on the new instance
      const message = err instanceof Error ? err.message : String(err);
      const cleanupWarning = `Old ${oldCloudConfig.providerId ?? 'cloud'} instance may still be running: ${message}`;
      warning = warning ? `${warning} ${cleanupWarning}` : cleanupWarning;
      logger.warn({ err, oldProviderId: oldCloudConfig.providerId }, 'Switch: cleanup of old instance failed (non-critical)');
    }

    broadcastProvisioningProgress({ phase: 'complete', message: 'Provider switch complete', progress: 100 });

    const finalCi = getSettings().cloudInstance;
    return {
      success: true,
      cloudUrl: finalCi?.cloudUrl,
      cloudToken: finalCi?.cloudToken,
      warning,
    };
  }

  // ---------------------------------------------------------------------------
  // Share Link Channels (cloud-only — requires active cloud connection)
  // ---------------------------------------------------------------------------

  registerHandler('cloud:share-create', async (
    _event,
    payload: {
      resourceType?: 'conversation' | 'file';
      sessionId?: string;
      filePath?: string;
      expiresIn?: '24h' | '7d' | '30d' | 'never';
      password?: string;
    },
  ) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;
    if (!ci?.cloudUrl || !ci?.cloudToken) {
      return { success: false, error: 'Cloud not connected' };
    }

    try {
      // --- File share branch ---
      if (payload.resourceType === 'file') {
        if (!payload.filePath) {
          return { success: false, error: 'filePath is required for file shares' };
        }

        // Force sync before file share creation (fail-closed)
        const { cloudRouter } = await import('../services/cloud/cloudRouter');
        const syncResult = await cloudRouter.forceWorkspaceSync();
        if (!syncResult.success) {
          logger.warn({ error: syncResult.error }, 'File share creation blocked: workspace sync failed');
          return { success: false, error: 'Unable to sync file to cloud. Please try again.' };
        }
        if (syncResult.failed && syncResult.failed > 0) {
          logger.warn({ failed: syncResult.failed }, 'File share creation blocked: some files failed to sync');
          return { success: false, error: 'Unable to sync file to cloud. Please try again.' };
        }

        const bodyObj: Record<string, unknown> = { filePath: payload.filePath };
        if (payload.expiresIn) bodyObj.expiresIn = payload.expiresIn;
        if (payload.password) bodyObj.password = payload.password;
        const bodyStr = JSON.stringify(bodyObj);

        const resp = await fetch(`${ci.cloudUrl}/api/file-shares`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ci.cloudToken}`,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(bodyStr)),
          },
          body: bodyStr,
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          return { success: false, error: `HTTP ${resp.status}: ${body}` };
        }
        const data = await resp.json();
        return { success: true, shareId: data.shareId, expiresAt: data.expiresAt, hasPassword: data.hasPassword };
      }

      // --- Conversation share branch (default) ---
      const sessionId = payload.sessionId;
      if (!sessionId) {
        return { success: false, error: 'sessionId is required for conversation shares' };
      }

      const bodyObj: Record<string, unknown> = {};
      if (payload.expiresIn) bodyObj.expiresIn = payload.expiresIn;
      if (payload.password) bodyObj.password = payload.password;
      const hasBody = Object.keys(bodyObj).length > 0;

      const resp = await fetch(`${ci.cloudUrl}/api/sessions/${encodeURIComponent(sessionId)}/share`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ci.cloudToken}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...(hasBody ? { 'Content-Length': String(Buffer.byteLength(JSON.stringify(bodyObj))) } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(bodyObj) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return { success: false, error: `HTTP ${resp.status}: ${body}` };
      }
      const data = await resp.json();
      return { success: true, shareId: data.shareId, expiresAt: data.expiresAt, hasPassword: data.hasPassword };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  registerHandler('cloud:share-update', async (
    _event,
    payload: {
      resourceType?: 'conversation' | 'file';
      sessionId?: string;
      filePath?: string;
      expiresIn?: '24h' | '7d' | '30d' | 'never';
      password?: string | null;
    },
  ) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;
    if (!ci?.cloudUrl || !ci?.cloudToken) {
      return { success: false, error: 'Cloud not connected' };
    }
    try {
      // --- File share branch ---
      if (payload.resourceType === 'file') {
        if (!payload.filePath) {
          return { success: false, error: 'filePath is required for file shares' };
        }

        const bodyObj: Record<string, unknown> = { filePath: payload.filePath };
        if (payload.expiresIn !== undefined) bodyObj.expiresIn = payload.expiresIn;
        if (payload.password !== undefined) bodyObj.password = payload.password;
        const bodyStr = JSON.stringify(bodyObj);

        const resp = await fetch(`${ci.cloudUrl}/api/file-shares`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ci.cloudToken}`,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(bodyStr)),
          },
          body: bodyStr,
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          return { success: false, error: `HTTP ${resp.status}: ${body}` };
        }
        const data = await resp.json();
        return { success: true, expiresAt: data.expiresAt, hasPassword: data.hasPassword };
      }

      // --- Conversation share branch (default) ---
      const sessionId = payload.sessionId;
      if (!sessionId) {
        return { success: false, error: 'sessionId is required for conversation shares' };
      }

      const bodyObj: Record<string, unknown> = {};
      if (payload.expiresIn !== undefined) bodyObj.expiresIn = payload.expiresIn;
      if (payload.password !== undefined) bodyObj.password = payload.password;

      const bodyStr = JSON.stringify(bodyObj);
      const resp = await fetch(`${ci.cloudUrl}/api/sessions/${encodeURIComponent(sessionId)}/share`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ci.cloudToken}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(bodyStr)),
        },
        body: bodyStr,
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return { success: false, error: `HTTP ${resp.status}: ${body}` };
      }
      const data = await resp.json();
      return { success: true, expiresAt: data.expiresAt, hasPassword: data.hasPassword };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  registerHandler('cloud:share-list', async () => {
    const settings = getSettings();
    const ci = settings.cloudInstance;
    if (!ci?.cloudUrl || !ci?.cloudToken) {
      return { success: false, error: 'Cloud not connected' };
    }
    try {
      const resp = await fetch(`${ci.cloudUrl}/api/shares`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${ci.cloudToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return { success: false, error: `HTTP ${resp.status}: ${body}` };
      }
      const data = await resp.json();

      // TODO: Remove file share filter when CloudTab supports mixed resources.
      // CloudTab currently assumes all share entries are conversations. Sending
      // file shares would cause it to display/revoke them incorrectly.
      const shares = Array.isArray(data.shares)
        ? data.shares.filter((s: { resourceType?: string }) => s.resourceType !== 'file')
        : data.shares;

      return { success: true, shares };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  registerHandler('cloud:share-revoke', async (
    _event,
    payload: { resourceType?: 'conversation' | 'file'; sessionId?: string; filePath?: string },
  ) => {
    const settings = getSettings();
    const ci = settings.cloudInstance;
    if (!ci?.cloudUrl || !ci?.cloudToken) {
      return { success: false, error: 'Cloud not connected' };
    }
    try {
      // --- File share branch ---
      if (payload.resourceType === 'file') {
        if (!payload.filePath) {
          return { success: false, error: 'filePath is required for file share revocation' };
        }

        const resp = await fetch(
          `${ci.cloudUrl}/api/file-shares?filePath=${encodeURIComponent(payload.filePath)}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${ci.cloudToken}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          return { success: false, error: `HTTP ${resp.status}: ${body}` };
        }
        return { success: true };
      }

      // --- Conversation share branch (default) ---
      const sessionId = payload.sessionId;
      if (!sessionId) {
        return { success: false, error: 'sessionId is required for conversation share revocation' };
      }

      const resp = await fetch(`${ci.cloudUrl}/api/sessions/${encodeURIComponent(sessionId)}/share`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ci.cloudToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return { success: false, error: `HTTP ${resp.status}: ${body}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // cloud:fetch-lkg-image — Stage D of
  // docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
  // Fetches the cloud's last-known-good record and refreshes the desktop
  // mirror so the UI can render "Try previous version" affordances even
  // when the cloud is unreachable later.
  registerHandler('cloud:fetch-lkg-image', async (_event) => {
    void _event;
    const ci = getSettings().cloudInstance;
    if (!ci?.cloudUrl || !ci.cloudToken) {
      return { success: false, record: null, error: 'No cloud configured.' };
    }
    try {
      const resp = await fetch(`${ci.cloudUrl}/api/admin/lkg-image`, {
        headers: { Authorization: `Bearer ${ci.cloudToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          record: null,
          error: `Cloud returned HTTP ${resp.status}`,
        };
      }
      const body = (await resp.json()) as { record: unknown };
      const record = isLkgRecord(body?.record) ? body.record : null;
      const { writeDesktopLkgCache } = await import('../services/cloud/desktopLkgCache');
      writeDesktopLkgCache({
        record,
        refreshedAt: Date.now(),
        fetchedFromCloudUrl: ci.cloudUrl,
      });
      return { success: true, record };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, record: null, error: message };
    }
  });

  // cloud:revert-to-last-known-good — Stage D, user-confirmed manual rollback.
  // Only fires when confirmedByUser === true (Zod-enforced) so it cannot be
  // accidentally invoked by automation.
  registerHandler('cloud:revert-to-last-known-good', async (
    _event,
    request: { targetImageTag?: string; confirmedByUser: true },
  ) => {
    void _event;
    const ci = getSettings().cloudInstance;
    if (!ci?.cloudUrl || !ci.flyAppName || !ci.flyMachineId) {
      return { success: false, error: 'No Fly cloud configured.' };
    }
    if (ci.providerId !== 'fly') {
      return { success: false, error: 'Manual revert is only available for Fly-backed instances.' };
    }
    const { loadFlyApiToken } = await import('../services/flyTokenStorage');
    const flyToken = loadFlyApiToken();
    if (!flyToken) {
      return { success: false, error: 'No Fly API token stored.' };
    }

    let targetImageTag = request.targetImageTag;
    if (!targetImageTag) {
      const { readDesktopLkgCache } = await import('../services/cloud/desktopLkgCache');
      const cached = readDesktopLkgCache();
      targetImageTag = cached.record?.imageTag;
    }
    if (!targetImageTag) {
      return {
        success: false,
        error: 'No last-known-good image record available. Refresh and try again.',
      };
    }

    const { applyImageRollback } = await import('@core/services/flyApiClient');
    const result = await applyImageRollback(
      flyToken,
      ci.flyAppName,
      ci.flyMachineId,
      targetImageTag,
      { writerTag: 'desktop-revert' },
    );
    return {
      success: result.outcome === 'rolled-back' || result.outcome === 'no-op-same-image',
      outcome: result.outcome,
      targetImageTag,
      error: result.error,
    };
  });

  // cloud:repair-machine — Destroy and recreate a stuck Fly Machine
  let repairInProgress = false;
  registerHandler('cloud:repair-machine', async () => {
    // Managed instances are maintained automatically
    const ci = getSettings().cloudInstance;
    if (ci?.provisionMode === 'managed') {
      const ossRefusal = refuseManagedCloudInOss('cloud:repair-machine', { providerId: ci.providerId });
      if (ossRefusal) return ossRefusal;

      return { success: false, error: 'Managed cloud machines are monitored and repaired automatically. If something seems wrong, contact support.' };
    }

    if (repairInProgress) {
      return { success: false, error: 'Machine repair is already in progress.' };
    }
    repairInProgress = true;
    try {
      return await executeRepairMachine(getSettings, updateSettings);
    } finally {
      repairInProgress = false;
    }
  });

}

// ---------------------------------------------------------------------------
// Repair machine implementation (extracted for testability)
// ---------------------------------------------------------------------------

const HEALTH_POLL_INTERVAL_MS = 3_000;
const HEALTH_POLL_TIMEOUT_MS = 60_000;

async function pollAppHealth(cloudUrl: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${cloudUrl}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) return true;
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

async function executeRepairMachine(
  getSettings: () => AppSettings,
  updateSettings: (patch: Partial<AppSettings>) => void,
): Promise<{ success: boolean; oldMachineId?: string; newMachineId?: string; error?: string }> {
  const settings = getSettings();
  const ci = settings.cloudInstance;

  if (!ci?.cloudUrl || !ci.flyAppName || !ci.flyMachineId) {
    return { success: false, error: 'No Fly machine configured.' };
  }

  if (ci.providerId !== 'fly') {
    return { success: false, error: 'Machine repair is only available for Fly-backed instances.' };
  }

  const { loadFlyApiToken } = await import('../services/flyTokenStorage');
  const flyToken = loadFlyApiToken();
  if (!flyToken) {
    return { success: false, error: 'No Fly API token stored. Link one under Troubleshooting to enable machine repair.' };
  }

  const { getMachineState, destroyMachine, createMachine, waitForMachineState } = await import('@core/services/flyApiClient');
  const { getBroadcastService } = await import('@core/broadcastService');

  const broadcast = (step: string, detail?: string) => {
    try {
      getBroadcastService().sendToAllWindows('cloud:repair-machine-progress', { step, detail });
    } catch { /* renderer may not be ready */ }
  };

  const oldMachineId = ci.flyMachineId;

  // 1. Get current machine state + config
  broadcast('checking', 'Checking machine state...');
  const stateResult = await getMachineState(flyToken, ci.flyAppName, oldMachineId);
  if (!stateResult.success || !stateResult.machine) {
    return { success: false, oldMachineId, error: `Failed to get machine state: ${stateResult.error}` };
  }

  const { machine } = stateResult;
  if (machine.state === 'started') {
    return { success: true, oldMachineId, newMachineId: oldMachineId };
  }

  const savedConfig = machine.config;
  const region = machine.region;

  // 2. Force-destroy the stuck machine
  broadcast('destroying', `Destroying stuck machine (${machine.state})...`);
  logger.warn({ oldMachineId, state: machine.state }, 'Repair: destroying stuck machine');
  const destroyResult = await destroyMachine(flyToken, ci.flyAppName, oldMachineId, true);
  if (!destroyResult.success) {
    return { success: false, oldMachineId, error: `Failed to destroy machine: ${destroyResult.error}` };
  }

  // 3. Create new machine with saved config + same region
  broadcast('creating', 'Creating replacement machine...');
  const createResult = await createMachine(flyToken, ci.flyAppName, savedConfig, region);
  if (!createResult.success || !createResult.machineId) {
    // Old machine is destroyed but create failed — clear the stale machineId so
    // subsequent attempts don't try to destroy a non-existent machine.
    updateSettings({
      cloudInstance: {
        ...ci,
        flyMachineId: undefined,
      },
    });
    const repairError = `Machine destroyed but replacement failed: ${createResult.error}`;
    await cloudConnectionReconciler.reportFailure({
      writer: 'repair',
      rawError: new Error(repairError),
      legacyLastError: repairError,
    });
    broadcast('failed', 'Failed to create replacement machine');
    return { success: false, oldMachineId, error: `Failed to create replacement machine: ${createResult.error}` };
  }

  const newMachineId = createResult.machineId;

  // Immediately persist the new machine ID so it's never lost, even if
  // subsequent steps (wait, health check) fail.
  updateSettings({
    cloudInstance: {
      ...ci,
      flyMachineId: newMachineId,
    },
  });

  // 4. Wait for the new machine to reach 'started' state
  broadcast('waiting', 'Waiting for machine to start...');
  const waitResult = await waitForMachineState(flyToken, ci.flyAppName, newMachineId, 'started');
  if (!waitResult.success) {
    logger.error({ newMachineId, error: waitResult.error }, 'Repair: new machine failed to start');
    await cloudConnectionReconciler.reportFailure({
      writer: 'repair',
      rawError: new Error(waitResult.error ?? 'Replacement machine failed to start'),
      legacyLastError: waitResult.error,
    });
    broadcast('failed', 'Replacement machine failed to start');
    return { success: false, oldMachineId, newMachineId, error: `Replacement machine failed to start: ${waitResult.error}` };
  }

  // 5. Verify application-level health (machine started != app ready)
  broadcast('health-check', 'Verifying application health...');
  const healthy = await pollAppHealth(ci.cloudUrl);
  if (!healthy) {
    logger.warn({ newMachineId }, 'Repair: machine started but app health check timed out');
    await cloudConnectionReconciler.reportFailure({
      writer: 'repair',
      rawError: new Error('Machine started but application health check timed out'),
      legacyLastError: 'Machine started but application health check timed out',
    });
    broadcast('failed', 'Application health check timed out');
    return { success: false, oldMachineId, newMachineId, error: 'Machine started but application health check timed out. The machine may still be booting — try again shortly.' };
  }

  // 6. Mark as running
  await cloudConnectionReconciler.reportSuccess({ writer: 'repair', cloudUrl: ci.cloudUrl });

  // 7. Reset circuit breaker and trigger reconnect
  const { cloudFailureCooldown } = await import('../services/cloud/cloudFailureCooldown');
  cloudFailureCooldown.reset();

  try {
    const { cloudRouter } = await import('../services/cloud/cloudRouter');
    const updatedCi = getSettings().cloudInstance;
    if (updatedCi?.cloudUrl && updatedCi?.cloudToken) {
      await cloudRouter.updateConnection(updatedCi.cloudUrl, updatedCi.cloudToken);
    }
  } catch (err) {
    logger.warn({ err }, 'Repair: reconnect after machine replace failed (will retry on next sync)');
  }

  broadcast('complete', 'Machine replaced successfully');
  logger.info({ oldMachineId, newMachineId }, 'Repair: machine replaced successfully');

  return { success: true, oldMachineId, newMachineId };
}
