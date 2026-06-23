/**
 * Bug Report Outbox
 *
 * Durable, disk-backed outbox for user bug reports. This is the by-construction
 * R1/R2 net for the "Feedback & Bugs" path: once a user submits and sees a
 * confirmation, the raw report is persisted to disk BEFORE we return `accepted`,
 * then drained with retry until Sentry confirms a 2xx transport outcome.
 * Offline, transport failure, app quit, or even power loss can no longer lose a
 * submitted report.*
 *
 * (* Power-loss durability is POSIX-only: it relies on a parent-directory fsync
 * after the rename, which is unsupported on Windows. Windows still gets
 * crash-safety — temp-file + filehandle.sync() + crash-safe `.bak` replace — but
 * NOT the directory-entry power-loss guarantee. See "## Power-loss durability".)
 *
 * ## Why a bespoke per-file store (not assetUploadOutbox)
 *
 * `assetUploadOutbox.ts` keeps its queue in memory and re-derives state on boot
 * from an EXTERNAL source of truth (the asset store) — it has no payload-to-disk
 * layer. A bug report's TEXT is the only artifact, so we must persist the
 * payload itself. We therefore reuse the genuine persist-to-disk primitives from
 * the `cloudOutbox.ts` / `pending*Store.ts` family — atomic write, `.corrupt`
 * quarantine on unreadable/torn files, Zod-validate-on-read, byte caps — laid
 * out as ONE JSON file per report under `userData/bug-report-outbox/`. The
 * lifecycle shell (start / stop / backoff / drain) is borrowed conceptually from
 * `assetUploadOutbox`.
 *
 * ## Power-loss durability
 *
 * `src/main/utils/atomicFs.ts#writeFileAtomic` does temp-file + rename, which
 * survives a process crash but NOT a power loss (the temp file's bytes may still
 * be in the OS write-back cache when the rename's directory entry is flushed).
 * Because "robust by construction" is the explicit goal here, this module writes
 * the temp file and `filehandle.sync()`s it (fsync) BEFORE the rename, so the
 * payload bytes are on stable storage before the rename makes them visible, and
 * then fsyncs the PARENT DIRECTORY after the rename so the new directory entry
 * is itself durable (on some filesystems a rename can otherwise be lost on power
 * loss even though the file bytes survived). Directory fsync is skipped on
 * Windows (opening a directory for fsync is unsupported there) and is best-
 * effort everywhere — it never discards an otherwise-successful write.
 *
 * On Windows, `rename` fails if the destination exists, so an update of an
 * already-`accepted` record (retry bookkeeping / dead-letter parking) preserves
 * the live copy as `<id>.json.bak` until the replacement is durable, then
 * removes the backup. A crash mid-replace leaves a recoverable copy as either
 * `<id>.json` or its `.bak`; the boot/drain scan recovers a stranded `.bak`
 * (`recoverWindowsBackups`). The previous unlink-before-rename had a window
 * where a crash destroyed the only durable copy.
 *
 * ## schemaVersion (NOT a *STORE_VERSION constant)
 *
 * Each record carries a per-record `schemaVersion: 1`. This is deliberately NOT
 * registered in `ALL_STORE_VERSIONS` (`src/core/constants.ts`): doing so would
 * couple it to the `check-store-versions` gate and a `DATA_SCHEMA_EPOCH` bump,
 * whose cross-worktree login-breakage cost is not justified for an ephemeral
 * delivery queue. Old/unreadable records are quarantined to `.corrupt`, not
 * migrated — the queue is transient, not user state.
 *
 * ## Idempotency invariant
 *
 * Every record carries a FIXED `eventId` (32-char hex). All delivery attempts —
 * the immediate one and every retry — submit with the SAME `eventId`, so a retry
 * after a pre-delete crash dedups server-side in Sentry (no second issue). The
 * outbox never re-mints the id.
 *
 * ## Drain wakes (there is NO online/offline signal in main/core)
 *
 * The drain is woken by: (1) immediate-on-enqueue, (2) a boot directory scan in
 * `start()`, (3) a backoff re-fire timer, and (4) `powerMonitor.resume`. There
 * is intentionally NO "network-recovery" event — none exists at this layer.
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { powerMonitor } from 'electron';
import { z } from 'zod';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { DiagnosticSectionsSchema } from '@shared/diagnostics/diagnosticBundleSections';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getDataPath } from '../utils/dataPaths';

const log = createScopedLogger({ service: 'bugReportOutbox' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTBOX_DIR_NAME = 'bug-report-outbox';
const RECORD_SCHEMA_VERSION = 1 as const;

/**
 * Backoff schedule (ms) for failed delivery attempts, ramping to ~10 min then
 * holding at the cap. Modelled on `cloudOutbox`'s exponential ramp; ±20% jitter
 * is applied at scheduling time so a fleet coming back online does not thunder.
 */
