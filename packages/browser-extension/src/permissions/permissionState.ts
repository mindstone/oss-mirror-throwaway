/**
 * Pending-permissions state for the Rebel browser extension.
 *
 * Backed by `chrome.storage.session` so it survives service-worker eviction
 * but NOT a bundle reload (that's Key Decision 13 — accepted trade-off; the
 * next agent dispatch re-triggers the prompt).
 *
 * Shape: `Record<origin, PendingPermissionEntry>`.
 * Keyed by origin (not `tabId`) so two tabs on the same origin coalesce to
 * one entry with a list of tabIds (Key Decision 10).
 *
 * See docs/plans/260424_browser_extension_bundling_and_permissions_fix.md
 * §Key Decisions 10, 11, 12, 13.
 */

export const PENDING_PERMISSIONS_STORAGE_KEY = 'rebel.pending-permissions.v1';
export const LAST_REVOKED_STORAGE_KEY = 'rebel.last-revoked.v1';

/** Entries older than this are auto-cleared on every read (Key Decision 12). */
export const STALE_ENTRY_MS = 2 * 60 * 1000; // 2 minutes

export interface PendingPermissionEntry {
  origin: string;
  capability: string;
  /**
   * Tabs that triggered this pending entry. A grant clears the whole entry
   * regardless of `tabIds`; tab close / navigation only removes a single
   * id (§10 coalescing — two tabs on the same origin share one entry).
   */
  tabIds: number[];
  firstRequestedAt: number;
  lastRequestedAt: number;
  /** Free-form label the popup/sidepanel can render (tab title / origin fallback). */
  displayName: string;
}

export type PendingPermissionsState = Record<string, PendingPermissionEntry>;

export interface LastRevokedMarker {
  origin: string;
  at: number;
}

interface StorageArea {
  get(
    keys?: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

type StorageChangeListener = (
  changes: Record<string, StorageChange>,
  areaName: string,
) => void;

interface StorageOnChanged {
  addListener(listener: StorageChangeListener): void;
  removeListener(listener: StorageChangeListener): void;
}

function getSessionStorage(): StorageArea | null {
  const storage = (globalThis as typeof globalThis & {
    chrome?: {
      storage?: { session?: StorageArea };
    };
  }).chrome?.storage?.session;
  return storage ?? null;
}

function getStorageOnChanged(): StorageOnChanged | null {
  const onChanged = (globalThis as typeof globalThis & {
    chrome?: {
      storage?: { onChanged?: StorageOnChanged };
    };
  }).chrome?.storage?.onChanged;
  return onChanged ?? null;
}

function nowMs(): number {
  return Date.now();
}

function isPendingEntry(value: unknown): value is PendingPermissionEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PendingPermissionEntry>;
  if (typeof entry.origin !== 'string' || entry.origin.length === 0) return false;
  if (typeof entry.capability !== 'string' || entry.capability.length === 0) return false;
  if (!Array.isArray(entry.tabIds)) return false;
  if (!entry.tabIds.every((id) => typeof id === 'number' && Number.isFinite(id))) {
    return false;
  }
  if (typeof entry.firstRequestedAt !== 'number') return false;
  if (typeof entry.lastRequestedAt !== 'number') return false;
  if (typeof entry.displayName !== 'string') return false;
  return true;
}

function normaliseState(raw: unknown): PendingPermissionsState {
  if (!raw || typeof raw !== 'object') return {};
  const next: PendingPermissionsState = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isPendingEntry(value) && value.origin === key) {
      next[key] = value;
    }
  }
  return next;
}

async function readRawState(): Promise<PendingPermissionsState> {
  const storage = getSessionStorage();
  if (!storage) return {};
  try {
    const record = await storage.get(PENDING_PERMISSIONS_STORAGE_KEY);
    return normaliseState(record[PENDING_PERMISSIONS_STORAGE_KEY]);
  } catch (err) {
    // chrome.storage errors in tests / missing mocks should degrade gracefully —
    // but we still want a trace for developer triage (plan §19: "silent failure is a bug").
    console.debug('[rebel-permissions] storage.session.get failed; returning empty state', err);
    return {};
  }
}

async function writeState(state: PendingPermissionsState): Promise<void> {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    if (Object.keys(state).length === 0) {
      await storage.remove(PENDING_PERMISSIONS_STORAGE_KEY);
      return;
    }
    await storage.set({ [PENDING_PERMISSIONS_STORAGE_KEY]: state });
  } catch (err) {
    // Intentional: storage write failures should not crash dispatch,
    // but they should be observable (plan §19).
    console.debug('[rebel-permissions] storage.session.set failed', err);
  }
}

/**
 * Read the pending-permissions map, auto-clearing any entry older than
 * `STALE_ENTRY_MS` on the way out. Performs a write-back only when stale
 * entries were actually dropped.
 */
export async function getPending(): Promise<PendingPermissionsState> {
  const raw = await readRawState();
  const now = nowMs();
  let mutated = false;
  const next: PendingPermissionsState = {};
  for (const [origin, entry] of Object.entries(raw)) {
    if (now - entry.lastRequestedAt > STALE_ENTRY_MS) {
      mutated = true;
      continue;
    }
    next[origin] = entry;
  }
  if (mutated) {
    await writeState(next);
  }
  return next;
}

export interface SetPendingInput {
  origin: string;
  capability: string;
  tabId: number;
  displayName: string;
}

/**
 * Upsert a pending entry. When the origin already has an entry, appends
 * the `tabId` (deduped) and refreshes `lastRequestedAt`; `firstRequestedAt`
 * is only set on create.
 */
