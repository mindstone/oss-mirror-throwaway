/**
 * TokenStore — app pairing tokens + router-internal token (Stage 3).
 *
 * Two token classes per R5/D13:
 *   - **App pairing token** — external apps (extension, Office, etc.) carry
 *     this on `/intent/*` WS auth. Scoped to `(appId, clientId, fingerprint)`.
 *   - **Router-internal token** — the bundled RebelAppBridge MCP server uses
 *     this on `/apps/*` relay routes. Never exposed to apps. Generated at
 *     construction time so Stage 3's WS auth can run the full scope check
 *     (pair tokens rejected on router-internal routes, and vice versa).
 *
 * Stage 3 delivers:
 *   - `issuePairingToken()` / `issueAppToken(appId, clientId)` — mint tokens
 *   - `verifyAppToken(token, { appId, clientId })` — constant-time scope check
 *     required by the WS auth handshake (R6)
 *   - `classifyToken(token)` — tells routes whether a presented token is a
 *     pair token, the router-internal token, or unrecognised. Used by the
 *     HTTP relay and `/pair/revoke` to enforce cross-class rejection (R5).
 *   - `revokeAppToken(token)` — removes an app pairing token
 *   - `getRouterInternalToken()` — returns the in-memory router token
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppType } from '../shared/protocol';

export interface AppTokenClaims {
  appId: AppType;
  clientId: string;
  issuedAt: number;
  /**
   * Extension origin fingerprint (post-review B4). Tied to the
   * `(appId, clientId)` tuple at pair-claim time so a token that leaks
   * from one browser profile can't be replayed from another. `null` is
   * the canonical "no fingerprint provided on either side" state —
   * Office and other legacy callers that don't present a fingerprint
   * stay compatible as long as the claim is also `null`.
   */
  fingerprint: string | null;
  /**
   * Extension ID presented in the `Origin` header when the token was minted.
   * Optional for backwards compatibility with old state files and non-browser
   * callers that do not pair via a browser-extension origin.
   */
  extensionId?: string | null;
  /**
   * Pair-session id stamped at claim time for session-scoped install flows.
   * Undefined for legacy tokens minted before the binding field existed.
   */
  pairSessionId?: string;
}

export interface PersistedAppTokenRecord extends AppTokenClaims {
  hashedToken: string;
}

export interface InstallSessionDenylistRecord {
  installSessionId: string;
  revokedAt: number;
}

export interface ClientExtensionBindingRecord {
  clientId: string;
  extensionId: string;
  createdAt: number;
}

export type ClientExtensionBindingUpsertResult =
  | { ok: true; kind: 'new' | 'unchanged' }
  | { ok: false; reason: 'forward-conflict'; existingExtensionId: string }
  | { ok: false; reason: 'reverse-conflict'; existingClientId: string };

/** How a presented token was classified. */
export type TokenKind = 'pair' | 'router-internal' | 'unknown';

/**
 * Options passed to `verifyAppToken`. Using an object keeps the call site
 * self-documenting at the places where scope matters (WS auth handshake,
 * intent router, relay).
 */
export interface VerifyAppTokenOptions {
  appId: AppType;
  clientId: string;
  /**
   * Optional fingerprint (post-review B4). When the stored claim has a
   * non-null fingerprint the caller MUST present the exact same string
   * or verification fails. `null` on both sides is accepted — that's the
   * backward-compatible path for Office and any older browser extension
   * that paired before the field was introduced.
   */
  fingerprint?: string | null;
}

/**
 * Length of the raw entropy used for tokens. 32 bytes → 256 bits;
 * base64url-encoded the resulting token is 43 characters long.
 */
const TOKEN_BYTES = 32;
const MAX_INSTALL_SESSION_DENYLIST_ENTRIES = 100;
const MAX_CLIENT_EXTENSION_BINDINGS = 50;
export interface TokenStoreOptions {
  /** Override the router-internal token (testing only). */
  routerInternalToken?: string;
}

