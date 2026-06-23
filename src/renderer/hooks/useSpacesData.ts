/**
 * Centralised Spaces data source for the renderer.
 *
 * Why this exists: `scanSpaces()` was being called independently from
 * LibraryNavigatorProvider, SpacesManager, useBrokenSpacesNotification,
 * useAtlasSpaces, useCompanyValuesStatus, usePersonalGoalsStatus,
 * useSpaceWizardState, MeetingsTab, VoiceRecordersSection, PluginsTab, and a
 * private cache in MessageMarkdown.tsx — each with its own caching strategy
 * (30s TTL, module-level version counter, none-at-all). When SpacesManager
 * added/removed a Space, the other consumers wouldn't see the change until
 * their own TTL expired (or until full reload). This hook is the single
 * source of truth.
 *
 * Behaviour:
 * - Module-level cache keyed on `coreDirectory`. Workspace change invalidates.
 * - In-flight request coalescing — concurrent callers for the same
 *   `{ coreDirectory, generation }` share one fetch. Workspace switches and
 *   invalidations start their own fresh request, and stale resolutions are
 *   ignored.
 * - Failed automatic fetches do not spin. A failed workspace/generation is not
 *   retried by the hook effect until a refresh/invalidation bumps generation
 *   (or the requested workspace changes).
 * - 30-second freshness TTL (matches the previous LibraryNavigatorProvider
 *   value). Pass `{ force: true }` to bypass.
 * - `invalidateSpaces(coreDirectory)` is the canonical standalone API for "I
 *   just mutated a Space in this workspace, make the next read fresh". The
 *   hook's `refresh()` callback is the convenience form bound to the active
 *   workspace.
 * - `useSyncExternalStore` subscription for tear-free reads across consumers.
 * - Cross-workspace zeroing is synchronous: if a component asks for `/B` while
 *   the cache still holds `/A`, the hook immediately returns an empty,
 *   loading snapshot until the `/B` fetch resolves. Consumers must not render
 *   old-workspace data during that transition.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SpaceInfo } from '@shared/ipc/schemas/library';

const TTL_MS = 30_000;

export type SpaceParseWarning = {
  path: string;
  message: string;
};

type ScanSpacesRequest = {
  withRepair?: boolean;
};

type ScanSpacesResponse = {
  success: boolean;
  spaces?: SpaceInfo[];
  error?: string;
  parseWarnings?: SpaceParseWarning[];
};

type SpacesSnapshot = {
  spaces: SpaceInfo[];
  ready: boolean;
  error: boolean;
  errorMessage?: string;
  parseWarnings: SpaceParseWarning[];
};

type SpacesCacheState = SpacesSnapshot & {
  coreDirectory: string | null;
  /**
   * Monotonic freshness token for the currently-bound workspace. Every
   * `invalidateSpaces(coreDirectory)` call for that workspace increments this
   * value so in-flight fetches from older generations can resolve without
   * overwriting newer cache state.
   */
  generation: number;
};

let state: SpacesCacheState = {
  spaces: [],
  ready: false,
  error: false,
  errorMessage: undefined,
  parseWarnings: [],
  coreDirectory: null,
  generation: 0,
};

let lastFetchedAt = 0;
const workspaceGenerations = new Map<string, number>();
const failedFetchGenerations = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) {
    try { listener(); } catch { /* listener errors must not break the cache */ }
  }
}

function setState(next: SpacesCacheState): void {
  state = next;
  notify();
}

function zeroSnapshot(): SpacesSnapshot {
  return {
    spaces: [],
    ready: false,
    error: false,
    errorMessage: undefined,
    parseWarnings: [],
  };
}

function makeInFlightKey(coreDirectory: string, generation: number, withRepair = false): string {
  const mode = withRepair ? 'with-repair' : 'read-only';
  return `${coreDirectory}|${generation}|${mode}`;
}

function getWorkspaceGeneration(coreDirectory: string): number {
  return workspaceGenerations.get(coreDirectory) ?? 0;
}

function isCurrentFetch(coreDirectory: string, generation: number): boolean {
  return state.coreDirectory === coreDirectory && state.generation === generation;
}

