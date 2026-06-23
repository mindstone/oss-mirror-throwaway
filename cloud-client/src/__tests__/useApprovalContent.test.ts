import React, { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { useApprovalContent } from '../hooks/useApprovalContent';
import type { CloudStagedToolCall, MemoryWriteApproval, StagedFile } from '../types';

// ---------- Helpers ----------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const strictModeWrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(StrictMode, null, children);

function makeStagedFile(overrides: Partial<StagedFile> = {}): StagedFile {
  return {
    id: 'staged-1',
    realPath: 'memory/inbox/notes.md',
    spaceName: 'Memory',
    spacePath: 'memory/inbox/notes.md',
    sessionId: 'session-1',
    baseHash: 'existing-hash',
    summary: 'Test summary',
    stagedAt: Date.UTC(2026, 3, 16),
    sensitivity: 'high',
    ...overrides,
  };
}

function makeMemoryApproval(overrides: Partial<MemoryWriteApproval> & { content?: string } = {}): MemoryWriteApproval & { content?: string } {
  return {
    toolUseId: 'tool-use-1',
    originalTurnId: 'turn-1',
    originalSessionId: 'session-1',
    spaceName: 'Memory',
    filePath: 'memory/notes.md',
    summary: 'Memory summary',
    contentPreview: 'preview only',
    timestamp: Date.UTC(2026, 3, 16),
    spacePath: 'memory/notes.md',
    sharing: 'private',
    isNewFile: false,
    blockedBy: 'safety_prompt',
    ...overrides,
  };
}

function makeCloudToolCall(overrides: Partial<CloudStagedToolCall> = {}): CloudStagedToolCall {
  return {
    id: 'tool-call-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    timestamp: Date.UTC(2026, 3, 16),
    status: 'pending',
    displayName: 'Send email',
    toolCategory: 'communication',
    riskLevel: 'high',
    reason: 'because',
    mcpPayload: { server: 'gmail', tool: 'send' } as unknown as CloudStagedToolCall['mcpPayload'],
    ...overrides,
  };
}

// ---------- Tests ----------

describe('useApprovalContent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns initial state when item is null', () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn();
    const { result } = renderHook(
      () => useApprovalContent(null, { readStagedContent, readWorkspaceFile }),
      { wrapper: strictModeWrapper },
    );
    expect(result.current).toEqual({
      status: 'not-loaded',
      staged: null,
      original: null,
      loading: false,
      error: null,
      isNewFile: false,
      conflict: false,
      changeType: 'modify',
      refetch: expect.any(Function),
    });
    expect(readStagedContent).not.toHaveBeenCalled();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('CloudStagedToolCall resolves to neutral state without IPC', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn();
    const { result } = renderHook(
      () => useApprovalContent(makeCloudToolCall(), { readStagedContent, readWorkspaceFile }),
      { wrapper: strictModeWrapper },
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.staged).toBeNull();
    expect(result.current.original).toBeNull();
    expect(result.current.error).toBeNull();
    expect(readStagedContent).not.toHaveBeenCalled();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('staged file: fetches staged + original and detects no conflict when equal', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('hello world');
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'hello world' });

    const file = makeStagedFile({ baseHash: 'existing-hash' });
    const { result } = renderHook(
      () => useApprovalContent(file, { readStagedContent, readWorkspaceFile }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.staged).toBe('hello world');
    expect(result.current.original).toBe('hello world');
    expect(result.current.conflict).toBe(false);
    expect(result.current.changeType).toBe('modify');
    expect(result.current.isNewFile).toBe(false);
    expect(result.current.error).toBeNull();
    expect(readStagedContent).toHaveBeenCalledWith('staged-1', expect.any(AbortSignal));
    expect(readWorkspaceFile).toHaveBeenCalledWith('memory/inbox/notes.md', expect.any(AbortSignal));
  });

  it('staged file: detects conflict when staged differs from original', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('new text');
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'old text' });
    const { result } = renderHook(
      () => useApprovalContent(makeStagedFile(), { readStagedContent, readWorkspaceFile }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conflict).toBe(true);
    expect(result.current.staged).toBe('new text');
    expect(result.current.original).toBe('old text');
    expect(result.current.changeType).toBe('modify');
  });

  it('staged file with baseHash = new-file skips original fetch', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('brand new content');
    const readWorkspaceFile = vi.fn();
    const { result } = renderHook(
      () => useApprovalContent(makeStagedFile({ baseHash: 'new-file' }), {
        readStagedContent,
        readWorkspaceFile,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('brand new content');
    expect(result.current.original).toBeNull();
    expect(result.current.isNewFile).toBe(true);
    expect(result.current.changeType).toBe('create');
    expect(result.current.conflict).toBe(false);
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('staged file: handles canonical { content, error } IPC response shape', async () => {
    const readStagedContent = vi.fn().mockResolvedValue({ content: 'cloud body' });
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'cloud body' });
    const { result } = renderHook(
      () => useApprovalContent(makeStagedFile(), { readStagedContent, readWorkspaceFile }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('cloud body');
    expect(result.current.conflict).toBe(false);
  });

  it('staged file: null staged content (cloud IPC) resolves to null staged', async () => {
    const readStagedContent = vi.fn().mockResolvedValue({ content: null });
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'original' });
    const { result } = renderHook(
      () => useApprovalContent(makeStagedFile(), { readStagedContent, readWorkspaceFile }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBeNull();
    expect(result.current.original).toBe('original');
    // staged is null → can't detect conflict; not a conflict.
    expect(result.current.conflict).toBe(false);
    expect(result.current.changeType).toBe('delete');
  });

  it('staged file: canonical { content: null, error } IPC response surfaces as hook-level error (F2-1)', async () => {
    // Regression guard for D8 ("Fail loudly, not silently"). When
    // `memory:staging-get-content` reports `{ content: null, error: '...' }`,
    // the hook MUST surface a hook-level error + emit the `approval.content-fetch`
    // log, NOT silently render "no content".
    const readStagedContent = vi.fn().mockResolvedValue({
      content: null,
      error: 'Invalid staged file ID',
    });
    const readWorkspaceFile = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useApprovalContent(makeStagedFile(), {
          readStagedContent,
          readWorkspaceFile,
          onError,
        }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Hook surfaces a user-visible error (never silently defaults).
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.kind).toBe('other');
    expect(result.current.error?.detail).toBe('Invalid staged file ID');
    // Staged content is null; conflict must NOT be silently false-positive.
    expect(result.current.staged).toBeNull();
    expect(result.current.conflict).toBe(false);
    // Observability: approval.content-fetch breadcrumb must fire (Stage 2 D8).
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({
      itemId: 'staged-1',
      kind: 'other',
      detail: 'Invalid staged file ID',
    });
    // Staged-content failure short-circuits — no remote fetch attempt.
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('staged file: canonical error response on new file still surfaces as hard error (F2-2)', async () => {
    // Staged-content failures are always errors, regardless of `isNewFile`
    // (per plan's Failure Mode Matrix entry for useApprovalContent).
    const readStagedContent = vi.fn().mockResolvedValue({
      content: null,
      error: 'Invalid staged file ID',
    });
    const readWorkspaceFile = vi.fn();
    const { result } = renderHook(
      () =>
        useApprovalContent(makeStagedFile({ baseHash: 'new-file' }), {
          readStagedContent,
          readWorkspaceFile,
        }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('other');
    expect(result.current.staged).toBeNull();
    // Metadata `isNewFile` is preserved on the result for UI branching, but
    // `error` is also surfaced so consumers can render a hard error rather
    // than the silent new-file fallback.
    expect(result.current.isNewFile).toBe(true);
  });

  // =============================================================================
  // Refetch API
  // =============================================================================

  it('refetch() re-runs the content fetch for the current item', async () => {
    let stagedCallCount = 0;
    const readStagedContent = vi.fn().mockImplementation(async () => {
      stagedCallCount += 1;
      return `body-${stagedCallCount}`;
    });
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'original' });
    const { result } = renderHook(() =>
      useApprovalContent(makeStagedFile(), { readStagedContent, readWorkspaceFile }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('body-1');
    expect(readStagedContent).toHaveBeenCalledTimes(1);

    // Wire the Retry affordance
    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.staged).toBe('body-2'));
    expect(readStagedContent).toHaveBeenCalledTimes(2);
  });

  it('refetch() is a no-op when item is null', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn();
    const { result } = renderHook(() =>
      useApprovalContent(null, { readStagedContent, readWorkspaceFile }),
    );
    // Function exists and does not throw, but triggers no IPC.
    await act(async () => {
      result.current.refetch();
    });
    expect(readStagedContent).not.toHaveBeenCalled();
  });

  it('refetch() after an error clears the error and reloads successfully', async () => {
    // First call fails (permission), second call succeeds.
    let call = 0;
    const readStagedContent = vi.fn().mockResolvedValue('staged body');
    const readWorkspaceFile = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return { content: 'original body' };
    });
    const { result } = renderHook(() =>
      useApprovalContent(makeStagedFile(), { readStagedContent, readWorkspaceFile }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('permission');

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.original).toBe('original body');
  });

  it('memory approval: reads inline content and fetches remote', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'old' });
    const { result } = renderHook(
      () =>
        useApprovalContent(
          makeMemoryApproval({ content: 'new content' } as unknown as Partial<MemoryWriteApproval>),
          { readStagedContent, readWorkspaceFile },
        ),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('new content');
    expect(result.current.original).toBe('old');
    expect(result.current.conflict).toBe(true);
    expect(readStagedContent).not.toHaveBeenCalled();
    expect(readWorkspaceFile).toHaveBeenCalledWith('memory/notes.md', expect.any(AbortSignal));
  });

  it('memory approval: falls back to contentPreview when content missing', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'preview only' });
    const item = makeMemoryApproval({ contentPreview: 'preview only' });
    const { result } = renderHook(
      () => useApprovalContent(item, { readStagedContent, readWorkspaceFile }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('preview only');
    expect(result.current.conflict).toBe(false);
  });

  it('memory approval: recovers content when inline payload is empty', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'old content' });
    const readMemoryApprovalContent = vi.fn().mockResolvedValue('recovered content');
    const item = makeMemoryApproval({
      content: '',
      contentPreview: '',
      originalSessionId: 'session-1',
      filePath: 'memory/notes.md',
    });
    const { result } = renderHook(
      () =>
        useApprovalContent(item, {
          readStagedContent,
          readWorkspaceFile,
          readMemoryApprovalContent,
        }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBe('revealed');
    expect(result.current.staged).toBe('recovered content');
    expect(result.current.error).toBeNull();
    expect(readMemoryApprovalContent).toHaveBeenCalledWith(
      {
        toolUseId: 'tool-use-1',
        originalSessionId: 'session-1',
        filePath: 'memory/notes.md',
        approvalIdentifier: undefined,
      },
      expect.any(AbortSignal),
    );
  });

  it('memory approval: surfaces error when required recovery misses', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn();
    const readMemoryApprovalContent = vi.fn().mockResolvedValue(null);
    const item = makeMemoryApproval({
      content: '',
      contentPreview: '',
      originalSessionId: 'session-1',
      filePath: 'memory/notes.md',
    });
    const { result } = renderHook(
      () =>
        useApprovalContent(item, {
          readStagedContent,
          readWorkspaceFile,
          readMemoryApprovalContent,
        }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBe('error');
    expect(result.current.error?.kind).toBe('other');
    expect(result.current.error?.detail).toContain('Could not recover memory approval content');
    expect(result.current.staged).toBeNull();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('memory approval: isNewFile = true skips remote fetch', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn();
    const item = makeMemoryApproval({ isNewFile: true, contentPreview: 'brand new' });
    const { result } = renderHook(
      () => useApprovalContent(item, { readStagedContent, readWorkspaceFile }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('brand new');
    expect(result.current.original).toBeNull();
    expect(result.current.isNewFile).toBe(true);
    expect(result.current.changeType).toBe('create');
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  // =============================================================================
  // Error classification
  // =============================================================================

  it('ENOENT on remote fetch → isNewFile: true, error: null, log emitted', async () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    const readStagedContent = vi.fn().mockResolvedValue('staged body');
    const readWorkspaceFile = vi.fn().mockRejectedValue(err);
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useApprovalContent(makeStagedFile(), {
          readStagedContent,
          readWorkspaceFile,
          onError,
        }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('staged body');
    expect(result.current.original).toBeNull();
    expect(result.current.isNewFile).toBe(true);
    expect(result.current.conflict).toBe(false);
    expect(result.current.changeType).toBe('create');
    expect(result.current.error).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({
      itemId: 'staged-1',
      kind: 'missing',
      detail: expect.stringContaining('ENOENT'),
    });
  });

  it('permission denied on remote fetch → error.kind = permission', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const readStagedContent = vi.fn().mockResolvedValue('staged');
    const readWorkspaceFile = vi.fn().mockRejectedValue(err);
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useApprovalContent(makeStagedFile(), {
          readStagedContent,
          readWorkspaceFile,
          onError,
        }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('permission');
    expect(result.current.staged).toBe('staged');
    expect(result.current.original).toBeNull();
    // NOT treated as new file — the file might exist but we cannot read it.
    expect(result.current.isNewFile).toBe(false);
    expect(onError).toHaveBeenCalledWith({
      itemId: 'staged-1',
      kind: 'permission',
      detail: expect.any(String),
    });
  });

  it('network error on remote fetch → error.kind = network', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('staged');
    const readWorkspaceFile = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(
      () =>
        useApprovalContent(makeStagedFile(), {
          readStagedContent,
          readWorkspaceFile,
        }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('network');
  });

  it('unclassified error on remote fetch → error.kind = other', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('staged');
    const readWorkspaceFile = vi.fn().mockRejectedValue(new Error('something strange'));
    const { result } = renderHook(
      () =>
        useApprovalContent(makeStagedFile(), {
          readStagedContent,
          readWorkspaceFile,
        }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('other');
    expect(result.current.error?.detail).toBe('something strange');
  });

  it('error fetching staged content surfaces error state', async () => {
    const readStagedContent = vi.fn().mockRejectedValue(new Error('boom'));
    const readWorkspaceFile = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useApprovalContent(makeStagedFile(), {
          readStagedContent,
          readWorkspaceFile,
          onError,
        }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('other');
    expect(result.current.staged).toBeNull();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('binary extension short-circuits with error.kind = binary, no IPC', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useApprovalContent(
          makeStagedFile({ realPath: 'assets/image.png' }),
          { readStagedContent, readWorkspaceFile, onError },
        ),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.kind).toBe('binary');
    expect(result.current.staged).toBeNull();
    expect(result.current.original).toBeNull();
    expect(readStagedContent).not.toHaveBeenCalled();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({
      itemId: 'staged-1',
      kind: 'binary',
      detail: expect.stringContaining('image.png'),
    });
  });

  // =============================================================================
  // Cancellation
  // =============================================================================

  it('aborts the in-flight fetch when item id changes', async () => {
    // Route the deferred by item id so that the mock is robust to the first
    // effect aborting before it reaches the readWorkspaceFile call.
    const stagedDeferredById: Record<string, ReturnType<typeof deferred<string>>> = {
      first: deferred<string>(),
      second: deferred<string>(),
    };
    const originalDeferredByPath: Record<string, ReturnType<typeof deferred<{ content: string }>>> = {
      '/first': deferred<{ content: string }>(),
      '/second': deferred<{ content: string }>(),
    };
    const readStagedContent = vi.fn<(id: string, signal: AbortSignal) => Promise<string>>()
      .mockImplementation(async (id) => stagedDeferredById[id].promise);
    const readWorkspaceFile = vi.fn<(path: string, signal: AbortSignal) => Promise<{ content: string }>>()
      .mockImplementation(async (path) => originalDeferredByPath[path].promise);

    const firstFile = makeStagedFile({ id: 'first', realPath: '/first' });
    const secondFile = makeStagedFile({ id: 'second', realPath: '/second' });

    const { result, rerender } = renderHook(
      ({ file }: { file: StagedFile }) =>
        useApprovalContent(file, { readStagedContent, readWorkspaceFile }),
      { initialProps: { file: firstFile } },
    );

    // Switch to the second item before the first request resolves.
    rerender({ file: secondFile });

    // Resolve the first (now stale) request. The hook must not update state
    // based on it (controller for first effect was aborted).
    await act(async () => {
      stagedDeferredById.first.resolve('first staged');
      originalDeferredByPath['/first'].resolve({ content: 'first original' });
      await stagedDeferredById.first.promise;
      await originalDeferredByPath['/first'].promise;
    });

    // Now resolve the second (active) request.
    await act(async () => {
      stagedDeferredById.second.resolve('second staged');
      originalDeferredByPath['/second'].resolve({ content: 'second original' });
      await stagedDeferredById.second.promise;
      await originalDeferredByPath['/second'].promise;
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('second staged');
    expect(result.current.original).toBe('second original');
  });

  it('cleans up on unmount without setState warnings', async () => {
    const stagedDeferred = deferred<string>();
    const readStagedContent = vi.fn().mockReturnValue(stagedDeferred.promise);
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'o' });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(
      () =>
        useApprovalContent(makeStagedFile(), {
          readStagedContent,
          readWorkspaceFile,
        }),
    );
    expect(result.current.loading).toBe(true);

    unmount();

    // Resolving after unmount must not produce a warning/error.
    await act(async () => {
      stagedDeferred.resolve('late');
      await stagedDeferred.promise;
    });

    // We don't assert 0 console errors globally (the wrapper may have its own)
    // — only that no "setState on unmounted component"-style message appeared.
    const unmountWarnings = consoleErrorSpy.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('unmounted')),
    );
    expect(unmountWarnings).toEqual([]);
    consoleErrorSpy.mockRestore();
  });

  it('resets to initial state when item transitions to null', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('staged body');
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'original' });
    const { result, rerender } = renderHook(
      ({ file }: { file: StagedFile | null }) =>
        useApprovalContent(file, { readStagedContent, readWorkspaceFile }),
      { initialProps: { file: makeStagedFile() as StagedFile | null } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.staged).toBe('staged body');

    rerender({ file: null });
    expect(result.current).toEqual({
      status: 'not-loaded',
      staged: null,
      original: null,
      loading: false,
      error: null,
      isNewFile: false,
      conflict: false,
      changeType: 'modify',
      refetch: expect.any(Function),
    });
  });

  it('accepts inline-arrow callbacks without restarting the effect', async () => {
    const stagedMock = vi.fn<(id: string, signal: AbortSignal) => Promise<string>>()
      .mockResolvedValue('body');
    const workspaceMock = vi.fn<(path: string, signal: AbortSignal) => Promise<{ content: string }>>()
      .mockResolvedValue({ content: 'orig' });
    const file = makeStagedFile();

    const { result, rerender } = renderHook(
      ({ rev }: { rev: number }) =>
        // Inline arrow creates a new callback identity on every render. The
        // hook must not re-fire the fetch because of this.
        useApprovalContent(file, {
          readStagedContent: (id: string, signal: AbortSignal) => stagedMock(id, signal),
          readWorkspaceFile: (path: string, signal: AbortSignal) => workspaceMock(path, signal),
        }) && rev,
      { initialProps: { rev: 0 } },
    );

    await waitFor(() => expect(result.current).toBeDefined());

    const stagedCallsAfterFirstRender = stagedMock.mock.calls.length;
    rerender({ rev: 1 });
    rerender({ rev: 2 });

    // Give microtasks a chance to settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(stagedMock.mock.calls.length).toBe(stagedCallsAfterFirstRender);
    expect(workspaceMock.mock.calls.length).toBeLessThanOrEqual(stagedCallsAfterFirstRender);
  });
});

// Type-assertion helper: confirms we didn't accidentally weaken the return type.
// (Kept lightweight; full contract is exercised by behavioral tests above.)
describe('useApprovalContent return type', () => {
  it('has the documented shape', () => {
    const mocks = {
      readStagedContent: vi.fn() as Mock,
      readWorkspaceFile: vi.fn() as Mock,
    };
    const { result } = renderHook(() => useApprovalContent(null, mocks));
    const snapshot = result.current;
    expect(['not-loaded', 'loading', 'revealed', 'empty', 'error']).toContain(snapshot.status);
    expect(typeof snapshot.loading).toBe('boolean');
    expect(typeof snapshot.isNewFile).toBe('boolean');
    expect(typeof snapshot.conflict).toBe('boolean');
    expect(snapshot.staged === null || typeof snapshot.staged === 'string').toBe(true);
    expect(snapshot.original === null || typeof snapshot.original === 'string').toBe(true);
    expect(snapshot.error === null || (typeof snapshot.error === 'object' && typeof snapshot.error.kind === 'string')).toBe(true);
    expect(['create', 'modify', 'delete']).toContain(snapshot.changeType);
    expect(typeof snapshot.refetch).toBe('function');
  });
});
