import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react';

import { normalizeDocumentPath } from '../document-editor/utils/normalizeDocumentPath';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { LibraryLens } from '../library/types/lens';

import { FLOW_SURFACES } from './constants';

export { FLOW_SURFACES };

export const FLOW_PANELS_STORAGE_KEY = 'flow-panels-state';

/**
 * Built-in flow surfaces derived from the canonical array.
 * Plugin surfaces use the branded `PluginSurfaceId` type.
 * `FlowSurface` is the union of both.
 */
export type BuiltInFlowSurface = (typeof FLOW_SURFACES)[number];
export type FlowSurface = BuiltInFlowSurface | import('../plugins/types').PluginSurfaceId;

type LibraryNavigationOptions = {
  spaceFilter?: string;
  folderPath?: string;
  expandIndexingPanel?: boolean;
  revealInTree?: boolean;
};

export type PendingLibraryNavigation = ({
  lens: Partial<LibraryLens>;
} & LibraryNavigationOptions) | null;

export const DEFAULT_INSIGHTS_DRAWER_WIDTH = 520;
export const MIN_INSIGHTS_DRAWER_WIDTH = 320;
export const MAX_INSIGHTS_DRAWER_WIDTH = 800;

// Document preview drawer dimensions - starts at ~50% of typical screen width
export const DEFAULT_DOCUMENT_PREVIEW_WIDTH = 720;
export const MIN_DOCUMENT_PREVIEW_WIDTH = 400;
export const MAX_DOCUMENT_PREVIEW_WIDTH = 1200;

// Approvals drawer — fixed width, participates in same right-column slot as insights/doc preview.
// Slightly wider than the original compact drawer so approval decisions can
// breathe without turning each request into a large detail card.
export const APPROVALS_DRAWER_WIDTH = 440;

export type FlowPanelsState = {
  history: boolean;
  surface: FlowSurface;
  insightsDrawerWidth?: number;
  documentPreviewWidth?: number;
};

type LegacyFlowPanelsState = Partial<FlowPanelsState> &
  Partial<{ tasks: boolean; automations: boolean; workspace: boolean }>; // backward compatibility for old shape

type DocumentPreviewOpener = (path: string) => Promise<boolean>;

type FlowPanelsContextValue = {
  activeSurface: FlowSurface;
  setActiveSurface: Dispatch<SetStateAction<FlowSurface>>;
  flowHistoryOpen: boolean;
  setFlowHistoryOpen: Dispatch<SetStateAction<boolean>>;
  toggleFlowHistoryOpen: () => void;
  /** Whether sidebar content should be visible (for animation orchestration) */
  sidebarContentVisible: boolean;
  // Insights drawer state
  insightsDrawerOpen: boolean;
  selectedInsightsTurnId: string | null;
  openInsightsDrawer: (turnId: string) => void;
  closeInsightsDrawer: () => void;
  setSelectedInsightsTurnId: Dispatch<SetStateAction<string | null>>;
  // Insights drawer width (resizable)
  insightsDrawerWidth: number;
  setInsightsDrawerWidth: Dispatch<SetStateAction<number>>;
  // Document preview drawer state
  documentPreviewOpen: boolean;
  documentPreviewPath: string | null;
  documentPreviewGeneration: number;
  openDocumentPreview: (filePath: string) => void;
  closeDocumentPreview: () => void;
  setDocumentPreviewOpener: (opener: DocumentPreviewOpener | null) => void;
  documentPreviewWidth: number;
  setDocumentPreviewWidth: Dispatch<SetStateAction<number>>;
  // Library editor state and sidebar auto-collapse
  libraryEditorOpen: boolean;
  collapseSidebarForLibraryEditor: (filePath?: string) => void;
  restoreSidebarFromLibraryEditor: () => void;
  // Approvals drawer state (shares right-column slot with insights/doc preview)
  approvalsDrawerOpen: boolean;
  openApprovalsDrawer: () => void;
  closeApprovalsDrawer: () => void;
  toggleApprovalsDrawer: () => void;
  // Cross-feature workspace navigation
  pendingLibraryNavigation: PendingLibraryNavigation;
  navigateToLibraryLens: (lens: Partial<LibraryLens>, options?: LibraryNavigationOptions) => void;
  clearPendingLibraryNavigation: () => void;
};