const BACKOFF_DELAYS_MS = [
  1_000,
  5_000,
  25_000,
  60_000,
  125_000,
  300_000, // 5 min
  600_000, // 10 min — cap
];
const BACKOFF_JITTER_RATIO = 0.2;

/**
 * Max delivery attempts before a record is dead-lettered. After this many
 * failed attempts the record is parked (kept on disk for visibility), retrying
 * stops, and a distinct Sentry event is emitted so the dead-letter itself is
 * visible — a silent local-only dead-letter would be reborn-invisible, which is
 * the exact class of bug this whole effort fixes.
 */
const MAX_DELIVERY_ATTEMPTS = 12;

/** Bounded retention. Oldest dead-letters are pruned first with a loud log. */
const MAX_RECORD_COUNT = 200;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Drain concurrency. Reports are rare — one at a time avoids retry storms. */
// (Enforced structurally by the single `draining` guard below.)

// ---------------------------------------------------------------------------
// Record schema (Zod-validated on read)
// ---------------------------------------------------------------------------

const UrgencySchema = z.enum(['low', 'medium', 'high', 'critical']);

/**
 * The persisted bug-report record. Raw report fields + best-effort enrichment
 * slots + delivery bookkeeping. `schemaVersion` is per-record (see file header).
 */
export const BugReportRecordSchema = z.object({
  schemaVersion: z.literal(RECORD_SCHEMA_VERSION),
  reportId: z.string().min(1),
  /** Fixed 32-char lowercase hex Sentry event_id — reused across all attempts. */
  eventId: z.string().regex(/^[0-9a-f]{32}$/),
  createdAt: z.number(),

  // Raw report fields (the artifact we must never lose).
  description: z.string().min(1),
  stepsToReproduce: z.string().optional(),
  expectedBehavior: z.string().optional(),
  urgency: UrgencySchema,
  conversationId: z.string().optional(),
  screenshotBase64: z.string().optional(),
  screenshotMimeType: z.string().optional(),

  // Best-effort enrichment slots (gathered at submit time; persisted so a
  // later-boot replay keeps whatever was captured). All optional.
  includeEnrichedDiagnostics: z.boolean().optional(),
  attachContinuityDiagnostics: z.boolean().optional(),
  /**
   * The user's granular per-section diagnostic toggle map. PERSISTED (it is a
   * small partial boolean record, not bulk content) so the user's CONSENT
   * choice — an explicit `false` means "do not gather this section" — is
   * honored on the immediate attempt AND every retry, not just the first.
   * Dropping it would silently re-gather a section the user unchecked: a
   * consent/privacy regression (Stage-4 review F3).
   */
  diagnosticSections: DiagnosticSectionsSchema.optional(),

  // Delivery bookkeeping.
  attempt: z.number().int().nonnegative(),
  nextRetryAt: z.number(),
  /**
   * Set once a record has exhausted its retries (dead-letter). Parked records
   * are kept on disk for visibility but never retried; they are the first
   * candidates for retention pruning.
   */
  deadLetteredAt: z.number().optional(),
  lastError: z.string().optional(),
});

export type BugReportRecord = z.infer<typeof BugReportRecordSchema>;

/**
 * The fields a caller supplies at enqueue time. The outbox fills in
 * `schemaVersion`, `createdAt`, `attempt`, and `nextRetryAt`.
 */
export type BugReportEnqueueInput = Omit<
  BugReportRecord,
  'schemaVersion' | 'createdAt' | 'attempt' | 'nextRetryAt' | 'deadLetteredAt' | 'lastError'
>;

// ---------------------------------------------------------------------------
// Submit outcome contract
// ---------------------------------------------------------------------------

/**
 * Outcome of a single delivery attempt, returned by the injected submit fn.
 * - `delivered`: confirmed 2xx transport outcome → delete the record.
 * - `retry`: transient failure (non-2xx, flush timeout, throw) → keep + backoff.
 * - `circuit-open`: Sentry returned 429 / quota / is disabled → pause draining.
 *   `retryAfterMs` (when present) widens the pause to honour `Retry-After`.
 */
export type BugReportSubmitOutcome =
  | { kind: 'delivered' }
  | { kind: 'retry'; error?: string }
  | { kind: 'circuit-open'; error?: string; retryAfterMs?: number };

/**
 * Per-record submit function. Reuses the Stage-1/2/3 capture logic from
 * `bugReportHandlers.ts` (same event_id, tags, attachments, fingerprint) — the
 * immediate attempt and all retries go through this one path.
 */
