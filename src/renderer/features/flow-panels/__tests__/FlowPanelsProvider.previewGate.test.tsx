// @vitest-environment happy-dom
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowPanelsProvider, useFlowPanels } from '../FlowPanelsProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FlowPanelsContextSnapshot = ReturnType<typeof useFlowPanels>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

type MountedProvider = {
  getCtx: () => FlowPanelsContextSnapshot;
  unmount: () => void;
};

const mountedProviders: MountedProvider[] = [];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderWithProvider(): MountedProvider {
  let ctx: FlowPanelsContextSnapshot | null = null;

  function CtxCapture() {
    ctx = useFlowPanels();
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  act(() => {
    root.render(
      <FlowPanelsProvider>
        <CtxCapture />
      </FlowPanelsProvider>,
    );
  });

  const mounted: MountedProvider = {
    getCtx: () => {
      if (!ctx) {
        throw new Error('FlowPanels context was not captured');
      }
      return ctx;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };

  mountedProviders.push(mounted);
  return mounted;
}

function registerOpener(
  mounted: MountedProvider,
  opener: (path: string) => Promise<boolean>,
): void {
  act(() => {
    mounted.getCtx().setDocumentPreviewOpener(opener);
  });
}

async function openPreviewAndFlush(mounted: MountedProvider, path: string): Promise<void> {
  act(() => {
    mounted.getCtx().openDocumentPreview(path);
  });
  await flushMicrotasks();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1440,
  });
});

