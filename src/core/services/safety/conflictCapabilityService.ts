/**
 * Conflict-resolution capability token service.
 *
 * Stage B of `docs/plans/260417_approval_consolidation_closeout.md` closes
 * the HIGH-severity finding from the Stage 6 security reviewer: a
 * jailbroken agent could call `memory:staging-resolve-conflict` directly
 * and bypass the "ask the user first" instruction that only exists in the
 * seed prompt. The prompt-level deny-list + allowlist is still the
 * first line of defense, but this module adds a hard server-side gate.
 *
 * Design goals:
 *   1. **Short-lived.** Five-minute TTL (see {@link DEFAULT_TOKEN_TTL_MS}).
 *      Stale tokens are rejected with `EXPIRED`.
 *   2. **Scoped.** A token minted for file `A` cannot be used to resolve
 *      a conflict on file `B`. Rejected with `SCOPE_MISMATCH`.
 *   3. **One-time-use.** Each mint returns a token with a 128-bit nonce;
 *      successful validation records the nonce in a per-process seen-map.
 *      A second validate with the same token is rejected with `REUSED`.
 *   4. **Stateless signing.** Tokens are HMAC-SHA256 signed with a
 *      per-process secret, so the only state the service keeps is the
 *      `seen-map` for replay protection — no persistence required.
 *   5. **Fail-closed.** Any parse, encoding, or signature error returns
 *      a specific error code rather than falling through to "ok".
 *   6. **Zero Electron imports.** Lives in `src/core/` so both the
 *      Electron main process and the cloud service can instantiate one
 *      service instance at startup (each with its own secret) and wire
 *      it into the IPC handler.
 *
 * Threat model — what this defends against:
 *   - Jailbroken agent that somehow decides to call
 *     `memory:staging-resolve-conflict` without going through the
 *     conversational seed prompt → no valid token → handler rejects.
 *   - Replay of an earlier token captured from a prior session → nonce
 *     already consumed → `REUSED`.
 *   - Cross-file replay of a token minted for one conflict applied to a
 *     different staged file → `SCOPE_MISMATCH`.
 *   - Stale tokens discovered long after mint → `EXPIRED`.
 *
 * Out of scope (intentionally):
 *   - Revocation / user-initiated invalidation. Token TTL is short enough
 *     that a per-file revoke API would be more attack surface than value.
 *   - Durable nonce storage across process restart. Nonces live in-memory
 *     only; a process restart means all minted-but-unused tokens become
 *     unusable (re-mint), but the legitimate UI flow remints on the next
 *     user action anyway.
 *   - Sharing a secret across multiple desktop/cloud processes. Each
 *     process mints + validates its own tokens; tokens do not need to
 *     cross process boundaries.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Payload embedded inside a capability token. */
export interface ConflictCapabilityPayload {
  stagedFileId: string;
  /** Cryptographically-random nonce (32 hex chars / 128 bits) — prevents replay. */
  nonce: string;
  /** Unix ms expiry. */
  exp: number;
}

/**
 * Well-known failure codes emitted by {@link ConflictCapabilityService.validate}.
 * Surfaced on the IPC response as `'CAPABILITY_' + code` so desktop / mobile
 * UIs can classify and re-mint on specific errors.
 */
export type ConflictCapabilityFailureCode =
  | 'MALFORMED'
  | 'INVALID_SIGNATURE'
  | 'EXPIRED'
  | 'SCOPE_MISMATCH'
  | 'REUSED';

export type ConflictCapabilityValidationResult =
  | { ok: true; payload: ConflictCapabilityPayload }
  | { ok: false; code: ConflictCapabilityFailureCode };

export interface ConflictCapabilityService {
  /**
   * Mint a new token authorizing resolution of exactly one conflict on
   * `stagedFileId`. The returned token is a stateless,
   * HMAC-SHA256-signed string of the form `<payload>.<sig>` where both
   * halves are base64url-encoded.
   *
   * @throws RangeError when `stagedFileId` is empty or longer than
   *         {@link MAX_STAGED_FILE_ID_LENGTH}. The IPC schema already
   *         enforces these bounds; the service throws as
   *         defense-in-depth.
   */
  mint(input: { stagedFileId: string }): { token: string; expiresAt: number };

  /**
   * Validate a token against an expected `stagedFileId`. On success the
   * nonce is **consumed** (added to the seen-map) so a second validate
   * with the same token returns `{ ok: false, code: 'REUSED' }`.
   *
   * Fail-closed: any parse error, signature mismatch, expired token,
   * scope mismatch, or reused nonce returns a typed failure code
   * rather than silently succeeding.
   */
  validate(input: { token: string; stagedFileId: string }): ConflictCapabilityValidationResult;
}

