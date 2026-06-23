// @vitest-environment happy-dom
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import React, { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { createMockWindowApi } from '@renderer/test-utils';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

// DI-C (2026-04-27): Partial-mock the renderer sentry module so we can spy
// on `captureRendererMessage` without affecting other exports. Hoisted by
// vitest before any module loads (including the instrumented variant of
// MessageMarkdown), so both the static and dynamic imports of
// `@renderer/src/sentry` see the same mocked instance. vi.mock is the
// only safe way to intercept a third-party SDK call here — DI would
// require routing every Sentry call through a context, which is overkill
// for a single observability hook.
 
vi.mock('@renderer/src/sentry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@renderer/src/sentry')>();
  return {
    ...original,
    captureRendererMessage: vi.fn(),
  };
});

import { isEditableWorkspaceFile, EDITABLE_EXTENSIONS } from '../../constants';
import { parseCollapseBlock, isCollapseLanguage, convertHtmlDetailsToCollapse, encodeSpacesInMarkdownLinks } from '@rebel/shared';
import { formatLibraryUrl } from '@shared/navigation/urlParser';
import {
  ImageError,
  MessageMarkdown,
  canonicalizeImagePath,
  invalidateImageCacheEntry,
  __resetImageLibraryChangedSubscriptionForTests,
  type ImagePipelineErrorCode,
} from '../MessageMarkdown';
import { captureRendererMessage } from '@renderer/src/sentry';
import { __resetSpacesCacheForTests } from '../../hooks/useSpacesData';

const captureRendererMessageMock = vi.mocked(captureRendererMessage);

/**
 * Tests for MessageMarkdown link handling logic
 * 
 * These tests verify the expected behavior for file link clicking:
 * 1. Editable files (md, txt, etc.) should open in internal editor via onOpenFile
 * 2. Image files should open in internal image viewer
 * 3. Non-editable files should reveal in Finder
 * 4. External URLs should open in browser
 * 
 * The core issue being fixed: absolute paths to editable files were 
 * incorrectly opening in Finder instead of the internal editor.
 */

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

const isImagePath = (filePath: string): boolean => {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.includes(ext);
};

const isAbsolutePath = (filePath: string): boolean => {
  return /^([A-Za-z]:[\\/]|\/)/.test(filePath);
};

