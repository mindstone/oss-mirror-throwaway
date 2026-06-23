/**
 * Navigation Context
 *
 * Provides a unified navigation API for the application.
 * Part of the Unified Navigation System (see docs/plans/finished/251219_unified_navigation_system.md).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MutableRefObject, type ReactNode } from 'react';
import type { FlowSurface } from '@renderer/features/flow-panels/FlowPanelsProvider';
import type { LibraryFilter } from '@renderer/features/library/types/lens';
import { createPluginSurfaceId } from '@renderer/features/plugins/types';
import { setPluginRoute } from '@renderer/features/plugins/api/pluginRouteStore';
import { NAVIGATION_ERROR_COPY, resolveLink, type NavigationAction } from '@core/navigation';
import type { NavigationTarget, SettingsTabId } from '@shared/navigation/types';
import type { OpenSettingsDialogOptions } from '@renderer/features/settings/hooks/useSettingsFeature';
import { rendererDesktopSpaceResolver } from './desktopSpaceResolverRenderer';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

/**
 * Navigation API exposed via context.
 */
export interface NavigationContextValue {
  /**
   * Navigate to a target location.
   * Accepts either a NavigationTarget object or a rebel:// URL string.
   *
   * @param target - NavigationTarget or rebel:// URL string
   * @returns Promise<boolean> - true if navigation succeeded, false if cancelled or failed
   *
   * @example
   * // Navigate by target object
   * navigate({ type: 'settings', tab: 'agents' });
   *
   * // Navigate by URL string
   * navigate('rebel://settings/agents#voiceAudio');
   */
  navigate: (target: NavigationTarget | string) => Promise<boolean>;

  /**
   * The current active surface.
   */
  currentSurface: FlowSurface;

  /** Operator card selected by a rebel://team/{operatorId} deep-link. */
  teamSelectedOperatorId: string | null;
}

/**
 * Dependencies required by NavigationProvider.
 * These are injected from the parent component (App.tsx) which has access to the necessary callbacks.
 */