export type BugReportSubmitFn = (record: BugReportRecord) => Promise<BugReportSubmitOutcome>;

export interface BugReportOutboxOptions {
  submit: BugReportSubmitFn;
  /**
   * Whether Sentry is currently enabled. When disabled the record still
   * PERSISTS (deliverable on later enable) but the drain no-ops observably.
   * Re-checked on every drain so enabling Sentry later resumes delivery.
   */
  isSentryEnabled: () => boolean;
  /**
   * Called when a drain is skipped because Sentry is disabled AND there is at
   * least one pending (non-dead-lettered) record waiting. Receives the oldest
   * such record so the handler can surface the honest `delivery-unavailable`
   * toast (the record persisted but can't be delivered right now) WITH the
   * report text for the environment-independent Copy-report action — without the
   * outbox knowing about broadcasts. Optional; fired at most once per skipped
   * drain.
   *
   * `trigger` is the drain reason (`'enqueue'` for a fresh user submit;
   * `'boot'`/`'power-resume'`/`'backoff-timer'`/`'quit'` for proactive/background
   * drains). The handler uses it to suppress UNSOLICITED toasts: a stranded
   * prior-session record replayed at boot must not pop a warning toast unrelated
   * to any current user action (Phase 7 SHOULD-3 / Native F2).
   */
  onSentryDisabledWithPending?: (oldestPending: BugReportRecord, trigger: string) => void;
  /**
   * Called when a record is dead-lettered after exhausting its delivery retries.
   * Lets the handler surface the honest `delivery-unavailable` toast (with the
   * report text for the Copy-report action) so a permanently-undeliverable
   * report isn't reborn-invisible to the user. Optional.
   *
   * `trigger` is the drain reason that drove this dead-letter — same suppression
   * contract as `onSentryDisabledWithPending` (toast only for a fresh submit).
   */
  onDeadLetter?: (record: BugReportRecord, trigger: string) => void;
  /** Override the outbox directory (tests). Defaults to userData/bug-report-outbox. */
  dirPath?: string;
  /** Override now() for deterministic tests. */
  now?: () => number;
}

export interface StopOptions {
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export class BugReportOutbox {
  private readonly submit: BugReportSubmitFn;
  private readonly isSentryEnabled: () => boolean;
  private readonly onSentryDisabledWithPending?: (oldestPending: BugReportRecord, trigger: string) => void;
  private readonly onDeadLetter?: (record: BugReportRecord, trigger: string) => void;
  private readonly dir: string;
  private readonly now: () => number;

  private running = false;
  private stopping = false;
  /** Coalesces concurrent drains: re-entrant callers await the in-flight one. */
  private drainPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private circuitOpenUntil = 0;
  private onPowerResume?: () => void;

  constructor(options: BugReportOutboxOptions) {
    this.submit = options.submit;
    this.isSentryEnabled = options.isSentryEnabled;
    this.onSentryDisabledWithPending = options.onSentryDisabledWithPending;
    this.onDeadLetter = options.onDeadLetter;
    this.dir = options.dirPath ?? path.join(getDataPath(), OUTBOX_DIR_NAME);
    this.now = options.now ?? (() => Date.now());
  }

  /** The directory this outbox persists records under (absolute path). */
  get directory(): string {
    return this.dir;
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    await fsp.mkdir(this.dir, { recursive: true }).catch((err) => {
      log.warn({ err: errMsg(err), dir: this.dir }, 'Failed to create bug-report outbox dir');
    });

    // Wake 4: powerMonitor.resume (laptop wake — a common "was offline" moment).
    // powerMonitor requires app-ready; start() runs after boot so this is safe.
    try {
      this.onPowerResume = () => {
        this.fireDrain('power-resume');
      };
      powerMonitor.on('resume', this.onPowerResume);
    } catch (err) {
      // Non-fatal: power events are a bonus wake, not the only one.
      log.warn({ err: errMsg(err) }, 'Failed to subscribe to powerMonitor.resume');
    }

    // Wake 2: boot directory scan.
    await this.drain('boot');
  }

  async stop(options: StopOptions = {}): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    const timeoutMs = options.timeoutMs ?? 5_000;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.onPowerResume) {
      try {
        powerMonitor.removeListener('resume', this.onPowerResume);
      } catch (err) {
        ignoreBestEffortCleanup(err, {
          operation: 'bugReportOutbox.stop.unsubscribePowerResume',
          reason: 'unsubscribing a power-resume listener at shutdown must never block quit',
        });
      }
      this.onPowerResume = undefined;
    }

