import {
  clearSessionToken,
  ensureClientId,
  LOCAL_AUTH_STORAGE_KEY,
  mintSessionTokenFromBootToken,
  migrateLegacyLocalToken,
  persistSessionToken,
  readAuthSnapshot,
  readBootTokenFileFromBundle,
  readInstallStatus,
  SESSION_AUTH_STORAGE_KEY,
  type InstallStatus,
  writeInstallStatus,
} from '../lib/browserAuth';
import { getCapabilities } from '../lib/capabilities';
import { createLogger } from '../lib/logger';
import {
  computeMatchPattern,
  displayOriginForUser,
} from '../permissions/originMatch';
import {
  clearPendingForOrigin,
  clearPendingForTabNavigation,
  dropTabFromPending,
  setPending,
  writeLastRevokedMarker,
} from '../permissions/permissionState';
import contentScriptUrl from '../content/contentScript.ts?script';

const log = createLogger({ prefix: '[sw]' });

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const KEEPALIVE_ALARM = 'rebel-ext-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 1;
const MINT_BACKOFF_MS = [2_000, 5_000, 15_000] as const;
const LAST_INSTALL_SESSION_KEY = 'rebel.lastInstallSessionId';

// When the desktop app re-extracts the extension, it writes a new
// `installSessionId` into `rebel-boot-token.json`. Chromium keeps
// running the OLD service worker bundle even though new files are
// on disk (unpacked extensions do not auto-reload on file change).
// This check compares the on-disk `installSessionId` against the
// last one we saw; if it changed we call `chrome.runtime.reload()`
// so the fresh SW picks up the new `assets/*.js` bundles.
//
// Safe against reload loops: after reload, the new SW sees the
// stored id matches the on-disk id (we persist BEFORE reloading).
export async function reloadIfBundleChanged(): Promise<void> {
  try {
    const tokenResult = await readBootTokenFileFromBundle();
    if (!tokenResult.ok) return;
    const currentId = tokenResult.bootToken.installSessionId;
    const stored = await chrome.storage.local.get(LAST_INSTALL_SESSION_KEY);
    const previousId = stored[LAST_INSTALL_SESSION_KEY];
    if (typeof previousId !== 'string' || previousId.length === 0) {
      await chrome.storage.local.set({ [LAST_INSTALL_SESSION_KEY]: currentId });
      return;
    }
    if (previousId === currentId) return;
    await chrome.storage.local.set({ [LAST_INSTALL_SESSION_KEY]: currentId });
    log.info(
      { previousId, currentId },
      'install-session changed on disk — reloading extension to pick up new bundle',
    );
    chrome.runtime.reload();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'reloadIfBundleChanged failed');
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  const runtime = (chrome as typeof chrome & {
    offscreen?: typeof chrome.offscreen;
  }).offscreen;
  if (!runtime) return false;
  const ctxApi = (chrome.runtime as unknown as {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
  }).getContexts;
  if (!ctxApi) {
    const legacy = (runtime as unknown as { hasDocument?: () => Promise<boolean> }).hasDocument;
    if (legacy) return legacy();
    return false;
  }
  const contexts = await ctxApi({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  const runtime = (chrome as typeof chrome & {
    offscreen?: typeof chrome.offscreen;
  }).offscreen;
  if (!runtime) {
    log.error('offscreen API unavailable — Chrome 116+ required');
    return;
  }
  if (await hasOffscreenDocument()) return;
  try {
    await runtime.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: 'Maintains the long-lived WebSocket to the Rebel App Bridge.',
    });
    log.info('offscreen document created');
  } catch (err) {
    log.error('failed to create offscreen document', err);
  }
}

async function broadcastConnectionStatus(status: InstallStatus): Promise<void> {
  await Promise.allSettled([
    chrome.runtime.sendMessage({ target: 'popup', type: 'connection-status', status }),
    chrome.runtime.sendMessage({ target: 'sidepanel', type: 'connection-status', status }),
  ]);
}

/**
 * Canonicalize a permission-grant origin into the same `scheme://host`
 * shape the bridge's `wsServer` event handler stores via `canonicalizeOrigin`.
 * Without this, `https://example.com/` and `https://example.com` would be
 * stored under two different keys and the relay's awaitGrant lookup would
 * miss. Falls back to the raw value if the URL cannot be parsed — that
 * branch is reachable only for malformed permission entries.
 */
function canonicalizeBridgeEventOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`;
  } catch {
    return origin;
  }
}

/**
 * Forward a permission-related bridge event to the offscreen WS runner so
 * it can push it on the active transport. Best effort: drops silently if
 * offscreen isn't running (the bridge's recency window catches up the next
 * time a dispatch arrives within 5 s).
 */
async function forwardBridgeEventToOffscreen(
  event: 'permission-granted',
  origin: string,
  at: number,
): Promise<void> {
  await ensureOffscreen();
  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'bridge-event',
      event,
      origin,
      at,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('Receiving end does not exist')
    ) {
      log.debug({ origin }, 'offscreen unavailable — bridge event will rely on recency window');
      return;
    }
    log.warn({ err, origin }, 'forwardBridgeEventToOffscreen failed');
  }
}

// `chrome.storage` is NOT exposed to offscreen documents in Chromium
// (only `chrome.runtime` is). Every auth read or write must therefore
// happen in the service worker, which forwards a snapshot to the
// offscreen doc. This helper is the single outbound channel.
async function pushAuthSnapshotToOffscreen(): Promise<void> {
  try {
    const snapshot = await readAuthSnapshot();
    await chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'auth-snapshot', snapshot })
      .catch(() => undefined);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'pushAuthSnapshotToOffscreen failed');
  }
}

async function setInstallBadge(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' });
  } catch (error) {
    log.warn('failed to set install badge', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function enableSidePanelActionClick(): Promise<void> {
  const sidePanel = (chrome as typeof chrome & {
    sidePanel?: TabAwareSidePanelApi;
  }).sidePanel;
  if (!sidePanel || typeof sidePanel.setPanelBehavior !== 'function') {
    return;
  }
  try {
    await sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    log.warn('sidePanel.setPanelBehavior failed', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export class BrowserInstallController {
  private currentStatus: InstallStatus = { kind: 'idle' };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private wakeInFlight: Promise<void> | null = null;

  constructor(
    private readonly ensureOffscreenDocument: () => Promise<void> = ensureOffscreen,
  ) {}

  async hydrate(): Promise<void> {
    this.currentStatus = await readInstallStatus();
  }

  async getStatus(): Promise<InstallStatus> {
    return this.currentStatus;
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async setStatus(status: InstallStatus): Promise<void> {
    this.currentStatus = status;
    await writeInstallStatus(status);
    await broadcastConnectionStatus(status);
  }

  private scheduleRetry(status: InstallStatus, delayMs: number): void {
    this.clearRetry();
    void this.setStatus(status);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.handleWake();
    }, delayMs);
  }

  private async runWake(): Promise<void> {
    await this.ensureOffscreenDocument();
    await migrateLegacyLocalToken();
    const clientId = await ensureClientId();
    const auth = await readAuthSnapshot();
    if (auth.token) {
      return;
    }

    const bootTokenResult = await readBootTokenFileFromBundle().catch(() => ({
      ok: false,
      kind: 'boot-token-missing',
    } as const));

    if (!bootTokenResult.ok) {
      this.retryAttempt = 0;
      this.clearRetry();
      await this.setStatus({ kind: 'boot-token-missing' });
      return;
    }

    const mintResult = await mintSessionTokenFromBootToken({
      bootToken: bootTokenResult.bootToken,
      clientId,
      extensionId: chrome.runtime.id,
    });

    if (mintResult.ok) {
      this.retryAttempt = 0;
      this.clearRetry();
      await persistSessionToken({
        token: mintResult.token,
        installSessionId: mintResult.installSessionId,
      });
      await this.setStatus({ kind: 'connecting', port: mintResult.port });
      // Prime the offscreen cache BEFORE nudging it to reconnect so the
      // runner's connectLoop sees an up-to-date snapshot on its first
      // readStoredAuth() call rather than racing the round-trip.
      await pushAuthSnapshotToOffscreen();
      await chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'mint-updated' })
        .catch(() => undefined);
      return;
    }

    switch (mintResult.kind) {
      case 'mint-failed-transient': {
        this.retryAttempt = Math.min(this.retryAttempt + 1, MINT_BACKOFF_MS.length);
        const delayMs = MINT_BACKOFF_MS[this.retryAttempt - 1] ?? 15_000;
        this.scheduleRetry(
          { kind: 'mint-failed-transient', attempt: this.retryAttempt },
          delayMs,
        );
        return;
      }
      case 'port-stale': {
        this.retryAttempt = 1;
        this.scheduleRetry({ kind: 'port-stale' }, MINT_BACKOFF_MS[0]);
        return;
      }
      case 'mint-rate-limited': {
        this.retryAttempt = 0;
        this.scheduleRetry(
          { kind: 'mint-rate-limited', retryAfterMs: mintResult.retryAfterMs },
          mintResult.retryAfterMs,
        );
        return;
      }
      case 'mint-forbidden': {
        this.retryAttempt = 0;
        this.clearRetry();
        await this.setStatus({
          kind: 'mint-forbidden',
          ...(mintResult.reason ? { reason: mintResult.reason } : {}),
        });
        return;
      }
    }
  }

  async handleWake(): Promise<void> {
    if (this.wakeInFlight) {
      return this.wakeInFlight;
    }
    this.wakeInFlight = this.runWake().finally(() => {
      this.wakeInFlight = null;
    });
    return this.wakeInFlight;
  }

  async requestReconnect(): Promise<void> {
    const auth = await readAuthSnapshot();
    if (!auth.token) {
      await this.handleWake();
      return;
    }
    await this.ensureOffscreenDocument();
    await chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'reconnect-now' })
      .catch(() => undefined);
  }

  async handleOffscreenStatus(status: InstallStatus): Promise<void> {
    if (
      status.kind !== 'connecting' &&
      status.kind !== 'registering' &&
      status.kind !== 'connected' &&
      status.kind !== 'reconnecting'
    ) {
      return;
    }
    if (status.kind === 'connected') {
      this.retryAttempt = 0;
      this.clearRetry();
    }
    if (status.kind === 'reconnecting') {
      this.retryAttempt = status.attempt;
    }
    await this.setStatus(status);
  }

  async handleAuthInvalidated(reason: 'revoked-by-user' = 'revoked-by-user'): Promise<void> {
    this.retryAttempt = 0;
    this.clearRetry();
    await clearSessionToken();
    await this.setStatus({ kind: reason });
    // Also clear the offscreen cache so its next connectLoop exits
    // cleanly instead of attempting to register with a revoked token.
    await pushAuthSnapshotToOffscreen();
  }
}

interface TabContextPayload {
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
}

interface DispatchCapabilityEnvelope {
  target: 'service-worker';
  type: 'dispatch-capability';
  action: string;
  params: Record<string, unknown>;
  tabContext?: TabContextPayload;
}

type ActiveScopeChangeReason =
  | 'requested'
  | 'tab-activated'
  | 'tab-updated'
  | 'tab-removed'
  | 'window-focus-changed';

interface E2ETabTarget {
  url: string;
  title?: string;
  text?: string;
}

interface E2EHookApi {
  seedPairing(input: { clientId: string; token: string }): Promise<void>;
  reconnect(): Promise<void>;
  sendConversationIntent(input: {
    port: number;
    clientId: string;
    token: string;
    intent: string;
    target: E2ETabTarget;
  }): Promise<{ status: number; body: unknown }>;
  sendStoredConversationIntent(input: {
    port: number;
    intent: string;
    target: E2ETabTarget;
  }): Promise<{ status: number; body: unknown }>;
  clearPendingState(): Promise<void>;
  forceGrant(origin: string): Promise<boolean>;
  revokeGrant(origin: string): Promise<boolean>;
}

interface ContentSuccessResponse {
  ok: true;
  data: unknown;
}

interface ContentErrorResponse {
  ok: false;
  code?: string;
  reason?: string;
  error?: string;
  details?: Record<string, unknown>;
}

type ContentResponse = ContentSuccessResponse | ContentErrorResponse;

/**
 * Pinned Chromium error messages we classify as "no host permission" — the
 * one failure mode where `chrome.permissions.request` is the right next step.
 *
 * Everything else maps to `request-failed` (structural classification —
 * never silently to `denied-by-user`). When Chromium changes the wording,
 * the E2E `content-script-injection.spec.ts` fails loudly so this list stays
 * honest; see plan §9.
 */
export const NO_HOST_PERMISSION_MESSAGES: readonly RegExp[] = [
  /Cannot access (contents of|the )/i,
  /Missing host permission/i,
  /No tab with id/i,
];

function errorMatchesNoHostPermission(message: string): boolean {
  return NO_HOST_PERMISSION_MESSAGES.some((pattern) => pattern.test(message));
}

const UNSUPPORTED_PROTOCOLS = new Set([
  'chrome:',
  'edge:',
  'about:',
  'chrome-extension:',
  'moz-extension:',
]);

function normalizeTabLocation(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin.toLowerCase()}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function isUnsupportedSurfaceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (UNSUPPORTED_PROTOCOLS.has(parsed.protocol)) {
      return true;
    }
    return parsed.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

function hasTabContextDiverged(
  tabContext: TabContextPayload | undefined,
  tab: chrome.tabs.Tab,
): boolean {
  if (typeof tabContext?.url !== 'string' || tabContext.url.length === 0) {
    return false;
  }
  if (typeof tab.url !== 'string' || tab.url.length === 0) {
    return true;
  }
  const expected = normalizeTabLocation(tabContext.url);
  const actual = normalizeTabLocation(tab.url);
  if (!expected || !actual) {
    return true;
  }
  return expected !== actual;
}

async function resolveTargetTab(
  tabContext: TabContextPayload | undefined,
): Promise<
  | { ok: true; tab: chrome.tabs.Tab }
  | { ok: false; code: string; reason?: string; error?: string }
> {
  if (tabContext && typeof tabContext.tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(tabContext.tabId);
      if (!tab || typeof tab.id !== 'number') {
        return { ok: false, code: 'TAB_CONTEXT_GONE', reason: 'tab_not_found' };
      }
      if (hasTabContextDiverged(tabContext, tab)) {
        return {
          ok: false,
          code: 'TAB_CONTEXT_DIVERGED',
          reason: 'tab_url_changed',
        };
      }
      return { ok: true, tab };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: 'TAB_CONTEXT_GONE',
        reason: 'tab_get_failed',
        error: msg,
      };
    }
  }

  return { ok: false, code: 'TAB_CONTEXT_GONE', reason: 'missing_tab_context' };
}

function tabToContext(tab: chrome.tabs.Tab | undefined): TabContextPayload | null {
  if (!tab || typeof tab.id !== 'number') return null;
  return {
    tabId: tab.id,
    ...(typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {}),
    ...(typeof tab.url === 'string' && tab.url.length > 0 ? { url: tab.url } : {}),
    ...(typeof tab.title === 'string' && tab.title.length > 0 ? { title: tab.title } : {}),
  };
}

async function getActiveTabContext(windowId?: number): Promise<TabContextPayload | null> {
  try {
    const query: chrome.tabs.QueryInfo =
      typeof windowId === 'number'
        ? { active: true, windowId }
        : { active: true, currentWindow: true };
    const tabs = await chrome.tabs.query(query);
    return tabToContext(tabs[0]);
  } catch {
    return null;
  }
}

async function broadcastScopeChanged(
  reason: ActiveScopeChangeReason,
  windowId?: number,
): Promise<void> {
  const tabContext = await getActiveTabContext(windowId);
  await chrome.runtime
    .sendMessage({
      target: 'sidepanel',
      type: 'scope-changed',
      reason,
      ...(tabContext ? { tabContext } : {}),
      ...(typeof (tabContext?.windowId ?? windowId) === 'number'
        ? { windowId: tabContext?.windowId ?? windowId }
        : {}),
    })
    .catch(() => undefined);
}

type InjectionRefusedReason =
  | 'no-host-permission'
  | 'denied-by-user'
  | 'unsupported-scheme'
  | 'chrome-blocked'
  | 'request-failed'
  | 'transient';

function injectionRefused({
  origin,
  reason,
  retryable,
  capability,
  error,
}: {
  origin: string;
  reason: InjectionRefusedReason;
  retryable: boolean;
  capability: string;
  error?: string;
}): ContentErrorResponse {
  const details: Record<string, unknown> = {
    origin,
    displayOrigin: displayOriginForUser(origin),
    reason,
    retryable,
    capability,
  };
  if (error) details.error = error;
  return {
    ok: false,
    code: 'INJECTION_REFUSED',
    reason,
    error: error ?? `injection_refused:${reason}`,
    details,
  };
}

export async function dispatchCapability(
  env: DispatchCapabilityEnvelope,
): Promise<ContentResponse> {
  // `status` is a host-level capability — the agent only wants tab metadata.
  // It must work on a fresh install with zero granted origins and no content
  // script injection. See plan Finding F / §8.
  if (env.action === 'status') {
    return handleStatusDispatch(env.tabContext);
  }

  const resolved = await resolveTargetTab(env.tabContext);
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.reason ? { reason: resolved.reason } : {}),
      ...(resolved.error ? { error: resolved.error } : {}),
    };
  }
  const { tab } = resolved;
  const tabId = tab.id as number;

  if (typeof tab.url === 'string' && isUnsupportedSurfaceUrl(tab.url)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_SURFACE',
      reason: 'unsupported_surface',
    };
  }

  const tabUrl = typeof tab.url === 'string' ? tab.url : undefined;
  const match = computeMatchPattern(tabUrl);
  if (!match.ok) {
    // 'pending' / 'opaque' share the unsupported-scheme UI surface (per the
    // plan) but stay distinct in the `reason` field for logs.
    const reasonForSurface: InjectionRefusedReason = 'unsupported-scheme';
    const origin = tabUrl ?? '';
    log.warn(
      { tabId, capability: env.action, reason: match.reason },
      'dispatchCapability refused: unsupported tab URL',
    );
    return injectionRefused({
      origin,
      reason: reasonForSurface,
      retryable: false,
      capability: env.action,
      error: `url_reason:${match.reason}`,
    });
  }

  const hasPerm = await chromePermissionsContains(match.matchPattern);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [contentScriptUrl],
      // Keep this explicit as a drift guard in case Chromium changes defaults.
      world: 'ISOLATED',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const classification = classifyInjectionError({ message: msg, hasPerm });
    if (classification.reason === 'no-host-permission') {
      await recordPendingPermission({
        origin: match.origin,
        tabId,
        tab,
        capability: env.action,
      });
    }
    log.warn(
      {
        tabId,
        capability: env.action,
        reason: classification.reason,
        hasPerm,
      },
      'content script injection refused',
    );
    return injectionRefused({
      origin: match.origin,
      reason: classification.reason,
      retryable: classification.retryable,
      capability: env.action,
      error: msg,
    });
  }

  try {
    const resp = (await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      type: 'capability',
      capability: env.action,
      payload: env.params,
      ctx: {
        tabId,
        ...(typeof tab.url === 'string' ? { url: tab.url } : {}),
      },
    })) as ContentResponse | undefined;
    if (!resp) {
      // Empty response typically indicates the content script or tab
      // disappeared mid-dispatch. Surface as transient so the agent can
      // retry rather than treating it as a permission problem.
      return injectionRefused({
        origin: match.origin,
        reason: 'transient',
        retryable: true,
        capability: env.action,
        error: 'empty_response',
      });
    }
    return resp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const classification = classifyInjectionError({ message: msg, hasPerm });
    log.warn(
      { tabId, capability: env.action, reason: classification.reason },
      'content script post-injection call failed',
    );
    if (classification.reason === 'no-host-permission') {
      await recordPendingPermission({
        origin: match.origin,
        tabId,
        tab,
        capability: env.action,
      });
    }
    return injectionRefused({
      origin: match.origin,
      reason: classification.reason,
      retryable: classification.retryable,
      capability: env.action,
      error: msg,
    });
  }
}

async function handleStatusDispatch(tabContext?: TabContextPayload): Promise<ContentResponse> {
  let tab: chrome.tabs.Tab | undefined;
  if (typeof tabContext?.tabId === 'number') {
    const resolved = await resolveTargetTab(tabContext);
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.code,
        ...(resolved.reason ? { reason: resolved.reason } : {}),
        ...(resolved.error ? { error: resolved.error } : {}),
      };
    }
    tab = resolved.tab;
  } else {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs[0];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'INTERNAL_ERROR', error: msg };
    }
  }
  const installStatus = await readInstallStatus().catch(() => ({ kind: 'idle' } as InstallStatus));
  return {
    ok: true,
    data: {
      tabId: typeof tab?.id === 'number' ? tab.id : null,
      windowId: typeof tab?.windowId === 'number' ? tab.windowId : null,
      url: typeof tab?.url === 'string' ? tab.url : null,
      title: typeof tab?.title === 'string' ? tab.title : null,
      capabilities: getCapabilities(),
      installStatus,
    },
  };
}

interface ClassifiedInjectionError {
  reason: InjectionRefusedReason;
  retryable: boolean;
}

function classifyInjectionError({
  message,
  hasPerm,
}: {
  message: string;
  hasPerm: boolean;
}): ClassifiedInjectionError {
  // Chrome uses this shape for chrome:// / WebUI / PDFs / devtools surfaces.
  if (/The extensions gallery cannot be scripted/i.test(message)) {
    return { reason: 'chrome-blocked', retryable: false };
  }
  if (errorMatchesNoHostPermission(message)) {
    return { reason: 'no-host-permission', retryable: true };
  }
  if (!hasPerm) {
    // contains() said no, we tried activeTab, and the message wasn't in our
    // pinned set. Most likely a policy / managed-browser reject or a blocked
    // surface we don't otherwise recognise. Surface as request-failed so the
    // UX gives the user actionable guidance rather than a fake denial.
    return { reason: 'request-failed', retryable: true };
  }
  return { reason: 'transient', retryable: true };
}

async function chromePermissionsContains(matchPattern: string): Promise<boolean> {
  const perms = (chrome as typeof chrome & {
    permissions?: {
      contains(options: { origins?: string[] }): Promise<boolean>;
    };
  }).permissions;
  if (!perms || typeof perms.contains !== 'function') {
    return false;
  }
  try {
    return await perms.contains({ origins: [matchPattern] });
  } catch {
    return false;
  }
}

async function recordPendingPermission({
  origin,
  tabId,
  tab,
  capability,
}: {
  origin: string;
  tabId: number;
  tab: chrome.tabs.Tab;
  capability: string;
}): Promise<void> {
  const displayName =
    typeof tab.title === 'string' && tab.title.trim().length > 0
      ? tab.title.trim()
      : displayOriginForUser(origin);
  await setPending({ origin, capability, tabId, displayName });
}

// ---------------------------------------------------------------------------
// Test-only E2E hooks — gated by `import.meta.env.MODE === 'test'`.
// Vite substitutes MODE at build time; production builds collapse the gate
// to `'production' === 'test'` (dead code), which Rollup tree-shakes out.
// The `scripts/check-extension-dist-bundled.ts` guard asserts the final
// `dist/assets/**/*.js` contains zero matches of `__rebelE2E__`.
// See plan Key Decision 13 / §Test-only surface gating.
// ---------------------------------------------------------------------------
if (import.meta.env.MODE === 'test') {
  const e2eGlobal = globalThis as typeof globalThis & {
    __rebelE2E__?: Record<string, unknown>;
  };
  const permissionsApi = (chrome as typeof chrome & {
    permissions?: {
      request(options: { origins?: string[] }): Promise<boolean>;
      remove(options: { origins?: string[] }): Promise<boolean>;
    };
  }).permissions;
  const hooks: E2EHookApi = {
    async seedPairing({ clientId, token }) {
      await chrome.storage.local.set({
        [LOCAL_AUTH_STORAGE_KEY]: { clientId },
      });
      await chrome.storage.session.set({
        [SESSION_AUTH_STORAGE_KEY]: {
          token,
          installSessionId: 'inst_e2e_seeded',
        },
      });
    },
    async reconnect() {
      await ensureOffscreen();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'reconnect-now',
          });
          return;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes('Receiving end does not exist') ||
            attempt === 9
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    },
    async sendConversationIntent({ port, clientId, token, intent, target }) {
      const tabs = await chrome.tabs.query({});
      const targetTab = tabs.find((tab) => tab.url === target.url);
      if (!targetTab?.id) {
        throw new Error(`Could not find target tab for ${target.url}`);
      }

      const response = await fetch(
        `http://127.0.0.1:${port}/intent/conversation/create`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'x-rebel-app-id': 'browser-extension',
            'x-rebel-client-id': clientId,
          },
          body: JSON.stringify({
            appId: 'browser-extension',
            clientId,
            intent,
            tabContext: {
              tabId: targetTab.id,
              windowId: targetTab.windowId,
              url: target.url,
              title: target.title,
            },
            pageContext: {
              url: target.url,
              title: target.title,
              text: target.text,
            },
          }),
        },
      );
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
    async sendStoredConversationIntent({ port, intent, target }) {
      const auth = await readAuthSnapshot();
      if (!auth.clientId || !auth.token) {
        throw new Error('No stored auth is available');
      }
      return this.sendConversationIntent({
        port,
        clientId: auth.clientId,
        token: auth.token,
        intent,
        target,
      });
    },
    async clearPendingState() {
      await chrome.storage.session.remove([
        'rebel.pending-permissions.v1',
        'rebel.last-revoked.v1',
      ]);
    },
    async forceGrant(origin) {
      if (!permissionsApi?.request) return false;
      const matchPattern = origin.endsWith('/*') ? origin : `${origin}/*`;
      return permissionsApi.request({ origins: [matchPattern] });
    },
    async revokeGrant(origin) {
      if (!permissionsApi?.remove) return false;
      const matchPattern = origin.endsWith('/*') ? origin : `${origin}/*`;
      const removed = await permissionsApi.remove({ origins: [matchPattern] });
      if (removed) {
        await writeLastRevokedMarker(origin);
        await clearPendingForOrigin(origin);
      }
      return removed;
    },
  };
  e2eGlobal.__rebelE2E__ = { ...(e2eGlobal.__rebelE2E__ ?? {}), ...hooks };
}

