/**
 * Contribution Startup Sweep
 *
 * Stage 6 of the agent-reported-state hardening plan
 * (`docs/plans/260416_agent_reported_state_hardening.md`).
 *
 * ─── Motivation ───
 *
 * Contributions can get stuck in the `testing` status when a promotion signal
 * path fails silently — classically the "subagent gap" where a subagent built
 * the connector, registered it, but the PostToolUse hooks never fired for the
 * parent session. Stage 4 consolidated promotion into a composition predicate
 * that refuses to promote on operational-state alone. This is correct for
 * newly-built connectors, but it leaves historical `testing` records stuck
 * forever once the session ends.
 *
 * The startup sweep unblocks stuck contributions whose connector IS present
 * on disk AND registered in the MCP config. Stage 3.E (260426): rebuilds
 * durable readiness evidence by firing `observeContribution` for both
 * build-detected and server-registered observations through the same
 * reducer as all other paths — no special-casing. Boot-time observations
 * never fire `ready_requested`; the agent must re-issue intent.
 *
 * ─── Remediates Apple-Reminders in-situ ───
 *
 * The user's Apple-Reminders build (`contrib-mo1ngu1k-dyw8sv`) stalled at
 * `testing`. Shipping this sweep promotes it on the next app boot without
 * the user having to rebuild.
 *
 * ─── Idempotency ───
 *
 * Safe to run on every boot. The promotion service guards against
 * re-promotion via the store's same-status no-op guard (Stage 2) and its own
 * post-promotion registry cleanup.
 *
 * ─── Age threshold ───
 *
 * Only considers contributions older than `STUCK_AGE_THRESHOLD_MS` (10 min).
 * Younger contributions are likely still in-flight (post-turn sweep, agent
 * tool call, auto-check) and should not be touched.
 *
 * ─── Signal reconstruction strategy ───
 *
 * For each stuck contribution:
 *   1. Check if `localServerPath` exists on disk → emit `file-detection`
 *      (evidence axis).
 *   2. Check if MCP config registers a server that matches on name OR path
 *      → emit `startup-sweep` (operational-state axis).
 *
 * If both fire, predicate `evidence AND operational-state` is satisfied and
 * the contribution is promoted. Either axis alone is insufficient, which
 * preserves Stage 4's correctness guarantee.
 */