export async function setPending(input: SetPendingInput): Promise<void> {
  const raw = await readRawState();
  const now = nowMs();
  const existing = raw[input.origin];
  if (existing) {
    const tabIds = existing.tabIds.includes(input.tabId)
      ? existing.tabIds
      : [...existing.tabIds, input.tabId];
    raw[input.origin] = {
      ...existing,
      capability: input.capability,
      tabIds,
      lastRequestedAt: now,
      displayName:
        input.displayName.length > 0 ? input.displayName : existing.displayName,
    };
  } else {
    raw[input.origin] = {
      origin: input.origin,
      capability: input.capability,
      tabIds: [input.tabId],
      firstRequestedAt: now,
      lastRequestedAt: now,
      displayName:
        input.displayName.length > 0 ? input.displayName : input.origin,
    };
  }
  await writeState(raw);
}

/**
 * Remove an origin entry regardless of remaining `tabIds`. Used on grant
 * success (permission is origin-wide) and on explicit clear.
 */
export async function clearPendingForOrigin(origin: string): Promise<void> {
  const raw = await readRawState();
  if (!(origin in raw)) return;
  delete raw[origin];
  await writeState(raw);
}

/**
 * Drop a single tab from every pending entry. Called from `tabs.onRemoved`;
 * if the resulting `tabIds` list is empty, the origin entry itself is
 * deleted (Key Decision 10).
 */
export async function dropTabFromPending(tabId: number): Promise<void> {
  const raw = await readRawState();
  let mutated = false;
  for (const [origin, entry] of Object.entries(raw)) {
    const filtered = entry.tabIds.filter((id) => id !== tabId);
    if (filtered.length === entry.tabIds.length) {
      continue;
    }
    mutated = true;
    if (filtered.length === 0) {
      delete raw[origin];
    } else {
      raw[origin] = { ...entry, tabIds: filtered };
    }
  }
  if (mutated) {
    await writeState(raw);
  }
}

/**
 * Fired from `webNavigation.onCommitted` (top-level frames only). If the
 * tab's new origin is different from any origin that still lists `tabId`,
 * drop `tabId` from those origins' lists. Same empty-list-deletes-entry
 * semantics as `dropTabFromPending`.
 */
export async function clearPendingForTabNavigation(
  tabId: number,
  newUrl: string,
): Promise<void> {
  const raw = await readRawState();
  let newOrigin: string | null = null;
  try {
    const parsed = new URL(newUrl);
    newOrigin = parsed.origin.toLowerCase();
  } catch {
    newOrigin = null;
  }

  let mutated = false;
  for (const [origin, entry] of Object.entries(raw)) {
    if (!entry.tabIds.includes(tabId)) continue;
    if (newOrigin && newOrigin === origin.toLowerCase()) {
      // Tab stayed on this origin — nothing to clear.
      continue;
    }
    const filtered = entry.tabIds.filter((id) => id !== tabId);
    mutated = true;
    if (filtered.length === 0) {
      delete raw[origin];
    } else {
      raw[origin] = { ...entry, tabIds: filtered };
    }
  }
  if (mutated) {
    await writeState(raw);
  }
}

/**
 * Subscribe to pending-permissions changes. Listens to
 * `chrome.storage.onChanged` and invokes the listener with the full,
 * stale-cleaned state whenever the key changes. Returns an unsubscribe fn.
 */
export function onChange(
  listener: (state: PendingPermissionsState) => void,
): () => void {
  const onChanged = getStorageOnChanged();
  if (!onChanged) {
    return () => undefined;
  }
  const wrapped: StorageChangeListener = (changes, areaName) => {
    if (areaName !== 'session') return;
    if (!(PENDING_PERMISSIONS_STORAGE_KEY in changes)) return;
    void getPending().then(listener);
  };
  onChanged.addListener(wrapped);
  return () => onChanged.removeListener(wrapped);
}

/**
 * Short-lived toast marker for a permission revoked externally (via
 * `chrome://extensions/?id=...`). Consumed by the popup/sidepanel in
 * Group D; here we only write it.
 */
export async function writeLastRevokedMarker(origin: string): Promise<void> {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const marker: LastRevokedMarker = { origin, at: nowMs() };
    await storage.set({ [LAST_REVOKED_STORAGE_KEY]: marker });
  } catch (err) {
    // Non-fatal — worst case the user won't see the toast this session.
    // Still trace for triage (plan §19).
    console.debug('[rebel-permissions] writeLastRevokedMarker failed', err);
  }
}

// ---------------------------------------------------------------------------
// Test-only helpers (Key Decision 13 / plan R2 residual)
// ---------------------------------------------------------------------------
//
// `import.meta.env.MODE === 'test'` is replaced by Vite at build time.
// Production builds become `'production' === 'test'` which is dead code and
// tree-shaken by Rollup — the `dist/assets/**/*.js` check asserts zero
// `__rebelE2E__` string matches. See docs/plans/260424... §Test-only surface.

declare const __RebelE2EApi: unique symbol;
interface RebelE2EApi {
  readonly [__RebelE2EApi]?: never;
  clearPendingState(): Promise<void>;
}

const e2eGlobal = globalThis as typeof globalThis & {
  __rebelE2E__?: Record<string, unknown> & {
    permissionState?: RebelE2EApi;
  };
};

if (import.meta.env.MODE === 'test') {
  const existing = e2eGlobal.__rebelE2E__ ?? {};
  const api: RebelE2EApi = {
    async clearPendingState(): Promise<void> {
      const storage = getSessionStorage();
      if (!storage) return;
      await storage.remove(PENDING_PERMISSIONS_STORAGE_KEY);
      await storage.remove(LAST_REVOKED_STORAGE_KEY);
    },
  };
  e2eGlobal.__rebelE2E__ = { ...existing, permissionState: api };
}