interface SidePanelOpenOptions {
  tabId?: number;
  windowId?: number;
}

interface TabAwareSidePanelApi {
  open(options: { tabId?: number; windowId?: number }): Promise<void>;
  setOptions?(options: { tabId?: number; enabled?: boolean; path?: string }): Promise<void>;
  setPanelBehavior?(options: { openPanelOnActionClick: boolean }): Promise<void>;
}

async function openSidePanel(
  options: SidePanelOpenOptions,
): Promise<{ ok: boolean; error?: string; fallback?: 'window' }> {
  const sidePanel = (chrome as typeof chrome & {
    sidePanel?: TabAwareSidePanelApi;
  }).sidePanel;
  if (!sidePanel || typeof sidePanel.open !== 'function') {
    log.warn('sidePanel API unavailable — Chrome 116+ required');
    return { ok: false, error: 'api_unavailable' };
  }
  if (typeof options.tabId === 'number') {
    try {
      if (typeof sidePanel.setOptions === 'function') {
        await sidePanel.setOptions({ tabId: options.tabId, enabled: true });
      } else {
        log.warn(
          { diagnosticCode: 'tab_pinning_unsupported', tabId: options.tabId },
          'sidePanel.setOptions unavailable — falling back if tab open is unsupported',
        );
      }
      await sidePanel.open({ tabId: options.tabId });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        { diagnosticCode: 'tab_pinning_unsupported', tabId: options.tabId, detail: msg },
        'sidePanel.open by tab failed — falling back to window scope',
      );
    }
  }
  if (typeof options.windowId !== 'number') {
    return { ok: false, error: 'missing_side_panel_target' };
  }
  try {
    await sidePanel.open({ windowId: options.windowId });
    return typeof options.tabId === 'number'
      ? { ok: true, fallback: 'window' }
      : { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ detail: msg }, 'sidePanel.open failed');
    return { ok: false, error: msg };
  }
}