const DEFAULT_FLOW_PANELS_STATE: FlowPanelsState = {
  history: false,
  surface: 'home',
  insightsDrawerWidth: DEFAULT_INSIGHTS_DRAWER_WIDTH,
  documentPreviewWidth: DEFAULT_DOCUMENT_PREVIEW_WIDTH
};

const FlowPanelsContext = createContext<FlowPanelsContextValue | undefined>(undefined);

const isFlowSurface = (value: unknown): value is FlowSurface =>
  typeof value === 'string' &&
  (FLOW_SURFACES.includes(value as BuiltInFlowSurface) || value.startsWith('plugin:'));

export const readFlowPanelsState = (): FlowPanelsState => {
  if (typeof window === 'undefined') {
    return DEFAULT_FLOW_PANELS_STATE;
  }

  try {
    const stored = window.localStorage.getItem(FLOW_PANELS_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_FLOW_PANELS_STATE;
    }

    const parsed = JSON.parse(stored) as LegacyFlowPanelsState & { insightsDrawerWidth?: number; documentPreviewWidth?: number };
    let historyValue = typeof parsed.history === 'boolean' ? parsed.history : DEFAULT_FLOW_PANELS_STATE.history;

    // Force sidebar open when on Conversations tab - this is the expected default for conversations
    if (isFlowSurface(parsed.surface) && parsed.surface === 'sessions') {
      historyValue = true;
    }

    // Force sidebar closed when on Home or Focus tab - these surfaces want full width
    if (isFlowSurface(parsed.surface) && (parsed.surface === 'home' || parsed.surface === 'focus')) {
      historyValue = false;
    }

    // Clamp insightsDrawerWidth to valid range
    let drawerWidth = DEFAULT_INSIGHTS_DRAWER_WIDTH;
    if (typeof parsed.insightsDrawerWidth === 'number') {
      drawerWidth = Math.max(
        MIN_INSIGHTS_DRAWER_WIDTH,
        Math.min(MAX_INSIGHTS_DRAWER_WIDTH, parsed.insightsDrawerWidth)
      );
    }

    // Clamp documentPreviewWidth to valid range
    let docPreviewWidth = DEFAULT_DOCUMENT_PREVIEW_WIDTH;
    if (typeof parsed.documentPreviewWidth === 'number') {
      docPreviewWidth = Math.max(
        MIN_DOCUMENT_PREVIEW_WIDTH,
        Math.min(MAX_DOCUMENT_PREVIEW_WIDTH, parsed.documentPreviewWidth)
      );
    }

    if (isFlowSurface(parsed.surface)) {
      return {
        history: historyValue,
        surface: parsed.surface,
        insightsDrawerWidth: drawerWidth,
        documentPreviewWidth: docPreviewWidth
      } satisfies FlowPanelsState;
    }

    if (parsed.automations) {
      return { history: historyValue, surface: 'automations', insightsDrawerWidth: drawerWidth, documentPreviewWidth: docPreviewWidth } satisfies FlowPanelsState;
    }
    if (parsed.tasks) {
      return { history: historyValue, surface: 'tasks', insightsDrawerWidth: drawerWidth, documentPreviewWidth: docPreviewWidth } satisfies FlowPanelsState;
    }
    if (parsed.workspace) {
      return { history: historyValue, surface: 'library', insightsDrawerWidth: drawerWidth, documentPreviewWidth: docPreviewWidth } satisfies FlowPanelsState;
    }

    return {
      history: historyValue,
      surface: DEFAULT_FLOW_PANELS_STATE.surface,
      insightsDrawerWidth: drawerWidth,
      documentPreviewWidth: docPreviewWidth
    } satisfies FlowPanelsState;
  } catch {
    return DEFAULT_FLOW_PANELS_STATE;
  }
};