function renderMessageMarkdown(
  content: string,
  props: Partial<ComponentProps<typeof MessageMarkdown>> = {},
) {
  const onOpenFile = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <MessageMarkdown
        content={content}
        onOpenFile={onOpenFile}
        {...props}
      />,
    );
  });

  return {
    container,
    onOpenFile,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function renderImageError(code: ImagePipelineErrorCode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<ImageError code={code} />);
  });

  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function findLink(container: HTMLElement, text: string): HTMLAnchorElement {
  const link = Array.from(container.querySelectorAll('a')).find((candidate) => (
    candidate.textContent === text ||
    candidate.querySelector('.markdown-link__filename')?.textContent === text
  ));
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Could not find link with text "${text}"`);
  }
  return link;
}

function clickLink(link: HTMLAnchorElement): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  return link.dispatchEvent(event);
}

function clickLinkEvent(link: HTMLAnchorElement): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  return event;
}

function contextMenuLink(link: HTMLAnchorElement): boolean {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 24,
    clientY: 32,
  });
  return link.dispatchEvent(event);
}

const instrumentedMessageMarkdownPath = join(
  process.cwd(),
  'src/renderer/components/MessageMarkdown.__instrumented__.tsx',
);
const pendingLightweightMessageMarkdownPath = join(
  process.cwd(),
  'src/renderer/components/MessageMarkdown.__pending_lightweight__.tsx',
);
const instrumentedMessageMarkdownSpecifier = '../MessageMarkdown.__instrumented__.tsx';
const pendingLightweightMessageMarkdownSpecifier = '../MessageMarkdown.__pending_lightweight__.tsx';
const instrumentedHookExportMarker = 'function normalizePath(';
const instrumentedConvertFilePathsToLinksExportMarker =
  'const convertFilePathsToLinks = (content: string, linkCtx: ConvertLinkContext | null): string => {';
const instrumentedCacheExportsMarker =
  'const getCachedDimensions = (filePath: string): { width: number; height: number } | null => {';
const pendingLightweightMarker = 'const isPending = trimmed !== deferredContent;';

type SpacesSnapshot = {
  spaces: readonly unknown[];
  spacesReady: boolean;
  spacesError: boolean;
  spacesErrorMessage?: string;
};

type InstrumentedMessageMarkdownModule = {
  MessageMarkdown: typeof MessageMarkdown;
  __TEST_ONLY_useSpacesReady: (coreDirectory?: string) => SpacesSnapshot;
  __TEST_ONLY_convertFilePathsToLinks: (content: string, linkCtx: unknown) => string;
  __TEST_ONLY_getCachedImage: (filePath: string) => {
    dimensions: { width: number; height: number };
    dataUrl: string;
    mtimeMs?: number;
    size?: number | null;
  } | null;
  __TEST_ONLY_inFlightImageRequests: Map<
    string,
    Promise<{ dataUrl: string; dimensions: { width: number; height: number }; mtimeMs?: number; size?: number | null; stale?: boolean }>
  >;
  __TEST_ONLY_IMAGE_DECODE_TIMEOUT_MS: number;
  __TEST_ONLY_IMAGE_IPC_TIMEOUT_MS: number;
  __TEST_ONLY_mountedImageSubscribers: Map<string, Set<() => void>>;
  __TEST_ONLY_cacheGenerations: Map<string, number>;
  __TEST_ONLY_saveToCache: (
    filePath: string,
    dimensions: { width: number; height: number },
    dataUrl: string,
    mtimeMs: number,
    size: number | null,
  ) => void;
  __TEST_ONLY_getImageDataUrlCacheStats: () => {
    entries: number;
    estimatedKB: number;
    totalBytes: number;
    maxBytes: number;
    evictionCount: number;
  };
  invalidateImageCacheEntry: (filePath: string) => void;
  canonicalizeImagePath: (filePath: string) => string;
  __resetImageLibraryChangedSubscriptionForTests: () => void;
};

let instrumentedMessageMarkdownModule: InstrumentedMessageMarkdownModule | null = null;
let pendingLightweightMessageMarkdownModule: Pick<InstrumentedMessageMarkdownModule, 'MessageMarkdown'> | null = null;

async function ensureInstrumentedMessageMarkdownModule(): Promise<InstrumentedMessageMarkdownModule> {
  if (instrumentedMessageMarkdownModule) {
    return instrumentedMessageMarkdownModule;
  }

  const rawMessageMarkdownModule = await import('../MessageMarkdown.tsx?raw');
  const rawMessageMarkdownSource = rawMessageMarkdownModule.default;
  if (
    !rawMessageMarkdownSource.includes(instrumentedHookExportMarker) ||
    !rawMessageMarkdownSource.includes(instrumentedConvertFilePathsToLinksExportMarker) ||
    !rawMessageMarkdownSource.includes(instrumentedCacheExportsMarker)
  ) {
    throw new Error('Could not instrument MessageMarkdown.tsx for test-only helper access');
  }

  const instrumentedMessageMarkdownSource = rawMessageMarkdownSource
    .replace(
      instrumentedHookExportMarker,
      'export { useSpacesReady as __TEST_ONLY_useSpacesReady };\n\nfunction normalizePath(',
    )
    .replace(
      instrumentedConvertFilePathsToLinksExportMarker,
      'export { convertFilePathsToLinks as __TEST_ONLY_convertFilePathsToLinks };\n\nconst convertFilePathsToLinks = (content: string, linkCtx: ConvertLinkContext | null): string => {',
    )
    .replace(
      instrumentedCacheExportsMarker,
      'export {\n  getCachedImage as __TEST_ONLY_getCachedImage,\n  inFlightImageRequests as __TEST_ONLY_inFlightImageRequests,\n  IMAGE_DECODE_TIMEOUT_MS as __TEST_ONLY_IMAGE_DECODE_TIMEOUT_MS,\n  IMAGE_IPC_TIMEOUT_MS as __TEST_ONLY_IMAGE_IPC_TIMEOUT_MS,\n  mountedImageSubscribers as __TEST_ONLY_mountedImageSubscribers,\n  cacheGenerations as __TEST_ONLY_cacheGenerations,\n  saveToCache as __TEST_ONLY_saveToCache,\n  getImageDataUrlCacheStats as __TEST_ONLY_getImageDataUrlCacheStats,\n};\n\nconst getCachedDimensions = (filePath: string): { width: number; height: number } | null => {',
    );

  await writeFile(instrumentedMessageMarkdownPath, instrumentedMessageMarkdownSource, 'utf8');
  instrumentedMessageMarkdownModule = await import(/* @vite-ignore */ instrumentedMessageMarkdownSpecifier) as InstrumentedMessageMarkdownModule;

  return instrumentedMessageMarkdownModule;
}

async function ensurePendingLightweightMessageMarkdownModule(): Promise<Pick<InstrumentedMessageMarkdownModule, 'MessageMarkdown'>> {
  if (pendingLightweightMessageMarkdownModule) {
    return pendingLightweightMessageMarkdownModule;
  }

  const rawMessageMarkdownModule = await import('../MessageMarkdown.tsx?raw');
  const rawMessageMarkdownSource = rawMessageMarkdownModule.default;
  if (!rawMessageMarkdownSource.includes(pendingLightweightMarker)) {
    throw new Error('Could not instrument MessageMarkdown.tsx pending lightweight branch');
  }

  const instrumentedSource = rawMessageMarkdownSource.replace(
    pendingLightweightMarker,
    'const isPending = true;',
  );
  await writeFile(pendingLightweightMessageMarkdownPath, instrumentedSource, 'utf8');
  pendingLightweightMessageMarkdownModule = await import(
    /* @vite-ignore */ pendingLightweightMessageMarkdownSpecifier
  ) as Pick<InstrumentedMessageMarkdownModule, 'MessageMarkdown'>;
  return pendingLightweightMessageMarkdownModule;
}

function renderInstrumentedMessageMarkdown(
  content: string,
  props: Partial<ComponentProps<typeof MessageMarkdown>> = {},
) {
  if (!instrumentedMessageMarkdownModule) {
    throw new Error('Instrumented MessageMarkdown module was not initialized');
  }

  const InstrumentedMessageMarkdown = instrumentedMessageMarkdownModule.MessageMarkdown;
  const useSpacesReady = instrumentedMessageMarkdownModule.__TEST_ONLY_useSpacesReady;
  const onOpenFile = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let latestSnapshot: SpacesSnapshot | null = null;

  const SpacesReadyProbe = () => {
    latestSnapshot = useSpacesReady(props.coreDirectory);
    return (
      <div
        data-testid="spaces-ready-probe"
        data-spaces-ready={String(latestSnapshot.spacesReady)}
        data-spaces-error={String(latestSnapshot.spacesError)}
      />
    );
  };

  act(() => {
    root.render(
      <>
        <InstrumentedMessageMarkdown
          content={content}
          onOpenFile={onOpenFile}
          {...props}
        />
        <SpacesReadyProbe />
      </>,
    );
  });

  return {
    container,
    onOpenFile,
    getSnapshot: () => latestSnapshot,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushSpacesScan(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function flushImageWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type MockImageMode = 'auto' | 'manual';

const mockImageState: {
  mode: MockImageMode;
  instances: MockImage[];
  instantiationCount: number;
} = {
  mode: 'auto',
  instances: [],
  instantiationCount: 0,
};

class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 640;
  naturalHeight = 480;
  private _src = '';

  constructor() {
    mockImageState.instantiationCount += 1;
    mockImageState.instances.push(this);
  }

  set src(value: string) {
    this._src = value;
    if (value === '' || mockImageState.mode === 'manual') {
      return;
    }
    queueMicrotask(() => {
      this.onload?.();
    });
  }

  get src() {
    return this._src;
  }

  triggerLoad(width = 640, height = 480) {
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.onload?.();
  }

  triggerError() {
    this.onerror?.();
  }
}

const setMockImageMode = (mode: MockImageMode) => {
  mockImageState.mode = mode;
};

const getMockImageInstances = () => mockImageState.instances;

const resetMockImageState = () => {
  mockImageState.mode = 'auto';
  mockImageState.instances = [];
  mockImageState.instantiationCount = 0;
};

describe('rendered link click behavior', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const mockAppApi = {
    openUrl: vi.fn().mockResolvedValue(undefined),
    revealPath: vi.fn().mockResolvedValue(undefined),
  };
  const mockLibraryApi = {
    readFileBase64: vi.fn().mockResolvedValue(''),
    resolveSpaceLink: vi.fn().mockResolvedValue({ ok: true, workspaceRelativePath: 'Exec/notes.md' }),
    fileToSpaceLink: vi.fn().mockResolvedValue(null),
  };
  const cleanups: Array<() => void> = [];
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createMockWindowApi('api', mockAppApi);
    createMockWindowApi('appApi', mockAppApi);
    createMockWindowApi('libraryApi', mockLibraryApi);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  it('suppresses default handling and opens workspace files internally', () => {
    const view = renderMessageMarkdown('[x](library://foo.md)');
    cleanups.push(view.cleanup);
    const preventDefaultSpy = vi.spyOn(Event.prototype, 'preventDefault');

    const link = findLink(view.container, 'foo.md');
    expect(link.querySelector('.markdown-link__filename')?.textContent).toBe('foo.md');
    expect(link.querySelector('.markdown-link__scope-meta')).toBeNull();
    expect(link.getAttribute('data-full-path')).toBe('foo.md');
    expect(link.textContent).not.toBe('x');

    clickLink(link);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(view.onOpenFile).toHaveBeenCalledWith('foo.md');
    preventDefaultSpy.mockRestore();
  });

  it('shows the rich file context menu for library links', async () => {
    const view = renderMessageMarkdown('[x](library://foo.md)');
    cleanups.push(view.cleanup);

    await act(async () => {
      contextMenuLink(findLink(view.container, 'foo.md'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Reveal in file explorer');
    expect(document.body.textContent).toContain('Open in Library');
  });

  it('resolves rebel space links for the rich file context menu', async () => {
    mockLibraryApi.resolveSpaceLink.mockResolvedValueOnce({
      ok: true,
      workspaceRelativePath: 'Exec/notes.md',
    });
    const view = renderMessageMarkdown('[x](rebel://space/Exec/notes.md)');
    cleanups.push(view.cleanup);

    await act(async () => {
      contextMenuLink(findLink(view.container, 'notes.md'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockLibraryApi.resolveSpaceLink).toHaveBeenCalledWith({
      spaceName: 'Exec',
      filePath: 'notes.md',
      folderPath: undefined,
    });
    expect(findLink(view.container, 'notes.md').getAttribute('data-full-path')).toBe('Exec/notes.md');
    expect(document.body.textContent).toContain('Reveal in file explorer');
    expect(document.body.textContent).toContain('Open in Library');
  });

  it('does not collapse bare space navigation links into file chips', () => {
    const view = renderMessageMarkdown('[Exec](rebel://space/Exec)');
    cleanups.push(view.cleanup);

    const link = findLink(view.container, 'Exec');
    expect(link.classList.contains('markdown-link--space')).toBe(true);
    expect(link.classList.contains('markdown-link--file')).toBe(false);
    expect(link.querySelector('.markdown-link__scope-meta')).toBeNull();
  });

  it('suppresses default handling and opens external links via appApi', () => {
    const view = renderMessageMarkdown('[x](https://example.com)');
    cleanups.push(view.cleanup);
    const preventDefaultSpy = vi.spyOn(Event.prototype, 'preventDefault');

    clickLink(findLink(view.container, 'x'));
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(mockAppApi.openUrl).toHaveBeenCalledWith('https://example.com');
    expect(view.onOpenFile).not.toHaveBeenCalled();
    preventDefaultSpy.mockRestore();
  });

  it('does not suppress default handling for anchor-only links', () => {
    const view = renderMessageMarkdown('[x](#top)');
    cleanups.push(view.cleanup);
    const preventDefaultSpy = vi.spyOn(Event.prototype, 'preventDefault');

    clickLink(findLink(view.container, 'x'));
    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(mockAppApi.openUrl).not.toHaveBeenCalled();
    expect(view.onOpenFile).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    preventDefaultSpy.mockRestore();
  });

  it('suppresses blocked protocol-relative links and warns instead of navigating', () => {
    const view = renderMessageMarkdown('[x](//example.com/path)');
    cleanups.push(view.cleanup);
    const preventDefaultSpy = vi.spyOn(Event.prototype, 'preventDefault');

    clickLink(findLink(view.container, 'x'));
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[MessageMarkdown] Blocked (protocol-relative):',
      '//example.com/path',
    );
    expect(mockAppApi.openUrl).not.toHaveBeenCalled();
    expect(view.onOpenFile).not.toHaveBeenCalled();
    preventDefaultSpy.mockRestore();
  });

  it('blocks malformed rebel:// links instead of calling onNavigate', () => {
    const onNavigate = vi.fn();
    const view = renderMessageMarkdown('[x](rebel://foo/bar)', { onNavigate });
    cleanups.push(view.cleanup);
    const preventDefaultSpy = vi.spyOn(Event.prototype, 'preventDefault');

    clickLink(findLink(view.container, 'x'));
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[MessageMarkdown] Blocked (invalid-rebel-url):',
      'rebel://foo/bar',
    );
    preventDefaultSpy.mockRestore();
  });
});

describe('Stage 1 markdown anchor URL-scheme characterization', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const mockAppApi = {
    openUrl: vi.fn().mockResolvedValue(undefined),
    revealPath: vi.fn().mockResolvedValue(undefined),
  };
  const mockLibraryApi = {
    readFileBase64: vi.fn().mockResolvedValue(''),
    resolveSpaceLink: vi.fn().mockResolvedValue({ ok: true, workspaceRelativePath: 'Exec/notes.md' }),
    fileToSpaceLink: vi.fn().mockResolvedValue(null),
  };
  const cleanups: Array<() => void> = [];
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createMockWindowApi('api', mockAppApi);
    createMockWindowApi('appApi', mockAppApi);
    createMockWindowApi('libraryApi', mockLibraryApi);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    consoleWarnSpy.mockRestore();
  });

  afterAll(async () => {
    await unlink(pendingLightweightMessageMarkdownPath).catch(() => undefined);
  });

  type DispatchExpectation =
    | { kind: 'blocked'; reason: string; url: string }
    | { kind: 'external'; url: string }
    | { kind: 'open-file'; path: string }
    | { kind: 'conversation'; sessionId: string }
    | { kind: 'tutorial'; path: string }
    | { kind: 'navigate'; url: string }
    | { kind: 'no-op' };

  type AnchorCase = {
    name: string;
    markdownUrl: string;
    renderedHref: string | null;
    dataHref: string | null;
    dispatch: DispatchExpectation;
    target?: string | null;
    rel?: string | null;
    classes?: string[];
    absentClasses?: string[];
    fullPath?: string | null;
    filename?: string;
    scopeMeta?: string | null;
  };

  const mainAnchorCases: AnchorCase[] = [
    {
      name: 'javascript:',
      markdownUrl: 'javascript:alert',
      renderedHref: '#',
      dataHref: 'javascript:alert',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'javascript:alert' },
    },
    {
      name: 'leading whitespace JavaScript:',
      markdownUrl: '\tJavaScript:alert',
      renderedHref: '#',
      dataHref: 'JavaScript:alert',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'JavaScript:alert' },
    },
    {
      name: 'blob:',
      markdownUrl: 'blob:https://evil.example/id',
      renderedHref: '#',
      dataHref: 'blob:https://evil.example/id',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'blob:https://evil.example/id' },
    },
    {
      name: 'leading whitespace Blob:',
      markdownUrl: '\tBlob:https://evil.example/id',
      renderedHref: '#',
      dataHref: 'Blob:https://evil.example/id',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'Blob:https://evil.example/id' },
    },
    {
      name: 'file://',
      markdownUrl: 'file:///Users/you/docs/from-file.md',
      renderedHref: 'file:///Users/you/docs/from-file.md',
      dataHref: 'file:///Users/you/docs/from-file.md',
      dispatch: { kind: 'open-file', path: '/Users/you/docs/from-file.md' },
    },
    {
      name: 'data:image/svg+xml',
      markdownUrl: 'data:image/svg+xml;base64,AAAA',
      renderedHref: '#',
      dataHref: 'data:image/svg+xml;base64,AAAA',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'data:image/svg+xml;base64,AAAA' },
    },
    {
      name: 'data:image/png',
      markdownUrl: 'data:image/png;base64,AAAA',
      renderedHref: '#',
      dataHref: 'data:image/png;base64,AAAA',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'data:image/png;base64,AAAA' },
    },
    {
      name: 'data:text/html',
      markdownUrl: 'data:text/html,hello',
      renderedHref: '#',
      dataHref: 'data:text/html,hello',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'data:text/html,hello' },
    },
    {
      name: 'vbscript:',
      markdownUrl: 'vbscript:msgbox',
      renderedHref: '#',
      dataHref: 'vbscript:msgbox',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'vbscript:msgbox' },
    },
    {
      name: 'mixed case VbScript:',
      markdownUrl: 'VbScript:msgbox',
      renderedHref: '#',
      dataHref: 'VbScript:msgbox',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'VbScript:msgbox' },
    },
    {
      name: 'protocol-relative',
      markdownUrl: '//evil.example/path',
      renderedHref: '#',
      dataHref: '//evil.example/path',
      dispatch: { kind: 'blocked', reason: 'protocol-relative', url: '//evil.example/path' },
    },
    {
      name: 'unknown weird:',
      markdownUrl: 'weird:thing',
      renderedHref: '#',
      dataHref: 'weird:thing',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'weird:thing' },
    },
    {
      name: 'https://',
      markdownUrl: 'https://example.com/path',
      renderedHref: 'https://example.com/path',
      dataHref: 'https://example.com/path',
      dispatch: { kind: 'external', url: 'https://example.com/path' },
      target: '_blank',
      rel: 'noopener noreferrer',
      classes: ['markdown-link--external'],
    },
    {
      name: 'mailto:',
      markdownUrl: 'mailto:hello@example.com',
      renderedHref: '#',
      dataHref: 'mailto:hello@example.com',
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'mailto:hello@example.com' },
    },
    {
      name: 'library://',
      markdownUrl: 'library://docs/guide.md',
      renderedHref: '#',
      dataHref: 'library://docs/guide.md',
      dispatch: { kind: 'open-file', path: 'docs/guide.md' },
      classes: ['markdown-link--file', 'markdown-link--workspace'],
      fullPath: 'docs/guide.md',
      filename: 'guide.md',
      scopeMeta: null,
    },
    {
      name: 'workspace://',
      markdownUrl: 'workspace://docs/workspace.md',
      renderedHref: '#',
      dataHref: 'workspace://docs/workspace.md',
      dispatch: { kind: 'open-file', path: 'docs/workspace.md' },
      classes: ['markdown-link--file', 'markdown-link--workspace'],
      fullPath: 'docs/workspace.md',
      filename: 'workspace.md',
      scopeMeta: null,
    },
    {
      name: 'rebel://library/...',
      markdownUrl: 'rebel://library/docs/rebel.md',
      renderedHref: '#',
      dataHref: 'rebel://library/docs/rebel.md',
      dispatch: { kind: 'open-file', path: 'docs/rebel.md' },
      classes: ['markdown-link--file', 'markdown-link--workspace'],
      fullPath: 'docs/rebel.md',
      filename: 'rebel.md',
      scopeMeta: null,
    },
    {
      name: 'rebel://space/...',
      markdownUrl: 'rebel://space/Exec/notes.md',
      renderedHref: '#',
      dataHref: 'rebel://space/Exec/notes.md',
      dispatch: { kind: 'navigate', url: 'rebel://space/Exec/notes.md' },
      classes: ['markdown-link--file', 'markdown-link--space'],
      absentClasses: ['markdown-link--workspace'],
      fullPath: 'Exec/notes.md',
      filename: 'notes.md',
      scopeMeta: 'Exec',
    },
    {
      name: 'rebel://conversation/...',
      markdownUrl: 'rebel://conversation/session-123',
      renderedHref: '#',
      dataHref: 'rebel://conversation/session-123',
      dispatch: { kind: 'conversation', sessionId: 'session-123' },
      classes: ['markdown-link--conversation'],
    },
    {
      name: 'rebel://help/tutorials/...',
      markdownUrl: 'rebel://help/tutorials/intro.html',
      renderedHref: '#',
      dataHref: 'rebel://help/tutorials/intro.html',
      dispatch: { kind: 'tutorial', path: 'rebel-system/help-for-humans/tutorials/intro.html' },
      classes: ['markdown-link--tutorial'],
    },
    {
      name: 'relative path',
      markdownUrl: 'docs/relative.md',
      renderedHref: '#',
      dataHref: formatLibraryUrl('docs/relative.md'),
      dispatch: { kind: 'open-file', path: 'docs/relative.md' },
      classes: ['markdown-link--file', 'markdown-link--workspace'],
      fullPath: 'docs/relative.md',
      filename: 'relative.md',
      scopeMeta: null,
    },
    {
      name: '#hash',
      markdownUrl: '#section',
      renderedHref: '#section',
      dataHref: '#section',
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'Windows-drive-like path',
      markdownUrl: 'C:\\Users\\greg\\notes.md',
      renderedHref: '#',
      dataHref: formatLibraryUrl('C:\\Users\\greg\\notes.md'),
      dispatch: { kind: 'open-file', path: 'C:\\Users\\greg\\notes.md' },
      classes: ['markdown-link--file', 'markdown-link--workspace'],
      fullPath: 'C:\\Users\\greg\\notes.md',
      filename: 'notes.md',
      scopeMeta: null,
    },
  ];

  const expectDispatch = (
    event: MouseEvent,
    dispatch: DispatchExpectation,
    view: ReturnType<typeof renderMessageMarkdown>,
    callbacks: {
      onOpenConversation: ReturnType<typeof vi.fn>;
      onOpenTutorial: ReturnType<typeof vi.fn>;
      onNavigate: ReturnType<typeof vi.fn>;
    },
  ) => {
    switch (dispatch.kind) {
      case 'blocked':
        expect(event.defaultPrevented).toBe(true);
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          `[MessageMarkdown] Blocked (${dispatch.reason}):`,
          dispatch.url,
        );
        expect(mockAppApi.openUrl).not.toHaveBeenCalled();
        expect(view.onOpenFile).not.toHaveBeenCalled();
        expect(callbacks.onOpenConversation).not.toHaveBeenCalled();
        expect(callbacks.onOpenTutorial).not.toHaveBeenCalled();
        expect(callbacks.onNavigate).not.toHaveBeenCalled();
        break;
      case 'external':
        expect(event.defaultPrevented).toBe(true);
        expect(mockAppApi.openUrl).toHaveBeenCalledWith(dispatch.url);
        expect(view.onOpenFile).not.toHaveBeenCalled();
        break;
      case 'open-file':
        expect(event.defaultPrevented).toBe(true);
        expect(view.onOpenFile).toHaveBeenCalledWith(dispatch.path);
        expect(mockAppApi.openUrl).not.toHaveBeenCalled();
        break;
      case 'conversation':
        expect(event.defaultPrevented).toBe(true);
        expect(callbacks.onOpenConversation).toHaveBeenCalledWith(dispatch.sessionId);
        expect(mockAppApi.openUrl).not.toHaveBeenCalled();
        expect(view.onOpenFile).not.toHaveBeenCalled();
        break;
      case 'tutorial':
        expect(event.defaultPrevented).toBe(true);
        expect(callbacks.onOpenTutorial).toHaveBeenCalledWith(dispatch.path);
        expect(mockAppApi.openUrl).not.toHaveBeenCalled();
        expect(view.onOpenFile).not.toHaveBeenCalled();
        break;
      case 'navigate':
        expect(event.defaultPrevented).toBe(true);
        expect(callbacks.onNavigate).toHaveBeenCalledWith(dispatch.url);
        expect(mockAppApi.openUrl).not.toHaveBeenCalled();
        expect(view.onOpenFile).not.toHaveBeenCalled();
        break;
      case 'no-op':
        expect(event.defaultPrevented).toBe(false);
        expect(consoleWarnSpy).not.toHaveBeenCalled();
        expect(mockAppApi.openUrl).not.toHaveBeenCalled();
        expect(view.onOpenFile).not.toHaveBeenCalled();
        expect(callbacks.onOpenConversation).not.toHaveBeenCalled();
        expect(callbacks.onOpenTutorial).not.toHaveBeenCalled();
        expect(callbacks.onNavigate).not.toHaveBeenCalled();
        break;
      default: {
        const exhaustive: never = dispatch;
        throw new Error(`Unhandled dispatch expectation: ${String(exhaustive)}`);
      }
    }
  };

  it.each(mainAnchorCases)('main anchor keeps current render + click-dispatch behavior for $name', (anchorCase) => {
    const onOpenConversation = vi.fn();
    const onOpenTutorial = vi.fn();
    const onNavigate = vi.fn();
    const view = renderMessageMarkdown(`[${anchorCase.name}](${anchorCase.markdownUrl})`, {
      onOpenConversation,
      onOpenTutorial,
      onNavigate,
    });
    cleanups.push(view.cleanup);

    const link = findLink(view.container, anchorCase.filename ?? anchorCase.name);
    expect(link.getAttribute('href')).toBe(anchorCase.renderedHref);
    expect(link.getAttribute('data-href')).toBe(anchorCase.dataHref);
    expect(link.getAttribute('target')).toBe(anchorCase.target ?? null);
    expect(link.getAttribute('rel')).toBe(anchorCase.rel ?? null);
    expect(link.classList.contains('markdown-link')).toBe(true);
    for (const className of anchorCase.classes ?? []) {
      expect(link.classList.contains(className)).toBe(true);
    }
    for (const className of anchorCase.absentClasses ?? []) {
      expect(link.classList.contains(className)).toBe(false);
    }
    if ('fullPath' in anchorCase) {
      expect(link.getAttribute('data-full-path')).toBe(anchorCase.fullPath ?? null);
    }
    if ('scopeMeta' in anchorCase) {
      const scopeMeta = link.querySelector('.markdown-link__scope-meta');
      expect(scopeMeta?.textContent ?? null).toBe(anchorCase.scopeMeta ?? null);
    }

    const event = clickLinkEvent(link);
    expectDispatch(event, anchorCase.dispatch, view, { onOpenConversation, onOpenTutorial, onNavigate });
  });

  const collapsedAnchorCases: AnchorCase[] = [
    {
      name: 'javascript:',
      markdownUrl: 'javascript:alert',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'leading whitespace JavaScript:',
      markdownUrl: '\tJavaScript:alert',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'blob:',
      markdownUrl: 'blob:https://evil.example/id',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'leading whitespace Blob:',
      markdownUrl: '\tBlob:https://evil.example/id',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'file://',
      markdownUrl: 'file:///Users/you/docs/from-file.md',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'data:image/svg+xml',
      markdownUrl: 'data:image/svg+xml;base64,AAAA',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'data:image/png',
      markdownUrl: 'data:image/png;base64,AAAA',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'data:text/html',
      markdownUrl: 'data:text/html,hello',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'mixed case VbScript:',
      markdownUrl: 'VbScript:msgbox',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'vbscript:',
      markdownUrl: 'vbscript:msgbox',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'protocol-relative',
      markdownUrl: '//evil.example/path',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'unknown weird:',
      markdownUrl: 'weird:thing',
      renderedHref: null,
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'https://',
      markdownUrl: 'https://example.com/path',
      renderedHref: 'https://example.com/path',
      dataHref: null,
      dispatch: { kind: 'external', url: 'https://example.com/path' },
    },
    {
      name: 'mailto:',
      markdownUrl: 'mailto:hello@example.com',
      renderedHref: 'mailto:hello@example.com',
      dataHref: null,
      dispatch: { kind: 'blocked', reason: 'unknown-scheme', url: 'mailto:hello@example.com' },
    },
    {
      name: 'library://',
      markdownUrl: 'library://docs/guide.md',
      renderedHref: 'library://docs/guide.md',
      dataHref: null,
      dispatch: { kind: 'open-file', path: 'docs/guide.md' },
    },
    {
      name: 'workspace://',
      markdownUrl: 'workspace://docs/workspace.md',
      renderedHref: 'workspace://docs/workspace.md',
      dataHref: null,
      dispatch: { kind: 'open-file', path: 'docs/workspace.md' },
    },
    {
      name: 'rebel://library/...',
      markdownUrl: 'rebel://library/docs/rebel.md',
      renderedHref: 'rebel://library/docs/rebel.md',
      dataHref: null,
      dispatch: { kind: 'open-file', path: 'docs/rebel.md' },
    },
    {
      name: 'rebel://space/...',
      markdownUrl: 'rebel://space/Exec/notes.md',
      renderedHref: 'rebel://space/Exec/notes.md',
      dataHref: null,
      dispatch: { kind: 'navigate', url: 'rebel://space/Exec/notes.md' },
    },
    {
      name: 'rebel://conversation/...',
      markdownUrl: 'rebel://conversation/session-123',
      renderedHref: 'rebel://conversation/session-123',
      dataHref: null,
      dispatch: { kind: 'conversation', sessionId: 'session-123' },
    },
    {
      name: 'rebel://help/tutorials/...',
      markdownUrl: 'rebel://help/tutorials/intro.html',
      renderedHref: 'rebel://help/tutorials/intro.html',
      dataHref: null,
      dispatch: { kind: 'tutorial', path: 'rebel-system/help-for-humans/tutorials/intro.html' },
    },
    {
      name: 'relative path',
      markdownUrl: 'docs/relative.md',
      renderedHref: formatLibraryUrl('docs/relative.md'),
      dataHref: null,
      dispatch: { kind: 'open-file', path: 'docs/relative.md' },
    },
    {
      name: '#hash',
      markdownUrl: '#section',
      renderedHref: '#section',
      dataHref: null,
      dispatch: { kind: 'no-op' },
    },
    {
      name: 'Windows-drive-like path',
      markdownUrl: 'C:\\Users\\greg\\notes.md',
      renderedHref: formatLibraryUrl('C:\\Users\\greg\\notes.md'),
      dataHref: null,
      dispatch: { kind: 'open-file', path: 'C:\\Users\\greg\\notes.md' },
    },
  ];

  it.each(collapsedAnchorCases)('collapsed-body anchor keeps expected render + click-dispatch behavior for $name', (anchorCase) => {
    const onOpenConversation = vi.fn();
    const onOpenTutorial = vi.fn();
    const onNavigate = vi.fn();
    const view = renderMessageMarkdown(
      `<details open>\n<summary>Section</summary>\n\n[${anchorCase.name}](${anchorCase.markdownUrl})\n</details>`,
      { onOpenConversation, onOpenTutorial, onNavigate },
    );
    cleanups.push(view.cleanup);

    const collapsibleBody = view.container.querySelector('.markdown-collapsible__body');
    expect(collapsibleBody).not.toBeNull();
    const link = findLink(collapsibleBody as HTMLElement, anchorCase.name);
    expect(link.getAttribute('href')).toBe(anchorCase.renderedHref);
    expect(link.getAttribute('data-href')).toBe(anchorCase.dataHref);
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toBeNull();
    expect(link.className).toBe('');

    const event = clickLinkEvent(link);
    expectDispatch(event, anchorCase.dispatch, view, { onOpenConversation, onOpenTutorial, onNavigate });
  });

  it.each([
    {
      name: 'file://',
      markdownUrl: 'file:///Users/you/docs/from-file.md',
      dangerousSelector: 'a[href^="file:"]',
    },
    {
      name: 'data:image/svg+xml',
      markdownUrl: 'data:image/svg+xml;base64,AAAA',
      dangerousSelector: 'a[href^="data:"]',
    },
  ])('collapsed-body anchor renders $name inert so copy/middle-click cannot reach the dangerous URL', (anchorCase) => {
    const view = renderMessageMarkdown(
      `<details open>\n<summary>Section</summary>\n\n[${anchorCase.name}](${anchorCase.markdownUrl})\n</details>`,
    );
    cleanups.push(view.cleanup);

    const collapsibleBody = view.container.querySelector('.markdown-collapsible__body');
    expect(collapsibleBody).not.toBeNull();
    const link = findLink(collapsibleBody as HTMLElement, anchorCase.name);
    expect(link.getAttribute('href')).toBeNull();
    expect(link.getAttribute('data-href')).toBeNull();
    expect(collapsibleBody?.querySelector(anchorCase.dangerousSelector)).toBeNull();
  });

  it('two-phase lightweight MessageMarkdown renders anchors as inert children-only spans', () => {
    const filler = 'x '.repeat(760);
    const view = renderMessageMarkdown(`[lightweight](javascript:alert)\n\n${filler}`);
    cleanups.push(view.cleanup);

    expect(view.container.querySelector('a')).toBeNull();
    const span = Array.from(view.container.querySelectorAll('span')).find((candidate) => (
      candidate.textContent === 'lightweight'
    ));
    expect(span).toBeDefined();
    expect(span?.getAttribute('href')).toBeNull();
    expect(span?.getAttribute('data-href')).toBeNull();
    expect(mockAppApi.openUrl).not.toHaveBeenCalled();
  });

  it('pending lightweight MessageMarkdown renders anchors as inert children-only spans', async () => {
    const { MessageMarkdown: PendingLightweightMessageMarkdown } =
      await ensurePendingLightweightMessageMarkdownModule();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const cleanup = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };
    cleanups.push(cleanup);

    const filler = 'x '.repeat(300);
    act(() => {
      root.render(
        <PendingLightweightMessageMarkdown
          content={`[pending](javascript:alert)\n\n${filler}`}
          onOpenFile={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('a')).toBeNull();
    const span = Array.from(container.querySelectorAll('span')).find((candidate) => (
      candidate.textContent === 'pending'
    ));
    expect(span).toBeDefined();
    expect(span?.getAttribute('href')).toBeNull();
    expect(span?.getAttribute('data-href')).toBeNull();
    expect(mockAppApi.openUrl).not.toHaveBeenCalled();
  });
});

describe('File link click behavior specifications', () => {
  describe('isEditableWorkspaceFile', () => {
    it('returns true for markdown files', () => {
      expect(isEditableWorkspaceFile('/path/to/file.md')).toBe(true);
      expect(isEditableWorkspaceFile('./docs/readme.md')).toBe(true);
      expect(isEditableWorkspaceFile('src/file.markdown')).toBe(true);
    });

    it('returns true for text files', () => {
      expect(isEditableWorkspaceFile('/path/notes.txt')).toBe(true);
      expect(isEditableWorkspaceFile('./notes.text')).toBe(true);
    });

    it('returns true for mdx files', () => {
      expect(isEditableWorkspaceFile('/components/Button.mdx')).toBe(true);
    });

    it('returns false for non-editable files', () => {
      expect(isEditableWorkspaceFile('/path/app.exe')).toBe(false);
      expect(isEditableWorkspaceFile('./image.png')).toBe(false);
      expect(isEditableWorkspaceFile('data.json')).toBe(false);
      expect(isEditableWorkspaceFile('script.ts')).toBe(false);
    });

    it('returns false for empty path', () => {
      expect(isEditableWorkspaceFile('')).toBe(false);
    });

    it('is case insensitive', () => {
      expect(isEditableWorkspaceFile('/path/FILE.MD')).toBe(true);
      expect(isEditableWorkspaceFile('/path/file.TXT')).toBe(true);
    });
  });

  describe('isImagePath helper', () => {
    it('identifies image extensions', () => {
      expect(isImagePath('photo.png')).toBe(true);
      expect(isImagePath('/path/to/image.jpg')).toBe(true);
      expect(isImagePath('./screenshots/capture.jpeg')).toBe(true);
      expect(isImagePath('icon.gif')).toBe(true);
      expect(isImagePath('banner.webp')).toBe(true);
      expect(isImagePath('logo.bmp')).toBe(true);
      expect(isImagePath('diagram.svg')).toBe(true);
    });

    it('returns false for non-image files', () => {
      expect(isImagePath('document.md')).toBe(false);
      expect(isImagePath('script.ts')).toBe(false);
      expect(isImagePath('data.json')).toBe(false);
    });
  });

  describe('isAbsolutePath helper', () => {
    it('identifies Unix absolute paths', () => {
      expect(isAbsolutePath('/Users/test/file.md')).toBe(true);
      expect(isAbsolutePath('/home/user/docs/readme.txt')).toBe(true);
    });

    it('identifies Windows absolute paths', () => {
      expect(isAbsolutePath('C:\\Users\\test\\file.md')).toBe(true);
      expect(isAbsolutePath('D:/Documents/readme.txt')).toBe(true);
    });

    it('returns false for relative paths', () => {
      expect(isAbsolutePath('./docs/readme.md')).toBe(false);
      expect(isAbsolutePath('../parent/file.txt')).toBe(false);
      expect(isAbsolutePath('src/components/Button.tsx')).toBe(false);
    });
  });

  describe('Expected link click behavior matrix', () => {
    /**
     * This defines the expected behavior for each combination of:
     * - Path type (absolute vs relative)
     * - File type (editable, image, other)
     * - Callback availability (onOpenFile provided or not)
     */
    
    const testCases = [
      // Editable files - should use onOpenFile when available
      { path: '/Users/test/docs/readme.md', isAbsolute: true, isEditable: true, isImage: false, 
        expected: 'onOpenFile', description: 'Absolute markdown path' },
      { path: './docs/readme.md', isAbsolute: false, isEditable: true, isImage: false, 
        expected: 'onOpenFile', description: 'Relative markdown path' },
      { path: 'src/docs/guide.md', isAbsolute: false, isEditable: true, isImage: false, 
        expected: 'onOpenFile', description: 'Project-relative markdown path' },
      { path: '/path/to/notes.txt', isAbsolute: true, isEditable: true, isImage: false, 
        expected: 'onOpenFile', description: 'Absolute text file' },
      { path: './notes.txt', isAbsolute: false, isEditable: true, isImage: false, 
        expected: 'onOpenFile', description: 'Relative text file' },
      
      // Image files - should use image viewer
      { path: '/Users/test/photo.png', isAbsolute: true, isEditable: false, isImage: true, 
        expected: 'imageViewer', description: 'Absolute image path' },
      { path: './images/screenshot.jpg', isAbsolute: false, isEditable: false, isImage: true, 
        expected: 'imageViewer', description: 'Relative image path' },
      { path: 'assets/logo.svg', isAbsolute: false, isEditable: false, isImage: true, 
        expected: 'imageViewer', description: 'Project-relative image path' },
      
      // Non-editable, non-image files - should reveal in Finder
      { path: '/Users/test/app.exe', isAbsolute: true, isEditable: false, isImage: false, 
        expected: 'revealPath', description: 'Absolute binary path' },
      { path: './build/output.bin', isAbsolute: false, isEditable: false, isImage: false, 
        expected: 'revealPath', description: 'Relative binary path' },
      { path: 'config.json', isAbsolute: false, isEditable: false, isImage: false, 
        expected: 'revealPath', description: 'Config file (not editable in our editor)' },
    ];

    for (const tc of testCases) {
      it(`${tc.description} (${tc.path}) -> ${tc.expected}`, () => {
        expect(isAbsolutePath(tc.path)).toBe(tc.isAbsolute);
        expect(isEditableWorkspaceFile(tc.path)).toBe(tc.isEditable);
        expect(isImagePath(tc.path)).toBe(tc.isImage);
        
        // The expected behavior
        let expectedAction: string;
        if (tc.isImage) {
          expectedAction = 'imageViewer';
        } else if (tc.isEditable) {
          expectedAction = 'onOpenFile';
        } else {
          expectedAction = 'revealPath';
        }
        expect(expectedAction).toBe(tc.expected);
      });
    }
  });

  describe('Real-world agent output scenarios', () => {
    it('Acme Proposal Meeting scenario - absolute path to created markdown', () => {
      const path = '/Users/you/Documents/Workspace/Core/chief-of-staff/memory/conversations/acme-proposal-meeting.md';
      
      expect(isAbsolutePath(path)).toBe(true);
      expect(isEditableWorkspaceFile(path)).toBe(true);
      expect(isImagePath(path)).toBe(false);
      
      // Expected: should open in internal editor, NOT reveal in Finder
    });

    it('Screenshot capture scenario - absolute path to image', () => {
      const path = '/Users/test/screenshots/capture.png';
      
      expect(isAbsolutePath(path)).toBe(true);
      expect(isEditableWorkspaceFile(path)).toBe(false);
      expect(isImagePath(path)).toBe(true);
      
      // Expected: should open in internal image viewer
    });

    it('Meeting notes scenario - relative path to markdown', () => {
      const path = './chief-of-staff/memory/meetings/2024-01-15-standup.md';
      
      expect(isAbsolutePath(path)).toBe(false);
      expect(isEditableWorkspaceFile(path)).toBe(true);
      expect(isImagePath(path)).toBe(false);
      
      // Expected: should open in internal editor
    });
  });

  describe('file:// URL handling (agent output)', () => {
    /**
     * Agents often output file:// URLs when creating files.
     * These need to be converted to filesystem paths before opening.
     * Uses URL API for robust parsing.
     */
    const convertFileUrlToPath = (href: string): string => {
      // Same logic as in handleLinkClick - uses URL API
      try {
        const url = new URL(href);
        let filePath = decodeURIComponent(url.pathname);
        // Windows drive letter: /C:/... -> C:/...
        if (/^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.substring(1);
        }
        // UNC path: hostname is the server name
        if (url.hostname && url.hostname !== 'localhost') {
          filePath = `\\\\${url.hostname}${filePath.replace(/\//g, '\\')}`;
        }
        return filePath;
      } catch {
        return decodeURIComponent(href.substring('file://'.length).replace(/^\/([A-Za-z]:)/, '$1'));
      }
    };

    it('converts Unix file:// URLs to paths', () => {
      const url = 'file:///Users/you/Dropbox/skills/demo-script.md';
      expect(convertFileUrlToPath(url)).toBe('/Users/you/Dropbox/skills/demo-script.md');
    });

    it('converts Windows file:// URLs to paths', () => {
      const url = 'file:///C:/Users/test/Documents/file.md';
      expect(convertFileUrlToPath(url)).toBe('C:/Users/test/Documents/file.md');
    });

    it('handles URL-encoded characters', () => {
      const url = 'file:///Users/test/My%20Documents/file%20name.md';
      expect(convertFileUrlToPath(url)).toBe('/Users/test/My Documents/file name.md');
    });

    it('strips URL fragments (anchors) from path', () => {
      // This was a bug: file:///path/to/docs.md#setup would result in /path/to/docs.md#setup
      // which failed isEditableWorkspaceFile check
      const url = 'file:///Users/you/docs/guide.md#installation';
      const path = convertFileUrlToPath(url);
      expect(path).toBe('/Users/you/docs/guide.md');
      expect(isEditableWorkspaceFile(path)).toBe(true);
    });

    it('strips query parameters from path', () => {
      const url = 'file:///Users/you/docs/guide.md?line=42';
      const path = convertFileUrlToPath(url);
      expect(path).toBe('/Users/you/docs/guide.md');
    });

    it('handles localhost variant', () => {
      const url = 'file://localhost/Users/you/docs/file.md';
      expect(convertFileUrlToPath(url)).toBe('/Users/you/docs/file.md');
    });

    it('handles UNC paths (Windows network shares)', () => {
      const url = 'file://server/share/path/file.md';
      expect(convertFileUrlToPath(url)).toBe('\\\\server\\share\\path\\file.md');
    });

    it('resulting path is editable for markdown files', () => {
      const url = 'file:///Users/you/workspace/skills/customer-research-agent/demo-script.md';
      const path = convertFileUrlToPath(url);
      expect(isEditableWorkspaceFile(path)).toBe(true);
    });

    it('real bug scenario - file:// URL passed to workspace:read-file', () => {
      // This was the actual bug: file:// URLs were being passed directly to the
      // workspace API without converting to a filesystem path first
      const agentOutputUrl = 'file:///Users/you/Dropbox/dev/experim/Rebel-chief-of-staff/Chief-of-Staff/skills/customer-research-agent/demo-script.md';
      const expectedPath = '/Users/you/Dropbox/dev/experim/Rebel-chief-of-staff/Chief-of-Staff/skills/customer-research-agent/demo-script.md';
      
      expect(convertFileUrlToPath(agentOutputUrl)).toBe(expectedPath);
      expect(isEditableWorkspaceFile(expectedPath)).toBe(true);
    });
  });

  describe('EDITABLE_EXTENSIONS completeness', () => {
    it('includes all expected markdown variants', () => {
      expect(EDITABLE_EXTENSIONS).toContain('.md');
      expect(EDITABLE_EXTENSIONS).toContain('.markdown');
      expect(EDITABLE_EXTENSIONS).toContain('.mdx');
    });

    it('includes text file extensions', () => {
      expect(EDITABLE_EXTENSIONS).toContain('.txt');
      expect(EDITABLE_EXTENSIONS).toContain('.text');
    });
  });
});