const isVitest =
  Boolean((import.meta as ImportMeta & { vitest?: unknown }).vitest) ||
  '__vitest_worker__' in globalThis;

const installController = new BrowserInstallController();

function wakeInstallController(): Promise<void> {
  return installController.handleWake().catch((err) => {
    log.warn(
      { detail: err instanceof Error ? err.message : String(err) },
      'install controller wake failed',
    );
  });
}

function scheduleWakeInstallController(): void {
  if (isVitest) return;
  void wakeInstallController();
}

chrome.runtime.onInstalled.addListener((details) => {
  log.info('onInstalled', { reason: details.reason });
  chrome.alarms.create(KEEPALIVE_ALARM, {
    periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
  });
  void enableSidePanelActionClick();
  if (details.reason === 'install') {
    void setInstallBadge();
  }
  scheduleWakeInstallController();
});

chrome.runtime.onStartup.addListener(() => {
  log.info('onStartup');
  void enableSidePanelActionClick();
  scheduleWakeInstallController();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    scheduleWakeInstallController();
    // Liveness probe: ask offscreen whether its WS is actually open.
    // If offscreen has been evicted or the socket silently died, the
    // `verify-alive` handler kicks runner.start(). Failures are
    // expected (no offscreen yet) and intentionally swallowed.
    void chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'verify-alive' })
      .catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  const envelope = msg as {
    target?: string;
    type?: string;
    tabId?: number;
    windowId?: number;
    status?: InstallStatus;
    reason?: 'revoked-by-user';
    origin?: string;
  };
  if (envelope.target !== 'service-worker') return false;
  if (envelope.type === 'ensure-offscreen') {
    void ensureOffscreen().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (envelope.type === 'get-auth-snapshot') {
    // Offscreen docs cannot access chrome.storage; they ask the SW and
    // we read on their behalf. See pushAuthSnapshotToOffscreen.
    void readAuthSnapshot()
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch(() =>
        sendResponse({
          ok: false,
          snapshot: {
            clientId: null,
            token: null,
            installSessionId: null,
            fingerprint: null,
          },
        }));
    return true;
  }
  if (envelope.type === 'dispatch-capability') {
    void dispatchCapability(envelope as DispatchCapabilityEnvelope).then(sendResponse);
    return true;
  }
  if (envelope.type === 'open-side-panel') {
    void openSidePanel({
      ...(typeof envelope.tabId === 'number' ? { tabId: envelope.tabId } : {}),
      ...(typeof envelope.windowId === 'number' ? { windowId: envelope.windowId } : {}),
    }).then(sendResponse);
    return true;
  }
  if (envelope.type === 'get-active-scope') {
    void getActiveTabContext(envelope.windowId).then((tabContext) =>
      sendResponse({
        ok: true,
        ...(tabContext ? { tabContext } : {}),
      }),
    );
    return true;
  }
  if (envelope.type === 'get-install-state') {
    void installController.getStatus().then((status) => sendResponse({ status }));
    return true;
  }
  if (envelope.type === 'reconnect-auth') {
    void installController.requestReconnect().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (envelope.type === 'offscreen-status' && envelope.status) {
    void installController.handleOffscreenStatus(envelope.status).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (envelope.type === 'auth-invalidated') {
    void installController
      .handleAuthInvalidated(envelope.reason ?? 'revoked-by-user')
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (envelope.type === 'permission-granted' && typeof envelope.origin === 'string') {
    // The popup / sidepanel Allow handler informs the SW after a successful
    // grant so we can log + clear the pending entry. Storage change events
    // also re-notify surfaces, but the explicit message lets us emit a
    // breadcrumb at grant time (plan §11).
    log.info({ origin: envelope.origin }, 'permission granted by user');
    const grantedOrigin = canonicalizeBridgeEventOrigin(envelope.origin);
    const at = Date.now();
    void clearPendingForOrigin(envelope.origin)
      .then(() => forwardBridgeEventToOffscreen('permission-granted', grantedOrigin, at))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

(() => {
  const tabsApi = chrome.tabs as typeof chrome.tabs & {
    onActivated?: {
      addListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
    onUpdated?: {
      addListener(
        listener: (
          tabId: number,
          changeInfo: chrome.tabs.TabChangeInfo,
          tab: chrome.tabs.Tab,
        ) => void,
      ): void;
    };
    onRemoved?: {
      addListener(listener: (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void): void;
    };
  };
  tabsApi.onActivated?.addListener((activeInfo) => {
    void broadcastScopeChanged('tab-activated', activeInfo.windowId);
  });
  tabsApi.onUpdated?.addListener((_tabId, changeInfo, tab) => {
    if (!tab.active) return;
    if (!changeInfo.url && !changeInfo.title && changeInfo.status !== 'complete') return;
    void broadcastScopeChanged('tab-updated', tab.windowId);
  });
  tabsApi.onRemoved?.addListener((_tabId, removeInfo) => {
    void broadcastScopeChanged('tab-removed', removeInfo.windowId);
  });
  const windowsApi = chrome.windows as typeof chrome.windows & {
    WINDOW_ID_NONE?: number;
    onFocusChanged?: {
      addListener(listener: (windowId: number) => void): void;
    };
  };
  windowsApi.onFocusChanged?.addListener((windowId) => {
    if (windowId === (windowsApi.WINDOW_ID_NONE ?? -1)) return;
    void broadcastScopeChanged('window-focus-changed', windowId);
  });
})();

// ---------------------------------------------------------------------------
// Pending-permission integrity listeners (plan §12, Key Decisions 10 + 12).
// All three sources keep `rebel.pending-permissions.v1` honest:
//   1. Tab closed          → drop tab from every origin's tabIds list.
//   2. Tab committed a nav → drop tab if the new origin differs.
//   3. Permission revoked  → clear pending entry + write revoked marker.
// ---------------------------------------------------------------------------
(() => {
  const webNavigation = (chrome as typeof chrome & {
    webNavigation?: {
      onCommitted: {
        addListener: (
          listener: (details: {
            tabId: number;
            frameId: number;
            url: string;
          }) => void,
        ) => void;
      };
    };
  }).webNavigation;
  if (webNavigation?.onCommitted) {
    webNavigation.onCommitted.addListener((details) => {
      if (details.frameId !== 0) return;
      void clearPendingForTabNavigation(details.tabId, details.url);
    });
  }

  if (chrome.tabs?.onRemoved?.addListener) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      void dropTabFromPending(tabId);
    });
  }

  const permissionsApi = (chrome as typeof chrome & {
    permissions?: {
      onRemoved?: {
        addListener: (
          listener: (permissions: { origins?: string[] }) => void,
        ) => void;
      };
    };
  }).permissions;
  if (permissionsApi?.onRemoved?.addListener) {
    permissionsApi.onRemoved.addListener((permissions) => {
      const origins = permissions.origins ?? [];
      for (const matchPattern of origins) {
        const origin = matchPattern.replace(/\/\*$/, '');
        log.info({ origin }, 'permission removed externally');
        void writeLastRevokedMarker(origin);
        void clearPendingForOrigin(origin);
      }
    });
  }
})();

chrome.action?.onClicked?.addListener((tab) => {
  void openSidePanel({
    ...(typeof tab.id === 'number' ? { tabId: tab.id } : {}),
    ...(typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {}),
  });
});

if (!isVitest) {
  void enableSidePanelActionClick()
    .then(() => reloadIfBundleChanged())
    .then(() => installController.hydrate())
    .then(() => wakeInstallController())
    .catch((err) => {
      log.warn(
        { detail: err instanceof Error ? err.message : String(err) },
        'extension startup wake failed',
      );
    });
}
