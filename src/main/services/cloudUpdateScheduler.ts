import { getBroadcastService } from '@core/broadcastService';
import { applyCloudUpdate, checkForCloudUpdate, getCloudUpdateChannel, setFlyApiTokenSecret, setSentryDsnSecret } from '@core/services/cloudUpdateService';
import { resolveCommercialCloudSentryDsn } from '@main/sentryCloudDsn';
import type { CloudUpdateChannel } from '@core/services/cloudUpdateService';
import type { AppSettings, CloudInstanceConfig } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { loadFlyApiToken } from './flyTokenStorage';
import { updateSettings } from '../settingsStore';
import { getBuildChannel } from '@main/utils/buildChannel';
import { createPausableInterval } from './visibilityAwareScheduler';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'cloud-update-scheduler' });

const INITIAL_CHECK_MAX_JITTER_MS = 60 * 60 * 1000; // 0-60 min
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

type SchedulerTrigger = 'startup' | 'interval' | 'version-change';
type CloudUpdateStatus =
  | 'checking'
  | 'rate_limited'
  | 'up_to_date'
  | 'update_available'
  | 'applying'
  | 'updated'
  | 'error';

interface EligibleCloudTarget {
  cloudUrl: string;
  flyAppName: string;
  flyMachineId: string;
}

let getSettingsRef: (() => AppSettings) | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: (() => void) | null = null;
let inFlightRun: Promise<void> | null = null;
let schedulerStarted = false;

function toEligibleTarget(cloudInstance: CloudInstanceConfig | undefined): EligibleCloudTarget | null {
  if (!cloudInstance) {
    return null;
  }

  if (
    cloudInstance.mode !== 'cloud' ||
    cloudInstance.provisionMode !== 'byok' ||
    !cloudInstance.cloudUrl ||
    !cloudInstance.flyAppName ||
    !cloudInstance.flyMachineId
  ) {
    return null;
  }

  return {
    cloudUrl: cloudInstance.cloudUrl,
    flyAppName: cloudInstance.flyAppName,
    flyMachineId: cloudInstance.flyMachineId,
  };
}

function broadcastUpdateStatus(
  status: CloudUpdateStatus,
  message: string,
  payload: Record<string, unknown> = {},
): void {
  try {
    getBroadcastService().sendToAllWindows('cloud:update-status', {
      status,
      message,
      timestamp: Date.now(),
      ...payload,
    });
  } catch (err) {
    log.warn({ err, status }, 'Failed to broadcast cloud update status');
  }
}