export const FlowPanelsProvider = ({ children }: { children: ReactNode }) => {
  const initialState = useMemo(() => readFlowPanelsState(), []);
  const [flowHistoryOpen, setFlowHistoryOpen] = useState<boolean>(initialState.history);
  const [activeSurfaceInternal, setActiveSurfaceInternal] = useState<FlowSurface>(initialState.surface);
  // Sidebar content visibility state - used for animation orchestration
  // When closing: content fades first, then grid collapses
  // When opening: grid expands first, then content fades in
  const [sidebarContentVisible, setSidebarContentVisible] = useState<boolean>(initialState.history);

  // Insights drawer state
  const [insightsDrawerOpen, setInsightsDrawerOpen] = useState(false);
  const [selectedInsightsTurnId, setSelectedInsightsTurnId] = useState<string | null>(null);
  const [insightsDrawerWidth, setInsightsDrawerWidth] = useState<number>(
    initialState.insightsDrawerWidth ?? DEFAULT_INSIGHTS_DRAWER_WIDTH
  );

  // Document preview drawer state — simplified: just open/path/generation.
  // Tab management is handled internally by UnifiedDocumentEditor.
  const [documentPreviewOpen, setDocumentPreviewOpen] = useState(false);
  const [documentPreviewPath, setDocumentPreviewPath] = useState<string | null>(null);
  const [documentPreviewGeneration, setDocumentPreviewGeneration] = useState(0);
  // Ref mirrors documentPreviewOpen for use inside stable callbacks (setActiveSurface)
  const documentPreviewOpenRef = useRef(false);
  useEffect(() => { documentPreviewOpenRef.current = documentPreviewOpen; }, [documentPreviewOpen]);
  const documentPreviewOpenerRef = useRef<DocumentPreviewOpener | null>(null);
  const documentPreviewRequestGenRef = useRef(0);

  const [documentPreviewWidth, setDocumentPreviewWidth] = useState<number>(
    initialState.documentPreviewWidth ?? DEFAULT_DOCUMENT_PREVIEW_WIDTH
  );

  // Approvals drawer state — shares right-column slot with insights/doc preview
  const [approvalsDrawerOpen, setApprovalsDrawerOpen] = useState(false);
  const sidebarStateBeforeApprovalsRef = useRef<boolean | null>(null);

  // Ref to store sidebar state before opening drawer (so we can restore it on close)
  const sidebarStateBeforeDrawerRef = useRef<boolean | null>(null);
  // Ref to store sidebar state before opening document preview (so we can restore it on close)
  const sidebarStateBeforeDocPreviewRef = useRef<boolean | null>(null);
  // Ref to store sidebar state before opening workspace (so we can restore it on close)
  const sidebarStateBeforeLibraryRef = useRef<boolean | null>(null);
  // Track previous surface to detect workspace transitions
  const previousSurfaceRef = useRef<FlowSurface>(initialState.surface);
  
  // Library editor open state - tracks whether editor panel is visible in Library
  const [libraryEditorOpen, setLibraryEditorOpen] = useState(false);
  // Tracks the file path currently open in the Library editor so we can transfer
  // it to the Document Preview Drawer when leaving the Library surface.
  const libraryEditorFilePathRef = useRef<string | null>(null);

  const cancelInFlightDocumentPreviewGate = useCallback(() => {
    documentPreviewRequestGenRef.current += 1;
  }, []);

  const setDocumentPreviewOpener = useCallback((opener: DocumentPreviewOpener | null) => {
    if (opener === null) {
      cancelInFlightDocumentPreviewGate();
    }
    documentPreviewOpenerRef.current = opener;
  }, [cancelInFlightDocumentPreviewGate]);

  const commitDocumentPreview = useCallback((path: string) => {
    setDocumentPreviewPath(path);
    setDocumentPreviewOpen(true);
    setDocumentPreviewGeneration(prev => prev + 1);
  }, []);

  const tryCommitDocumentPreview = useCallback(
    async (path: string, commit: (path: string) => void = commitDocumentPreview): Promise<boolean> => {
      const opener = documentPreviewOpenerRef.current;
      if (!opener) {
        commit(path);
        return true;
      }

      const requestGen = ++documentPreviewRequestGenRef.current;
      let ok = false;
      try {
        ok = await opener(path);
      } catch (err) {
        console.warn('[FlowPanels] preview opener threw', err);
      }

      if (requestGen !== documentPreviewRequestGenRef.current) {
        return false;
      }

      if (!ok) {
        return false;
      }

      commit(path);
      return true;
    },
    [commitDocumentPreview]
  );

  const setActiveSurface = useCallback<Dispatch<SetStateAction<FlowSurface>>>((value) => {
    setActiveSurfaceInternal((prev) => {
      const next = typeof value === 'function' ? (value as (prev: FlowSurface) => FlowSurface)(prev) : value;
      if (prev === next) return prev;

      if (prev === 'library' && next !== 'library') {
        cancelInFlightDocumentPreviewGate();
        const libraryFilePath = libraryEditorFilePathRef.current;
        setLibraryEditorOpen(false);
        libraryEditorFilePathRef.current = null;

        if (libraryFilePath) {
          // Transfer the Library editor file to the Document Preview Drawer.
          fireAndForget(tryCommitDocumentPreview(libraryFilePath, (committedPath) => {
            // Only set the doc preview sidebar ref if not already set — this preserves
            // the original sidebar state when a preview was already open before Library.
            if (sidebarStateBeforeDocPreviewRef.current === null) {
              sidebarStateBeforeDocPreviewRef.current = sidebarStateBeforeLibraryRef.current;
            }
            sidebarStateBeforeLibraryRef.current = null;
            // Sidebar stays collapsed (already collapsed for the library editor).

            // Close insights drawer if it happens to be open (they share right-side space)
            setInsightsDrawerOpen(false);
            setSelectedInsightsTurnId(null);
            if (sidebarStateBeforeDrawerRef.current !== null) {
              if (sidebarStateBeforeDocPreviewRef.current === null) {
                sidebarStateBeforeDocPreviewRef.current = sidebarStateBeforeDrawerRef.current;
              }
              sidebarStateBeforeDrawerRef.current = null;
            }

            if (!documentPreviewOpenRef.current) {
              const halfWidth = Math.floor(window.innerWidth * 0.5);
              setDocumentPreviewWidth(Math.max(
                MIN_DOCUMENT_PREVIEW_WIDTH,
                Math.min(MAX_DOCUMENT_PREVIEW_WIDTH, halfWidth)
              ));
            }
            commitDocumentPreview(committedPath);
          }), 'flowPanels/libraryToPreviewGate');
        } else if (sidebarStateBeforeLibraryRef.current !== null) {
          setFlowHistoryOpen(sidebarStateBeforeLibraryRef.current);
          setSidebarContentVisible(sidebarStateBeforeLibraryRef.current);
          sidebarStateBeforeLibraryRef.current = null;
        }
      }

      // Close sidebar when switching to Home or Focus — these surfaces want full width
      if ((next === 'home' || next === 'focus') && prev !== next) {
        setFlowHistoryOpen(false);
        setSidebarContentVisible(false);
      }

      previousSurfaceRef.current = next;
      return next;
    });
  }, [cancelInFlightDocumentPreviewGate, commitDocumentPreview, tryCommitDocumentPreview]);

  const toggleFlowHistoryOpen = useCallback(() => {
    // Toggle both states together - CSS handles the animation timing
    // Grid column changes instantly, but sidebar content and nozzle animate in parallel
    const nextOpen = !flowHistoryOpen;
    setFlowHistoryOpen(nextOpen);
    setSidebarContentVisible(nextOpen);
  }, [flowHistoryOpen]);

  const openInsightsDrawer = useCallback(
    (turnId: string) => {
      // If drawer is already open, just update the turn ID (don't re-collapse sidebar)
      if (insightsDrawerOpen) {
        setSelectedInsightsTurnId(turnId);
        return;
      }

      // AMD.2 (post-Stage-1 review fix): cancel any pending document-preview gate
      // BEFORE the drawer-mutex branches. A gate may be in-flight even when
      // documentPreviewOpen=false (the path commits only after editor.openDocument
      // resolves true), so the existing `else if (documentPreviewOpen)` branch
      // would miss it. Unconditional cancellation here is safe: when no gate is
      // pending it's a free no-op (just bumps the request gen).
      cancelInFlightDocumentPreviewGate();

      // Close approvals drawer if open, transferring its saved sidebar state
      if (approvalsDrawerOpen) {
        setApprovalsDrawerOpen(false);
        sidebarStateBeforeDrawerRef.current = sidebarStateBeforeApprovalsRef.current;
        sidebarStateBeforeApprovalsRef.current = null;
      } else if (documentPreviewOpen) {
        setDocumentPreviewOpen(false);
        setDocumentPreviewPath(null);
        sidebarStateBeforeDrawerRef.current = sidebarStateBeforeDocPreviewRef.current;
        sidebarStateBeforeDocPreviewRef.current = null;
      } else {
        // Store current sidebar state before collapsing
        sidebarStateBeforeDrawerRef.current = flowHistoryOpen;
      }

      // Collapse sidebar when opening drawer
      setFlowHistoryOpen(false);
      setSidebarContentVisible(false);
      setSelectedInsightsTurnId(turnId);
      setInsightsDrawerOpen(true);
    },
    [insightsDrawerOpen, approvalsDrawerOpen, documentPreviewOpen, flowHistoryOpen, cancelInFlightDocumentPreviewGate]
  );

  const closeInsightsDrawer = useCallback(() => {
    setInsightsDrawerOpen(false);
    setSelectedInsightsTurnId(null);
    // Restore sidebar to its previous state
    if (sidebarStateBeforeDrawerRef.current !== null) {
      setFlowHistoryOpen(sidebarStateBeforeDrawerRef.current);
      setSidebarContentVisible(sidebarStateBeforeDrawerRef.current);
      sidebarStateBeforeDrawerRef.current = null;
    }
  }, []);

  const openDocumentPreview = useCallback(
    (filePath: string) => {
      const normalizedPath = normalizeDocumentPath(filePath);

      // Close insights drawer if open (they share the same right-side space)
      if (insightsDrawerOpen) {
        setInsightsDrawerOpen(false);
        setSelectedInsightsTurnId(null);
        sidebarStateBeforeDocPreviewRef.current = sidebarStateBeforeDrawerRef.current;
        sidebarStateBeforeDrawerRef.current = null;
      }

      // Close approvals drawer if open (they share the same right-side space)
      if (approvalsDrawerOpen) {
        setApprovalsDrawerOpen(false);
        if (sidebarStateBeforeDocPreviewRef.current === null) {
          sidebarStateBeforeDocPreviewRef.current = sidebarStateBeforeApprovalsRef.current;
        }
        sidebarStateBeforeApprovalsRef.current = null;
      }

      if (!documentPreviewOpen) {
        // Calculate initial width as ~50% of window width, clamped to min/max
        const halfWidth = Math.floor(window.innerWidth * 0.5);
        const clampedWidth = Math.max(
          MIN_DOCUMENT_PREVIEW_WIDTH,
          Math.min(MAX_DOCUMENT_PREVIEW_WIDTH, halfWidth)
        );
        setDocumentPreviewWidth(clampedWidth);

        // Store current sidebar state before collapsing
        if (sidebarStateBeforeDocPreviewRef.current === null) {
          sidebarStateBeforeDocPreviewRef.current = flowHistoryOpen;
        }
        setFlowHistoryOpen(false);
        setSidebarContentVisible(false);
      }

      fireAndForget(tryCommitDocumentPreview(normalizedPath), 'flowPanels/openDocumentPreviewGate');
    },
    [documentPreviewOpen, insightsDrawerOpen, approvalsDrawerOpen, flowHistoryOpen, tryCommitDocumentPreview]
  );

  const closeDocumentPreview = useCallback(() => {
    cancelInFlightDocumentPreviewGate();
    setDocumentPreviewOpen(false);
    setDocumentPreviewPath(null);
    // Restore sidebar to its previous state
    if (sidebarStateBeforeDocPreviewRef.current !== null) {
      setFlowHistoryOpen(sidebarStateBeforeDocPreviewRef.current);
      setSidebarContentVisible(sidebarStateBeforeDocPreviewRef.current);
      sidebarStateBeforeDocPreviewRef.current = null;
    }
  }, [cancelInFlightDocumentPreviewGate]);

  // Collapse sidebar when file editor is opened in library (called from LibraryDrawer)
  const collapseSidebarForLibraryEditor = useCallback((filePath?: string) => {
    if (filePath) {
      libraryEditorFilePathRef.current = filePath;
    }
    // Only store state if we haven't already (prevents overwriting on subsequent file opens)
    if (sidebarStateBeforeLibraryRef.current === null) {
      sidebarStateBeforeLibraryRef.current = flowHistoryOpen;
    }
    setFlowHistoryOpen(false);
    setSidebarContentVisible(false);
    setLibraryEditorOpen(true);
  }, [flowHistoryOpen]);

  // Restore sidebar when editor is closed in library (called from LibraryDrawer)
  const restoreSidebarFromLibraryEditor = useCallback(() => {
    setLibraryEditorOpen(false);
    libraryEditorFilePathRef.current = null;
    if (sidebarStateBeforeLibraryRef.current !== null) {
      setFlowHistoryOpen(sidebarStateBeforeLibraryRef.current);
      setSidebarContentVisible(sidebarStateBeforeLibraryRef.current);
      sidebarStateBeforeLibraryRef.current = null;
    }
  }, []);

  // Approvals drawer — mutual exclusivity with insights/doc preview
  const openApprovalsDrawer = useCallback(() => {
    if (approvalsDrawerOpen) return;

    // AMD.2 (post-Stage-1 review fix): cancel any pending document-preview gate
    // BEFORE the drawer-mutex branches. See parallel comment in openInsightsDrawer.
    cancelInFlightDocumentPreviewGate();

    // Close insights drawer if open, transferring its saved sidebar state
    if (insightsDrawerOpen) {
      setInsightsDrawerOpen(false);
      setSelectedInsightsTurnId(null);
      sidebarStateBeforeApprovalsRef.current = sidebarStateBeforeDrawerRef.current;
      sidebarStateBeforeDrawerRef.current = null;
    }

    // Close document preview if open, transferring its saved sidebar state
    if (documentPreviewOpen) {
      setDocumentPreviewOpen(false);
      setDocumentPreviewPath(null);
      if (sidebarStateBeforeApprovalsRef.current === null) {
        sidebarStateBeforeApprovalsRef.current = sidebarStateBeforeDocPreviewRef.current;
      }
      sidebarStateBeforeDocPreviewRef.current = null;
    }

    // Store current sidebar state before collapsing (if not already transferred from another drawer)
    if (sidebarStateBeforeApprovalsRef.current === null) {
      sidebarStateBeforeApprovalsRef.current = flowHistoryOpen;
    }
    setFlowHistoryOpen(false);
    setSidebarContentVisible(false);
    setApprovalsDrawerOpen(true);
  }, [approvalsDrawerOpen, insightsDrawerOpen, documentPreviewOpen, flowHistoryOpen, cancelInFlightDocumentPreviewGate]);

  const closeApprovalsDrawer = useCallback(() => {
    setApprovalsDrawerOpen(false);
    if (sidebarStateBeforeApprovalsRef.current !== null) {
      setFlowHistoryOpen(sidebarStateBeforeApprovalsRef.current);
      setSidebarContentVisible(sidebarStateBeforeApprovalsRef.current);
      sidebarStateBeforeApprovalsRef.current = null;
    }
  }, []);

  const toggleApprovalsDrawer = useCallback(() => {
    if (approvalsDrawerOpen) {
      closeApprovalsDrawer();
    } else {
      openApprovalsDrawer();
    }
  }, [approvalsDrawerOpen, closeApprovalsDrawer, openApprovalsDrawer]);

  // Cross-feature library navigation
  const [pendingLibraryNavigation, setPendingLibraryNavigation] = useState<PendingLibraryNavigation>(null);

  const navigateToLibraryLens = useCallback((lens: Partial<LibraryLens>, options?: LibraryNavigationOptions) => {
    setPendingLibraryNavigation({ lens, ...options });
    setActiveSurface('library');
  }, [setActiveSurface]);

  const clearPendingLibraryNavigation = useCallback(() => {
    setPendingLibraryNavigation(null);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const nextState: FlowPanelsState = {
      history: flowHistoryOpen,
      surface: activeSurfaceInternal,
      insightsDrawerWidth,
      documentPreviewWidth
    };
    try {
      window.localStorage.setItem(FLOW_PANELS_STORAGE_KEY, JSON.stringify(nextState));
    } catch {
      // Ignore persistence issues
    }
  }, [activeSurfaceInternal, flowHistoryOpen, insightsDrawerWidth, documentPreviewWidth]);


  const value = useMemo<FlowPanelsContextValue>(
    () => ({
      activeSurface: activeSurfaceInternal,
      setActiveSurface,
      flowHistoryOpen,
      setFlowHistoryOpen,
      toggleFlowHistoryOpen,
      sidebarContentVisible,
      // Insights drawer
      insightsDrawerOpen,
      selectedInsightsTurnId,
      openInsightsDrawer,
      closeInsightsDrawer,
      setSelectedInsightsTurnId,
      // Insights drawer width
      insightsDrawerWidth,
      setInsightsDrawerWidth,
      // Document preview drawer
      documentPreviewOpen,
      documentPreviewPath,
      documentPreviewGeneration,
      openDocumentPreview,
      closeDocumentPreview,
      setDocumentPreviewOpener,
      documentPreviewWidth,
      setDocumentPreviewWidth,
      // Library editor state and sidebar auto-collapse
      libraryEditorOpen,
      collapseSidebarForLibraryEditor,
      restoreSidebarFromLibraryEditor,
      // Approvals drawer
      approvalsDrawerOpen,
      openApprovalsDrawer,
      closeApprovalsDrawer,
      toggleApprovalsDrawer,
      // Cross-feature library navigation
      pendingLibraryNavigation,
      navigateToLibraryLens,
      clearPendingLibraryNavigation
    }),
    [
      activeSurfaceInternal,
      flowHistoryOpen,
      sidebarContentVisible,
      setActiveSurface,
      toggleFlowHistoryOpen,
      insightsDrawerOpen,
      selectedInsightsTurnId,
      openInsightsDrawer,
      closeInsightsDrawer,
      insightsDrawerWidth,
      documentPreviewOpen,
      documentPreviewPath,
      documentPreviewGeneration,
      openDocumentPreview,
      closeDocumentPreview,
      setDocumentPreviewOpener,
      documentPreviewWidth,
      libraryEditorOpen,
      collapseSidebarForLibraryEditor,
      restoreSidebarFromLibraryEditor,
      approvalsDrawerOpen,
      openApprovalsDrawer,
      closeApprovalsDrawer,
      toggleApprovalsDrawer,
      pendingLibraryNavigation,
      navigateToLibraryLens,
      clearPendingLibraryNavigation
    ]
  );

  return <FlowPanelsContext.Provider value={value}>{children}</FlowPanelsContext.Provider>;
};

export const useFlowPanels = (): FlowPanelsContextValue => {
  const context = useContext(FlowPanelsContext);
  if (!context) {
    throw new Error('useFlowPanels must be used within a FlowPanelsProvider');
  }
  return context;
};
