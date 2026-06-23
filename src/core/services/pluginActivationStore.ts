import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { PLUGIN_ACTIVATION_STORE_VERSION } from '@core/constants';

const log = createScopedLogger({ service: 'pluginActivationStore' });

type PluginActivationStoreState = {
  version: number;
  activatedPluginIds: string[];
  deactivatedPluginIds: string[];
  // Plugins created by the agent that request elevated permissions and are
  // awaiting the user's security review before they go live (Stage 3A). Distinct
  // from `deactivatedPluginIds` (which means "the user explicitly turned this
  // off") so the UI can show a "Needs review" affordance rather than a plain
  // off toggle. Backward-compatible: missing key normalises to []; no migration.
  pendingReviewPluginIds: string[];
};

const createDefaultState = (): PluginActivationStoreState => ({
  version: PLUGIN_ACTIVATION_STORE_VERSION,
  activatedPluginIds: [],
  deactivatedPluginIds: [],
  pendingReviewPluginIds: [],
});

let _store: KeyValueStore<PluginActivationStoreState> | null = null;

function getStore(): KeyValueStore<PluginActivationStoreState> {
  if (!_store) {
    _store = createStore<PluginActivationStoreState>({
      name: 'plugin-activation',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

function normalizeActivatedPluginIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      log.warn({ candidate }, 'Skipping non-string activated plugin ID');
      continue;
    }

    const pluginId = candidate.trim();
    if (pluginId.length === 0 || seen.has(pluginId)) {
      continue;
    }

    seen.add(pluginId);
    normalized.push(pluginId);
  }

  return normalized;
}

function writeActivatedPluginIds(ids: string[]): void {
  getStore().set('activatedPluginIds', ids);
}

function writeDeactivatedPluginIds(ids: string[]): void {
  getStore().set('deactivatedPluginIds', ids);
}

function hasSameOrder(a: string[], b: unknown): boolean {
  if (!Array.isArray(b) || a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

export function getActivatedPluginIds(): string[] {
  const store = getStore();
  const raw = store.get('activatedPluginIds');
  const normalized = normalizeActivatedPluginIds(raw);

  if (!hasSameOrder(normalized, raw)) {
    store.set('activatedPluginIds', normalized);
  }

  return normalized;
}

export function addActivatedPluginId(pluginId: string): void {
  const normalizedId = pluginId.trim();
  if (normalizedId.length === 0) {
    return;
  }

  // Mutual exclusivity: remove from deactivated when activating
  const deactivatedIds = getDeactivatedPluginIds();
  if (deactivatedIds.includes(normalizedId)) {
    writeDeactivatedPluginIds(deactivatedIds.filter((id) => id !== normalizedId));
  }

  // Activating a plugin resolves any pending security review for it.
  removePendingReviewPluginId(normalizedId);

  const ids = getActivatedPluginIds();
  if (ids.includes(normalizedId)) {
    return;
  }

  writeActivatedPluginIds([...ids, normalizedId]);
}

export function removeActivatedPluginId(pluginId: string): void {
  const normalizedId = pluginId.trim();
  if (normalizedId.length === 0) {
    return;
  }

  const ids = getActivatedPluginIds();
  const next = ids.filter((id) => id !== normalizedId);

  if (next.length === ids.length) {
    return;
  }

  writeActivatedPluginIds(next);
}

export function isPluginActivated(pluginId: string): boolean {
  const normalizedId = pluginId.trim();
  if (normalizedId.length === 0) {
    return false;
  }

  return getActivatedPluginIds().includes(normalizedId);
}

// ── Deactivated Plugin Tracking ────────────────────────────────────────
// Tracks plugins the user has explicitly disabled. Prevents Chief-of-Staff
// plugins from auto-reactivating on the next Space scan.

export function getDeactivatedPluginIds(): string[] {
  const store = getStore();
  const raw = store.get('deactivatedPluginIds');
  const normalized = normalizeActivatedPluginIds(raw);

  if (!hasSameOrder(normalized, raw)) {
    store.set('deactivatedPluginIds', normalized);
  }

  return normalized;
}

export function addDeactivatedPluginId(pluginId: string): void {
  const normalizedId = pluginId.trim();
  if (normalizedId.length === 0) {
    return;
  }

  // Mutual exclusivity: remove from activated when deactivating
  const activatedIds = getActivatedPluginIds();
  if (activatedIds.includes(normalizedId)) {
    writeActivatedPluginIds(activatedIds.filter((id) => id !== normalizedId));
  }

  const ids = getDeactivatedPluginIds();
  if (ids.includes(normalizedId)) {
    return;
  }

  writeDeactivatedPluginIds([...ids, normalizedId]);
}

export function removeDeactivatedPluginId(pluginId: string): void {
  const normalizedId = pluginId.trim();
  if (normalizedId.length === 0) {
    return;
  }

  const ids = getDeactivatedPluginIds();
  const next = ids.filter((id) => id !== normalizedId);

  if (next.length === ids.length) {
    return;
  }

  writeDeactivatedPluginIds(next);
}

 
// ── Pending Security Review Tracking (Stage 3A) ────────────────────────
// Plugins created by the agent that requested elevated permissions and have not
// yet been approved by the user. Held inactive (also marked deactivated, which
// is what actually suppresses Chief-of-Staff auto-activation); this list is the
// UI signal so a pending-review plugin reads as "Rebel built this, review it"
// rather than "you turned this off". Cleared when the plugin is activated.
// See docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 3A.

function writePendingReviewPluginIds(ids: string[]): void {
  getStore().set('pendingReviewPluginIds', ids);
}

export function getPendingReviewPluginIds(): string[] {
  const store = getStore();
  const raw = store.get('pendingReviewPluginIds');
  const normalized = normalizeActivatedPluginIds(raw);

  if (!hasSameOrder(normalized, raw)) {
    store.set('pendingReviewPluginIds', normalized);
  }

  return normalized;
}

export function addPendingReviewPluginId(pluginId: string): void {
  const normalizedId = pluginId.trim();
  if (normalizedId.length === 0) {
    return;
  }

  const ids = getPendingReviewPluginIds();
  if (ids.includes(normalizedId)) {
    return;
  }

  writePendingReviewPluginIds([...ids, normalizedId]);
}

export function removePendingReviewPluginId(pluginId: string): void {
  const normalizedId = pluginId.trim();
  if (normalizedId.length === 0) {
    return;
  }

  const ids = getPendingReviewPluginIds();
  const next = ids.filter((id) => id !== normalizedId);

  if (next.length === ids.length) {
    return;
  }

  writePendingReviewPluginIds(next);
}

export function _resetForTests(): void {
  _store = null;
}