    // Final best-effort drain, bounded by timeoutMs so quit isn't blocked.
    const drainPromise = this.drain('quit');
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([drainPromise, timeout]).catch((err) => {
      ignoreBestEffortCleanup(err, {
        operation: 'bugReportOutbox.stop.quitDrain',
        reason: 'the quit drain is best-effort and time-bounded; undelivered records replay on next boot',
      });
    });

    this.running = false;
    this.stopping = false;
  }

  // ---- Enqueue ------------------------------------------------------------

  /**
   * Persist a record to disk with an atomic + fsync'd write, confirm it, and
   * return. The handler returns `accepted` ONLY after this resolves — that is
   * the durability contract. Wakes the drain immediately (wake 1).
   *
   * Resolves to the persisted record; rejects only if the durable write fails
   * (so the caller can surface an honest `failed`, not a false `accepted`).
   */
  async enqueue(input: BugReportEnqueueInput): Promise<BugReportRecord> {
    await fsp.mkdir(this.dir, { recursive: true });

    const record: BugReportRecord = {
      ...input,
      schemaVersion: RECORD_SCHEMA_VERSION,
      createdAt: this.now(),
      attempt: 0,
      nextRetryAt: this.now(),
    };
    // Validate before persisting so a malformed record can't reach disk.
    const validated = BugReportRecordSchema.parse(record);

    await this.writeRecordDurable(validated);

    // Fire-and-forget immediate drain (wake 1). Don't gate enqueue on delivery.
    this.fireDrain('enqueue');
    return validated;
  }

  // ---- Drain --------------------------------------------------------------

  /**
   * Drain due records, one at a time (concurrency = 1). Concurrent calls
   * coalesce: a re-entrant caller awaits the in-flight drain rather than
   * starting a second one (so the immediate-on-enqueue drain and an explicit
   * drain don't run the same record twice). Gated on `isSentryEnabled()` and the
   * circuit breaker; both cause an observable no-op (logged), not silent
   * inaction.
   *
   * NOTE: drain is intentionally NOT gated on `this.running`. The handler
   * enqueues (and triggers the immediate drain) without ever calling `start()` —
   * `start()` only adds the boot scan + power-resume wake.
   */
  async drain(reason: string): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runDrain(reason).finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  /**
   * Fire-and-forget a drain (the wake triggers don't await delivery). A drain
   * should never reject — `runDrain` guards each step — but if it somehow does,
   * log it observably rather than dropping the rejection (no silent swallow).
   */
  private fireDrain(reason: string): void {
    this.drain(reason).catch((err) => {
      log.warn({ err: errMsg(err), reason }, 'Bug-report outbox drain rejected unexpectedly');
    });
  }

  private async runDrain(reason: string): Promise<void> {
    if (!this.isSentryEnabled()) {
      log.info({ reason }, 'Bug-report outbox drain skipped — Sentry disabled (records persist for later)');
      // Keep the user-facing status honest: if a record is waiting, tell the
      // handler so it can surface the `delivery-unavailable` state. The record
      // stays on disk and delivers if Sentry is enabled later. We forward the
      // drain `reason` so the handler can suppress the toast for proactive/boot
      // drains (a stranded record must not pop an unsolicited startup toast —
      // Phase 7 SHOULD-3); the no-op is still logged above (observable).
      if (this.onSentryDisabledWithPending) {
        const records = await this.loadAllRecords();
        const pending = records
          .filter((r) => r.deadLetteredAt === undefined)
          .sort((a, b) => a.createdAt - b.createdAt);
        if (pending.length > 0) {
          // Pass the oldest pending record so the handler can offer Copy-report.
          this.onSentryDisabledWithPending(pending[0], reason);
        }
      }
      return;
    }

    const nowTs = this.now();
    if (this.circuitOpenUntil > nowTs) {
      log.info(
        { reason, reopenInMs: this.circuitOpenUntil - nowTs },
        'Bug-report outbox drain skipped — circuit breaker open',
      );
      this.scheduleWake(this.circuitOpenUntil - nowTs);
      return;
    }

    // Retention prune first so an over-full queue can't grow unbounded even
    // when nothing is deliverable.
    await this.pruneForRetention();

    const records = await this.loadAllRecords();
    for (const record of records) {
      if (record.deadLetteredAt !== undefined) continue;
      if (record.nextRetryAt > this.now()) continue;

      let outcome: BugReportSubmitOutcome;
      try {
        outcome = await this.submit(record);
      } catch (err) {
        outcome = { kind: 'retry', error: errMsg(err) };
      }

      if (outcome.kind === 'delivered') {
        await this.deleteRecord(record.reportId);
        continue;
      }

      if (outcome.kind === 'circuit-open') {
        // Pause the whole drain; do NOT count this as an attempt against the
        // record (the failure is server-side capacity, not this report).
        const pauseMs = outcome.retryAfterMs && outcome.retryAfterMs > 0
          ? outcome.retryAfterMs
          : this.backoffForAttempt(0);
        this.circuitOpenUntil = this.now() + pauseMs;
        log.warn(
          { reportId: record.reportId, pauseMs, error: outcome.error },
          'Bug-report outbox circuit opened (Sentry 429/quota/disabled) — pausing drain',
        );
        this.scheduleWake(pauseMs);
        return;
      }

      // outcome.kind === 'retry'
      await this.recordAttemptFailure(record, reason, outcome.error);
    }

    // Schedule the next wake for the soonest pending retry (wake 3).
    await this.scheduleNextRetryWake();
  }

  // ---- Failure / dead-letter ----------------------------------------------

  private async recordAttemptFailure(record: BugReportRecord, trigger: string, error?: string): Promise<void> {
    const attempt = record.attempt + 1;
    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      await this.deadLetter(record, trigger, error);
      return;
    }
    const updated: BugReportRecord = {
      ...record,
      attempt,
      // attempt N (1-based) uses backoff index N-1, so the first retry waits the
      // shortest delay (BACKOFF_DELAYS_MS[0]).
      nextRetryAt: this.now() + this.backoffForAttempt(attempt - 1),
      lastError: error,
    };
    await this.writeRecordDurable(updated).catch((err) => {
      log.warn({ err: errMsg(err), reportId: record.reportId }, 'Failed to persist retry bookkeeping');
    });
    log.info(
      { reportId: record.reportId, attempt, nextRetryAt: updated.nextRetryAt, error },
      'Bug report delivery failed — will retry',
    );
  }

  /**
   * Park a record after retry exhaustion and emit its OWN Sentry event so the
   * dead-letter is visible (not reborn-invisible). The file is kept on disk.
   */
  private async deadLetter(record: BugReportRecord, trigger: string, error?: string): Promise<void> {
    const updated: BugReportRecord = {
      ...record,
      attempt: record.attempt + 1,
      deadLetteredAt: this.now(),
      lastError: error,
      // Park: never due again.
      nextRetryAt: Number.MAX_SAFE_INTEGER,
    };
    await this.writeRecordDurable(updated).catch((err) => {
      log.error({ err: errMsg(err), reportId: record.reportId }, 'Failed to persist dead-letter bookkeeping');
    });

    log.error(
      { reportId: record.reportId, eventId: record.eventId, attempts: updated.attempt, error },
      'Bug report dead-lettered after retry exhaustion — kept on disk; emitting a distinct Sentry event',
    );
    this.emitDeadLetterEvent(updated, 'retry-exhaustion', error);
    // Surface the honest user-facing `delivery-unavailable` toast (with the
    // report text for the Copy-report action) so a permanently-undeliverable
    // report isn't reborn-invisible. Best-effort; never let it break the drain.
    if (this.onDeadLetter) {
      try {
        this.onDeadLetter(updated, trigger);
      } catch (err) {
        log.error(
          { err: errMsg(err), reportId: record.reportId },
          'Bug-report outbox onDeadLetter callback threw',
        );
      }
    }
  }

  /**
   * Emit the distinct `bug_report_dead_letter` Sentry event so a dead-lettered
   * report is VISIBLE (not reborn-invisible). Shared by retry-exhaustion
   * dead-lettering and by retention forced-eviction of a live record (F4).
   */
  private emitDeadLetterEvent(
    record: BugReportRecord,
    reason: 'retry-exhaustion' | 'retention-forced',
    error?: string,
  ): void {
    try {
      getErrorReporter().captureMessage(
        'bug_report_dead_letter: a user bug report could not be delivered after retries',
        {
          level: 'error',
          tags: { bug_report_dead_letter: 'true', report_id: record.reportId, dead_letter_reason: reason },
          extra: {
            reportId: record.reportId,
            eventId: record.eventId,
            attempts: record.attempt,
            urgency: record.urgency,
            createdAt: record.createdAt,
            lastError: error ?? record.lastError,
            deadLetterReason: reason,
          },
        },
      );
    } catch (err) {
      log.error({ err: errMsg(err), reportId: record.reportId }, 'Failed to emit dead-letter Sentry event');
    }
  }

  // ---- Retention ----------------------------------------------------------

  /**
   * Enforce bounded retention: prune by age, then (if still over count/bytes
   * caps) prune oldest dead-letters first, then oldest live records, with a loud
   * log.
   *
   * F4 — "never lost" visibility: a dead-letter being pruned has already emitted
   * its `bug_report_dead_letter` Sentry event, so its removal is just cleanup.
   * But a LIVE (non-dead-lettered) record forced out under cap pressure would
   * otherwise vanish silently — so before deleting it we emit the same visible
   * `bug_report_dead_letter` Sentry event (reason `retention-forced`). It
   * becomes an explicit, observable terminal state, not a silent delete.
   */
  private async pruneForRetention(): Promise<void> {
    const records = await this.loadAllRecords();

    const tooOld = records.filter((r) => this.now() - r.createdAt > MAX_RECORD_AGE_MS);
    for (const r of tooOld) {
      // An aged-out LIVE record is also a forced loss — make it visible too.
      if (r.deadLetteredAt === undefined) {
        this.emitDeadLetterEvent(r, 'retention-forced');
      }
      await this.deleteRecord(r.reportId);
      log.warn({ reportId: r.reportId, ageMs: this.now() - r.createdAt }, 'Pruned aged-out bug report from outbox');
    }

    let remaining = records.filter((r) => this.now() - r.createdAt <= MAX_RECORD_AGE_MS);

    // Prune oldest dead-letters first, then oldest live records, until under both
    // caps. Sort: deliverable records last (preserve them), oldest first.
    const overCount = () => remaining.length > MAX_RECORD_COUNT;
    const overBytes = () =>
      remaining.reduce((sum, r) => sum + recordByteCost(r), 0) > MAX_TOTAL_BYTES;

    while ((overCount() || overBytes()) && remaining.length > 0) {
      const sorted = [...remaining].sort((a, b) => {
        const aDead = a.deadLetteredAt !== undefined ? 0 : 1;
        const bDead = b.deadLetteredAt !== undefined ? 0 : 1;
        if (aDead !== bDead) return aDead - bDead; // dead-letters first
        return a.createdAt - b.createdAt; // then oldest
      });
      const victim = sorted[0];
      const victimIsLive = victim.deadLetteredAt === undefined;
      // F4: a forced-out live record must be observable, not silently dropped.
      if (victimIsLive) {
        this.emitDeadLetterEvent(victim, 'retention-forced');
      }
      await this.deleteRecord(victim.reportId);
      remaining = remaining.filter((r) => r.reportId !== victim.reportId);
      log.warn(
        { reportId: victim.reportId, deadLettered: !victimIsLive, forcedLiveEviction: victimIsLive },
        'Pruned bug report from outbox to enforce retention caps',
      );
    }
  }

  // ---- Disk primitives ----------------------------------------------------

  private recordPath(reportId: string): string {
    return path.join(this.dir, `${reportId}.json`);
  }

  /**
   * Atomic, power-loss-durable write. Writes to a unique temp file, fsyncs the
   * file handle so the bytes hit stable storage, then commits the temp file into
   * place and fsyncs the PARENT DIRECTORY so the new directory entry is itself
   * durable. Survives both process crash AND power loss.
   *
   * POSIX (`rename` overwrites atomically) and Windows (`rename` fails if the
   * destination exists) need different commit strategies — see
   * `commitTempOverDest`. Both are crash-safe: a live `<id>.json` is never left
   * absent at any instant on either platform.
   */
  private async writeRecordDurable(record: BugReportRecord): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const dest = this.recordPath(record.reportId);
    const tmp = `${dest}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(record);

    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      // fsync the payload bytes to stable storage BEFORE the commit so a power
      // loss between write and commit cannot leave a torn/empty file visible.
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await this.commitTempOverDest(tmp, dest);
    } catch (err) {
      try {
        await fsp.unlink(tmp);
      } catch (cleanupErr) {
        ignoreBestEffortCleanup(cleanupErr, {
          operation: 'bugReportOutbox.writeRecordDurable.unlinkTmpOnError',
          reason: 'removing the temp file after a failed commit is best-effort; the original error is rethrown',
        });
      }
      throw err;
    }

    // F1: the file bytes are durable, but on some filesystems the directory
    // entry created by the rename is not durable until the PARENT DIR is
    // fsynced — a power loss right after `accepted` could otherwise lose the
    // only record. Best-effort + awaited: a dir-fsync failure must NOT discard
    // an otherwise-successful write, so we log and continue (the file is on
    // disk regardless).
    await this.fsyncDir(this.dir);
  }

  /**
   * Commit `tmp` over `dest`, crash-safely, per platform.
   *
   * - **POSIX:** `rename(tmp, dest)` overwrites atomically — `dest` always names
   *   either the old or the new content, never absent.
   * - **Windows (F2):** `rename` fails if `dest` exists. The previous code
   *   unlinked `dest` first, leaving a window where a crash destroyed the only
   *   durable copy of an already-`accepted` report (retry/dead-letter rewrites).
   *   Instead, when `dest` exists we first move it aside to `<dest>.bak`, then
   *   rename `tmp` → `dest`, fsync the dir so both the new entry and the `.bak`
   *   removal are durable, then remove `.bak`. At every instant a recoverable
   *   copy exists as either `dest` or `<dest>.bak`; the boot scan recovers a
   *   stranded `.bak` (see `recoverWindowsBackups`).
   */
  private async commitTempOverDest(tmp: string, dest: string): Promise<void> {
    if (process.platform !== 'win32') {
      await fsp.rename(tmp, dest);
      return;
    }

    const bak = `${dest}.bak`;
    let destExists = false;
    try {
      await fsp.access(dest);
      destExists = true;
    } catch {
      destExists = false;
    }

    if (!destExists) {
      // No prior copy to protect — a plain rename is safe (a crash leaves either
      // nothing or the new file, never a destroyed live record).
      await fsp.rename(tmp, dest);
      return;
    }

    // FOLD-IN-5 (Phase 7, GPT F4): a stale `<id>.json.bak` from a prior
    // interrupted replace makes `rename(dest, bak)` fail on Windows (the target
    // exists → EEXIST/EPERM), which would abort this rewrite. Remove any leftover
    // `.bak` first so the move-aside always has a clear target. This is safe: at
    // this point `dest` is the live record, so the stale `.bak` is superseded
    // (the same classification boot recovery makes for a `.bak` alongside a valid
    // `dest`). Best-effort: if the unlink itself fails the rename below will
    // surface the real error.
    await fsp.unlink(bak).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        ignoreBestEffortCleanup(err, {
          operation: 'bugReportOutbox.commitTempOverDest.unlinkStaleBak',
          reason: 'a leftover .bak is superseded while dest is live; clearing it lets the move-aside succeed',
        });
      }
    });

    // Preserve the live copy as `.bak` until the new file + dir entry are
    // durable. A crash anywhere here leaves `dest` (old) or `bak` (old) intact.
    await fsp.rename(dest, bak);
    await fsp.rename(tmp, dest);
    await this.fsyncDir(this.dir);
    await fsp.unlink(bak).catch((err) => {
      // The new file is committed and durable; a leftover `.bak` is harmless
      // (boot recovery treats it as superseded when `dest` is a valid record).
      ignoreBestEffortCleanup(err, {
        operation: 'bugReportOutbox.commitTempOverDest.unlinkBak',
        reason: 'the replacement is durable; removing the backup is best-effort and self-heals on boot',
      });
    });
  }

  /**
   * Best-effort fsync of a directory so its entries are durable. Opening a
   * directory for fsync is unsupported on Windows (EISDIR / EPERM), so we skip
   * it there. Never throws: a dir-fsync failure must not fail an otherwise-
   * successful write.
   */
  private async fsyncDir(dirPath: string): Promise<void> {
    if (process.platform === 'win32') return; // dir fsync unsupported on Windows
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(dirPath, 'r');
      await handle.sync();
    } catch (err) {
      log.warn(
        { err: errMsg(err), dir: dirPath },
        'Best-effort parent-directory fsync failed (record bytes are still durable)',
      );
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (closeErr) {
          ignoreBestEffortCleanup(closeErr, {
            operation: 'bugReportOutbox.fsyncDir.close',
            reason: 'closing the directory handle after a best-effort fsync must never fail the write',
          });
        }
      }
    }
  }

  private async deleteRecord(reportId: string): Promise<void> {
    await fsp.unlink(this.recordPath(reportId)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err: errMsg(err), reportId }, 'Failed to delete bug-report record');
      }
    });
  }

  /**
   * F2 — recover `.bak` files left by a crash during a Windows record replace
   * (`commitTempOverDest`). A `<id>.json.bak` means a replace was interrupted.
   * Recovery rule (a recoverable copy is guaranteed to exist as either the
   * `.json` or the `.bak`):
   *   - If `<id>.json` is present AND a valid record → the replacement
   *     committed; the `.bak` is superseded → delete it.
   *   - Otherwise (`.json` missing or torn/invalid) → the crash happened before
   *     the new file was committed; promote the `.bak` back to `<id>.json`
   *     (it holds the last durable copy).
   * Returns the (possibly mutated) directory listing reflecting the recovery.
   * Best-effort + loudly logged; never throws (recovery failure must not crash
   * the drain).
   */
  private async recoverWindowsBackups(names: string[]): Promise<string[]> {
    const bakNames = names.filter((n) => n.endsWith('.json.bak'));
    if (bakNames.length === 0) return names;

    const resulting = new Set(names);
    for (const bakName of bakNames) {
      const baseName = bakName.slice(0, -'.bak'.length); // `<id>.json`
      const bakPath = path.join(this.dir, bakName);
      const basePath = path.join(this.dir, baseName);

      let baseIsValid = false;
      try {
        const raw = await fsp.readFile(basePath, 'utf8');
        baseIsValid = BugReportRecordSchema.safeParse(JSON.parse(raw)).success;
      } catch {
        baseIsValid = false;
      }

      try {
        if (baseIsValid) {
          // Replacement committed; the backup is stale.
          await fsp.unlink(bakPath);
          log.warn(
            { bakPath, basePath },
            'Removed superseded bug-report .bak (Windows replace committed before crash)',
          );
        } else {
          // Crash before the replacement committed; the .bak holds the last
          // durable copy — promote it back. unlink any torn `.json` first so the
          // rename can land (Windows rename fails if dest exists).
          await fsp.unlink(basePath).catch((err) => {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          });
          await fsp.rename(bakPath, basePath);
          resulting.add(baseName);
          log.warn(
            { bakPath, basePath },
            'Recovered bug-report record from .bak after interrupted Windows replace',
          );
        }
      } catch (err) {
        log.error(
          { err: errMsg(err), bakPath, basePath },
          'Failed to recover bug-report .bak; leaving it on disk for inspection',
        );
      }
      resulting.delete(bakName);
    }
    return [...resulting];
  }

  /**
   * Load and Zod-validate every record in the dir. Unreadable / torn / invalid /
   * wrong-version files are quarantined to `<name>.corrupt.<ts>` (renamed, kept,
   * loud warn) and skipped — the drain never crashes on a bad file.
   * Returned records are ordered oldest-first (by createdAt) for fair draining.
   */
  private async loadAllRecords(): Promise<BugReportRecord[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      log.warn({ err: errMsg(err), dir: this.dir }, 'Failed to read bug-report outbox dir');
      return [];
    }

    // F2: recover any `.bak` left by a crash mid-Windows-replace BEFORE loading,
    // so a stranded backup is promoted back to its `.json` (or cleaned up) and
    // the record is not lost. Mutates `names` to reflect the recovery.
    names = await this.recoverWindowsBackups(names);

    const records: BugReportRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue; // skip .tmp / .corrupt
      const filePath = path.join(this.dir, name);
      let raw: string;
      try {
        raw = await fsp.readFile(filePath, 'utf8');
      } catch (err) {
        log.warn({ err: errMsg(err), filePath }, 'Failed to read bug-report record; skipping');
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        await this.quarantine(filePath, `unparseable JSON: ${errMsg(err)}`);
        continue;
      }

      const result = BugReportRecordSchema.safeParse(parsed);
      if (!result.success) {
        await this.quarantine(filePath, `schema validation failed: ${result.error.message}`);
        continue;
      }
      records.push(result.data);
    }

    records.sort((a, b) => a.createdAt - b.createdAt);
    return records;
  }

  private async quarantine(filePath: string, reason: string): Promise<void> {
    const corruptPath = `${filePath}.corrupt.${this.now()}`;
    try {
      await fsp.rename(filePath, corruptPath);
      log.warn({ filePath, corruptPath, reason }, 'Quarantined corrupt bug-report record (kept for inspection)');
    } catch (err) {
      log.error({ err: errMsg(err), filePath, reason }, 'Failed to quarantine corrupt bug-report record');
    }
  }

  // ---- Scheduling ---------------------------------------------------------

  private backoffForAttempt(attempt: number): number {
    const base = BACKOFF_DELAYS_MS[Math.min(attempt, BACKOFF_DELAYS_MS.length - 1)];
    const jitter = base * BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1); // ±20%
    return Math.max(0, Math.round(base + jitter));
  }

  private scheduleWake(delayMs: number): void {
    if (this.stopping) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.fireDrain('backoff-timer');
    }, Math.max(10, delayMs));
    this.retryTimer.unref?.();
  }

  private async scheduleNextRetryWake(): Promise<void> {
    const records = await this.loadAllRecords();
    const pending = records
      .filter((r) => r.deadLetteredAt === undefined)
      .map((r) => r.nextRetryAt);
    if (pending.length === 0) return;
    const soonest = Math.min(...pending);
    const delay = soonest - this.now();
    if (delay <= 0) {
      // Something became due during this drain; wake soon.
      this.scheduleWake(50);
    } else {
      this.scheduleWake(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Approximate on-disk byte cost of a record (for the total-bytes retention cap). */
function recordByteCost(record: BugReportRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}
