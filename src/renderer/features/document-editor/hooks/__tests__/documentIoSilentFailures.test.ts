// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  createMockWindowApi,
  flushAsync,
  renderHook,
  setupFakeTimers,
  cleanupFakeTimers,
} from '@renderer/test-utils';
import type { EmitLogFn } from '@renderer/contexts';
import { useDocumentFileIO } from '../useDocumentFileIO';

// Tests for the Cluster 1 silent-failure sweep, Class B (surface-only).
// See docs/plans/260428_document_io_silent_failure_sweep_class_b.md
//
// Each test asserts: structured emitLog event fires, level is correct,
// no privacy-sensitive fields leak (paths/basenames/content/hashes), and
// for toast-emitting sites the user-visible toast fires the right number
// of times with `variant: 'error'`.

 
vi.mock('@renderer/utils/sha256Hex', () => ({
  sha256HexUtf8: vi.fn(async (text: string) => `hash:${text}`),
}));

type LibraryChangedListener = (payload: unknown) => void;

type ToastOptions = { title: string; description?: string; variant?: 'default' | 'error' };

type LoggedPayload = {
  level?: string;
  context?: Record<string, unknown>;
};

const findEmitLogCall = (
  mock: ReturnType<typeof vi.fn>,
  matcher: (ctx: Record<string, unknown> | undefined) => boolean,
): LoggedPayload | undefined => {
  const call = mock.mock.calls.find((args: unknown[]) => {
    const payload = args[0] as LoggedPayload | undefined;
    return matcher(payload?.context);
  });
  return call ? (call[0] as LoggedPayload) : undefined;
};

// Privacy invariant: scan the entire emitLog mock for path / basename /
// content / hash / message-fragment leaks. Includes the path-bearing
// error message text used in the privacy-honesty test.
const assertNoSensitiveFields = (mock: ReturnType<typeof vi.fn>) => {
  const stringified = JSON.stringify(mock.mock.calls);
  expect(stringified).not.toContain('notes/test.md');
  expect(stringified).not.toContain('test.md');
  expect(stringified).not.toContain('secret.md');
  expect(stringified).not.toContain('/Users/test/workspace/');
  expect(stringified).not.toContain('Local edit');
  expect(stringified).not.toContain('External content');
  expect(stringified).not.toContain('hash:');
  // Path-bearing error message from the privacy-honesty test.
  expect(stringified).not.toContain('permission denied');
  expect(stringified).not.toContain('open ');
  expect(stringified).not.toMatch(/EACCES: permission denied, open '/);
  expect(stringified).not.toMatch(/ENOENT: no such file or directory/);
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface MountOptions {
  readFileMock?: ReturnType<typeof vi.fn>;
  readFileBase64Mock?: ReturnType<typeof vi.fn>;
  writeFileMock?: ReturnType<typeof vi.fn>;
  settingsGetMock?: ReturnType<typeof vi.fn>;
  getStagedFilesMock?: ReturnType<typeof vi.fn>;
  publishStagedFileMock?: ReturnType<typeof vi.fn>;
  keepStagedFilePrivateMock?: ReturnType<typeof vi.fn>;
  documentPath?: string | null;
  emitLogMock?: ReturnType<typeof vi.fn>;
  showToastMock?: ReturnType<typeof vi.fn>;
  /**
   * When true, the hook is mounted WITHOUT an `emitLog` sink, exercising the
   * AMD.6 console.error fallback path in `flushAnnotationWriteNow`.
   */
  omitEmitLog?: boolean;
}

async function mountIO(opts: MountOptions = {}) {
  const documentPath = opts.documentPath === undefined ? 'notes/test.md' : opts.documentPath;
  const emitLogMock = opts.emitLogMock ?? vi.fn();
  const showToastMock: ReturnType<typeof vi.fn> = opts.showToastMock ?? vi.fn();
  const readFileMock = opts.readFileMock ?? vi.fn().mockResolvedValue({ content: 'Base content', updatedAt: 1 });
  const writeFileMock = opts.writeFileMock ?? vi.fn().mockResolvedValue({
    result: 'ok',
    path: documentPath ?? 'notes/test.md',
    updatedAt: Date.now(),
    currentHash: 'hash:write',
  });

  let libraryChangedListener: LibraryChangedListener | null = null;

  createMockWindowApi('settingsApi', {
    get: opts.settingsGetMock ?? vi.fn().mockResolvedValue({ coreDirectory: '/workspace' }),
  });
  createMockWindowApi('libraryApi', {
    readFile: readFileMock,
    writeFile: writeFileMock,
    readFileBase64: opts.readFileBase64Mock ?? vi.fn(),
  });
  createMockWindowApi('api', {
    onLibraryChanged: vi.fn((listener: LibraryChangedListener) => {
      libraryChangedListener = listener;
      return () => {
        if (libraryChangedListener === listener) {
          libraryChangedListener = null;
        }
      };
    }),
    getStagedFiles: opts.getStagedFilesMock ?? vi.fn().mockResolvedValue([]),
    publishStagedFile: opts.publishStagedFileMock ?? vi.fn().mockResolvedValue({ status: 'success' }),
    keepStagedFilePrivate: opts.keepStagedFilePrivateMock ?? vi.fn().mockResolvedValue({ status: 'success' }),
  });

  const hook = renderHook(() =>
    useDocumentFileIO({
      documentPath,
      ...(opts.omitEmitLog
        ? {}
        : { emitLog: emitLogMock as unknown as EmitLogFn }),
      showToast: showToastMock as unknown as (options: ToastOptions) => void,
    }),
  );

  // Drain initial async effects (settings fetch + load).
  for (let i = 0; i < 6; i++) {
    await flushAsync();
    if (documentPath === null) break;
    if (hook.result.current.isEditing && hook.result.current.content !== null) break;
    if (hook.result.current.error !== null) break;
    if (hook.result.current.pendingApproval !== null) break;
  }

  return {
    ...hook,
    readFileMock,
    writeFileMock,
    emitLogMock,
    showToastMock,
  };
}

async function flushUntil(predicate: () => boolean, maxIterations = 12): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return;
    await flushAsync();
  }
}