function isFetchingFor(coreDirectory: string | null, generation: number): boolean {
  if (!coreDirectory) return false;
  return inFlight.has(makeInFlightKey(coreDirectory, generation, false))
    || inFlight.has(makeInFlightKey(coreDirectory, generation, true));
}

function hasFailedCurrentGeneration(coreDirectory: string): boolean {
  const generation = state.coreDirectory === coreDirectory
    ? state.generation
    : getWorkspaceGeneration(coreDirectory);
  return failedFetchGenerations.get(coreDirectory) === generation;
}

function markFetchFailed(coreDirectory: string, generation: number): void {
  failedFetchGenerations.set(coreDirectory, generation);
}

/**
 * Fetch Spaces for the given workspace. Coalesces concurrent callers, respects
 * TTL freshness, and honours an explicit `force` bypass. A fetch captures the
 * workspace and cache generation at start; on resolution it only writes state
 * if both still match, so workspace switches and mutation invalidations cannot
 * leak stale results into the active cache.
 */
export async function fetchSpaces(
  coreDirectory: string,
  options: { force?: boolean; withRepair?: boolean } = {},
): Promise<void> {
  if (!coreDirectory) return;

  const force = options.force === true;
  const withRepair = options.withRepair === true;
  const stillFresh = state.coreDirectory === coreDirectory && (Date.now() - lastFetchedAt) < TTL_MS;
  if (!force && stillFresh && state.ready) return;

  const generation = state.coreDirectory === coreDirectory ? state.generation : getWorkspaceGeneration(coreDirectory);
  if (state.coreDirectory !== coreDirectory) {
    setState({
      ...zeroSnapshot(),
      coreDirectory,
      generation,
    });
  }

  const inFlightKey = makeInFlightKey(coreDirectory, generation, withRepair);
  const existing = inFlight.get(inFlightKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const scan = (window as unknown as { libraryApi?: { scanSpaces?: (request?: ScanSpacesRequest) => Promise<ScanSpacesResponse> } })
        .libraryApi?.scanSpaces;
      if (typeof scan !== 'function') {
        if (isCurrentFetch(coreDirectory, generation)) {
          markFetchFailed(coreDirectory, generation);
          setState({
            spaces: [],
            ready: false,
            error: true,
            errorMessage: 'libraryApi.scanSpaces unavailable',
            parseWarnings: [],
            coreDirectory,
            generation,
          });
        }
        return;
      }
      const result = withRepair ? await scan({ withRepair: true }) : await scan();
      if (!isCurrentFetch(coreDirectory, generation)) return;
      if (result?.success) {
        failedFetchGenerations.delete(coreDirectory);
        lastFetchedAt = Date.now();
        setState({
          spaces: result.spaces ?? [],
          ready: true,
          error: false,
          errorMessage: undefined,
          parseWarnings: result.parseWarnings ?? [],
          coreDirectory,
          generation,
        });
      } else {
        markFetchFailed(coreDirectory, generation);
        setState({
          spaces: state.spaces,
          ready: false,
          error: true,
          errorMessage: result?.error ?? 'scanSpaces returned unsuccessful result',
          parseWarnings: state.parseWarnings,
          coreDirectory,
          generation,
        });
      }
    } catch (err) {
      if (isCurrentFetch(coreDirectory, generation)) {
        markFetchFailed(coreDirectory, generation);
        setState({
          spaces: state.spaces,
          ready: false,
          error: true,
          errorMessage: err instanceof Error ? err.message : String(err),
          parseWarnings: state.parseWarnings,
          coreDirectory,
          generation,
        });
      }
    } finally {
      inFlight.delete(inFlightKey);
    }
  })();

  inFlight.set(inFlightKey, promise);
  return promise;
}

/**
 * Canonical invalidation API. Use after mutations (add/remove/rename Space,
 * update frontmatter) so other consumers see the new data immediately.
 *
 * The `coreDirectory` argument is required. This keeps standalone mutation
 * handlers explicit about which workspace generation they are invalidating.
 * React consumers normally call the hook-bound `refresh()` convenience instead.
 */
