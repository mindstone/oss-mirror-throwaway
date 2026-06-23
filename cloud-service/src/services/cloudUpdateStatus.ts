/**
 * Cloud Update Status & Rollback Visibility
 *
 * The pre-bootstrap watchdog (`preBootstrapWatchdog.ts`) rolls a crash-looping
 * cloud back to its last-known-good image and quarantines the bad tag — but it
 * runs BEFORE Sentry is initialised, so it can only `console.error` to Fly
 * logs. A successful rollback is therefore invisible to monitoring AND to the
 * user, who is silently left running an older image.
 *
 * This module runs on the *next* (healthy) boot — AFTER Sentry init — and:
 *  - {@link computeCloudUpdateStatus} derives a coarse status from the on-disk
 *    quarantine + last-known-good state, surfaced on `/api/health` so the
 *    desktop reconciler / user can see "a recent update was rolled back".
 *  - {@link reportRollbackIfNew} emits a one-shot Sentry event for any rollback
 *    we have not reported yet (deduped via a transient marker file) so the team
 *    learns that a bad image shipped and the safety net caught it.
 *
 * Deliberately read-only with respect to the watchdog's stores: we never write
 * the quarantine / LKG / boot-state files here. The only file this module
 * writes is its own dedup marker, which is transient telemetry state (NOT a
 * schema-versioned store — it must stay out of `ALL_STORE_VERSIONS` so it never
 * affects the rollback schema-fingerprint gate).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import {
  createQuarantinedTagsStore,
  type QuarantinedTagsStore,
  type QuarantineEntry,
} from './quarantinedTagsStore';
import {
  createLastKnownGoodImageTagStore,
  type LastKnownGoodImageTagStore,
} from './lastKnownGoodImageTagStore';

const log = createScopedLogger({ service: 'cloud-update-status' });

const DEFAULT_MARKER_FILE = '.rollback-reported.json';

export type CloudUpdateHealthStatus = 'ok' | 'recently-rolled-back';

export interface CloudUpdateStatusSummary {
  /**
   * `recently-rolled-back` whenever there is at least one active (non-expired)
   * quarantine entry — i.e. the pre-bootstrap watchdog rejected a bad image
   * within the quarantine TTL (default 7d). Otherwise `ok`.
   */
  status: CloudUpdateHealthStatus;
  /** The image this process is running (`FLY_IMAGE_REF`), if known. */
  currentImageTag?: string;
  /** The last-known-good image the watchdog would roll back to, if recorded. */
  lastKnownGoodImageTag?: string;
  /** Active quarantined image tags (bad images the watchdog rejected). */
  quarantinedTags: string[];
}

export interface CloudUpdateStatusDeps {
  dataDir: string;
  /** Defaults to `process.env.FLY_IMAGE_REF`. */
  currentImageTag?: string;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injected for tests; defaults to a store rooted at `dataDir`. */
  quarantineStore?: QuarantinedTagsStore;
  /** Injected for tests; defaults to a store rooted at `dataDir`. */
  lkgStore?: LastKnownGoodImageTagStore;
}

function resolveCurrentImageTag(deps: CloudUpdateStatusDeps): string | undefined {
  return deps.currentImageTag ?? process.env.FLY_IMAGE_REF ?? undefined;
}

/**
 * Best-effort, read-only. Any store read failure degrades to empty/`ok` rather
 * than throwing — this is telemetry/status, never a request-blocking path.
 */
export function computeCloudUpdateStatus(
  deps: CloudUpdateStatusDeps,
): CloudUpdateStatusSummary {
  const now = deps.now ?? Date.now;

  let quarantinedTags: string[] = [];
  try {
    const quarantineStore =
      deps.quarantineStore ?? createQuarantinedTagsStore({ dataPath: deps.dataDir });
    quarantinedTags = quarantineStore.readActive(now()).map((e) => e.imageTag);
  } catch (err) {
    log.warn({ err }, 'cloud-update status: failed to read quarantine store');
  }

  let lastKnownGoodImageTag: string | undefined;
  try {
    const lkgStore =
      deps.lkgStore ?? createLastKnownGoodImageTagStore({ dataPath: deps.dataDir });
    lastKnownGoodImageTag = lkgStore.read()?.imageTag;
  } catch (err) {
    log.warn({ err }, 'cloud-update status: failed to read last-known-good store');
  }

  return {
    status: quarantinedTags.length > 0 ? 'recently-rolled-back' : 'ok',
    currentImageTag: resolveCurrentImageTag(deps),
    lastKnownGoodImageTag,
    quarantinedTags,
  };
}

