import { memo, useCallback, useMemo, useRef, useEffect, useLayoutEffect, useState, Fragment, type CSSProperties, type ReactNode } from 'react';
import { type ChromeMode, chromeInert } from './chromeMode';
import { Button, Tooltip, MaturityBadge, type MaturityLevel, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@renderer/components/ui';
import { Plug } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useHover,
  useDismiss,
  useRole,
  useInteractions,
  safePolygon,
  FloatingPortal
} from '@floating-ui/react';
import {
  type BuiltInFlowSurface,
  type FlowSurface,
  useFlowPanels,
  APPROVALS_DRAWER_WIDTH,
  MIN_INSIGHTS_DRAWER_WIDTH,
  MAX_INSIGHTS_DRAWER_WIDTH,
  MIN_DOCUMENT_PREVIEW_WIDTH,
  MAX_DOCUMENT_PREVIEW_WIDTH
} from './FlowPanelsProvider';
import { isBuiltInSurface } from '@renderer/features/plugins/types';
import { tracking } from '@renderer/src/tracking';
import {
  useSessionStore,
  selectCurrentSessionIsBusy,
} from '@renderer/features/agent-session/store/sessionStore';

const SESSIONS_PANEL_WIDTH = 340;

type SurfaceTab = {
  id: FlowSurface;
  label: string;
  badge?: number;
  icon?: LucideIcon;
  tooltip?: string;
  /** Optional maturity level (labs, early, beta) - displays badge next to label */
  maturity?: MaturityLevel;
  /** Dim the tab slightly (e.g., for experimental features) */
  dimmed?: boolean;
  /** Hide this tab behind the overflow menu */
  overflow?: boolean;
};

type FlowSurfaceConfig = {
  content: ReactNode;
  kind?: 'stage' | 'panel';
  bodyClassName?: string;
};

type FlowPanelsShellProps = {
  brand: ReactNode;
  headerCenter?: ReactNode;
  headerRight?: ReactNode;
  sidebar: ReactNode;
  surfaceTabs: SurfaceTab[];
  surfaces: Record<string, FlowSurfaceConfig | undefined>;
  showConversation: boolean;
  onSurfaceChange?: (surface: FlowSurface) => void;
  onToggleHistory?: () => void;
  sidebarLabel?: string;
  sidebarChromeRight?: ReactNode;
  /** Right drawer content (insights or document preview) */
  rightDrawer?: ReactNode;
  /** Approvals drawer content (mutually exclusive with rightDrawer) */
  approvalsDrawer?: ReactNode;
  /** Called when clicking Library tab while already on Library (to reset to opening state) */
  onLibraryReset?: () => void;
  /** Chrome display mode — 'reduced' dims sidebar, nav, header for focused experiences. */
  chromeMode?: ChromeMode;
  /** When true, shows manual "Continue to Rebel" button (Layer 2 fallback) */
  showOnboardingManualContinue?: boolean;
  /** Called when user clicks manual continue button */
  onOnboardingManualContinue?: () => void;
  /** When true, shows demo mode indicator in header */
  isDemoMode?: boolean;
  /** Called when user clicks exit demo mode */
  onExitDemoMode?: () => void;
  /** Called when user clicks restart demo mode */
  onRestartDemoMode?: () => void;
  /** True while exiting demo mode */
  isExitingDemoMode?: boolean;
  /** Optional banner rendered between the tab bar and the content panels */
  belowTabs?: ReactNode;
};

const defaultSurfaceConfig: FlowSurfaceConfig = {
  content: null,
  kind: 'panel'
};

type FlowSurfacePanelProps = {
  tabId: FlowSurface;
  slot: FlowSurfaceConfig;
  isActive: boolean;
};