export function invalidateSpaces(coreDirectory: string): void {
  if (!coreDirectory) return;
  lastFetchedAt = 0;
  const nextGeneration = getWorkspaceGeneration(coreDirectory) + 1;
  workspaceGenerations.set(coreDirectory, nextGeneration);
  failedFetchGenerations.delete(coreDirectory);
  if (state.coreDirectory !== coreDirectory) return;

  setState({
    ...state,
    generation: nextGeneration,
  });
}

/**
 * React hook: subscribe to the shared Spaces cache. Triggers a fetch on mount
 * and on `coreDirectory` change.
 *
 * Returns the current snapshot plus a `refresh()` callback that forces a fetch
 * for the bound workspace.
 */
export function useSpacesData(coreDirectory: string | null | undefined): {
  spaces: SpaceInfo[];
  /** True only while the requested workspace is fetching or awaiting its first cache fill. */
  loading: boolean;
  /** True after the requested workspace has a successful scan result in cache. */
  ready: boolean;
  /** True when the latest scan for the requested workspace failed. */
  error: boolean;
  errorMessage?: string;
  parseWarnings: SpaceParseWarning[];
  refresh: () => Promise<void>;
} {
  const cacheVersion = useSyncExternalStore(
    useCallback((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }, []),
    () => version,
    () => version,
  );

  useEffect(() => {
    if (coreDirectory) {
      if (state.coreDirectory !== coreDirectory) {
        failedFetchGenerations.delete(coreDirectory);
      }
      if (hasFailedCurrentGeneration(coreDirectory)) return;
      void fetchSpaces(coreDirectory);
    }
  }, [cacheVersion, coreDirectory]);

  const refresh = useCallback(async () => {
    if (!coreDirectory) return;
    await fetchSpaces(coreDirectory, { force: true, withRepair: true });
  }, [coreDirectory]);

  if (!coreDirectory) {
    return {
      ...zeroSnapshot(),
      loading: false,
      refresh,
    };
  }

  const matchesActiveWorkspace = state.coreDirectory === coreDirectory;
  if (!matchesActiveWorkspace) {
    return {
      ...zeroSnapshot(),
      loading: true,
      refresh,
    };
  }

  return {
    spaces: state.spaces,
    ready: state.ready,
    loading: isFetchingFor(coreDirectory, state.generation) && !state.ready,
    error: state.error,
    errorMessage: state.errorMessage,
    parseWarnings: state.parseWarnings,
    refresh,
  };
}

/**
 * For consumers that just want imperative access (e.g. one-shot pre-action
 * checks). Prefer `useSpacesData` in components.
 */
export function getSpacesSnapshot(): SpacesSnapshot & { coreDirectory: string | null } {
  return {
    spaces: state.spaces,
    ready: state.ready,
    error: state.error,
    errorMessage: state.errorMessage,
    parseWarnings: state.parseWarnings,
    coreDirectory: state.coreDirectory,
  };
}

/**
 * Workspace-scoped imperative snapshot. Returns cached data only when the
 * requested `coreDirectory` matches the active cache key; otherwise returns a
 * zeroed snapshot so synchronous consumers (for example markdown link
 * rewriting) cannot accidentally read old-workspace Spaces.
 */
export function getSpacesSnapshotFor(coreDirectory: string): SpacesSnapshot {
  if (state.coreDirectory !== coreDirectory) return zeroSnapshot();
  return {
    spaces: state.spaces,
    ready: state.ready,
    error: state.error,
    errorMessage: state.errorMessage,
    parseWarnings: state.parseWarnings,
  };
}

/**
 * Test helper: reset cache between tests. Do not call in production code.
 * Consumers must unmount any rendered hooks before calling, to prevent silent
 * orphaned-listener flakes.
 */
export function __resetSpacesCacheForTests(): void {
  state = {
    spaces: [],
    ready: false,
    error: false,
    errorMessage: undefined,
    parseWarnings: [],
    coreDirectory: null,
    generation: 0,
  };
  lastFetchedAt = 0;
  workspaceGenerations.clear();
  failedFetchGenerations.clear();
  inFlight.clear();
  listeners.clear();
  version += 1;
}