export interface ReportRollbackDeps extends CloudUpdateStatusDeps {
  /** Defaults to `.rollback-reported.json` under `dataDir`. */
  markerFileName?: string;
}

export interface ReportRollbackResult {
  reported: boolean;
  rolledBackFromTag?: string;
}

interface RollbackReportMarker {
  reportedRejectedAt: number;
}

function readReportedRejectedAt(markerPath: string): number {
  try {
    if (!fs.existsSync(markerPath)) return 0;
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<RollbackReportMarker>;
    if (typeof parsed.reportedRejectedAt === 'number' && Number.isFinite(parsed.reportedRejectedAt)) {
      return parsed.reportedRejectedAt;
    }
  } catch (err) {
    log.warn({ err }, 'rollback visibility: failed to read report marker; may re-report once');
  }
  return 0;
}

function persistReportedRejectedAt(markerPath: string, rejectedAt: number): void {
  try {
    const tmp = `${markerPath}.tmp`;
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ reportedRejectedAt: rejectedAt }), 'utf8');
    fs.renameSync(tmp, markerPath);
  } catch (err) {
    log.warn({ err }, 'rollback visibility: captured event but failed to persist marker (may re-report)');
  }
}

/**
 * If the watchdog rolled this machine back (≥1 active quarantine entry) and we
 * have not yet reported that rollback, emit a single Sentry event and record it
 * so subsequent boots within the quarantine TTL don't re-report the same event.
 *
 * Idempotent across boots via the marker; fail-safe (never throws). `level:
 * 'error'` — designated leave-alertable: this event means a bad image shipped
 * to production and crash-looped; it must page even under a `level gte error`
 * alert filter (re-leveled warning→error in Stage 3 of
 * docs/plans/260610_improve-sentry-noise/PLAN.md).
 */
export function reportRollbackIfNew(deps: ReportRollbackDeps): ReportRollbackResult {
  const now = deps.now ?? Date.now;

  let entries: QuarantineEntry[];
  try {
    const quarantineStore =
      deps.quarantineStore ?? createQuarantinedTagsStore({ dataPath: deps.dataDir });
    entries = quarantineStore.readActive(now());
  } catch (err) {
    log.warn({ err }, 'rollback visibility: failed to read quarantine store');
    return { reported: false };
  }

  if (entries.length === 0) return { reported: false };

  const newest = entries.reduce((a, b) => (b.rejectedAt > a.rejectedAt ? b : a));
  const markerPath = path.join(deps.dataDir, deps.markerFileName ?? DEFAULT_MARKER_FILE);

  if (newest.rejectedAt <= readReportedRejectedAt(markerPath)) {
    return { reported: false };
  }

  const currentImageTag = resolveCurrentImageTag(deps);
  try {
    getErrorReporter().captureMessage('cloud.image_rollback.recovered', {
      level: 'error',
      fingerprint: ['cloud.image_rollback.recovered'],
      tags: {
        event: 'cloud.image_rollback.recovered',
        surface: 'cloud',
      },
      extra: {
        rolledBackFromTag: newest.imageTag,
        currentImageTag,
        rejectedAt: newest.rejectedAt,
        activeQuarantineCount: entries.length,
      },
    });
  } catch (err) {
    log.warn({ err }, 'rollback visibility: failed to capture rollback event');
    return { reported: false };
  }

  persistReportedRejectedAt(markerPath, newest.rejectedAt);
  log.info(
    { rolledBackFromTag: newest.imageTag, currentImageTag },
    'rollback visibility: reported image rollback to Sentry',
  );
  return { reported: true, rolledBackFromTag: newest.imageTag };
}