const STORAGE_FULL_TOAST = {
  title: 'Your storage is full.',
  description: 'Free up some space and try again.',
  variant: 'error' as const,
};

const PERMISSION_DENIED_TOAST = {
  title: "Rebel can't write to this file.",
  description: 'It may be read-only — check permissions and try again.',
  variant: 'error' as const,
};

const GENERIC_WRITE_TOAST = {
  title: 'Unable to save file changes.',
  variant: 'error' as const,
};

const getErrorToastCalls = (showToastMock: ReturnType<typeof vi.fn>) =>
  showToastMock.mock.calls.filter((args: unknown[]) =>
    (args[0] as ToastOptions | undefined)?.variant === 'error',
  );

async function expectTaggedFlushFailure(
  errorCode: string,
  expectedToast: ToastOptions,
): Promise<Awaited<ReturnType<typeof mountIO>> & { rejection: Error }> {
  const writeFileMock = vi.fn().mockResolvedValue({ result: 'failed', errorCode });
  const mounted = await mountIO({ writeFileMock });

  act(() => {
    mounted.result.current.handleEditorBodyChange('Local edit');
  });

  let rejection: unknown;
  await act(async () => {
    try {
      await mounted.result.current.flush();
    } catch (err) {
      rejection = err;
    }
  });

  expect(rejection).toBeInstanceOf(Error);
  const error = rejection as Error & { code?: string };
  expect(error.constructor.name).toBe('WriteFailureError');
  expect(error.code).toBe(errorCode);

  const errorToastCalls = getErrorToastCalls(mounted.showToastMock);
  expect(errorToastCalls).toHaveLength(1);
  expect(errorToastCalls[0]?.[0]).toEqual(expectedToast);

  return { ...mounted, rejection: error };
}