export interface NavigationProviderDeps {
  /** Current active surface from useFlowPanels */
  activeSurface: FlowSurface;
  /** Switch to a different surface */
  setActiveSurface: (surface: FlowSurface) => void;
  /** Open a conversation session (with draft protection) */
  openSession: (sessionId: string) => void;
  /** Open the insights drawer for a turn */
  openInsightsDrawer: (turnId: string) => void;
  /** Open settings dialog, optionally to a specific tab and section */
  openSettingsDialog: (tab?: SettingsTabId, section?: string, options?: OpenSettingsDialogOptions) => void;
  /** Close settings dialog (flushes pending saves) */
  closeSettingsDialog: () => void;
  /** Load a file in the workspace editor */
  loadWorkspaceFile?: (filePath: string) => Promise<void>;
  /** Navigate to a folder in the library (expands tree and scrolls to folder) */
  navigateToLibraryFolder?: (folderPath: string) => void;
  /** Apply a Library lens (filter/view) — used when a deep link carries `?filter=...`. */
  navigateToLibraryLens?: (lens: { filter?: LibraryFilter; view?: 'folders' | 'cards' | 'atlas' }) => void;
  /** Whether settings dialog is currently open */
  settingsOpen: boolean;
  /** Set the focused approval ID when navigating to tasks */
  setTasksFocusApprovalId?: (id: string | undefined) => void;
  /** Select a use case by ID and trigger use case activation flow */
  selectUseCaseById?: (useCaseId: string) => void;
  /** Show toast notification (for space link resolution errors) */
  showToast?: (message: { title: string; description?: string; variant?: 'default' | 'success' | 'warning' | 'error' | 'info' }) => void;
  /** Open feedback/bug report dialog with optional pre-fill data */
  openFeedbackDialog?: (target: Extract<NavigationTarget, { type: 'feedback' }>) => void;
  /** Redeem a dashboard-share token and seed a new conversation. */
  openSeededDashboardChat?: (token: string) => Promise<boolean>;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

declare global {
  var __rebelNavigateForTool: ((target: NavigationTarget | string) => Promise<boolean>) | undefined;
  var __rebelGetCurrentSurfaceForTool: (() => FlowSurface) | undefined;
}

export interface NavigationProviderProps {
  children: ReactNode;
  deps: NavigationProviderDeps;
}

/**
 * Provider that makes navigation available via context.
 * Must be rendered inside App.tsx where all dependencies are available.
 */
export const NavigationProvider = ({ children, deps }: NavigationProviderProps) => {
  const {
    activeSurface,
    setActiveSurface,
    openSession,
    openInsightsDrawer,
    openSettingsDialog,
    closeSettingsDialog,
    loadWorkspaceFile,
    navigateToLibraryFolder,
    navigateToLibraryLens,
    settingsOpen,
    setTasksFocusApprovalId,
    selectUseCaseById,
    showToast,
    openFeedbackDialog,
    openSeededDashboardChat,
  } = deps;
  const [teamSelectedOperatorId, setTeamSelectedOperatorId] = useState<string | null>(null);

  const navigate = useCallback(
    async (targetOrUrl: NavigationTarget | string): Promise<boolean> => {
      // Delegate URL parsing + space resolution + error mapping to the core
      // resolver. NavigationContext's job is now purely UI dispatch: switch on
      // action.kind and run the desktop side-effects (setActiveSurface, open
      // dialog, close settings, show toast).
      //
      // See docs/plans/260416_centralize_cross_surface_links.md — Stage D.
      let action: NavigationAction;
      try {
        action = await resolveLink(targetOrUrl, {
          spaceResolver: rendererDesktopSpaceResolver,
          surface: 'desktop-renderer',
        });
      } catch {
        // Defensive: resolveLink wraps resolver throws as 'resolver-failed'
        // error actions, but if the resolver itself throws synchronously we
        // surface a generic failure toast rather than crashing the renderer.
        showToast?.({
          title: NAVIGATION_ERROR_COPY['resolver-failed'].title,
          description: NAVIGATION_ERROR_COPY['resolver-failed'].description,
          variant: 'error',
        });
        return false;
      }

      switch (action.kind) {
        case 'open-home': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          setActiveSurface('home');
          return true;
        }

        case 'open-settings': {
          // Settings is a FlowSurface — must set activeSurface to keep dialog open
          // (App.tsx has an effect that closes settingsOpen when activeSurface !== 'settings').
          setActiveSurface('settings');
          openSettingsDialog(action.tab, action.section, {
            source: 'deep_link',
            interactionType: 'deep_link',
          });
          return true;
        }

        case 'open-session': {
          // Close settings if open (flush pending saves)
          if (settingsOpen) {
            closeSettingsDialog();
          }
          // Always switch to sessions surface immediately so the transition
          // doesn't depend on the async effect that watches settingsOpen.
          // Without this, closing settings → opening a session can race:
          // the effect-driven surface switch renders the old session briefly
          // before executeOpenHistorySession completes the load.
          setActiveSurface('sessions');

          // openSession (handleOpenHistorySession in App.tsx) already handles
          // draft protection internally. Fire-and-forget: actual navigation
          // depends on the user's response to the draft-discard dialog.
          openSession(action.sessionId);
          return true;
        }

        case 'open-session-surface': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          setActiveSurface('sessions');
          return true;
        }

        case 'open-seeded-chat': {
          return openSeededDashboardChat ? openSeededDashboardChat(action.token) : false;
        }

        case 'open-library-file': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          setActiveSurface('library');
          if (action.filter) {
            navigateToLibraryLens?.({ filter: action.filter });
          }
          if (loadWorkspaceFile) {
            try {
              await loadWorkspaceFile(action.relativePath);
            } catch {
              return false;
            }
          }
          return true;
        }

        case 'open-library-folder': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          setActiveSurface('library');
          if (action.filter) {
            navigateToLibraryLens?.({ filter: action.filter });
          }
          navigateToLibraryFolder?.(action.relativePath);
          return true;
        }