async function runUpdateCycle(trigger: SchedulerTrigger): Promise<void> {
  if (inFlightRun) {
    log.debug({ trigger }, 'Skipping cloud update cycle; previous run still in progress');
    return inFlightRun;
  }

  // Background runs (startup/interval) only broadcast actionable states
  // (update_available, applying, updated, error). Manual checks broadcast all states.
  const isBackground = trigger === 'startup' || trigger === 'interval';

  inFlightRun = (async () => {
    const getSettings = getSettingsRef;
    if (!getSettings) {
      return;
    }

    const settings = getSettings();
    const target = toEligibleTarget(settings.cloudInstance);
    if (!target) {
      log.debug({ trigger }, 'Cloud update scheduler skipped (not a BYOK cloud instance)');
      return;
    }

    const flyApiToken = loadFlyApiToken();
    if (!flyApiToken) {
      log.warn({ trigger, flyAppName: target.flyAppName }, 'Skipping cloud update check: Fly API token not available');
      return;
    }

    const channel: CloudUpdateChannel = (settings.cloudUpdateChannel as CloudUpdateChannel) ?? getCloudUpdateChannel(getBuildChannel());

    if (!isBackground) {
      broadcastUpdateStatus('checking', 'Checking for cloud service updates...', {
        trigger,
        flyAppName: target.flyAppName,
      });
    }

    const checkResult = await checkForCloudUpdate({
      cloudUrl: target.cloudUrl,
      flyAppName: target.flyAppName,
      channel,
    });

    if (checkResult.rateLimited) {
      log.debug({ trigger, flyAppName: target.flyAppName }, 'Cloud update check rate-limited; skipping');
      return;
    }

    if (!checkResult.success) {
      if (isBackground) {
        log.warn({ trigger, flyAppName: target.flyAppName, error: checkResult.error }, 'Background cloud update check failed');
      } else {
        broadcastUpdateStatus('error', checkResult.error ?? 'Cloud update check failed.', {
          trigger,
          flyAppName: target.flyAppName,
        });
      }
      return;
    }

    // Backfill SENTRY_DSN as a Fly secret on pre-existing instances (the OSS
    // scrub removed the hardcoded cloud DSN; machines provisioned before the
    // machine-create env gained SENTRY_DSN run with Sentry silently off).
    // Deliberately BEFORE the update-available early-return so the fleet
    // converges on every 24h cycle — secret staging is non-disruptive and
    // activates on the next restart/update from either updater. No DSN →
    // skip entirely; OSS builds resolve undefined BY CONSTRUCTION (the helper
    // gates on PlatformConfig.isOss, never the raw env) — fail-open-to-off is
    // the OSS no-phone-home contract.
    // Fresh snapshot: checkForCloudUpdate awaited above — cloudInstance may
    // have been rewritten by another writer since the cycle-start `settings`.
    const cloudInstance = getSettings().cloudInstance;
    if (cloudInstance && !cloudInstance.sentryDsnSecretRepairedAt) {
      const sentryDsn = resolveCommercialCloudSentryDsn();
      if (sentryDsn) {
        const dsnRepair = await setSentryDsnSecret({ flyApiToken, flyAppName: target.flyAppName, sentryDsn });
        if (dsnRepair.success) {
          try {
            updateSettings({
              cloudInstance: { ...cloudInstance, sentryDsnSecretRepairedAt: Date.now() },
            });
            log.info({ trigger, flyAppName: target.flyAppName }, 'SENTRY_DSN secret backfilled on cloud app');
          } catch (err) {
            log.warn({ err, flyAppName: target.flyAppName }, 'Failed to persist sentryDsnSecretRepairedAt timestamp');
          }
        } else {
          // Non-fatal: continue with the cycle. We'll retry on the next one.
          log.warn(
            { trigger, flyAppName: target.flyAppName, error: dsnRepair.error },
            'Failed to backfill SENTRY_DSN secret; cloud-side Sentry stays disabled until the next cycle',
          );
        }
      }
    }

    if (!checkResult.updateAvailable || !checkResult.latestTag) {
      if (!isBackground) {
        broadcastUpdateStatus('up_to_date', 'Cloud service is already up to date.', {
          trigger,
          flyAppName: target.flyAppName,
          runningVersion: checkResult.runningVersion,
        });
      }
      return;
    }

    // Self-heal pre-existing instances: write FLY_API_TOKEN as a Fly secret
    // (lazy / piggyback path) before the image PATCH so the cloud-side
    // self-update scheduler can run independently of the desktop going forward.
    // The image update's own restart will activate the new secret — no extra
    // disruption. Skip if we've already done this for this instance.
    // Fresh snapshot (not the cycle-start `settings`): the SENTRY_DSN backfill
    // above may have just persisted its own flag into cloudInstance — spreading
    // a stale snapshot here would silently erase it.
    const ci = getSettings().cloudInstance;
    if (ci && !ci.flyApiTokenSecretRepairedAt) {
      const repair = await setFlyApiTokenSecret({ flyApiToken, flyAppName: target.flyAppName });
      if (repair.success) {
        try {
          updateSettings({
            cloudInstance: { ...ci, flyApiTokenSecretRepairedAt: Date.now() },
          });
          log.info({ trigger, flyAppName: target.flyAppName }, 'FLY_API_TOKEN secret bootstrapped on cloud app');
        } catch (err) {
          log.warn({ err, flyAppName: target.flyAppName }, 'Failed to persist flyApiTokenSecretRepairedAt timestamp');
        }
      } else {
        // Non-fatal: continue with the update. We'll retry on the next cycle.
        log.warn(
          { trigger, flyAppName: target.flyAppName, error: repair.error },
          'Failed to bootstrap FLY_API_TOKEN secret; cloud-side self-updater may remain stuck',
        );
      }
    }

    broadcastUpdateStatus('applying', 'Updating your cloud instance...', {
      trigger,
      flyAppName: target.flyAppName,
      latestTag: checkResult.latestTag,
    });

    const applyResult = await applyCloudUpdate({
      flyApiToken,
      flyAppName: target.flyAppName,
      flyMachineId: target.flyMachineId,
      cloudUrl: target.cloudUrl,
      latestTag: checkResult.latestTag,
      channel,
    });

    if (!applyResult.success) {
      broadcastUpdateStatus('error', applyResult.error ?? 'Cloud update failed.', {
        trigger,
        flyAppName: target.flyAppName,
        latestTag: checkResult.latestTag,
      });
      return;
    }

    if (!applyResult.updated) {
      log.debug({ trigger, flyAppName: target.flyAppName }, 'Cloud update not applied (already current)');
      return;
    }

    broadcastUpdateStatus('updated', 'Cloud service updated successfully.', {
      trigger,
      flyAppName: target.flyAppName,
      latestTag: applyResult.latestTag,
      runningVersion: applyResult.runningVersion,
      startedMachine: applyResult.startedMachine,
    });
  })()
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, trigger }, 'Cloud update scheduler run failed unexpectedly');
      broadcastUpdateStatus('error', message, { trigger });
    })
    .finally(() => {
      inFlightRun = null;
    });

  return inFlightRun;
}