import fs from 'node:fs';
import { createScopedLogger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import { getStuckTestingContributions } from '@core/services/contributionStore';
import { observeContribution } from '@core/services/contributionObservationService';
import { classifyContributionPath } from '@shared/utils/contributionPathClassifier';
import { verifyConnectorRegistration } from './mcpRegistrationVerifier';
import { resolveMcpConfigPath } from './mcpService';
import { getSettings } from '../settingsStore';

const log = createScopedLogger({ service: 'contributionStartupSweep' });
export { isAbsoluteCrossPlatformForTests } from './mcpRegistrationVerifier';

function redactPathTail(pathValue: string | null | undefined): string | null {
  if (!pathValue) return null;
  const parts = toPortablePath(pathValue).split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(-2).join('/');
}

function isAllowedContributionPathClass(
  pathClass: ReturnType<typeof classifyContributionPath>,
): boolean {
  return pathClass === 'canonical' || pathClass === 'connectors-repo';
}

/**
 * Contributions must be at least this old before the sweep considers them
 * "stuck". Newer contributions are likely still in an in-flight promotion
 * path (post-turn sweep scheduled, agent tool call in progress, etc.) and
 * touching them risks racing with active logic.
 *
 * 10 minutes is a conservative floor: a connector build that hasn't made
 * promotion progress in 10 minutes is almost certainly stuck.
 */
export const STUCK_AGE_THRESHOLD_MS = 10 * 60 * 1_000;

/**
 * Result of a single sweep invocation. Returned for logging and tests.
 */
export interface StartupSweepResult {
  inspected: number;
  skippedYoung: number;
  skippedNoConfig: number;
  skippedNoPath: number;
  skippedNotOnDisk: number;
  skippedNotRegistered: number;
  promoted: number;
  /** Contribution IDs that the sweep promoted, for observability. */
  promotedIds: string[];
  /** Contribution IDs that stayed `testing` despite inspection. */
  remainingIds: string[];
}

/**
 * Whether a local path exists on disk. Errors (EPERM, ELOOP, etc.) count as
 * not-exist because we can't prove the connector is present.
 */
function pathExistsOnDisk(localServerPath: string): boolean {
  try {
    return fs.existsSync(localServerPath);
  } catch {
    return false;
  }
}

/**
 * Parse an ISO timestamp into millis. Contribution timestamps are stored as
 * ISO strings (`ConnectorContribution.createdAt/updatedAt` — see
 * `contributionTypes.ts`), so raw arithmetic would yield NaN. Returns
 * undefined on parse failure so callers can gate safely.
 */
function parseIsoTimestamp(raw: string | number | undefined | null): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Run the startup sweep. Returns the result for tests / observability; does
 * NOT throw — any per-contribution error is logged and the sweep continues.
 *
 * Optional `now` / `configPathOverride` params support dependency injection
 * in tests.
 */
export async function runContributionStartupSweep(options?: {
  now?: number;
  configPathOverride?: string | null;
}): Promise<StartupSweepResult> {
  const now = options?.now ?? Date.now();
  const result: StartupSweepResult = {
    inspected: 0,
    skippedYoung: 0,
    skippedNoConfig: 0,
    skippedNoPath: 0,
    skippedNotOnDisk: 0,
    skippedNotRegistered: 0,
    promoted: 0,
    promotedIds: [],
    remainingIds: [],
  };

  // Stage 3.E (260426): use the dedicated store helper so the boot sweep
  // applies the age threshold inside the store's normalised view, not
  // post-hoc on `listContributions()`. Stage 3.C added this helper.
  const stuck = getStuckTestingContributions({
    now,
    olderThanMs: STUCK_AGE_THRESHOLD_MS,
  });
  if (stuck.length === 0) {
    log.info({ inspected: 0 }, 'Startup sweep: no stuck contributions');
    return result;
  }

  const configPath =
    options?.configPathOverride !== undefined
      ? options.configPathOverride
      : resolveMcpConfigPath(getSettings());

  if (!configPath) {
    log.warn(
      { stuckCount: stuck.length },
      'Startup sweep: no MCP config path; skipping all stuck contributions',
    );
    result.skippedNoConfig = stuck.length;
    result.remainingIds = stuck.map((c) => c.id);
    return result;
  }

  for (const contribution of stuck) {
    result.inspected += 1;

    // Wrap entire per-contribution body so one rogue throw doesn't abort
    // the whole sweep. The header contract promises this behavior but the
    // original code only had a narrow try/catch around the config scan
    // (Opus S1, Codex MEDIUM).
    try {
      // Defence in depth: getStuckTestingContributions filters by age, but
      // a malformed timestamp could still surface here. parseIsoTimestamp
      // double-checks (CRITICAL: raw `now - isoString` yields NaN, which
      // is always false under `<`, bypassing the guard entirely — GPT-5.5
      // CRITICAL + Codex CRITICAL).
      const timestampCandidate = contribution.updatedAt ?? contribution.createdAt;
      const parsedMs = parseIsoTimestamp(timestampCandidate);
      if (parsedMs === undefined) {
        log.warn(
          {
            contributionId: contribution.id,
            raw: timestampCandidate,
          },
          'Startup sweep: could not parse contribution timestamp; treating as young and skipping',
        );
        result.skippedYoung += 1;
        result.remainingIds.push(contribution.id);
        continue;
      }
      const ageMs = now - parsedMs;
      if (ageMs < STUCK_AGE_THRESHOLD_MS) {
        result.skippedYoung += 1;
        result.remainingIds.push(contribution.id);
        continue;
      }

      // Path guard: without a localServerPath we can't verify evidence.
      if (!contribution.localServerPath) {
        result.skippedNoPath += 1;
        result.remainingIds.push(contribution.id);
        continue;
      }

      const pathClass = classifyContributionPath(contribution.localServerPath);
      if (!isAllowedContributionPathClass(pathClass)) {
        result.remainingIds.push(contribution.id);
        log.warn(
          {
            reason: 'contribution-path-non-canonical',
            gate: 'startup-sweep',
            sessionId: contribution.sessionId,
            contributionId: contribution.id,
            connectorName: contribution.connectorName,
            pathClassRedacted: redactPathTail(contribution.localServerPath),
            classification: pathClass,
          },
          'Non-canonical contribution path — SKILL.md contract violation',
        );
        continue;
      }

      // Evidence signal: path exists on disk.
      const onDisk = pathExistsOnDisk(contribution.localServerPath);
      if (!onDisk) {
        result.skippedNotOnDisk += 1;
        result.remainingIds.push(contribution.id);
        log.info(
          {
            contributionId: contribution.id,
            connectorName: contribution.connectorName,
            localServerPath: contribution.localServerPath,
          },
          'Startup sweep: stuck contribution not present on disk; leaving record at testing for Settings recovery affordance',
        );
        continue;
      }

      // Operational-state signal: MCP config registers the connector.
      let registrationMatched = false;
      try {
        const registration = await verifyConnectorRegistration(
          configPath,
          contribution.connectorName,
          contribution.localServerPath,
          { log },
        );
        registrationMatched = registration.matched;
      } catch (err) {
        log.warn(
          {
            err,
            contributionId: contribution.id,
            connectorName: contribution.connectorName,
          },
          'Startup sweep: MCP config scan failed; skipping this contribution',
        );
        result.skippedNotRegistered += 1;
        result.remainingIds.push(contribution.id);
        continue;
      }

      if (!registrationMatched) {
        result.skippedNotRegistered += 1;
        result.remainingIds.push(contribution.id);
        log.info(
          {
            contributionId: contribution.id,
            connectorName: contribution.connectorName,
          },
          'Startup sweep: stuck contribution not registered in MCP config; leaving record at testing for Settings recovery affordance',
        );
        continue;
      }

      // Stage 3.E (260426): route through `observeContribution`. Two
      // observations per stuck record — `build_detected` populates
      // `lastBuildDetectedAt + lastBuildFingerprint`, then
      // `server_registered` populates `lastRegisteredAt`. Neither fires
      // `ready_requested`; the boot path must NOT auto-promote (no agent
      // intent — the Apple-Reminders re-entry path is intentionally
      // sacrificed per Stage 3 plan § 3.E Decision 3).
      await observeContribution({
        kind: 'build_detected',
        sessionId: contribution.sessionId,
        localServerPath: contribution.localServerPath,
        connectorName: contribution.connectorName,
        source: 'startup-sweep',
      });
      await observeContribution({
        kind: 'server_registered',
        sessionId: contribution.sessionId,
        localServerPath: contribution.localServerPath,
        connectorName: contribution.connectorName,
        source: 'startup-sweep',
      });

      // The reducer never auto-promotes from boot-time observations
      // alone — `lastReadyRequestedAt` was lost when the legacy
      // in-memory promotion-signal map died on restart, and the agent
      // must re-issue. We surface this record as still-pending so the
      // UI / Settings recovery affordance can prompt the user.
      result.remainingIds.push(contribution.id);
      log.info(
        {
          contributionId: contribution.id,
          connectorName: contribution.connectorName,
          ageMinutes: Math.round(ageMs / 60_000),
          reason: 'awaiting-ready-requested',
        },
        'Startup sweep: emitted build_detected + server_registered observations; awaiting fresh ready_requested from agent',
      );
    } catch (err) {
      // Per-contribution catch-all. Log, record as remaining, continue.
      log.warn(
        {
          err,
          contributionId: contribution.id,
          connectorName: contribution.connectorName,
        },
        'Startup sweep: unexpected error processing contribution; continuing sweep',
      );
      result.remainingIds.push(contribution.id);
    }
  }

  log.info(
    {
      inspected: result.inspected,
      promoted: result.promoted,
      skippedYoung: result.skippedYoung,
      skippedNoPath: result.skippedNoPath,
      skippedNotOnDisk: result.skippedNotOnDisk,
      skippedNotRegistered: result.skippedNotRegistered,
    },
    'Contribution startup sweep complete',
  );

  return result;
}
