/**
 * Space Maintenance Lease
 *
 * Best-effort multi-desktop coordination for the `runDailyMaintenance`
 * pipeline. When two (or more) desktops are synced to the same Google
 * Drive Shared Drive they will each fire the 06:00 local space-maintenance
 * automation; without coordination both desktops end up running LLM merges
 * on the same `.conflict-cloud` files at roughly the same time. This
 * reduces double-merge probability, but it is NOT a hard lock:
 *
 *   - Drive sync is eventually consistent — the lease file may appear/
 *     disappear in non-obvious orders. That's acceptable because the
 *     atomic-write + retry-backoff layers in Stages 1-4 already handle
 *     any residual concurrent-merge safety.
 *   - The TTL (10 min) guarantees an abandoned lease from a crashed desktop
 *     is automatically overridable on the next scheduled run.
 *
 * Why a dotfile INSIDE the shared space? Per the plan (§Stage 1 principle
 * #8 "no new .rebel/ subtrees"), there's an explicit exception for this
 * ephemeral lock file: (a) it's not a growing history tree — there's at
 * most one file, ≤300 bytes, with a 10-minute TTL — and (b) it MUST live
 * in the shared space so other desktops can see it.
 *
 * Why the `.json` extension? The conflict-detection regex in
 * `@shared/conflictPatterns` matches `*.conflict-cloud.<ext>`. If the
 * lock file's own `.conflict-cloud` artifact shows up after a sync race
 * (e.g. `.rebel-maintenance.lock.json.conflict-cloud`), the existing
 * pattern catalog already handles it — no special case needed.
 *
 * Core-only: this module uses `node:os` and `process.pid` from Node, but
 * NOT `electron` (verified via `rg "from 'electron'" src/core/`). Tests
 * inject a custom `fs`, `now`, `hostname`, and `pid` to avoid touching
 * the host machine.
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 5)
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'spaceMaintenanceLease' });

/** Current lease-content schema version. Unknown versions trigger safe-skip. */
export const LEASE_SCHEMA_VERSION = 1 as const;

/**
 * Lease TTL. Long enough that a normal daily run completes inside the
 * window, short enough that a crashed desktop's stale lease doesn't block
 * a second desktop for a full day.
 */
export const LEASE_TTL_MS = 10 * 60 * 1000;

/**
 * Filename inside the shared space. The `.json` suffix is deliberate —
 * when the Drive provider generates a conflict copy of the lease itself
 * (`.rebel-maintenance.lock.json.conflict-cloud`), the existing
 * `@shared/conflictPatterns` regex already matches it. See module doc
 * comment for the rationale on dotfile placement.
 */
export const LEASE_FILE_NAME = '.rebel-maintenance.lock.json';

/**
 * On-disk lease payload. `schemaVersion` is the first field (by
 * JSON.stringify key order is insertion order) so a reader that only
 * peeks at the first few bytes can still detect a future incompatible
 * version and bail safely.
 */
