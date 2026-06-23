// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';

const flowPanels = vi.hoisted(() => ({
  activeSurface: 'sessions',
  setActiveSurface: vi.fn(),
  flowHistoryOpen: false,
  setFlowHistoryOpen: vi.fn(),
  toggleFlowHistoryOpen: vi.fn(),
  collapseSidebarForLibraryEditor: vi.fn(),
  restoreSidebarFromLibraryEditor: vi.fn(),
  libraryEditorOpen: false,
  openInsightsDrawer: vi.fn(),
  navigateToLibraryLens: vi.fn(),
  openDocumentPreview: vi.fn(),
  closeDocumentPreview: vi.fn(),
  setDocumentPreviewOpener: vi.fn(),
  documentPreviewOpen: false,
  documentPreviewPath: null as string | null,
  documentPreviewGeneration: 0,
  approvalsDrawerOpen: false,
  openApprovalsDrawer: vi.fn(),
  closeApprovalsDrawer: vi.fn(),
  toggleApprovalsDrawer: vi.fn(),
}));

vi.mock('@renderer/features/atlas/components/AtlasCanvas', () => ({
  AtlasCanvas: () => null,
}));

vi.mock('@renderer/features/flow-panels/FlowPanelsProvider', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    FlowPanelsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useFlowPanels: () => flowPanels,
  };
});

vi.mock('@renderer/features/flow-panels/FlowPanelsShell', () => ({
  FlowPanelsShell: (props: { surfaces: Record<string, { content: ReactNode } | undefined> }) =>
    props.surfaces.sessions?.content ?? null,
}));

vi.mock('@renderer/features/agent-session/components/SessionSurfaceContent', () => ({
  SessionSurfaceContent: () => null,
}));

import { installPreloadBridges, mountApp } from './_harness/mountApp';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';

function installCompletedOnboardingBridges(): ReturnType<typeof installPreloadBridges> {
  return installPreloadBridges({
    settingsApi: {
      get: () =>
        Promise.resolve({
          onboardingCompleted: true,
          onboardingCompletedAt: Date.now(),
        }),
    },
    authApi: {
      getState: () =>
        Promise.resolve({ isAuthenticated: true, user: null, isLoading: false }),
    },
    appApi: {
      safeModeState: () => Promise.resolve({ isEnabled: false }),
    },
    errorRecoveryApi: {
      getState: () =>
        Promise.resolve({
          evaluationId: null,
          status: 'idle',
          errorCategory: null,
          evaluation: null,
          startedAt: null,
          quipIndex: 0,
        }),
    },
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setCurrentSessionForShortcut(sessionId: string): Promise<void> {
  await act(async () => {
    useSessionStore.setState({
      currentSessionId: sessionId,
      currentSessionDoneAt: null,
      autoDoneEnabled: false,
      autoDoneBySessionId: {},
      editingMessageId: null,
      showConversation: true,
    });
  });
  await flushEffects();
}

function dispatchModEnter(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  }));
}

describe('App Cmd/Ctrl+Enter auto-done shortcut', () => {
  let restoreBridges: (() => void) | null = null;
  let unmountApp: (() => void) | null = null;

  afterEach(() => {
    if (unmountApp) {
      unmountApp();
      unmountApp = null;
    }
    if (restoreBridges) {
      restoreBridges();
      restoreBridges = null;
    }
    useSessionStore.setState({
      currentSessionId: 'conversation-reset',
      currentSessionDoneAt: null,
      autoDoneEnabled: false,
      autoDoneBySessionId: {},
      editingMessageId: null,
      showConversation: false,
    });
    vi.clearAllMocks();
  });

  it('toggles auto-done for a normal current session', async () => {
    restoreBridges = installCompletedOnboardingBridges().restore;
    const { unmount, mountError } = mountApp();
    unmountApp = unmount;
    expect(mountError).toBeNull();

    const sessionId = 'conversation-shortcut';
    await setCurrentSessionForShortcut(sessionId);

    await act(async () => {
      dispatchModEnter();
    });

    expect(useSessionStore.getState().autoDoneBySessionId[sessionId]).toBe(true);
  });

  it('does not toggle auto-done for a background current session', async () => {
    restoreBridges = installCompletedOnboardingBridges().restore;
    const { unmount, mountError } = mountApp();
    unmountApp = unmount;
    expect(mountError).toBeNull();

    const sessionId = 'automation-source-capture--shortcut';
    await setCurrentSessionForShortcut(sessionId);

    await act(async () => {
      dispatchModEnter();
    });

    expect(useSessionStore.getState().autoDoneBySessionId[sessionId]).toBeUndefined();
    expect(useSessionStore.getState().autoDoneEnabled).toBe(false);
  });
});