afterEach(() => {
  while (mountedProviders.length > 0) {
    mountedProviders.pop()?.unmount();
  }
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('FlowPanelsProvider document preview gate', () => {
  it('T1 commits path, open state, and generation after opener resolves true', async () => {
    const mounted = renderWithProvider();
    const opener = vi.fn(async () => true);

    registerOpener(mounted, opener);
    await openPreviewAndFlush(mounted, 'a.md');

    expect(opener).toHaveBeenCalledWith('a.md');
    expect(mounted.getCtx().documentPreviewPath).toBe('a.md');
    expect(mounted.getCtx().documentPreviewOpen).toBe(true);
    expect(mounted.getCtx().documentPreviewGeneration).toBe(1);
  });

  it('T2 keeps the prior preview document when opener resolves false', async () => {
    const mounted = renderWithProvider();
    let openerResult = true;
    const opener = vi.fn(async () => openerResult);

    registerOpener(mounted, opener);
    await openPreviewAndFlush(mounted, 'doc-a.md');
    const generationAfterDocA = mounted.getCtx().documentPreviewGeneration;

    openerResult = false;
    await openPreviewAndFlush(mounted, 'doc-b.md');

    expect(opener).toHaveBeenCalledTimes(2);
    expect(mounted.getCtx().documentPreviewPath).toBe('doc-a.md');
    expect(mounted.getCtx().documentPreviewOpen).toBe(true);
    expect(mounted.getCtx().documentPreviewGeneration).toBe(generationAfterDocA);
  });

  it('T3 gates the library-surface transfer path while still resetting library state', async () => {
    const mounted = renderWithProvider();
    const openerResults = [true, false];
    const opener = vi.fn(async () => openerResults.shift() ?? false);

    registerOpener(mounted, opener);

    act(() => {
      mounted.getCtx().setActiveSurface('library');
      mounted.getCtx().collapseSidebarForLibraryEditor('library-a.md');
      mounted.getCtx().setActiveSurface('home');
    });
    await flushMicrotasks();

    expect(opener).toHaveBeenCalledWith('library-a.md');
    expect(mounted.getCtx().documentPreviewPath).toBe('library-a.md');
    expect(mounted.getCtx().documentPreviewOpen).toBe(true);
    expect(mounted.getCtx().libraryEditorOpen).toBe(false);
    const generationAfterLibraryA = mounted.getCtx().documentPreviewGeneration;

    act(() => {
      mounted.getCtx().setActiveSurface('library');
      mounted.getCtx().collapseSidebarForLibraryEditor('library-b.md');
      mounted.getCtx().setActiveSurface('home');
    });
    await flushMicrotasks();

    expect(opener).toHaveBeenCalledWith('library-b.md');
    expect(mounted.getCtx().libraryEditorOpen).toBe(false);
    expect(mounted.getCtx().documentPreviewPath).toBe('library-a.md');
    expect(mounted.getCtx().documentPreviewOpen).toBe(true);
    expect(mounted.getCtx().documentPreviewGeneration).toBe(generationAfterLibraryA);
  });

  it('T5 commits synchronously when no opener is registered for mount-time fallback', () => {
    const mounted = renderWithProvider();

    act(() => {
      mounted.getCtx().openDocumentPreview('foo.md');
    });

    expect(mounted.getCtx().documentPreviewPath).toBe('foo.md');
    expect(mounted.getCtx().documentPreviewOpen).toBe(true);
    expect(mounted.getCtx().documentPreviewGeneration).toBe(1);
  });

  it('T6 uses latest-wins semantics for rapid document preview clicks', async () => {
    const mounted = renderWithProvider();
    const firstGate = deferred<boolean>();
    const secondGate = deferred<boolean>();
    const opener = vi.fn((path: string) => (path === 'a.md' ? firstGate.promise : secondGate.promise));

    registerOpener(mounted, opener);

    act(() => {
      mounted.getCtx().openDocumentPreview('a.md');
    });
    act(() => {
      mounted.getCtx().openDocumentPreview('b.md');
    });

    firstGate.resolve(true);
    await flushMicrotasks();

    expect(mounted.getCtx().documentPreviewPath).toBeNull();
    expect(mounted.getCtx().documentPreviewOpen).toBe(false);

    secondGate.resolve(true);
    await flushMicrotasks();

    expect(opener).toHaveBeenCalledTimes(2);
    expect(mounted.getCtx().documentPreviewPath).toBe('b.md');
    expect(mounted.getCtx().documentPreviewOpen).toBe(true);
    expect(mounted.getCtx().documentPreviewGeneration).toBe(1);
  });

  it('T7 drops an in-flight gate when closeDocumentPreview runs before resolution', async () => {
    const mounted = renderWithProvider();
    const secondGate = deferred<boolean>();
    const opener = vi.fn((path: string) => (path === 'doc-b.md' ? secondGate.promise : Promise.resolve(true)));

    registerOpener(mounted, opener);
    await openPreviewAndFlush(mounted, 'doc-a.md');

    act(() => {
      mounted.getCtx().openDocumentPreview('doc-b.md');
      mounted.getCtx().closeDocumentPreview();
    });

    secondGate.resolve(true);
    await flushMicrotasks();

    expect(mounted.getCtx().documentPreviewOpen).toBe(false);
    expect(mounted.getCtx().documentPreviewPath).toBeNull();
    expect(mounted.getCtx().documentPreviewGeneration).toBe(1);
  });

  it('T8 drops an in-flight gate when the document preview opener is deregistered', async () => {
    const mounted = renderWithProvider();
    const gate = deferred<boolean>();
    const opener = vi.fn(() => gate.promise);

    registerOpener(mounted, opener);

    act(() => {
      mounted.getCtx().openDocumentPreview('a.md');
    });
    act(() => {
      mounted.getCtx().setDocumentPreviewOpener(null);
    });

    gate.resolve(true);
    await flushMicrotasks();

    expect(mounted.getCtx().documentPreviewPath).toBeNull();
    expect(mounted.getCtx().documentPreviewOpen).toBe(false);
    expect(mounted.getCtx().documentPreviewGeneration).toBe(0);
  });

  it('T-AMD-2a keeps approvals drawer takeover when an earlier gate resolves true', async () => {
    const mounted = renderWithProvider();
    const gate = deferred<boolean>();
    const opener = vi.fn(() => gate.promise);

    registerOpener(mounted, opener);

    act(() => {
      mounted.getCtx().openDocumentPreview('a.md');
      mounted.getCtx().openApprovalsDrawer();
    });

    gate.resolve(true);
    await flushMicrotasks();

    expect(mounted.getCtx().approvalsDrawerOpen).toBe(true);
    expect(mounted.getCtx().documentPreviewOpen).toBe(false);
    expect(mounted.getCtx().documentPreviewPath).toBeNull();
  });

  it('T-AMD-2b keeps insights drawer takeover when an earlier gate resolves true', async () => {
    const mounted = renderWithProvider();
    const gate = deferred<boolean>();
    const opener = vi.fn(() => gate.promise);

    registerOpener(mounted, opener);

    act(() => {
      mounted.getCtx().openDocumentPreview('a.md');
      mounted.getCtx().openInsightsDrawer('turn-1');
    });

    gate.resolve(true);
    await flushMicrotasks();

    expect(mounted.getCtx().insightsDrawerOpen).toBe(true);
    expect(mounted.getCtx().selectedInsightsTurnId).toBe('turn-1');
    expect(mounted.getCtx().documentPreviewOpen).toBe(false);
    expect(mounted.getCtx().documentPreviewPath).toBeNull();
  });

  it('T-AMD-3 leaves library and document-preview sidebar refs unshuffled on rejected library transfer', async () => {
    const mounted = renderWithProvider();
    const opener = vi.fn(async () => false);

    registerOpener(mounted, opener);

    act(() => {
      mounted.getCtx().setFlowHistoryOpen(true);
    });
    expect(mounted.getCtx().flowHistoryOpen).toBe(true);

    act(() => {
      mounted.getCtx().setActiveSurface('library');
      mounted.getCtx().collapseSidebarForLibraryEditor('library-reject.md');
    });
    expect(mounted.getCtx().flowHistoryOpen).toBe(false);
    expect(mounted.getCtx().libraryEditorOpen).toBe(true);

    act(() => {
      mounted.getCtx().setActiveSurface('home');
    });
    await flushMicrotasks();

    expect(opener).toHaveBeenCalledWith('library-reject.md');
    expect(mounted.getCtx().documentPreviewPath).toBeNull();
    expect(mounted.getCtx().documentPreviewOpen).toBe(false);
    expect(mounted.getCtx().libraryEditorOpen).toBe(false);
    expect(mounted.getCtx().flowHistoryOpen).toBe(false);

    act(() => {
      mounted.getCtx().closeDocumentPreview();
    });
    expect(mounted.getCtx().flowHistoryOpen).toBe(false);

    act(() => {
      mounted.getCtx().restoreSidebarFromLibraryEditor();
    });
    expect(mounted.getCtx().flowHistoryOpen).toBe(true);
  });

  it('T-AMD-5 logs opener rejections and preserves the prior preview document', async () => {
    const mounted = renderWithProvider();
    const thrown = new Error('preview opener failed');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const opener = vi.fn(async (path: string) => {
      if (path === 'doc-a.md') {
        return true;
      }
      throw thrown;
    });

    registerOpener(mounted, opener);
    await openPreviewAndFlush(mounted, 'doc-a.md');
    const generationAfterDocA = mounted.getCtx().documentPreviewGeneration;

    await openPreviewAndFlush(mounted, 'doc-b.md');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[FlowPanels] preview opener threw', thrown);
    expect(mounted.getCtx().documentPreviewPath).toBe('doc-a.md');
    expect(mounted.getCtx().documentPreviewOpen).toBe(true);
    expect(mounted.getCtx().documentPreviewGeneration).toBe(generationAfterDocA);
    expect(mounted.getCtx().insightsDrawerOpen).toBe(false);
    expect(mounted.getCtx().approvalsDrawerOpen).toBe(false);
  });
});