const FlowSurfacePanel = memo(function FlowSurfacePanel({
  tabId,
  slot,
  isActive,
}: FlowSurfacePanelProps) {
  if (!slot.content) {
    return null;
  }

  const tabIdAttr = `flow-tab-${tabId}`;
  const panelId = `flow-panel-${tabId}`;

  if (slot.kind === 'stage' || tabId === 'sessions') {
    return (
      <div
        className={`flow-surface flow-surface--${tabId}`}
        data-active={isActive}
        role="tabpanel"
        aria-labelledby={tabIdAttr}
        aria-hidden={!isActive}
        id={panelId}
      >
        {tabId === 'sessions' || isActive ? slot.content : null}
      </div>
    );
  }

  const bodyClassName = ['flow-surface-panel__body', slot.bodyClassName || ''].filter(Boolean).join(' ').trim();

  return (
    <div
      className={`flow-surface flow-surface--${tabId}`}
      data-active={isActive}
      role="tabpanel"
      aria-labelledby={tabIdAttr}
      aria-hidden={!isActive}
      id={panelId}
    >
      <div className={`flow-surface-panel flow-surface-panel--${tabId}`} data-open="true">
        <div className={bodyClassName}>{isActive ? slot.content : null}</div>
      </div>
    </div>
  );
}, (prev, next) => {
  if (prev.tabId !== next.tabId) return false;
  // Hidden non-session surfaces intentionally unmount their heavy content; the
  // sessions surface stays mounted above because it owns scroll-sensitive state.
  // Ignore slot churn for inactive non-session panels until they become active.
  if (!prev.isActive && !next.isActive) return true;
  return prev.isActive === next.isActive && prev.slot === next.slot;
});

