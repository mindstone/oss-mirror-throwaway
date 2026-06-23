/**
 * Codex OAuth Token Storage (cross-surface)
 */

import { z } from 'zod';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { EventEmitter } from 'node:events';
import { getSecureTokenStore } from '@core/secureTokenStore';
import { isValidNonEmptyAscii } from '@core/services/safeStorageDecode';
import { getTracker } from '@core/tracking';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';

const log = createScopedLogger({ service: 'codex-token-storage' });

const STORE_NAMESPACE = 'codex-oauth-tokens';
const CODEX_STORE_KEY = 'encryptedTokens';
const CODEX_PENDING_CLOUD_CLEAR_KEY = 'pendingCloudTokenClear';
const TOKEN_KIND = 'codex-oauth-token';

export const CodexTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  accountId: z.string().min(1),
  accountEmail: z.string().nullish(),
});

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  accountEmail?: string;
}

export type CodexAuthTelemetrySurface = 'desktop' | 'cloud' | 'mobile' | 'unknown';
export type CodexAuthTelemetrySource =
  | 'codex_auth_core'
  | 'codex_auth_service'
  | 'codex_sync_channel'
  | 'codex_sync_route'
  | 'secure_token_store'
  | 'cloud_router_sync_guard'
  | 'unknown';

export type CodexTokenSaveCause = 'login_success' | 'refresh_success' | 'sync_update' | 'token_saved';
export type CodexTokenClearCause =
  | 'manual_logout'
  | 'refresh_auth_failure'
  | 'refresh_malformed_response'
  | 'sync_null';
export type CodexAuthDestructiveDisconnectCause =
  | 'refresh_auth_failure'
  | 'refresh_malformed_response'
  | 'corrupt_read'
  | 'sync_null_deletion_attempted';
type CodexAuthDestructiveDisconnectSource =
  | 'codex_auth_core'
  | 'codex_sync_channel'
  | 'codex_sync_route'
  | 'secure_token_store'
  | 'cloud_router_sync_guard';
export type CodexAuthDisconnectedCause = CodexTokenClearCause | 'corrupt_read' | 'sync_null_deletion_attempted';

interface CodexAuthLifecycleTelemetryPayload extends Record<string, unknown> {
  cause: string;
  surface: CodexAuthTelemetrySurface;
  source: CodexAuthTelemetrySource;
  httpStatus?: number;
}

interface CodexAuthLifecycleDetails {
  cause: string;
  source: CodexAuthTelemetrySource;
  httpStatus?: number;
}

export interface SaveCodexTokensContext {
  cause?: CodexTokenSaveCause;
  source?: CodexAuthTelemetrySource;
  httpStatus?: number;
}

export interface ClearCodexTokensContext {
  cause: CodexTokenClearCause;
  source: CodexAuthTelemetrySource;
  httpStatus?: number;
}

export interface CodexAuthDisconnectedTelemetry {
  cause: CodexAuthDisconnectedCause;
  source: CodexAuthTelemetrySource;
  httpStatus?: number;
}

interface CodexTokenStore extends Record<string, unknown> {
  [CODEX_STORE_KEY]?: string;
  [CODEX_PENDING_CLOUD_CLEAR_KEY]?: CodexPendingCloudClearMarker;
}

type CodexPendingCloudClearFailureReason =
  // Eager mark written BEFORE the mutation-null push is attempted, so an app
  // exit during an in-flight POST cannot lose the logout intent. Observed
  // failures refine the reason below; confirmed delivery clears the marker.
  | 'mutation_in_flight'
  | 'mutation_post_failed'
  | 'mutation_skipped_no_client'
  | 'mutation_skipped_no_config';

interface CodexPendingCloudClearMarker {
  setAt: number;
  reason: CodexPendingCloudClearFailureReason;
}