export interface LeaseContent {
  schemaVersion: typeof LEASE_SCHEMA_VERSION;
  hostname: string;
  pid: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface Lease {
  /** Absolute path to the on-disk lease file. */
  leasePath: string;
  /** Contents we wrote (used on release to verify we still own it). */
  content: LeaseContent;
}

/**
 * Structured outcome of `acquireLease`. `acquired === false` is not an
 * error — callers use it to take the clean-skip code path.
 */
export type AcquireLeaseResult =
  | { acquired: true; lease: Lease }
  | {
      acquired: false;
      reason: 'held-by-other' | 'unknown-schema';
      /**
       * Best-effort snapshot of the current holder. Populated when the
       * existing file parsed cleanly. Undefined when the file was
       * corrupt or had an unknown schema.
       */
      holder?: { hostname?: string; pid?: number; expiresAt?: number };
      leasePath: string;
    };

/**
 * Platform-agnostic fs ops the lease needs. Tests inject their own
 * implementation to avoid racing the real filesystem and to exercise
 * edge cases (mid-flight writes, permission errors) deterministically.
 */
export interface LeaseFs {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string, options?: { flag?: string }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
}

const defaultFs: LeaseFs = {
  readFile: (p) => fs.readFile(p, 'utf8'),
  writeFile: (p, d, options) => fs.writeFile(p, d, { encoding: 'utf8', ...options }),
  rename: (from, to) => fs.rename(from, to),
  unlink: (p) => fs.unlink(p),
  mkdir: (p, opts) => fs.mkdir(p, opts).then(() => undefined),
};

export interface AcquireLeaseOptions {
  fs?: LeaseFs;
  now?: () => number;
  /** Hostname override — defaults to `os.hostname()`. */
  hostname?: () => string;
  /** PID override — defaults to `process.pid`. */
  pid?: () => number;
  /** TTL override for tests. Defaults to {@link LEASE_TTL_MS}. */
  ttlMs?: number;
}

export interface ReleaseLeaseOptions {
  fs?: LeaseFs;
}

/**
 * Attempt to acquire the lease for the given shared-space directory.
 *
 * Semantics:
 *   - No file OR existing `expiresAt < now` → write our own lease with
 *     an exclusive create (`flag: 'wx'`). Returns `{ acquired: true }`.
 *   - File exists, unexpired, hostname + pid match ours → treat as
 *     reacquire (refresh `acquiredAt` / `expiresAt`). Returns
 *     `{ acquired: true }`.
 *   - File exists, unexpired, other hostname/pid → `{ acquired: false,
 *     reason: 'held-by-other' }`.
 *   - File exists with unknown `schemaVersion` → `{ acquired: false,
 *     reason: 'unknown-schema' }` (safe-skip: never clobber forward-
 *     compat data; behave as if held by another desktop).
 *
 * Never throws on routine contention. Only surfaces errors via a thrown
 * rejection when the host filesystem itself can't be used
 * (`mkdir`/`writeFile`/`rename` all fail). Callers of `runDailyMaintenance`
 * catch that and record as a pushError — they don't let it crash the run.
 */
export async function acquireLease(
  spacePath: string,
  options: AcquireLeaseOptions = {},
): Promise<AcquireLeaseResult> {
  const fsOps = options.fs ?? defaultFs;
  const now = options.now ?? Date.now;
  const hostnameFn = options.hostname ?? os.hostname;
  const pidFn = options.pid ?? (() => process.pid);
  const ttlMs = options.ttlMs ?? LEASE_TTL_MS;

  const leasePath = path.join(spacePath, LEASE_FILE_NAME);
  const hostname = hostnameFn();
  const pid = pidFn();
  const nowMs = now();

  // Read the existing lease (if any). Malformed / missing → treat as
  // "no active lease" and proceed to write one. Unknown schema → we
  // MUST NOT overwrite; that's the forward-compat safe-skip contract.
  const initialRead = await readLeaseRecord(fsOps, leasePath);
  let existing = initialRead.kind === 'present' ? initialRead.record : null;

  if (existing) {
    if (existing.schemaVersion !== LEASE_SCHEMA_VERSION) {
      log.warn(
        { leasePath, foundVersion: existing.schemaVersion, expectedVersion: LEASE_SCHEMA_VERSION },
        'Lease has unknown schemaVersion; treating as held-by-other (safe-skip)',
      );
      return {
        acquired: false,
        reason: 'unknown-schema',
        leasePath,
      };
    }

    const hostnameStr = typeof existing.hostname === 'string' ? existing.hostname : undefined;
    const pidNum = typeof existing.pid === 'number' ? existing.pid : undefined;
    const expiresAt = typeof existing.expiresAt === 'number' ? existing.expiresAt : 0;
    const isExpired = expiresAt < nowMs;
    const isOurs = hostnameStr === hostname && pidNum === pid;

    if (!isExpired && !isOurs) {
      log.info(
        { leasePath, holderHost: hostnameStr, holderPid: pidNum, expiresAt, nowMs },
        'Lease already held by another desktop/process; skipping run',
      );
      return {
        acquired: false,
        reason: 'held-by-other',
        holder: { hostname: hostnameStr, pid: pidNum, expiresAt },
        leasePath,
      };
    }

    // Either the lease expired OR we already hold it (reacquire path).
    // Fall through to writing a fresh lease below — identical code for
    // both cases since we're authoring new acquiredAt/expiresAt values.
  }

  const content: LeaseContent = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    hostname,
    pid,
    acquiredAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };

  await fsOps.mkdir(path.dirname(leasePath), { recursive: true });

  if (!existing) {
    // First-acquire path: use exclusive create so two contenders that both
    // observed "no lease" cannot both acquire. Exactly one write wins; the
    // loser gets EEXIST and reclassifies as held-by-other.
    try {
      await fsOps.writeFile(leasePath, JSON.stringify(content, null, 2), { flag: 'wx' });
      log.debug(
        { leasePath, hostname, pid, expiresAt: content.expiresAt },
        'Acquired space-maintenance lease (exclusive create)',
      );
      return {
        acquired: true,
        lease: { leasePath, content },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw err;
      }

      const raced = await readLeaseRecord(fsOps, leasePath);
      if (raced.kind === 'missing') {
        return {
          acquired: false,
          reason: 'held-by-other',
          leasePath,
        };
      } else if (raced.kind === 'invalid') {
        // If we ALREADY observed invalid JSON before the exclusive create
        // attempt, treat this as a pre-existing corrupt lease and proceed
        // to overwrite via the refresh path below. Otherwise fail closed:
        // this is most likely a raced holder we couldn't parse yet.
        if (initialRead.kind === 'invalid') {
          existing = { schemaVersion: LEASE_SCHEMA_VERSION };
        } else {
          return {
            acquired: false,
            reason: 'held-by-other',
            leasePath,
          };
        }
      } else if (raced.record.schemaVersion !== LEASE_SCHEMA_VERSION) {
        return {
          acquired: false,
          reason: 'unknown-schema',
          leasePath,
        };
      } else {
        const racedHost = typeof raced.record.hostname === 'string' ? raced.record.hostname : undefined;
        const racedPid = typeof raced.record.pid === 'number' ? raced.record.pid : undefined;
        const racedAcquiredAt = typeof raced.record.acquiredAt === 'number' ? raced.record.acquiredAt : 0;
        const racedExpiresAt = typeof raced.record.expiresAt === 'number' ? raced.record.expiresAt : 0;
        const isExpired = racedExpiresAt < nowMs;
        const isOurs = racedHost === hostname && racedPid === pid;

        if (isOurs && !isExpired) {
          return {
            acquired: true,
            lease: {
              leasePath,
              content: {
                schemaVersion: LEASE_SCHEMA_VERSION,
                hostname,
                pid,
                acquiredAt: racedAcquiredAt,
                expiresAt: racedExpiresAt,
              },
            },
          };
        }

        if (!isExpired) {
          return {
            acquired: false,
            reason: 'held-by-other',
            holder: { hostname: racedHost, pid: racedPid, expiresAt: racedExpiresAt },
            leasePath,
          };
        }

        // Expired raced lease: fall through to overwrite path below.
        existing = raced.record;
      }
    }
  }