describe('Link handling implementation requirements', () => {
  /**
   * These are the requirements for the handleLinkClick function:
   * 
   * CURRENT (BUGGY) BEHAVIOR:
   * 1. Image files -> image viewer
   * 2. Absolute paths -> revealPath (WRONG for editable files!)
   * 3. Relative paths + onOpenFile -> onOpenFile
   * 4. Relative paths without onOpenFile -> revealPath
   * 
   * EXPECTED (FIXED) BEHAVIOR:
   * 1. Image files -> image viewer (regardless of absolute/relative)
   * 2. Editable files + onOpenFile -> onOpenFile (regardless of absolute/relative)
   * 3. Non-editable/non-image files -> revealPath
   * 4. External URLs -> openUrl
   */
  
  it('documents the fix needed in handleLinkClick', () => {
    // Note: Click handler now accepts both library:// and workspace:// (backwards compat)
    const pseudoCode = `
      handleLinkClick(href, onOpenFile):
        prefix = href.startsWith('library://') ? 'library://' : 'workspace://'
        filePath = decodeURIComponent(href.substring(prefix.length))
        
        // 1. Images always use viewer (already correct)
        if (isImagePath(filePath)):
          openImageViewer(filePath)
          return
        
        // 2. FIXED: Editable files use onOpenFile regardless of absolute/relative
        if (isEditableWorkspaceFile(filePath) && onOpenFile):
          onOpenFile(filePath)
          return
        
        // 3. Everything else reveals in Finder
        revealPath(filePath)
    `;
    
    expect(pseudoCode).toBeDefined();
  });
});

