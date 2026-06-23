/**
 * Same-host advisory sync lock for git-safe-sync.
 *
 * Serializes the fetch→merge→validate→push critical section per machine so
 * concurrent local agents queue instead of losing the push race after full
 * validation (measured June 2026: 22% of syncs exited 40 after ~3-4 min of
 * validation; same-host overlap inflated the gate median 140s→182s).
 *
 * Design (see docs/plans/260611_prepush-gate-speedup/PLAN.md Stage 4 +
 * Amendments item 3):
 * - ADVISORY + FAIL-OPEN. Any unexpected error, and max-wait exhaustion,
 *   degrade to today's racy-but-safe behavior with a loud warning. The lock
 *   must never block a sync outright.
 * - Lock file under `~/.cache/rebel-git-safe-sync/` keyed by
 *   sha256(normalized origin URL) — every worktree/clone on the host pushing
 *   to the same remote contends on one file. Home-dir based (NOT os.tmpdir())
 *   because agent sandboxes override TMPDIR, which would silently give two
 *   agents different lock paths. macOS tmp-purge concerns dissolve too.
 * - Staleness = PID-liveness, NOT mtime heartbeat: git-safe-sync blocks its
 *   event loop for minutes inside execSync('git push') (the entire pre-push
 *   gate runs synchronously inside it), so a heartbeat lock (proper-lockfile)
 *   would go falsely stale mid-push and be stolen exactly when protection
 *   matters most. Holder is live iff kill(pid,0) succeeds AND (POSIX)
 *   `ps -p pid -o stat=,command=` shows a non-zombie whose command contains
 *   the recorded cmdToken (covers SIGKILL→ESRCH, zombie→stat Z, PID reuse→
 *   command mismatch; all spike-verified 2026-06-11). On win32 the ps
 *   refinement is unavailable: PID-liveness plus a max-age cap keyed off the
 *   lock file's mtime (a wall-clock cap has known NTP/sleep skew; acceptable
 *   for an advisory lock on a platform the team doesn't run today).
 * - Exclusive create in one `writeFileSync(..., { flag: 'wx' })` API call.
 *   NOTE: that is open(O_CREAT|O_EXCL) + write — two syscalls, NOT atomic —
 *   so a brief empty-file window exists in principle; the unparseable-content
 *   grace rule is the real safety net (held while younger than a short grace,
 *   stale after it). Don't rely on "single-syscall" atomicity here.
 * - Stale takeover is rename-arbitrated AND identity-verified: rename the
 *   stale lock to a unique sidecar (exactly one rename wins; losers loop),
 *   read the sidecar back and compare ownerId/pid against the content that
 *   was judged stale — if a fresh live lock was wx-created in the
 *   evaluate→rename window (TOCTOU), restore it and keep waiting instead of
 *   displacing it. Only an identity-confirmed takeover proceeds to the fresh
 *   `wx` acquire.
 * - Release is ownership-checked: each acquisition gets a UUID ownerId and
 *   release unlinks ONLY if the file still carries it — a slow releaser can
 *   never delete a successor's lock.
 *
 * Known residual race (documented, accepted): if a holder is SIGKILLed while
 * its synchronous `git push` child is still running, the child may complete
 * the push after a waiter takes the lock over — one residual exit-40-style
 * race. Advisory degradation, no corruption. A `ps`-for-live-push "held"
 * heuristic was explicitly rejected (false-held risk).
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const LOCK_CMD_TOKEN = 'git-safe-sync';

const DEFAULT_MAX_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const HOLDER_PRINT_INTERVAL_MS = 15_000;
/** Unparseable/empty lock content younger than this is treated as held (a
 * writer may have crashed mid-create on a non-atomic filesystem); older is
 * stale. */
const UNPARSEABLE_GRACE_MS = 10_000;
/** win32 only: with no `ps` refinement available, a lock older than this is
 * treated as stale regardless of PID liveness (PID reuse would otherwise hold
 * it forever). Keyed off lock-file mtime, not the holder's wall clock. */
