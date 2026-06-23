import { useEffect } from 'react';
import type { LibraryChangedSource } from '@shared/ipc/channels/library';
import { fetchSpaces, getSpacesSnapshot, invalidateSpaces } from './useSpacesData';

const THROTTLE_MS = 2_000;

type LibraryChangedEvent = {
  timestamp: number;
  affectsTree: boolean;
  writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
  changedPath?: string;
  source?: LibraryChangedSource;
};

type LibraryChangedApi = {
  onLibraryChanged?: (callback: (event: LibraryChangedEvent) => void) => () => void;
};

let mountCount = 0;
let unsubscribe: (() => void) | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let missingSourceWarningLogged = false;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isReadmeInKnownSpace(changedPath: string | undefined): boolean {
  if (!changedPath || !/readme\.md$/i.test(changedPath)) return false;

  const snapshot = getSpacesSnapshot();
  const normalizedChangedPath = normalizePath(changedPath);
  const candidates = new Set<string>();

  for (const space of snapshot.spaces) {
    candidates.add(normalizePath(`${space.path}/README.md`));
    candidates.add(normalizePath(`${space.absolutePath}/README.md`));
    if (space.sourcePath) {
      candidates.add(normalizePath(`${space.sourcePath}/README.md`));
    }
  }

  return candidates.has(normalizedChangedPath);
}

function flushInvalidation(): void {
  throttleTimer = null;
  if (!dirty) return;
  dirty = false;

  const activeCoreDirectory = getSpacesSnapshot().coreDirectory;
  if (!activeCoreDirectory) return;

  invalidateSpaces(activeCoreDirectory);
  void fetchSpaces(activeCoreDirectory, { force: true });
}

function queueInvalidation(source: LibraryChangedSource): void {
  dirty = true;
  if (source === 'user') {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    flushInvalidation();
    return;
  }
  if (throttleTimer) {
    return;
  }
  throttleTimer = setTimeout(flushInvalidation, THROTTLE_MS);
}

function getEventSource(event: LibraryChangedEvent): LibraryChangedSource {
  if (event.source === 'user' || event.source === 'watcher') {
    return event.source;
  }
  if (!missingSourceWarningLogged) {
    missingSourceWarningLogged = true;
    console.warn('[useLibraryChangedInvalidator] Missing library:changed source; defaulting to watcher throttle.');
  }
  return 'watcher';
}

function handleLibraryChanged(event: LibraryChangedEvent): void {
  if (event.affectsTree || isReadmeInKnownSpace(event.changedPath)) {
    queueInvalidation(getEventSource(event));
  }
}

function subscribeOnce(): void {
  if (unsubscribe) return;
  const api = (window as unknown as { api?: LibraryChangedApi }).api;
  if (typeof api?.onLibraryChanged !== 'function') return;
  unsubscribe = api.onLibraryChanged(handleLibraryChanged);
}

function unsubscribeIfIdle(): void {
  if (mountCount > 0) return;
  unsubscribe?.();
  unsubscribe = null;
  dirty = false;
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
}

/**
 * Singleton bridge from `library:changed` IPC events into the shared Spaces
 * cache. Safe to mount from multiple app roots/consumers; only one IPC
 * listener is active while at least one hook instance is mounted.
 */
export function useLibraryChangedInvalidator(): void {
  useEffect(() => {
    mountCount += 1;
    subscribeOnce();

    return () => {
      mountCount = Math.max(0, mountCount - 1);
      unsubscribeIfIdle();
    };
  }, []);
}

export function __resetLibraryChangedInvalidatorForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  mountCount = 0;
  dirty = false;
  missingSourceWarningLogged = false;
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
}