let _store: KeyValueStore<CodexTokenStore> | null = null;
const getStore = (): KeyValueStore<CodexTokenStore> => {
  if (!_store) {
    _store = createStore<CodexTokenStore>({
      name: STORE_NAMESPACE,
      defaults: {} as CodexTokenStore,
    });
  }
  return _store;
};

export const codexTokenEvents = new EventEmitter();

function parsePendingCloudClearMarker(raw: unknown): CodexPendingCloudClearMarker | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const marker = raw as Record<string, unknown>;
  const setAt = marker.setAt;
  const reason = marker.reason;
  if (typeof setAt !== 'number' || !Number.isFinite(setAt)) {
    return null;
  }
  if (
    reason !== 'mutation_in_flight'
    && reason !== 'mutation_post_failed'
    && reason !== 'mutation_skipped_no_client'
    && reason !== 'mutation_skipped_no_config'
  ) {
    return null;
  }
  return {
    setAt,
    reason,
  };
}

export function markPendingCodexCloudClear(reason: CodexPendingCloudClearFailureReason): void {
  getStore().set(CODEX_PENDING_CLOUD_CLEAR_KEY, {
    setAt: Date.now(),
    reason,
  } satisfies CodexPendingCloudClearMarker);
}

export function clearPendingCodexCloudClear(): void {
  getStore().delete(CODEX_PENDING_CLOUD_CLEAR_KEY);
}

export function hasPendingCodexCloudClear(): boolean {
  return parsePendingCloudClearMarker(getStore().get(CODEX_PENDING_CLOUD_CLEAR_KEY)) !== null;
}

