import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OperatorListFailure, OperatorMetadata } from '@shared/ipc/channels/operators';
import type { OperatorRole } from '@shared/types/operators';
import { useSpacesData } from '@renderer/hooks/useSpacesData';

const EMPTY_OPERATORS: OperatorMetadata[] = [];
const EMPTY_FAILURES: OperatorListFailure[] = [];
const EMPTY_SPACE_PATHS: string[] = [];
const EMPTY_SOURCE_SPACES: OperatorSourceSpace[] = [];
const operatorRegistryListCache = new Map<string, { operators: OperatorMetadata[]; failures: OperatorListFailure[] }>();

let operatorRegistryCacheVersion = 0;
const cacheVersionListeners = new Set<() => void>();

type LibraryChangedEvent = {
  timestamp: number;
  affectsTree: boolean;
  writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
  changedPath?: string;
};

type LibraryChangedApi = {
  onLibraryChanged?: (callback: (event: LibraryChangedEvent) => void) => () => void;
};

let libraryChangedSubscriberCount = 0;
let libraryChangedUnsubscribe: (() => void) | null = null;

function basenameFromChangedPath(value: string | undefined): string {
  if (!value) return '';
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

function handleLibraryChangedForOperators(event: LibraryChangedEvent): void {
  if (basenameFromChangedPath(event.changedPath) !== 'OPERATOR.md') return;
  invalidateOperatorRegistryCache();
}

function ensureLibraryChangedSubscription(): void {
  if (libraryChangedUnsubscribe) return;
  const api = (window as unknown as { api?: LibraryChangedApi }).api;
  if (typeof api?.onLibraryChanged !== 'function') return;
  libraryChangedUnsubscribe = api.onLibraryChanged(handleLibraryChangedForOperators);
}

function teardownLibraryChangedSubscriptionIfIdle(): void {
  if (libraryChangedSubscriberCount > 0) return;
  libraryChangedUnsubscribe?.();
  libraryChangedUnsubscribe = null;
}

/**
 * Invalidate every cached `operators:list` response and notify any mounted
 * `useOperatorRegistry` consumer to re-fetch. Call this from any operator
 * mutation success path so cross-surface views (e.g. MeetingCompanionBanner
 * caching `roleFilter: 'live_meeting'`) cannot stay stale after a toggle.
 */
export function invalidateOperatorRegistryCache(): void {
  operatorRegistryListCache.clear();
  operatorRegistryCacheVersion += 1;
  for (const listener of cacheVersionListeners) {
    listener();
  }
}

export function clearOperatorRegistryListCacheForTests(): void {
  operatorRegistryListCache.clear();
  operatorRegistryCacheVersion = 0;
  cacheVersionListeners.clear();
  libraryChangedUnsubscribe?.();
  libraryChangedUnsubscribe = null;
  libraryChangedSubscriberCount = 0;
}

export type OperatorRegistryMode = 'discovery' | 'panel';

export interface OperatorSourceSpace {
  sourceSpacePath: string;
  label: string;
  category: 'bundled' | 'space';
  isChiefOfStaff?: boolean;
}

export interface UseOperatorRegistryOptions {
  coreDirectory: string | null | undefined;
  /**
   * When provided, the registry scopes to that active Space plus
   * Chief-of-Staff. When absent, only Chief-of-Staff is used so slug-only
   * mention tokens cannot drift across duplicate Operator slugs in unrelated
   * Spaces.
   */
  activeSpacePath?: string | null;
  mode?: OperatorRegistryMode;
  roleFilter?: OperatorRole;
  enabled?: boolean;
}

export interface UseOperatorRegistryResult {
  operators: OperatorMetadata[];
  failures: OperatorListFailure[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  spacePaths: string[];
  sourceSpaces: OperatorSourceSpace[];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function isChiefOfStaffSpace(space: { type: string; path: string; absolutePath: string }): boolean {
  const normalizedPath = space.path.replace(/\\/g, '/').toLowerCase();
  const normalizedAbsolutePath = space.absolutePath.replace(/\\/g, '/').toLowerCase();
  return (
    space.type === 'chief-of-staff' ||
    normalizedPath === 'chief-of-staff' ||
    normalizedPath.endsWith('/chief-of-staff') ||
    normalizedAbsolutePath.endsWith('/chief-of-staff') ||
    normalizedAbsolutePath.endsWith('/rebelcore/agents')
  );
}

function joinPath(basePath: string, childPath: string): string {
  return `${basePath.replace(/[\\/]+$/u, '')}/${childPath.replace(/^[\\/]+/u, '')}`;
}

function displayNameForSpace(space: { name?: string; path: string; absolutePath: string; type: string }): string {
  if (isChiefOfStaffSpace(space)) return 'Chief-of-Staff';
  return space.name?.trim() || space.path.split(/[\\/]/u).filter(Boolean).at(-1) || space.absolutePath;
}

function uniqueSourceSpaces(spaces: OperatorSourceSpace[]): OperatorSourceSpace[] {
  return uniqueStrings(spaces.map((space) => space.sourceSpacePath))
    .map((sourceSpacePath) => spaces.find((space) => space.sourceSpacePath === sourceSpacePath))
    .filter((space): space is OperatorSourceSpace => Boolean(space));
}

function makeListCacheKey(spacePaths: string[], roleFilter?: OperatorRole): string {
  return JSON.stringify({ spacePaths, roleFilter: roleFilter ?? null });
}

export function useOperatorRegistry({
  coreDirectory,
  activeSpacePath,
  mode = 'discovery',
  roleFilter,
  enabled = true,
}: UseOperatorRegistryOptions): UseOperatorRegistryResult {
  const {
    spaces,
    loading: spacesLoading,
    ready: spacesReady,
    error: spacesError,
    errorMessage: spacesErrorMessage,
  } = useSpacesData(coreDirectory);
  const [operators, setOperators] = useState<OperatorMetadata[]>([]);
  const [failures, setFailures] = useState<OperatorListFailure[]>(EMPTY_FAILURES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheVersion, setCacheVersion] = useState(operatorRegistryCacheVersion);

  useEffect(() => {
    const listener = () => setCacheVersion(operatorRegistryCacheVersion);
    cacheVersionListeners.add(listener);
    return () => {
      cacheVersionListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    libraryChangedSubscriberCount += 1;
    ensureLibraryChangedSubscription();
    return () => {
      libraryChangedSubscriberCount = Math.max(0, libraryChangedSubscriberCount - 1);
      teardownLibraryChangedSubscriptionIfIdle();
    };
  }, []);

  const sourceSpaces = useMemo((): OperatorSourceSpace[] => {
    if (!coreDirectory || !spacesReady) return EMPTY_SOURCE_SPACES;
    const userSpaces: OperatorSourceSpace[] = spaces.map((space) => ({
      sourceSpacePath: space.absolutePath,
      label: displayNameForSpace(space),
      category: 'space' as const,
      ...(isChiefOfStaffSpace(space) ? { isChiefOfStaff: true } : {}),
    }));
    if (mode === 'panel') {
      return uniqueSourceSpaces(userSpaces).concat([{
        sourceSpacePath: joinPath(coreDirectory, 'rebel-system'),
        label: 'Bundled',
        category: 'bundled' as const,
      }]);
    }

    const chiefOfStaffSpaces = spaces
      .filter(isChiefOfStaffSpace)
      .map((space) => userSpaces.find((candidate) => candidate.sourceSpacePath === space.absolutePath))
      .filter((space): space is OperatorSourceSpace => Boolean(space));
    const activeSpaces = activeSpacePath
      ? spaces
        .filter((space) => space.path === activeSpacePath || space.absolutePath === activeSpacePath)
        .map((space) => userSpaces.find((candidate) => candidate.sourceSpacePath === space.absolutePath))
        .filter((space): space is OperatorSourceSpace => Boolean(space))
      : EMPTY_SOURCE_SPACES;
    return uniqueSourceSpaces([...chiefOfStaffSpaces, ...activeSpaces]);
  }, [activeSpacePath, coreDirectory, mode, spaces, spacesReady]);

  const spacePaths = useMemo(() => {
    if (sourceSpaces.length === 0) return EMPTY_SPACE_PATHS;
    return sourceSpaces.map((space) => space.sourceSpacePath);
  }, [sourceSpaces]);

  const cacheKey = useMemo(
    () => `${cacheVersion}|${makeListCacheKey(spacePaths, roleFilter)}`,
    [cacheVersion, roleFilter, spacePaths],
  );

  const loadOperators = useCallback(async (forceRefresh: boolean) => {
    if (!enabled || !coreDirectory || !spacesReady) {
      setOperators((current) => (current.length === 0 ? current : EMPTY_OPERATORS));
      setFailures((current) => (current.length === 0 ? current : EMPTY_FAILURES));
      setLoading(false);
      setError(null);
      return;
    }

    if (!forceRefresh) {
      const cached = operatorRegistryListCache.get(cacheKey);
      if (cached) {
        setOperators(cached.operators);
        setFailures(cached.failures);
        setLoading(false);
        setError(null);
        return;
      }
    }

    setLoading(true);
    setError(null);
    try {
      const response = await window.operatorsApi.list({
        spacePaths,
        ...(roleFilter ? { roleFilter } : {}),
      });
      setOperators(response.operators);
      const nextFailures = response.failures ?? EMPTY_FAILURES;
      setFailures(nextFailures);
      operatorRegistryListCache.set(cacheKey, {
        operators: response.operators,
        failures: nextFailures,
      });
    } catch (err) {
      setOperators([]);
      setFailures(EMPTY_FAILURES);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cacheKey, coreDirectory, enabled, roleFilter, spacePaths, spacesReady]);

  const refresh = useCallback(async () => {
    await loadOperators(true);
  }, [loadOperators]);

  useEffect(() => {
    void loadOperators(false);
  }, [loadOperators]);

  return {
    operators,
    failures,
    loading: spacesLoading || loading,
    error: spacesError ? spacesErrorMessage ?? 'Unable to load Spaces' : error,
    refresh,
    spacePaths,
    sourceSpaces,
  };
}
