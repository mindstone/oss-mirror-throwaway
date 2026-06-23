// @vitest-environment happy-dom
import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedDocumentEditorHandle } from '../UnifiedDocumentEditor';
import type { UnifiedDocumentEditorProps } from '../UnifiedDocumentEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fileIOMock = vi.hoisted(() => ({
  flush: vi.fn(),
  persistAnnotationsNow: vi.fn(),
  persistCurrentContentNow: vi.fn(),
  save: vi.fn(),
  handleAnnotationContentChange: vi.fn(),
  handleEditorBodyChange: vi.fn(),
  flushAnnotationWriteNow: vi.fn(),
  applyExternalCommittedContent: vi.fn(),
  prepareForExternalCommit: vi.fn(),
  cancelExternalCommit: vi.fn(),
  approvePending: vi.fn(),
  denyPending: vi.fn(),
  resolveConflict: vi.fn(),
  setIsEditing: vi.fn(),
  confirmSharedSkillDirectSave: vi.fn(),
  captureIntoContentRef: { current: null as ((content: string) => string) | null },
  setMediaState: vi.fn(),
}));

const flowPanelsState = vi.hoisted(() => ({
  activeSurface: 'library' as 'library' | 'sessions',
}));

vi.mock('@renderer/features/flow-panels/FlowPanelsProvider', () => ({
  useFlowPanels: () => flowPanelsState,
}));

 
vi.mock('../../hooks/useDocumentFileIO', () => ({
  useDocumentFileIO: () => ({
    loading: false,
    error: null,
    content: 'Base content',
    editContent: 'Base content',
    isEditing: true,
    isDirty: false,
    isSaving: false,
    justSaved: false,
    statusText: 'Saved',
    fileName: 'doc.md',
    absolutePath: null,
    relativePath: 'doc.md',
    fileCategory: 'text',
    isMarkdownFile: true,
    conflictState: null,
    pendingApproval: null,
    imageState: { loading: false, error: null, dataUrl: null },
    mediaState: { loading: false, error: null, objectUrl: null },
    sharedSkillSaveProtection: null,
    needsSharedSkillSaveConfirmation: false,
    ...fileIOMock,
  }),
}));

 
vi.mock('@renderer/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

 
vi.mock('@renderer/contexts/AppContext', () => ({
  useAppContextSafe: () => null,
}));

 
vi.mock('@renderer/components/ui', () => {
  const ReactLocal = require('react') as typeof import('react');
  return {
    Button: ReactLocal.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
      function MockButton({ children, ...rest }, ref) {
        return ReactLocal.createElement('button', { ...rest, ref }, children);
      },
    ),
    Tooltip: ({ children }: { children: React.ReactNode }) =>
      ReactLocal.createElement(ReactLocal.Fragment, null, children),
  };
});

 
vi.mock('../DocumentHeader', () => {
  const ReactLocal = require('react') as typeof import('react');
  return {
    DocumentHeader: (props: { onClose?: () => void }) =>
      ReactLocal.createElement(
        'button',
        { 'data-testid': 'document-close', onClick: props.onClose },
        'Close',
      ),
  };
});

 
vi.mock('../DocumentFooter', () => ({ DocumentFooter: () => null }));
 
vi.mock('../DocumentRenderers', () => ({ DocumentRenderers: () => null }));
 
vi.mock('../DocumentTabBar', () => ({ DocumentTabBar: () => null }));
 
vi.mock('../DocumentConflictBanner', () => ({ DocumentConflictBanner: () => null }));
 