describe('parseCollapseBlock', () => {
  it('extracts summary from first line', () => {
    const content = 'Summary text\nBody content here';
    const result = parseCollapseBlock(content);
    expect(result.summary).toBe('Summary text');
  });

  it('extracts body from remaining lines', () => {
    const content = 'Summary text\nBody line 1\nBody line 2';
    const result = parseCollapseBlock(content);
    expect(result.body).toBe('Body line 1\nBody line 2');
  });

  it('falls back to "Details" when first line is empty', () => {
    // When content is empty or whitespace-only, summary falls back to "Details"
    const emptyContent = '';
    const result1 = parseCollapseBlock(emptyContent);
    expect(result1.summary).toBe('Details');
    expect(result1.body).toBe('');

    // Whitespace-only content also falls back
    const whitespaceContent = '   \n  \n   ';
    const result2 = parseCollapseBlock(whitespaceContent);
    expect(result2.summary).toBe('Details');
    expect(result2.body).toBe('');
  });

  it('handles empty body (summary-only case)', () => {
    const content = 'Just a summary';
    const result = parseCollapseBlock(content);
    expect(result.summary).toBe('Just a summary');
    expect(result.body).toBe('');
  });

  it('handles content with multiple lines', () => {
    const content = 'Installation Steps\nStep 1: Clone the repo\nStep 2: Run npm install\nStep 3: Start the server';
    const result = parseCollapseBlock(content);
    expect(result.summary).toBe('Installation Steps');
    expect(result.body).toBe('Step 1: Clone the repo\nStep 2: Run npm install\nStep 3: Start the server');
  });
});

describe('isCollapseLanguage', () => {
  it('returns { isCollapse: true, defaultOpen: false } for language-collapse', () => {
    const result = isCollapseLanguage('language-collapse');
    expect(result).toEqual({ isCollapse: true, defaultOpen: false });
  });

  it('returns { isCollapse: true, defaultOpen: true } for language-collapse-open', () => {
    const result = isCollapseLanguage('language-collapse-open');
    expect(result).toEqual({ isCollapse: true, defaultOpen: true });
  });

  it('returns { isCollapse: false, defaultOpen: false } for other languages', () => {
    expect(isCollapseLanguage('language-javascript')).toEqual({ isCollapse: false, defaultOpen: false });
    expect(isCollapseLanguage('language-typescript')).toEqual({ isCollapse: false, defaultOpen: false });
    expect(isCollapseLanguage('language-python')).toEqual({ isCollapse: false, defaultOpen: false });
  });

  it('returns { isCollapse: false, defaultOpen: false } for undefined/empty className', () => {
    expect(isCollapseLanguage(undefined)).toEqual({ isCollapse: false, defaultOpen: false });
    expect(isCollapseLanguage('')).toEqual({ isCollapse: false, defaultOpen: false });
  });

  it('does NOT match substrings like language-collapsible', () => {
    // This tests the exact token matching to avoid false positives
    expect(isCollapseLanguage('language-collapsible')).toEqual({ isCollapse: false, defaultOpen: false });
    expect(isCollapseLanguage('language-collapse-custom')).toEqual({ isCollapse: false, defaultOpen: false });
    expect(isCollapseLanguage('language-my-collapse')).toEqual({ isCollapse: false, defaultOpen: false });
  });
});

describe('convertHtmlDetailsToCollapse', () => {
  it('converts basic <details><summary> to ```collapse', () => {
    const input = '<details>\n<summary>Click to expand</summary>\n\nSome body content.\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('```collapse\n');
    expect(result).toContain('Click to expand');
    expect(result).toContain('Some body content.');
    expect(result).toContain('```');
    expect(result).not.toContain('<details');
    expect(result).not.toContain('<summary');
  });

  it('converts <details open> to ```collapse-open', () => {
    const input = '<details open>\n<summary>Expanded section</summary>\n\nVisible content.\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('```collapse-open\n');
    expect(result).toContain('Expanded section');
  });

  it('strips HTML tags from summary (e.g. <strong>)', () => {
    const input = '<details>\n<summary><strong>Bold title</strong> — extra text</summary>\n\nBody.\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('Bold title — extra text');
    expect(result).not.toContain('<strong>');
  });

  it('preserves markdown in body', () => {
    const input = '<details>\n<summary>Summary</summary>\n\n- **Item 1**: Description\n- **Item 2**: Description\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('- **Item 1**: Description');
    expect(result).toContain('- **Item 2**: Description');
  });

  it('returns content unchanged when no <details> tags present', () => {
    const input = 'Just some regular markdown\n\n## Heading\n\nParagraph text.';
    expect(convertHtmlDetailsToCollapse(input)).toBe(input);
  });

  it('handles multiple <details> blocks', () => {
    const input = '<details>\n<summary>First</summary>\nBody 1\n</details>\n\n<details>\n<summary>Second</summary>\nBody 2\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('First');
    expect(result).toContain('Body 1');
    expect(result).toContain('Second');
    expect(result).toContain('Body 2');
    expect(result).not.toContain('<details');
  });

  it('falls back to "Details" for empty summary', () => {
    const input = '<details>\n<summary></summary>\nBody content\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('Details');
  });

  it('handles the real-world conversation case', () => {
    const input = `### Worth double-checking

<details>
<summary><strong>Holiday period (25\u201331 Dec)</strong> \u2014 Calendar shows "Company Holiday"</summary>

- **Dec 25 (Christmas)**: Calendar shows "Day in office"
- **Dec 26 (Boxing Day)**: Calendar shows "Company standup" only

</details>`;
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('```collapse\n');
    expect(result).toContain('Holiday period (25\u201331 Dec)');
    expect(result).not.toContain('<strong>');
    expect(result).toContain('- **Dec 25 (Christmas)**');
    expect(result).not.toContain('<details');
    expect(result).not.toContain('</details>');
  });

  it('does NOT convert <details> inside fenced code blocks', () => {
    const input = 'Here is an example:\n\n```html\n<details>\n<summary>Example</summary>\nBody\n</details>\n```';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('<details>');
    expect(result).toContain('<summary>Example</summary>');
    expect(result).not.toContain('```collapse');
  });

  it('handles <details> with extra attributes (class, id)', () => {
    const input = '<details class="info" id="section-1">\n<summary>With attributes</summary>\nBody content\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('```collapse\n');
    expect(result).toContain('With attributes');
    expect(result).not.toContain('<details');
  });

  it('handles <details class="x" open> with mixed attributes', () => {
    const input = '<details class="info" open>\n<summary>Open with class</summary>\nBody\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('```collapse-open\n');
    expect(result).toContain('Open with class');
  });

  it('handles <summary> with attributes', () => {
    const input = '<details>\n<summary class="title">Styled summary</summary>\nBody\n</details>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('Styled summary');
    expect(result).not.toContain('class=');
  });

  it('handles case-insensitive tags', () => {
    const input = '<DETAILS>\n<SUMMARY>Uppercase</SUMMARY>\nBody\n</DETAILS>';
    const result = convertHtmlDetailsToCollapse(input);
    expect(result).toContain('```collapse\n');
    expect(result).toContain('Uppercase');
    expect(result).not.toContain('<DETAILS');
  });
});