export interface CreateConflictCapabilityServiceOptions {
  /**
   * Override the token lifetime. Defaults to
   * {@link DEFAULT_TOKEN_TTL_MS}. Useful in tests — production callers
   * should leave this undefined.
   */
  ttlMs?: number;
  /**
   * Override the clock. Defaults to {@link Date.now}. Tests can provide
   * a stub to advance time deterministically.
   */
  now?: () => number;
  /**
   * Override the HMAC secret. Defaults to `crypto.randomBytes(32)`. Tests
   * that need cross-instance determinism can share a fixed secret; the
   * dedicated "different secret → INVALID_SIGNATURE" test deliberately
   * does NOT pass this so each service has its own secret.
   */
  secret?: Buffer;
  /**
   * Maximum number of consumed nonces to keep in memory before running
   * a lazy purge. Defaults to {@link DEFAULT_SEEN_NONCE_CAP}. Small
   * values in tests let the map-size bound assertion fire quickly.
   */
  seenNonceCap?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Five minutes — short enough to limit blast radius, long enough for the
 *  user to review the seeded prompt before sending. */
export const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Mirrors the Zod schema in `memory.ts`. Defense-in-depth at the service
 *  layer so a test that bypasses the schema still fails loudly. */
export const MAX_STAGED_FILE_ID_LENGTH = 256;

/** Lazy-purge threshold — when the seen-map grows past this size, expired
 *  entries are removed before the next validate check. Small enough to
 *  keep memory bounded under adversarial churn. */
export const DEFAULT_SEEN_NONCE_CAP = 1000;

/** 128-bit nonce — 32 hex chars once hex-encoded. Same entropy as
 *  `generateFenceNonce` in `packages/shared/src/untrustedFencing.ts`. */
const NONCE_BYTES = 16;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a single {@link ConflictCapabilityService} instance. Call once
 * per process at startup (see `src/main/index.ts` + `cloud-service/src/bootstrap.ts`).
 * The returned service captures a fresh HMAC secret and in-memory
 * seen-nonce map in closure — do NOT instantiate multiple services and
 * expect tokens to flow between them, that's a design feature not a bug.
 */
export function createConflictCapabilityService(
  options: CreateConflictCapabilityServiceOptions = {},
): ConflictCapabilityService {
  const ttlMs = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  const now = options.now ?? Date.now;
  const secret = options.secret ?? randomBytes(32);
  const seenNonceCap = options.seenNonceCap ?? DEFAULT_SEEN_NONCE_CAP;

  // Map value is the token's exp so we can lazy-purge once the map grows
  // past the cap. Using a Map (insertion-ordered) keeps the cleanup
  // O(map size) but that's bounded by the cap + one cleanup pass.
  const seen = new Map<string, number>();

  function purgeExpired(currentMs: number): void {
    for (const [nonce, exp] of seen) {
      if (exp <= currentMs) {
        seen.delete(nonce);
      }
    }
  }

  /**
   * Enforce the seen-map cap under sustained legitimate load, where
   * `purgeExpired()` may free zero entries (all tokens within TTL).
   * After the cap is reached we drop the oldest entries in insertion
   * order — a FIFO eviction that costs us replay protection for the
   * handful of oldest (and likely already-used) nonces in exchange for
   * a hard memory bound. Safe because tokens are also scoped by
   * signature + TTL — evicting a valid-but-old consumed nonce merely
   * re-opens replay for THAT specific token, which the attacker would
   * have had to capture before its 5-minute TTL anyway. See
   * `F-B-R2-8` in planning doc 260417_approval_consolidation_closeout.md.
   */
  function enforceCap(currentMs: number): void {
    if (seen.size < seenNonceCap) return;
    purgeExpired(currentMs);
    while (seen.size >= seenNonceCap) {
      // Map iteration is insertion-ordered — `keys().next()` yields the
      // oldest entry, giving us FIFO eviction without a separate queue.
      const oldest = seen.keys().next();
      if (oldest.done || typeof oldest.value !== 'string') break;
      seen.delete(oldest.value);
    }
  }

  return {
    mint({ stagedFileId }) {
      if (typeof stagedFileId !== 'string' || stagedFileId.length === 0) {
        throw new RangeError('stagedFileId must be a non-empty string');
      }
      if (stagedFileId.length > MAX_STAGED_FILE_ID_LENGTH) {
        throw new RangeError(
          `stagedFileId exceeds max length of ${MAX_STAGED_FILE_ID_LENGTH} (got ${stagedFileId.length})`,
        );
      }

      const nonce = randomBytes(NONCE_BYTES).toString('hex');
      const exp = now() + ttlMs;
      const payload: ConflictCapabilityPayload = { stagedFileId, nonce, exp };
      const token = signPayload(payload, secret);

      return { token, expiresAt: exp };
    },

    validate({ token, stagedFileId }) {
      // Parse first so all later checks can trust the payload shape.
      const parsed = parseAndVerifyToken(token, secret);
      if (!parsed.ok) return parsed;

      const payload = parsed.payload;
      const currentMs = now();

      if (payload.exp <= currentMs) {
        return { ok: false, code: 'EXPIRED' };
      }
      if (payload.stagedFileId !== stagedFileId) {
        return { ok: false, code: 'SCOPE_MISMATCH' };
      }

      // Replay check BEFORE enforceCap — a cheap has() lookup that has
      // no side effects. Running enforceCap first would FIFO-evict the
      // very nonce we're about to check, turning every replay of the
      // oldest cached nonce into a false `ok: true`. Node's
      // single-threaded JS execution guarantees the has/set pair is
      // atomic with respect to other validate() calls, so Promise.all
      // of two validates for the same token yields exactly one
      // `ok: true` and one `REUSED`.
      if (seen.has(payload.nonce)) {
        return { ok: false, code: 'REUSED' };
      }

      // About to consume. Enforce the cap before inserting so the map
      // never grows past seenNonceCap — purges expired entries first,
      // then FIFO-evicts the oldest if still at cap. Cost of eviction
      // is that the evicted nonce loses replay protection; justified
      // because tokens also expire after their 5-minute TTL.
      enforceCap(currentMs);
      seen.set(payload.nonce, payload.exp);

      return { ok: true, payload };
    },
  };
}

// ---------------------------------------------------------------------------
// Sign / verify helpers
// ---------------------------------------------------------------------------

function signPayload(payload: ConflictCapabilityPayload, secret: Buffer): string {
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.from(payloadJson, 'utf8');
  const payloadEncoded = payloadBytes.toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadJson).digest();
  const sigEncoded = sig.toString('base64url');
  return `${payloadEncoded}.${sigEncoded}`;
}