vi.mock('../DocumentFindBar', () => ({ DocumentFindBar: () => null }));

 
vi.mock('@renderer/features/library/components/SkillHistoryPanel', () => ({
  SkillHistoryPanel: () => null,
}));

 
vi.mock('@renderer/features/library/components/GoToHeadingDialog', () => ({
  GoToHeadingDialog: () => null,
}));

 
vi.mock('@renderer/features/library/components/SkillCard', () => ({
  parseSkillContent: () => ({ isValid: false }),
}));

 
vi.mock('@renderer/features/library/hooks/useAnnotatedMarkdownEditor', () => ({
  useAnnotatedMarkdownEditor: () => ({
    content: { handleTipTapChange: vi.fn() },
    editor: { instance: null, ref: { current: null } },
    outline: { goToHeading: vi.fn() },
    annotations: {
      captureIntoContent: (content: string) => content,
      commitAnnotationBlock: vi.fn(),
      editing: false,
      selection: null,
      getEditorView: () => null,
      hasAnnotations: false,
      list: [],
      remove: vi.fn(),
      clearAll: vi.fn(),
      formatMessage: vi.fn(),
      formatDisplayMessage: vi.fn(),
      flushAnnotationWriteNow: vi.fn(),
    },
    selectionUi: { handleAddFromToolbar: vi.fn() },
  }),
}));

 
vi.mock('@renderer/features/library/hooks/useDocumentActions', () => ({
  useDocumentActions: () => ({
    breadcrumbSegments: [],
    enclosingFolderPath: null,
    exporting: null,
    copyFullPath: vi.fn(),
    copyRelativePath: vi.fn(),
    revealInFinder: vi.fn(),
    exportPdf: vi.fn(),
    exportDocx: vi.fn(),
    exportMarkdown: vi.fn(),
    openWithDefaultApp: vi.fn(),
  }),
}));

 
vi.mock('../../hooks/useMarkdownImageImport', () => ({
  useMarkdownImageImport: () => ({
    canImportImages: false,
    isImportingImage: false,
    fileInputProps: {},
    importFiles: vi.fn(),
  }),
}));

const { act: reactAct } = require('react') as typeof import('react');

import { UnifiedDocumentEditor } from '../UnifiedDocumentEditor';

type MountedEditor = {
  ref: React.RefObject<UnifiedDocumentEditorHandle | null>;
  container: HTMLDivElement;
  root: ReactDOMClient.Root;
  onClose: ReturnType<typeof vi.fn>;
  unmount: () => void;
};

