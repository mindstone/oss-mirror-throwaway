/**
 * PairingStore — pending-pairing-session registry (Stage 2).
 *
 * Owns the short-lived "pair code → pending session" map plus per-code rate
 * limiting (burns a code after 10 wrong tries, ≤3 concurrent sessions — R7).
 *
 * Stage 2 delivers:
 *   - `createPendingSession(appId)` — generates a 6-digit numeric code,
 *     records the session bound to `appId`, enforces the 3-session global cap.
 *   - `claim(code, bindings)` — atomically consumes the code on first match,
 *     increments the attempt counter on wrong code, burns the code on the
 *     10th wrong attempt, issues a pairing token on success.
 *   - `revoke(token)` — removes the underlying token via `TokenStore`.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { randomInt } from 'node:crypto';
import { ErrorCode, createAppBridgeError } from '../shared/errors';
import type { AppType } from '../shared/protocol';
import { TokenStore } from './tokenStore';

export interface PendingSession {
  code: string;
  expiresAt: number;
  pairSessionId?: string;
}

export interface PairingBindings {
  clientId: string;
  fingerprint?: string;
  extensionId?: string;
}

export interface CreatePendingSessionOptions {
  pairSessionId?: string;
}

export type ClaimResult =
  | { ok: true; token: string; pairSessionId?: string }
  | { ok: false; error: ErrorCode };

export interface PairingStoreOptions {
  /** Wall-clock TTL for a pending session (default 10 minutes). */
  ttlMs?: number;
  /** Max wrong attempts before the code is burned (default 10, per R7). */
  maxAttemptsPerCode?: number;
  /** Max concurrent pending sessions across all codes (default 3). */
  maxConcurrentSessions?: number;
  /** Optional injected token store so the caller can share one across routes. */
  tokenStore?: TokenStore;
  /** Clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface PendingRecord {
  appId: AppType;
  code: string;
  expiresAt: number;
  wrongAttempts: number;
  pairSessionId?: string;
}

export class PairingStore {
  private readonly ttlMs: number;
  private readonly maxAttemptsPerCode: number;
  private readonly maxConcurrentSessions: number;
  private readonly tokenStore: TokenStore;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingRecord>();

  constructor(options: PairingStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxAttemptsPerCode = options.maxAttemptsPerCode ?? 10;
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? 3;
    this.tokenStore = options.tokenStore ?? new TokenStore();
    this.now = options.now ?? Date.now;
  }

  /**
   * Generate a fresh pairing code bound to `appId`.
   *
   * Throws `RATE_LIMITED` (HTTP 429) if the concurrent-session cap is already
   * reached. Expired sessions are pruned before the cap check, so long-idle
   * codes don't block new pair flows (R7).
   */
  createPendingSession(
    appId: AppType,
    options: CreatePendingSessionOptions = {},
  ): PendingSession {
    this.pruneExpired();

    if (this.pending.size >= this.maxConcurrentSessions) {
      throw createAppBridgeError(
        ErrorCode.RATE_LIMITED,
        `Too many pairing sessions in progress (max ${this.maxConcurrentSessions}). Finish or cancel an existing one, then try again.`,
      );
    }

    const code = this.generateUniqueCode();
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(code, {
      appId,
      code,
      expiresAt,
      wrongAttempts: 0,
      pairSessionId: options.pairSessionId,
    });
    return {
      code,
      expiresAt,
      ...(options.pairSessionId ? { pairSessionId: options.pairSessionId } : {}),
    };
  }

  /**
   * Claim a pairing code atomically.
   *
   * - Correct code + live session → consumes the code, mints an app pairing
   *   token, returns `{ ok: true, token }`.
   * - Wrong code → increments the attempt counter on every matching live
   *   pending record (we can't know which record the caller targeted without
   *   the right code, so we charge every live record in proportion to the
   *   lost attempt). If any record's counter hits `maxAttemptsPerCode`, that
   *   record is burned. Returns `{ ok: false, error: PAIRING_EXPIRED }`.
   * - Expired/burned/missing code → `{ ok: false, error: PAIRING_EXPIRED }`.
   *
   * The "charge every live record" policy is the R7 equivalent: an attacker
   * can't bypass the counter by guessing across different pending sessions,
   * because guesses burn the whole pending pool together.
   */
  claim(code: string, bindings: PairingBindings): ClaimResult {
    if (typeof code !== 'string' || code.length === 0) {
      return { ok: false, error: ErrorCode.BAD_REQUEST };
    }

    this.pruneExpired();

    const record = this.pending.get(code);
    if (record) {
      // Live match — consume the code and mint a token.
      this.pending.delete(code);
      // Post-review B4: bind the fingerprint into the token claims.
      // Passing `null` when absent keeps Office + legacy callers compatible.
      const fingerprint =
        typeof bindings.fingerprint === 'string' && bindings.fingerprint.length > 0
          ? bindings.fingerprint
          : null;
      const extensionId =
        typeof bindings.extensionId === 'string' && bindings.extensionId.length > 0
          ? bindings.extensionId
          : null;
      const token = this.tokenStore.issueAppToken(
        record.appId,
        bindings.clientId,
        fingerprint,
        extensionId,
        record.pairSessionId,
      );
      return {
        ok: true,
        token,
        ...(record.pairSessionId ? { pairSessionId: record.pairSessionId } : {}),
      };
    }

    // No match — charge every live record and burn any that exceed the cap.
    this.chargeAttemptAcrossLiveRecords();

    return { ok: false, error: ErrorCode.PAIRING_EXPIRED };
  }

  /**
   * Revoke a previously-issued pairing token.
   */
  revoke(token: string): void {
    this.tokenStore.revokePairingToken(token);
  }

  /**
   * Exposed for tests. Returns the current live records (snapshot).
   */
  listActive(): readonly PendingSession[] {
    this.pruneExpired();
    return Array.from(this.pending.values()).map((r) => ({
      code: r.code,
      expiresAt: r.expiresAt,
      ...(r.pairSessionId ? { pairSessionId: r.pairSessionId } : {}),
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private pruneExpired(): void {
    const nowMs = this.now();
    for (const [code, record] of this.pending) {
      if (record.expiresAt <= nowMs) {
        this.pending.delete(code);
      }
    }
  }

  private chargeAttemptAcrossLiveRecords(): void {
    const toBurn: string[] = [];
    for (const [code, record] of this.pending) {
      record.wrongAttempts += 1;
      if (record.wrongAttempts >= this.maxAttemptsPerCode) {
        toBurn.push(code);
      }
    }
    for (const code of toBurn) {
      this.pending.delete(code);
    }
  }

  private generateUniqueCode(): string {
    // 6-digit numeric, zero-padded. 10⁶ space + 10-min TTL + 10-attempt burn
    // makes brute-force infeasible (≤ 3 codes × 10 tries / 10 min ≈ 0.00001% per window).
    // Resolve collisions (rare) by trying again. The cap is at most `maxConcurrentSessions`
    // live records, so the birthday-paradox floor is negligible.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const n = randomInt(100_000, 1_000_000);
      const code = String(n);
      if (!this.pending.has(code)) {
        return code;
      }
    }
    // Extremely unlikely; treat as internal error.
    throw createAppBridgeError(
      ErrorCode.INTERNAL_ERROR,
      'Could not generate a unique pairing code after 32 attempts.',
    );
  }

  // -------------------------------------------------------------------------
  // Accessors used by Stage 2 tests
  // -------------------------------------------------------------------------

  getTtlMs(): number {
    return this.ttlMs;
  }

  getMaxAttemptsPerCode(): number {
    return this.maxAttemptsPerCode;
  }

  getMaxConcurrentSessions(): number {
    return this.maxConcurrentSessions;
  }

  getTokenStore(): TokenStore {
    return this.tokenStore;
  }
}