type ParseResult =
  | { ok: true; payload: ConflictCapabilityPayload }
  | { ok: false; code: Extract<ConflictCapabilityFailureCode, 'MALFORMED' | 'INVALID_SIGNATURE'> };

function parseAndVerifyToken(token: string, secret: Buffer): ParseResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: 'MALFORMED' };
  }

  // Exactly one '.' separator.
  const dotIdx = token.indexOf('.');
  if (dotIdx < 0 || dotIdx !== token.lastIndexOf('.')) {
    return { ok: false, code: 'MALFORMED' };
  }

  const payloadEncoded = token.slice(0, dotIdx);
  const sigEncoded = token.slice(dotIdx + 1);
  if (payloadEncoded.length === 0 || sigEncoded.length === 0) {
    return { ok: false, code: 'MALFORMED' };
  }

  let payloadBytes: Buffer;
  let sigBytes: Buffer;
  try {
    payloadBytes = Buffer.from(payloadEncoded, 'base64url');
    sigBytes = Buffer.from(sigEncoded, 'base64url');
  } catch {
    return { ok: false, code: 'MALFORMED' };
  }

  if (payloadBytes.length === 0 || sigBytes.length === 0) {
    return { ok: false, code: 'MALFORMED' };
  }

  let payloadJson: string;
  try {
    payloadJson = payloadBytes.toString('utf8');
  } catch {
    return { ok: false, code: 'MALFORMED' };
  }

  // Compute the expected signature over the EXACT payloadJson we'll
  // parse. The encode/decode round-trip preserves bytes so signing the
  // round-tripped JSON keeps parity with `signPayload`.
  const expectedSig = createHmac('sha256', secret).update(payloadJson).digest();

  // Constant-time compare — only safe when lengths match, else we fall
  // through to INVALID_SIGNATURE rather than risking a length-dependent
  // early return.
  if (sigBytes.length !== expectedSig.length) {
    return { ok: false, code: 'INVALID_SIGNATURE' };
  }
  if (!timingSafeEqual(sigBytes, expectedSig)) {
    return { ok: false, code: 'INVALID_SIGNATURE' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, code: 'MALFORMED' };
  }

  if (!isCapabilityPayload(payload)) {
    return { ok: false, code: 'MALFORMED' };
  }

  return { ok: true, payload };
}

function isCapabilityPayload(value: unknown): value is ConflictCapabilityPayload {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.stagedFileId !== 'string' || obj.stagedFileId.length === 0) return false;
  if (obj.stagedFileId.length > MAX_STAGED_FILE_ID_LENGTH) return false;
  if (typeof obj.nonce !== 'string' || obj.nonce.length === 0) return false;
  if (typeof obj.exp !== 'number' || !Number.isFinite(obj.exp) || obj.exp <= 0) return false;
  return true;
}
