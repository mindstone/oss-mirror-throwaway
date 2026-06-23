export const LOCAL_AUTH_STORAGE_KEY = 'rebel.pairing.v1';
export const SESSION_AUTH_STORAGE_KEY = 'rebel.session.v1';
export const CONNECTION_STATUS_STORAGE_KEY = 'rebel.connection.v1';
export const FINGERPRINT_STORAGE_KEY = 'rebel.fingerprint.v1';
export const LEGACY_FINGERPRINT_STORAGE_KEYS = [
  'rebel.clientFingerprint.v1',
  'rebel.pairingFingerprint.v1',
] as const;

export interface BootTokenFile {
  schemaVersion: 1;
  routerToken: string;
  bridgeOrigin: string;
  port: number;
  startedAt: string;
  installSessionId: string;
}

export interface LocalAuthState {
  clientId?: string;
  token?: string;
  fingerprint?: string;
}

export interface SessionAuthState {
  token?: string;
  installSessionId?: string;
}

export interface AuthSnapshot {
  clientId: string | null;
  token: string | null;
  installSessionId: string | null;
  fingerprint: string | null;
}

export interface PairingSnapshot {
  clientId: string | null;
  token: string | null;
  fingerprint: string | null;
}

export type InstallStatus =
  | { kind: 'idle' }
  | { kind: 'boot-token-missing' }
  | { kind: 'mint-failed-transient'; attempt: number }
  | { kind: 'mint-rate-limited'; retryAfterMs: number }
  | { kind: 'mint-forbidden'; reason?: string }
  | { kind: 'revoked-by-user' }
  | { kind: 'port-stale' }
  | { kind: 'connecting'; port: number }
  | { kind: 'registering'; port: number }
  | { kind: 'connected'; port: number; sessionId: string }
  | { kind: 'reconnecting'; attempt: number };

export type BootTokenReadResult =
  | { ok: true; bootToken: BootTokenFile }
  | { ok: false; kind: 'boot-token-missing' };

export type MintTokenResult =
  | {
      ok: true;
      kind: 'connected';
      token: string;
      installSessionId: string;
      port: number;
    }
  | { ok: false; kind: 'mint-failed-transient'; reason?: string }
  | { ok: false; kind: 'mint-forbidden'; reason?: string }
  | { ok: false; kind: 'mint-rate-limited'; retryAfterMs: number }
  | { ok: false; kind: 'port-stale' };

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseLocalAuthState(value: unknown): LocalAuthState {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.clientId === 'string' && record.clientId.length > 0
      ? { clientId: record.clientId }
      : {}),
    ...(typeof record.token === 'string' && record.token.length > 0
      ? { token: record.token }
      : {}),
    ...((typeof record.fingerprint === 'string' && record.fingerprint.length > 0) ||
    (typeof record.clientFingerprint === 'string' && record.clientFingerprint.length > 0)
      ? {
          fingerprint:
            (typeof record.fingerprint === 'string' && record.fingerprint.length > 0
              ? record.fingerprint
              : record.clientFingerprint) as string,
        }
      : {}),
  };
}

function readFingerprintFromStorageRecord(raw: Record<string, unknown>): string | null {
  const primary = raw[FINGERPRINT_STORAGE_KEY];
  if (typeof primary === 'string' && primary.length > 0) {
    return primary;
  }
  for (const legacyKey of LEGACY_FINGERPRINT_STORAGE_KEYS) {
    const candidate = raw[legacyKey];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function parseSessionAuthState(value: unknown): SessionAuthState {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.token === 'string' && record.token.length > 0
      ? { token: record.token }
      : {}),
    ...(typeof record.installSessionId === 'string' && record.installSessionId.length > 0
      ? { installSessionId: record.installSessionId }
      : {}),
  };
}

function isBootTokenFile(value: unknown): value is BootTokenFile {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.routerToken === 'string' &&
    record.routerToken.length > 0 &&
    typeof record.bridgeOrigin === 'string' &&
    record.bridgeOrigin.length > 0 &&
    typeof record.port === 'number' &&
    Number.isFinite(record.port) &&
    typeof record.startedAt === 'string' &&
    record.startedAt.length > 0 &&
    typeof record.installSessionId === 'string' &&
    record.installSessionId.length > 0
  );
}

