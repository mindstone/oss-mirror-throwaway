/**
 * Navigation Types
 *
 * Type-safe foundation for navigation targets and URL parsing.
 * Part of the Unified Navigation System (see docs/plans/finished/251219_unified_navigation_system.md).
 */

/**
 * Settings tab IDs - central registry that MUST match SettingsSurface.tsx
 */
export const SETTINGS_TABS = [
  'system',
  'spaces',
  'plugins',
  'meetings',
  'tools',
  'agents',
  'voice',
  'safety',
  'diagnostics',
  'developer',
  'usage',
  'cloud',
  'account',
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number];

/**
 * Navigation targets (discriminated union)
 *
 * Internal type uses 'sessions' to match FlowSurface.
 * URL format uses 'conversation' (rebel://conversation/{id}).
 */
export type FeedbackTargetType = 'bug' | 'improvement';

/**
 * Library lens filter selectable via `rebel://library?filter=...`.
 * Mirrors `LibraryFilter` in `@renderer/features/library/types/lens` but is
 * declared here so the navigation layer doesn't depend on renderer code.
 */
export const LIBRARY_NAVIGATION_FILTERS = [
  'spaces',
  'plugins',
  'skills',
  'memory',
  'everything',
] as const;
export type LibraryNavigationFilter = (typeof LIBRARY_NAVIGATION_FILTERS)[number];

/**
 * Known widget-style action verbs that `rebel://action/{verb}` URLs can carry.
 * Open-ended (plugins/future work may extend); parser accepts any string and
 * the dispatcher decides whether it handles the verb or surfaces an unsupported
 * error. See docs/plans/260416_centralize_cross_surface_links.md.
 */
export const WIDGET_ACTIONS = [
  'start-voice',
  'start-meeting-recording',
  'stop-meeting-recording',
  'inbox-item-focus',
] as const;

export type WidgetAction = (typeof WIDGET_ACTIONS)[number];

export type NavigationTarget =
  | { type: 'home' }
  | { type: 'settings'; tab?: SettingsTabId; section?: string }
  | { type: 'sessions'; sessionId?: string }
  | { type: 'library'; filter?: LibraryNavigationFilter; filePath?: string; folderPath?: never }
  | { type: 'library'; filter?: LibraryNavigationFilter; folderPath: string; filePath?: never }
  | { type: 'library'; filter?: LibraryNavigationFilter; filePath?: never; folderPath?: never }
  | { type: 'space'; spaceName: string; filePath?: string; folderPath?: never }
  | { type: 'space'; spaceName: string; folderPath: string; filePath?: never }
  | { type: 'space'; spaceName: string; filePath?: never; folderPath?: never }
  | { type: 'automations'; automationId?: string }
  | { type: 'tasks'; focusApprovalId?: string }
  | { type: 'dashboard-chat'; token: string }
  | { type: 'usecases'; useCaseId?: string }
  | { type: 'insights'; turnId: string }
  | { type: 'media'; resourcePath: string }
  | {
      type: 'feedback';
      feedbackType?: FeedbackTargetType;
      description?: string;
      stepsToReproduce?: string;
      expectedBehavior?: string;
      attachContinuityDiagnostics?: boolean;
    }
  | { type: 'focus'; lens?: 'week' | 'month' | 'quarter' }
  | { type: 'team'; roleId?: string }
  | { type: 'plugin'; pluginId: string; tabId?: string; params?: Record<string, string> }
  | { type: 'action'; action: string; params?: Record<string, string> };

/**
 * Aliases for settings tab IDs used in rebel:// URLs.
 * Maps old or alternate names to their canonical tab ID.
 * When the UI label changes but the tab ID stays the same (e.g. "tools" → "Connectors"),
 * content authors may use the label as a URL segment. This map ensures those URLs resolve.
 */
export const SETTINGS_TAB_ALIASES: Record<string, SettingsTabId> = {
  connectors: 'tools',
  support: 'diagnostics',
};

/**
 * Type guard to check if a string is a valid SettingsTabId
 */
export function isSettingsTabId(value: string): value is SettingsTabId {
  return SETTINGS_TABS.includes(value as SettingsTabId);
}

/**
 * Resolves a URL segment to a canonical SettingsTabId, checking aliases.
 */
export function resolveSettingsTabId(value: string): SettingsTabId | undefined {
  if (isSettingsTabId(value)) return value;
  return SETTINGS_TAB_ALIASES[value];
}

// Settings IA / deep-link matrix: `settingsNavigationContract.ts` (resolveSettingsNavigation, scroll helpers, public section ids).