function getTelemetrySurface(): CodexAuthTelemetrySurface {
  switch (process.env.REBEL_SURFACE) {
    case 'desktop':
      return 'desktop';
    case 'cloud':
      return 'cloud';
    case 'mobile':
      return 'mobile';
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

function buildLifecyclePayload(details: CodexAuthLifecycleDetails): CodexAuthLifecycleTelemetryPayload {
  const payload: CodexAuthLifecycleTelemetryPayload = {
    cause: details.cause,
    surface: getTelemetrySurface(),
    source: details.source,
  };
  if (details.httpStatus !== undefined) {
    payload.httpStatus = details.httpStatus;
  }
  return payload;
}

function trackCodexLifecycle(event: 'Codex Auth Connected' | 'Codex Auth Disconnected', payload: CodexAuthLifecycleTelemetryPayload): void {
  try {
    const tracker = getTracker();
    if (!tracker.isAvailable()) {
      return;
    }
    tracker.track(event, payload);
  } catch (error) {
    log.warn({ err: error, event, ...payload }, 'Failed to track codex auth lifecycle event');
  }
}

function isDestructiveDisconnectCause(cause: CodexAuthDisconnectedCause): cause is CodexAuthDestructiveDisconnectCause {
  return (
    cause === 'refresh_auth_failure'
    || cause === 'refresh_malformed_response'
    || cause === 'corrupt_read'
    || cause === 'sync_null_deletion_attempted'
  );
}

function isDestructiveDisconnectSource(source: CodexAuthTelemetrySource): source is CodexAuthDestructiveDisconnectSource {
  return (
    source === 'codex_auth_core'
    || source === 'codex_sync_channel'
    || source === 'codex_sync_route'
    || source === 'secure_token_store'
    || source === 'cloud_router_sync_guard'
  );
}

function emitCodexAuthConnected(details: CodexAuthLifecycleDetails): void {
  const payload = buildLifecyclePayload(details);
  log.info(payload, 'Codex auth connected');
  trackCodexLifecycle('Codex Auth Connected', payload);
}

export function reportCodexAuthDisconnected(details: CodexAuthDisconnectedTelemetry): void {
  const payload = buildLifecyclePayload(details);
  log.warn(payload, 'Codex auth disconnected');
  trackCodexLifecycle('Codex Auth Disconnected', payload);

  if (!isDestructiveDisconnectCause(details.cause)) {
    return;
  }

  if (!isDestructiveDisconnectSource(details.source)) {
    log.warn({ cause: details.cause, source: details.source }, 'Skipping destructive codex known condition for unsupported source');
    return;
  }

  const destructivePayload = {
    cause: details.cause,
    source: details.source,
    surface: payload.surface,
    ...(payload.httpStatus !== undefined ? { httpStatus: payload.httpStatus } : {}),
  };

  captureKnownCondition(
    'codex_auth_destructive_disconnect',
    destructivePayload,
    new Error('codex auth disconnected by destructive cause'),
  );
}

function isCodexTokens(parsed: unknown): parsed is CodexTokens {
  if (parsed === null || typeof parsed !== 'object') return false;
  const p = parsed as Record<string, unknown>;
  if (typeof p.accessToken !== 'string' || !isValidNonEmptyAscii(p.accessToken)) return false;
  if (typeof p.refreshToken !== 'string' || !isValidNonEmptyAscii(p.refreshToken)) return false;
  if (typeof p.expiresAt !== 'number' || !Number.isFinite(p.expiresAt) || p.expiresAt <= 0) return false;
  if (typeof p.accountId !== 'string' || !isValidNonEmptyAscii(p.accountId)) return false;
  if (p.accountEmail !== undefined && p.accountEmail !== null) {
    if (typeof p.accountEmail !== 'string' || p.accountEmail.length === 0) return false;
    if (p.accountEmail.includes('\uFFFD')) return false;
    for (let i = 0; i < p.accountEmail.length; i++) {
      const code = p.accountEmail.charCodeAt(i);
      if (code < 0x20 || (code >= 0x7F && code < 0xA0)) return false;
    }
  }
  return true;
}

function parseCodexTokens(raw: string): CodexTokens | null {
  try {
    const parsed = JSON.parse(raw);
    if (!isCodexTokens(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCodexTokens(tokens: CodexTokens, context?: SaveCodexTokensContext): void {
  try {
    getSecureTokenStore().write({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: CODEX_STORE_KEY,
      value: JSON.stringify(tokens),
    });
    emitCodexAuthConnected({
      cause: context?.cause ?? 'token_saved',
      source: context?.source ?? 'unknown',
      httpStatus: context?.httpStatus,
    });
    try {
      codexTokenEvents.emit('changed', tokens);
    } catch (emitError) {
      log.warn({ err: emitError }, 'codex-token-changed listener threw');
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to save Codex tokens');
    throw new Error('Failed to save Codex tokens securely');
  }
}

export function loadCodexTokens(): CodexTokens | null {
  try {
    if (process.env.REBEL_SURFACE === 'cli-standalone') {
      return null;
    }

    const raw = getSecureTokenStore().read({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: CODEX_STORE_KEY,
      kind: TOKEN_KIND,
      validate: (value) => parseCodexTokens(value) !== null,
      onDestructiveRead: (signal) => {
        if (signal.kind !== 'corrupt') {
          return;
        }
        reportCodexAuthDisconnected({
          cause: 'corrupt_read',
          source: 'secure_token_store',
        });
      },
    });
    if (!raw) return null;
    return parseCodexTokens(raw);
  } catch (error) {
    log.error({ err: error }, 'Failed to load Codex tokens');
    return null;
  }
}

export function clearCodexTokens(context: ClearCodexTokensContext): void {
  try {
    getSecureTokenStore().delete({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: CODEX_STORE_KEY,
    });
    reportCodexAuthDisconnected({
      cause: context.cause,
      source: context.source,
      httpStatus: context.httpStatus,
    });
    try {
      codexTokenEvents.emit('changed', null);
    } catch (emitError) {
      log.warn({ err: emitError }, 'codex-token-changed listener threw on clear');
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to clear Codex tokens');
  }
}

export function hasCodexTokens(): boolean {
  return getSecureTokenStore().has({
    store: getStore(),
    namespace: STORE_NAMESPACE,
    key: CODEX_STORE_KEY,
  });
}
