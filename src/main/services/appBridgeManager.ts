/**
 * App Bridge Lifecycle Manager
 *
 * Thin Electron-process wrapper around `createAppBridge()` from
 * `@core/appBridge`. Responsible for the *host* side of the bridge only:
 *
 *   - Decide whether to start at all (surface + kill-switch gate).
 *   - Inject the desktop-specific `PlatformConfig`, `ErrorReporter`, and
 *     scoped logger into the core factory.
 *   - Serialise concurrent `start()` calls and make `stop()` safe in any
 *     state (idempotent, never throws).
 *   - Expose a small read-only view (`getState()` / `isRunning()`) so
 *     `coreStartup` can push the current `{ port, routerToken }` into
 *     the RebelAppBridge MCP payload.
 *
 * Non-goals: this module does not touch the router config, the MCP catalog,
 * or the browser extension. It does not spawn child processes. It is not
 * responsible for the RebelAppBridge MCP server.cjs — that stays stdio-only.
 *
 * Surface gating (R34 / D6):
 *   - `platformConfig.capabilities.appBridgeServer === true` → may start.
 *   - Otherwise (`'cloud'`, `'mobile'`) → no-op. The bridge needs a
 *     loopback socket a browser can reach, which only exists on the user's
 *     desktop.
 *
 * Kill-switch (D19):
 *   - `REBEL_DISABLE_APP_BRIDGE=1` → `start()` skips the factory entirely.
 *     Logged once at info level so the reason is visible on launch.
 *     Intended as an emergency escape hatch before the extension ships
 *     publicly; we never want this to silently disable the bridge.
 *
 * Multi-instance coexistence (D26):
 *   - The factory itself handles port fallbacks (52320–52325).
 *   - If a second Rebel instance launches on the same host, its manager
 *     will bind a different port and write a different state file path
 *     (per `platformConfig.userDataPath`, which the OS guarantees is unique
 *     per install). Tests cover this explicitly.
 *
 * Breadcrumbs & redaction:
 *   - The factory emits `bridge-start` / `bridge-stop` breadcrumbs. This
 *     module adds `bridge-disabled` (kill-switch) and `bridge-skipped`
 *     (surface mismatch) so ops can tell the difference between "off" and
 *     "failed to start" from Sentry alone.
 *   - Tokens and pairing codes are redacted via `redactObjectDeep` at log
 *     call sites (see `SENSITIVE_KEY_PATTERNS` in `@core/utils/logRedaction`
 *     for the full list).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import type { Logger } from 'pino';
import path from 'node:path';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge';
import type { ErrorReporter } from '@core/errorReporter';
import type { PlatformConfig } from '@core/platform';
import { createScopedLogger } from '@core/logger';
import type { IntentHandlers } from '@core/appBridge/server/intentRouter';
import {
  formatExtensionIdFingerprint,
  redactExtensionIdForLog,
} from '@core/appBridge/shared/fingerprint';
import { resolveAllowedExtensionIds } from '@core/appBridge/shared/allowedExtensionIds';
import { installEvent } from '@core/appBridge/shared/installEvent';
import { isAppType } from '@core/appBridge/shared/protocol';
import { isBridgeAlreadyRunningError } from '@core/appBridge/shared/errors';
import {
  CHROME_EXTENSION_ID_REGEX,
  forgetTrustedExtensionIds,
  persistTrustedExtensionId,
} from '@core/appBridge/server/originGuard';
import type { HostToolResult } from '@core/appBridge/installer/hostToolContracts';
import { PairEventBus, type PairEvent } from '@core/appBridge/server/pairEventBus';
import type { BroadcastService } from '@core/broadcastService';
import {
  CONNECTOR_STATUS_CHANGED,
  ConnectorStatusChangedPayloadSchema,
  LEGACY_SETTINGS_SESSION_ID,
  type BrowserId,
  type ConnectorStatusChangedPayload,
} from '@shared/ipc/channels/appBridge';
import { randomUUID } from 'node:crypto';
import type { ConversationStreamCoordinator } from '@core/appBridge/server/conversationStreamCoordinator';
import type { AppBridgeInstallerService } from './appBridgeInstallerService';
import { installFunnelStats } from './installFunnelStats';

/** Env var name for the emergency kill switch (D19). */
export const APP_BRIDGE_KILL_SWITCH_ENV = 'REBEL_DISABLE_APP_BRIDGE';
/** Env var that enables dev extensions via `dev-extension-ids.json` and open pair routes. */
export const APP_BRIDGE_DEV_MODE_ENV = 'REBEL_APP_BRIDGE_DEV';

const TRUSTED_HOST_BROWSER_CLIENT_ID_REGEX = /^browser-[0-9a-f]{16}$/;
const TRUSTED_HOST_BROWSER_RATE_LIMIT_WINDOW_MS = 60_000;
const TRUSTED_HOST_BROWSER_RATE_LIMIT_MAX_REQUESTS = 10;

/**
 * Minimal read-only view of a running App Bridge. Matches the three fields
 * the RebelAppBridge MCP server writes into its state file — `coreStartup`
 * can hand this straight to `buildAppBridgePayload()`.
 */
export interface AppBridgeRuntimeState {
  /** Bound loopback port (52320–52325). */
  port: number;
  /** Absolute path to `state.json` written by the bridge. */
  stateFilePath: string;
  /** Router-internal token (R5 / D13) — only used by the MCP relay. */
  routerToken: string;
}

export interface AppBridgeManagerOptions {
  platformConfig: PlatformConfig;
  errorReporter: ErrorReporter;
  /**
   * Optional scoped logger. When omitted, a `service: 'app-bridge-manager'`
   * child is created from the root logger so messages land in the normal
   * log files.
   */
  logger?: Logger;
  /**
   * Test-only override for reading the kill switch — lets unit tests
   * toggle the value per-test without mutating `process.env`, which is
   * cross-test state.
   */
  readKillSwitch?: () => string | undefined;
  /**
   * Optional factory override. Kept out of the public surface; used by
   * tests to swap in a fake bridge so we don't bind real loopback ports.
   */
  createBridge?: typeof createAppBridge;
  /**
   * Stage 7 — optional `IntentHandlers` implementation for the
   * `/intent/*` routes. When omitted the router returns 501 for every
   * `/intent/conversation/*` route (pre-Stage-7 posture). `coreStartup`
   * constructs the desktop implementation (`appBridgeIntentService`) and
   * threads it through here.
   */
  intentHandlers?: IntentHandlers;
  /**
   * Optional override — defaults to
   * `resolveAllowedExtensionIds()` (production IDs unioned with env extras).
   * Tests can pass an explicit allowlist so they don't depend on env.
   */
  resolveAllowedExtensionIds?: () => readonly string[];
  /**
   * Stage 10-preview — toggles TOFU on. Decoupled from `devMode` so the
   * distinction is observable in code review.
   */
  previewMode?: boolean;
  /**
   * Broadcast service to emit pending approval updates to the renderer.
   */
  broadcastService?: BroadcastService;
  /**
   * Test-only override for reading dev mode.
   */
  readDevMode?: () => boolean;
  /**
   * Installer service used to power `/host/*` loopback routes for the
   * agent-owned browser-install flow.
   */
  installerService?: AppBridgeInstallerService;
  /**
   * Embedded-chat SSE fan-out (Stage 2 of
   * `260421_embedded_chat_in_extension`). When present, the manager
   * closes any live writers associated with a revoked pairing token so
   * the browser extension's side panel doesn't keep receiving deltas
   * after the user unpairs. Optional because unit tests that only
   * exercise pairing/revoke flows don't need a full coordinator.
   */
  streamCoordinator?: ConversationStreamCoordinator;
}

/**
 * Reason the bridge declined to start. Returned by `start()` via the
 * manager state so hosts can render a diagnostic without re-checking env.
 */
export type AppBridgeSkipReason = 'kill-switch' | 'surface-not-desktop';

/**
 * Read-only view of a paired client surfaced to the IPC settings UI.
 *
 * `clientId` is the stable per-install identifier the extension sent during
 * pairing. `token` is intentionally omitted — we never return it to the
 * renderer; revocation happens by clientId.
 */
export interface PairedClientSnapshot {
  clientId: string;
  appId: string;
  issuedAt: number;
  pairSessionId?: string;
}

export interface PendingApproval {
  pendingApprovalId: string;
  fingerprint: string;
  extensionId: string;
  inferredBrowserId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ActivePairSession {
  pairSessionId: string;
  appId: string;
  browserId?: string;
  createdAt: number;
  ttlMs: number;
}

export interface AppBridgeManager {
  /**
   * Start the bridge if the gates allow it. Safe to call repeatedly —
   * subsequent calls return the existing handle (idempotent).
   *
   * Never throws for "should not start" outcomes; throws only when the
   * underlying factory rejects (no free port, disk write failure, …).
   */
  start(): Promise<AppBridgeRuntimeState | null>;
  /**
   * Stop the bridge if it was started. Safe to call in any state
   * (pre-start, post-stop, while start is in flight). Never throws —
   * failures are logged and swallowed because we run this from
   * `gracefulShutdown`.
   */
  stop(): Promise<void>;
  /** True iff the factory returned a live handle and it hasn't been stopped. */
  isRunning(): boolean;
  /** Current runtime state (port/token/…) or `null` when not running. */
  getState(): AppBridgeRuntimeState | null;
  /** Diagnostic reason when the bridge skipped start. `null` when running or not yet started. */
  getSkipReason(): AppBridgeSkipReason | null;
  /**
   * Loopback HTTP base used by trusted main-process callers to exercise
   * `/pair/*` and friends with the router-internal token.
   *
   * `null` when the bridge isn't running. Never exposed to the renderer.
   */
  getHttpBaseForIpc(): string | null;
  /**
   * Router-internal token, for main-process code signing Bearer headers
   * on the HTTP loopback. `null` when the bridge isn't running. Never
   * exposed to the renderer.
   */
  getRouterTokenForIpc(): string | null;
  /**
   * Snapshot of currently paired app tokens (clientId + appId + issuedAt).
   * Used by the settings UI to render the "Paired browsers" list.
   */
  listPairedClients(): readonly PairedClientSnapshot[];
  /**
   * Extension IDs persisted in paired token claims. Used by startup-time
   * NMH manifest re-registration without exposing the values to the renderer.
   */
  listPairedExtensionIds(): readonly string[];
  /**
   * Revoke every app pairing token matching `clientId`. Returns the count
   * revoked (0 if no match). Idempotent.
   */
  revokePairedClient(clientId: string): Promise<number>;
  /**
   * Revoke every paired client. Returns the count revoked.
   */
  revokeAllPairedClients(): Promise<number>;
  /**
   * Stage 9 — stop the bridge and re-run the factory so it picks up a
   * fresh port from the fallback list. Used by the "Let Rebel pick
   * another port" CTA when the preferred port is taken on launch and
   * the user wants to try again without restarting Rebel.
   *
   * Returns the new runtime state on success, or `null` when the manager
   * refuses to restart (already stopped, kill switch on, non-desktop surface).
   * Throws when the underlying factory throws (e.g. no free port at all).
   */
  restartWithDynamicPort(): Promise<AppBridgeRuntimeState | null>;
  /**
   * Mint a pairing code directly against the in-process `PairingStore`.
   *
   * Post-review fix A3 — the previous implementation went through an
   * HTTP POST `/pair/start` call from within the same process, which
   * required setting an `Origin` header that the originGuard then
   * rejected (originGuard only allows extension origins on /pair/start).
   *
   * Calling the store directly is cleaner, sidesteps the loopback origin
   * dance entirely, and keeps the pairing token contract identical. The
   * IPC handler is the only authorised caller — `AppBridgeManager` is
   * scoped to the main process and never reachable from the renderer.
   *
   * @throws when the bridge isn't running.
   */
  startPairing(appId: string): { code: string; expiresAt: number; expiresInSeconds: number };
  startPairing(opts: {
    appId: string;
    browserId?: string;
  }): {
    code: string;
    expiresAt: number;
    expiresInSeconds: number;
    pairSessionId: string;
  };