const WIN32_MAX_LOCK_AGE_MS = 60 * 60 * 1000;

/** JSON content of the lock file. */
export interface SyncLockInfo {
  ownerId: string;
  pid: number;
  cmdToken: string;
  argv: string[];
  host: string;
  acquiredAt: string; // ISO timestamp, display only — staleness is PID-based
}

export interface SyncLockHandle {
  readonly ownerId: string;
  readonly path: string;
  /** Ownership-checked, idempotent, never throws. */
  release(): void;
}

export type AcquireSyncLockResult =
  | { acquired: true; handle: SyncLockHandle; waitedMs: number; note: string }
  | { acquired: false; reason: 'timeout' | 'error'; waitedMs: number; note: string };

/** Injectable seams for tests. All optional; defaults are the real thing. */
export interface SyncLockDeps {
  /** kill(pid, 0) probe; defaults to process.kill. */
  kill?: (pid: number, signal: number) => unknown;
  /**
   * Returns `ps -p <pid> -o stat=,command=` output, or null when the PID is
   * not listed (process gone). May throw if ps itself is unavailable — that
   * propagates to the acquire-level catch and fails open.
   */
  runPs?: (pid: number) => string | null;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
  /** Random source for the ±10% budget jitter; defaults to Math.random. */
  random?: () => number;
  /**
   * TEST-ONLY seam: runs after a stale verdict, before the takeover rename.
   * Lets tests widen the evaluate→rename TOCTOU window deterministically.
   * Never set in production (the conditional keeps the production takeover
   * path fully synchronous — no await is introduced when unset).
   */
  beforeTakeoverRename?: () => void | Promise<void>;
  /**
   * TEST-ONLY seam: runs after an identity-check mismatch, before the
   * linkSync restore attempt. Lets tests occupy the briefly-vacant lock path
   * deterministically (the restore-collision branch). Same production-purity
   * rule as beforeTakeoverRename.
   */
  beforeRestoreAttempt?: () => void | Promise<void>;
}

function defaultRunPs(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'stat=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // ps exits 1 when the PID is not listed — that is a real "process gone".
    // A spawn failure (ps missing) is genuinely unexpected: rethrow so the
    // acquire-level catch fails open rather than mass-declaring locks stale.
    const e = err as { status?: number | null; code?: string };
    if (typeof e.status === 'number') return null;
    throw err;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Normalizes a git remote URL so trivially-different spellings of the same
 * remote (trailing slash, `.git` suffix, case) key the same lock. All
 * worktrees of one clone share the identical URL anyway; this just widens
 * coverage to hand-configured variants.
 */
export function normalizeOriginUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export function syncLockDir(): string {
  const override = process.env.GIT_SAFE_SYNC_LOCK_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), '.cache', 'rebel-git-safe-sync');
}

export function syncLockPathForOrigin(originUrl: string): string {
  const digest = createHash('sha256').update(normalizeOriginUrl(originUrl)).digest('hex');
  return join(syncLockDir(), `${digest}.lock`);
}

/**
 * Liveness predicate for a recorded lock holder. Exported for unit tests.
 *
 * Live iff:
 * - `kill(pid, 0)` does not throw ESRCH (EPERM still means "exists"), AND
 * - (POSIX) `ps` shows the PID with a stat not starting with 'Z' (zombie) and
 *   a command containing cmdToken (PID-reuse guard).
 * On win32 the ps refinement is skipped (no equivalent cheap probe); the
 * caller compensates with a lock-file max-age cap.
 */