function mountEditor(overrides: Partial<UnifiedDocumentEditorProps> = {}): MountedEditor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  const ref = React.createRef<UnifiedDocumentEditorHandle>();
  const onClose = vi.fn();

  reactAct(() => {
    root.render(
      <UnifiedDocumentEditor
        ref={ref}
        onClose={onClose}
        {...overrides}
      />,
    );
  });

  return {
    ref,
    container,
    root,
    onClose,
    unmount() {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await reactAct(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getCloseButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('[data-testid="document-close"]');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Document close button not found');
  }
  return button;
}

function focusEditorPanel(container: HTMLElement): void {
  const panel = container.querySelector('[data-testid="library-editor-panel"]');
  if (!(panel instanceof HTMLDivElement)) {
    throw new Error('Library editor panel not found');
  }
  reactAct(() => {
    panel.focus();
  });
}

function dispatchShortcut(init: KeyboardEventInit): void {
  reactAct(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

function dispatchShortcutFromTarget(target: EventTarget, init: KeyboardEventInit): void {
  reactAct(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

describe('UnifiedDocumentEditor flushThenAct consumer guard', () => {
  let mounted: MountedEditor | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    flowPanelsState.activeSurface = 'library';
    fileIOMock.flush.mockResolvedValue(undefined);
    fileIOMock.persistAnnotationsNow.mockResolvedValue(undefined);
    fileIOMock.persistCurrentContentNow.mockResolvedValue(undefined);
    fileIOMock.approvePending.mockResolvedValue(false);
    fileIOMock.denyPending.mockResolvedValue(false);
    (window as unknown as { skillHistoryApi: { getVersions: ReturnType<typeof vi.fn> } }).skillHistoryApi = {
      getVersions: vi.fn().mockResolvedValue({ success: false }),
    };
    (window as unknown as { appApi: { openPath: ReturnType<typeof vi.fn>; openUrl: ReturnType<typeof vi.fn> } }).appApi = {
      openPath: vi.fn().mockResolvedValue(undefined),
      openUrl: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  // -------------------------------------------------------------------------
  // T20: failed flush aborts the destructive action; successful flush runs it.
  // -------------------------------------------------------------------------
  it('does not call the close action when flush rejects, and calls it when flush resolves', async () => {
    mounted = mountEditor();
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc.md')).resolves.toBe(true);
    });
    await flushMicrotasks();
    expect(mounted.ref.current?.getOpenTabCount()).toBe(1);
    fileIOMock.flush.mockClear();

    fileIOMock.flush.mockRejectedValueOnce(new Error('flush failed'));
    reactAct(() => {
      getCloseButton(mounted!.container).click();
    });
    await flushMicrotasks();

    expect(fileIOMock.flush).toHaveBeenCalledTimes(1);
    expect(mounted.onClose).not.toHaveBeenCalled();

    fileIOMock.flush.mockResolvedValueOnce(undefined);
    reactAct(() => {
      getCloseButton(mounted!.container).click();
    });
    await flushMicrotasks();

    expect(fileIOMock.flush).toHaveBeenCalledTimes(2);
    expect(mounted.onClose).toHaveBeenCalledTimes(1);
  });

  it('restores chrome on Escape in reduced mode before close', async () => {
    const onRestoreChromeMode = vi.fn();
    mounted = mountEditor({ chromeMode: 'reduced', onRestoreChromeMode });
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc.md')).resolves.toBe(true);
    });
    await flushMicrotasks();

    focusEditorPanel(mounted.container);
    dispatchShortcut({ key: 'Escape' });
    await flushMicrotasks();

    expect(onRestoreChromeMode).toHaveBeenCalledTimes(1);
    expect(mounted.onClose).not.toHaveBeenCalled();
  });

  it('does not steal Escape from contentEditable targets while kiosk is wide', async () => {
    const onRestoreChromeMode = vi.fn();
    mounted = mountEditor({ editorKioskLevel: 'wide', onRestoreChromeMode });
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc.md')).resolves.toBe(true);
    });
    await flushMicrotasks();

    focusEditorPanel(mounted.container);
    const panel = mounted.container.querySelector('[data-testid="library-editor-panel"]');
    if (!(panel instanceof HTMLDivElement)) {
      throw new Error('Library editor panel not found');
    }

    const tiptapWrapper = document.createElement('div');
    tiptapWrapper.setAttribute('data-testid', 'tiptap-markdown-editor');
    const editableTarget = document.createElement('div');
    editableTarget.contentEditable = 'true';
    editableTarget.tabIndex = 0;
    editableTarget.setAttribute('data-testid', 'escape-target-contenteditable');
    tiptapWrapper.appendChild(editableTarget);
    panel.appendChild(tiptapWrapper);

    const targetEscapeSpy = vi.fn();
    editableTarget.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        targetEscapeSpy();
      }
    });

    reactAct(() => {
      editableTarget.focus();
    });
    dispatchShortcutFromTarget(editableTarget, { key: 'Escape' });
    await flushMicrotasks();

    expect(targetEscapeSpy).toHaveBeenCalledTimes(1);
    expect(onRestoreChromeMode).not.toHaveBeenCalled();
    expect(mounted.onClose).not.toHaveBeenCalled();
  });

  it('closes the editor on Escape in normal chrome mode without restoring chrome', async () => {
    const onRestoreChromeMode = vi.fn();
    mounted = mountEditor({ chromeMode: 'normal', onRestoreChromeMode });
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc.md')).resolves.toBe(true);
    });
    await flushMicrotasks();

    focusEditorPanel(mounted.container);
    dispatchShortcut({ key: 'Escape' });
    await flushMicrotasks();

    expect(mounted.onClose).toHaveBeenCalledTimes(1);
    expect(onRestoreChromeMode).not.toHaveBeenCalled();
  });

  it('handles Cmd/Ctrl+W by closing the active tab', async () => {
    mounted = mountEditor();
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc-a.md')).resolves.toBe(true);
      await expect(mounted!.ref.current!.openDocument('doc-b.md')).resolves.toBe(true);
    });
    await flushMicrotasks();
    expect(mounted.ref.current?.getOpenTabCount()).toBe(2);

    focusEditorPanel(mounted.container);
    dispatchShortcut({ key: 'w', metaKey: true });
    await flushMicrotasks();

    expect(mounted.ref.current?.getOpenTabCount()).toBe(1);
    expect(fileIOMock.flush).toHaveBeenCalled();
  });

  it('handles Cmd/Ctrl+1..9 by switching to the indexed tab', async () => {
    mounted = mountEditor();
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc-a.md')).resolves.toBe(true);
      await expect(mounted!.ref.current!.openDocument('doc-b.md')).resolves.toBe(true);
      await expect(mounted!.ref.current!.openDocument('doc-c.md')).resolves.toBe(true);
    });
    await flushMicrotasks();
    expect(mounted.ref.current?.getActiveDocumentPath()).toBe('doc-c.md');

    focusEditorPanel(mounted.container);
    dispatchShortcut({ key: '1', metaKey: true });
    await flushMicrotasks();
    expect(mounted.ref.current?.getActiveDocumentPath()).toBe('doc-a.md');

    dispatchShortcut({ key: '3', metaKey: true });
    await flushMicrotasks();
    expect(mounted.ref.current?.getActiveDocumentPath()).toBe('doc-c.md');
  });

  it('handles Cmd/Ctrl+P and Cmd/Ctrl+O by opening Quick Open', async () => {
    const onOpenQuickOpen = vi.fn();
    mounted = mountEditor({ onOpenQuickOpen });
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc.md')).resolves.toBe(true);
    });
    await flushMicrotasks();

    focusEditorPanel(mounted.container);
    dispatchShortcut({ key: 'p', metaKey: true });
    dispatchShortcut({ key: 'o', metaKey: true });

    expect(onOpenQuickOpen).toHaveBeenCalledTimes(2);
  });

  it('cycles kiosk with Cmd+\\ across surfaces and keeps Cmd+Shift+F as library-only alias', async () => {
    const onToggleKioskMode = vi.fn();
    mounted = mountEditor({ onToggleKioskMode });
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc.md')).resolves.toBe(true);
    });
    await flushMicrotasks();
    focusEditorPanel(mounted.container);

    flowPanelsState.activeSurface = 'sessions';
    reactAct(() => {
      mounted?.root.render(
        <UnifiedDocumentEditor
          ref={mounted?.ref}
          onClose={() => {}}
          onToggleKioskMode={onToggleKioskMode}
        />,
      );
    });
    await flushMicrotasks();
    focusEditorPanel(mounted.container);
    dispatchShortcut({ key: '\\', metaKey: true });
    dispatchShortcut({ key: 'f', metaKey: true, shiftKey: true });
    expect(onToggleKioskMode).toHaveBeenCalledTimes(1);

    flowPanelsState.activeSurface = 'library';
    reactAct(() => {
      mounted?.root.render(
        <UnifiedDocumentEditor
          ref={mounted?.ref}
          onClose={() => {}}
          onToggleKioskMode={onToggleKioskMode}
        />,
      );
    });
    await flushMicrotasks();
    focusEditorPanel(mounted.container);
    dispatchShortcut({ key: '\\', metaKey: true });
    dispatchShortcut({ key: 'f', metaKey: true, shiftKey: true });
    expect(onToggleKioskMode).toHaveBeenCalledTimes(3);
  });

  it('ignores key-repeat for kiosk shortcuts to prevent multi-step cycling', async () => {
    const onToggleKioskMode = vi.fn();
    mounted = mountEditor({ onToggleKioskMode });
    await reactAct(async () => {
      await expect(mounted!.ref.current!.openDocument('doc.md')).resolves.toBe(true);
    });
    await flushMicrotasks();
    focusEditorPanel(mounted.container);

    dispatchShortcut({ key: '\\', metaKey: true, repeat: true });
    dispatchShortcut({ key: '\\', metaKey: true });

    expect(onToggleKioskMode).toHaveBeenCalledTimes(1);
  });
});