/**
 * Test-only seam: run a single update cycle and await its completion.
 * `startCloudUpdateScheduler` must have been called first (it installs the
 * settings accessor); production code paths go through the timers /
 * `triggerImmediateUpdateCheck`, which are fire-and-forget by design.
 */
export async function _runUpdateCycleForTesting(trigger: SchedulerTrigger): Promise<void> {
  return runUpdateCycle(trigger);
}

export function startCloudUpdateScheduler(getSettings: () => AppSettings): void {
  getSettingsRef = getSettings;

  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;

  const startupJitterMs = Math.floor(Math.random() * (INITIAL_CHECK_MAX_JITTER_MS + 1));
  startupTimer = setTimeout(() => {
    startupTimer = null;
    fireAndForget(runUpdateCycle('startup'), 'cloudUpdateScheduler.line236');
  }, startupJitterMs);

  intervalTimer = createPausableInterval(() => {
    fireAndForget(runUpdateCycle('interval'), 'cloudUpdateScheduler.line240');
  }, UPDATE_CHECK_INTERVAL_MS, { pauseOnBlur: true, catchUpPriority: 9 });

  log.info(
    { startupJitterMs, intervalMs: UPDATE_CHECK_INTERVAL_MS },
    'Cloud update scheduler started',
  );
}

/**
 * Trigger an immediate update check (bypasses jitter and interval).
 * Called when the desktop detects a cloud version change via the
 * X-Rebel-Cloud-Version header on regular HTTP traffic.
 */
export function triggerImmediateUpdateCheck(): void {
  if (!getSettingsRef) {
    log.debug('triggerImmediateUpdateCheck: scheduler not started, ignoring');
    return;
  }
  log.info('Triggering immediate cloud update check (version change detected)');
  fireAndForget(runUpdateCycle('version-change'), 'cloudUpdateScheduler.line260');
}

export function stopCloudUpdateScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (intervalTimer) {
    intervalTimer();
    intervalTimer = null;
  }

  schedulerStarted = false;
  inFlightRun = null;
  getSettingsRef = null;

  log.info('Cloud update scheduler stopped');
}