  /**
   * Check if there are any paired clients or pending approvals.
   */
  getGlobalPairStatus(): {
    paired: { appId: string; clientId: string }[];
    hasPending: boolean;
    activeSessionCount: number;
    degraded?: 'trust-persist-failed';
  };
  checkPairStatus(pairSessionId: string): {
    paired: { appId: string; clientId: string }[];
    hasPending: boolean;
    pairSessionExpired: boolean;
    /**
     * True when the bridge has no record of this pairSessionId at all —
     * neither active nor recently-ended. Distinct from `pairSessionExpired`:
     * expired means "we remember issuing it, it just aged out", not-found
     * means "we never issued it" (typically an agent hallucinating a
     * pairSessionId it copied wrong or fabricated). Agents should treat
     * `pairSessionNotFound` as a hard error and stop looping.
     */
    pairSessionNotFound: boolean;
  };

  /**
   * List all pending TOFU approvals.
   */
  listPendingApprovals(): PendingApproval[];
  listPendingApprovals(pairSessionId: string): PendingApproval[];

  /**
   * Approve or reject a pending TOFU approval.
   */
  approvePendingApproval(args: {
    pendingApprovalId: string;
    approved: boolean;
    fingerprint: string;
    pairSessionId: string;
  }): {
    ok: boolean;
    reason?:
      | 'already-resolved'
      | 'not-found'
      | 'expired'
      | 'fingerprint-mismatch'
      | 'session-mismatch'
      | 'session-expired'
      | 'session-unbound';
  };
  endPairSession(
    pairSessionId: string,
    options?: { stage?: string; reason?: string },
  ): void;
  resetInstall(args: {
    pairSessionId: string;
    full?: boolean;
  }): Promise<
    HostToolResult<{
      revoked: number;
      idsRemoved: number;
      folderRemoved?: boolean;
      degraded?: boolean;
    }>
  >;
  hasActivePairSession(pairSessionId: string): boolean;
  hasAnyActivePairSessionForBrowser(browserId: BrowserId): boolean;
  getActivePairSessionForBrowser(browserId: BrowserId): string | undefined;
  getActivePairSessions(): readonly Pick<ActivePairSession, 'pairSessionId' | 'browserId'>[];
  /**
   * Report the currently connected extension version, when the extension
   * advertises one during WS register. Older builds only send the protocol
   * version, which we treat as "unknown" so the Settings banner stays dark
   * until a real app version is available.
   */
  getExtensionVersionStatus(latestVersion: string): {
    currentVersion: string | null;
    latestVersion: string;
  };
}

/**
 * Create a new manager. Does NOT start the bridge — call `start()` when
 * the host is ready (after platform config + error reporter are wired).
 */
export function createAppBridgeManager(options: AppBridgeManagerOptions): AppBridgeManager {
  const { platformConfig, errorReporter } = options;
  const installerService = options.installerService;
  const streamCoordinator = options.streamCoordinator;
  const readKillSwitch = options.readKillSwitch ?? (() => process.env[APP_BRIDGE_KILL_SWITCH_ENV]);
  const factory = options.createBridge ?? createAppBridge;
  const log = options.logger ?? createScopedLogger({ service: 'app-bridge-manager' });
  const resolveAllowlist =
    options.resolveAllowedExtensionIds ?? (() => resolveAllowedExtensionIds());
  const readDevMode =
    options.readDevMode ??
    ((): boolean => {
      const raw = process.env[APP_BRIDGE_DEV_MODE_ENV];
      if (typeof raw !== 'string') return false;
      const normalized = raw.trim().toLowerCase();
      return normalized === '1' || normalized === 'true' || normalized === 'yes';
    });

  const previewMode = options.previewMode ?? false;
  const broadcastService = options.broadcastService;

  let handle: AppBridgeHandle | null = null;
  let skipReason: AppBridgeSkipReason | null = null;
  let startInFlight: Promise<AppBridgeRuntimeState | null> | null = null;
  let stopped = false;
  // 10.5min — stays slightly above pairingStore.ttlMs (10min) so the session
  // cleanup path fires AFTER the pair code itself has expired, not before.
  const ACTIVE_PAIR_SESSION_TTL_MS = 10 * 60_000 + 30_000;
  const PENDING_TOFU_TTL_MS = 120_000;

  type PendingTofuEntry = {
    extensionId: string;
    inferredBrowserId?: string;
    pairSessionId: string | null;
    createdAt: number;
    ttlMs: number;
    resolve: (approved: boolean) => void;
  };
  const pendingTofuPairings = new Map<string, PendingTofuEntry>();
  const resolvedPendingApprovalIds = new Set<string>();
  const activePairSessions = new Map<string, ActivePairSession>();
  const installSessionAliasByPairSessionId = new Map<string, string>();
  const pairSessionIdByInstallSessionAlias = new Map<string, string>();
  const pairedTokenSessionIds = new Map<string, string>();
  const approvedUnknownOriginSessionIds = new Map<string, string | null>();
  const pairSessionTrustedExtensionIds = new Map<string, Set<string>>();

  /**
   * Shared `PairEventBus` owned by the manager and passed into the core
   * factory via `options.pairEventBus`. The manager subscribes per pair
   * session inside `startPairing()` and translates bus events into the
   * renderer-facing `connector:status-changed` broadcast. Owning the bus
   * here (rather than reading it off `AppBridgeHandle`) keeps subscriber
   * lifetimes tied to individual pair sessions — independent of
   * `manager.stop()` / `restartWithDynamicPort()`.
   *
   * @see docs/plans/260422_renderer_driven_connector_status.md — Stage 2
   */
  const pairEventBus = new PairEventBus();
  /**
   * Per-pair-session unsubscribe handles for the translator subscriber.
   * Populated alongside `activePairSessions.set()`; cleared by
   * `unsubscribePairSessionBus()` at every `activePairSessions.delete()`
   * call site. Idempotent — no-op for sessions that never subscribed.
   */
  const pairSessionSubscriptions = new Map<string, () => void>();

  /**
   * Recently-ended pair session IDs → endedAt timestamp.
   *
   * Purpose: lets `checkPairStatus` / `endPairSession` / `listPendingApprovals`
   * distinguish between "this session ID is genuinely expired or user-ended"
   * (it was here, we remember it) and "this session ID was never issued by
   * this bridge" (we have no record — the agent is probably hallucinating).
   * Without this, the agent-side recovery advice for the two cases is
   * identical ("pairing window closed, restart STEP 1") even though the
   * second case is a code/prompt bug, not a user-visible state.
   *
   * Retention: IDs stay in this map until the bridge process restarts or
   * the map is pruned. Size-capped to avoid unbounded growth across very
   * long runs (an install flow issues one pair session per attempt).
   */
  const recentlyEndedPairSessionIds = new Map<string, number>();
  const MAX_RECENTLY_ENDED = 256;
  const trustedHostMintAttempts = new Map<string, number[]>();
  function rememberEndedPairSessionId(pairSessionId: string): void {
    if (recentlyEndedPairSessionIds.size >= MAX_RECENTLY_ENDED) {
      // Drop the oldest entry. Map iteration order is insertion order.
      const oldestKey = recentlyEndedPairSessionIds.keys().next().value;
      if (typeof oldestKey === 'string') {
        recentlyEndedPairSessionIds.delete(oldestKey);
      }
    }
    recentlyEndedPairSessionIds.set(pairSessionId, Date.now());
  }

  let trustPersistenceDegraded = false;
  let ttlSweepInterval: NodeJS.Timeout | null = null;

  installerService?.setDiagnoseContext({
    isBridgeReachable: () => handle !== null,
    hasActiveInstallSession: (installSessionId) => hasActivePairSession(installSessionId),
    hasAnyActiveInstallSessionForBrowser: (browserId) =>
      hasAnyActivePairSessionForBrowser(browserId),
    getActiveInstallSessionForBrowser: (browserId) => getActivePairSessionForBrowser(browserId),
    getActiveInstallSessions: () =>
      getActivePairSessions().map((session) => ({
        installSessionId: session.pairSessionId,
        browserId: session.browserId,
      })),
  });

  function redactIdSuffix(value: string | undefined): string | undefined {
    if (typeof value !== 'string' || value.length === 0) {
      return undefined;
    }
    return value.slice(-6);
  }

  function getOrCreateInstallSessionAlias(pairSessionId: string): string {
    const existing = installSessionAliasByPairSessionId.get(pairSessionId);
    if (existing) return existing;

    const alias = `install_alias_${randomUUID()}`;
    installSessionAliasByPairSessionId.set(pairSessionId, alias);
    pairSessionIdByInstallSessionAlias.set(alias, pairSessionId);
    return alias;
  }

  function resolveInstallSessionAlias(pairSessionIdOrAlias: string): string {
    return pairSessionIdByInstallSessionAlias.get(pairSessionIdOrAlias) ?? pairSessionIdOrAlias;
  }

  function toPublicPairSessionId(pairSessionId: string): string {
    return installSessionAliasByPairSessionId.get(pairSessionId) ?? pairSessionId;
  }

  function recordTrustedHostMintAttempt(clientId: string, now: number): {
    allowed: boolean;
    retryAfterMs?: number;
    remaining?: number;
  } {
    const attempts = trustedHostMintAttempts.get(clientId) ?? [];
    const windowStart = now - TRUSTED_HOST_BROWSER_RATE_LIMIT_WINDOW_MS;
    const recentAttempts = attempts.filter((attempt) => attempt > windowStart);
    if (recentAttempts.length >= TRUSTED_HOST_BROWSER_RATE_LIMIT_MAX_REQUESTS) {
      const oldestAttempt = recentAttempts[0] ?? now;
      return {
        allowed: false,
        retryAfterMs: Math.max(
          1,
          TRUSTED_HOST_BROWSER_RATE_LIMIT_WINDOW_MS - (now - oldestAttempt),
        ),
      };
    }

    recentAttempts.push(now);
    trustedHostMintAttempts.set(clientId, recentAttempts);
    return {
      allowed: true,
      remaining: Math.max(
        0,
        TRUSTED_HOST_BROWSER_RATE_LIMIT_MAX_REQUESTS - recentAttempts.length,
      ),
    };
  }

  function broadcastPendingUpdate(): void {
    if (broadcastService) {
      broadcastService.sendToAllWindows('app-bridge:pending-approval-updated');
    }
  }

  /**
   * Translate a `PairEvent` into a renderer-visible broadcast status verb.
   *
   * - `paired` → `connected`
   * - `code-expired` → `expired`
   * - `session-ended` + `cause: 'user-reset'` → `cancelled`
   * - `session-ended` + `cause: 'step7-cleanup'` → `null` (no broadcast —
   *    pair already announced on `paired`)
   * - `session-ended` without a known cause → `expired` (back-compat:
   *    earlier builds emitted `session-ended` without the `cause` field,
   *    so we default to the safer user-facing verb instead of swallowing)
   */
  function translatePairEventStatus(
    event: PairEvent,
  ): 'connected' | 'expired' | 'cancelled' | null {
    switch (event.type) {
      case 'paired':
        return 'connected';
      case 'code-expired':
        return 'expired';
      case 'session-ended':
        if (event.cause === 'user-reset') return 'cancelled';
        if (event.cause === 'step7-cleanup') return null;
        return 'expired';
      default:
        return null;
    }
  }

  /**
   * Build + validate + broadcast the translator payload. Destructuring is
   * explicit: the source `PairEvent` has an optional `tokenFingerprint`
   * field that MUST NOT cross the main↔renderer boundary. We only read
   * `pairSessionId` and `emittedAt` off the event and never spread it.
   *
   * Schema validation is a belt-and-braces check against future drift
   * (e.g. someone adding a new payload field without updating the
   * contract). A failure here never falls through to broadcast — the
   * error is logged and the event is dropped. Broadcasting an
   * unvalidated payload would bypass the `.strict()` boundary that
   * Stage 1 put in place specifically for this.
   */
  function broadcastConnectorStatus(
    status: 'connected' | 'expired' | 'cancelled',
    pairSessionId: string,
    emittedAt: number,
  ): void {
    if (!broadcastService) return;

    const publicPairSessionId = toPublicPairSessionId(pairSessionId);
    const candidate = {
      connectorId: 'bundled-app-bridge' as const,
      status,
      pairSessionId: publicPairSessionId,
      emittedAt,
      eventId: `${publicPairSessionId}:${emittedAt}:${status}`,
    } satisfies ConnectorStatusChangedPayload;

    const parsed = ConnectorStatusChangedPayloadSchema.safeParse(candidate);
    if (!parsed.success) {
      log.error(
        {
          pairSessionId,
          status,
          issues: parsed.error.issues,
        },
        'connector:status-changed payload failed schema validation — not broadcasting',
      );
      return;
    }

    broadcastService.sendToAllWindows(CONNECTOR_STATUS_CHANGED, parsed.data);
    log.debug(
      { pairSessionId, status },
      'Broadcast connector:status-changed',
    );
  }

  /**
   * Subscribe the translator to this pair session's bus events. Idempotent
   * per pairSessionId — a second call replaces the prior unsubscribe so
   * we never leak duplicate handlers. Safe to call without the bridge
   * running (the bus lives on the manager, not the handle).
   */
  function subscribePairSessionBus(pairSessionId: string): void {
    // Idempotent: if we're somehow re-subscribing, drop the prior first.
    unsubscribePairSessionBus(pairSessionId);
    const unsubscribe = pairEventBus.subscribe(pairSessionId, (event) => {
      const status = translatePairEventStatus(event);
      if (status === null) return;
      broadcastConnectorStatus(status, event.pairSessionId, event.emittedAt);
    });
    pairSessionSubscriptions.set(pairSessionId, unsubscribe);
  }

  function unsubscribePairSessionBus(pairSessionId: string): void {
    const unsubscribe = pairSessionSubscriptions.get(pairSessionId);
    if (!unsubscribe) return;
    try {
      unsubscribe();
    } catch (err) {
      log.warn(
        { pairSessionId, err },
        'Failed to unsubscribe pair-event-bus translator — continuing',
      );
    }
    pairSessionSubscriptions.delete(pairSessionId);
  }

  function isPairSessionExpired(session: ActivePairSession, now = Date.now()): boolean {
    return now - session.createdAt >= session.ttlMs;
  }

  function getLiveActivePairSession(pairSessionId: string): ActivePairSession | null {
    const session = activePairSessions.get(pairSessionId);
    if (!session) return null;
    if (isPairSessionExpired(session)) {
      activePairSessions.delete(pairSessionId);
      unsubscribePairSessionBus(pairSessionId);
      rememberEndedPairSessionId(pairSessionId);
      return null;
    }
    return session;
  }

  function registerActiveInstallSession(pairSessionId: string, browserId?: BrowserId): void {
    recentlyEndedPairSessionIds.delete(pairSessionId);
    const existing = activePairSessions.get(pairSessionId);
    if (existing) {
      activePairSessions.set(pairSessionId, {
        ...existing,
        ...(browserId ? { browserId } : {}),
      });
      return;
    }

    activePairSessions.set(pairSessionId, {
      pairSessionId,
      appId: 'browser-extension',
      ...(browserId ? { browserId } : {}),
      createdAt: Date.now(),
      ttlMs: ACTIVE_PAIR_SESSION_TTL_MS,
    });
    subscribePairSessionBus(pairSessionId);
    errorReporter.addBreadcrumb({
      category: 'app-bridge.install',
      level: 'info',
      message: 'app-bridge.install.prepare-session-registered',
      data: {
        browserId,
        pairSessionIdSuffix: redactIdSuffix(pairSessionId),
      },
    });
    log.info(
      { browserId, pairSessionIdSuffix: redactIdSuffix(pairSessionId) },
      'Registered prepare-install session for status reconciliation',
    );
  }

  function maybeBindNewTokensToPairSessions(): void {
    if (!handle) return;
    const tokenEntries = handle.tokenStore.listAppTokens();
    const liveHashes = new Set(tokenEntries.map((entry) => entry.hashedToken));
    for (const existingHash of pairedTokenSessionIds.keys()) {
      if (!liveHashes.has(existingHash)) {
        pairedTokenSessionIds.delete(existingHash);
      }
    }

    for (const entry of tokenEntries) {
      if (pairedTokenSessionIds.has(entry.hashedToken)) continue;
      if (entry.pairSessionId) {
        const session = getLiveActivePairSession(entry.pairSessionId);
        if (session) {
          pairedTokenSessionIds.set(entry.hashedToken, session.pairSessionId);
        }
        continue;
      }

      let fallbackSession: ActivePairSession | undefined;
      for (const session of activePairSessions.values()) {
        if (entry.issuedAt <= session.createdAt) continue;
        if (entry.issuedAt > session.createdAt + session.ttlMs) continue;
        if (!fallbackSession || session.createdAt > fallbackSession.createdAt) {
          fallbackSession = session;
        }
      }
      if (fallbackSession) {
        log.warn(
          {
            clientId: entry.clientId,
            issuedAt: entry.issuedAt,
            pairSessionId: fallbackSession.pairSessionId,
          },
          'App Bridge token missing pairSessionId; using legacy timestamp fallback',
        );
        pairedTokenSessionIds.set(entry.hashedToken, fallbackSession.pairSessionId);
      }
    }
  }

  function rememberTrustedExtensionIdForSession(
    pairSessionId: string,
    extensionId: string,
  ): void {
    const existing = pairSessionTrustedExtensionIds.get(pairSessionId);
    if (existing) {
      existing.add(extensionId);
      return;
    }
    pairSessionTrustedExtensionIds.set(pairSessionId, new Set([extensionId]));
  }

  function getBridgeStateDirectory(): string {
    return path.join(platformConfig.userDataPath, 'mcp', 'rebel-app-bridge');
  }

  function persistTrustedExtensionIdFromMint(extensionId: string): void {
    const result = persistTrustedExtensionId(
      getBridgeStateDirectory(),
      extensionId,
      errorReporter,
    );
    if (!result.added && !result.alreadyPresent) {
      trustPersistenceDegraded = true;
      log.warn(
        { extensionIdSuffix: redactExtensionIdForLog(extensionId) },
        'App Bridge trusted-host mint failed to persist extension trust',
      );
    }
  }

  async function regenerateBootTokensAfterRevoke(
    browserIds: BrowserId[] | 'all',
    context: string,
  ): Promise<void> {
    if (!installerService) {
      return;
    }

    const result = await installerService.regenerateBootTokenFiles(browserIds, errorReporter);
    if (!result.ok) {
      log.warn(
        {
          context,
          browserIds: browserIds === 'all' ? 'all' : [...browserIds],
          reason: result.reason,
          rewritten: result.rewritten,
          skipped: result.skipped,
        },
        'Boot-token rotation skipped during revoke flow',
      );
    }
  }

  /**
   * Persist a newly-trusted chrome-extension ID that just succeeded at
   * `/pair/claim` and bind it to the pair session so `resetInstall` can
   * later forget it. Called fire-and-forget from the pair-routes factory
   * via `onClaimPersistTrust` — mirrors the TOFU-approved path (the
   * `onPersistedExtensionId` wiring in `start()`) without going through
   * the now-unused pending-approval plumbing. Best-effort: all failures
   * are logged and swallowed, never thrown, so a disk-write hiccup can't
   * break a successful claim. See
   * docs-private/investigations/260423_tofu_vs_claim_timeout_bug.md for the full
   * rationale.
   */
  function rememberTrustedExtensionIdForPairSession(args: {
    pairSessionId: string;
    extensionId: string;
  }): void {
    const { pairSessionId, extensionId } = args;
    const stateDirectory = path.join(
      platformConfig.userDataPath,
      'mcp',
      'rebel-app-bridge',
    );
    const result = persistTrustedExtensionId(
      stateDirectory,
      extensionId,
      errorReporter,
    );
    if (result.added) {
      rememberTrustedExtensionIdForSession(pairSessionId, extensionId);
    }
    const degraded = !result.added && !result.alreadyPresent;
    // Mirror the TOFU-approved path's degraded-signal semantics: a disk
    // write failure must flip the manager-wide `trustPersistenceDegraded`
    // flag so `getGlobalPairStatus()` surfaces `{ degraded: 'trust-persist-failed' }`
    // and the renderer can show the "saved for this session only" banner.
    // Without this the claim-persistence path silently fails — the exact
    // class of bug AGENTS.md's "silent failure is a bug" rule forbids.
    // See docs-private/investigations/260423_tofu_vs_claim_timeout_bug.md for
    // the full rationale.
    if (degraded) {
      trustPersistenceDegraded = true;
      log.warn(
        {
          extensionIdSuffix: redactExtensionIdForLog(extensionId),
          pairSessionId,
          stateDirectory,
        },
        'App Bridge claim-path trust persistence failed; degraded flag set for runtime',
      );
    }
    const approvalData = {
      extensionIdSuffix: redactExtensionIdForLog(extensionId),
      pairSessionId,
      persistOnApproval: true,
      added: result.added,
      alreadyPresent: result.alreadyPresent,
      degraded,
      source: 'pair-claim' as const,
    };
    errorReporter.addBreadcrumb({
      category: 'app-bridge.origin-guard',
      level: 'info',
      message: 'tofu-extension-approved',
      data: approvalData,
    });
    installEvent(log, 'info', 'app-bridge.tofu.approved', approvalData);
  }

  function clearPairSessionTokenBindings(pairSessionId: string): void {
    for (const [hashedToken, boundSessionId] of pairedTokenSessionIds.entries()) {
      if (boundSessionId === pairSessionId) {
        pairedTokenSessionIds.delete(hashedToken);
      }
    }
  }

  function clearPendingApprovalsForSession(pairSessionId: string): boolean {
    let changed = false;
    for (const [pendingApprovalId, entry] of pendingTofuPairings.entries()) {
      if (entry.pairSessionId !== pairSessionId) continue;
      pendingTofuPairings.delete(pendingApprovalId);
      resolvedPendingApprovalIds.add(pendingApprovalId);
      entry.resolve(false);
      changed = true;
    }
    if (changed) {
      broadcastPendingUpdate();
    }
    return changed;
  }

  /**
   * Tears down per-pair-session bookkeeping AND unsubscribes the Stage 2
   * `PairEventBus` translator.
   *
   * **Invariant — callers MUST emit any terminal `PairEventBus` event (e.g.,
   * `session-ended`) BEFORE invoking this helper.** Once `cleanupPairSession`
   * runs, the translator subscription is torn down, and any subsequent emit
   * for this pair session will not reach the renderer `connector:status-changed`
   * broadcast. The Stage 2 M1 review caught exactly this ordering bug in
   * `/host/reset-install` (emit-after-unsubscribe), which is why the
   * `session-ended`/`cause: user-reset` emit lives inside `resetInstall()`
   * — immediately above the `cleanupPairSession` call — rather than in the
   * route handler. The same rule applies to future callers adding new
   * terminal lifecycle events.
   *
   * @see docs/plans/260422_renderer_driven_connector_status.md — Stage 2 M1
   */
  function cleanupPairSession(
    pairSessionId: string,
    stage: string,
    reason: string,
  ): ActivePairSession | null {
    const session = activePairSessions.get(pairSessionId) ?? null;
    activePairSessions.delete(pairSessionId);
    const alias = installSessionAliasByPairSessionId.get(pairSessionId);
    if (alias) {
      installSessionAliasByPairSessionId.delete(pairSessionId);
      pairSessionIdByInstallSessionAlias.delete(alias);
    }
    unsubscribePairSessionBus(pairSessionId);
    // Whether or not the session entry was still present, remember this
    // ID so subsequent checkPairStatus/listPendingApprovals calls can
    // distinguish "expired and we know about it" from "never issued".
    rememberEndedPairSessionId(pairSessionId);
    for (const [extensionId, boundSessionId] of approvedUnknownOriginSessionIds.entries()) {
      if (boundSessionId === pairSessionId) {
        approvedUnknownOriginSessionIds.delete(extensionId);
      }
    }
    const hadTrustedExtensionIds =
      (pairSessionTrustedExtensionIds.get(pairSessionId)?.size ?? 0) > 0;
    clearPairSessionTokenBindings(pairSessionId);
    const hadPendingApprovals = clearPendingApprovalsForSession(pairSessionId);
    pairSessionTrustedExtensionIds.delete(pairSessionId);
    if (session || hadPendingApprovals || hadTrustedExtensionIds) {
      errorReporter.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.abandon',
        data: {
          pairSessionId,
          browserId: session?.browserId,
          stage,
          reason,
        },
      });
    }
    return session;
  }

  function notifyPairSessionEnded(pairSessionId: string): void {
    if (!handle) {
      return;
    }
    const tokenStore = handle.tokenStore;
    const matchingConnections = handle.connectionManager
      .list()
      .filter((connection) => {
        const pairSessionIds = tokenStore
          .listPersistedAppTokens()
          .filter(
            (entry) =>
              entry.clientId === connection.clientId &&
              entry.pairSessionId === pairSessionId,
          )
          .map((entry) => entry.pairSessionId);
        return pairSessionIds.includes(pairSessionId);
      });

    for (const connection of matchingConnections) {
      try {
        connection.socket.send(
          JSON.stringify({ type: 'session-ended', pairSessionId }),
          () => {
            try {
              connection.socket.close(4001, 'session-ended');
            } catch {
              // best effort
            }
          },
        );
      } catch {
        try {
          connection.socket.close(4001, 'session-ended');
        } catch {
          // best effort
        }
      }
    }
  }

  function startTtlSweep(): void {
    if (ttlSweepInterval) return;
    ttlSweepInterval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, entry] of pendingTofuPairings.entries()) {
        if (now - entry.createdAt >= entry.ttlMs) {
          entry.resolve(false);
          pendingTofuPairings.delete(id);
          changed = true;
          // Audit: TOFU expiry is a *negative* security decision (deny by
          // timeout). Log + breadcrumb so security review can reconstruct
          // the full approval lifecycle without tailing renderer events.
          log.info(
            { pendingApprovalId: id, extensionId: entry.extensionId, outcome: 'expired' },
            'App Bridge TOFU approval expired',
          );
          errorReporter.addBreadcrumb({
            category: 'app-bridge.tofu',
            level: 'info',
            message: 'app-bridge.tofu.expired',
            data: {
              pendingApprovalId: id,
              extensionIdSuffix: redactExtensionIdForLog(entry.extensionId),
              ageMs: now - entry.createdAt,
              pairSessionId: entry.pairSessionId,
            },
          });
        }
      }
      for (const [pairSessionId, session] of activePairSessions.entries()) {
        if (isPairSessionExpired(session, now)) {
          cleanupPairSession(pairSessionId, 'idle-ttl', 'ttl-expired');
        }
      }
      if (changed) {
        broadcastPendingUpdate();
      }
    }, 10_000);
  }

  function stopTtlSweep(): void {
    if (ttlSweepInterval) {
      clearInterval(ttlSweepInterval);
      ttlSweepInterval = null;
    }
  }

  async function onUnknownExtensionOrigin(extensionId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const now = Date.now();
      const liveSessions = Array.from(activePairSessions.values()).filter(
        (session) => now - session.createdAt < session.ttlMs,
      );
      const inferredSession = liveSessions.length === 1 ? liveSessions[0] : null;
      if (inferredSession === null && liveSessions.length !== 1) {
        log.warn(
          {
            activeSessionCount: liveSessions.length,
            extensionIdSuffix: redactExtensionIdForLog(extensionId),
          },
          'App Bridge TOFU request arrived without a unique active pair session; leaving it unbound',
        );
      }
      const pendingApprovalId = randomUUID();
      const resolveApproval = (approved: boolean): void => {
        if (approved) {
          approvedUnknownOriginSessionIds.set(
            extensionId,
            inferredSession?.pairSessionId ?? null,
          );
        } else {
          approvedUnknownOriginSessionIds.delete(extensionId);
        }
        resolve(approved);
      };
      pendingTofuPairings.set(pendingApprovalId, {
        extensionId,
        inferredBrowserId: inferredSession?.browserId,
        pairSessionId: inferredSession?.pairSessionId ?? null,
        createdAt: now,
        ttlMs: PENDING_TOFU_TTL_MS,
        resolve: resolveApproval,
      });
      // Audit: record the request so security review can see every TOFU
      // prompt the user was shown, even ones that later expired without
      // resolution. We log the extension ID (not secret) but never the
      // router token.
      log.info(
        { pendingApprovalId, extensionId, outcome: 'requested' },
        'App Bridge TOFU approval requested',
      );
      errorReporter.addBreadcrumb({
        category: 'app-bridge.tofu',
        level: 'info',
        message: 'app-bridge.tofu.requested',
        data: {
          pendingApprovalId,
          extensionIdSuffix: redactExtensionIdForLog(extensionId),
          inferredBrowserId: inferredSession?.browserId,
          pairSessionId: inferredSession?.pairSessionId ?? null,
        },
      });
      broadcastPendingUpdate();
    });
  }

  function toState(h: AppBridgeHandle): AppBridgeRuntimeState {
    return {
      port: h.port,
      stateFilePath: h.stateFilePath,
      routerToken: h.routerInternalToken,
    };
  }

  function killSwitchActive(): boolean {
    const raw = readKillSwitch();
    if (raw === undefined) return false;
    // Accept `1` / `true` / `yes` case-insensitively; anything else is "off".
    // This matches the posture of other Rebel env flags and avoids surprising
    // "truthy string" disables (e.g. `REBEL_DISABLE_APP_BRIDGE=0` must be off).
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }

  async function start(): Promise<AppBridgeRuntimeState | null> {
    if (stopped) {
      // Stop() is terminal — do not restart. Callers should create a new manager.
      return null;
    }
    if (handle) {
      return toState(handle);
    }
    if (startInFlight) {
      return startInFlight;
    }

    if (killSwitchActive()) {
      skipReason = 'kill-switch';
      log.info({ env: APP_BRIDGE_KILL_SWITCH_ENV }, 'App Bridge disabled via kill switch');
      errorReporter.addBreadcrumb({
        category: 'app-bridge',
        level: 'info',
        message: 'bridge-disabled',
        data: { reason: 'kill-switch', env: APP_BRIDGE_KILL_SWITCH_ENV },
      });
      return null;
    }

    if (!platformConfig.capabilities.appBridgeServer) {
      skipReason = 'surface-not-desktop';
      log.info({ surface: platformConfig.surface }, 'App Bridge skipped — non-desktop surface');
      errorReporter.addBreadcrumb({
        category: 'app-bridge',
        level: 'info',
        message: 'bridge-skipped',
        data: { reason: 'surface-not-desktop', surface: platformConfig.surface },
      });
      return null;
    }

    skipReason = null;

    startInFlight = (async () => {
      try {
        const allowedChromeExtensionIds = resolveAllowlist();
        const devMode = readDevMode();
        // Guard: if we somehow ended up with neither a production ID nor
        // dev-mode, the bridge would refuse *every* extension. That's the
        // safer failure mode, but we still log loudly so operators notice.
        if (allowedChromeExtensionIds.length === 0 && !devMode) {
          log.warn(
            {},
            'App Bridge starting with empty Chrome extension allowlist and devMode=false — extensions will be rejected',
          );
        }
        const hostHandlers = installerService
          ? {
              prepareInstall: (browserId?: string) =>
                installerService
                  .prepareInstall(
                    browserId as Parameters<AppBridgeInstallerService['prepareInstall']>[0],
                  )
                  .then((result) => {
                    const pairSessionId = result.data?.pairSessionId;
                    const selectedBrowserId = result.data?.selectedBrowser?.id;
                    if (result.ok && result.data && typeof pairSessionId === 'string') {
                      registerActiveInstallSession(pairSessionId, selectedBrowserId);
                      const installSessionAlias = getOrCreateInstallSessionAlias(pairSessionId);
                      return {
                        ...result,
                        data: {
                          ...result.data,
                          pairSessionId: installSessionAlias,
                        },
                      };
                    }
                    return result;
                  }),
              extractExtension: (browserId: string) =>
                installerService.extractExtensionFolder(
                  browserId as Parameters<AppBridgeInstallerService['extractExtensionFolder']>[0],
                ),
              revealExtensionFolder: (browserId: string) =>
                installerService.revealExtensionFolder(
                  browserId as Parameters<AppBridgeInstallerService['revealExtensionFolder']>[0],
                ),
              openBrowserExtensionsPage: (browserId: string) =>
                installerService.openBrowserExtensionsPage(
                  browserId as Parameters<AppBridgeInstallerService['openBrowserExtensionsPage']>[0],
                ),
              startPairing: ({ browserId }: { browserId?: string }) => {
                const session = startPairing({
                  appId: 'browser-extension',
                  ...(browserId ? { browserId } : {}),
                });
                return {
                  ...session,
                  appId: 'browser-extension',
                };
              },
              checkPairStatus,
              diagnose: async ({
                browserId,
                pairSessionId,
              }: {
                browserId: string;
                pairSessionId?: string;
              }) => {
                const cooldown = installFunnelStats.consumeDiagnoseCooldown(
                  browserId,
                );
                if (!cooldown.allowed) {
                  const remainingSeconds = Math.max(
                    1,
                    Math.ceil(cooldown.remainingMs / 1000),
                  );
                  return {
                    ok: false,
                    reason: 'cooldown-active',
                    userMessage: 'Diagnose was already run recently.',
                    instructions: `Wait ~${remainingSeconds}s before running diagnose again.`,
                    retryable: true,
                  };
                }

                return {
                  ok: true,
                  reason: 'ok',
                  retryable: false,
                  data: await installerService.diagnose({
                    browserId:
                      browserId as Parameters<AppBridgeInstallerService['diagnose']>[0]['browserId'],
                    ...(pairSessionId ? { pairSessionId: resolveInstallSessionAlias(pairSessionId) } : {}),
                  }),
                };
              },
              resetInstall,
              listPendingApprovals,
              approvePending: (args: {
                pendingApprovalId: string;
                approved: boolean;
                fingerprint: string;
                pairSessionId: string;
              }) => approvePendingApproval(args),
              listPaired: () =>
                listPairedClients().map((entry) => ({
                  appId: entry.appId,
                  clientId: entry.clientId,
                  issuedAt: entry.issuedAt,
                })),
              endPairSession,
              mintAppTokenForTrustedHost,
            }
          : undefined;
        const built = await factory({
          platformConfig,
          errorReporter,
          logger: log,
          allowedChromeExtensionIds,
          devMode,
          previewMode,
          // Share the manager-owned bus so the translator subscribers see the
          // same events as the bridge's internal routes
          // (pair-claim/code-expired sweep/host-reset-install/end-pair-session).
          pairEventBus,
          ...(previewMode ? { onUnknownExtensionOrigin } : {}),
          ...(previewMode
            ? { onClaimPersistTrust: rememberTrustedExtensionIdForPairSession }
            : {}),
          onTrustPersistenceFailure: ({ extensionId, stateDirectory }) => {
            trustPersistenceDegraded = true;
            approvedUnknownOriginSessionIds.delete(extensionId);
            log.warn(
              {
                extensionIdSuffix: redactExtensionIdForLog(extensionId),
                stateDirectory,
              },
              'App Bridge trust persistence failed; degraded flag set for runtime',
            );
          },
          onPersistedExtensionId: (extensionId) => {
            const pairSessionId = approvedUnknownOriginSessionIds.get(extensionId);
            approvedUnknownOriginSessionIds.delete(extensionId);
            if (pairSessionId) {
              rememberTrustedExtensionIdForSession(pairSessionId, extensionId);
            }
          },
          ...(hostHandlers ? { hostHandlers } : {}),
          ...(options.intentHandlers ? { intentHandlers: options.intentHandlers } : {}),
        });
        handle = built;
        trustPersistenceDegraded = false;
        startTtlSweep();
        log.info(
          {
            port: built.port,
            stateFilePath: built.stateFilePath,
            // Never log the router token itself — only that one exists.
            hasRouterToken: built.routerInternalToken.length > 0,
          },
          'App Bridge started',
        );
        // Refresh boot-token files on every successful bridge start.
        // The bridge generates a fresh `routerInternalToken` on each
        // process launch (see `TokenStore` constructor), but the on-disk
        // boot-token files consumed by browser extensions are only
        // rewritten during install/extract/revoke. Without this sweep,
        // extensions whose session-token cache is cleared (Chrome
        // restart, `chrome.runtime.reload()`) will loop on 401s from
        // `/host/mint-app-token`. Must be non-fatal — a failure to
        // rewrite a boot-token file is ugly but not worth aborting the
        // bridge over, and the breadcrumb surfaces it for Sentry.
        // See docs-private/investigations/260424_boot_token_stale_on_startup.md.
        if (installerService) {
          try {
            const regenResult = await installerService.regenerateBootTokenFiles(
              'all',
              errorReporter,
            );
            log.info(
              {
                rewritten: regenResult.rewritten,
                skipped: regenResult.skipped,
                preserved: regenResult.preserved,
                reason: regenResult.ok ? 'ok' : regenResult.reason,
              },
              'Boot-token regeneration on bridge start',
            );
            errorReporter.addBreadcrumb({
              category: 'app-bridge.install',
              level: 'info',
              message: 'boot-token-regen-startup',
              data: {
                rewritten: regenResult.rewritten,
                skipped: regenResult.skipped,
                preserved: regenResult.preserved,
                ok: regenResult.ok,
              },
            });
          } catch (regenErr) {
            log.warn(
              { err: regenErr },
              'Boot-token regeneration on bridge start failed — continuing',
            );
            errorReporter.captureException(regenErr, {
              area: 'app-bridge',
              phase: 'manager-start-boot-token-regen',
            });
          }
        }
        return toState(built);
      } catch (err) {
        if (isBridgeAlreadyRunningError(err)) {
          // Expected condition (REBEL-5EB): another live App Bridge owns the state
          // file. The bridge layer already emits a warn with full context
          // (stateFilePath), so log at debug here to avoid a duplicate warn, and
          // skip the Sentry capture so this expected ownership conflict isn't an error.
          log.debug({ err }, 'App Bridge already running in another process; start aborted');
        } else {
          log.error({ err }, 'Failed to start App Bridge');
          errorReporter.captureException(err, { area: 'app-bridge', phase: 'manager-start' });
        }
        throw err;
      } finally {
        startInFlight = null;
      }
    })();

    return startInFlight;
  }

  async function stop(): Promise<void> {
    stopped = true;
    stopTtlSweep();
    activePairSessions.clear();
    installSessionAliasByPairSessionId.clear();
    pairSessionIdByInstallSessionAlias.clear();
    // Drain any lingering translator subscriptions so long-lived manager
    // instances (test harnesses, `restartWithDynamicPort()` rollovers) do
    // not retain stale closures that keep the `PairEventBus` alive.
    // Paired with `cleanupPairSession()` at every per-session delete site;
    // this is the belt-and-braces sweep for the terminal stop path.
    for (const unsubscribe of pairSessionSubscriptions.values()) {
      try {
        unsubscribe();
      } catch (err) {
        log.warn(
          { err },
          'Failed to unsubscribe pair-event-bus translator during manager.stop() — continuing',
        );
      }
    }
    pairSessionSubscriptions.clear();
    resolvedPendingApprovalIds.clear();
    pairedTokenSessionIds.clear();
    approvedUnknownOriginSessionIds.clear();
    pairSessionTrustedExtensionIds.clear();
    trustPersistenceDegraded = false;
    
    // Resolve all pending with false
    for (const entry of pendingTofuPairings.values()) {
      entry.resolve(false);
    }
    pendingTofuPairings.clear();

    // Wait for any concurrent start() before stopping to avoid racing the
    // handle assignment. If start() threw, we simply have nothing to close.
    if (startInFlight) {
      try {
        await startInFlight;
      } catch {
        // The error is already logged inside start(); nothing to stop.
      }
    }

    const current = handle;
    handle = null;
    if (!current) return;

    try {
      await current.stop();
    } catch (err) {
      // Graceful shutdown never surfaces exceptions. Log + report and move on.
      log.warn({ err }, 'App Bridge stop threw — continuing shutdown');
      errorReporter.captureException(err, { area: 'app-bridge', phase: 'manager-stop' });
    }
  }

  /**
   * Stop the bridge without flipping the terminal `stopped` flag, then
   * restart the factory. Used by `restartWithDynamicPort`. Rejects on any
   * factory error so the IPC handler can surface it to the UI.
   */
  async function restartWithDynamicPort(): Promise<AppBridgeRuntimeState | null> {
    if (stopped) {
      // We're in graceful-shutdown territory — don't resurrect.
      log.info('restartWithDynamicPort ignored — manager already stopped');
      return null;
    }
    if (killSwitchActive()) {
      skipReason = 'kill-switch';
      return null;
    }
    if (!platformConfig.capabilities.appBridgeServer) {
      skipReason = 'surface-not-desktop';
      return null;
    }

    // Wait for any in-flight start before tearing down, so we never close
    // a handle whose factory call hasn't resolved yet.
    if (startInFlight) {
      try {
        await startInFlight;
      } catch {
        // Prior start failed; there's nothing to close.
      }
    }

    const previous = handle;
    handle = null;
    if (previous) {
      try {
        await previous.stop();
      } catch (err) {
        log.warn(
          { err },
          'Previous bridge stop threw during restart — continuing',
        );
        errorReporter.captureException(err, {
          area: 'app-bridge',
          phase: 'manager-restart-stop',
        });
      }
    }

    // Fall through to the normal start path — it re-reads the kill
    // switch, surface, and then calls the factory.
    return start();
  }

  function requireHandle(op: string): AppBridgeHandle {
    if (!handle) {
      throw new Error(`App Bridge is not running (requested: ${op}).`);
    }
    return handle;
  }

  function listPairedClients(): readonly PairedClientSnapshot[] {
    if (!handle) return [];
    maybeBindNewTokensToPairSessions();
    return handle.tokenStore.listAppTokens().map((entry) => ({
      clientId: entry.clientId,
      appId: entry.appId,
      issuedAt: entry.issuedAt,
      pairSessionId: entry.pairSessionId ?? pairedTokenSessionIds.get(entry.hashedToken),
    }));
  }

  /**
   * Allowlist of `appId` values permitted to mint a paired app token via
   * `/host/mint-app-token` (router-internal-auth'd).
   *
   * This route exists so host-trusted companion processes (e.g. the Office
   * sidecar spawned by the Rebel desktop app) can obtain a paired app
   * token without driving the interactive pair/claim flow — they already
   * live inside the Rebel trust boundary (same user, same machine, can
   * read the bridge state file). But we still keep the allowlist tight so
   * a compromised handler wiring can't turn the route into a universal
   * token-issuance backdoor.
   */
  const TRUSTED_HOST_APP_IDS: ReadonlySet<string> = new Set([
    'office-addin',
    'browser-extension',
  ]);

  function rotateBrowserBindingForSameInstallSession(args: {
    existingClientId: string;
    newClientId: string;
    extensionId: string;
    installSessionId: string;
  }): boolean {
    const h = handle;
    if (!h) return false;

    const persistedTokenEntries = h.tokenStore
      .listPersistedAppTokens()
      .filter(
        (entry) =>
          entry.appId === 'browser-extension' &&
          entry.clientId === args.existingClientId &&
          entry.extensionId === args.extensionId,
      );
    const hasSameInstallSession = persistedTokenEntries.some(
      (entry) => entry.pairSessionId === args.installSessionId,
    );
    if (!hasSameInstallSession) {
      return false;
    }

    const hashedTokens = streamCoordinator
      ? persistedTokenEntries.map((entry) => entry.hashedToken)
      : [];
    const revoked = h.tokenStore.revokeAppTokensByClientId(args.existingClientId);
    h.tokenStore.removeClientExtensionBinding(args.existingClientId);

    if (streamCoordinator) {
      for (const hashedToken of hashedTokens) {
        streamCoordinator.closeAllForToken(hashedToken);
      }
    }

    const live = h.connectionManager.findByClientId(args.existingClientId);
    for (const conn of live) {
      try {
        conn.socket.close(4001, 'rotated');
      } catch {
        // socket may already be closing/dead — fall through
      }
    }

    log.info(
      {
        existingClientIdSuffix: redactIdSuffix(args.existingClientId),
        newClientIdSuffix: redactIdSuffix(args.newClientId),
        installSessionIdSuffix: redactIdSuffix(args.installSessionId),
        extensionIdSuffix: redactExtensionIdForLog(args.extensionId),
        revoked,
        closedConnections: live.length,
      },
      'Rotated browser extension client binding for same install session',
    );
    return true;
  }

  function mintAppTokenForTrustedHost(args: {
    appId: string;
    clientId: string;
    extensionId?: string;
    originExtensionId?: string;
    installSessionId?: string;
    fingerprint?: string;
  }):
    | { ok: true; token: string }
    | {
        ok: false;
        reason: string;
        status?: number;
        retryAfterMs?: number;
        direction?: 'forward' | 'reverse';
      } {
    const h = handle;
    if (!h) {
      return { ok: false, reason: 'bridge-not-running' };
    }
    if (!TRUSTED_HOST_APP_IDS.has(args.appId)) {
      log.warn(
        { appId: args.appId },
        'mint-app-token rejected — appId not on trusted-host allowlist',
      );
      return {
        ok: false,
        reason: 'appId-not-on-trusted-host-allowlist',
        status: 403,
      };
    }
    if (args.clientId.trim().length === 0) {
      return { ok: false, reason: 'clientId-required', status: 400 };
    }

    if (args.appId === 'office-addin') {
      h.tokenStore.revokeAppTokensByClientId(args.clientId);
      const token = h.tokenStore.issueAppToken(args.appId, args.clientId);
      log.info(
        { appId: args.appId, clientId: args.clientId },
        'Minted paired app token for trusted host',
      );
      return { ok: true, token };
    }

    if (!args.extensionId || !args.installSessionId) {
      return {
        ok: false,
        reason: 'missing-browser-extension-fields',
        status: 400,
      };
    }

    if (!TRUSTED_HOST_BROWSER_CLIENT_ID_REGEX.test(args.clientId)) {
      return {
        ok: false,
        reason: 'invalid-client-id-format',
        status: 400,
      };
    }

    if (!CHROME_EXTENSION_ID_REGEX.test(args.extensionId)) {
      return {
        ok: false,
        reason: 'invalid-extension-id-format',
        status: 400,
      };
    }

    if (h.tokenStore.isInstallSessionRevoked(args.installSessionId)) {
      const rejectionData = {
        appId: args.appId,
        clientIdSuffix: redactIdSuffix(args.clientId),
        installSessionIdSuffix: redactIdSuffix(args.installSessionId),
        extensionIdSuffix: redactExtensionIdForLog(args.extensionId),
      };
      errorReporter.addBreadcrumb({
        category: 'app-bridge.security',
        level: 'warning',
        message: 'trusted-host-mint-install-session-revoked',
        data: rejectionData,
      });
      log.warn(rejectionData, 'mint-app-token rejected — install session already revoked');
      return {
        ok: false,
        reason: 'install-session-revoked',
        status: 403,
      };
    }

    const now = Date.now();
    const rateLimit = recordTrustedHostMintAttempt(args.clientId, now);
    if (!rateLimit.allowed) {
      const rejectionData = {
        appId: args.appId,
        clientIdSuffix: redactIdSuffix(args.clientId),
        installSessionIdSuffix: redactIdSuffix(args.installSessionId),
        extensionIdSuffix: redactExtensionIdForLog(args.extensionId),
        retryAfterMs: rateLimit.retryAfterMs,
      };
      errorReporter.addBreadcrumb({
        category: 'app-bridge.security',
        level: 'warning',
        message: 'trusted-host-mint-rate-limited',
        data: rejectionData,
      });
      log.warn(rejectionData, 'mint-app-token rejected — trusted-host rate limit exceeded');
      return {
        ok: false,
        reason: 'rate-limited',
        status: 429,
        retryAfterMs: rateLimit.retryAfterMs,
      };
    }

    let bindingResult = h.tokenStore.upsertClientExtensionBinding(
      args.clientId,
      args.extensionId,
    );
    if (
      !bindingResult.ok &&
      bindingResult.reason === 'reverse-conflict' &&
      args.originExtensionId?.toLowerCase() === args.extensionId.toLowerCase() &&
      rotateBrowserBindingForSameInstallSession({
        existingClientId: bindingResult.existingClientId,
        newClientId: args.clientId,
        extensionId: args.extensionId,
        installSessionId: args.installSessionId,
      })
    ) {
      bindingResult = h.tokenStore.upsertClientExtensionBinding(
        args.clientId,
        args.extensionId,
      );
    }
    if (!bindingResult.ok) {
      const direction = bindingResult.reason === 'forward-conflict' ? 'forward' : 'reverse';
      const rejectionData = {
        appId: args.appId,
        clientIdSuffix: redactIdSuffix(args.clientId),
        installSessionIdSuffix: redactIdSuffix(args.installSessionId),
        extensionIdSuffix: redactExtensionIdForLog(args.extensionId),
        direction,
      };
      errorReporter.addBreadcrumb({
        category: 'app-bridge.security',
        level: 'warning',
        message: 'trusted-host-mint-binding-conflict',
        data: rejectionData,
      });
      log.warn(rejectionData, 'mint-app-token rejected — client/extension binding conflict');
      return {
        ok: false,
        reason: 'clientId-extensionId-binding-conflict',
        status: 403,
        direction,
      };
    }

    h.tokenStore.revokeAppTokensByClientId(args.clientId);
    const token = h.tokenStore.issueAppToken(
      'browser-extension',
      args.clientId,
      args.fingerprint ?? null,
      args.extensionId,
      args.installSessionId,
    );
    persistTrustedExtensionIdFromMint(args.extensionId);
    if (
      activePairSessions.has(args.installSessionId) ||
      pairSessionTrustedExtensionIds.has(args.installSessionId)
    ) {
      rememberTrustedExtensionIdForSession(args.installSessionId, args.extensionId);
    }
    broadcastPendingUpdate();
    broadcastConnectorStatus('connected', args.installSessionId, now);
    errorReporter.addBreadcrumb({
      category: 'app-bridge.pair',
      level: 'info',
      message: 'trusted-host-browser-mint-ok',
      data: {
        appId: args.appId,
        clientIdSuffix: redactIdSuffix(args.clientId),
        installSessionIdSuffix: redactIdSuffix(args.installSessionId),
        extensionIdSuffix: redactExtensionIdForLog(args.extensionId),
        fingerprintPresent: typeof args.fingerprint === 'string',
      },
    });
    log.info(
      {
        appId: args.appId,
        clientIdSuffix: redactIdSuffix(args.clientId),
        installSessionIdSuffix: redactIdSuffix(args.installSessionId),
        extensionIdSuffix: redactExtensionIdForLog(args.extensionId),
        fingerprintPresent: typeof args.fingerprint === 'string',
        rateLimitRemaining: rateLimit.remaining,
      },
      'Minted paired app token for trusted browser host',
    );
    return { ok: true, token };
  }

  function listPairedExtensionIds(): readonly string[] {
    if (!handle) return [];
    return handle.tokenStore.listPairedExtensionIds();
  }

  function getExtensionVersionStatus(latestVersion: string): {
    currentVersion: string | null;
    latestVersion: string;
  } {
    const normalizedLatestVersion = latestVersion.trim();
    if (!handle || normalizedLatestVersion.length === 0) {
      return { currentVersion: null, latestVersion: normalizedLatestVersion };
    }

    const liveVersions = Array.from(
      new Set(
        handle.connectionManager
          .list()
          .filter((connection) => connection.appId === 'browser-extension')
          .map((connection) => {
            const reportedVersion = connection.version.trim();
            if (reportedVersion.length === 0) return null;
            return reportedVersion === connection.protocolVersion ? null : reportedVersion;
          })
          .filter((version): version is string => version !== null),
      ),
    );

    if (liveVersions.length === 0) {
      return { currentVersion: null, latestVersion: normalizedLatestVersion };
    }

    const currentVersion =
      liveVersions.find((version) => version !== normalizedLatestVersion) ?? liveVersions[0];

    return {
      currentVersion,
      latestVersion: normalizedLatestVersion,
    };
  }

  async function revokePairedClient(clientId: string): Promise<number> {
    const h = requireHandle('revokePairedClient');
    const persistedTokenEntries = h.tokenStore
      .listPersistedAppTokens()
      .filter((entry) => entry.clientId === clientId);
    const installSessionIds = new Set(
      persistedTokenEntries
        .map((entry) => entry.pairSessionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    for (const installSessionId of installSessionIds) {
      h.tokenStore.revokeInstallSessionId(installSessionId);
    }
    const boundExtensionId = h.tokenStore.lookupExtensionByClientId(clientId);
    const extensionIdsToForget = new Set(
      persistedTokenEntries
        .map((entry) => entry.extensionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    if (boundExtensionId) {
      extensionIdsToForget.add(boundExtensionId);
    }
    // Snapshot hashedTokens BEFORE revocation — TokenStore wipes its
    // internal claim map as part of the revoke, so we can't recover the
    // hashes after the fact. Any live SSE streams carrying these hashes
    // must be closed (Stage 2 of the embedded-chat plan).
    const hashedTokens = streamCoordinator
      ? h.tokenStore
          .listAppTokens()
          .filter((entry) => entry.clientId === clientId)
          .map((entry) => entry.hashedToken)
      : [];
    const revoked = h.tokenStore.revokeAppTokensByClientId(clientId);
    h.tokenStore.removeClientExtensionBinding(clientId);
    if (extensionIdsToForget.size > 0) {
      forgetTrustedExtensionIds(
        getBridgeStateDirectory(),
        [...extensionIdsToForget],
        errorReporter,
      );
    }
    if (streamCoordinator) {
      for (const hashedToken of hashedTokens) {
        streamCoordinator.closeAllForToken(hashedToken);
      }
    }
    const live = h.connectionManager.findByClientId(clientId);
    for (const conn of live) {
      try {
        conn.socket.close(4001, 'revoked');
      } catch {
        // socket may already be closing/dead — fall through
      }
    }
    if (live.length > 0) {
      log.info(
        { clientId, closedConnections: live.length },
        'Revoked paired client and closed live WS connections',
      );
    }
    await regenerateBootTokensAfterRevoke('all', 'revokePairedClient');
    log.info(
      {
        clientIdSuffix: redactIdSuffix(clientId),
        revoked,
        installSessionIdsRevoked: installSessionIds.size,
        extensionIdsForgotten: extensionIdsToForget.size,
      },
      'App Bridge paired-client revoke completed',
    );
    // Settings UI (useAppBridgePairedCount) listens to this broadcast to
    // re-read the paired-client count and flip the Rebel Browser card
    // between "Install" (unpaired) and "Disconnect" (paired) states.
    // Fires on every revoke, whether or not any tokens actually changed —
    // that's cheap and keeps the UI in sync with the agent-mode pair
    // section (which also calls `api.revoke()` directly on per-row unpair).
    if (revoked > 0 || live.length > 0) {
      broadcastPendingUpdate();
    }
    return revoked;
  }

  async function revokeAllPairedClients(): Promise<number> {
    const h = requireHandle('revokeAllPairedClients');
    const persistedTokenEntries = h.tokenStore.listPersistedAppTokens();
    const installSessionIds = new Set(
      persistedTokenEntries
        .map((entry) => entry.pairSessionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    for (const installSessionId of installSessionIds) {
      h.tokenStore.revokeInstallSessionId(installSessionId);
    }
    const extensionIdsToForget = new Set(
      persistedTokenEntries
        .map((entry) => entry.extensionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    for (const binding of h.tokenStore.listClientExtensionBindings()) {
      extensionIdsToForget.add(binding.extensionId);
      h.tokenStore.removeClientExtensionBinding(binding.clientId);
    }
    if (extensionIdsToForget.size > 0) {
      forgetTrustedExtensionIds(
        getBridgeStateDirectory(),
        [...extensionIdsToForget],
        errorReporter,
      );
    }
    // Snapshot hashedTokens BEFORE revocation so we can close every
    // live SSE stream attached to a token that's about to disappear.
    const hashedTokens = streamCoordinator
      ? h.tokenStore.listAppTokens().map((entry) => entry.hashedToken)
      : [];
    const revoked = h.tokenStore.revokeAllAppTokens();
    if (streamCoordinator) {
      for (const hashedToken of hashedTokens) {
        streamCoordinator.closeAllForToken(hashedToken);
      }
    }
    const live = h.connectionManager.list();
    for (const conn of live) {
      try {
        conn.socket.close(4001, 'revoked');
      } catch {
        // ignore
      }
    }
    if (live.length > 0) {
      log.info(
        { closedConnections: live.length },
        'Revoked all paired clients and closed live WS connections',
      );
    }
    await regenerateBootTokensAfterRevoke('all', 'revokeAllPairedClients');
    log.info(
      {
        revoked,
        installSessionIdsRevoked: installSessionIds.size,
        extensionIdsForgotten: extensionIdsToForget.size,
      },
      'App Bridge revoke-all completed',
    );
    // See `revokePairedClient` for why this broadcast fires.
    if (revoked > 0 || live.length > 0) {
      broadcastPendingUpdate();
    }
    return revoked;
  }

  async function resetInstall(args: {
    pairSessionId: string;
    full?: boolean;
  }): Promise<
    HostToolResult<{
      revoked: number;
      idsRemoved: number;
      folderRemoved?: boolean;
      degraded?: boolean;
    }>
  > {
    const h = requireHandle('resetInstall');
    const { full = false } = args;
    const pairSessionId = resolveInstallSessionAlias(args.pairSessionId);
    const session = activePairSessions.get(pairSessionId) ?? null;
    const persistedTokenEntries = h.tokenStore
      .listPersistedAppTokens()
      .filter((entry) => entry.pairSessionId === pairSessionId);
    const hasAnyScopedState =
      persistedTokenEntries.length > 0 || pairSessionTrustedExtensionIds.has(pairSessionId);
    if (session === null && !hasAnyScopedState) {
      return {
        ok: false,
        reason: 'pair-session-not-found',
        retryable: false,
      };
    }

    const clientIds = new Set(persistedTokenEntries.map((entry) => entry.clientId));
    const installSessionIds = new Set(
      persistedTokenEntries
        .map((entry) => entry.pairSessionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    for (const installSessionId of installSessionIds) {
      h.tokenStore.revokeInstallSessionId(installSessionId);
    }
    const candidateIds = pairSessionTrustedExtensionIds.get(pairSessionId) ?? new Set<string>();
    const stillReferenced = new Set<string>();
    for (const [otherSessionId, ids] of pairSessionTrustedExtensionIds.entries()) {
      if (otherSessionId === pairSessionId) continue;
      for (const id of ids) {
        if (candidateIds.has(id)) {
          stillReferenced.add(id);
        }
      }
    }
    const idsToForget = [...candidateIds].filter((id) => !stillReferenced.has(id));

    notifyPairSessionEnded(pairSessionId);
    // Snapshot hashedTokens before the revoke wipes the claims so we
    // can close any live SSE streams tied to this pair session.
    const hashedTokensToClose = streamCoordinator
      ? persistedTokenEntries.map((entry) => entry.hashedToken)
      : [];
    const revoked = h.tokenStore.revokeAppTokensByPairSessionId(pairSessionId);
    if (streamCoordinator) {
      for (const hashedToken of hashedTokensToClose) {
        streamCoordinator.closeAllForToken(hashedToken);
      }
    }
    clearPairSessionTokenBindings(pairSessionId);

    const forgotten = forgetTrustedExtensionIds(
      getBridgeStateDirectory(),
      idsToForget,
      errorReporter,
    );
    await regenerateBootTokensAfterRevoke(
      session?.browserId ? [session.browserId as BrowserId] : 'all',
      'resetInstall',
    );
    const folderResult =
      full && installerService
        ? await installerService.revertExtractionArtifacts({
            browserId: session?.browserId as BrowserId | undefined,
            sessionStartedAt: session?.createdAt,
          })
        : { removed: false };

    // Emit the terminal `session-ended`/`cause: user-reset` BEFORE
    // cleanupPairSession unsubscribes the Stage 2 translator. Otherwise the
    // renderer never sees the `cancelled` broadcast and Configure with Rebel
    // silently hangs after a user-initiated reset. Ownership of this emit
    // lives on the manager (not the /host/reset-install route) so no future
    // caller can accidentally reintroduce the emit-after-unsubscribe bug.
    // See docs/plans/260422_renderer_driven_connector_status.md — Stage 2 M1.
    pairEventBus.emit({
      type: 'session-ended',
      cause: 'user-reset',
      pairSessionId,
      emittedAt: Date.now(),
    });

    cleanupPairSession(pairSessionId, 'reset-install', 'reset-install');
    if (forgotten.degraded && idsToForget.length > 0) {
      pairSessionTrustedExtensionIds.set(pairSessionId, new Set(idsToForget));
    }

    const resultData = {
      revoked,
      idsRemoved: forgotten.removed,
      ...(full ? { folderRemoved: folderResult.removed } : {}),
      ...(forgotten.degraded && idsToForget.length > 0
        ? { degraded: true as const }
        : {}),
    };

    log.info(
      {
        pairSessionId,
        browserId: session?.browserId,
        revokedClientCount: clientIds.size,
        revokedInstallSessionIds: installSessionIds.size,
        revokedTokens: revoked,
        forgottenTrustedExtensionIds: forgotten.removed,
        trustedExtensionIdsToForget: idsToForget.length,
        trustedExtensionIdsDegraded: forgotten.degraded,
        full,
        folderRemoved: folderResult.removed,
      },
      'App Bridge install session reset',
    );

    if (forgotten.degraded && idsToForget.length > 0) {
      return {
        ok: false,
        reason: 'reset-partial-failure',
        retryable: true,
        data: resultData,
      };
    }

    return {
      ok: true,
      reason: 'ok',
      retryable: false,
      data: resultData,
    };
  }

  function startPairing(appId: string): {
    code: string;
    expiresAt: number;
    expiresInSeconds: number;
  };
  function startPairing(opts: {
    appId: string;
    browserId?: string;
  }): {
    code: string;
    expiresAt: number;
    expiresInSeconds: number;
    pairSessionId: string;
  };
  function startPairing(
    input: string | { appId: string; browserId?: string },
  ):
    | {
        code: string;
        expiresAt: number;
        expiresInSeconds: number;
      }
    | {
        code: string;
        expiresAt: number;
        expiresInSeconds: number;
        pairSessionId: string;
      } {
    const h = requireHandle('startPairing');
    const opts = typeof input === 'string' ? { appId: input } : input;
    if (!isAppType(opts.appId)) {
      throw new Error(
        `startPairing requires a valid appId; received ${JSON.stringify(opts.appId)}.`,
      );
    }
    const pairSessionId = typeof input === 'string' ? undefined : randomUUID();
    const session = h.pairingStore.createPendingSession(opts.appId, {
      ...(pairSessionId ? { pairSessionId } : {}),
    });
    const now = Date.now();
    const expiresInSeconds = Math.max(
      1,
      Math.floor((session.expiresAt - now) / 1000),
    );

    if (pairSessionId) {
      activePairSessions.set(pairSessionId, {
        pairSessionId,
        appId: opts.appId,
        browserId: opts.browserId,
        createdAt: now,
        ttlMs: ACTIVE_PAIR_SESSION_TTL_MS,
      });
      // Subscribe the translator at the same moment the active session
      // becomes tracked so the renderer-facing `connector:status-changed`
      // broadcast is wired up for every emit from this pair session.
      // Subscribing here (rather than inside the route handlers) keeps
      // the subscription lifecycle symmetric with `activePairSessions`,
      // and `unsubscribePairSessionBus()` at every `.delete()` site
      // keeps the map balanced without tying to manager lifecycle.
      subscribePairSessionBus(pairSessionId);
      errorReporter.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.pair-start',
        data: {
          appId: opts.appId,
          browserId: opts.browserId,
          pairSessionId,
          expiresAt: session.expiresAt,
        },
      });
      log.info(
        {
          appId: opts.appId,
          browserId: opts.browserId,
          pairSessionId,
          expiresAt: session.expiresAt,
        },
        'App Bridge pair-start minted for agent-managed install session',
      );
      return {
        code: session.code,
        expiresAt: session.expiresAt,
        expiresInSeconds,
        pairSessionId,
      };
    }

    errorReporter.addBreadcrumb({
      category: 'app-bridge.pair',
      level: 'info',
      message: 'pair-start',
      data: { appId: opts.appId, expiresAt: session.expiresAt },
    });
    log.info(
      { appId: opts.appId, expiresAt: session.expiresAt },
      'App Bridge pair-start minted via direct manager call',
    );
    return {
      code: session.code,
      expiresAt: session.expiresAt,
      expiresInSeconds,
    };
  }

  function getPendingApprovalSnapshots(now = Date.now()): PendingApproval[] {
    const list: PendingApproval[] = [];
    for (const [pendingApprovalId, entry] of pendingTofuPairings.entries()) {
      const expiresAt = entry.createdAt + entry.ttlMs;
      if (now < expiresAt) {
        const fingerprint = formatExtensionIdFingerprint(entry.extensionId);
        list.push({
          pendingApprovalId,
          fingerprint,
          extensionId: fingerprint,
          inferredBrowserId: entry.inferredBrowserId,
          createdAt: entry.createdAt,
          expiresAt,
        });
      }
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  function listPendingApprovals(): PendingApproval[];
  function listPendingApprovals(pairSessionId: string): PendingApproval[];
  function listPendingApprovals(pairSessionId?: string): PendingApproval[] {
    const all = getPendingApprovalSnapshots();
    if (!pairSessionId) {
      return all;
    }
    const resolvedPairSessionId = resolveInstallSessionAlias(pairSessionId);
    const session = getLiveActivePairSession(resolvedPairSessionId);
    if (!session) return [];
    return all.filter(
      (entry) =>
        entry.createdAt >= session.createdAt &&
        (session.browserId == null || entry.inferredBrowserId === session.browserId),
    );
  }

  function getGlobalPairStatus(): {
    paired: { appId: string; clientId: string }[];
    hasPending: boolean;
    activeSessionCount: number;
    degraded?: 'trust-persist-failed';
  } {
    maybeBindNewTokensToPairSessions();
    const paired = handle
      ? handle.tokenStore.listAppTokens().map((entry) => ({
          appId: entry.appId,
          clientId: entry.clientId,
        }))
      : [];
    return {
      paired,
      hasPending: pendingTofuPairings.size > 0,
      activeSessionCount: getActivePairSessions().length,
      ...(trustPersistenceDegraded
        ? { degraded: 'trust-persist-failed' as const }
        : {}),
    };
  }

  function checkPairStatus(pairSessionId: string): {
    paired: { appId: string; clientId: string }[];
    hasPending: boolean;
    pairSessionExpired: boolean;
    pairSessionNotFound: boolean;
  } {
    maybeBindNewTokensToPairSessions();
    const resolvedPairSessionId = resolveInstallSessionAlias(pairSessionId);
    const session = getLiveActivePairSession(resolvedPairSessionId);
    if (!session) {
      const wasEverKnown = recentlyEndedPairSessionIds.has(resolvedPairSessionId);
      return {
        paired: [],
        hasPending: false,
        pairSessionExpired: wasEverKnown,
        pairSessionNotFound: !wasEverKnown,
      };
    }

    const paired = handle
      ? handle.tokenStore
          .listAppTokens()
          .filter((entry) => entry.pairSessionId === resolvedPairSessionId)
          .map((entry) => ({
            appId: entry.appId,
            clientId: entry.clientId,
          }))
      : [];

    return {
      paired,
      hasPending: listPendingApprovals(resolvedPairSessionId).length > 0,
      pairSessionExpired: false,
      pairSessionNotFound: false,
    };
  }

  function approvePendingApproval(args: {
    pendingApprovalId: string;
    approved: boolean;
    fingerprint: string;
    pairSessionId: string;
  }): {
    ok: boolean;
    reason?:
      | 'already-resolved'
      | 'not-found'
      | 'expired'
      | 'fingerprint-mismatch'
      | 'session-mismatch'
      | 'session-expired'
      | 'session-unbound';
  } {
    const {
      pendingApprovalId,
      approved,
      fingerprint,
      pairSessionId: publicPairSessionId,
    } = args;
    const pairSessionId = resolveInstallSessionAlias(publicPairSessionId);

    const entry = pendingTofuPairings.get(pendingApprovalId);
    if (!entry) {
      const reason = resolvedPendingApprovalIds.has(pendingApprovalId)
        ? 'already-resolved'
        : 'not-found';
      log.info(
        { pendingApprovalId, approved, outcome: reason },
        'App Bridge TOFU resolution for unknown id',
      );
      return { ok: false, reason };
    }

    const now = Date.now();
    if (now - entry.createdAt >= entry.ttlMs) {
      pendingTofuPairings.delete(pendingApprovalId);
      resolvedPendingApprovalIds.add(pendingApprovalId);
      broadcastPendingUpdate();
      entry.resolve(false);
      const expiredData = {
        pendingApprovalId,
        extensionIdSuffix: redactExtensionIdForLog(entry.extensionId),
        pairSessionId: entry.pairSessionId,
      };
      errorReporter.addBreadcrumb({
        category: 'app-bridge.tofu',
        level: 'info',
        message: 'app-bridge.tofu.expired',
        data: expiredData,
      });
      installEvent(log, 'info', 'app-bridge.tofu.expired', expiredData);
      return { ok: false, reason: 'expired' };
    }

    const formattedFingerprint = formatExtensionIdFingerprint(entry.extensionId);
    const fingerprintMatches = fingerprint === formattedFingerprint;
    if (!fingerprintMatches) {
      const fingerprintData = {
        pendingApprovalId,
        pairSessionId,
        extensionIdSuffix: redactExtensionIdForLog(entry.extensionId),
      };
      errorReporter.addBreadcrumb({
        category: 'app-bridge.tofu',
        level: 'warning',
        message: 'app-bridge.tofu.approve-rejected-fingerprint-mismatch',
        data: fingerprintData,
      });
      installEvent(
        log,
        'warn',
        'app-bridge.tofu.approve-rejected-fingerprint-mismatch',
        fingerprintData,
      );
      return { ok: false, reason: 'fingerprint-mismatch' };
    }

    if (entry.pairSessionId == null) {
      const unboundData = {
        pendingApprovalId,
        pairSessionId,
        fingerprintMatch: true,
        decisionLatencyMs: now - entry.createdAt,
        reason: 'session-unbound',
        extensionIdSuffix: redactExtensionIdForLog(entry.extensionId),
      };
      errorReporter.addBreadcrumb({
        category: 'app-bridge.tofu',
        level: 'warning',
        message: 'app-bridge.tofu.rejected',
        data: unboundData,
      });
      installEvent(log, 'warn', 'app-bridge.tofu.rejected', unboundData);
      return { ok: false, reason: 'session-unbound' };
    }

    if (pairSessionId !== LEGACY_SETTINGS_SESSION_ID) {
      const session = getLiveActivePairSession(pairSessionId);
      if (!session) {
        const sessionExpiredData = {
          pendingApprovalId,
          pairSessionId,
          fingerprintMatch: true,
          decisionLatencyMs: now - entry.createdAt,
          reason: 'session-expired',
          extensionIdSuffix: redactExtensionIdForLog(entry.extensionId),
        };
        errorReporter.addBreadcrumb({
          category: 'app-bridge.tofu',
          level: 'warning',
          message: 'app-bridge.tofu.rejected',
          data: sessionExpiredData,
        });
        installEvent(log, 'warn', 'app-bridge.tofu.rejected', sessionExpiredData);
        return { ok: false, reason: 'session-expired' };
      }
      if (
        entry.pairSessionId !== pairSessionId ||
        (session.browserId != null &&
          entry.inferredBrowserId != null &&
          entry.inferredBrowserId !== session.browserId)
      ) {
        const mismatchData = {
          pendingApprovalId,
          pairSessionId,
          fingerprintMatch: true,
          decisionLatencyMs: now - entry.createdAt,
          reason: 'session-mismatch',
          extensionIdSuffix: redactExtensionIdForLog(entry.extensionId),
        };
        errorReporter.addBreadcrumb({
          category: 'app-bridge.tofu',
          level: 'warning',
          message: 'app-bridge.tofu.rejected',
          data: mismatchData,
        });
        installEvent(log, 'warn', 'app-bridge.tofu.rejected', mismatchData);
        return { ok: false, reason: 'session-mismatch' };
      }
    }

    pendingTofuPairings.delete(pendingApprovalId);
    resolvedPendingApprovalIds.add(pendingApprovalId);
    broadcastPendingUpdate();
    if (approved) {
      rememberTrustedExtensionIdForSession(pairSessionId, entry.extensionId);
    }
    entry.resolve(approved);

    log.info(
      {
        pendingApprovalId,
        extensionIdSuffix: redactExtensionIdForLog(entry.extensionId),
        outcome: approved ? 'approved' : 'rejected',
        decisionLatencyMs: now - entry.createdAt,
        pairSessionId,
      },
      approved ? 'App Bridge TOFU approval granted' : 'App Bridge TOFU approval rejected',
    );
    const outcomeData = {
      pendingApprovalId,
      pairSessionId,
      fingerprintMatch: true,
      decisionLatencyMs: now - entry.createdAt,
      ...(approved ? {} : { reason: 'user-rejected' }),
      extensionIdSuffix: redactExtensionIdForLog(entry.extensionId),
    };
    errorReporter.addBreadcrumb({
      category: 'app-bridge.tofu',
      level: 'info',
      message: approved ? 'app-bridge.tofu.approved' : 'app-bridge.tofu.rejected',
      data: outcomeData,
    });
    installEvent(
      log,
      'info',
      approved ? 'app-bridge.tofu.approved' : 'app-bridge.tofu.rejected',
      outcomeData,
    );
    return { ok: true };
  }

  function endPairSession(
    pairSessionId: string,
    options?: { stage?: string; reason?: string },
  ): void {
    const resolvedPairSessionId = resolveInstallSessionAlias(pairSessionId);
    cleanupPairSession(
      resolvedPairSessionId,
      options?.stage ?? 'end-pair-session',
      options?.reason ?? 'session-ended',
    );
  }

  function hasActivePairSession(pairSessionId: string): boolean {
    return getLiveActivePairSession(resolveInstallSessionAlias(pairSessionId)) !== null;
  }

  function getActivePairSessionForBrowser(browserId: BrowserId): string | undefined {
    const now = Date.now();
    return Array.from(activePairSessions.values())
      .filter((session) => session.browserId === browserId && !isPairSessionExpired(session, now))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
      ?.pairSessionId;
  }

  function hasAnyActivePairSessionForBrowser(browserId: BrowserId): boolean {
    return getActivePairSessionForBrowser(browserId) !== undefined;
  }

  function getActivePairSessions(): readonly Pick<
    ActivePairSession,
    'pairSessionId' | 'browserId'
  >[] {
    const now = Date.now();
    return Array.from(activePairSessions.values())
      .filter((session) => !isPairSessionExpired(session, now))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => ({
        pairSessionId: session.pairSessionId,
        browserId: session.browserId,
      }));
  }

  return {
    start,
    stop,
    isRunning: () => handle !== null,
    getState: () => (handle ? toState(handle) : null),
    getSkipReason: () => skipReason,
    getHttpBaseForIpc: () => (handle ? `http://127.0.0.1:${handle.port}` : null),
    getRouterTokenForIpc: () => (handle ? handle.routerInternalToken : null),
    listPairedClients,
    listPairedExtensionIds,
    revokePairedClient,
    revokeAllPairedClients,
    restartWithDynamicPort,
    startPairing,
    getGlobalPairStatus,
    checkPairStatus,
    listPendingApprovals,
    approvePendingApproval,
    endPairSession,
    resetInstall,
    hasActivePairSession,
    hasAnyActivePairSessionForBrowser,
    getActivePairSessionForBrowser,
    getActivePairSessions,
    getExtensionVersionStatus,
  };
}
