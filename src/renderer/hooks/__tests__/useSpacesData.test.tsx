// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import {
  __resetSpacesCacheForTests,
  fetchSpaces,
  getSpacesSnapshot,
  getSpacesSnapshotFor,
  invalidateSpaces,
  useSpacesData,
} from '../useSpacesData';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const makeSpace = (name: string): SpaceInfo => ({
  name,
  path: name,
  absolutePath: `/ws/${name}`,
  type: 'project',
  isSymlink: false,
  hasReadme: true,
  status: 'ok',
});

type ScanSpacesResult = {
  success: boolean;
  spaces: SpaceInfo[];
  parseWarnings?: { path: string; message: string }[];
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function setScanSpaces(impl: (request?: { withRepair?: boolean }) => Promise<ScanSpacesResult>): void {
  (globalThis as unknown as { window: { libraryApi: { scanSpaces: typeof impl } } }).window = {
    libraryApi: { scanSpaces: impl },
  };
}

function clearScanSpaces(): void {
  (globalThis as unknown as { window: { libraryApi?: unknown } }).window = { libraryApi: undefined };
}

describe('useSpacesData', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    __resetSpacesCacheForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    __resetSpacesCacheForTests();
    clearScanSpaces();
    vi.clearAllMocks();
  });

  function renderHookValue(coreDirectory: string | null) {
    const observed: ReturnType<typeof useSpacesData>[] = [];
    const Probe: React.FC<{ dir: string | null }> = ({ dir }) => {
      const value = useSpacesData(dir);
      observed.push(value);
      return null;
    };
    act(() => { root.render(<Probe dir={coreDirectory} />); });
    return observed;
  }

  it('coalesces concurrent fetches into one IPC call', async () => {
    const scan = vi.fn().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ success: true, spaces: [makeSpace('a'), makeSpace('b')] }), 10);
    }));
    setScanSpaces(scan);

    await Promise.all([
      fetchSpaces('/ws'),
      fetchSpaces('/ws'),
      fetchSpaces('/ws'),
    ]);

    expect(scan).toHaveBeenCalledTimes(1);
    expect(getSpacesSnapshot().spaces).toHaveLength(2);
  });

  it('respects TTL freshness — a second fetch within window is a no-op', async () => {
    const scan = vi.fn().mockResolvedValue({ success: true, spaces: [makeSpace('a')] });
    setScanSpaces(scan);

    await fetchSpaces('/ws');
    await fetchSpaces('/ws');

    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('invalidateSpaces(coreDirectory) forces the next fetch to refetch', async () => {
    const scan = vi.fn().mockResolvedValue({ success: true, spaces: [makeSpace('a')] });
    setScanSpaces(scan);

    await fetchSpaces('/ws');
    invalidateSpaces('/ws');
    await fetchSpaces('/ws');

    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('resets snapshot when the bound coreDirectory changes (no cross-workspace leakage)', async () => {
    const scan = vi.fn()
      .mockResolvedValueOnce({ success: true, spaces: [makeSpace('ws1-space')] })
      .mockResolvedValueOnce({ success: true, spaces: [makeSpace('ws2-space')] });
    setScanSpaces((...args) => scan(...args));

    await fetchSpaces('/ws1');
    expect(getSpacesSnapshot().spaces[0]?.name).toBe('ws1-space');

    await fetchSpaces('/ws2');
    expect(getSpacesSnapshot().spaces[0]?.name).toBe('ws2-space');
  });

  it('surfaces error state when scanSpaces rejects', async () => {
    setScanSpaces(() => Promise.reject(new Error('boom')));
    await fetchSpaces('/ws');
    expect(getSpacesSnapshot().ready).toBe(false);
  });

  it('does not auto-retry a failed hook fetch until the workspace generation is invalidated', async () => {
    const scan = vi.fn().mockRejectedValue(new Error('boom'));
    setScanSpaces(scan);

    const observed = renderHookValue('/ws');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(1);
    expect(observed[observed.length - 1]).toMatchObject({
      ready: false,
      loading: false,
      error: true,
      errorMessage: 'boom',
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(1);

    act(() => { invalidateSpaces('/ws'); });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(2);
    expect(observed[observed.length - 1]).toMatchObject({
      ready: false,
      loading: false,
      error: true,
      errorMessage: 'boom',
    });
  });

  it('workspace re-entry after prior failure retries the new workspace', async () => {
    const scan = vi.fn()
      .mockRejectedValueOnce(new Error('B failed'))
      .mockResolvedValueOnce({ success: true, spaces: [makeSpace('from-A')] })
      .mockResolvedValueOnce({ success: true, spaces: [makeSpace('from-B')] });
    setScanSpaces(() => scan());

    const observed: ReturnType<typeof useSpacesData>[] = [];
    const Probe: React.FC<{ dir: string }> = ({ dir }) => {
      observed.push(useSpacesData(dir));
      return null;
    };

    await act(async () => {
      root.render(<Probe dir="/B" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(1);
    expect(observed[observed.length - 1]).toMatchObject({
      ready: false,
      loading: false,
      error: true,
      errorMessage: 'B failed',
    });

    await act(async () => {
      root.render(<Probe dir="/A" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(2);
    expect(observed[observed.length - 1]).toMatchObject({
      ready: true,
      error: false,
      spaces: [expect.objectContaining({ name: 'from-A' })],
    });

    await act(async () => {
      root.render(<Probe dir="/B" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(3);
    expect(observed[observed.length - 1]).toMatchObject({
      ready: true,
      error: false,
      spaces: [expect.objectContaining({ name: 'from-B' })],
    });
  });

  it('useSpacesData() re-renders subscribers when the cache resolves', async () => {
    let resolveScan: ((value: { success: true; spaces: SpaceInfo[] }) => void) | undefined;
    setScanSpaces(() => new Promise((resolve) => { resolveScan = resolve; }));

    const observed = renderHookValue('/ws');

    // Initial snapshot: not ready
    expect(observed[observed.length - 1]?.ready).toBe(false);
    expect(observed[observed.length - 1]?.spaces).toEqual([]);

    // Resolve and wait for the microtask queue to flush.
    await act(async () => {
      resolveScan!({ success: true, spaces: [makeSpace('a')] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const final = observed[observed.length - 1];
    expect(final?.ready).toBe(true);
    expect(final?.spaces.map((s) => s.name)).toEqual(['a']);
  });

  it('refresh() requests a withRepair scan while background fetches stay read-only', async () => {
    const scan = vi.fn().mockResolvedValue({ success: true, spaces: [makeSpace('a')] });
    setScanSpaces(scan);

    let latest: ReturnType<typeof useSpacesData> | null = null;
    const Probe: React.FC = () => {
      latest = useSpacesData('/ws');
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]).toEqual([]);

    await act(async () => {
      await latest?.refresh();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls[1]).toEqual([{ withRepair: true }]);
  });

  it('drops an old workspace in-flight result after switching workspaces and starts a new fetch', async () => {
    const firstScan = deferred<ScanSpacesResult>();
    const secondScan = deferred<ScanSpacesResult>();
    const scan = vi.fn()
      .mockReturnValueOnce(firstScan.promise)
      .mockReturnValueOnce(secondScan.promise);
    setScanSpaces(scan);

    const observed: ReturnType<typeof useSpacesData>[] = [];
    const Probe: React.FC<{ dir: string }> = ({ dir }) => {
      observed.push(useSpacesData(dir));
      return null;
    };

    act(() => { root.render(<Probe dir="/A" />); });
    expect(scan).toHaveBeenCalledTimes(1);

    act(() => { root.render(<Probe dir="/B" />); });
    expect(scan).toHaveBeenCalledTimes(2);

    await act(async () => {
      firstScan.resolve({ success: true, spaces: [makeSpace('from-A')] });
      await firstScan.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getSpacesSnapshotFor('/B')).toMatchObject({
      spaces: [],
      ready: false,
      error: false,
      parseWarnings: [],
    });

    await act(async () => {
      secondScan.resolve({ success: true, spaces: [makeSpace('from-B')] });
      await secondScan.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getSpacesSnapshotFor('/B').spaces.map((space) => space.name)).toEqual(['from-B']);
  });

  it('drops an in-flight result after invalidation bumps the workspace generation and starts a new fetch', async () => {
    const staleScan = deferred<ScanSpacesResult>();
    const freshScan = deferred<ScanSpacesResult>();
    const scan = vi.fn()
      .mockReturnValueOnce(staleScan.promise)
      .mockReturnValueOnce(freshScan.promise);
    setScanSpaces(scan);

    const Probe: React.FC = () => {
      useSpacesData('/A');
      return null;
    };

    act(() => { root.render(<Probe />); });
    expect(scan).toHaveBeenCalledTimes(1);

    act(() => { invalidateSpaces('/A'); });
    expect(scan).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleScan.resolve({ success: true, spaces: [makeSpace('stale')] });
      await staleScan.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getSpacesSnapshotFor('/A')).toMatchObject({
      spaces: [],
      ready: false,
      error: false,
      parseWarnings: [],
    });

    await act(async () => {
      freshScan.resolve({ success: true, spaces: [makeSpace('fresh')] });
      await freshScan.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getSpacesSnapshotFor('/A').spaces.map((space) => space.name)).toEqual(['fresh']);
  });

  it('synchronously zeros the hook snapshot on the first render after a workspace switch', async () => {
    const secondScan = deferred<ScanSpacesResult>();
    const scan = vi.fn()
      .mockResolvedValueOnce({ success: true, spaces: [makeSpace('from-A')] })
      .mockReturnValueOnce(secondScan.promise);
    setScanSpaces(scan);

    const observed: ReturnType<typeof useSpacesData>[] = [];
    const Probe: React.FC<{ dir: string }> = ({ dir }) => {
      observed.push(useSpacesData(dir));
      return null;
    };

    await act(async () => {
      root.render(<Probe dir="/A" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(observed[observed.length - 1]).toMatchObject({
      ready: true,
      spaces: [expect.objectContaining({ name: 'from-A' })],
    });

    const beforeSwitchRenderCount = observed.length;
    act(() => { root.render(<Probe dir="/B" />); });

    const firstPostFlipRender = observed[beforeSwitchRenderCount];
    expect(firstPostFlipRender).toMatchObject({
      spaces: [],
      ready: false,
      loading: true,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
    });
  });

  it('getSpacesSnapshotFor() returns a zeroed snapshot for a mismatched workspace', async () => {
    const scan = vi.fn().mockResolvedValue({ success: true, spaces: [makeSpace('from-A')] });
    setScanSpaces(scan);

    await fetchSpaces('/A');

    expect(getSpacesSnapshotFor('/other')).toMatchObject({
      spaces: [],
      ready: false,
      error: false,
      errorMessage: undefined,
      parseWarnings: [],
    });
  });

  it('getSpacesSnapshotFor() returns stale cached data for a matching workspace while refresh is in flight', async () => {
    const refreshScan = deferred<ScanSpacesResult>();
    const scan = vi.fn()
      .mockResolvedValueOnce({ success: true, spaces: [makeSpace('cached-A')] })
      .mockReturnValueOnce(refreshScan.promise);
    setScanSpaces(scan);

    const observed: ReturnType<typeof useSpacesData>[] = [];
    const Probe: React.FC = () => {
      observed.push(useSpacesData('/A'));
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getSpacesSnapshotFor('/A')).toMatchObject({
      spaces: [expect.objectContaining({ name: 'cached-A' })],
      ready: true,
      error: false,
      parseWarnings: [],
    });

    act(() => { invalidateSpaces('/A'); });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(scan).toHaveBeenCalledTimes(2);
    expect(getSpacesSnapshotFor('/A')).toMatchObject({
      spaces: [expect.objectContaining({ name: 'cached-A' })],
      ready: true,
      error: false,
      parseWarnings: [],
    });

    await act(async () => {
      refreshScan.resolve({ success: true, spaces: [makeSpace('fresh-A')] });
      await refreshScan.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(observed[observed.length - 1]?.spaces.map((space) => space.name)).toEqual(['fresh-A']);
  });
});