/**
 * Constant-time string comparison that is length-safe. Falls back to `false`
 * when either string is empty or lengths differ.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export class TokenStore {
  /**
   * Active pairing tokens. In-memory only — a fresh bridge boot invalidates
   * every outstanding pairing. This is deliberate: Stage 3 has no persistence
   * and no need for one.
   */
  private readonly pairingTokens = new Set<string>();

  /**
   * Claims attached to each pairing token. `verifyAppToken` enforces
   * `(appId, clientId)` match (R6); revoke clears both structures.
   */
  private readonly pairingClaims = new Map<string, AppTokenClaims>();

  private readonly installSessionDenylist = new Map<string, InstallSessionDenylistRecord>();

  private readonly clientExtensionBindings = new Map<string, ClientExtensionBindingRecord>();

  private readonly extensionClientBindings = new Map<string, ClientExtensionBindingRecord>();

  /**
   * Router-internal token — generated at construction by default, but may be
   * injected for tests. Never written to disk here (Stage 4 flushes it to the
   * state file if/when needed).
   */
  private readonly routerInternalToken: string;

  constructor(options: TokenStoreOptions = {}) {
    this.routerInternalToken =
      options.routerInternalToken ?? randomBytes(TOKEN_BYTES).toString('base64url');
  }

  private findPresentedTokenHash(token: string): string | null {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }
    const presentedHash = hashToken(token);
    for (const storedHash of this.pairingTokens) {
      if (constantTimeEquals(storedHash, presentedHash)) {
        return storedHash;
      }
    }
    return null;
  }

  private trimInstallSessionDenylist(): void {
    if (this.installSessionDenylist.size <= MAX_INSTALL_SESSION_DENYLIST_ENTRIES) {
      return;
    }

    const entries = [...this.installSessionDenylist.values()].sort(
      (a, b) => a.revokedAt - b.revokedAt,
    );
    while (this.installSessionDenylist.size > MAX_INSTALL_SESSION_DENYLIST_ENTRIES) {
      const oldest = entries.shift();
      if (!oldest) {
        return;
      }
      this.installSessionDenylist.delete(oldest.installSessionId);
    }
  }

  private trimClientExtensionBindings(): void {
    if (this.clientExtensionBindings.size <= MAX_CLIENT_EXTENSION_BINDINGS) {
      return;
    }

    const entries = [...this.clientExtensionBindings.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    while (this.clientExtensionBindings.size > MAX_CLIENT_EXTENSION_BINDINGS) {
      const oldest = entries.shift();
      if (!oldest) {
        return;
      }
      this.removeClientExtensionBinding(oldest.clientId);
    }
  }

  /**
   * Mint a fresh pairing token. Caller is responsible for binding it to an
   * `appId` (via `issueAppToken`) OR for using the raw token when claims
   * aren't known yet.
   */
  issuePairingToken(): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.pairingTokens.add(hashToken(token));
    return token;
  }

  /**
   * Mint a pairing token AND record its claims. Used by `PairingStore.claim()`
   * once the pairing handshake succeeds.
   *
   * `fingerprint` binds the token to a per-browser-profile identifier
   * (post-review B4). Leave `null` for callers that don't send one —
   * `verifyAppToken` treats `null` on both sides as the backwards-
   * compatible path.
   */
  issueAppToken(
    appId: AppType,
    clientId: string,
    fingerprint: string | null = null,
    extensionId: string | null = null,
    pairSessionId?: string,
  ): string {
    const token = this.issuePairingToken();
    this.pairingClaims.set(hashToken(token), {
      appId,
      clientId,
      issuedAt: Date.now(),
      fingerprint,
      extensionId,
      pairSessionId,
    });
    return token;
  }

  /**
   * Rehydrate a previously-persisted app token (post-review C1). Unlike
   * `issueAppToken`, the token value is *not* freshly generated — the
   * caller passes the already-valid hashed token + claims after reading them
   * from the state file. Overwrites any existing claim for the same hash.
   */
  restoreAppToken(hashedToken: string, claims: AppTokenClaims): void {
    if (typeof hashedToken !== 'string' || !isSha256Hex(hashedToken)) return;
    this.pairingTokens.add(hashedToken);
    this.pairingClaims.set(hashedToken, { ...claims });
  }

  restoreRevokedInstallSession(entry: InstallSessionDenylistRecord): void {
    if (
      typeof entry.installSessionId !== 'string' ||
      entry.installSessionId.length === 0 ||
      typeof entry.revokedAt !== 'number' ||
      !Number.isFinite(entry.revokedAt)
    ) {
      return;
    }
    this.installSessionDenylist.set(entry.installSessionId, { ...entry });
    this.trimInstallSessionDenylist();
  }

  restoreClientExtensionBinding(entry: ClientExtensionBindingRecord): void {
    if (
      typeof entry.clientId !== 'string' ||
      entry.clientId.length === 0 ||
      typeof entry.extensionId !== 'string' ||
      entry.extensionId.length === 0 ||
      typeof entry.createdAt !== 'number' ||
      !Number.isFinite(entry.createdAt)
    ) {
      return;
    }

    const existingByClient = this.clientExtensionBindings.get(entry.clientId);
    if (existingByClient?.extensionId === entry.extensionId) {
      return;
    }
    const existingByExtension = this.extensionClientBindings.get(entry.extensionId);
    if (existingByExtension?.clientId === entry.clientId) {
      return;
    }
    if (existingByClient || existingByExtension) {
      return;
    }

    const record = { ...entry };
    this.clientExtensionBindings.set(record.clientId, record);
    this.extensionClientBindings.set(record.extensionId, record);
    this.trimClientExtensionBindings();
  }

  /**
   * True if the token is an active pairing token (regardless of scope).
   */
  validatePairingToken(token: string): boolean {
    return this.findPresentedTokenHash(token) !== null;
  }

  /**
   * Full scope check for WS `auth` and `/intent/*` (R6).
   *
   * Returns the bound claims on success, `null` when:
   *   - token is empty / not a pairing token
   *   - token has no claims (issued without them — shouldn't happen via
   *     `issueAppToken`)
   *   - token's `appId` doesn't match the expected `appId`
   *   - token's `clientId` doesn't match the expected `clientId`
   *
   * Never leaks which specific check failed; callers decide the HTTP/WS
   * surface reaction.
   */
  verifyAppToken(token: string, options: VerifyAppTokenOptions): AppTokenClaims | null {
    const tokenHash = this.findPresentedTokenHash(token);
    if (!tokenHash) {
      return null;
    }
    const claims = this.pairingClaims.get(tokenHash);
    if (!claims) {
      return null;
    }
    if (claims.appId !== options.appId) {
      return null;
    }
    if (claims.clientId !== options.clientId) {
      return null;
    }
    // Fingerprint binding (B4). Strict rules:
    //   - Stored fingerprint is null AND caller doesn't pass one → accept
    //     (backward compat; Office keeps working).
    //   - Stored fingerprint is null AND caller passes one → accept
    //     (allows graceful upgrade; we don't force a re-pair).
    //   - Stored fingerprint is set AND caller passes a different one → reject.
    //   - Stored fingerprint is set AND caller passes none → reject.
    const storedFp = claims.fingerprint;
    const presentedFp = options.fingerprint ?? null;
    if (storedFp !== null) {
      if (presentedFp === null) return null;
      if (presentedFp !== storedFp) return null;
    }
    return claims;
  }

  /**
   * Return what class the presented token belongs to. Used by the HTTP relay
   * and `/pair/revoke` to reject cross-class presentations (D13 / R5):
   *   - Pair token presented to `/apps/*` → 403 + Sentry breadcrumb
   *   - Router-internal token presented to `/pair/revoke` → 403 + breadcrumb
   */
  classifyToken(token: string): TokenKind {
    if (typeof token !== 'string' || token.length === 0) {
      return 'unknown';
    }
    if (constantTimeEquals(token, this.routerInternalToken)) {
      return 'router-internal';
    }
    if (this.findPresentedTokenHash(token)) {
      return 'pair';
    }
    return 'unknown';
  }

  /** Remove a pairing token. Idempotent. */
  revokePairingToken(token: string): void {
    const tokenHash = this.findPresentedTokenHash(token);
    if (!tokenHash) return;
    this.pairingTokens.delete(tokenHash);
    this.pairingClaims.delete(tokenHash);
  }

  /** Alias of `revokePairingToken` for API symmetry. */
  revokeAppToken(token: string): void {
    this.revokePairingToken(token);
  }

  /**
   * Return the router-internal token. Stage 3 generates it at construct time;
   * Stage 4 propagates it to the state file under `userData/mcp/rebel-app-bridge/`.
   */
  getRouterInternalToken(): string {
    return this.routerInternalToken;
  }

  /** Exposed for tests. Returns the count of currently-live pairing tokens. */
  getActiveTokenCount(): number {
    return this.pairingTokens.size;
  }

  /**
   * Snapshot of all paired clients (Stage 6a — powers the settings UI).
   *
   * Returns one entry per *active* pairing token that has claims attached
   * (i.e. minted via `issueAppToken`). Each entry is a defensive copy so
   * callers can't mutate internal state.
   *
   * Order is undefined. Callers that want a deterministic order should sort
   * on `issuedAt`.
   */
  listAppTokens(): ReadonlyArray<{
    /** SHA-256 digest persisted to disk; plaintext never leaves the claim response. */
    hashedToken: string;
    appId: AppType;
    clientId: string;
    issuedAt: number;
    fingerprint: string | null;
    pairSessionId?: string;
  }> {
    const out: Array<{
      hashedToken: string;
      appId: AppType;
      clientId: string;
      issuedAt: number;
      fingerprint: string | null;
      pairSessionId?: string;
    }> = [];
    for (const [hashedToken, claims] of this.pairingClaims) {
      out.push({
        hashedToken,
        appId: claims.appId,
        clientId: claims.clientId,
        issuedAt: claims.issuedAt,
        fingerprint: claims.fingerprint,
        pairSessionId: claims.pairSessionId,
      });
    }
    return out;
  }

  /**
   * Snapshot of paired extension IDs, used by the desktop installer to
   * regenerate latent NMH manifests on startup without exposing token claims
   * to the renderer.
   */
  listPairedExtensionIds(): readonly string[] {
    const ids = new Set<string>();
    for (const claims of this.pairingClaims.values()) {
      if (typeof claims.extensionId === 'string' && claims.extensionId.length > 0) {
        ids.add(claims.extensionId);
      }
    }
    return [...ids];
  }

  /**
   * Full persisted-token snapshot. Includes optional fields that the
   * renderer-facing `listAppTokens()` intentionally omits.
   */
  listPersistedAppTokens(): ReadonlyArray<PersistedAppTokenRecord> {
    const out: PersistedAppTokenRecord[] = [];
    for (const [hashedToken, claims] of this.pairingClaims) {
      out.push({
        hashedToken,
        appId: claims.appId,
        clientId: claims.clientId,
        issuedAt: claims.issuedAt,
        fingerprint: claims.fingerprint,
        extensionId: claims.extensionId ?? null,
        pairSessionId: claims.pairSessionId,
      });
    }
    return out;
  }

  /**
   * Revoke all app pairing tokens whose claims match the given `clientId`.
   *
   * Returns the number of tokens revoked. Used by the settings UI so users
   * can unpair a specific browser without touching others that may share a
   * logical "browser extension" app. Idempotent.
   */
  revokeAppTokensByClientId(clientId: string): number {
    if (typeof clientId !== 'string' || clientId.length === 0) return 0;
    const toRemove: string[] = [];
    for (const [tokenHash, claims] of this.pairingClaims) {
      if (claims.clientId === clientId) {
        toRemove.push(tokenHash);
      }
    }
    for (const tokenHash of toRemove) {
      this.pairingClaims.delete(tokenHash);
      this.pairingTokens.delete(tokenHash);
    }
    return toRemove.length;
  }

  revokeAppTokensByAppId(appId: AppType): number {
    if (typeof appId !== 'string' || appId.length === 0) return 0;
    const toRemove: string[] = [];
    for (const [tokenHash, claims] of this.pairingClaims) {
      if (claims.appId === appId) {
        toRemove.push(tokenHash);
      }
    }
    for (const tokenHash of toRemove) {
      this.pairingClaims.delete(tokenHash);
      this.pairingTokens.delete(tokenHash);
    }
    return toRemove.length;
  }

  /**
   * Revoke every app pairing token stamped to a specific pair session.
   *
   * Used by Stage 6 reset-install so only the abandoned install session is
   * invalidated, not every paired browser profile on the machine.
   */
  revokeAppTokensByPairSessionId(pairSessionId: string): number {
    if (typeof pairSessionId !== 'string' || pairSessionId.length === 0) return 0;
    const toRemove: string[] = [];
    for (const [tokenHash, claims] of this.pairingClaims) {
      if (claims.pairSessionId === pairSessionId) {
        toRemove.push(tokenHash);
      }
    }
    for (const tokenHash of toRemove) {
      this.pairingClaims.delete(tokenHash);
      this.pairingTokens.delete(tokenHash);
    }
    return toRemove.length;
  }

  /**
   * Revoke every active app pairing token. Returns the number revoked.
   *
   * Convenience for "Unpair all browsers" buttons in the settings UI and
   * emergency diagnostic flows. Router-internal token is untouched — the
   * MCP relay keeps functioning, it just has no paired apps to reach.
   */
  revokeAllAppTokens(): number {
    const count = this.pairingClaims.size;
    for (const tokenHash of this.pairingClaims.keys()) {
      this.pairingTokens.delete(tokenHash);
    }
    this.pairingClaims.clear();
    return count;
  }

  revokeInstallSessionId(installSessionId: string): void {
    if (typeof installSessionId !== 'string' || installSessionId.length === 0) return;
    this.installSessionDenylist.set(installSessionId, {
      installSessionId,
      revokedAt: Date.now(),
    });
    this.trimInstallSessionDenylist();
  }

  isInstallSessionRevoked(installSessionId: string): boolean {
    if (typeof installSessionId !== 'string' || installSessionId.length === 0) {
      return false;
    }
    return this.installSessionDenylist.has(installSessionId);
  }

  listRevokedInstallSessions(): ReadonlyArray<InstallSessionDenylistRecord> {
    return [...this.installSessionDenylist.values()]
      .sort((a, b) => a.revokedAt - b.revokedAt)
      .map((entry) => ({ ...entry }));
  }

  upsertClientExtensionBinding(
    clientId: string,
    extensionId: string,
  ): ClientExtensionBindingUpsertResult {
    const existingByClient = this.clientExtensionBindings.get(clientId);
    if (existingByClient) {
      if (existingByClient.extensionId === extensionId) {
        return { ok: true, kind: 'unchanged' };
      }
      return {
        ok: false,
        reason: 'forward-conflict',
        existingExtensionId: existingByClient.extensionId,
      };
    }

    const existingByExtension = this.extensionClientBindings.get(extensionId);
    if (existingByExtension) {
      return {
        ok: false,
        reason: 'reverse-conflict',
        existingClientId: existingByExtension.clientId,
      };
    }

    const record = {
      clientId,
      extensionId,
      createdAt: Date.now(),
    } satisfies ClientExtensionBindingRecord;
    this.clientExtensionBindings.set(clientId, record);
    this.extensionClientBindings.set(extensionId, record);
    this.trimClientExtensionBindings();
    return { ok: true, kind: 'new' };
  }

  removeClientExtensionBinding(clientId: string): ClientExtensionBindingRecord | null {
    const existing = this.clientExtensionBindings.get(clientId);
    if (!existing) {
      return null;
    }
    this.clientExtensionBindings.delete(clientId);
    this.extensionClientBindings.delete(existing.extensionId);
    return { ...existing };
  }

  lookupExtensionByClientId(clientId: string): string | null {
    return this.clientExtensionBindings.get(clientId)?.extensionId ?? null;
  }

  lookupClientByExtensionId(extensionId: string): string | null {
    return this.extensionClientBindings.get(extensionId)?.clientId ?? null;
  }

  listClientExtensionBindings(): ReadonlyArray<ClientExtensionBindingRecord> {
    return [...this.clientExtensionBindings.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => ({ ...entry }));
  }
}