  // Refresh / expired-takeover path. To preserve "at most one winner"
  // semantics we remove the stale lease (best-effort) and then perform
  // another exclusive create. This prevents two contenders from both
  // returning acquired:true when they race to refresh/replace.
  try {
    await fsOps.unlink(leasePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  try {
    await fsOps.writeFile(leasePath, JSON.stringify(content, null, 2), { flag: 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw err;
    }

    const raced = await readLeaseRecord(fsOps, leasePath);
    if (raced.kind === 'missing' || raced.kind === 'invalid') {
      return {
        acquired: false,
        reason: 'held-by-other',
        leasePath,
      };
    }
    if (raced.record.schemaVersion !== LEASE_SCHEMA_VERSION) {
      return {
        acquired: false,
        reason: 'unknown-schema',
        leasePath,
      };
    }

    const racedHost = typeof raced.record.hostname === 'string' ? raced.record.hostname : undefined;
    const racedPid = typeof raced.record.pid === 'number' ? raced.record.pid : undefined;
    const racedAcquiredAt = typeof raced.record.acquiredAt === 'number'
      ? raced.record.acquiredAt
      : 0;
    const racedExpiresAt = typeof raced.record.expiresAt === 'number' ? raced.record.expiresAt : 0;
    const isOurs = racedHost === hostname && racedPid === pid;
    if (isOurs && racedExpiresAt >= nowMs) {
      return {
        acquired: true,
        lease: {
          leasePath,
          content: {
            schemaVersion: LEASE_SCHEMA_VERSION,
            hostname,
            pid,
            acquiredAt: racedAcquiredAt,
            expiresAt: racedExpiresAt,
          },
        },
      };
    }

    return {
      acquired: false,
      reason: 'held-by-other',
      holder: { hostname: racedHost, pid: racedPid, expiresAt: racedExpiresAt },
      leasePath,
    };
  }

  log.debug(
    { leasePath, hostname, pid, expiresAt: content.expiresAt },
    'Acquired space-maintenance lease',
  );

  return {
    acquired: true,
    lease: { leasePath, content },
  };
}

/**
 * Release a lease we previously acquired.
 *
 * Only deletes the file if its current on-disk contents match what we
 * wrote (hostname + pid + acquiredAt). If another desktop has since
 * taken over the lease (our own TTL expired before we finished the run),
 * this is a no-op — we must NOT clobber their ownership.
 *
 * Release failures are logged at warn level but do NOT throw. The lease
 * will naturally expire in {@link LEASE_TTL_MS} regardless, so a
 * transient release failure is self-healing.
 */
export async function releaseLease(
  lease: Lease,
  options: ReleaseLeaseOptions = {},
): Promise<void> {
  const fsOps = options.fs ?? defaultFs;

  let raw: string;
  try {
    raw = await fsOps.readFile(lease.leasePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Someone already removed the file (could be another desktop whose
      // OS reaped an expired lease) — nothing to release.
      log.debug({ leasePath: lease.leasePath }, 'Lease file already gone on release');
      return;
    }
    log.warn(
      { leasePath: lease.leasePath, err: toErrMsg(err) },
      'Failed to read lease file during release; will let it expire naturally',
    );
    return;
  }

  let current: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    log.warn(
      { leasePath: lease.leasePath },
      'Lease file is not valid JSON on release; leaving alone',
    );
    return;
  }

  if (!current) return;

  // Match on the full identifying tuple we wrote — hostname + pid +
  // acquiredAt. acquiredAt is the tiebreaker for the same-process
  // reacquire case (if we reacquired, `lease.content.acquiredAt` is
  // the latest value; if someone else now owns the file, their
  // acquiredAt will differ).
  const sameHolder =
    current.hostname === lease.content.hostname
    && current.pid === lease.content.pid
    && current.acquiredAt === lease.content.acquiredAt;

  if (!sameHolder) {
    log.info(
      {
        leasePath: lease.leasePath,
        ours: {
          hostname: lease.content.hostname,
          pid: lease.content.pid,
          acquiredAt: lease.content.acquiredAt,
        },
        current: {
          hostname: current.hostname,
          pid: current.pid,
          acquiredAt: current.acquiredAt,
        },
      },
      'Lease ownership changed before release; leaving current holder intact',
    );
    return;
  }

  try {
    await fsOps.unlink(lease.leasePath);
    log.debug({ leasePath: lease.leasePath }, 'Released space-maintenance lease');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    log.warn(
      { leasePath: lease.leasePath, err: toErrMsg(err) },
      'Failed to unlink lease file on release; will expire naturally',
    );
  }
}

function toErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type LeaseReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'present'; record: Record<string, unknown> };

async function readLeaseRecord(
  fsOps: LeaseFs,
  leasePath: string,
): Promise<LeaseReadResult> {
  try {
    const raw = await fsOps.readFile(leasePath);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return { kind: 'present', record: parsed as Record<string, unknown> };
      }
      return { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { kind: 'missing' };
    }
    if (code !== 'ENOENT') {
      log.debug({ leasePath, err: toErrMsg(err) }, 'Failed to read existing lease file');
    }
    return { kind: 'missing' };
  }
}