export const FlowPanelsShell = ({
  brand,
  headerCenter,
  headerRight,
  sidebar,
  surfaceTabs,
  surfaces,
  showConversation,
  onSurfaceChange,
  onToggleHistory,
  sidebarLabel = '',
  sidebarChromeRight,
  rightDrawer,
  approvalsDrawer,
  onLibraryReset,
  chromeMode = 'normal',
  showOnboardingManualContinue = false,
  onOnboardingManualContinue,
  isDemoMode = false,
  onExitDemoMode,
  onRestartDemoMode,
  isExitingDemoMode = false,
  belowTabs
}: FlowPanelsShellProps) => {
  const {
    activeSurface,
    setActiveSurface,
    flowHistoryOpen,
    toggleFlowHistoryOpen,
    sidebarContentVisible,
    insightsDrawerOpen,
    insightsDrawerWidth,
    setInsightsDrawerWidth,
    documentPreviewOpen,
    documentPreviewWidth,
    setDocumentPreviewWidth,
    libraryEditorOpen,
    approvalsDrawerOpen
  } = useFlowPanels();

  // Resize handle state
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const [isResizing, setIsResizing] = useState(false);

  // Overflow menu state
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  
  // Skip onboarding confirmation dialog state
  const [showSkipConfirmation, setShowSkipConfirmation] = useState(false);

  const { refs: overflowRefs, floatingStyles: overflowFloatingStyles, context: overflowContext } = useFloating({
    open: overflowMenuOpen,
    onOpenChange: setOverflowMenuOpen,
    placement: 'bottom-end',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate
  });
  const overflowHover = useHover(overflowContext, {
    delay: { open: 100, close: 200 },
    handleClose: safePolygon({ blockPointerEvents: true }),
  });
  const overflowClick = useClick(overflowContext);
  const overflowDismiss = useDismiss(overflowContext);
  const overflowRole = useRole(overflowContext, { role: 'menu' });
  const { getReferenceProps: getOverflowReferenceProps, getFloatingProps: getOverflowFloatingProps } = useInteractions([
    overflowHover,
    overflowClick,
    overflowDismiss,
    overflowRole
  ]);

  // Plugins always live behind a single "Plugins" dropdown, regardless of available
  // horizontal space. This keeps plugin discovery in one consistent place — the tab
  // bar stays stable as users add/remove plugins, and once you have more than one
  // plugin the dropdown is the only sensible affordance anyway. Inlining individual
  // plugin tabs created visual churn and split the mental model across two locations.
  const navRef = useRef<HTMLElement>(null);
  const allOverflowTabs = useMemo(() => surfaceTabs.filter(tab => tab.overflow), [surfaceTabs]);
  const builtInTabs = useMemo(() => surfaceTabs.filter(tab => !tab.overflow), [surfaceTabs]);

  // Responsive tab density: measure children widths vs container to detect overflow.
  // On every resize, compare total children width to available space.
  // De-escalation: when the container grows, reset to 'normal' and let
  // useLayoutEffect re-escalate before paint if normal tabs don't fit.
  const segmentRef = useRef<HTMLDivElement>(null);
  const [navTier, setNavTier] = useState<'normal' | 'compact' | 'scroll'>('normal');
  const lastNavWidthRef = useRef(0);

  const checkNavTier = useCallback(() => {
    const segmentEl = segmentRef.current;
    if (!segmentEl) return;

    // Measure total children width directly — robust across all flex/overflow combos
    const style = getComputedStyle(segmentEl);
    const paddingH = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const gap = parseFloat(style.gap) || 0;
    let childrenWidth = 0;
    for (let i = 0; i < segmentEl.children.length; i++) {
      if (i > 0) childrenWidth += gap;
      childrenWidth += (segmentEl.children[i] as HTMLElement).offsetWidth;
    }
    const available = segmentEl.clientWidth - paddingH;
    const isOverflowing = childrenWidth > available + 1;

    setNavTier(prev => {
      if (isOverflowing) {
        if (prev === 'normal') return 'compact';
        if (prev === 'compact') return 'scroll';
      }
      return prev;
    });
  }, []);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      const currentWidth = el.getBoundingClientRect().width;
      const prevWidth = lastNavWidthRef.current;
      lastNavWidthRef.current = currentWidth;

      if (prevWidth > 0 && currentWidth > prevWidth + 20) {
        // Container grew — reset to normal; useLayoutEffect will re-escalate if needed
        setNavTier('normal');
      } else {
        checkNavTier();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkNavTier]);

  // Plugins always render inside the "Plugins" overflow dropdown; built-in tabs
  // stay inline. (See note above on why we don't inline plugin tabs.)
  const visibleTabs = builtInTabs;
  const overflowTabs = allOverflowTabs;

  // Runs synchronously before paint when tier or visible tab count changes
  useLayoutEffect(checkNavTier, [navTier, visibleTabs.length, checkNavTier]);

  // NOTE: This callback is only invoked when the user explicitly clicks a surface tab.
  // The onSurfaceChange callback applies side effects like setShowConversation(true).
  // Programmatic callers of setActiveSurface() bypass this - they must manually apply
  // any needed side effects (e.g., showing the conversation pane, opening history).
  const handleSurfaceSelect = useCallback(
    (surface: FlowSurface) => {
      const previousSurface = activeSurface;
      
      // If clicking Library while already on Library, reset to opening state
      if (surface === 'library' && previousSurface === 'library') {
        onLibraryReset?.();
        return;
      }
      
      // Update UI immediately - defer everything else
      setActiveSurface(surface);
      
      // Auto-open/close sidebar and track analytics after UI update
      queueMicrotask(() => {
        // Auto-open conversation history sidebar when navigating to Conversations tab
        if (surface === 'sessions' && !flowHistoryOpen) {
          toggleFlowHistoryOpen();
        }
        // Auto-collapse when navigating AWAY from Conversations tab
        if (previousSurface === 'sessions' && surface !== 'sessions' && flowHistoryOpen) {
          toggleFlowHistoryOpen();
        }
        // Auto-collapse sidebar when navigating to Home or Focus (these surfaces want full width)
        if ((surface === 'home' || surface === 'focus') && flowHistoryOpen) {
          toggleFlowHistoryOpen();
        }
        onSurfaceChange?.(surface);
        
        // Track tab click for analytics (deferred to not block UI)
        // Only track built-in surfaces in analytics (plugin surfaces aren't in the schema)
        const builtInTabNameMap: Record<BuiltInFlowSurface, 'home' | 'focus' | 'conversations' | 'spark' | 'library' | 'automations' | 'inbox' | 'team' | 'settings'> = {
          home: 'home',
          focus: 'focus',
          sessions: 'conversations',
          usecases: 'spark',
          library: 'library',
          automations: 'automations',
          tasks: 'inbox',
          team: 'team',
          settings: 'settings'
        };
        if (isBuiltInSurface(surface)) {
          const previousTabName = previousSurface && isBuiltInSurface(previousSurface)
            ? builtInTabNameMap[previousSurface]
            : undefined;
          tracking.navigation.tabClicked(builtInTabNameMap[surface], previousTabName);
        }
      });
    },
    [activeSurface, onSurfaceChange, onLibraryReset, setActiveSurface, flowHistoryOpen, toggleFlowHistoryOpen]
  );

  const handleHistoryToggle = useCallback(() => {
    if (onToggleHistory) {
      onToggleHistory();
      return;
    }
    toggleFlowHistoryOpen();
  }, [onToggleHistory, toggleFlowHistoryOpen]);

  // Either insights, document preview, or approvals drawer can be open (mutually exclusive)
  const rightDrawerOpen = insightsDrawerOpen || documentPreviewOpen || approvalsDrawerOpen;
  const activeRightDrawerWidth = approvalsDrawerOpen
    ? APPROVALS_DRAWER_WIDTH
    : documentPreviewOpen
      ? documentPreviewWidth
      : insightsDrawerWidth;

  const appShellClassName = useMemo(
    () =>
      [
        'app-shell',
        'flow-mode',
        showConversation ? 'visible' : '',
        flowHistoryOpen ? 'app-shell--sessions-open' : '',
        rightDrawerOpen ? 'app-shell--insights-open' : '',
        libraryEditorOpen ? 'app-shell--library-editor-open' : '',
        'app-shell--focus-mode'
      ]
        .filter(Boolean)
        .join(' '),
    [flowHistoryOpen, showConversation, rightDrawerOpen, libraryEditorOpen]
  );

  const appShellStyle = useMemo(() => {
    const style: CSSProperties & Record<string, string> = {} as CSSProperties & Record<string, string>;
    style['--sessions-panel-width'] = flowHistoryOpen ? `${SESSIONS_PANEL_WIDTH}px` : '0px';
    style['--insights-drawer-width'] = rightDrawerOpen ? `${activeRightDrawerWidth}px` : '0px';
    return style;
  }, [flowHistoryOpen, rightDrawerOpen, activeRightDrawerWidth]);

  // Body-level [data-active-work] anchor for Stage 3's blur budget. Foreground-only
  // lens (R2-2): idle Conversation B keeps blur even while background Conversation A
  // streams. body is used so portal descendants (Dialog, Tooltip mounted on
  // document.body) inherit the attribute. Removed (not set to 'false') when idle so
  // CSS selectors don't have to special-case the falsy literal.
  //
  // Self-healing watchdog (Phase 8 close-out): if `selectCurrentSessionIsBusy`
  // stays true for >30 min the attribute is force-cleared, mirroring Stage 6's
  // BackgroundConsumerLatch degraded-mode contract. Symmetric robustness: if
  // some upstream signal leaks (turn never terminates, watcher never resolves),
  // the renderer recovers blur instead of holding the budget hostage forever.
  // Refusal to re-set on the same continuous busy window enforces zero-crossing
  // semantics — the attribute only re-arms after `isCurrentSessionBusy` returns
  // to false at least once.
  //
  // Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md
  //                 Stage 1 + Stage 3 + Phase 8 close-out.
  const isCurrentSessionBusy = useSessionStore(selectCurrentSessionIsBusy);
  const activeWorkForceClearedRef = useRef(false);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const body = document.body;
    if (!body) return;
    if (!isCurrentSessionBusy) {
      body.removeAttribute('data-active-work');
      activeWorkForceClearedRef.current = false;
      return;
    }
    if (activeWorkForceClearedRef.current) {
      // Watchdog fired during a previous busy run within this same continuous
      // window. Refuse to re-set — only a real idle transition re-arms.
      return;
    }
    body.setAttribute('data-active-work', 'true');
    const watchdogTimeoutMs = 30 * 60 * 1000;
    const timeoutId = window.setTimeout(() => {
      body.removeAttribute('data-active-work');
      activeWorkForceClearedRef.current = true;
      // Renderer-side structured warn (captured under [Renderer] in main logs)
      // mirrors Stage 6 R2-7 format: reason + watchdogTimeoutMs are required
      // fields so monitoring can correlate active-work leaks across stages.
      console.warn(
        '[Stage 3 self-healing] data-active-work attribute force-cleared after watchdog timeout',
        {
          reason: 'leaked_active_work_signal',
          watchdogTimeoutMs,
          stage: 'stage_3_blur_budget',
        },
      );
    }, watchdogTimeoutMs);
    return () => {
      window.clearTimeout(timeoutId);
      body.removeAttribute('data-active-work');
    };
  }, [isCurrentSessionBusy]);

  // Handle resize drag - supports both insights and document preview drawers
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = activeRightDrawerWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [activeRightDrawerWidth]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      // Dragging left (decreasing X) should increase width (drawer is on right)
      const deltaX = startXRef.current - e.clientX;
      
      // Use appropriate min/max based on which drawer is open
      const minWidth = documentPreviewOpen ? MIN_DOCUMENT_PREVIEW_WIDTH : MIN_INSIGHTS_DRAWER_WIDTH;
      const maxWidth = documentPreviewOpen ? MAX_DOCUMENT_PREVIEW_WIDTH : MAX_INSIGHTS_DRAWER_WIDTH;
      const setWidth = documentPreviewOpen ? setDocumentPreviewWidth : setInsightsDrawerWidth;
      
      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + deltaX));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        setIsResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [documentPreviewOpen, setInsightsDrawerWidth, setDocumentPreviewWidth]);

  const renderSurface = useCallback(
    (tab: SurfaceTab) => {
      const slot = surfaces[tab.id] ?? defaultSurfaceConfig;
      return (
        <FlowSurfacePanel
          key={tab.id}
          tabId={tab.id}
          slot={slot}
          isActive={activeSurface === tab.id}
        />
      );
    },
    [activeSurface, surfaces]
  );

  return (
    <div
      className={appShellClassName}
      style={appShellStyle}
      data-chrome-mode={chromeMode !== 'normal' ? chromeMode : undefined}
      data-demo-mode={isDemoMode}
      data-active-work={isCurrentSessionBusy ? 'true' : undefined}
    >
      <header className="app-header" data-demo-mode={isDemoMode}>
        <div className="header-left">
          <div className="brand-cluster">{brand}</div>
          {isDemoMode && (
            <div className="demo-mode-indicator">
              <span className="demo-mode-indicator__icon">🎭</span>
              <span className="demo-mode-indicator__text">Demo Mode</span>
            </div>
          )}
        </div>
        {headerCenter ? <div className="header-center" inert={chromeInert(chromeMode)}>{headerCenter}</div> : null}
        <div className="header-actions" inert={chromeInert(chromeMode)}>
          {isDemoMode && onRestartDemoMode && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRestartDemoMode}
              disabled={isExitingDemoMode}
              className="demo-mode-exit-button"
            >
              Restart Demo
            </Button>
          )}
          {isDemoMode && onExitDemoMode && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onExitDemoMode}
              disabled={isExitingDemoMode}
              className="demo-mode-exit-button"
            >
              {isExitingDemoMode ? 'Exiting...' : 'Exit Demo'}
            </Button>
          )}
          {headerRight}
        </div>
        {/* Layer 2 fallback: Later button during onboarding coach */}
        {showOnboardingManualContinue && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSkipConfirmation(true)}
            className="onboarding-skip-button"
          >
            Later
          </Button>
        )}
      </header>
      <div className="flow-body">
        <aside
          className="flow-column flow-column--sessions"
          data-tour="sidebar-sessions"
          data-open={flowHistoryOpen}
          data-content-visible={sidebarContentVisible}
          aria-hidden={!flowHistoryOpen}
          inert={chromeInert(chromeMode)}
        >
          {(sidebarLabel || sidebarChromeRight) && (
            <div className="flow-column__chrome flow-column__chrome--sessions">
              {sidebarLabel && <span className="flow-column__title">{sidebarLabel}</span>}
              {sidebarChromeRight ? <div>{sidebarChromeRight}</div> : null}
            </div>
          )}
          {sidebar}
          {/* Toggle button positioned on the glass panel edge */}
          <Tooltip content={flowHistoryOpen ? 'Collapse history' : 'Show history'}>
            <button
              type="button"
              className="history-nozzle"
              onClick={handleHistoryToggle}
              aria-label={flowHistoryOpen ? 'Collapse conversation history sidebar' : 'Show conversation history sidebar'}
              aria-expanded={flowHistoryOpen}
            >
              {flowHistoryOpen ? '‹' : '›'}
            </button>
          </Tooltip>
        </aside>
        <section className="flow-main" data-surface={activeSurface}>
          {/* Content navigation bar — inert only when the shell enters reduced chrome */}
          <nav ref={navRef} className="flow-content-nav" aria-label="Work surfaces" inert={chromeInert(chromeMode)}>
            <div ref={segmentRef} className={['flow-segment-control', navTier !== 'normal' && 'flow-segment-control--compact', navTier === 'scroll' && 'flow-segment-control--scroll'].filter(Boolean).join(' ')} role="tablist">
              {visibleTabs.map((tab) => {
                const isActive = activeSurface === tab.id;
                const tabId = `flow-tab-${tab.id}`;
                const panelId = `flow-panel-${tab.id}`;
                const chipClassName = [
                  'flow-chip',
                  isActive ? 'active' : '',
                  tab.dimmed ? 'flow-chip--dimmed' : ''
                ].filter(Boolean).join(' ');
                const tabButton = (
                  <button
                    type="button"
                    role="tab"
                    id={tabId}
                    aria-controls={panelId}
                    className={chipClassName}
                    onClick={() => handleSurfaceSelect(tab.id)}
                    aria-selected={isActive}
                    data-flow-tab-id={tab.id}
                    data-tour={tab.id === 'usecases' ? 'spark-nav' : undefined}
                  >
                    {tab.icon ? <tab.icon size={14} aria-hidden="true" /> : null}
                    <span>{tab.label}</span>
                    {tab.maturity ? <MaturityBadge level={tab.maturity} featureName={tab.label} /> : null}
                    {tab.badge ? <span className="flow-chip__badge">{tab.badge}</span> : null}
                  </button>
                );
                return tab.tooltip ? (
                  <Tooltip key={tab.id} content={tab.tooltip} placement="bottom" delayShow={300}>
                    {tabButton}
                  </Tooltip>
                ) : (
                  <Fragment key={tab.id}>{tabButton}</Fragment>
                );
              })}
              {/* Overflow menu for hidden tabs */}
              {overflowTabs.length > 0 && (() => {
                const activePluginTab = overflowTabs.find((tab) => tab.id === activeSurface);
                const isPluginActive = Boolean(activePluginTab);
                const buttonLabel = activePluginTab?.label ?? 'Plugins';
                return (
                <>
                  <Tooltip content="Browse and manage plugins" disabled={overflowMenuOpen}>
                    <button
                      ref={overflowRefs.setReference}
                      type="button"
                      className={`flow-chip flow-chip--plugins ${overflowMenuOpen || isPluginActive ? 'active' : ''}`.trim()}
                      aria-label={isPluginActive ? `Plugins (${buttonLabel} active)` : 'Plugins'}
                      aria-haspopup="menu"
                      aria-expanded={overflowMenuOpen}
                      {...getOverflowReferenceProps()}
                    >
                      <Plug size={14} aria-hidden />
                      <span>{buttonLabel}</span>
                    </button>
                  </Tooltip>
                  {overflowMenuOpen && (
                    <FloatingPortal>
                      <div
                        ref={overflowRefs.setFloating}
                        style={overflowFloatingStyles}
                        className="flow-overflow-menu"
                        role="menu"
                        {...getOverflowFloatingProps()}
                      >
                        {overflowTabs.map((tab) => {
                          const isActive = activeSurface === tab.id;
                          return (
                            <button
                              key={tab.id}
                              type="button"
                              role="menuitem"
                              className={`flow-overflow-menu__item ${isActive ? 'flow-overflow-menu__item--active' : ''}`.trim()}
                              onClick={() => {
                                handleSurfaceSelect(tab.id);
                                setOverflowMenuOpen(false);
                              }}
                            >
                              {tab.icon ? <tab.icon size={14} aria-hidden /> : null}
                              <span>{tab.label}</span>
                              {tab.maturity ? <MaturityBadge level={tab.maturity} featureName={tab.label} /> : null}
                            </button>
                          );
                        })}
                      </div>
                    </FloatingPortal>
                  )}
                </>
                );
              })()}
            </div>
          </nav>
          {belowTabs}
          <div className="flow-content-panels">
            {surfaceTabs.map((tab) => renderSurface(tab))}
          </div>
          {/* Layer 2 fallback: Manual continue button during onboarding coach */}
          {/* Note: Button moved to header area for better placement */}
        </section>
        {/* Right drawer for insights, document preview, or approvals */}
        {(approvalsDrawerOpen ? approvalsDrawer : rightDrawer) ? (
          <aside
            className="flow-column flow-column--insights"
            data-open={rightDrawerOpen}
            data-resizing={isResizing}
            aria-hidden={!rightDrawerOpen}
          >
            {/* Resize handle on left edge (hidden for fixed-width approvals drawer) */}
            {!approvalsDrawerOpen && (
              <div
                className="insights-drawer-resize-handle"
                onMouseDown={handleResizeMouseDown}
                role="separator"
                aria-orientation="vertical"
                aria-label={documentPreviewOpen ? 'Resize document preview' : 'Resize insights drawer'}
                tabIndex={0}
              />
            )}
            {approvalsDrawerOpen ? approvalsDrawer : rightDrawer}
          </aside>
        ) : null}
      </div>
      
      {/* Defer onboarding confirmation dialog */}
      <Dialog open={showSkipConfirmation} onOpenChange={setShowSkipConfirmation}>
        <DialogContent className="skip-onboarding-dialog">
          <DialogHeader>
            <DialogTitle>Come back later?</DialogTitle>
            <DialogDescription>
              Rebel will keep working. The intro stays on Home so you can finish it when you are ready.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowSkipConfirmation(false)}>
              Keep going
            </Button>
            <Button 
              variant="secondary" 
              onClick={() => {
                setShowSkipConfirmation(false);
                onOnboardingManualContinue?.();
              }}
            >
              Back to Home
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export type { FlowPanelsShellProps, FlowSurfaceConfig, SurfaceTab };