export function isHolderProcessLive(
  info: Pick<SyncLockInfo, 'pid' | 'cmdToken'>,
  deps: SyncLockDeps = {},
): boolean {
  const kill = deps.kill ?? ((pid: number, sig: number) => process.kill(pid, sig));
  const platform = deps.platform ?? process.platform;

  if (!Number.isInteger(info.pid) || info.pid <= 0) return false;
  try {
    kill(info.pid, 0);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ESRCH') return false;
    // EPERM (or anything else): the process exists but we can't signal it.
    // Fall through to the ps refinement.
  }

  if (platform === 'win32') return true; // see WIN32_MAX_LOCK_AGE_MS note

  const runPs = deps.runPs ?? defaultRunPs;
  const psOutput = runPs(info.pid);
  if (psOutput == null) return false; // not listed — gone between probes
  const line = psOutput
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return false;
  const firstSpace = line.search(/\s/);
  const stat = firstSpace === -1 ? line : line.slice(0, firstSpace);
  const command = firstSpace === -1 ? '' : line.slice(firstSpace).trim();
  if (stat.startsWith('Z')) return false; // zombie — SIGKILLed under a stopped parent
  if (!command.includes(info.cmdToken)) return false; // PID reuse
  return true;
}

/**
 * Identity equality for takeover verification: parseable locks match on
 * ownerId+pid; a judged-unparseable lock only matches a still-unparseable
 * one (same junk, not a fresh real lock).
 */
function sameLockIdentity(a: SyncLockInfo | null, b: SyncLockInfo | null): boolean {
  return a !== null && b !== null
    ? a.ownerId === b.ownerId && a.pid === b.pid
    : a === null && b === null;
}

/** Parses lock-file content; null = unparseable/not-a-lock-shape. */
function parseLockInfo(raw: string): SyncLockInfo | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as SyncLockInfo).pid === 'number' &&
      typeof (parsed as SyncLockInfo).cmdToken === 'string'
    ) {
      return parsed as SyncLockInfo;
    }
  } catch {
    // unparseable
  }
  return null;
}

type StalenessVerdict =
  | { verdict: 'held'; info: SyncLockInfo | null; ageMs: number }
  | { verdict: 'stale'; info: SyncLockInfo | null; ageMs: number; why: string }
  | { verdict: 'gone' };

/**
 * Reads the lock file and decides held vs stale. Exported for unit tests.
 * `gone` means the file vanished between probes — caller should retry acquire.
 */
export function evaluateLockStaleness(
  lockPath: string,
  deps: SyncLockDeps = {},
): StalenessVerdict {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lockPath, 'utf8');
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { verdict: 'gone' };
    throw err;
  }
  const ageMs = Math.max(0, Date.now() - mtimeMs); // clamp NTP-step negatives

  const info = parseLockInfo(raw);

  if (!info) {
    return ageMs >= UNPARSEABLE_GRACE_MS
      ? { verdict: 'stale', info: null, ageMs, why: 'unparseable lock content past grace period' }
      : { verdict: 'held', info: null, ageMs };
  }

  const platform = deps.platform ?? process.platform;
  if (!isHolderProcessLive(info, deps)) {
    return { verdict: 'stale', info, ageMs, why: `holder pid ${info.pid} is not a live ${info.cmdToken} process` };
  }
  if (platform === 'win32' && ageMs >= WIN32_MAX_LOCK_AGE_MS) {
    return { verdict: 'stale', info, ageMs, why: 'win32 max-age cap exceeded (no ps refinement available)' };
  }
  return { verdict: 'held', info, ageMs };
}

