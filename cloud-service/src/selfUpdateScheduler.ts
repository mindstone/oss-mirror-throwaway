/**
 * Cloud Service Self-Update Scheduler
 *
 * Periodically checks GHCR for newer image tags and triggers the
 * appropriate update mechanism based on the deployment provider:
 *
 * - **Fly.io**: Calls `updateMachineConfig()` to set the new image.
 *   Fly restarts the machine automatically.
 * - **Self-hosted VM**: Writes `.update-signal` + `rebel-cloud.tag`
 *   for the host-level systemd watcher to pick up.
 *
 * Defers updates when agent turns are in progress.
 */

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { fireAndForget } from '@shared/utils/fireAndForget';
import {
  fetchLatestTag,
  isCloudVersionCurrent,
  type CloudUpdateChannel,
} from '@core/services/cloudUpdateService';
import { updateMachineConfig } from '@core/services/flyApiClient';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { applyFlyRestartPolicyMigration } from './services/flyRestartPolicyMigration';
import { createQuarantinedTagsStore } from './services/quarantinedTagsStore';

declare const __BUILD_COMMIT__: string | undefined;

const log = createScopedLogger({ service: 'cloud-self-update-scheduler' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOUD_IMAGE_REPO = 'ghcr.io/mindstone/rebel-cloud';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_MAX_JITTER_MS = 30 * 60 * 1000; // 30 min
const DATA_DIR = process.env.REBEL_USER_DATA || '/data';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SelfUpdateConfig {
  getSettings: () => { cloudUpdateChannel?: string };
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let startupTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let configRef: SelfUpdateConfig | null = null;
let schedulerStarted = false;
let cycleInProgress = false;

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

type Provider = 'fly' | 'vm';

function detectProvider(): Provider {
  return process.env.FLY_APP_NAME ? 'fly' : 'vm';
}

// ---------------------------------------------------------------------------
// Failure telemetry
// ---------------------------------------------------------------------------

type SelfUpdateFailureCause =
  | 'cycle-exception'
  | 'tag-resolve-failed'
  | 'quarantine-read-failed'
  | 'fly-token-missing'
  | 'fly-env-missing'
  | 'fly-update-failed'
  | 'vm-signal-write-failed';

/**
 * Severity per cause. Missing-credential states are a *known-degraded* config
 * (a pre-existing BYOK instance whose `FLY_API_TOKEN` the desktop hasn't
 * bootstrapped yet; self-heals when the desktop next comes online) — kept at
 * `info` so the whole cohort is visible in Sentry at low urgency. Since
 * 260610 improve-sentry-noise Stage 5 those causes route through the
 * known-conditions registry (`cloud_self_update_credentials_missing`,
 * `sink: 'issue-stream'`, same per-cause fingerprint) because raw info-level
 * captures no longer compile. Genuine failures (couldn't resolve a tag,
 * unreadable quarantine list, Fly rejected the config update, the VM signal
 * write failed, an unexpected throw) are real operational problems → raw
 * `warning` capture, unchanged. Neither should page: not acute (the cloud
 * keeps running its current image and retries next cycle) — they're
 * sweep-level signals.
 */
const CREDENTIALS_MISSING_CAUSES = ['fly-token-missing', 'fly-env-missing'] as const;
type CredentialsMissingCause = (typeof CREDENTIALS_MISSING_CAUSES)[number];

function isCredentialsMissingCause(cause: SelfUpdateFailureCause): cause is CredentialsMissingCause {
  return (CREDENTIALS_MISSING_CAUSES as readonly SelfUpdateFailureCause[]).includes(cause);
}

/**
 * Once-per-cause-per-process throttle. The scheduler runs in one long-lived
 * process every 6h; re-capturing the same cause every cycle adds no information
 * (same fingerprint → same Sentry issue, just an inflated count) and risks
 * tripping the unscoped "Rebel Error" alert rule (pages on any issue >3
 * events/1h regardless of level — see docs/project/SENTRY_TRIAGE.md). Capturing
 * each cause at most once per process keeps the per-instance event rate at ≤1
 * per cause, so the grouped issue still reflects cohort size (one event per
 * affected instance) without a single instance spamming. Cleared on
 * `stopSelfUpdateScheduler()` (fresh start == fresh process semantics).
 */
const capturedCauses = new Set<SelfUpdateFailureCause>();

/**
 * Report a genuine self-update failure to Sentry.
 *
 * Why this exists: the cloud `createScopedLogger` only attaches Sentry
 * *breadcrumbs* (see `src/core/logger.ts`) — it never captures events — so
 * without an explicit capture the entire self-update path is invisible to
 * monitoring and to Sentry triage. A cohort that silently stops updating
 * (broken GHCR auth, or a `FLY_API_TOKEN`-missing fleet) would otherwise retry
 * forever with no signal anyone could see.
 *
 * A stable per-cause `fingerprint` groups every instance hitting the same cause
 * into a single issue — that grouped issue IS the fleet "stopped updating"
 * signal, and its event count communicates cohort size. `level: 'warning'`
 * keeps it off the pager: these are operator-attention signals, not acute
 * paging events. Expected / self-healing paths (GHCR rate-limit, agent-turn
 * deferral, quarantine skip, already-up-to-date) deliberately do NOT capture —
 * capturing them would be noise.
 */
function captureSelfUpdateFailure(
  cause: SelfUpdateFailureCause,
  details: {
    provider?: Provider;
    channel?: CloudUpdateChannel;
    currentVersion?: string;
    latestTag?: string;
    error?: string;
  } = {},
): void {
  // Throttle: capture each cause at most once per process (see capturedCauses).
  if (capturedCauses.has(cause)) return;
  capturedCauses.add(cause);

  const tags = {
    event: 'cloud.self_update.failed',
    cause,
    ...(details.provider ? { provider: details.provider } : {}),
    ...(details.channel ? { channel: details.channel } : {}),
  };
  const extra = {
    currentVersion: details.currentVersion,
    latestTag: details.latestTag,
    error: details.error,
  };

  try {
    if (isCredentialsMissingCause(cause)) {
      // Info-level cohort telemetry — registry-owned (issue-stream sink, same
      // ['cloud.self_update.failed', cause] fingerprint as the raw capture it
      // replaces). See 260610 improve-sentry-noise Stage 5.
      captureKnownCondition(
        'cloud_self_update_credentials_missing',
        { cause, tags, extra },
        new Error('cloud.self_update.failed'),
      );
      return;
    }

    getErrorReporter().captureMessage('cloud.self_update.failed', {
      level: 'warning',
      fingerprint: ['cloud.self_update.failed', cause],
      tags,
      extra,
    });
  } catch (captureError) {
    log.warn({ err: captureError, cause }, 'Failed to report self-update failure to Sentry');
  }
}

/**
 * Report a failure of the one-shot Fly `[[restart]]`-policy backfill migration
 * (Stage B of the rollback defense-in-depth). A `fly-error` outcome (or a throw)
 * means an existing machine didn't get its restart cap backfilled, so a future
 * crash-loop's blast radius is unbounded on that machine — worth surfacing.
 * One-shot per process (sentinel-gated), so no throttle needed. `warning`.
 */
function captureRestartPolicyMigrationFailure(error?: string): void {
  try {
    getErrorReporter().captureMessage('cloud.restart_policy_migration.failed', {
      level: 'warning',
      fingerprint: ['cloud.restart_policy_migration.failed'],
      tags: { event: 'cloud.restart_policy_migration.failed', surface: 'cloud' },
      extra: { error },
    });
  } catch (captureError) {
    log.warn({ err: captureError }, 'Failed to report restart-policy migration failure to Sentry');
  }
}

// ---------------------------------------------------------------------------
// Config normalization — ensures existing machines converge to always-on
// ---------------------------------------------------------------------------

type ServiceConfig = { auto_stop_machines?: string; min_machines_running?: number; [k: string]: unknown };

function normalizeAlwaysOnConfig(config: Record<string, unknown>): Record<string, unknown> {
  const services = config.services as ServiceConfig[] | undefined;
  if (!Array.isArray(services) || services.length === 0) return config;

  let changed = false;
  const patched = services.map((svc) => {
    if (svc.auto_stop_machines === 'off' && svc.min_machines_running === 1) return svc;
    changed = true;
    return { ...svc, auto_stop_machines: 'off', min_machines_running: 1 };
  });

  if (!changed) return config;
  log.info('Normalizing machine config: setting auto_stop_machines=off, min_machines_running=1');
  return { ...config, services: patched };
}

// ---------------------------------------------------------------------------
// Update cycle
// ---------------------------------------------------------------------------

async function runUpdateCycle(): Promise<void> {
  if (cycleInProgress) {
    log.debug('Skipping self-update cycle; previous run still in progress');
    return;
  }
  cycleInProgress = true;

  try {
    await runUpdateCycleInner();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'Self-update cycle failed unexpectedly');
    captureSelfUpdateFailure('cycle-exception', { error: message });
  } finally {
    cycleInProgress = false;
  }
}

async function runUpdateCycleInner(): Promise<void> {
  // Guard: skip if __BUILD_COMMIT__ is not available (dev/test mode)
  const buildCommit = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : undefined;
  if (!buildCommit || buildCommit === 'unknown') {
    log.debug('Skipping self-update check: __BUILD_COMMIT__ is undefined or unknown');
    return;
  }

  const config = configRef;
  if (!config) {
    log.debug('Skipping self-update check: scheduler not configured');
    return;
  }

  const provider = detectProvider();
  const channel: CloudUpdateChannel =
    (config.getSettings().cloudUpdateChannel as CloudUpdateChannel) ?? 'stable';

  // 1. Fetch latest tag from GHCR
  const result = await fetchLatestTag(channel);

  if (result.rateLimited) {
    log.info({ provider, channel }, 'Self-update check rate-limited by GHCR; will retry next cycle');
    return;
  }

  if (result.error || !result.tag) {
    log.warn(
      { provider, channel, error: result.error },
      'Self-update check failed to fetch latest tag; will retry next cycle',
    );
    captureSelfUpdateFailure('tag-resolve-failed', {
      provider,
      channel,
      currentVersion: buildCommit,
      error: result.error,
    });
    return;
  }

  const latestTag = result.tag;

  // 2. Compare versions
  if (isCloudVersionCurrent(buildCommit, latestTag)) {
    log.info(
      { provider, currentVersion: buildCommit, latestTag, channel },
      'Cloud service is up to date',
    );
    return;
  }

  // 2a. Quarantine check (Stage F of
  // docs/plans/260510_cloud_image_rollback_defense_in_depth.md). The
  // pre-bootstrap watchdog writes the image tag of any boot it rolled back
  // away from. If the latest GHCR tag matches a quarantined entry, skip
  // this cycle so we do not immediately reinstall the same broken image.
  // Quarantine entries auto-expire after 7d (REBEL_QUARANTINE_TTL_MS).
  // DATA_DIR is captured at module load; re-read REBEL_USER_DATA at call
  // time so tests that override the env after import still hit the right
  // dir.
  const quarantineDataDir = process.env.REBEL_USER_DATA || DATA_DIR;
  try {
    const quarantineStore = createQuarantinedTagsStore({ dataPath: quarantineDataDir });
    // Corruption probe. The store's reader swallows read/parse errors and
    // returns an empty list — which would silently DISABLE the rollback guard
    // and let this cycle reinstall the exact tag the watchdog just rejected.
    // Detect a present-but-unparseable quarantine file explicitly so that
    // failure is visible in Sentry, not silent. We still fail-open (proceed) —
    // the pre-bootstrap watchdog is the backstop — but at least it's surfaced.
    const quarantinePath = quarantineStore.filePath();
    if (existsSync(quarantinePath)) {
      try {
        JSON.parse(readFileSync(quarantinePath, 'utf8'));
      } catch (parseErr) {
        const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
        log.warn(
          { event: 'scheduler-quarantine-corrupt', error: message },
          'Quarantine list is present but unparseable; rollback guard disabled this cycle',
        );
        captureSelfUpdateFailure('quarantine-read-failed', {
          provider,
          channel,
          currentVersion: buildCommit,
          latestTag,
          error: message,
        });
      }
    }
    const active = quarantineStore.readActive();
    if (active.some((entry) => entry.imageTag.endsWith(`:${latestTag}`))) {
      log.warn(
        {
          provider,
          currentVersion: buildCommit,
          latestTag,
          channel,
          event: 'scheduler-skipped-quarantined-tag',
          quarantineCount: active.length,
        },
        'Self-update skipped: latest tag is in the rollback quarantine list',
      );
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { event: 'scheduler-quarantine-read-failed', error: message },
      'Self-update quarantine check failed; proceeding without quarantine guard',
    );
    // A failed quarantine read means the rollback safety layer is blind for this
    // cycle: we proceed (fail-open — the pre-bootstrap watchdog is the backstop),
    // but a corrupt/unreadable quarantine list could let us reinstall the exact
    // tag the watchdog just rejected. Surface it so that risk isn't silent.
    captureSelfUpdateFailure('quarantine-read-failed', {
      provider,
      channel,
      currentVersion: buildCommit,
      latestTag,
      error: message,
    });
  }

  // 3. Check for active agent turns
  const activeTurns = agentTurnRegistry.getActiveTurnCount();
  if (activeTurns > 0) {
    log.info(
      { provider, currentVersion: buildCommit, latestTag, channel, activeTurns },
      'Self-update deferred: agent turns in progress',
    );
    return;
  }

  // 4. Apply update based on provider
  if (provider === 'fly') {
    await applyFlyUpdate(buildCommit, latestTag, channel);
  } else {
    await applyVmUpdate(buildCommit, latestTag, channel);
  }
}

// ---------------------------------------------------------------------------
// Fly update path
// ---------------------------------------------------------------------------

async function applyFlyUpdate(
  currentVersion: string,
  latestTag: string,
  channel: CloudUpdateChannel,
): Promise<void> {
  const flyApiToken = process.env.FLY_API_TOKEN;
  if (!flyApiToken) {
    log.warn(
      { provider: 'fly', currentVersion, latestTag, channel, action: 'skipped' },
      'Self-update skipped: FLY_API_TOKEN not available (pre-existing instance without token secret)',
    );
    // Known-degraded cohort: this BYOK instance cannot self-update until the
    // desktop bootstraps the FLY_API_TOKEN secret. Surfaced (not silent) so the
    // size of the stuck cohort is visible; not acute, hence 'info' (CAUSE_LEVEL).
    captureSelfUpdateFailure('fly-token-missing', { provider: 'fly', channel, currentVersion, latestTag });
    return;
  }

  const flyAppName = process.env.FLY_APP_NAME;
  const flyMachineId = process.env.FLY_MACHINE_ID;
  if (!flyAppName || !flyMachineId) {
    log.warn(
      { provider: 'fly', currentVersion, latestTag, channel, action: 'skipped' },
      'Self-update skipped: FLY_APP_NAME or FLY_MACHINE_ID not set',
    );
    captureSelfUpdateFailure('fly-env-missing', { provider: 'fly', channel, currentVersion, latestTag });
    return;
  }

  const targetImage = `${CLOUD_IMAGE_REPO}:${latestTag}`;

  log.info(
    { provider: 'fly', currentVersion, latestTag, channel, targetImage, action: 'applying' },
    'Self-update: applying Fly machine update (process will restart)',
  );

  const updateResult = await updateMachineConfig(
    flyApiToken,
    flyAppName,
    flyMachineId,
    (config) => normalizeAlwaysOnConfig({ ...config, image: targetImage }),
  );

  if (!updateResult.success) {
    log.error(
      { provider: 'fly', currentVersion, latestTag, channel, action: 'failed', error: updateResult.error },
      'Self-update failed: Fly machine config update failed',
    );
    captureSelfUpdateFailure('fly-update-failed', {
      provider: 'fly',
      channel,
      currentVersion,
      latestTag,
      error: updateResult.error,
    });
    return;
  }

  log.info(
    { provider: 'fly', currentVersion, latestTag, channel, action: 'applied' },
    'Self-update: Fly machine config updated; process will be restarted by Fly',
  );
}

// ---------------------------------------------------------------------------
// VM update path
// ---------------------------------------------------------------------------

async function applyVmUpdate(
  currentVersion: string,
  latestTag: string,
  channel: CloudUpdateChannel,
): Promise<void> {
  const tagFile = path.join(DATA_DIR, 'rebel-cloud.tag');
  const signalFile = path.join(DATA_DIR, '.update-signal');

  log.info(
    { provider: 'vm', currentVersion, latestTag, channel, action: 'signaling' },
    'Self-update: writing update signal files for host watcher',
  );

  try {
    await fs.writeFile(tagFile, latestTag, 'utf-8');
    await fs.writeFile(signalFile, latestTag, 'utf-8');

    log.info(
      { provider: 'vm', currentVersion, latestTag, channel, action: 'signaled' },
      'Self-update: update signal files written; host watcher will handle restart',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { provider: 'vm', currentVersion, latestTag, channel, action: 'failed', error: message },
      'Self-update failed: could not write update signal files',
    );
    captureSelfUpdateFailure('vm-signal-write-failed', {
      provider: 'vm',
      channel,
      currentVersion,
      latestTag,
      error: message,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startSelfUpdateScheduler(config: SelfUpdateConfig): void {
  if (schedulerStarted) {
    return;
  }

  configRef = config;
  schedulerStarted = true;

  // Backfill the [[restart]] policy on existing Fly machines (Stage B of
  // docs/plans/260510_cloud_image_rollback_defense_in_depth.md). One-shot,
  // gated by a sentinel on /data; never blocks boot.
  applyFlyRestartPolicyMigration({ dataDir: DATA_DIR })
    .then((result) => {
      if (result.outcome === 'fly-error') {
        log.warn({ outcome: result.outcome, error: result.error }, 'Restart-policy migration failed (Fly error)');
        captureRestartPolicyMigrationFailure(result.error);
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ error: message }, 'Restart-policy migration threw unexpectedly');
      captureRestartPolicyMigrationFailure(message);
    });

  const startupJitterMs = Math.floor(Math.random() * (STARTUP_MAX_JITTER_MS + 1));

  startupTimer = setTimeout(() => {
    startupTimer = null;
    fireAndForget(runUpdateCycle(), 'cloud.selfUpdate.startupCycle');
  }, startupJitterMs);

  intervalTimer = setInterval(() => {
    fireAndForget(runUpdateCycle(), 'cloud.selfUpdate.intervalCycle');
  }, CHECK_INTERVAL_MS);

  log.info(
    { startupJitterMs, intervalMs: CHECK_INTERVAL_MS },
    'Cloud self-update scheduler started',
  );
}

export interface TriggerUpdateResult {
  success: boolean;
  updated: boolean;
  alreadyUpToDate?: boolean;
  latestTag?: string;
  rateLimited?: boolean;
  deferred?: boolean;
  activeTurns?: number;
  error?: string;
}

export async function triggerImmediateUpdate(channel?: CloudUpdateChannel): Promise<TriggerUpdateResult> {
  const config = configRef;
  const buildCommit = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : undefined;

  if (!buildCommit || buildCommit === 'unknown') {
    return { success: false, updated: false, error: 'Build commit unknown (dev/test mode).' };
  }

  if (!config) {
    return { success: false, updated: false, error: 'Self-update scheduler not configured.' };
  }

  const resolvedChannel: CloudUpdateChannel =
    channel ?? (config.getSettings().cloudUpdateChannel as CloudUpdateChannel) ?? 'stable';

  const result = await fetchLatestTag(resolvedChannel);
  if (result.rateLimited) {
    return { success: false, updated: false, rateLimited: true, error: 'GHCR rate-limited.' };
  }
  if (result.error || !result.tag) {
    return { success: false, updated: false, error: result.error ?? 'Failed to resolve latest tag.' };
  }

  if (isCloudVersionCurrent(buildCommit, result.tag)) {
    return { success: true, updated: false, alreadyUpToDate: true, latestTag: result.tag };
  }

  // Quarantine check — same as runUpdateCycleInner's 2a. Manual trigger gets
  // a structured error so callers can surface the reason to the user.
  const quarantineDataDir = process.env.REBEL_USER_DATA || DATA_DIR;
  try {
    const quarantineStore = createQuarantinedTagsStore({ dataPath: quarantineDataDir });
    const active = quarantineStore.readActive();
    if (active.some((entry) => entry.imageTag.endsWith(`:${result.tag}`))) {
      return {
        success: false,
        updated: false,
        latestTag: result.tag,
        error: `Latest tag '${result.tag}' is quarantined (auto-rolled-back previously); waiting for next published tag.`,
      };
    }
  } catch {
    // Best-effort; fall through to the apply step on read failures.
  }

  const activeTurns = agentTurnRegistry.getActiveTurnCount();
  if (activeTurns > 0) {
    return { success: true, updated: false, deferred: true, activeTurns, latestTag: result.tag };
  }

  const provider = detectProvider();

  if (provider === 'fly') {
    const flyApiToken = process.env.FLY_API_TOKEN;
    const flyAppName = process.env.FLY_APP_NAME;
    const flyMachineId = process.env.FLY_MACHINE_ID;

    if (!flyApiToken || !flyAppName || !flyMachineId) {
      return { success: false, updated: false, latestTag: result.tag, error: 'Fly credentials not available for self-update.' };
    }

    const targetImage = `${CLOUD_IMAGE_REPO}:${result.tag}`;
    log.info({ provider: 'fly', latestTag: result.tag, targetImage }, 'Trigger-update: applying Fly machine update');

    const updateResult = await updateMachineConfig(flyApiToken, flyAppName, flyMachineId, (c) => normalizeAlwaysOnConfig({ ...c, image: targetImage }));
    if (!updateResult.success) {
      return { success: false, updated: false, latestTag: result.tag, error: updateResult.error ?? 'Machine config update failed.' };
    }

    return { success: true, updated: true, latestTag: result.tag };
  }

  // VM path
  const tagFile = path.join(DATA_DIR, 'rebel-cloud.tag');
  const signalFile = path.join(DATA_DIR, '.update-signal');

  try {
    await fs.writeFile(tagFile, result.tag, 'utf-8');
    await fs.writeFile(signalFile, result.tag, 'utf-8');
    return { success: true, updated: true, latestTag: result.tag };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, updated: false, latestTag: result.tag, error: `Failed to write update signal: ${message}` };
  }
}

export function stopSelfUpdateScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }

  schedulerStarted = false;
  configRef = null;
  cycleInProgress = false;
  capturedCauses.clear();

  log.info('Cloud self-update scheduler stopped');
}
