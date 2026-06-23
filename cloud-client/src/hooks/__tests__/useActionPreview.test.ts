// @vitest-environment happy-dom
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ActionPreviewInput } from '@rebel/shared';
import { useActionPreview } from '../useActionPreview';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface RenderHookResult<TProps, TResult> {
  result: { current: TResult };
  rerender: (nextProps: TProps) => void;
  unmount: () => void;
}

function renderHook<TProps, TResult>(
  callback: (props: TProps) => TResult,
  options: { initialProps: TProps },
): RenderHookResult<TProps, TResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const result: { current: TResult } = { current: undefined as TResult };
  let currentProps = options.initialProps;

  // Read currentProps from the closure rather than via React props, so the
  // harness is a zero-prop component. This avoids React.createElement's generic
  // prop-type overload constraints while preserving rerender semantics (each
  // render reads the latest currentProps).
  function TestHarness(): React.ReactElement | null {
    result.current = callback(currentProps);
    return null;
  }

  act(() => {
    root.render(React.createElement(TestHarness));
  });

  return {
    result,
    rerender(nextProps: TProps) {
      currentProps = nextProps;
      act(() => {
        root.render(React.createElement(TestHarness));
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function waitFor(assertion: () => void, timeoutMs: number = 4000): Promise<void> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('waitFor timed out');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSlackStagedToolInput(
  overrides: Partial<Extract<ActionPreviewInput, { kind: 'staged-tool' }>> = {},
): Extract<ActionPreviewInput, { kind: 'staged-tool' }> {
  return {
    kind: 'staged-tool',
    toolId: 'chat_postMessage',
    packageId: 'slack',
    displayName: 'Send Slack message',
    args: {
      channel: 'C123456',
      text: 'hello team',
    },
    ...overrides,
  };
}

function makeMemoryInput(
  overrides: Partial<Extract<ActionPreviewInput, { kind: 'memory' }>> = {},
): Extract<ActionPreviewInput, { kind: 'memory' }> {
  return {
    kind: 'memory',
    filePath: 'memory/general/notes.md',
    spaceName: 'General',
    spacePath: 'memory/general/notes.md',
    summary: 'Update notes',
    contentPreview: 'updated notes',
    content: 'updated notes',
    sharing: 'private',
    isNewFile: false,
    ...overrides,
  };
}

function makeStagedFileInput(
  overrides: Partial<Extract<ActionPreviewInput, { kind: 'staged-file' }>> = {},
): Extract<ActionPreviewInput, { kind: 'staged-file' }> {
  return {
    kind: 'staged-file',
    stagedFileId: 'staged-1',
    filePath: 'memory/general/staged.md',
    spaceName: 'General',
    spacePath: 'memory/general/staged.md',
    summary: 'Staged update',
    contentPreview: 'staged content',
    sharing: 'private',
    baseHash: 'existing-hash',
    isNewFile: false,
    ...overrides,
  };
}

describe('useActionPreview', () => {
  it('returns a synchronous model for Slack staged-tool input with neutral content', () => {
    const { result, unmount } = renderHook(
      () => useActionPreview(makeSlackStagedToolInput()),
      { initialProps: undefined },
    );

    expect(result.current.model.effectKind).toBe('message');
    expect(result.current.content).toEqual({
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

    unmount();
  });

  it('recovers memory content from host callback when inline content is missing', async () => {
    const readMemoryApprovalContent = vi.fn().mockResolvedValue('Recovered persisted content');

    const { result, unmount } = renderHook(
      () => useActionPreview(
        makeMemoryInput({
          toolUseId: 'mem-1',
          content: '',
          contentPreview: '',
        }),
        {
          readStagedContent: vi.fn(),
          readWorkspaceFile: vi.fn().mockResolvedValue({ content: '' }),
          readMemoryApprovalContent,
        },
      ),
      { initialProps: undefined },
    );

    await waitFor(() => expect(result.current.content.status).toBe('revealed'));
    expect(result.current.content.staged).toBe('Recovered persisted content');
    expect(readMemoryApprovalContent).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'mem-1',
        filePath: 'memory/general/notes.md',
      }),
      expect.any(AbortSignal),
    );
    unmount();
  });

  it('marks memory recovery lookup misses as explicit errors', async () => {
    const readMemoryApprovalContent = vi.fn().mockResolvedValue(null);

    const { result, unmount } = renderHook(
      () => useActionPreview(
        makeMemoryInput({
          toolUseId: 'mem-missing',
          content: '',
          contentPreview: '',
        }),
        {
          readStagedContent: vi.fn(),
          readWorkspaceFile: vi.fn().mockResolvedValue({ content: '' }),
          readMemoryApprovalContent,
        },
      ),
      { initialProps: undefined },
    );

    await waitFor(() => expect(result.current.content.status).toBe('error'));
    expect(result.current.content.error?.detail).toContain('Could not recover memory approval content');
    expect(result.current.content.staged).toBeNull();
    unmount();
  });

  it('keeps hook order stable across effect kinds and delegates only when file-backed', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('same body');
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'same body' });

    const { result, rerender, unmount } = renderHook(
      ({ input }: { input: ActionPreviewInput }) =>
        useActionPreview(input, { readStagedContent, readWorkspaceFile }),
      { initialProps: { input: makeSlackStagedToolInput() as ActionPreviewInput } },
    );

    expect(result.current.model.effectKind).toBe('message');
    expect(readStagedContent).not.toHaveBeenCalled();
    expect(readWorkspaceFile).not.toHaveBeenCalled();

    rerender({ input: makeMemoryInput() });
    await waitFor(() => expect(result.current.content.loading).toBe(false));
    expect(result.current.model.effectKind).toBe('document');
    expect(readWorkspaceFile).toHaveBeenCalled();

    // If the hook call was conditional, this rerender would throw hook-order errors.
    rerender({ input: makeSlackStagedToolInput({ args: { channel: 'C42', text: 'rerender' } }) });
    expect(result.current.model.effectKind).toBe('message');
    unmount();
  });

  it('delegates staged-file content resolution through useApprovalContent transports', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('staged body');
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'staged body' });

    const { result, unmount } = renderHook(
      () => useActionPreview(makeStagedFileInput(), { readStagedContent, readWorkspaceFile }),
      { initialProps: undefined },
    );

    await waitFor(() => expect(result.current.content.loading).toBe(false));

    expect(result.current.model.effectKind).toBe('document');
    expect(result.current.content.staged).toBe('staged body');
    expect(result.current.content.original).toBe('staged body');
    expect(result.current.content.conflict).toBe(false);
    expect(result.current.content.error).toBeNull();
    expect(readStagedContent).toHaveBeenCalledWith(
      'staged-1',
      expect.any(AbortSignal),
    );
    expect(readWorkspaceFile).toHaveBeenCalledWith(
      'memory/general/staged.md',
      expect.any(AbortSignal),
    );
    unmount();
  });

  it('returns neutral content instead of throwing when stagedFileId is missing', async () => {
    const readStagedContent = vi.fn();
    const readWorkspaceFile = vi.fn();

    const { result, unmount } = renderHook(
      () =>
        useActionPreview(
          makeStagedFileInput({
            stagedFileId: undefined,
            baseHash: 'existing-hash',
            isNewFile: false,
          }),
          { readStagedContent, readWorkspaceFile },
        ),
      { initialProps: undefined },
    );

    expect(result.current.model.effectKind).toBe('document');
    expect(result.current.content.loading).toBe(false);
    expect(result.current.content.error).toBeNull();
    expect(readStagedContent).not.toHaveBeenCalled();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    unmount();
  });

  it('passes loading and error states through from useApprovalContent', async () => {
    const stagedDeferred = deferred<string>();
    const readStagedContent = vi.fn().mockReturnValue(stagedDeferred.promise);
    const readWorkspaceFile = vi.fn();

    const { result, unmount } = renderHook(
      () => useActionPreview(makeStagedFileInput(), { readStagedContent, readWorkspaceFile }),
      { initialProps: undefined },
    );

    expect(result.current.content.loading).toBe(true);

    await act(async () => {
      stagedDeferred.reject(new Error('staged fetch failed'));
      try {
        await stagedDeferred.promise;
      } catch {
        // expected rejection
      }
    });

    await waitFor(() => expect(result.current.content.loading).toBe(false));
    expect(result.current.content.error?.kind).toBe('network');
    expect(result.current.content.error?.detail).toContain('staged fetch failed');
    unmount();
  });

  it('passes conflict through and reclassifies conflicted net-new source capture as document', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('captured body');
    const readWorkspaceFile = vi.fn().mockResolvedValue({ content: 'older body' });

    const sourceCaptureInput = makeStagedFileInput({
      kind: 'staged-file',
      filePath: 'memory/sources/260529_1430_meeting_q3-review.md',
      spaceName: 'Chief of Staff',
      spacePath: 'memory/sources/260529_1430_meeting_q3-review.md',
      summary: 'Captured source',
      contentPreview: 'captured body',
      sharing: 'restricted',
      isNewFile: true,
      // Keeps the source "net-new" for classifier, while still forcing a real
      // original fetch so conflict can be observed from useApprovalContent.
      baseHash: 'existing-hash',
    });

    const { result, unmount } = renderHook(
      () => useActionPreview(sourceCaptureInput, { readStagedContent, readWorkspaceFile }),
      { initialProps: undefined },
    );

    expect(result.current.model.effectKind).toBe('data-capture');

    await waitFor(() => expect(result.current.content.conflict).toBe(true));
    expect(result.current.model.effectKind).toBe('document');
    unmount();
  });

  it('honors staged-file hasConflict when deriving the model', async () => {
    const readStagedContent = vi.fn().mockResolvedValue('captured body');
    const readWorkspaceFile = vi.fn();

    const { result, unmount } = renderHook(
      () =>
        useActionPreview(
          makeStagedFileInput({
            filePath: 'memory/sources/260529_1430_meeting_q3-review.md',
            spaceName: 'Chief of Staff',
            spacePath: 'memory/sources/260529_1430_meeting_q3-review.md',
            baseHash: 'new-file',
            isNewFile: true,
            hasConflict: true,
          }),
          { readStagedContent, readWorkspaceFile },
        ),
      { initialProps: undefined },
    );

    await waitFor(() => expect(result.current.content.loading).toBe(false));
    expect(result.current.model.effectKind).toBe('document');
    unmount();
  });
});
