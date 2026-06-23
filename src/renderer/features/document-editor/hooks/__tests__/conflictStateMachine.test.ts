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

 
vi.mock('@renderer/utils/sha256Hex', () => ({
  sha256HexUtf8: vi.fn(async (text: string) => `hash:${text}`),
}));

type LibraryChangeWriterKind = 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';

type LibraryChangedPayload = {
  timestamp: number;
  affectsTree: boolean;
  writerKind?: LibraryChangeWriterKind;
  changedPath?: string;
};

type LibraryChangedListener = (payload: LibraryChangedPayload) => void;

async function flushUntil(predicate: () => boolean, maxIterations = 12): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) {
      return;
    }
    await flushAsync();
  }
}

async function mountDocumentFileIO(
  readFileMock: ReturnType<typeof vi.fn>,
  writeFileMock: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
    result: 'ok',
    path: 'notes/test.md',
    updatedAt: Date.now(),
    currentHash: 'hash:write',
  }),
  emitLogMock: ReturnType<typeof vi.fn> = vi.fn(),
) {
  let libraryChangedListener: LibraryChangedListener | null = null;

  createMockWindowApi('settingsApi', {
    get: vi.fn().mockResolvedValue({ coreDirectory: '/workspace' }),
  });
  createMockWindowApi('libraryApi', {
    readFile: readFileMock,
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
  });

  const hook = renderHook(() =>
    useDocumentFileIO({
      documentPath: 'notes/test.md',
      emitLog: emitLogMock as unknown as EmitLogFn,
    }),
  );
  for (let i = 0; i < 6; i++) {
    await flushAsync();
    if (hook.result.current.isEditing && hook.result.current.content !== null) {
      break;
    }
  }

  return {
    ...hook,
    writeFileMock,
    emitLogMock,
    emitLibraryChanged: (payload?: Partial<LibraryChangedPayload>) => {
      if (!libraryChangedListener) {
        throw new Error('onLibraryChanged listener is not registered');
      }
      libraryChangedListener({
        timestamp: payload?.timestamp ?? Date.now(),
        affectsTree: payload?.affectsTree ?? false,
        writerKind: payload?.writerKind,
        changedPath: payload?.changedPath,
      });
    },
  };
}

