import type { SettingsTabId } from '@shared/navigation/types';

export const APP_NAVIGATION_DESTINATIONS = [
  'home',
  'conversations',
  'actions',
  'automations',
  'spark',
  'library',
  'settings',
] as const;

export type AppNavigationDestination = (typeof APP_NAVIGATION_DESTINATIONS)[number];

export const APP_NAVIGATION_DESTINATION_SURFACES: Record<AppNavigationDestination, string> = {
  home: 'home',
  conversations: 'sessions',
  actions: 'tasks',
  automations: 'automations',
  spark: 'usecases',
  library: 'library',
  settings: 'settings',
};

export interface AppNavigationInput {
  destination: AppNavigationDestination;
  settingsTab?: SettingsTabId;
  settingsSection?: string;
}

export type AppNavigationErrorCode =
  | 'navigation-not-supported-on-this-surface'
  | 'visual-app-access-denied'
  | 'window-not-found'
  | 'navigation-failed'
  | 'invalid-destination-modifiers'
  | 'invalid-destination';

export type AppNavigationResult =
  | {
      kind: 'ok';
      destination: AppNavigationDestination;
      settingsTab?: SettingsTabId;
      settingsSection?: string;
    }
  | {
      kind: 'error';
      errorCode: AppNavigationErrorCode;
      detail?: unknown;
    };

export interface AppNavigationService {
  navigateApp(input: AppNavigationInput): Promise<AppNavigationResult>;
}

let _appNavigationService: AppNavigationService | null = null;

// CROSS_SURFACE_PARITY_EXEMPT: Desktop-only: requires Electron BrowserWindow + navigation IPC to programmatically navigate the Rebel app shell; cloud is a stateless HTTP server with no window concept and mobile uses React Navigation with different abstractions; safe because getAppNavigationService() returns null on cloud/mobile and callers handle navigation-not-supported-on-this-surface error code. Baseline acknowledgement at gate rollout (260516).
export function setAppNavigationService(service: AppNavigationService): void {
  _appNavigationService = service;
}

export function getAppNavigationService(): AppNavigationService | null {
  return _appNavigationService;
}