        case 'open-library-root': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          setActiveSurface('library');
          if (action.filter) {
            navigateToLibraryLens?.({ filter: action.filter });
          }
          return true;
        }

        case 'open-focus': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          setActiveSurface('focus');
          // Note: lens handling (week/month/quarter) deferred to a later phase.
          return true;
        }

        case 'open-automations': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          setActiveSurface('automations');
          // Note: automationId handling can be added in future stages.
          return true;
        }

        case 'open-tasks': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          // Set focused approval ID before switching surface so the target panel can consume it.
          setTasksFocusApprovalId?.(action.focusApprovalId);
          setActiveSurface('tasks');
          return true;
        }

        case 'open-team': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          setTeamSelectedOperatorId(action.roleId ?? null);
          setActiveSurface('team');
          return true;
        }

        case 'open-usecases': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          if (action.useCaseId && selectUseCaseById) {
            selectUseCaseById(action.useCaseId);
          } else {
            setActiveSurface('usecases');
          }
          return true;
        }

        case 'open-insights': {
          // Insights drawer is an overlay — no need to close settings or check drafts.
          openInsightsDrawer(action.turnId);
          return true;
        }

        case 'open-media': {
          // Media URLs are for video streaming, not navigable from this layer.
          return false;
        }

        case 'open-feedback': {
          openFeedbackDialog?.({
            type: 'feedback',
            feedbackType: action.feedbackType,
            description: action.description,
            stepsToReproduce: action.stepsToReproduce,
            expectedBehavior: action.expectedBehavior,
            attachContinuityDiagnostics: action.attachContinuityDiagnostics,
          });
          return true;
        }

        case 'open-plugin': {
          if (settingsOpen) {
            closeSettingsDialog();
          }
          // Write route state (tabId + params) before switching surface.
          setPluginRoute(action.pluginId, { tabId: action.tabId, params: action.params ?? {} });
          // Surface ID is always base (no tabId) — shell only registers base surfaces.
          const surfaceId = createPluginSurfaceId(action.pluginId);
          setActiveSurface(surfaceId);
          return true;
        }

        case 'invoke-action': {
          // Widget-style action verbs (start-voice, start-meeting-recording, etc.).
          // Desktop currently has no first-class handlers for these — widgets are
          // a mobile-only concept — so we surface an observable "unsupported"
          // state instead of silently succeeding. Mobile's +native-intent.ts
          // dispatches these before the router runs.
          //
          // If desktop grows widget-parity verbs later (global shortcut → voice,
          // tray icon → record meeting), add explicit handlers here. Keeping
          // this as a fail-loud branch preserves the "silent failure is a bug"
          // principle.
          showToast?.({
            title: 'Action not available',
            description: `"${action.action}" isn't supported on this surface yet.`,
            variant: 'warning',
          });
          return false;
        }

        case 'error': {
          const copy = NAVIGATION_ERROR_COPY[action.code];
          const variant = action.code === 'resolver-failed' ? 'error' : 'warning';
          showToast?.({ ...copy, variant });
          return false;
        }

        default: {
          const _exhaustive: never = action;
          return false;
        }
      }
    },
    [
      closeSettingsDialog,
      loadWorkspaceFile,
      navigateToLibraryFolder,
      navigateToLibraryLens,
      openInsightsDrawer,
      openSession,
      openSettingsDialog,
      setActiveSurface,
      setTasksFocusApprovalId,
      selectUseCaseById,
      settingsOpen,
      showToast,
      openFeedbackDialog,
      openSeededDashboardChat,
    ]
  );

  const value = useMemo<NavigationContextValue>(
    () => ({
      navigate,
      currentSurface: activeSurface,
      teamSelectedOperatorId,
    }),
    [navigate, activeSurface, teamSelectedOperatorId]
  );

  useEffect(() => {
    const getCurrentSurface = () => activeSurface;
    globalThis.__rebelNavigateForTool = navigate;
    globalThis.__rebelGetCurrentSurfaceForTool = getCurrentSurface;
    return () => {
      if (globalThis.__rebelNavigateForTool === navigate) {
        delete globalThis.__rebelNavigateForTool;
      }
      if (globalThis.__rebelGetCurrentSurfaceForTool === getCurrentSurface) {
        delete globalThis.__rebelGetCurrentSurfaceForTool;
      }
    };
  }, [activeSurface, navigate]);

  // Listen for navigation deep links from the OS (rebel://space/... opened from Slack, etc.)
  useIpcEvent(window.api.onNavigateDeepLink, (url: string) => {
    navigate(url);
  }, [navigate]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
};

/**
 * Hook to access navigation API from context.
 * Must be used within a NavigationProvider.
 *
 * @throws Error if used outside of NavigationProvider
 */
export const useNavigation = (): NavigationContextValue => {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return context;
};

/**
 * Safe version that returns null if not within provider.
 * Useful for optional navigation access (e.g., in shared components that may be rendered outside the provider).
 */
export const useNavigationSafe = (): NavigationContextValue | null => {
  return useContext(NavigationContext);
};

/**
 * Syncs the NavigationContext's navigate function to an external ref.
 * Render this inside NavigationProvider to expose navigate() to imperative code
 * that can't use the hook (e.g., callbacks defined at the App.tsx level).
 *
 * This enables centralization: instead of duplicating dispatch logic in both
 * NavigationContext and handleNavigateFromChat, the latter delegates to this ref.
 */
export const NavigateRefSync = ({ navigateRef }: { navigateRef: MutableRefObject<((target: NavigationTarget | string) => Promise<boolean>) | null> }) => {
  const { navigate } = useNavigation();
  // Assign synchronously so it's available immediately after mount
  navigateRef.current = navigate;
  return null;
};