function makeHandle(ownerId: string, lockPath: string, warn: (msg: string) => void): SyncLockHandle {
  let released = false;
  return {
    ownerId,
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      try {
        const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
        if ((parsed as SyncLockInfo | null)?.ownerId !== ownerId) {
          // A successor (stale takeover after e.g. a long suspend) owns the
          // file now — never delete someone else's lock.
          return;
        }
        unlinkSync(lockPath);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT') return; // already gone — idempotent
        warn(`sync-lock release failed (lock left for staleness reclaim): ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export interface AcquireSyncLockOptions {
  originUrl: string;
  /** argv recorded into the lock file for holder diagnostics. */
  argv?: string[];
  /** Wait budget. Default: GIT_SAFE_SYNC_LOCK_MAX_WAIT_MS env or 20 min. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  /** Status/warning sink (agent/dev-facing CLI lines). Default: stderr. */
  log?: (msg: string) => void;
  deps?: SyncLockDeps;
}

function resolveMaxWaitMs(explicit: number | undefined): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const fromEnv = Number(process.env.GIT_SAFE_SYNC_LOCK_MAX_WAIT_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_MAX_WAIT_MS;
}

/**
 * Acquires the same-host advisory sync lock, waiting (poll ~2s) while a live
 * holder has it. Never throws; never blocks beyond the (jittered) budget.
 */
export async function acquireSameHostSyncLock(
  opts: AcquireSyncLockOptions,
): Promise<AcquireSyncLockResult> {
  const log = opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const deps = opts.deps ?? {};
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // ±10% jitter on the budget so a herd of waiters whose holder dies doesn't
  // fail open in lockstep.
  const budgetMs = resolveMaxWaitMs(opts.maxWaitMs) * (0.9 + random() * 0.2);

  const startedMono = performance.now(); // monotonic — laptop sleep can't eat the budget via wall-clock jumps
  const waited = (): number => Math.round(performance.now() - startedMono);

  try {
    const lockPath = syncLockPathForOrigin(opts.originUrl);
    mkdirSync(syncLockDir(), { recursive: true });

    const ownerId = randomUUID();
    const content = JSON.stringify(
      {
        ownerId,
        pid: process.pid,
        cmdToken: LOCK_CMD_TOKEN,
        argv: opts.argv ?? process.argv.slice(2),
        host: hostname(),
        acquiredAt: new Date().toISOString(),
      } satisfies SyncLockInfo,
      null,
      2,
    );

    let contended = false;
    let takeovers = 0;
    let restoreCollisions = 0;
    let lastHolderPrintMono = -Infinity;
    // Contention/takeover extras for the caller's `lock-wait` span note —
    // `restore collision(s)` here is the telemetry tripwire for the
    // documented takeover residual (see PREPUSH_GATE_AND_RECEIPTS.md).
    const noteExtras = (): string =>
      `${takeovers > 0 ? `; ${takeovers} stale takeover(s)` : ''}${restoreCollisions > 0 ? `; ${restoreCollisions} restore collision(s)` : ''}`;

    while (true) {
      try {
        writeFileSync(lockPath, content, { flag: 'wx' });
        const detail = contended ? `waited ${waited()}ms behind a holder${noteExtras()}` : 'uncontended';
        return {
          acquired: true,
          handle: makeHandle(ownerId, lockPath, log),
          waitedMs: waited(),
          note: detail,
        };
      } catch (err) {
        if ((err as { code?: string }).code !== 'EEXIST') throw err;
      }

      // Budget check sits right after a failed acquire attempt so that (a) a
      // rename winner always gets its fresh wx try, and (b) pathological
      // gone/stale flapping can't spin past the budget without sleeping.
      if (waited() >= budgetMs) {
        return {
          acquired: false,
          reason: 'timeout',
          waitedMs: waited(),
          note: `lock wait budget exhausted after ${waited()}ms — proceeding unserialized${noteExtras()}`,
        };
      }

      // Lock exists — held or stale?
      const verdict = evaluateLockStaleness(lockPath, deps);
      if (verdict.verdict === 'gone') continue; // released between probes — retry immediately

      if (verdict.verdict === 'stale') {
        const holderPid = verdict.info?.pid ?? '<unknown>';
        log(
          `sync-lock: previous holder (pid ${holderPid}) is gone (${verdict.why}); taking over. ` +
            `If it was killed mid-push its git-push child may still be in flight — a lost-race exit 40 remains possible.`,
        );
        log(`  lock file: ${lockPath}`);
        const judged = verdict.info;
        // Pre-rename identity recheck (displacement avoidance): the stale
        // verdict is already milliseconds old (liveness probes shell out to
        // `ps`; the takeover log writes to a pipe). If another waiter
        // completed takeover and a fresh winner wx-created in that gap,
        // skip the rename entirely instead of displacing a live lock.
        // Re-anchoring here shrinks the displacement window from
        // verdict-age (ms) to read→rename (µs); the post-rename sidecar
        // verification below remains the correctness backstop for that
        // residual window.
        let preRaw: string | null = null;
        try {
          preRaw = readFileSync(lockPath, 'utf8');
        } catch {
          continue; // gone between probes — retry acquire
        }
        if (!sameLockIdentity(judged, parseLockInfo(preRaw))) continue; // changed under us — re-evaluate
        if (deps.beforeTakeoverRename) await deps.beforeTakeoverRename(); // test-only seam
        const sidecar = `${lockPath}.stale-${randomUUID()}`;
        let renamed = false;
        try {
          renameSync(lockPath, sidecar); // exactly one concurrent waiter wins this
          renamed = true;
        } catch {
          // Lost the rename race (or holder released) — loop and re-probe.
        }
        if (renamed) {
          contended = true;
          // Identity-verify the takeover (TOCTOU guard): between our stale
          // verdict and the rename, another waiter may have completed its
          // takeover and a fresh winner may have wx-created a LIVE lock at
          // this path — rename arbitration only protects against concurrent
          // renamers, not against this evaluate→rename window. Confirm the
          // file we renamed away is the one we judged stale; if not, we just
          // displaced a live newcomer and must put it back.
          let sidecarRaw: string | null = null;
          try {
            sidecarRaw = readFileSync(sidecar, 'utf8');
          } catch {
            // Unverifiable read — treat as mismatch (restore is the safe direction).
          }
          const sidecarInfo = sidecarRaw === null ? null : parseLockInfo(sidecarRaw);
          const sameIdentity = sidecarRaw !== null && sameLockIdentity(judged, sidecarInfo);
          if (sameIdentity) {
            takeovers += 1;
            try {
              unlinkSync(sidecar);
            } catch {
              // best-effort litter cleanup; a leftover sidecar is inert
            }
          } else {
            // Restore FIRST, log after — every instruction between the rename
            // and the restore widens the vacancy window in which a third
            // waiter's wx can land (round-2 review measured production-like
            // pipe logging widening it enough to double-hold 2/30).
            //
            // linkSync is the load-bearing choice: link(2) fails EEXIST when
            // the destination exists, unlike rename(2) which SILENTLY REPLACES
            // it — a renameSync restore here clobbered a third waiter's fresh
            // live lock and made the collision branch dead code (round-2
            // review, probe-proven). With the hard link, a collision is
            // genuinely detected instead of silently created.
            if (deps.beforeRestoreAttempt) await deps.beforeRestoreAttempt(); // test-only seam
            let restored = false;
            let restoreFailureCode: string | null = null;
            try {
              linkSync(sidecar, lockPath); // no-clobber restore of the displaced live lock
              restored = true;
            } catch (err) {
              restoreFailureCode = (err as { code?: string }).code ?? 'unknown';
            }
            try {
              unlinkSync(sidecar); // restored via hard link, or unreferenced on failure
            } catch {
              // best-effort litter cleanup
            }
            if (restored) {
              log(
                `sync-lock: takeover identity check failed — a fresh live lock (pid ${sidecarInfo?.pid ?? '<unparseable>'}) ` +
                  'appeared in the evaluate→rename window; restored it and continuing to wait.',
              );
            } else if (restoreFailureCode === 'EEXIST') {
              // A third waiter wx-created while the path was briefly vacant.
              // The displaced holder (the sidecar's content) now runs
              // unserialized for this sync — advisory degradation, bounded.
              restoreCollisions += 1;
              log(
                `sync-lock: RESTORE COLLIDED — a live lock (pid ${sidecarInfo?.pid ?? '<unparseable>'}) was briefly ` +
                  'displaced and another waiter claimed the path; the displaced holder proceeds unserialized (advisory degradation).',
              );
            } else {
              // link(2) itself failed (e.g. a filesystem without hard-link
              // support — NFS-mounted home). Same advisory degradation as a
              // collision, but worded distinctly so transcripts on exotic
              // filesystems don't misreport collisions (round-4 reviewer F3).
              log(
                `sync-lock: could not restore displaced lock (${restoreFailureCode}) — hard links may be unsupported ` +
                  `on this filesystem; the displaced holder (pid ${sidecarInfo?.pid ?? '<unparseable>'}) proceeds unserialized (advisory degradation).`,
              );
            }
            // Fall through to continue: next iteration sees the live lock as
            // held and waits (or times out on budget).
          }
        }
        continue; // fresh wx attempt (confirmed takeover) or re-probe/wait
      }

      // Held by a live process.
      contended = true;
      const nowMono = performance.now();
      if (nowMono - lastHolderPrintMono >= HOLDER_PRINT_INTERVAL_MS) {
        lastHolderPrintMono = nowMono;
        const holder = verdict.info;
        const ageSec = Math.round(verdict.ageMs / 1000);
        const holderDesc = holder
          ? `pid ${holder.pid} (${LOCK_CMD_TOKEN} ${holder.argv.join(' ')})`
          : 'unknown holder (lock content unreadable)';
        log(
          `sync-lock: waiting for ${holderDesc}, lock age ${ageSec}s — another sync on this machine is in its fetch→push window.`,
        );
        log(`  lock file: ${lockPath}`);
        if (holder) {
          log(`  if this is wrong: kill ${holder.pid} or delete the file / use --no-lock`);
        } else {
          log('  if this is wrong: delete the file / use --no-lock');
        }
      }

      if (waited() >= budgetMs) {
        return {
          acquired: false,
          reason: 'timeout',
          waitedMs: waited(),
          note: `lock wait budget exhausted after ${waited()}ms (holder still live) — proceeding unserialized${noteExtras()}`,
        };
      }
      await sleep(pollIntervalMs);
    }
  } catch (err) {
    // The lock is a convenience layer — never let it block a sync.
    const msg = err instanceof Error ? err.message : String(err);
    log(`sync-lock: unexpected error (${msg}) — proceeding without lock`);
    return { acquired: false, reason: 'error', waitedMs: waited(), note: `lock module error: ${msg}` };
  }
}

/**
 * Installs SIGINT/SIGTERM handlers SCOPED to the async lock-wait phase.
 * Returns an uninstall function (idempotent) that restores the default
 * kill-the-process disposition.
 *
 * IMPORTANT — why scoped, not process-lifetime: Node cannot run JS signal
 * handlers while blocked inside execSync/spawnSync, and merely INSTALLING a
 * handler replaces the default disposition — so a process-lifetime handler
 * silently SWALLOWS a SIGTERM/Ctrl-C delivered during a synchronous child
 * section (e.g. the minutes-long `git push` gate), leaving the process alive.
 * The handlers' entire value (a killed waiter releases its lock and leaves a
 * timing log) lives in the async wait loop, where handlers CAN run. Callers
 * must uninstall before any synchronous child work begins; after uninstall,
 * mid-sync kills die immediately (today's behavior) and an orphaned lock is
 * reclaimed by the staleness predicate within ~one poll interval.
 *
 * Edge (round-2 review F3): a signal DELIVERED in the sub-ms window between
 * the acquire resolving and the uninstall is swallowed ONCE — Node has
 * already caught it at the OS level and dispatches the JS callback on a
 * later tick, by which time `process.off` has dropped it; it is NOT
 * re-raised under the restored default disposition. One-shot, sub-ms; the
 * next signal kills normally.
 */
export function installLockWaitSignalHandlers(
  onSignal: (signal: 'SIGINT' | 'SIGTERM', exitCode: 130 | 143) => void,
): () => void {
  const onSigint = (): void => onSignal('SIGINT', 130);
  const onSigterm = (): void => onSignal('SIGTERM', 143);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let removed = false;
  return (): void => {
    if (removed) return;
    removed = true;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}