describe('useDocumentFileIO conflict state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFakeTimers();
  });

  afterEach(() => {
    cleanupFakeTimers();
  });

  it('isConflictBlocking prevents auto-save when conflict is active', async () => {
    const readFileMock = vi.fn()
      .mockResolvedValue({ content: 'External content v1', updatedAt: 2 })
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 });

    const { result, emitLibraryChanged, writeFileMock, unmount } = await mountDocumentFileIO(readFileMock);
    expect(readFileMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      emitLibraryChanged();
    });
    await flushUntil(() => result.current.conflictState !== null);
    expect(readFileMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    expect(result.current.conflictState?.diskContent).toBe('External content v1');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(writeFileMock).not.toHaveBeenCalled();
    unmount();
  });

  it('skips reload for editor self-write echoes on the current document path', async () => {
    const readFileMock = vi.fn().mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 });
    const { emitLibraryChanged, unmount } = await mountDocumentFileIO(readFileMock);

    expect(readFileMock).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ writerKind: 'editor', changedPath: 'notes/test.md' });
    });
    await flushAsync();

    expect(readFileMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("resolveConflict('keep-disk') updates editor buffer and clears conflict", async () => {
    const readFileMock = vi.fn()
      .mockResolvedValue({ content: 'External content v1', updatedAt: 2 })
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 });

    const { result, emitLibraryChanged, unmount } = await mountDocumentFileIO(readFileMock);

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      emitLibraryChanged();
    });
    await flushUntil(() => result.current.conflictState !== null);

    expect(result.current.conflictState).not.toBeNull();

    await act(async () => {
      await result.current.resolveConflict('keep-disk');
    });
    await flushAsync();

    expect(result.current.editContent).toBe('External content v1');
    expect(result.current.content).toBe('External content v1');
    expect(result.current.conflictState).toBeNull();
    unmount();
  });

  it('captures writerKind from library:changed payload in conflict state', async () => {
    const readFileMock = vi.fn()
      .mockResolvedValue({ content: 'External content v1', updatedAt: 2 })
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 });

    const { result, emitLibraryChanged, unmount } = await mountDocumentFileIO(readFileMock);

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      emitLibraryChanged({ writerKind: 'agent', changedPath: 'notes/test.md' });
    });
    await flushUntil(() => result.current.conflictState !== null);

    expect(result.current.conflictState?.writerKind).toBe('agent');
    unmount();
  });

  it('updates active conflict when a newer disk version arrives', async () => {
    const readFileMock = vi.fn()
      .mockResolvedValue({ content: 'External content v2', updatedAt: 3 })
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 })
      .mockResolvedValueOnce({ content: 'External content v1', updatedAt: 2 })
      .mockResolvedValueOnce({ content: 'External content v2', updatedAt: 3 });

    const { result, emitLibraryChanged, unmount } = await mountDocumentFileIO(readFileMock);

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      emitLibraryChanged();
    });
    await flushUntil(() => result.current.conflictState !== null);

    const firstConflictDetectedAt = result.current.conflictState?.detectedAt;
    expect(result.current.conflictState?.diskContent).toBe('External content v1');
    expect(firstConflictDetectedAt).toBeDefined();

    act(() => {
      emitLibraryChanged();
    });
    await flushUntil(() => result.current.conflictState?.diskContent === 'External content v2');

    expect(result.current.conflictState?.diskContent).toBe('External content v2');
    expect(result.current.conflictState?.detectedAt).toBe(firstConflictDetectedAt);
    unmount();
  });

  // ---------------------------------------------------------------------
  // Stage 5 telemetry — structured emitLog events with stable event codes
  // for Sentry correlation. Privacy: no path / basename / content / hashes.
  // See docs/plans/finished/260427_document_write_conflict_resolution.md (Stage 5).
  // ---------------------------------------------------------------------

  type LoggedPayload = {
    level?: string;
    context?: Record<string, unknown>;
  };

  // Helper to find the first emitLog call whose context.event matches.
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

  // Helper to assert no privacy-sensitive fields leaked into a context bag.
  const assertNoSensitiveFields = (ctx: Record<string, unknown> | undefined) => {
    expect(ctx).toBeDefined();
    const stringified = JSON.stringify(ctx ?? {});
    expect(stringified).not.toContain('notes/test.md');
    expect(stringified).not.toContain('test.md');
    expect(stringified).not.toContain('Local edit');
    expect(stringified).not.toContain('External content');
    expect(stringified).not.toContain('Base content');
    expect(stringified).not.toContain('hash:'); // mocked hash prefix
  };

  it('emits document_editor.conflict.detected telemetry on library-changed reload conflict', async () => {
    const readFileMock = vi.fn()
      .mockResolvedValue({ content: 'External content v1', updatedAt: 2 })
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 });

    const { result, emitLibraryChanged, emitLogMock, unmount } = await mountDocumentFileIO(readFileMock);

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      emitLibraryChanged({ writerKind: 'agent' });
    });
    await flushUntil(() => result.current.conflictState !== null);

    const detectedCall = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.conflict.detected',
    );
    expect(detectedCall).toBeDefined();
    expect(detectedCall!.level).toBe('warn');
    expect(detectedCall!.context?.trigger).toBe('library-changed');
    expect(detectedCall!.context?.writerKind).toBe('agent');
    expect(detectedCall!.context?.fileExtension).toBe('md');
    expect(detectedCall!.context?.documentScope).toBe('workspace-relative');
    expect(typeof detectedCall!.context?.bufferHashEqualsDiskHash).toBe('boolean');
    expect(typeof detectedCall!.context?.hasCasBaseline).toBe('boolean');
    assertNoSensitiveFields(detectedCall!.context);
    unmount();
  });

  it('emits document_editor.conflict.resolved telemetry only after state clears', async () => {
    const readFileMock = vi.fn()
      .mockResolvedValue({ content: 'External content v1', updatedAt: 2 })
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 });

    const { result, emitLibraryChanged, emitLogMock, unmount } = await mountDocumentFileIO(readFileMock);

    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      emitLibraryChanged({ writerKind: 'agent' });
    });
    await flushUntil(() => result.current.conflictState !== null);

    await act(async () => {
      await result.current.resolveConflict('keep-disk');
    });
    await flushAsync();

    expect(result.current.conflictState).toBeNull();

    const resolvedCall = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.conflict.resolved',
    );
    expect(resolvedCall).toBeDefined();
    expect(resolvedCall!.level).toBe('info');
    expect(resolvedCall!.context?.resolution).toBe('keep-disk');
    expect(resolvedCall!.context?.writerKind).toBe('agent');
    expect(typeof resolvedCall!.context?.conflictAgeMs).toBe('number');
    assertNoSensitiveFields(resolvedCall!.context);
    unmount();
  });

  it('materializes auto-save CAS conflict directly without waiting for library:changed', async () => {
    const writeFileMock = vi.fn()
      .mockResolvedValueOnce({
        result: 'conflict',
        path: 'notes/test.md',
        currentHash: 'hash:disk-divergent',
      });
    const readFileMock = vi.fn()
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 })
      .mockResolvedValueOnce({ content: 'External CAS divergence', updatedAt: 2 });

    const { result, emitLogMock, unmount } = await mountDocumentFileIO(readFileMock, writeFileMock);

    act(() => {
      result.current.handleEditorBodyChange('Local edit triggering auto-save');
    });

    // Drive the auto-save debounce timeout (1400ms) and the inner async flow.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushUntil(() => result.current.conflictState !== null);

    expect(writeFileMock).toHaveBeenCalled();
    expect(result.current.conflictState).not.toBeNull();
    expect(result.current.conflictState?.diskContent).toBe('External CAS divergence');
    expect(result.current.conflictState?.writerKind).toBeUndefined();

    const detectedCall = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.conflict.detected'
        && ctx?.trigger === 'auto-save-cas',
    );
    expect(detectedCall).toBeDefined();
    expect(detectedCall!.level).toBe('warn');
    expect(detectedCall!.context?.writerKind).toBe('unknown');
    assertNoSensitiveFields(detectedCall!.context);
    unmount();
  });

  it("emits document_editor.conflict.write_rejected on third-writer race during resolveConflict('keep-editor')", async () => {
    // First write (auto-save during base load) succeeds, then the
    // resolveConflict write returns result:'conflict' (third-writer race).
    const writeFileMock = vi.fn()
      .mockResolvedValueOnce({ result: 'conflict', path: 'notes/test.md', currentHash: 'hash:cas-base' })
      .mockResolvedValueOnce({ result: 'conflict', path: 'notes/test.md', currentHash: 'hash:cas-shifted' });

    const readFileMock = vi.fn()
      .mockResolvedValueOnce({ content: 'Base content', updatedAt: 1 })
      .mockResolvedValueOnce({ content: 'External v1', updatedAt: 2 })
      .mockResolvedValueOnce({ content: 'External v2 after race', updatedAt: 3 });

    const { result, emitLogMock, unmount } = await mountDocumentFileIO(readFileMock, writeFileMock);

    // Trigger auto-save → CAS conflict materialized.
    act(() => {
      result.current.handleEditorBodyChange('Local edit');
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushUntil(() => result.current.conflictState !== null);
    expect(result.current.conflictState?.diskContent).toBe('External v1');

    // User picks keep-editor, but the third-writer race triggers conflict again.
    await act(async () => {
      await result.current.resolveConflict('keep-editor');
    });
    await flushAsync();

    expect(result.current.conflictState).not.toBeNull();
    expect(result.current.conflictState?.diskContent).toBe('External v2 after race');

    const rejectedCall = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.conflict.write_rejected',
    );
    expect(rejectedCall).toBeDefined();
    expect(rejectedCall!.level).toBe('warn');
    expect(rejectedCall!.context?.trigger).toBe('resolve-keep-editor');
    expect(typeof rejectedCall!.context?.conflictAgeMs).toBe('number');
    assertNoSensitiveFields(rejectedCall!.context);

    // No 'resolved' event should fire because state did not clear.
    const resolvedCall = findEmitLogCall(
      emitLogMock,
      (ctx) => ctx?.event === 'document_editor.conflict.resolved',
    );
    expect(resolvedCall).toBeUndefined();
    unmount();
  });
});