describe('encodeSpacesInMarkdownLinks', () => {
  it('encodes spaces in relative file path URLs', () => {
    const input = '[Spark Tab UX Audit](UX Audits/260212-The-Spark-Tab-UX-Audit.md)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('[Spark Tab UX Audit](UX%20Audits/260212-The-Spark-Tab-UX-Audit.md)');
  });

  it('encodes multiple spaces in a path', () => {
    const input = '[Doc](My Documents/Sub Folder/file name.md)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('[Doc](My%20Documents/Sub%20Folder/file%20name.md)');
  });

  it('does not modify links without spaces', () => {
    const input = '[Doc](docs/file.md)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('[Doc](docs/file.md)');
  });

  it('does not modify external URLs with spaces', () => {
    const input = '[Link](https://example.com/path with spaces)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('[Link](https://example.com/path with spaces)');
  });

  it('does not modify library:// URLs', () => {
    const input = '[Doc](library://My%20Documents/file.md)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('[Doc](library://My%20Documents/file.md)');
  });

  it('does not modify mailto: URLs', () => {
    const input = '[Email](mailto:user name@example.com)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('[Email](mailto:user name@example.com)');
  });

  it('does not touch code blocks', () => {
    const input = '```\n[Doc](UX Audits/file.md)\n```';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('```\n[Doc](UX Audits/file.md)\n```');
  });

  it('does not touch inline code', () => {
    const input = '`[Doc](UX Audits/file.md)`';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('`[Doc](UX Audits/file.md)`');
  });

  it('returns content unchanged when no markdown links present', () => {
    const input = 'Just some text without links.';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('Just some text without links.');
  });

  it('handles multiple links in same content', () => {
    const input = 'See [Doc A](UX Audits/a.md) and [Doc B](Research Reports/b.md)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('See [Doc A](UX%20Audits/a.md) and [Doc B](Research%20Reports/b.md)');
  });

  it('handles the real-world agent output case from the bug', () => {
    const input = '2. **Spark Tab UX Audit** ( [UX Audits/260212-The-Spark-Tab-UX-Audit.md](UX Audits/260212-The-Spark-Tab-UX-Audit.md) )';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('2. **Spark Tab UX Audit** ( [UX Audits/260212-The-Spark-Tab-UX-Audit.md](UX%20Audits/260212-The-Spark-Tab-UX-Audit.md) )');
  });

  it('encodes spaces in image link paths', () => {
    const input = '![screenshot](UX Audits/screenshot.png)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('![screenshot](UX%20Audits/screenshot.png)');
  });

  it('preserves link titles when encoding URL spaces', () => {
    const input = '[Doc](My Folder/file.md "My Title")';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('[Doc](My%20Folder/file.md "My Title")');
  });

  it('preserves link titles with single quotes', () => {
    const input = "[Doc](My Folder/file.md 'My Title')";
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe("[Doc](My%20Folder/file.md 'My Title')");
  });

  it('handles image links without spaces (no-op)', () => {
    const input = '![alt](docs/image.png)';
    const result = encodeSpacesInMarkdownLinks(input);
    expect(result).toBe('![alt](docs/image.png)');
  });
});

describe('Stage 1 — broken image fetch churn', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const cleanups: Array<() => void> = [];
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let restoreImage: (() => void) | null = null;

  beforeAll(async () => {
    await ensureInstrumentedMessageMarkdownModule();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockImageState();
    createMockWindowApi('api', {
      openUrl: vi.fn().mockResolvedValue(undefined),
      revealPath: vi.fn().mockResolvedValue(undefined),
    });
    createMockWindowApi('appApi', {
      openUrl: vi.fn().mockResolvedValue(undefined),
      revealPath: vi.fn().mockResolvedValue(undefined),
    });
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const RealImage = globalThis.Image;
    globalThis.Image = MockImage as unknown as typeof Image;
    restoreImage = () => {
      globalThis.Image = RealImage;
    };
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    restoreImage?.();
    restoreImage = null;
  });

  const getWarningCalls = (message: '[Renderer] AutoLoadImage in-flight failed' | '[Renderer] AutoLoadImage failed') =>
    consoleWarnSpy.mock.calls.filter(([firstArg]: [unknown, ...unknown[]]) => firstArg === message);

  it('T1 emits rebel://library/ image sources for backticked image paths with spaces', async () => {
    const {
      __TEST_ONLY_convertFilePathsToLinks: convertFilePathsToLinksForTesting,
    } = await ensureInstrumentedMessageMarkdownModule();
    const filePath = 'presentation image assets/t1 screenshot.png';
    const processed = encodeSpacesInMarkdownLinks(
      convertFilePathsToLinksForTesting(`See \`${filePath}\``, null),
    );

    expect(processed).toContain(`![](${formatLibraryUrl(filePath)})`);
    expect(processed).not.toContain(`![](${filePath.replace(/ /g, '%20')})`);
  });

  it('T1b skips auto-injecting an image when the same path already has a markdown image embed', async () => {
    const {
      __TEST_ONLY_convertFilePathsToLinks: convertFilePathsToLinksForTesting,
    } = await ensureInstrumentedMessageMarkdownModule();
    const filePath = 'Chief-of-Staff/generated-images/investor-pres.png';
    const input = `Simpler version: \`${filePath}\`\n\n![Simpler illustration](${filePath})`;
    const processed = convertFilePathsToLinksForTesting(input, null);

    // Backticked path becomes a normal link...
    expect(processed).toContain(`[${filePath}](${formatLibraryUrl(filePath)})`);
    // ...but no auto-injected `![](...)` placeholder/output, because the
    // original markdown already embeds the image.
    expect(processed).not.toContain('__INLINE_IMAGE_');
    expect(processed).not.toContain(`![](${formatLibraryUrl(filePath)})`);
    // The original explicit embed survives untouched.
    expect(processed).toContain(`![Simpler illustration](${filePath})`);
  });

  it('T1c still auto-injects an image when no explicit markdown image exists for the path', async () => {
    const {
      __TEST_ONLY_convertFilePathsToLinks: convertFilePathsToLinksForTesting,
    } = await ensureInstrumentedMessageMarkdownModule();
    const filePath = 'Chief-of-Staff/generated-images/investor-pres.png';
    const processed = convertFilePathsToLinksForTesting(`See \`${filePath}\``, null);

    expect(processed).toContain(`[${filePath}](${formatLibraryUrl(filePath)})`);
    expect(processed).toContain(`![](${formatLibraryUrl(filePath)})`);
  });

  it('T2 calls readFileBase64 with the decoded image path', async () => {
    const filePath = 'presentation image assets/t2 screenshot.png';
    const documentPath = '/docs/t2.md';
    const readFileBase64 = vi.fn().mockResolvedValue('Zm9v');
    createMockWindowApi('libraryApi', { readFileBase64 });

    const view = renderMessageMarkdown(`See \`${filePath}\``, { documentPath });
    cleanups.push(view.cleanup);

    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledWith({
      target: filePath,
      basePath: documentPath,
    });
  });

  it('T3 deduplicates concurrent mounts for the same image request', async () => {
    const filePath = 'presentation image assets/t3 screenshot.png';
    const documentPath = '/docs/t3.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });

    const view = renderMessageMarkdown(
      `First \`${filePath}\`\nSecond \`${filePath}\``,
      { documentPath },
    );
    cleanups.push(view.cleanup);

    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve('Zm9v');
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    const images = Array.from(view.container.querySelectorAll('img'));
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'data:image/png;base64,Zm9v',
      'data:image/png;base64,Zm9v',
    ]);
  });

  it('T4 keeps positive cache hits after success and retries after rejection', async () => {
    const successPath = 'presentation image assets/t4 success.png';
    const successDocumentPath = '/docs/t4-success.md';
    const successReadFileBase64 = vi.fn().mockResolvedValue('c3VjY2Vzcw==');
    createMockWindowApi('libraryApi', { readFileBase64: successReadFileBase64 });

    const successView = renderMessageMarkdown(`See \`${successPath}\``, {
      documentPath: successDocumentPath,
    });
    await flushImageWork();
    expect(successReadFileBase64).toHaveBeenCalledTimes(1);
    successView.cleanup();

    const remountedSuccessView = renderMessageMarkdown(`See \`${successPath}\``, {
      documentPath: successDocumentPath,
    });
    cleanups.push(remountedSuccessView.cleanup);
    await flushImageWork();
    expect(successReadFileBase64).toHaveBeenCalledTimes(1);

    const errorPath = 'presentation image assets/t4 error.png';
    const errorDocumentPath = '/docs/t4-error.md';
    const errorReadFileBase64 = vi.fn()
      .mockRejectedValueOnce(new Error('missing image'))
      .mockResolvedValueOnce('cmV0cnk=');
    createMockWindowApi('libraryApi', { readFileBase64: errorReadFileBase64 });

    const firstErrorView = renderMessageMarkdown(`See \`${errorPath}\``, {
      documentPath: errorDocumentPath,
    });
    await flushImageWork();
    expect(errorReadFileBase64).toHaveBeenCalledTimes(1);
    firstErrorView.cleanup();

    const secondErrorView = renderMessageMarkdown(`See \`${errorPath}\``, {
      documentPath: errorDocumentPath,
    });
    cleanups.push(secondErrorView.cleanup);
    await flushImageWork();
    expect(errorReadFileBase64).toHaveBeenCalledTimes(2);
  });

  it('T5 logs a renderer breadcrumb when image loading fails', async () => {
    const filePath = 'presentation image assets/t5 missing.png';
    const documentPath = '/docs/t5.md';
    const readFileBase64 = vi.fn().mockRejectedValue(new Error('missing image'));
    createMockWindowApi('libraryApi', { readFileBase64 });

    const view = renderMessageMarkdown(`See \`${filePath}\``, { documentPath });
    cleanups.push(view.cleanup);

    await flushImageWork();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Renderer] AutoLoadImage failed'),
      expect.objectContaining({
        filePath,
        documentPath,
        message: 'missing image',
      }),
    );
  });

  it('T14 resolves explicit markdown image syntax with decoded file paths', async () => {
    const filePath = 'my image.png';
    const documentPath = '/docs/t14.md';
    const readFileBase64 = vi.fn().mockResolvedValue('dDE0');
    createMockWindowApi('libraryApi', { readFileBase64 });

    const view = renderMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(view.cleanup);

    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledWith({
      target: filePath,
      basePath: documentPath,
    });
    expect(view.container.querySelector('img[src^="data:image/"]')).not.toBeNull();
  });

  it('T15 reuses the shared in-flight request for a late mount after IPC resolution', async () => {
    const filePath = 'presentation image assets/t15 shared.png';
    const documentPath = '/docs/t15.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });
    setMockImageMode('manual');

    const instrumentedModule = await ensureInstrumentedMessageMarkdownModule();
    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(firstView.cleanup);

    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve('dDE1');
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    expect(instrumentedModule.__TEST_ONLY_inFlightImageRequests.has(`${documentPath}::${filePath}`)).toBe(true);
    expect(getMockImageInstances()).toHaveLength(1);

    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(1);

    await act(async () => {
      getMockImageInstances()[0]?.triggerLoad();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    expect(firstView.container.querySelector('img[src="data:image/png;base64,dDE1"]')).not.toBeNull();
    expect(secondView.container.querySelector('img[src="data:image/png;base64,dDE1"]')).not.toBeNull();
  });

  it('T16 constructs only one Image per in-flight key', async () => {
    const filePath = 'presentation image assets/t16 shared.png';
    const documentPath = '/docs/t16.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });
    setMockImageMode('manual');

    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(firstView.cleanup);
    await flushImageWork();

    await act(async () => {
      deferred.resolve('dDE2');
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);
    await flushImageWork();

    expect(mockImageState.instantiationCount).toBe(1);
    expect(readFileBase64).toHaveBeenCalledTimes(1);

    await act(async () => {
      getMockImageInstances()[0]?.triggerLoad();
      await Promise.resolve();
    });
    await flushImageWork();
  });

  it('T17 logs decode failures once per owner/subscriber and retries on the next mount', async () => {
    const filePath = 'presentation image assets/t17 broken.png';
    const documentPath = '/docs/t17.md';
    const readFileBase64 = vi.fn().mockResolvedValue('dDE3');
    createMockWindowApi('libraryApi', { readFileBase64 });
    setMockImageMode('manual');

    const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(view.cleanup);

    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(getMockImageInstances()).toHaveLength(1);

    await act(async () => {
      getMockImageInstances()[0]?.triggerError();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    expect(view.container.textContent).toContain("Couldn't load the image.");
    expect(getWarningCalls('[Renderer] AutoLoadImage in-flight failed')).toHaveLength(1);
    expect(getWarningCalls('[Renderer] AutoLoadImage failed')).toHaveLength(1);
    expect(getWarningCalls('[Renderer] AutoLoadImage in-flight failed')[0]?.[1]).toEqual(
      expect.objectContaining({
        filePath,
        documentPath,
        message: 'Failed to decode image',
      }),
    );
    expect(getWarningCalls('[Renderer] AutoLoadImage failed')[0]?.[1]).toEqual(
      expect.objectContaining({
        filePath,
        documentPath,
        message: 'Failed to decode image',
      }),
    );

    const retryView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(retryView.cleanup);
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(2);
  });

  it('T18 warms the positive cache even if the sole subscriber unmounts before decode completes', async () => {
    const filePath = 'presentation image assets/t18 cache warm.png';
    const documentPath = '/docs/t18.md';
    const readFileBase64 = vi.fn().mockResolvedValue('dDE4');
    createMockWindowApi('libraryApi', { readFileBase64 });
    setMockImageMode('manual');

    const instrumentedModule = await ensureInstrumentedMessageMarkdownModule();
    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });

    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(instrumentedModule.__TEST_ONLY_getCachedImage(filePath)).toBeNull();

    firstView.cleanup();

    await act(async () => {
      getMockImageInstances()[0]?.triggerLoad();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    expect(instrumentedModule.__TEST_ONLY_getCachedImage(filePath)).toEqual(
      expect.objectContaining({
        dataUrl: 'data:image/png;base64,dDE4',
        dimensions: { width: 640, height: 480 },
      }),
    );

    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(secondView.container.querySelector('img[src="data:image/png;base64,dDE4"]')).not.toBeNull();
  });

  it('T19 logs owner and subscriber breadcrumbs correctly on IPC rejection with two subscribers', async () => {
    const filePath = 'presentation image assets/t19 missing.png';
    const documentPath = '/docs/t19.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });

    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(firstView.cleanup);
    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);

    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.reject(new Error('missing image'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    expect(firstView.container.textContent).toContain("Couldn't load the image.");
    expect(secondView.container.textContent).toContain("Couldn't load the image.");
    const ownerCalls = getWarningCalls('[Renderer] AutoLoadImage in-flight failed');
    const subscriberCalls = getWarningCalls('[Renderer] AutoLoadImage failed');
    expect(ownerCalls).toHaveLength(1);
    expect(subscriberCalls).toHaveLength(2);
    // Stage I12: lock the `code: 'unknown'` classification branch for
    // non-pipeline errors (generic Error, not ImagePipelineError).
    expect(ownerCalls[0]?.[1]).toEqual(
      expect.objectContaining({ code: 'unknown', timeoutMs: undefined }),
    );
    expect(subscriberCalls[0]?.[1]).toEqual(
      expect.objectContaining({ code: 'unknown', timeoutMs: undefined }),
    );
    // DI-C (2026-04-27): Sentry emit is scoped strictly to ipc-timeout. A
    // generic Error rejection (code:'unknown') MUST NOT produce a Sentry event.
    expect(captureRendererMessageMock).not.toHaveBeenCalled();
  });

  it('T20 times out stalled image decodes, clears the in-flight entry, and retries on remount', async () => {
    const filePath = 'presentation image assets/t20 timeout.png';
    const documentPath = '/docs/t20.md';
    const readFileBase64 = vi.fn().mockResolvedValue('dDIw');
    createMockWindowApi('libraryApi', { readFileBase64 });
    setMockImageMode('manual');

    const instrumentedModule = await ensureInstrumentedMessageMarkdownModule();
    vi.useFakeTimers();

    try {
      const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
      cleanups.push(view.cleanup);

      await flushImageWork();
      expect(readFileBase64).toHaveBeenCalledTimes(1);
      expect(instrumentedModule.__TEST_ONLY_inFlightImageRequests.has(`${documentPath}::${filePath}`)).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(instrumentedModule.__TEST_ONLY_IMAGE_DECODE_TIMEOUT_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      await flushImageWork();

      const expectedMessage = `Image decode timed out after ${instrumentedModule.__TEST_ONLY_IMAGE_DECODE_TIMEOUT_MS}ms`;
      expect(view.container.textContent).toContain(
        "Couldn't render that image. It might be unusually large or in a format I don't speak.",
      );
      expect(instrumentedModule.__TEST_ONLY_inFlightImageRequests.has(`${documentPath}::${filePath}`)).toBe(false);

      const ownerWarnings = getWarningCalls('[Renderer] AutoLoadImage in-flight failed');
      const subscriberWarnings = getWarningCalls('[Renderer] AutoLoadImage failed');
      expect(ownerWarnings).toHaveLength(1);
      expect(subscriberWarnings).toHaveLength(1);
      // Stage I12: lock the `code: 'decode-timeout'` classification + timeoutMs
      // on the already-shipped decode-timeout path so future refactors can't
      // silently drop the structured tagging.
      expect(ownerWarnings[0]?.[1]).toEqual(expect.objectContaining({
        message: expectedMessage,
        code: 'decode-timeout',
        timeoutMs: instrumentedModule.__TEST_ONLY_IMAGE_DECODE_TIMEOUT_MS,
      }));
      expect(subscriberWarnings[0]?.[1]).toEqual(expect.objectContaining({
        message: expectedMessage,
        code: 'decode-timeout',
        timeoutMs: instrumentedModule.__TEST_ONLY_IMAGE_DECODE_TIMEOUT_MS,
      }));
      // DI-C (2026-04-27): Sentry emit is scoped strictly to ipc-timeout. A
      // decode-timeout MUST NOT produce a Sentry event. If we ever want
      // decode-timeout telemetry we'll add a separate event with its own tag.
      expect(captureRendererMessageMock).not.toHaveBeenCalled();

      const retryView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
      cleanups.push(retryView.cleanup);
      await flushImageWork();

      expect(readFileBase64).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T20b keeps the remaining subscriber alive when another subscriber unmounts before decode completes', async () => {
    const filePath = 'presentation image assets/t20b shared.png';
    const documentPath = '/docs/t20b.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });
    setMockImageMode('manual');

    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);

    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve('dDIwYg==');
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    firstView.cleanup();

    await act(async () => {
      getMockImageInstances()[0]?.triggerLoad();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(secondView.container.querySelector('img[src="data:image/png;base64,dDIwYg=="]')).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Stage I12 — IPC timeout + late-settle observability (260423 plan)
  // --------------------------------------------------------------------------

  it('T21 times out a stalled IPC read and surfaces a recoverable error with friendlier user-facing copy', async () => {
    const filePath = 'presentation image assets/t21 ipc-hang.png';
    const documentPath = '/docs/t21.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });

    const instrumentedModule = await ensureInstrumentedMessageMarkdownModule();
    const ipcTimeoutMs = instrumentedModule.__TEST_ONLY_IMAGE_IPC_TIMEOUT_MS;
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.useFakeTimers();

    try {
      const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
      cleanups.push(view.cleanup);

      await flushImageWork();
      expect(readFileBase64).toHaveBeenCalledTimes(1);
      const key = `${documentPath}::${filePath}`;
      expect(instrumentedModule.__TEST_ONLY_inFlightImageRequests.has(key)).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ipcTimeoutMs + 1);
      });
      await flushImageWork();

      // DOM surfaces the friendlier copy (no raw milliseconds).
      expect(view.container.textContent).toContain("Couldn't reach the image. The connection timed out.");
      // In-flight map cleared — next subscribe rebuilds the shared promise.
      expect(instrumentedModule.__TEST_ONLY_inFlightImageRequests.has(key)).toBe(false);

      const ownerCalls = getWarningCalls('[Renderer] AutoLoadImage in-flight failed');
      const subscriberCalls = getWarningCalls('[Renderer] AutoLoadImage failed');
      expect(ownerCalls).toHaveLength(1);
      expect(subscriberCalls).toHaveLength(1);
      const expectedWarnPayload = expect.objectContaining({
        filePath,
        documentPath,
        message: `Image file read timed out after ${ipcTimeoutMs}ms`,
        code: 'ipc-timeout',
        timeoutMs: ipcTimeoutMs,
      });
      expect(ownerCalls[0]?.[1]).toEqual(expectedWarnPayload);
      expect(subscriberCalls[0]?.[1]).toEqual(expectedWarnPayload);

      // DI-C (2026-04-27): Sentry event fires exactly once with non-PII
      // extras (timeoutMs + derived fileExtension + hasDocumentPath).
      // Raw filePath / documentPath MUST NOT appear anywhere in the payload.
      expect(captureRendererMessageMock).toHaveBeenCalledTimes(1);
      const sentryArgs = captureRendererMessageMock.mock.calls[0];
      expect(sentryArgs?.[0]).toBe('AutoLoadImage IPC timeout');
      expect(sentryArgs?.[1]).toEqual(expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          source: 'AutoLoadImage',
          code: 'ipc-timeout',
        }),
        extra: expect.objectContaining({
          timeoutMs: ipcTimeoutMs,
          fileExtension: 'png',
          hasDocumentPath: true,
        }),
      }));
      // PII guard: extras must NOT include raw paths under any key.
      const extras = (sentryArgs?.[1] as { extra?: Record<string, unknown> } | undefined)?.extra ?? {};
      const extrasJson = JSON.stringify(extras);
      expect(extrasJson).not.toContain(filePath);
      expect(extrasJson).not.toContain(documentPath);

      // Remount the same image — fresh IPC call because the map was cleared.
      const retryView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
      cleanups.push(retryView.cleanup);
      await flushImageWork();
      expect(readFileBase64).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      consoleInfoSpy.mockRestore();
    }
  });

  it('T21a late IPC resolve after timeout is inert (no cache warm, one-shot info log)', async () => {
    const filePath = 'presentation image assets/t21a late-resolve.png';
    const documentPath = '/docs/t21a.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });

    const instrumentedModule = await ensureInstrumentedMessageMarkdownModule();
    const ipcTimeoutMs = instrumentedModule.__TEST_ONLY_IMAGE_IPC_TIMEOUT_MS;
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.useFakeTimers();

    try {
      const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
      cleanups.push(view.cleanup);

      await flushImageWork();
      // Fire the timeout.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ipcTimeoutMs + 1);
      });
      await flushImageWork();

      const warnCountBeforeLateResolve =
        getWarningCalls('[Renderer] AutoLoadImage in-flight failed').length
        + getWarningCalls('[Renderer] AutoLoadImage failed').length;

      // Now the underlying IPC eventually succeeds AFTER we've already
      // rejected the race. Should be inert on state; late-settle info fires.
      await act(async () => {
        deferred.resolve('bGF0ZS1yZXNvbHZl');
        await Promise.resolve();
        await Promise.resolve();
      });
      await flushImageWork();

      // No additional warn breadcrumb.
      const warnCountAfterLateResolve =
        getWarningCalls('[Renderer] AutoLoadImage in-flight failed').length
        + getWarningCalls('[Renderer] AutoLoadImage failed').length;
      expect(warnCountAfterLateResolve).toBe(warnCountBeforeLateResolve);

      // Positive cache NOT warmed — correctness: we reported failure to the user.
      expect(instrumentedModule.__TEST_ONLY_getCachedImage(filePath)).toBeNull();

      // DOM state unchanged — still the friendlier timeout copy.
      expect(view.container.textContent).toContain("Couldn't reach the image. The connection timed out.");

      // One-shot late-settle info log fired.
      const lateSuccessInfoCall = consoleInfoSpy.mock.calls.find(
        (call) => call[0] === '[Renderer] AutoLoadImage IPC late success (discarded after timeout)',
      );
      expect(lateSuccessInfoCall).toBeDefined();
      expect(lateSuccessInfoCall?.[1]).toEqual(expect.objectContaining({
        filePath,
        documentPath,
        code: 'ipc-late-success',
      }));
    } finally {
      vi.useRealTimers();
      consoleInfoSpy.mockRestore();
    }
  });

  it('T21b logs owner breadcrumb only when all subscribers unmount before IPC timeout fires', async () => {
    const filePath = 'presentation image assets/t21b orphan-timeout.png';
    const documentPath = '/docs/t21b.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });

    const instrumentedModule = await ensureInstrumentedMessageMarkdownModule();
    const ipcTimeoutMs = instrumentedModule.__TEST_ONLY_IMAGE_IPC_TIMEOUT_MS;
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.useFakeTimers();

    try {
      // Two subscribers on the same key. DO NOT push to `cleanups` — we call
      // cleanup manually; the outer afterEach loop is not idempotent.
      const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
      const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });

      await flushImageWork();
      expect(readFileBase64).toHaveBeenCalledTimes(1);

      // Unmount BOTH before the timer fires.
      firstView.cleanup();
      secondView.cleanup();

      // Now advance past the timeout.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ipcTimeoutMs + 1);
      });
      await flushImageWork();

      // Owner breadcrumb fires once with ipc-timeout classification.
      const ownerCalls = getWarningCalls('[Renderer] AutoLoadImage in-flight failed');
      expect(ownerCalls).toHaveLength(1);
      expect(ownerCalls[0]?.[1]).toEqual(expect.objectContaining({
        filePath,
        documentPath,
        code: 'ipc-timeout',
        timeoutMs: ipcTimeoutMs,
      }));

      // Subscriber breadcrumb CORRECTLY SUPPRESSED (both cancelled=true).
      expect(getWarningCalls('[Renderer] AutoLoadImage failed')).toHaveLength(0);

      // DI-C (2026-04-27): Sentry event fires exactly ONCE even with 2
      // subscribers — owner-only emission keeps the per-incident count
      // accurate and prevents the multi-subscriber inflation we'd see if
      // we emitted at the subscriber site instead.
      expect(captureRendererMessageMock).toHaveBeenCalledTimes(1);
      expect(captureRendererMessageMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        tags: expect.objectContaining({ code: 'ipc-timeout' }),
      }));

      // In-flight map cleaned up.
      const key = `${documentPath}::${filePath}`;
      expect(instrumentedModule.__TEST_ONLY_inFlightImageRequests.has(key)).toBe(false);
    } finally {
      vi.useRealTimers();
      consoleInfoSpy.mockRestore();
    }
  });

  it('T22 logs owner breadcrumb but suppresses subscriber breadcrumb when all subscribers unmount before rejection', async () => {
    const filePath = 'orphan dir/t22 orphaned.png';
    const documentPath = '/docs/t22.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });

    const instrumentedModule = await ensureInstrumentedMessageMarkdownModule();

    // Mount two subscribers on the same key. DO NOT push to `cleanups` — we
    // call cleanup manually below; outer afterEach is not idempotent.
    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });

    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    const key = `${documentPath}::${filePath}`;
    expect(instrumentedModule.__TEST_ONLY_inFlightImageRequests.has(key)).toBe(true);

    // Unmount BOTH subscribers while the shared promise is still pending.
    firstView.cleanup();
    secondView.cleanup();

    // Now reject with a plain Error — exercises the `code: 'unknown'` branch.
    await act(async () => {
      deferred.reject(new Error('simulated rejection'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    // Owner-of-flight breadcrumb fires exactly once with correct payload.
    const ownerCalls = getWarningCalls('[Renderer] AutoLoadImage in-flight failed');
    expect(ownerCalls).toHaveLength(1);
    expect(ownerCalls[0]?.[1]).toEqual(expect.objectContaining({
      filePath,
      documentPath,
      message: 'simulated rejection',
      code: 'unknown',
      timeoutMs: undefined,
    }));

    // Subscriber breadcrumb is CORRECTLY SUPPRESSED (both cancelled=true).
    expect(getWarningCalls('[Renderer] AutoLoadImage failed')).toHaveLength(0);

    // In-flight map cleaned up; cache NOT warmed by the failed path.
    expect(instrumentedModule.__TEST_ONLY_inFlightImageRequests.has(key)).toBe(false);
    expect(instrumentedModule.__TEST_ONLY_getCachedImage(filePath)).toBeNull();

    // DI-C (2026-04-27): Sentry emit is scoped strictly to ipc-timeout. An
    // orphaned rejection with code:'unknown' MUST NOT produce a Sentry event.
    expect(captureRendererMessageMock).not.toHaveBeenCalled();
  });

  it('T-WS-RENDER-1 classifies "Resolved path is outside the workspace directory." as workspace-escape', async () => {
    const filePath = 'ws-render/path-one.png';
    const documentPath = '/docs/ws-render-1.md';
    const readFileBase64 = vi
      .fn()
      .mockRejectedValue(new Error('Resolved path is outside the workspace directory.'));
    createMockWindowApi('libraryApi', { readFileBase64 });

    const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(view.cleanup);
    await flushImageWork();

    const ownerCalls = getWarningCalls('[Renderer] AutoLoadImage in-flight failed');
    const subscriberCalls = getWarningCalls('[Renderer] AutoLoadImage failed');
    expect(ownerCalls).toHaveLength(1);
    expect(ownerCalls[0]?.[1]).toEqual(expect.objectContaining({ code: 'workspace-escape' }));
    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]?.[1]).toEqual(expect.objectContaining({ code: 'workspace-escape' }));
  });

  it('T-WS-RENDER-2 classifies "Access to paths outside the workspace directory is not permitted." as workspace-escape', async () => {
    const filePath = 'ws-render/path-two.png';
    const documentPath = '/docs/ws-render-2.md';
    const readFileBase64 = vi
      .fn()
      .mockRejectedValue(new Error('Access to paths outside the workspace directory is not permitted.'));
    createMockWindowApi('libraryApi', { readFileBase64 });

    const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(view.cleanup);
    await flushImageWork();

    const ownerCalls = getWarningCalls('[Renderer] AutoLoadImage in-flight failed');
    const subscriberCalls = getWarningCalls('[Renderer] AutoLoadImage failed');
    expect(ownerCalls).toHaveLength(1);
    expect(ownerCalls[0]?.[1]).toEqual(expect.objectContaining({ code: 'workspace-escape' }));
    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]?.[1]).toEqual(expect.objectContaining({ code: 'workspace-escape' }));
  });

  it('T-WS-RENDER-3 emits a workspace-escape owner breadcrumb once per in-flight key', async () => {
    const filePath = 'ws-render/path-three.png';
    const documentPath = '/docs/ws-render-3.md';
    const deferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(deferred.promise);
    createMockWindowApi('libraryApi', { readFileBase64 });

    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(firstView.cleanup);
    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);

    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.reject(new Error('Resolved path is outside the workspace directory.'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    const ownerCalls = getWarningCalls('[Renderer] AutoLoadImage in-flight failed');
    const subscriberCalls = getWarningCalls('[Renderer] AutoLoadImage failed');
    expect(ownerCalls).toHaveLength(1);
    expect(ownerCalls[0]?.[1]).toEqual(expect.objectContaining({ code: 'workspace-escape' }));
    expect(subscriberCalls).toHaveLength(2);
    expect(subscriberCalls[0]?.[1]).toEqual(expect.objectContaining({ code: 'workspace-escape' }));
    expect(subscriberCalls[1]?.[1]).toEqual(expect.objectContaining({ code: 'workspace-escape' }));
  });

  it('T-WS-RENDER-4 captures Sentry only for ipc-timeout', async () => {
    const instrumentedModule = await ensureInstrumentedMessageMarkdownModule();

    createMockWindowApi('libraryApi', {
      readFileBase64: vi.fn().mockRejectedValue(new Error('Resolved path is outside the workspace directory.')),
    });
    const workspaceEscapeView = renderInstrumentedMessageMarkdown('![alt](ws-render/path-four-a.png)', {
      documentPath: '/docs/ws-render-4a.md',
    });
    cleanups.push(workspaceEscapeView.cleanup);
    await flushImageWork();
    expect(captureRendererMessageMock).not.toHaveBeenCalled();

    captureRendererMessageMock.mockClear();
    createMockWindowApi('libraryApi', {
      readFileBase64: vi.fn().mockRejectedValue(new Error('generic unknown failure')),
    });
    const unknownView = renderInstrumentedMessageMarkdown('![alt](ws-render/path-four-b.png)', {
      documentPath: '/docs/ws-render-4b.md',
    });
    cleanups.push(unknownView.cleanup);
    await flushImageWork();
    expect(captureRendererMessageMock).not.toHaveBeenCalled();

    captureRendererMessageMock.mockClear();
    createMockWindowApi('libraryApi', {
      readFileBase64: vi.fn().mockResolvedValue('d3MtcmVuZGVyLTQ='),
    });
    setMockImageMode('manual');
    vi.useFakeTimers();
    try {
      const decodeTimeoutView = renderInstrumentedMessageMarkdown('![alt](ws-render/path-four-c.png)', {
        documentPath: '/docs/ws-render-4c.md',
      });
      cleanups.push(decodeTimeoutView.cleanup);
      await flushImageWork();

      await act(async () => {
        vi.advanceTimersByTime(instrumentedModule.__TEST_ONLY_IMAGE_DECODE_TIMEOUT_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      await flushImageWork();

      expect(captureRendererMessageMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    captureRendererMessageMock.mockClear();
    const deferred = createDeferred<string>();
    createMockWindowApi('libraryApi', {
      readFileBase64: vi.fn().mockReturnValue(deferred.promise),
    });
    vi.useFakeTimers();
    try {
      const ipcTimeoutView = renderInstrumentedMessageMarkdown('![alt](ws-render/path-four-d.png)', {
        documentPath: '/docs/ws-render-4d.md',
      });
      cleanups.push(ipcTimeoutView.cleanup);
      await flushImageWork();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(instrumentedModule.__TEST_ONLY_IMAGE_IPC_TIMEOUT_MS + 1);
      });
      await flushImageWork();

      expect(captureRendererMessageMock).toHaveBeenCalledTimes(1);
      expect(captureRendererMessageMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        tags: expect.objectContaining({ code: 'ipc-timeout' }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('T-WS-RENDER-5 renders workspace-escape ImageError copy', () => {
    const view = renderImageError('workspace-escape');
    cleanups.push(view.cleanup);

    expect(view.container.textContent).toContain("That image link points outside your workspace, so I can't show it here.");
    expect(view.container.textContent).toContain("Ask me to save a copy in your workspace and I'll show it inline.");
  });

  it('T-WS-RENDER-6 renders reason-aware ImageError copy for ipc-timeout, decode-timeout, and unknown', () => {
    const expectations: Array<{ code: ImagePipelineErrorCode; title: string; helper: string }> = [
      {
        code: 'ipc-timeout',
        title: "Couldn't reach the image. The connection timed out.",
        helper: 'Try opening the image again, or reload the conversation.',
      },
      {
        code: 'decode-timeout',
        title: "Couldn't render that image. It might be unusually large or in a format I don't speak.",
        helper: 'Try opening it directly, or ask me to convert it to a standard format.',
      },
      {
        code: 'unknown',
        title: "Couldn't load the image.",
        helper: 'Open it directly to take a look.',
      },
    ];

    for (const expectation of expectations) {
      const view = renderImageError(expectation.code);
      cleanups.push(view.cleanup);
      expect(view.container.textContent).toContain(expectation.title);
      expect(view.container.textContent).toContain(expectation.helper);
    }
  });

  it('T-WS-RENDER-7 never renders the literal workspace_path token', () => {
    const codes: ImagePipelineErrorCode[] = [
      'workspace-escape',
      'ipc-timeout',
      'decode-timeout',
      'unknown',
    ];

    for (const code of codes) {
      const view = renderImageError(code);
      cleanups.push(view.cleanup);
      expect(view.container.textContent).not.toContain('workspace_path');
    }
  });
});

/**
 * Stale image cache freshness — when an agent overwrites a workspace image at
 * the same path, the next mount must observe the new bytes rather than the
 * cached pre-overwrite image. The fix combines:
 *   1) per-key generation tokens that cause in-flight shared promises to
 *      abandon their results on invalidation;
 *   2) a `library:stat-file` IPC probe on every cache hit that compares
 *      on-disk mtime against the cached mtime;
 *   3) a `library:changed` bridge that eagerly invalidates known paths;
 *   4) canonical path keys so `./foo.png` and `foo.png` map to the same entry.
 *
 * See docs-private/investigations/260519_stale_image_cache_after_agent_overwrite.md.
 */
describe('Stale image cache freshness (260519 fix)', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const cleanups: Array<() => void> = [];
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let restoreImage: (() => void) | null = null;
  let libraryChangedHandler: ((event: { changedPath?: string }) => void) | null = null;
  let instrumented: InstrumentedMessageMarkdownModule;

  beforeAll(async () => {
    instrumented = await ensureInstrumentedMessageMarkdownModule();
  });

  const makeReadFileBase64Result = (base64: string, mtimeMs: number, size: number) => ({
    base64,
    mtimeMs,
    size,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockImageState();
    libraryChangedHandler = null;
    instrumented.__resetImageLibraryChangedSubscriptionForTests();
    // Test-local imports operate on the original (non-instrumented) module; we
    // exercise the instrumented module to access cache internals, so keep
    // these aliases for readability while making sure all state lookups go
    // through the instrumented module.
    void __resetImageLibraryChangedSubscriptionForTests;
    void invalidateImageCacheEntry;
    void canonicalizeImagePath;
    createMockWindowApi('api', {
      openUrl: vi.fn().mockResolvedValue(undefined),
      revealPath: vi.fn().mockResolvedValue(undefined),
      onLibraryChanged: (cb: (event: { changedPath?: string }) => void) => {
        libraryChangedHandler = cb;
        return () => {
          libraryChangedHandler = null;
        };
      },
    });
    createMockWindowApi('appApi', {
      openUrl: vi.fn().mockResolvedValue(undefined),
      revealPath: vi.fn().mockResolvedValue(undefined),
    });
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const RealImage = globalThis.Image;
    globalThis.Image = MockImage as unknown as typeof Image;
    restoreImage = () => {
      globalThis.Image = RealImage;
    };
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    consoleInfoSpy?.mockRestore();
    restoreImage?.();
    restoreImage = null;
    libraryChangedHandler = null;
    instrumented.__resetImageLibraryChangedSubscriptionForTests();
  });

  it('T-FRESH-1 stat-on-mount probe invalidates cache when on-disk mtime is newer', async () => {
    const filePath = 'freshness/t-fresh-1.png';
    const documentPath = '/docs/t-fresh-1.md';
    const readFileBase64 = vi
      .fn()
      .mockResolvedValueOnce(makeReadFileBase64Result('aW1nQQ==', 1000, 10))
      .mockResolvedValueOnce(makeReadFileBase64Result('aW1nQg==', 2000, 12));
    // Cache-hit probe sees newer on-disk metadata and invalidates.
    const statFile = vi
      .fn()
      .mockResolvedValue({ exists: true, mtimeMs: 2000, size: 12 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    await flushImageWork();
    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).toEqual(
      expect.objectContaining({
        dataUrl: 'data:image/png;base64,aW1nQQ==',
        mtimeMs: 1000,
        size: 10,
      }),
    );
    firstView.cleanup();

    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);

    expect(secondView.container.querySelector('img[src="data:image/png;base64,aW1nQQ=="]')).not.toBeNull();

    await flushImageWork();
    await flushImageWork();
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(2);
    expect(secondView.container.querySelector('img[src="data:image/png;base64,aW1nQg=="]')).not.toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).toEqual(
      expect.objectContaining({ dataUrl: 'data:image/png;base64,aW1nQg==' }),
    );
  });

  it('T-FRESH-2 stat-on-mount probe leaves cache alone when mtime is unchanged', async () => {
    const filePath = 'freshness/t-fresh-2.png';
    const documentPath = '/docs/t-fresh-2.md';
    const readFileBase64 = vi.fn().mockResolvedValue(
      makeReadFileBase64Result('c2FtZQ==', 4242, 10),
    );
    const statFile = vi.fn().mockResolvedValue({ exists: true, mtimeMs: 4242, size: 10 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    await flushImageWork();
    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    firstView.cleanup();

    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);

    await flushImageWork();
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(secondView.container.querySelector('img[src="data:image/png;base64,c2FtZQ=="]')).not.toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).toEqual(
      expect.objectContaining({ dataUrl: 'data:image/png;base64,c2FtZQ==' }),
    );
  });

  it('T-FRESH-2b same-mtime size change invalidates cache and re-reads image bytes', async () => {
    const filePath = 'freshness/t-fresh-2b.png';
    const documentPath = '/docs/t-fresh-2b.md';
    const readFileBase64 = vi
      .fn()
      .mockResolvedValueOnce(makeReadFileBase64Result('b2xk', 7000, 10))
      .mockResolvedValueOnce(makeReadFileBase64Result('bmV3', 7000, 12));
    const statFile = vi.fn().mockResolvedValue({ exists: true, mtimeMs: 7000, size: 12 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    await flushImageWork();
    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    firstView.cleanup();

    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);
    await flushImageWork();
    await flushImageWork();
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(2);
    expect(secondView.container.querySelector('img[src="data:image/png;base64,bmV3"]')).not.toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).toEqual(
      expect.objectContaining({
        dataUrl: 'data:image/png;base64,bmV3',
        mtimeMs: 7000,
        size: 12,
      }),
    );
  });

  it('T-FRESH-3 library:changed event invalidates the cache entry for the changed path', async () => {
    const filePath = 'freshness/t-fresh-3.png';
    const documentPath = '/docs/t-fresh-3.md';
    const readFileBase64 = vi
      .fn()
      .mockResolvedValueOnce('Zmlyc3Q=')
      .mockResolvedValueOnce('c2Vjb25k');
    const statFile = vi.fn().mockResolvedValue({ exists: true, mtimeMs: 1000, size: 10 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(view.cleanup);
    await flushImageWork();
    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).not.toBeNull();
    expect(libraryChangedHandler).not.toBeNull();

    await act(async () => {
      libraryChangedHandler?.({ changedPath: filePath });
      await Promise.resolve();
    });
    await flushImageWork();
    await flushImageWork();
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('img[src="data:image/png;base64,c2Vjb25k"]')).not.toBeNull();
  });

  it('T-FRESH-4 in-flight result is dropped when invalidation fires mid-flight (generation guard)', async () => {
    const filePath = 'freshness/t-fresh-4.png';
    const documentPath = '/docs/t-fresh-4.md';
    const readDeferred = createDeferred<string>();
    const readFileBase64 = vi.fn().mockReturnValue(readDeferred.promise);
    const statFile = vi.fn().mockResolvedValue({ exists: true, mtimeMs: 1000, size: 10 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(instrumented.__TEST_ONLY_inFlightImageRequests.size).toBeGreaterThan(0);

    view.cleanup();

    instrumented.invalidateImageCacheEntry(filePath);
    expect(instrumented.__TEST_ONLY_inFlightImageRequests.has(`${documentPath}::${filePath}`)).toBe(false);

    await act(async () => {
      readDeferred.resolve('c3RhbGU=');
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).toBeNull();
  });

  it('T-FRESH-5 unrelated library:changed event leaves other cache entries intact', async () => {
    const pathA = 'freshness/t-fresh-5a.png';
    const pathB = 'freshness/t-fresh-5b.png';
    const otherPath = 'freshness/t-fresh-5-other.png';
    const documentPath = '/docs/t-fresh-5.md';

    const readFileBase64 = vi
      .fn()
      .mockImplementation(async (req: string | { target: string; basePath?: string }) => {
        const target = typeof req === 'string' ? req : req.target;
        if (target === pathA) return 'YQ==';
        if (target === pathB) return 'Yg==';
        return '';
      });
    const statFile = vi.fn().mockResolvedValue({ exists: true, mtimeMs: 1000, size: 10 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const view = renderInstrumentedMessageMarkdown(
      `![](${pathA})\n\n![](${pathB})`,
      { documentPath },
    );
    cleanups.push(view.cleanup);
    await flushImageWork();
    await flushImageWork();
    expect(instrumented.__TEST_ONLY_getCachedImage(pathA)).not.toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(pathB)).not.toBeNull();
    expect(libraryChangedHandler).not.toBeNull();

    await act(async () => {
      libraryChangedHandler?.({ changedPath: otherPath });
      await Promise.resolve();
    });
    await flushImageWork();

    expect(instrumented.__TEST_ONLY_getCachedImage(pathA)).not.toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(pathB)).not.toBeNull();
  });

  it('T-FRESH-6 canonical path keys collapse ./foo and foo to the same cache entry', async () => {
    const dottedPath = './freshness/t-fresh-6.png';
    const plainPath = 'freshness/t-fresh-6.png';
    const documentPath = '/docs/t-fresh-6.md';

    const readFileBase64 = vi.fn().mockResolvedValue('Zm9v');
    const statFile = vi.fn().mockResolvedValue({ exists: true, mtimeMs: 1000, size: 10 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    expect(instrumented.canonicalizeImagePath(dottedPath)).toBe(
      instrumented.canonicalizeImagePath(plainPath),
    );

    const view = renderInstrumentedMessageMarkdown(`![](${dottedPath})`, { documentPath });
    cleanups.push(view.cleanup);
    await flushImageWork();
    await flushImageWork();

    expect(instrumented.__TEST_ONLY_getCachedImage(dottedPath)).not.toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(plainPath)).not.toBeNull();

    instrumented.invalidateImageCacheEntry(plainPath);

    expect(instrumented.__TEST_ONLY_getCachedImage(dottedPath)).toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(plainPath)).toBeNull();
  });

  it('T-FRESH-7 stat-file IPC failure does not break the cached image render', async () => {
    const filePath = 'freshness/t-fresh-7.png';
    const documentPath = '/docs/t-fresh-7.md';

    const readFileBase64 = vi.fn().mockResolvedValue(
      makeReadFileBase64Result('Y2FjaGVk', 1000, 10),
    );
    const statFile = vi.fn()
      .mockResolvedValueOnce({ exists: true, mtimeMs: 1000, size: 10 })
      .mockRejectedValue(new Error('stat failed'));
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const firstView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    await flushImageWork();
    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    firstView.cleanup();

    const secondView = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(secondView.cleanup);

    expect(secondView.container.querySelector('img[src="data:image/png;base64,Y2FjaGVk"]')).not.toBeNull();

    await flushImageWork();
    await flushImageWork();

    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(secondView.container.querySelector('img[src="data:image/png;base64,Y2FjaGVk"]')).not.toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).toEqual(
      expect.objectContaining({ dataUrl: 'data:image/png;base64,Y2FjaGVk' }),
    );
  });

  it('T-FRESH-8 invalidation while shared promise is pending re-issues the IPC and renders the second result', async () => {
    const filePath = 'freshness/t-fresh-8.png';
    const documentPath = '/docs/t-fresh-8.md';
    // Two deferreds — first for the original (stale) shared promise, second
    // for the post-invalidation re-fetch. The fix's `forceRefreshCounter`
    // forces the fetch effect to re-run even though every other state value
    // already matched what `reset()` assigns.
    const firstDeferred = createDeferred<string>();
    const secondDeferred = createDeferred<string>();
    const calls: Array<() => void> = [
      () => firstDeferred.resolve('aW1nQQ=='),
      () => secondDeferred.resolve('aW1nQg=='),
    ];
    void calls;
    const readFileBase64 = vi
      .fn()
      .mockReturnValueOnce(firstDeferred.promise)
      .mockReturnValueOnce(secondDeferred.promise);
    const statFile = vi
      .fn()
      .mockResolvedValue({ exists: true, mtimeMs: 1000, size: 10 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    cleanups.push(view.cleanup);

    await flushImageWork();
    expect(readFileBase64).toHaveBeenCalledTimes(1);
    expect(instrumented.__TEST_ONLY_inFlightImageRequests.size).toBeGreaterThan(0);
    expect(libraryChangedHandler).not.toBeNull();

    // Fire library:changed while the first shared promise is still pending —
    // this triggers `invalidateImageCacheEntry` → reset() on the mounted
    // subscriber. Without forceRefreshCounter, all of reset()'s setState
    // calls would be no-ops (state already matches), the fetch effect
    // would not re-run, and the component would stay stuck.
    await act(async () => {
      libraryChangedHandler?.({ changedPath: filePath });
      await Promise.resolve();
    });
    await flushImageWork();

    // The fetch effect re-ran and issued a fresh IPC call.
    expect(readFileBase64).toHaveBeenCalledTimes(2);

    // Resolve the first (stale) shared promise — generation guard should
    // mark it stale and skip cache write + subscriber paint.
    await act(async () => {
      firstDeferred.resolve('aW1nQQ==');
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();

    // Resolve the second (fresh) shared promise — this is what should
    // actually land in component state.
    await act(async () => {
      secondDeferred.resolve('aW1nQg==');
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushImageWork();
    await flushImageWork();

    expect(view.container.querySelector('img[src="data:image/png;base64,aW1nQg=="]')).not.toBeNull();
    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).toEqual(
      expect.objectContaining({ dataUrl: 'data:image/png;base64,aW1nQg==' }),
    );
  });

  it('T-FRESH-MAP-CLEANUP mountedImageSubscribers map returns to baseline after mount/unmount cycle', async () => {
    const filePath = 'freshness/t-fresh-map-cleanup.png';
    const documentPath = '/docs/t-fresh-map-cleanup.md';
    const readFileBase64 = vi.fn().mockResolvedValue('Y2xlYW51cA==');
    const statFile = vi.fn().mockResolvedValue({ exists: true, mtimeMs: 1, size: 1 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const canonical = instrumented.canonicalizeImagePath(filePath);
    const baselineHasEntry = instrumented.__TEST_ONLY_mountedImageSubscribers.has(canonical);
    expect(baselineHasEntry).toBe(false);

    const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    await flushImageWork();

    const subs = instrumented.__TEST_ONLY_mountedImageSubscribers.get(canonical);
    expect(subs).toBeDefined();
    expect(subs?.size).toBe(1);

    view.cleanup();

    // Unmount cleanup must drop the empty Set entirely so unique-image-heavy
    // sessions don't accumulate per-path Map entries indefinitely.
    expect(instrumented.__TEST_ONLY_mountedImageSubscribers.has(canonical)).toBe(false);
  });

  it('T-FRESH-GEN-CLEANUP cacheGenerations entry is pruned once cache and subscribers are gone', async () => {
    const filePath = 'freshness/t-fresh-gen-cleanup.png';
    const documentPath = '/docs/t-fresh-gen-cleanup.md';
    const readFileBase64 = vi.fn().mockResolvedValue('Z2VuLWNsZWFudXA=');
    const statFile = vi.fn().mockResolvedValue({ exists: true, mtimeMs: 1, size: 1 });
    createMockWindowApi('libraryApi', { readFileBase64, statFile });

    const canonical = instrumented.canonicalizeImagePath(filePath);
    expect(instrumented.__TEST_ONLY_cacheGenerations.has(canonical)).toBe(false);

    const view = renderInstrumentedMessageMarkdown(`![alt](${filePath})`, { documentPath });
    await flushImageWork();
    await flushImageWork();

    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).not.toBeNull();

    view.cleanup();

    // While the cache entry exists, the gen token stays around (it could
    // still be matched by a future in-flight resolution).
    instrumented.invalidateImageCacheEntry(filePath);

    expect(instrumented.__TEST_ONLY_getCachedImage(filePath)).toBeNull();
    expect(instrumented.__TEST_ONLY_cacheGenerations.has(canonical)).toBe(false);
  });

  it('T-FRESH-FIFO-GEN-CLEANUP cacheGenerations entry is pruned when FIFO evicts the cache entry', () => {
    const targetPath = 'freshness/t-fresh-fifo-gen-target-unique.png';
    const targetCanonical = instrumented.canonicalizeImagePath(targetPath);

    // Pre-seed a generation token for the target — simulating the state
    // after an earlier invalidation that was blocked from pruning (because
    // subscribers or the cache entry were still alive at the time).
    instrumented.__TEST_ONLY_cacheGenerations.set(targetCanonical, 7);

    // Seed the target into the cache as the first entry.
    instrumented.__TEST_ONLY_saveToCache(
      targetPath,
      { width: 1, height: 1 },
      'data:target',
      1,
      1,
    );

    // Drive MAX_IMAGE_CACHE_ENTRIES more saveToCache calls with distinct
    // canonical paths. The first call after the cache hits the limit causes
    // FIFO eviction of the original target — which must now also prune its
    // cacheGenerations entry.
    for (let i = 0; i < 50; i++) {
      instrumented.__TEST_ONLY_saveToCache(
        `freshness/t-fresh-fifo-gen-other-${i}-unique.png`,
        { width: 1, height: 1 },
        `data:other-${i}`,
        1,
        1,
      );
    }

    expect(instrumented.__TEST_ONLY_getCachedImage(targetPath)).toBeNull();
    expect(instrumented.__TEST_ONLY_cacheGenerations.has(targetCanonical)).toBe(false);
  });

  it('T-FRESH-BYTE-CAP-1 keeps cache at or below 50MB after adding 51 ~1MB entries', () => {
    const ONE_MB = 1024 * 1024;
    const FIFTY_MB = 50 * ONE_MB;
    const dataUrlPrefix = 'data:image/png;base64,';
    // Intentionally 1MB payload + prefix so 50 entries would exceed 50MB
    // without byte-aware eviction.
    const oneMbPayload = 'a'.repeat(ONE_MB);
    const oneMbDataUrl = `${dataUrlPrefix}${oneMbPayload}`;
    const insertedPaths: string[] = [];

    for (let i = 0; i < 51; i += 1) {
      const path = `freshness/t-fresh-byte-cap-1-${i}.png`;
      insertedPaths.push(path);
      instrumented.__TEST_ONLY_saveToCache(
        path,
        { width: 1, height: 1 },
        oneMbDataUrl,
        i + 1,
        oneMbPayload.length,
      );
    }

    const stats = instrumented.__TEST_ONLY_getImageDataUrlCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(50);
    expect(stats.totalBytes).toBeLessThanOrEqual(FIFTY_MB);
    expect(stats.totalBytes).toBeLessThanOrEqual(stats.maxBytes);

    for (const path of insertedPaths) {
      instrumented.invalidateImageCacheEntry(path);
    }
  });

  it('T-FRESH-BYTE-CAP-2 rejects a single 60MB data URL cache entry', () => {
    const path = 'freshness/t-fresh-byte-cap-2-oversized.png';
    const SIXTY_MB = 60 * 1024 * 1024;
    const oversizedDataUrl = `data:image/png;base64,${'b'.repeat(SIXTY_MB)}`;

    instrumented.__TEST_ONLY_saveToCache(
      path,
      { width: 1, height: 1 },
      oversizedDataUrl,
      Date.now(),
      SIXTY_MB,
    );

    expect(instrumented.__TEST_ONLY_getCachedImage(path)).toBeNull();
    const stats = instrumented.__TEST_ONLY_getImageDataUrlCacheStats();
    expect(stats.totalBytes).toBeLessThanOrEqual(stats.maxBytes);
    instrumented.invalidateImageCacheEntry(path);
  });
});

/**
 * Stage 1 rendering sentinels — MessageMarkdown should emit rebel://space/
 * links for files inside shareable spaces and rebel://library/ links
 * otherwise. The module-level cache primes via `window.libraryApi.scanSpaces`,
 * and once that resolves we expect the next render to upgrade library URLs
 * to space URLs for shareable paths.
 *
 * See docs/plans/260418_finish_cross_surface_links_closeout.md — Stage 1.
 */
describe('Stage 1 — file link form (space vs library)', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // Use a unique coreDirectory per test so MessageMarkdown's module-level
  // cache (`_workspaceRootsCoreDir`) forces a fresh `scanSpaces` call each
  // time. Without this, state from the previous test leaks in.
  let testCounter = 0;
  let CORE = '';

  const mockAppApi = {
    openUrl: vi.fn().mockResolvedValue(undefined),
    revealPath: vi.fn().mockResolvedValue(undefined),
  };

  const cleanups: Array<() => void> = [];

  const makeSpace = (
    name: string,
    type: string,
    opts: { sharing?: string; absolutePath?: string; sourcePath?: string } = {},
  ) => ({
    name,
    path: name,
    absolutePath: opts.absolutePath ?? `${CORE}/${name}`,
    type,
    isSymlink: false,
    hasReadme: true,
    ...(opts.sharing !== undefined ? { sharing: opts.sharing } : {}),
    ...(opts.sourcePath !== undefined ? { sourcePath: opts.sourcePath } : {}),
    status: 'ok',
  });

  beforeEach(() => {
    __resetSpacesCacheForTests();
    vi.clearAllMocks();
    testCounter += 1;
    CORE = `/Users/me/core-${testCounter}`;
    createMockWindowApi('api', mockAppApi);
    createMockWindowApi('appApi', mockAppApi);
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    __resetSpacesCacheForTests();
  });

  // Helper: internal links have their `href` neutralised to "#"; the real
  // URL lives in `data-href` so click handlers can act on it.
  const hrefOf = (link: HTMLAnchorElement) => link.getAttribute('data-href') ?? link.getAttribute('href') ?? '';

  it('emits rebel://library/ links when spacesReady=false (first render before scan resolves)', async () => {
    // scanSpaces returns a never-resolving promise so spacesReady stays false.
    const neverResolving = new Promise(() => {});
    createMockWindowApi('libraryApi', {
      scanSpaces: vi.fn().mockReturnValue(neverResolving),
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderMessageMarkdown(
      '[Q1](Shared/Q1.md)',
      { coreDirectory: CORE, documentPath: `${CORE}/doc.md` },
    );
    cleanups.push(view.cleanup);

    const link = findLink(view.container, 'Q1.md');
    expect(hrefOf(link)).toContain('rebel://library/');
    expect(hrefOf(link)).not.toContain('rebel://space/');
  });

  it('emits rebel://space/ for files in a shareable space once scanSpaces resolves', async () => {
    const scanSpaces = vi.fn().mockResolvedValue({
      success: true,
      spaces: [makeSpace('Shared', 'team')],
    });
    createMockWindowApi('libraryApi', {
      scanSpaces,
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderMessageMarkdown(
      '[Q1](Shared/Q1.md)',
      { coreDirectory: CORE, documentPath: `${CORE}/doc.md` },
    );
    cleanups.push(view.cleanup);

    // Give the resolved promise a chance to flush through useSyncExternalStore.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const link = findLink(view.container, 'Q1.md');
    expect(link.querySelector('.markdown-link__scope-meta')?.textContent).toBe('Shared');
    expect(hrefOf(link)).toContain('rebel://space/Shared/');
  });

  it('emits rebel://library/ for files in a private (chief-of-staff) space', async () => {
    const scanSpaces = vi.fn().mockResolvedValue({
      success: true,
      spaces: [makeSpace('Chief-of-Staff', 'chief-of-staff')],
    });
    createMockWindowApi('libraryApi', {
      scanSpaces,
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderMessageMarkdown(
      '[Secret](Chief-of-Staff/diary.md)',
      { coreDirectory: CORE, documentPath: `${CORE}/doc.md` },
    );
    cleanups.push(view.cleanup);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const link = findLink(view.container, 'diary.md');
    const scopeMeta = link.querySelector('.markdown-link__scope-meta');
    expect(scopeMeta?.textContent).toBe('Private');
    expect(scopeMeta?.querySelector('.markdown-link__scope-icon svg')).not.toBeNull();
    expect(scopeMeta?.querySelector('.markdown-link__scope-separator')).not.toBeNull();
    expect(link.firstElementChild).toBe(scopeMeta);
    expect(link.getAttribute('data-full-path')).toBe('Chief-of-Staff/diary.md');
    const href = hrefOf(link);
    expect(href).toContain('rebel://library/');
    expect(href).not.toContain('rebel://space/');
  });

  it('emits rebel://space/ for backtick-wrapped paths in shareable spaces', async () => {
    const scanSpaces = vi.fn().mockResolvedValue({
      success: true,
      spaces: [makeSpace('Research', 'project')],
    });
    createMockWindowApi('libraryApi', {
      scanSpaces,
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderMessageMarkdown(
      'See `Research/report.md`',
      { coreDirectory: CORE, documentPath: `${CORE}/doc.md` },
    );
    cleanups.push(view.cleanup);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const link = findLink(view.container, 'report.md');
    expect(link.querySelector('.markdown-link__scope-meta')?.textContent).toBe('Research');
    expect(hrefOf(link)).toContain('rebel://space/Research/report.md');
  });

  it('links bare absolute paths that sit under a symlinked Space sourcePath', async () => {
    const scanSpaces = vi.fn().mockResolvedValue({
      success: true,
      spaces: [
        makeSpace('MyCloudSpace', 'project', {
          absolutePath: '/workspace/MyCloudSpace',
          sourcePath: '/Users/me/CloudDrive/Real',
        }),
      ],
    });
    createMockWindowApi('libraryApi', {
      scanSpaces,
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderMessageMarkdown(
      'See /Users/me/CloudDrive/Real/notes.md',
      { coreDirectory: '/workspace', documentPath: '/workspace/doc.md' },
    );
    cleanups.push(view.cleanup);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const link = findLink(view.container, 'notes.md');
    expect(link.querySelector('.markdown-link__scope-meta')?.textContent).toBe('MyCloudSpace');
    expect(hrefOf(link)).toContain('rebel://space/MyCloudSpace/notes.md');
  });

  it('emits rebel://space/...?type=folder for a trailing-slash wikilink folder reference', async () => {
    // Plan Must-fix #1 (260418): wikilinks ending with `/` are folder
    // references, not files. Before the fix, the preprocessor appended
    // `.md` and passed `'file'` to `toBestFileLink`, producing a bogus
    // `Exec/folder/.md` URL. The fix keeps the trailing slash and passes
    // `'folder'` so `toBestFileLink` emits `?type=folder`.
    const scanSpaces = vi.fn().mockResolvedValue({
      success: true,
      spaces: [makeSpace('Exec', 'team')],
    });
    createMockWindowApi('libraryApi', {
      scanSpaces,
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderMessageMarkdown(
      'Check [[Exec/memory/]]',
      { coreDirectory: CORE, documentPath: `${CORE}/doc.md` },
    );
    cleanups.push(view.cleanup);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const link = findLink(view.container, 'memory');
    const href = hrefOf(link);
    expect(href).toContain('rebel://space/Exec/memory');
    expect(href).toContain('?type=folder');
    // Regression guard: make sure we didn't append `.md` to a folder.
    expect(href).not.toContain('.md');
  });

  it('T1A.M1 does not leak old workspace spaces into markdown rendering after a workspace switch', async () => {
    const coreA = `${CORE}-A`;
    const coreB = `${CORE}-B`;
    const scanB = createDeferred<{ success: true; spaces: ReturnType<typeof makeSpace>[] }>();
    const scanSpaces = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        spaces: [{
          ...makeSpace('Shared', 'team'),
          absolutePath: `${coreA}/Shared`,
        }],
      })
      .mockReturnValueOnce(scanB.promise);
    createMockWindowApi('libraryApi', {
      scanSpaces,
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(() => {
      act(() => { root.unmount(); });
      container.remove();
    });

    await act(async () => {
      root.render(
        <MessageMarkdown
          content="[Q1](Shared/Q1.md)"
          coreDirectory={coreA}
          documentPath={`${coreA}/doc.md`}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(hrefOf(findLink(container, 'Q1.md'))).toContain('rebel://space/Shared/');

    act(() => {
      root.render(
        <MessageMarkdown
          content="[Q1](Shared/Q1.md)"
          coreDirectory={coreB}
          documentPath={`${coreB}/doc.md`}
        />,
      );
    });

    const hrefAfterSwitch = hrefOf(findLink(container, 'Q1.md'));
    expect(hrefAfterSwitch).toContain('rebel://library/');
    expect(hrefAfterSwitch).not.toContain('rebel://space/');
    expect(scanSpaces).toHaveBeenCalledTimes(2);
  });
});

describe('Stage 1 — scanSpaces failure paths', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let testCounter = 0;
  let CORE = '';
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  const cleanups: Array<() => void> = [];

  const mockAppApi = {
    openUrl: vi.fn().mockResolvedValue(undefined),
    revealPath: vi.fn().mockResolvedValue(undefined),
  };

  const hrefOf = (link: HTMLAnchorElement) => link.getAttribute('data-href') ?? link.getAttribute('href') ?? '';

  beforeAll(async () => {
    await ensureInstrumentedMessageMarkdownModule();
  });

  afterAll(async () => {
    await unlink(instrumentedMessageMarkdownPath).catch(() => undefined);
  });

  beforeEach(() => {
    __resetSpacesCacheForTests();
    vi.clearAllMocks();
    testCounter += 1;
    CORE = `/Users/me/error-path-core-${testCounter}`;
    createMockWindowApi('api', mockAppApi);
    createMockWindowApi('appApi', mockAppApi);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    consoleWarnSpy?.mockRestore();
    __resetSpacesCacheForTests();
  });

  it('marks spacesError=true and falls back to rebel://library/ when scanSpaces is unavailable', async () => {
    createMockWindowApi('libraryApi', {
      scanSpaces: undefined,
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderInstrumentedMessageMarkdown(
      '[Q1](Shared/Q1.md)',
      { coreDirectory: CORE, documentPath: `${CORE}/doc.md` },
    );
    cleanups.push(view.cleanup);

    await flushSpacesScan();

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      spacesError: true,
      spacesErrorMessage: 'libraryApi.scanSpaces unavailable',
    }));

    const link = findLink(view.container, 'Q1.md');
    expect(hrefOf(link)).toContain('rebel://library/');
    expect(hrefOf(link)).not.toContain('rebel://space/');
  });

  it('marks spacesError=true and falls back to rebel://library/ when scanSpaces returns success=false', async () => {
    createMockWindowApi('libraryApi', {
      scanSpaces: vi.fn().mockResolvedValue({ success: false, error: 'test-error' }),
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderInstrumentedMessageMarkdown(
      '[Q1](Shared/Q1.md)',
      { coreDirectory: CORE, documentPath: `${CORE}/doc.md` },
    );
    cleanups.push(view.cleanup);

    await flushSpacesScan();

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      spacesError: true,
      spacesErrorMessage: 'test-error',
    }));

    const link = findLink(view.container, 'Q1.md');
    expect(hrefOf(link)).toContain('rebel://library/');
    expect(hrefOf(link)).not.toContain('rebel://space/');
  });

  it('marks spacesError=true and falls back to rebel://library/ when scanSpaces rejects', async () => {
    createMockWindowApi('libraryApi', {
      scanSpaces: vi.fn().mockRejectedValue(new Error('network')),
      readFileBase64: vi.fn().mockResolvedValue(''),
    });

    const view = renderInstrumentedMessageMarkdown(
      '[Q1](Shared/Q1.md)',
      { coreDirectory: CORE, documentPath: `${CORE}/doc.md` },
    );
    cleanups.push(view.cleanup);

    await flushSpacesScan();

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      spacesError: true,
      spacesErrorMessage: 'network',
    }));

    const link = findLink(view.container, 'Q1.md');
    expect(hrefOf(link)).toContain('rebel://library/');
    expect(hrefOf(link)).not.toContain('rebel://space/');
  });
});

describe('I10 dangerous-scheme rejection', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let warnSpy: ReturnType<typeof vi.spyOn>;
  let readFileBase64: ReturnType<typeof vi.fn>;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    readFileBase64 = vi.fn().mockResolvedValue('Y29sbGFwc2U=');
    createMockWindowApi('api', {
      openUrl: vi.fn().mockResolvedValue(undefined),
      revealPath: vi.fn().mockResolvedValue(undefined),
    });
    createMockWindowApi('appApi', {
      openUrl: vi.fn().mockResolvedValue(undefined),
      revealPath: vi.fn().mockResolvedValue(undefined),
    });
    createMockWindowApi('libraryApi', { readFileBase64 });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    warnSpy.mockRestore();
  });

  const expectBlockedScheme = (scheme: 'javascript:' | 'blob:' | 'file:') => {
    expect(warnSpy).toHaveBeenCalledWith(
      '[Renderer] MessageMarkdown img blocked (dangerous scheme)',
      expect.objectContaining({
        scheme,
        src: expect.any(String),
      }),
    );
  };

  it('T-C.NEW.1 hides javascript: scheme img', () => {
    const view = renderMessageMarkdown('![xss](javascript:alert(1))');
    cleanups.push(view.cleanup);

    expect(view.container.querySelector('img[src^="javascript:"]')).toBeNull();
    expect(view.container.querySelector('img[hidden]')).not.toBeNull();
    expectBlockedScheme('javascript:');
    // Stage I9: stronger invariant — the scheme gate blocks BEFORE AutoLoadImage
    // mounts, so the IPC read is never issued. Locks a failure mode DOM
    // assertions alone would miss (a buggy refactor that mounts AutoLoadImage
    // alongside the hidden fallback would still satisfy the DOM check).
    expect(readFileBase64).not.toHaveBeenCalled();
  });

  it('T-C.NEW.2 hides blob: scheme img', () => {
    const view = renderMessageMarkdown('![xss](blob:http://example.com/abc)');
    cleanups.push(view.cleanup);

    expect(view.container.querySelector('img[src^="blob:"]')).toBeNull();
    expect(view.container.querySelector('img[hidden]')).not.toBeNull();
    expectBlockedScheme('blob:');
    expect(readFileBase64).not.toHaveBeenCalled();
  });

  it('T-C.NEW.3 hides file: scheme img', () => {
    const view = renderMessageMarkdown('![xss](file:///etc/passwd)');
    cleanups.push(view.cleanup);

    expect(view.container.querySelector('img[src^="file:"]')).toBeNull();
    expect(view.container.querySelector('img[hidden]')).not.toBeNull();
    expectBlockedScheme('file:');
    expect(readFileBase64).not.toHaveBeenCalled();
  });

  it('T-C.NEW.4 is case-insensitive (JavaScript:)', () => {
    const view = renderMessageMarkdown('![xss](JavaScript:alert(1))');
    cleanups.push(view.cleanup);

    expect(view.container.querySelector('img[src^="JavaScript:"]')).toBeNull();
    expect(view.container.querySelector('img[hidden]')).not.toBeNull();
    expectBlockedScheme('javascript:');
    expect(readFileBase64).not.toHaveBeenCalled();
  });

  it('T-C.NEW.5 handles leading whitespace (  javascript:)', () => {
    const view = renderMessageMarkdown('![xss](\tjavascript:alert(1))');
    cleanups.push(view.cleanup);

    expect(view.container.querySelector('img[src*="javascript:"]')).toBeNull();
    expect(view.container.querySelector('img[hidden]')).not.toBeNull();
    expectBlockedScheme('javascript:');
    expect(readFileBase64).not.toHaveBeenCalled();
  });

  it('T-C.NEW.6 redacts query strings in logs', () => {
    const view = renderMessageMarkdown('![xss](javascript:alert(1)?token=secret)');
    cleanups.push(view.cleanup);

    const blockedCall = warnSpy.mock.calls.find(
      ([message]: unknown[]) => message === '[Renderer] MessageMarkdown img blocked (dangerous scheme)',
    );
    expect(blockedCall).toBeDefined();
    const payload = blockedCall?.[1] as { scheme: string; src: string } | undefined;
    expect(payload).toEqual(expect.objectContaining({ scheme: 'javascript:' }));
    expect(payload?.src).not.toContain('secret');
    expect(readFileBase64).not.toHaveBeenCalled();
  });

  it('T-C.NEW.7 space-path inside collapse body renders img', async () => {
    const view = renderMessageMarkdown(
      '<details open>\n<summary>Section</summary>\n\n![alt](my image.png)\n</details>',
      { documentPath: '/docs/collapse.md' },
    );
    cleanups.push(view.cleanup);

    await flushImageWork();
    const collapsibleBody = view.container.querySelector('.markdown-collapsible__body');
    expect(collapsibleBody).not.toBeNull();
    expect(collapsibleBody?.textContent).not.toContain('![alt](my image.png)');
    expect(collapsibleBody?.querySelector('img, button')).not.toBeNull();

    if (readFileBase64.mock.calls.length > 0) {
      expect(readFileBase64).toHaveBeenCalledWith({
        target: 'my image.png',
        basePath: '/docs/collapse.md',
      });
    }
  });

  it('T-C.NEW.8 preserves data:image/png in collapsed body img', () => {
    // Build fixture programmatically to avoid secret-scanner false positives
    // on long base64 literals (safe placeholder body; scheme is what matters).
    const dataUrl = `data:image/png;base64,${'A'.repeat(32)}`;
    const view = renderMessageMarkdown(
      `<details open>\n<summary>Section</summary>\n\n![inline](${dataUrl})\n</details>`,
    );
    cleanups.push(view.cleanup);

    const collapsibleBody = view.container.querySelector('.markdown-collapsible__body');
    expect(collapsibleBody).not.toBeNull();
    const img = collapsibleBody?.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(dataUrl);
  });

  it('T-C.NEW.8a blanks data:text/html in collapsed body anchor', () => {
    const view = renderMessageMarkdown(
      '<details open>\n<summary>Section</summary>\n\n[click](data:text/html,<script>alert(1)</script>)\n</details>',
    );
    cleanups.push(view.cleanup);

    const collapsibleBody = view.container.querySelector('.markdown-collapsible__body');
    expect(collapsibleBody).not.toBeNull();
    const anchor = collapsibleBody?.querySelector('a');
    expect(anchor).not.toBeNull();
    // Defense-in-depth: data:text/html is not a safe collapsed-anchor scheme,
    // so render-time neutralization omits href before copy/middle-click paths
    // can observe it.
    expect(anchor?.getAttribute('href')).toBeNull();
  });

  it('T-C.NEW.8b preserves data:image/svg+xml in collapsed body img', () => {
    const svgDataUrl = `data:image/svg+xml;base64,${'B'.repeat(24)}`;
    const view = renderMessageMarkdown(
      `<details open>\n<summary>Section</summary>\n\n![svg](${svgDataUrl})\n</details>`,
    );
    cleanups.push(view.cleanup);

    const collapsibleBody = view.container.querySelector('.markdown-collapsible__body');
    const img = collapsibleBody?.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(svgDataUrl);
  });

  it('T-C.NEW.8c rejects malformed data:image without subtype', () => {
    // `data:image;base64,...` missing subtype — regex requires /^data:image\/[^;,]+/
    const malformed = `data:image;base64,${'C'.repeat(16)}`;
    const view = renderMessageMarkdown(
      `<details open>\n<summary>Section</summary>\n\n![malformed](${malformed})\n</details>`,
    );
    cleanups.push(view.cleanup);

    const collapsibleBody = view.container.querySelector('.markdown-collapsible__body');
    const img = collapsibleBody?.querySelector('img');
    // defaultUrlTransform blanks unknown schemes. react-markdown drops the
    // empty src prop, so React renders no `src` attribute. The important
    // safety invariant is that the malformed URL is NOT reflected in the DOM.
    const renderedSrc = img?.getAttribute('src');
    expect(renderedSrc).not.toBe(malformed);
    expect(renderedSrc ?? '').toBe('');
  });

  // Stage I9: close the scheme-gate symmetry gap. The collapsed body runs
  // through a DIFFERENT img renderer (DetailsInner, MessageMarkdown.tsx:1012)
  // than the main-body path covered by T-C.NEW.1–6. The safety invariant is
  // the same: a dangerous scheme must NEVER appear in the DOM and NEVER
  // trigger the IPC read.
  //
  // Defense-in-depth layering in the collapsed path:
  //   Layer 1: `collapsibleUrlTransform` calls `defaultUrlTransform` for any
  //     scheme not in the explicit allow-list (library://, rebel://, file://,
  //     data:image/*). react-markdown's default transform blanks
  //     javascript:/vbscript:/etc, so the img renderer sees `src === ''` and
  //     the dangerous href never enters the DOM.
  //   Layer 2: `findBlockedUrlScheme` inside the img renderer is the
  //     belt-and-braces backstop in case a future refactor bypasses layer 1.
  //
  // We lock layer 1 here by asserting (a) no DOM reflection and (b) no IPC
  // fetch. The T-C.NEW.1–6 main-body tests already lock layer 2 directly.
  it('T-C.NEW.9 blocks javascript: scheme img inside <details open> collapsed body', () => {
    const view = renderMessageMarkdown(
      '<details open>\n<summary>Section</summary>\n\n![xss](javascript:alert(1))\n</details>',
    );
    cleanups.push(view.cleanup);

    const collapsibleBody = view.container.querySelector('.markdown-collapsible__body');
    expect(collapsibleBody).not.toBeNull();

    // Safety invariant: the dangerous href never appears in the DOM.
    expect(collapsibleBody?.querySelector('img[src^="javascript:"]')).toBeNull();
    // And nothing in the collapsed body mounts an AutoLoadImage.
    expect(collapsibleBody?.querySelector('img[data-auto-load]')).toBeNull();

    // Safety invariant: the IPC read is never issued — the scheme is
    // rejected strictly upstream of AutoLoadImage mounting.
    expect(readFileBase64).not.toHaveBeenCalled();
  });
});