describe('useDocumentFileIO silent-failure sweep — Class B', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFakeTimers();
  });

  afterEach(() => {
    cleanupFakeTimers();
  });

  // -------------------------------------------------------------------
  // T1: settings fetch warn — no toast
  // -------------------------------------------------------------------
  it('emits document_editor.settings_fetch_failed when settingsApi.get rejects', async () => {
    const settingsGetMock = vi.fn().mockRejectedValue(new Error('IPC unavailable'));
    const { emitLogMock, showToastMock, unmount } = await mountIO({ settingsGetMock });

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.settings_fetch_failed',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('warn');
    expect(call!.context?.errorName).toBe('Error');
    expect(call!.context?.errorKind).toBe('unknown');
    expect(showToastMock).not.toHaveBeenCalled();
    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T2: staged-file recovery warn — no new toast
  // -------------------------------------------------------------------
  it('emits document_editor.load_recovery_failed when getStagedFiles rejects in ENOENT fallback', async () => {
    const readFileMock = vi.fn().mockRejectedValue(new Error('Failed to load (ENOENT)'));
    const getStagedFilesMock = vi.fn().mockRejectedValue(Object.assign(new Error('IPC down'), { code: 'EIPC' }));
    const { emitLogMock, showToastMock, unmount } = await mountIO({
      readFileMock,
      getStagedFilesMock,
    });
    await flushAsync();

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.load_recovery_failed',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('warn');
    expect(call!.context?.errorName).toBe('Error');
    expect(call!.context?.errorCode).toBe('EIPC');
    expect(call!.context?.errorKind).toBe('fs');
    // No NEW toast — the existing load error path still surfaces via setLoadState.
    expect(showToastMock).not.toHaveBeenCalled();
    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  it('shows user-facing copy instead of raw ENOENT when a document is missing', async () => {
    const readFileMock = vi.fn().mockRejectedValue(
      new Error("Error invoking remote method 'library:read-file': Error: Unable to access the requested file. (ENOENT)"),
    );
    const { result, unmount } = await mountIO({ readFileMock });
    await flushAsync();

    expect(result.current.error).toBe(
      'This file is not available. It may have been moved, deleted, or the write did not finish. Close this tab and generate it again if you still need it.',
    );
    expect(result.current.error).not.toContain('library:read-file');
    expect(result.current.error).not.toContain('ENOENT');
    unmount();
  });

  it('shows user-facing copy instead of raw ENOENT when an image preview is missing', async () => {
    const readFileBase64Mock = vi.fn().mockRejectedValue(
      new Error("Error invoking remote method 'library:read-file-base64': Error: Unable to access the requested file. (ENOENT)"),
    );
    const { result, unmount } = await mountIO({
      readFileBase64Mock,
      documentPath: 'notes/missing.png',
    });
    await flushAsync();

    expect(result.current.imageState.error).toBe(
      'This file is not available. It may have been moved, deleted, or the write did not finish. Close this tab and generate it again if you still need it.',
    );
    expect(result.current.imageState.error).not.toContain('library:read-file-base64');
    expect(result.current.imageState.error).not.toContain('ENOENT');
    unmount();
  });

  // -------------------------------------------------------------------
  // T3: auto-save warn for unknown/non-actionable failures (NO toast).
  // Behavioral preservation check: isDirty stays true, statusText stays
  // 'Unsaved changes'.
  // -------------------------------------------------------------------
  it('emits document_editor.write_failed on unknown auto-save reject without toasting (status bar preserves dirty indicator)', async () => {
    const customError = new Error('write failed');
    customError.name = 'CustomError';
    const writeFileMock = vi.fn().mockRejectedValue(customError);
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushUntil(() => emitLogMock.mock.calls.length > 0);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'auto-save',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('warn');
    expect(call!.context).not.toHaveProperty('errorCode');
    expect(call!.context?.errorKind).toBe('unknown');

    // Auto-save fails silently for non-actionable errors only.
    expect(showToastMock).not.toHaveBeenCalled();
    expect(result.current.isDirty).toBe(true);
    expect(result.current.statusText).toBe('Unsaved changes');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T4: debounced annotation write — emitLog twice, toast once (5s dedupe)
  // -------------------------------------------------------------------
  it('debounced annotation write failure: emitLog every time, toast deduped within 5s', async () => {
    const writeFileMock = vi.fn().mockRejectedValue(new Error('write failed'));
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    // Force preview mode (not editing) so handleAnnotationContentChange goes through the debounced write path.
    act(() => {
      result.current.setIsEditing(false);
    });

    // First failed write.
    act(() => {
      result.current.handleAnnotationContentChange('annotation v1');
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    await flushUntil(() => writeFileMock.mock.calls.length >= 1);

    // Second failed write within 5s of the first toast.
    // Use a different content string AND advance timers further to ensure
    // the debounce actually fires a second time (debounce is leading-edge
    // suppressed within the trailing window otherwise).
    act(() => {
      result.current.handleAnnotationContentChange('annotation v2');
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await flushUntil(() => writeFileMock.mock.calls.length >= 2);
    // After writeFileMock has been called twice, the second .catch needs
    // microtask flushes to run its body.
    await flushUntil(() => emitLogMock.mock.calls.filter((args: unknown[]) => {
      const ctx = (args[0] as LoggedPayload | undefined)?.context;
      return ctx?.event === 'document_editor.annotation_write_failed' && ctx?.operation === 'debounce';
    }).length >= 2, 30);

    const calls = emitLogMock.mock.calls.filter((args: unknown[]) => {
      const ctx = (args[0] as LoggedPayload | undefined)?.context;
      return ctx?.event === 'document_editor.annotation_write_failed' && ctx?.operation === 'debounce';
    });
    // Contract: emitLog fires every time (full Sentry breadcrumb history),
    // toast deduped within 5s window. If writeFileMock was hit twice we
    // expect 2 emitLog calls; if only 1 (debounce coalesced) we still
    // expect 1 toast.
    expect(writeFileMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(writeFileMock.mock.calls.length);
    expect((calls[0][0] as LoggedPayload).level).toBe('error');

    // Toast should fire EXACTLY ONCE due to 5s dedupe (regardless of how
    // many emitLog calls fired).
    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) => {
      const opts = args[0] as ToastOptions | undefined;
      return opts?.variant === 'error';
    });
    expect(errorToastCalls.length).toBe(1);

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T5: stale-document / unmount toast suppressed
  // -------------------------------------------------------------------
  it('annotation write failure does NOT toast after unmount (isMountedRef guard)', async () => {
    let rejectWrite: ((err: Error) => void) | null = null;
    const writeFileMock = vi.fn(
      () => new Promise<never>((_resolve, reject) => {
        rejectWrite = reject;
      }),
    );

    const { result, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.setIsEditing(false);
    });
    act(() => {
      result.current.handleAnnotationContentChange('annotation v1');
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    await flushUntil(() => writeFileMock.mock.calls.length >= 1);
    expect(rejectWrite).not.toBeNull();

    // Unmount BEFORE the write rejects — `isMountedRef.current` becomes false.
    unmount();

    act(() => {
      rejectWrite?.(new Error('boom'));
    });
    await flushAsync();

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // T6: persistAnnotationsNow error + toast + rejection (Class A Batch 1)
  // -------------------------------------------------------------------
  it('persistAnnotationsNow failure emits annotation_write_failed (persist-now), shows error toast, AND rejects', async () => {
    const writeFileMock = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    await act(async () => {
      // Class A Batch 1: persistAnnotationsNow rejects on write failure.
      // Destructive-navigation callers (handleOpenLinkedFile,
      // handleOpenInLibrary) MUST abort on rejection.
      await expect(
        result.current.persistAnnotationsNow((content: string) => content + ' + ann'),
      ).rejects.toThrow();
    });
    await flushAsync();

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.annotation_write_failed' && ctx?.operation === 'persist-now',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');
    expect(call!.context?.errorCode).toBe('EBUSY');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);
    expect(errorToastCalls[0][0].title).toBe('Unable to save file changes.');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T7: resolveConflict('keep-editor') non-CAS rejection — emits existing
  // resolve_write_failed AND adds new toast.
  // -------------------------------------------------------------------
  it("resolveConflict('keep-editor') non-CAS reject still emits resolve_write_failed AND now shows error toast", async () => {
    // First write (auto-save during base load) → CAS conflict to seed conflict state.
    // Second write (resolveConflict('keep-editor')) → non-CAS throw.
    const writeFileMock = vi.fn()
      .mockResolvedValueOnce({ result: 'conflict', path: 'notes/test.md', currentHash: 'hash:cas-base' })
      .mockRejectedValueOnce(new Error('permission denied'));

    const readFileMock = vi.fn()
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 })
      .mockResolvedValueOnce({ content: 'External v1', updatedAt: 2 });

    const { result, emitLogMock, showToastMock, unmount } = await mountIO({
      readFileMock,
      writeFileMock,
    });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushUntil(() => result.current.conflictState !== null);

    await act(async () => {
      await result.current.resolveConflict('keep-editor');
    });
    await flushAsync();

    const failureCall = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.conflict.resolve_write_failed',
    );
    expect(failureCall).toBeDefined();
    expect(failureCall!.level).toBe('error');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);
    expect(errorToastCalls[0][0].title).toBe('Unable to save file changes.');

    unmount();
  });

  // -------------------------------------------------------------------
  // T8a: approvePending catch — IPC throws
  // -------------------------------------------------------------------
  it('approvePending catch fires approval_action_failed + error toast and returns false', async () => {
    const publishStagedFileMock = vi.fn().mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'EAGAIN' }),
    );
    const readFileMock = vi.fn().mockRejectedValue(new Error('Failed to load (ENOENT)'));
    const getStagedFilesMock = vi.fn().mockResolvedValue([
      {
        id: 'staged-1',
        realPath: 'notes/test.md',
        spaceName: 'space',
        summary: 's',
        stagedAt: 1,
      },
    ]);
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({
      readFileMock,
      getStagedFilesMock,
      publishStagedFileMock,
    });
    await flushUntil(() => result.current.pendingApproval !== null);

    let returned = true;
    await act(async () => {
      returned = await result.current.approvePending();
    });

    expect(returned).toBe(false);
    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.approval_action_failed' && ctx?.action === 'approve',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');
    expect(call!.context?.errorCode).toBe('EAGAIN');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T8b: approvePending status:'error' branch — non-throwing failure
  // -------------------------------------------------------------------
  it("approvePending result.status === 'error' fires approval_action_failed + error toast", async () => {
    const publishStagedFileMock = vi.fn().mockResolvedValue({ status: 'error', error: 'something failed' });
    const readFileMock = vi.fn().mockRejectedValue(new Error('Failed to load (ENOENT)'));
    const getStagedFilesMock = vi.fn().mockResolvedValue([
      {
        id: 'staged-1',
        realPath: 'notes/test.md',
        spaceName: 'space',
        summary: 's',
        stagedAt: 1,
      },
    ]);
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({
      readFileMock,
      getStagedFilesMock,
      publishStagedFileMock,
    });
    await flushUntil(() => result.current.pendingApproval !== null);

    let returned = true;
    await act(async () => {
      returned = await result.current.approvePending();
    });

    expect(returned).toBe(false);
    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.approval_action_failed' && ctx?.action === 'approve',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);

    unmount();
  });

  // -------------------------------------------------------------------
  // T9: denyPending — same shape as T8 but action:'deny'
  // -------------------------------------------------------------------
  it('denyPending catch fires approval_action_failed (deny) + error toast and returns false', async () => {
    const keepStagedFilePrivateMock = vi.fn().mockRejectedValue(new Error('boom'));
    const readFileMock = vi.fn().mockRejectedValue(new Error('Failed to load (ENOENT)'));
    const getStagedFilesMock = vi.fn().mockResolvedValue([
      {
        id: 'staged-1',
        realPath: 'notes/test.md',
        spaceName: 'space',
        summary: 's',
        stagedAt: 1,
      },
    ]);
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({
      readFileMock,
      getStagedFilesMock,
      keepStagedFilePrivateMock,
    });
    await flushUntil(() => result.current.pendingApproval !== null);

    let returned = true;
    await act(async () => {
      returned = await result.current.denyPending();
    });

    expect(returned).toBe(false);
    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.approval_action_failed' && ctx?.action === 'deny',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);

    unmount();
  });

  // -------------------------------------------------------------------
  // T9b: denyPending status:'error' branch
  // -------------------------------------------------------------------
  it("denyPending result.status === 'error' fires approval_action_failed (deny) + error toast", async () => {
    const keepStagedFilePrivateMock = vi.fn().mockResolvedValue({
      status: 'error',
      error: 'something failed',
    });
    const readFileMock = vi.fn().mockRejectedValue(new Error('Failed to load (ENOENT)'));
    const getStagedFilesMock = vi.fn().mockResolvedValue([
      {
        id: 'staged-1',
        realPath: 'notes/test.md',
        spaceName: 'space',
        summary: 's',
        stagedAt: 1,
      },
    ]);
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({
      readFileMock,
      getStagedFilesMock,
      keepStagedFilePrivateMock,
    });
    await flushUntil(() => result.current.pendingApproval !== null);

    let returned = true;
    await act(async () => {
      returned = await result.current.denyPending();
    });

    expect(returned).toBe(false);
    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.approval_action_failed' && ctx?.action === 'deny',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);

    unmount();
  });

  // -------------------------------------------------------------------
  // T9c: lastAnnotationToastAtRef resets on documentPath change so the
  // 5s dedupe window does NOT carry across documents (a stuck-failing
  // doc A must not suppress the first error toast on doc B).
  // -------------------------------------------------------------------
  it('annotation toast dedupe window resets when documentPath changes (no cross-document suppression)', async () => {
    const writeFileMock = vi.fn().mockRejectedValue(new Error('write failed'));
    const emitLogMock = vi.fn();
    const showToastMock = vi.fn();

    let libraryChangedListener: LibraryChangedListener | null = null;
    createMockWindowApi('settingsApi', {
      get: vi.fn().mockResolvedValue({ coreDirectory: '/workspace' }),
    });
    createMockWindowApi('libraryApi', {
      readFile: vi.fn().mockResolvedValue({ content: 'Base content', updatedAt: 1 }),
      writeFile: writeFileMock,
      readFileBase64: vi.fn(),
    });
    createMockWindowApi('api', {
      onLibraryChanged: vi.fn((listener: LibraryChangedListener) => {
        libraryChangedListener = listener;
        return () => {
          if (libraryChangedListener === listener) {
            libraryChangedListener = null;
          }
        };
      }),
      getStagedFiles: vi.fn().mockResolvedValue([]),
      publishStagedFile: vi.fn().mockResolvedValue({ status: 'success' }),
      keepStagedFilePrivate: vi.fn().mockResolvedValue({ status: 'success' }),
    });

    type Props = { documentPath: string };
    const hook = renderHook<ReturnType<typeof useDocumentFileIO>, Props>(
      ({ documentPath }) =>
        useDocumentFileIO({
          documentPath,
          emitLog: emitLogMock as unknown as EmitLogFn,
          showToast: showToastMock as unknown as (options: ToastOptions) => void,
        }),
      { initialProps: { documentPath: 'notes/a.md' } },
    );

    // Drain initial async effects on doc A.
    for (let i = 0; i < 6; i++) {
      await flushAsync();
      if (hook.result.current.isEditing && hook.result.current.content !== null) break;
    }

    // First failure on doc A — should fire 1 toast.
    act(() => { hook.result.current.setIsEditing(false); });
    act(() => { hook.result.current.handleAnnotationContentChange('a-edit'); });
    act(() => { vi.advanceTimersByTime(700); });
    await flushUntil(() => writeFileMock.mock.calls.length >= 1);
    await flushUntil(() => showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error').length >= 1);

    expect(showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error').length).toBe(1);

    // Switch to doc B mid-failure-loop — the documentPath effect must
    // reset lastAnnotationToastAtRef to 0.
    hook.rerender({ documentPath: 'notes/b.md' });
    for (let i = 0; i < 6; i++) {
      await flushAsync();
    }

    // Failure on doc B — should fire a SECOND toast (dedupe window reset).
    act(() => { hook.result.current.setIsEditing(false); });
    act(() => { hook.result.current.handleAnnotationContentChange('b-edit'); });
    act(() => { vi.advanceTimersByTime(700); });
    await flushUntil(() => writeFileMock.mock.calls.length >= 2);
    await flushUntil(() => showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error').length >= 2);

    const errorToasts = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error');
    expect(errorToasts.length).toBe(2);

    hook.unmount();
  });

  // -------------------------------------------------------------------
  // T10: privacy invariant with path-bearing error message
  // -------------------------------------------------------------------
  it('classifyError never leaks err.message even when it contains a workspace path', async () => {
    const pathBearingError = Object.assign(
      new Error("EACCES: permission denied, open '/Users/test/workspace/secret.md'"),
      { code: 'EACCES' },
    );
    const writeFileMock = vi.fn().mockRejectedValue(pathBearingError);
    const { result, emitLogMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushUntil(() => emitLogMock.mock.calls.length > 0);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed',
    );
    expect(call).toBeDefined();
    expect(call!.context?.errorCode).toBe('EACCES');
    expect(call!.context?.errorKind).toBe('fs');

    // The full assertion: no path / message fragment leaks anywhere in
    // any captured emitLog payload.
    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T11: ZodError name survives the whitelist (regression guard).
  // The IPC boundary is contract-first with Zod; a ZodError on
  // settingsApi.get / getStagedFiles / etc. is a plausible failure mode
  // at the emit sites covered here. If KNOWN_ERROR_NAMES drops 'ZodError'
  // again the on-call dashboard loses signal — clamps to 'CustomError'.
  // -------------------------------------------------------------------
  it('classifyError surfaces ZodError verbatim (whitelist regression guard)', async () => {
    class ZodError extends Error {
      override name = 'ZodError';
    }
    const settingsGetMock = vi.fn().mockRejectedValue(new ZodError('invalid settings shape'));
    const { emitLogMock, unmount } = await mountIO({ settingsGetMock });

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.settings_fetch_failed',
    );
    expect(call).toBeDefined();
    expect(call!.context?.errorName).toBe('ZodError');
    expect(call!.context?.errorKind).toBe('unknown');
    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T12: flush awaits an in-flight debounced annotation write and rejects
  // on its failure. Uses a deferred promise seam to prove flush() stays
  // pending until the underlying write settles.
  // -------------------------------------------------------------------
  it('flush rejects on debounced annotation write failure after awaiting the in-flight write', async () => {
    const deferred = createDeferred<{ result: 'ok'; path: string; updatedAt: number; currentHash: string }>();
    const writeFileMock = vi.fn(() => deferred.promise);
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.setIsEditing(false);
    });
    act(() => {
      result.current.handleAnnotationContentChange('annotation deferred write');
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    await flushUntil(() => writeFileMock.mock.calls.length >= 1);

    let flushSettled = false;
    const flushPromise = result.current.flush();
    void flushPromise.then(
      () => { flushSettled = true; },
      () => { flushSettled = true; },
    );
    await flushAsync();
    expect(flushSettled).toBe(false);

    const writeError = Object.assign(new Error('disk busy'), { code: 'EBUSY' });
    deferred.reject(writeError);
    await expect(flushPromise).rejects.toBe(writeError);
    await flushUntil(() => emitLogMock.mock.calls.length >= 1);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.annotation_write_failed' && ctx?.operation === 'debounce',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');
    expect(call!.context?.errorCode).toBe('EBUSY');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);
    expect((errorToastCalls[0]?.[0] as ToastOptions | undefined)?.title).toBe('Unable to save file changes.');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T13: flush edit-content write failure propagates and emits the new
  // operation:'flush' telemetry + non-deduped toast.
  // -------------------------------------------------------------------
  it('flush rejects on edit-content write failure and surfaces operation:flush telemetry', async () => {
    const writeFileMock = vi.fn().mockRejectedValue(Object.assign(new Error('flush failed'), { code: 'EIO' }));
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });

    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('flush failed');
    });

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');
    expect(call!.context?.errorCode).toBe('EIO');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);
    expect((errorToastCalls[0]?.[0] as ToastOptions | undefined)?.title).toBe('Unable to save file changes.');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T14: flush happy path remains clean — resolves without failure
  // telemetry or error toast.
  // -------------------------------------------------------------------
  it('flush resolves cleanly when the pending edit-content write succeeds', async () => {
    const writeFileMock = vi.fn().mockResolvedValue({
      result: 'ok',
      path: 'notes/test.md',
      updatedAt: 2,
      currentHash: 'hash:write',
    });
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });

    await act(async () => {
      await expect(result.current.flush()).resolves.toBeUndefined();
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(emitLogMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
    unmount();
  });

  // -------------------------------------------------------------------
  // T18: concurrent flush calls do not share/drop failures; each caller
  // receives its own rejection and write attempt.
  // -------------------------------------------------------------------
  it('concurrent flush calls each receive their own rejection', async () => {
    const writeError = Object.assign(new Error('concurrent flush failed'), { code: 'EIO' });
    const writeFileMock = vi.fn().mockRejectedValue(writeError);
    const { result, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });

    let outcomes: PromiseSettledResult<void>[] = [];
    await act(async () => {
      const first = result.current.flush();
      const second = result.current.flush();
      outcomes = await Promise.allSettled([first, second]);
    });

    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.status).toBe('rejected');
    expect(outcomes[1]?.status).toBe('rejected');
    expect((outcomes[0] as PromiseRejectedResult | undefined)?.reason).toBe(writeError);
    expect((outcomes[1] as PromiseRejectedResult | undefined)?.reason).toBe(writeError);
    unmount();
  });

  // -------------------------------------------------------------------
  // T19: privacy regression guard for the new operation:'flush' catch
  // site specifically (distinct from T10's auto-save/debounce coverage).
  // -------------------------------------------------------------------
  it('rejected flush telemetry does not leak path-bearing error messages', async () => {
    const pathBearingError = Object.assign(
      new Error("EACCES: permission denied, open '/Users/test/workspace/secret.md'"),
      { code: 'EACCES' },
    );
    const writeFileMock = vi.fn().mockRejectedValue(pathBearingError);
    const { result, emitLogMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });

    await act(async () => {
      await expect(result.current.flush()).rejects.toBe(pathBearingError);
    });

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(call).toBeDefined();
    expect(call!.context?.errorCode).toBe('EACCES');
    expect(call!.context?.errorKind).toBe('fs');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T21: CAS conflict during flush propagates as rejection and uses the
  // same operation:'flush' observability path.
  // -------------------------------------------------------------------
  it('flush rejects and emits operation:flush telemetry when writeFile reports a CAS conflict', async () => {
    const writeFileMock = vi.fn().mockResolvedValue({
      result: 'conflict',
      path: 'notes/test.md',
      currentHash: 'hash:disk',
    });
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });

    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('changed elsewhere');
    });

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(1);
    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T22: the typing-burst annotation toast dedupe window resets when
  // flush() starts, so a recent inner toast cannot suppress feedback for
  // the explicit destructive-navigation flush.
  // -------------------------------------------------------------------
  it('annotation toast dedupe resets across the flush boundary', async () => {
    const writeFileMock = vi.fn().mockRejectedValue(new Error('write failed'));
    const { result, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.setIsEditing(false);
    });

    act(() => {
      result.current.handleAnnotationContentChange('annotation v1');
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    await flushUntil(() => showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    ).length >= 1);

    expect(showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    ).length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      result.current.handleAnnotationContentChange('annotation v2');
    });

    await expect(result.current.flush()).rejects.toThrow('write failed');
    await flushUntil(() => showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    ).length >= 2);

    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBe(2);
    unmount();
  });

  // -------------------------------------------------------------------
  // T23: Sticky-flag silent-loss guard (Class A Batch 1, Behavioral
  // Safety review).
  // Scenario: a debounced annotation write fails BEFORE the user clicks
  // navigate-away. The .finally() clears `debouncedWritePromiseRef`,
  // and the rejection has no awaiter. A later flush() — with no
  // in-flight write to await and no edit-content branch (preview mode)
  // — must STILL reject so the destructive navigation aborts. Without
  // the sticky failure flag, this is the silent-loss path the entire
  // batch is closing.
  // -------------------------------------------------------------------
  it('flush rejects on prior unresolved annotation failure even after the in-flight ref clears', async () => {
    const writeFileMock = vi.fn().mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.setIsEditing(false);
    });
    act(() => {
      result.current.handleAnnotationContentChange('annotation that will fail to save');
    });
    // Let the debounce fire and the failed write settle (catch runs,
    // sticky flag set, .finally() clears the in-flight ref).
    act(() => {
      vi.advanceTimersByTime(700);
    });
    await flushUntil(() => emitLogMock.mock.calls.length >= 1);
    await flushAsync();

    // User clicks navigate-away seconds later. flush() must reject
    // because the sticky failure flag is set, even though
    // debouncedWritePromiseRef.current is null and edit-content branch
    // is skipped (preview mode).
    await expect(result.current.flush()).rejects.toThrow('disk full');

    // Telemetry surfaces the resurrected failure with operation:'flush'.
    const flushCall = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(flushCall).toBeDefined();
    expect(flushCall!.level).toBe('error');

    // A user-visible toast surfaces (the original toast may have been
    // dismissed or never shown if the failure happened in another tab).
    const errorToastCalls = showToastMock.mock.calls.filter((args: unknown[]) =>
      (args[0] as ToastOptions | undefined)?.variant === 'error',
    );
    expect(errorToastCalls.length).toBeGreaterThanOrEqual(1);

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T24: tagged ENOSPC result → storage-full toast + tagged telemetry
  // -------------------------------------------------------------------
  it('T24: tagged ENOSPC failure produces storage-full toast and fs telemetry', async () => {
    const { emitLogMock, unmount } = await expectTaggedFlushFailure('ENOSPC', STORAGE_FULL_TOAST);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');
    expect(call!.context?.errorCode).toBe('ENOSPC');
    expect(call!.context?.errorKind).toBe('fs');
    expect(typeof call!.context?.errorName).toBe('string');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T25/T25b/T25c: permission/read-only errno cluster → same copy
  // -------------------------------------------------------------------
  it.each([
    ['T25: EACCES', 'EACCES'],
    ['T25b: EPERM', 'EPERM'],
    ['T25c: EROFS', 'EROFS'],
  ])('%s tagged failure produces permission-denied toast and tagged telemetry', async (_label, errorCode) => {
    const { emitLogMock, unmount } = await expectTaggedFlushFailure(errorCode, PERMISSION_DENIED_TOAST);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');
    expect(call!.context?.errorCode).toBe(errorCode);
    expect(call!.context?.errorKind).toBe('fs');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T25d: EDQUOT clusters with ENOSPC → storage-full copy
  // -------------------------------------------------------------------
  it('T25d: tagged EDQUOT failure produces storage-full toast and tagged telemetry', async () => {
    const { emitLogMock, unmount } = await expectTaggedFlushFailure('EDQUOT', STORAGE_FULL_TOAST);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(call).toBeDefined();
    expect(call!.context?.errorCode).toBe('EDQUOT');
    expect(call!.context?.errorKind).toBe('fs');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T26: UNKNOWN fallback from main does not pass errno whitelist
  // -------------------------------------------------------------------
  it('T26: tagged UNKNOWN failure produces generic toast and unknown-kind telemetry', async () => {
    const { emitLogMock, unmount } = await expectTaggedFlushFailure('UNKNOWN', GENERIC_WRITE_TOAST);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(call).toBeDefined();
    expect(call!.context).not.toHaveProperty('errorCode');
    expect(call!.context?.errorKind).toBe('unknown');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T26.5: CAS conflict is mutually exclusive with errno-tagged failures
  // -------------------------------------------------------------------
  it('T26.5: CAS conflict result preserves conflict path and does not show errno copy', async () => {
    const writeFileMock = vi.fn().mockResolvedValue({
      result: 'conflict',
      path: 'notes/test.md',
      currentHash: 'newhash',
    });
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });

    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('changed elsewhere');
    });

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'flush',
    );
    expect(call).toBeDefined();
    expect(call!.context).not.toHaveProperty('errorCode');

    const errorToastCalls = getErrorToastCalls(showToastMock);
    expect(errorToastCalls).toHaveLength(1);
    expect((errorToastCalls[0]?.[0] as ToastOptions | undefined)?.title).toContain('changed elsewhere');
    expect(JSON.stringify(errorToastCalls)).not.toContain(STORAGE_FULL_TOAST.title);
    expect(JSON.stringify(errorToastCalls)).not.toContain(PERMISSION_DENIED_TOAST.title);

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T27: flushAnnotationWriteNow privacy guard for path-bearing fs errors
  // -------------------------------------------------------------------
  it('T27: flushAnnotationWriteNow telemetry never leaks path-bearing fs error details', async () => {
    const pathBearingError = Object.assign(
      new Error("EACCES: permission denied, open '/Users/test/workspace/secret.md'"),
      {
        code: 'EACCES',
        path: '/Users/test/workspace/secret.md',
      },
    );
    const writeFileMock = vi.fn().mockRejectedValue(pathBearingError);
    const { result, emitLogMock, unmount } = await mountIO({ writeFileMock });

    await act(async () => {
      await expect(result.current.flushAnnotationWriteNow('content after annotation clear')).rejects.toBe(pathBearingError);
    });

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) =>
        ctx?.event === 'document_editor.annotation_write_failed'
        && ctx?.operation === 'flush-on-dispatch',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('error');
    expect(call!.context?.errorCode).toBe('EACCES');
    expect(call!.context?.errorKind).toBe('fs');
    expect(typeof call!.context?.errorName).toBe('string');
    expect(call!.context).not.toHaveProperty('documentPath');
    expect(call!.context).not.toHaveProperty('error');

    assertNoSensitiveFields(emitLogMock);
    const serialized = JSON.stringify(emitLogMock.mock.calls);
    expect(serialized).not.toContain('/Users/test/workspace');
    expect(serialized).not.toContain('secret.md');
    unmount();
  });

  // -------------------------------------------------------------------
  // T27b: AMD.6 — when no emitLog sink is wired, the privacy-safe console.error
  // fallback fires WITHOUT raw path or fs error message
  // -------------------------------------------------------------------
  it('T27b: console.error fallback (no emitLog sink) never leaks raw path or fs error message', async () => {
    const pathBearingError = Object.assign(
      new Error("EACCES: permission denied, open '/Users/test/workspace/secret.md'"),
      {
        code: 'EACCES',
        path: '/Users/test/workspace/secret.md',
      },
    );
    const writeFileMock = vi.fn().mockRejectedValue(pathBearingError);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result, unmount } = await mountIO({
        writeFileMock,
        omitEmitLog: true,
      });

      await act(async () => {
        await expect(
          result.current.flushAnnotationWriteNow('content after annotation clear'),
        ).rejects.toBe(pathBearingError);
      });

      // Must have surfaced the failure via console.error (observable, not silent)
      expect(consoleErrorSpy).toHaveBeenCalled();

      // Must not contain raw path or raw fs message in any console.error payload
      const consolePayloads = JSON.stringify(consoleErrorSpy.mock.calls);
      expect(consolePayloads).not.toContain('/Users/test/workspace');
      expect(consolePayloads).not.toContain('secret.md');
      expect(consolePayloads).not.toMatch(/EACCES: permission denied, open '/);
      // The errorClassifier shape (errorCode/errorKind/errorName) is fine to log
      expect(consolePayloads).toContain('EACCES');
      expect(consolePayloads).toContain('errorClassifier');
      unmount();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------
  // T29: sticky-flag retry can recover after the underlying write is fixed
  // -------------------------------------------------------------------
  it('T29: sticky annotation failure retries on flush and clears after success', async () => {
    const writeFileMock = vi.fn()
      .mockResolvedValueOnce({ result: 'failed', errorCode: 'ENOSPC' })
      .mockResolvedValue({
        result: 'ok',
        path: 'notes/test.md',
        updatedAt: 2,
        currentHash: 'hash:annotation recovered',
      });
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.setIsEditing(false);
    });
    act(() => {
      result.current.handleAnnotationContentChange('annotation that fails');
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    await flushUntil(() => writeFileMock.mock.calls.length >= 1);
    await flushUntil(() => getErrorToastCalls(showToastMock).length >= 1);

    expect(getErrorToastCalls(showToastMock)[0]?.[0]).toEqual(STORAGE_FULL_TOAST);

    act(() => {
      result.current.handleAnnotationContentChange('annotation recovered');
    });

    await act(async () => {
      await expect(result.current.flush()).resolves.toBeUndefined();
    });
    expect(writeFileMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await expect(result.current.flush()).resolves.toBeUndefined();
    });
    expect(writeFileMock).toHaveBeenCalledTimes(2);

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T30: auto-save tagged failure must not mark the edit as saved
  // -------------------------------------------------------------------
  it('T30: auto-save tagged failure preserves dirty state and surfaces storage-full copy', async () => {
    const writeFileMock = vi.fn().mockResolvedValue({ result: 'failed', errorCode: 'ENOSPC' });
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushUntil(() => emitLogMock.mock.calls.length >= 1, 30);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'auto-save',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('warn');
    expect(call!.context?.errorCode).toBe('ENOSPC');
    expect(call!.context?.errorKind).toBe('fs');

    expect(result.current.content).toBe('Base content');
    expect(result.current.editContent).toBe('Local edit');
    expect(result.current.isDirty).toBe(true);
    expect(result.current.statusText).toBe('Unsaved changes');
    expect(result.current.justSaved).toBe(false);

    expect(getErrorToastCalls(showToastMock)).toEqual([[STORAGE_FULL_TOAST]]);

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T30b: auto-save actionable failure toast dedupes per failure streak
  // -------------------------------------------------------------------
  it('T30b: auto-save actionable failure toast fires once per failure streak and resets after success', async () => {
    const writeFileMock = vi.fn()
      .mockResolvedValueOnce({ result: 'failed', errorCode: 'ENOSPC' })
      .mockResolvedValueOnce({ result: 'failed', errorCode: 'ENOSPC' })
      .mockResolvedValueOnce({
        result: 'ok',
        path: 'notes/test.md',
        updatedAt: 2,
        currentHash: 'hash:Local edit recovered',
      })
      .mockResolvedValueOnce({ result: 'failed', errorCode: 'ENOSPC' })
      .mockResolvedValue({
        result: 'ok',
        path: 'notes/test.md',
        updatedAt: 3,
        currentHash: 'hash:unmount fallback',
      });
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });
    const hasStreakDedupeBreadcrumb = () => emitLogMock.mock.calls.some((args: unknown[]) => {
      const payload = args[0] as LoggedPayload | undefined;
      return payload?.level === 'debug'
        && payload.context?.dedupe === 'actionable-failure-streak'
        && payload.context?.errorCode === 'ENOSPC';
    });
    const advanceAutoSaveUntil = async (predicate: () => boolean) => {
      await act(async () => {
        vi.advanceTimersByTime(2_000);
        await flushUntil(predicate, 30);
      });
    };

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });

    await advanceAutoSaveUntil(() =>
      writeFileMock.mock.calls.length >= 1
      && getErrorToastCalls(showToastMock).length >= 1
      && result.current.statusText === 'Unsaved changes',
    );
    expect(getErrorToastCalls(showToastMock)).toEqual([[STORAGE_FULL_TOAST]]);

    act(() => {
      result.current.handleEditorBodyChange('Local edit retry');
    });
    await advanceAutoSaveUntil(() =>
      writeFileMock.mock.calls.length >= 2
      && hasStreakDedupeBreadcrumb()
      && result.current.statusText === 'Unsaved changes',
    );
    expect(getErrorToastCalls(showToastMock)).toHaveLength(1);

    act(() => {
      result.current.handleEditorBodyChange('Local edit recovered');
    });
    await advanceAutoSaveUntil(() =>
      writeFileMock.mock.calls.length >= 3
      && result.current.isDirty === false,
    );
    expect(result.current.content).toBe('Local edit recovered');
    expect(getErrorToastCalls(showToastMock)).toHaveLength(1);

    act(() => {
      result.current.handleEditorBodyChange('Local edit after recovery');
    });
    await advanceAutoSaveUntil(() =>
      writeFileMock.mock.calls.length >= 4
      && getErrorToastCalls(showToastMock).length >= 2
      && result.current.statusText === 'Unsaved changes',
    );

    expect(getErrorToastCalls(showToastMock)).toEqual([[STORAGE_FULL_TOAST], [STORAGE_FULL_TOAST]]);
    expect(result.current.isDirty).toBe(true);
    expect(result.current.statusText).toBe('Unsaved changes');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T30c: auto-save non-actionable errno remains silent
  // -------------------------------------------------------------------
  it('T30c: auto-save non-actionable errno logs telemetry without toasting', async () => {
    const writeFileMock = vi.fn().mockResolvedValue({ result: 'failed', errorCode: 'EBUSY' });
    const { result, emitLogMock, showToastMock, unmount } = await mountIO({ writeFileMock });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushUntil(() => emitLogMock.mock.calls.length >= 1, 30);

    const call = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.write_failed' && ctx?.operation === 'auto-save',
    );
    expect(call).toBeDefined();
    expect(call!.level).toBe('warn');
    expect(call!.context?.errorCode).toBe('EBUSY');
    expect(call!.context?.errorKind).toBe('fs');

    expect(showToastMock).not.toHaveBeenCalled();
    expect(result.current.isDirty).toBe(true);
    expect(result.current.statusText).toBe('Unsaved changes');

    assertNoSensitiveFields(emitLogMock);
    unmount();
  });

  // -------------------------------------------------------------------
  // T31: keep-editor conflict resolution tagged failure keeps conflict UI
  // -------------------------------------------------------------------
  it("T31: resolveConflict('keep-editor') tagged failure keeps conflict state and shows permission copy", async () => {
    const writeFileMock = vi.fn()
      .mockResolvedValueOnce({ result: 'conflict', path: 'notes/test.md', currentHash: 'hash:cas-base' })
      .mockResolvedValueOnce({ result: 'failed', errorCode: 'EACCES' });
    const readFileMock = vi.fn()
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 })
      .mockResolvedValueOnce({ content: 'External v1', updatedAt: 2 });
    const { result, showToastMock, unmount } = await mountIO({
      readFileMock,
      writeFileMock,
    });

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushUntil(() => result.current.conflictState !== null, 30);
    expect(result.current.conflictState).not.toBeNull();

    await act(async () => {
      await result.current.resolveConflict('keep-editor');
    });

    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(result.current.conflictState).not.toBeNull();
    expect(getErrorToastCalls(showToastMock)).toEqual([[PERMISSION_DENIED_TOAST]]);

    unmount();
  });
});
