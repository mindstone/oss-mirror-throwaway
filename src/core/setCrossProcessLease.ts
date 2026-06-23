/**
 * Cross-process lease primitive.
 *
 * Ownership identity is **opaque** at the interface boundary (rec from
 * postmortem 260529_token_coordinator_lease_release_accountkey_leak): the
 * `LeaseHandle` no longer surfaces `pid` / `epochMs` / `nonce` as separate
 * inspectable fields. Instead it carries a single branded
 * `LeaseOwnerIdentity`, and `release`/stale-reclaim code must prove ownership
 * by comparing that opaque identity (`ownerIdentityEquals`) — they
 * structurally cannot operate on `scope` alone. The constituent fields are
 * only reachable via `describeLeaseOwner`, which exists for serialization to
 * the on-disk lock payload and for diagnostic logging, never for control
 * flow that decides who may release a lock.
 */

/** Raw owner-identity components. Internal to lease implementations. */
export interface LeaseOwnerParts {
  readonly pid: number;
  readonly epochMs: number;
  readonly nonce?: string;
}

declare const leaseOwnerIdentityBrand: unique symbol;

/**
 * Opaque, unforgeable ownership identity for a lease. Construct only via
 * {@link mintLeaseOwnerIdentity} (fresh acquire) or
 * {@link parseLeaseOwnerIdentity} (reconstruct from a persisted payload).
 * Compare with {@link ownerIdentityEquals}; never destructure for control
 * flow.
 */
export type LeaseOwnerIdentity = string & {
  readonly [leaseOwnerIdentityBrand]: 'LeaseOwnerIdentity';
};

// A printable, collision-safe field separator. The encoded fields are a
// decimal pid, a decimal epochMs, and a nonce that is either lowercase hex
// (real impls) or `inproc-<n>` (the in-process fallback) -- none of those
// alphabets contain a pipe, so the join is unambiguous and the source stays
// plain text (an earlier control-char separator made Git treat this file as
// binary, hiding it from diff/grep/review).
const OWNER_FIELD_SEPARATOR = '|';

function encodeOwner(parts: LeaseOwnerParts): LeaseOwnerIdentity {
  // The nonce (when present) is the high-entropy discriminator; pid/epochMs
  // disambiguate same-process re-acquires. Encoding all three keeps the
  // identity comparison total without re-exposing the fields as a structural
  // shape callers can pattern-match on.
  const nonce = parts.nonce ?? '';
  return `${parts.pid}${OWNER_FIELD_SEPARATOR}${parts.epochMs}${OWNER_FIELD_SEPARATOR}${nonce}` as LeaseOwnerIdentity;
}

/** Mint an opaque ownership identity for a freshly-acquired lease. */
export function mintLeaseOwnerIdentity(parts: LeaseOwnerParts): LeaseOwnerIdentity {
  return encodeOwner(parts);
}

/**
 * Reconstruct an opaque ownership identity from a persisted lock payload.
 * Same encoding as {@link mintLeaseOwnerIdentity} so a handle minted on
 * acquire compares equal to the identity read back from disk.
 */
export function parseLeaseOwnerIdentity(parts: LeaseOwnerParts): LeaseOwnerIdentity {
  return encodeOwner(parts);
}

/** Total equality over opaque identities. The only ownership check callers may use. */
export function ownerIdentityEquals(a: LeaseOwnerIdentity, b: LeaseOwnerIdentity): boolean {
  return a === b;
}

/**
 * Decode an opaque identity back into its components. Restricted to
 * serialization (writing the on-disk payload) and diagnostic logging — do not
 * use the result to decide who may release/reclaim a lock.
 */
export function describeLeaseOwner(identity: LeaseOwnerIdentity): LeaseOwnerParts {
  const [pidRaw = '', epochRaw = '', nonceRaw = ''] = identity.split(OWNER_FIELD_SEPARATOR);
  return {
    pid: Number(pidRaw),
    epochMs: Number(epochRaw),
    nonce: nonceRaw.length > 0 ? nonceRaw : undefined,
  };
}

export interface LeaseHandle {
  readonly scope: string;
  readonly acquiredAtMs: number;
  readonly ttlMs: number;
  /** Opaque ownership identity; compare with {@link ownerIdentityEquals}. */
  readonly owner: LeaseOwnerIdentity;
}

export interface CrossProcessLease {
  acquire(scope: string, ttlMs: number): Promise<LeaseHandle | null>;
  release(handle: LeaseHandle): Promise<void>;
  whoHolds(scope: string): Promise<{ pid: number; epochMs: number } | null>;
}

const inProcessLeases = new Map<string, LeaseHandle>();
let hasWarnedInProcessFallback = false;
let inProcessNonceCounter = 0;

function getCurrentPid(): number {
  return typeof process !== 'undefined' && typeof process.pid === 'number' ? process.pid : -1;
}

function isLeaseExpired(handle: LeaseHandle, nowMs: number): boolean {
  return nowMs >= handle.acquiredAtMs + handle.ttlMs;
}

function warnInProcessFallbackOnce(scope: string, ttlMs: number): void {
  if (hasWarnedInProcessFallback) return;
  hasWarnedInProcessFallback = true;
  console.warn(
    {
      event: 'cross-process-lease-unwired-fallback',
      scope,
      ttlMs,
      fallback: 'in-process-map',
    },
    'CrossProcessLease not wired; using in-process fallback',
  );
}

export const NULL_CROSS_PROCESS_LEASE: CrossProcessLease = {
  acquire: async (scope, ttlMs) => {
    warnInProcessFallbackOnce(scope, ttlMs);
    const nowMs = Date.now();
    const existing = inProcessLeases.get(scope);
    if (existing && !isLeaseExpired(existing, nowMs)) {
      return null;
    }

    const handle: LeaseHandle = {
      scope,
      acquiredAtMs: nowMs,
      ttlMs,
      owner: mintLeaseOwnerIdentity({
        pid: getCurrentPid(),
        epochMs: nowMs,
        nonce: `inproc-${++inProcessNonceCounter}`,
      }),
    };
    inProcessLeases.set(scope, handle);
    return handle;
  },
  release: async (handle) => {
    const current = inProcessLeases.get(handle.scope);
    if (!current) return;

    if (current === handle || ownerIdentityEquals(current.owner, handle.owner)) {
      inProcessLeases.delete(handle.scope);
    }
  },
  whoHolds: async (scope) => {
    const current = inProcessLeases.get(scope);
    if (!current) return null;

    const nowMs = Date.now();
    if (isLeaseExpired(current, nowMs)) {
      inProcessLeases.delete(scope);
      return null;
    }

    const owner = describeLeaseOwner(current.owner);
    return { pid: owner.pid, epochMs: owner.epochMs };
  },
};

let _crossProcessLease: CrossProcessLease = NULL_CROSS_PROCESS_LEASE;

export function setCrossProcessLease(lease: CrossProcessLease): void {
  _crossProcessLease = lease;
}

export function getCrossProcessLease(): CrossProcessLease {
  return _crossProcessLease;
}