async function safeReadJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function isPortStale(
  bridgeOrigin: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${bridgeOrigin}/intent/health`, {
      method: 'GET',
      cache: 'no-store',
    });
    return response.status === 404;
  } catch {
    return false;
  }
}

export function generateClientId(): string {
  return `browser-${randomHex(8)}`;
}

export async function ensureClientId(): Promise<string> {
  const raw = await chrome.storage.local.get(LOCAL_AUTH_STORAGE_KEY);
  const localState = parseLocalAuthState(raw[LOCAL_AUTH_STORAGE_KEY]);
  if (localState.clientId) {
    return localState.clientId;
  }
  const clientId = generateClientId();
  await chrome.storage.local.set({
    [LOCAL_AUTH_STORAGE_KEY]: { clientId },
  });
  return clientId;
}

export async function migrateLegacyLocalToken(): Promise<void> {
  const [localRaw, sessionRaw] = await Promise.all([
    chrome.storage.local.get([
      LOCAL_AUTH_STORAGE_KEY,
      FINGERPRINT_STORAGE_KEY,
      ...LEGACY_FINGERPRINT_STORAGE_KEYS,
    ]),
    chrome.storage.session.get(SESSION_AUTH_STORAGE_KEY),
  ]);
  const localState = parseLocalAuthState(localRaw[LOCAL_AUTH_STORAGE_KEY]);
  const sessionState = parseSessionAuthState(sessionRaw[SESSION_AUTH_STORAGE_KEY]);

  if (localState.token && !sessionState.token) {
    await chrome.storage.session.set({
      [SESSION_AUTH_STORAGE_KEY]: {
        ...(sessionState.installSessionId ? { installSessionId: sessionState.installSessionId } : {}),
        token: localState.token,
      },
    });
  }

  if (localState.token) {
    const fallbackFingerprint = readFingerprintFromStorageRecord(localRaw);
    await chrome.storage.local.set({
      [LOCAL_AUTH_STORAGE_KEY]: {
        ...(localState.clientId ? { clientId: localState.clientId } : {}),
        ...((localState.fingerprint ?? fallbackFingerprint)
          ? { fingerprint: localState.fingerprint ?? fallbackFingerprint }
          : {}),
      },
    });
  }
}

export async function readAuthSnapshot(): Promise<AuthSnapshot> {
  const [localRaw, sessionRaw] = await Promise.all([
    chrome.storage.local.get([
      LOCAL_AUTH_STORAGE_KEY,
      FINGERPRINT_STORAGE_KEY,
      ...LEGACY_FINGERPRINT_STORAGE_KEYS,
    ]),
    chrome.storage.session.get(SESSION_AUTH_STORAGE_KEY),
  ]);
  const localState = parseLocalAuthState(localRaw[LOCAL_AUTH_STORAGE_KEY]);
  const sessionState = parseSessionAuthState(sessionRaw[SESSION_AUTH_STORAGE_KEY]);
  const fallbackFingerprint = readFingerprintFromStorageRecord(localRaw);
  return {
    clientId: localState.clientId ?? null,
    token: sessionState.token ?? null,
    installSessionId: sessionState.installSessionId ?? null,
    fingerprint: localState.fingerprint ?? fallbackFingerprint,
  };
}

export async function readPairingSnapshot(): Promise<PairingSnapshot> {
  const auth = await readAuthSnapshot();
  return {
    clientId: auth.clientId,
    token: auth.token,
    fingerprint: auth.fingerprint,
  };
}

export async function persistSessionToken(args: {
  token: string;
  installSessionId: string;
}): Promise<void> {
  await chrome.storage.session.set({
    [SESSION_AUTH_STORAGE_KEY]: {
      token: args.token,
      installSessionId: args.installSessionId,
    },
  });
}

export async function clearSessionToken(): Promise<void> {
  await chrome.storage.session.remove(SESSION_AUTH_STORAGE_KEY);
}

export async function writeInstallStatus(status: InstallStatus): Promise<void> {
  await chrome.storage.session.set({
    [CONNECTION_STATUS_STORAGE_KEY]: status,
  });
}

export async function readInstallStatus(): Promise<InstallStatus> {
  const raw = await chrome.storage.session.get(CONNECTION_STATUS_STORAGE_KEY);
  const value = raw[CONNECTION_STATUS_STORAGE_KEY];
  if (!value || typeof value !== 'object') {
    return { kind: 'idle' };
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind : 'idle';
  switch (kind) {
    case 'boot-token-missing':
      return { kind };
    case 'mint-failed-transient':
      return { kind, attempt: typeof record.attempt === 'number' ? record.attempt : 1 };
    case 'mint-rate-limited':
      return {
        kind,
        retryAfterMs: typeof record.retryAfterMs === 'number' ? record.retryAfterMs : 0,
      };
    case 'mint-forbidden':
      return {
        kind,
        ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      };
    case 'revoked-by-user':
      return { kind };
    case 'port-stale':
      return { kind };
    case 'connecting':
    case 'registering':
      return { kind, port: typeof record.port === 'number' ? record.port : 0 };
    case 'connected':
      return {
        kind,
        port: typeof record.port === 'number' ? record.port : 0,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : 'unknown',
      };
    case 'reconnecting':
      return { kind, attempt: typeof record.attempt === 'number' ? record.attempt : 1 };
    default:
      return { kind: 'idle' };
  }
}

export async function readBootTokenFileFromBundle(
  fetchImpl: typeof fetch = fetch,
): Promise<BootTokenReadResult> {
  const response = await fetchImpl(chrome.runtime.getURL('rebel-boot-token.json'), {
    cache: 'no-store',
  });
  if (response.status === 404) {
    return { ok: false, kind: 'boot-token-missing' };
  }
  if (!response.ok) {
    return { ok: false, kind: 'boot-token-missing' };
  }

  try {
    const body = (await response.json()) as unknown;
    if (!isBootTokenFile(body)) {
      return { ok: false, kind: 'boot-token-missing' };
    }
    return { ok: true, bootToken: body };
  } catch {
    return { ok: false, kind: 'boot-token-missing' };
  }
}

export async function mintSessionTokenFromBootToken(args: {
  bootToken: BootTokenFile;
  clientId: string;
  extensionId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MintTokenResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${args.bootToken.bridgeOrigin}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.bootToken.routerToken}`,
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: args.clientId,
        extensionId: args.extensionId,
        installSessionId: args.bootToken.installSessionId,
      }),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });

    if (response.ok) {
      const body = await safeReadJson(response);
      const token = typeof body?.token === 'string' ? body.token : null;
      if (!token) {
        return {
          ok: false,
          kind: 'mint-failed-transient',
          reason: 'bad-response',
        };
      }
      return {
        ok: true,
        kind: 'connected',
        token,
        installSessionId: args.bootToken.installSessionId,
        port: args.bootToken.port,
      };
    }

    if (response.status === 429) {
      const body = await safeReadJson(response);
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterMs =
        (typeof body?.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)
          ? body.retryAfterMs
          : undefined) ??
        (retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) * 1000 : undefined) ??
        5_000;
      return {
        ok: false,
        kind: 'mint-rate-limited',
        retryAfterMs,
      };
    }

    if (response.status === 404 && (await isPortStale(args.bootToken.bridgeOrigin, fetchImpl))) {
      return {
        ok: false,
        kind: 'port-stale',
      };
    }

    if (response.status === 400 || response.status === 403) {
      const body = await safeReadJson(response);
      return {
        ok: false,
        kind: 'mint-forbidden',
        ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
      };
    }

    return {
      ok: false,
      kind: 'mint-failed-transient',
      reason: `status-${response.status}`,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ok: false,
        kind: 'mint-failed-transient',
        reason: 'timeout',
      };
    }
    return {
      ok: false,
      kind: 'mint-failed-transient',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
