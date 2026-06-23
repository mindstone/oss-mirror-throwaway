import {
  APP_NAVIGATION_DESTINATION_SURFACES,
  type AppNavigationDestination,
  type AppNavigationService,
} from '@core/appNavigationService';
import type { NavigationTarget, SettingsTabId } from '@shared/navigation/types';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import { BrowserWindow } from 'electron';
import { logger } from '@core/logger';
import {
  emitVisualVerificationOverlay,
  registerVisualVerificationRestoreTarget,
  waitForRendererPaint,
  waitForVisualVerificationOverlayCue,
} from './visualVerificationOverlayService';

const DESTINATION_TO_NAVIGATION_TARGET: Record<AppNavigationDestination, NavigationTarget> = {
  home: { type: 'home' },
  conversations: { type: 'sessions' },
  actions: { type: 'tasks' },
  automations: { type: 'automations' },
  spark: { type: 'usecases' },
  library: { type: 'library' },
  settings: { type: 'settings' },
};

const DESTINATION_LABELS: Record<AppNavigationDestination, string> = {
  home: 'Home',
  conversations: 'Conversations',
  actions: 'Actions',
  automations: 'Automations',
  spark: 'The Spark',
  library: 'Library',
  settings: 'Settings',
};

const SETTINGS_TAB_LABELS: Record<SettingsTabId, string> = {
  system: 'System',
  spaces: 'Spaces',
  plugins: 'Plugins',
  meetings: 'Meetings',
  tools: 'Connectors',
  agents: 'AI & Models',
  voice: 'Voice',
  safety: 'Safety',
  diagnostics: 'Diagnostics',
  developer: 'Developer',
  usage: 'Usage',
  cloud: 'Cloud',
  account: 'Account',
};

const SURFACE_RESTORE_TARGETS: Record<string, { url: string; label: string }> = {
  home: { url: 'rebel://home', label: 'Home' },
  sessions: { url: 'rebel://sessions', label: 'Conversations' },
  tasks: { url: 'rebel://tasks', label: 'Actions' },
  automations: { url: 'rebel://automations', label: 'Automations' },
  usecases: { url: 'rebel://usecases', label: 'The Spark' },
  library: { url: 'rebel://library', label: 'Library' },
  settings: { url: 'rebel://settings', label: 'Settings' },
  focus: { url: 'rebel://focus', label: 'Focus' },
  team: { url: 'rebel://team', label: 'Team' },
};

const NAVIGATION_BRIDGE_READY_ATTEMPTS = 8;
const NAVIGATION_BRIDGE_RETRY_MS = 125;

function buildSettingsUrl(tab?: SettingsTabId, section?: string): string {
  return formatNavigationUrl({
    type: 'settings',
    ...(tab !== undefined ? { tab } : {}),
    ...(section !== undefined ? { section } : {}),
  });
}

function buildNavigationTarget(input: Parameters<AppNavigationService['navigateApp']>[0]): {
  url: string;
  label: string;
} | null {
  if (input.destination === 'settings') {
    const settingsTabLabel = input.settingsTab ? SETTINGS_TAB_LABELS[input.settingsTab] : undefined;
    return {
      url: buildSettingsUrl(input.settingsTab, input.settingsSection),
      label: settingsTabLabel ? `Settings > ${settingsTabLabel}` : DESTINATION_LABELS.settings,
    };
  }

  const target = DESTINATION_TO_NAVIGATION_TARGET[input.destination];
  if (!target) return null;
  return { url: formatNavigationUrl(target), label: DESTINATION_LABELS[input.destination] };
}

async function waitForNavigationBridge(win: BrowserWindow): Promise<boolean> {
  for (let attempt = 0; attempt < NAVIGATION_BRIDGE_READY_ATTEMPTS; attempt += 1) {
    if (win.isDestroyed()) return false;

    try {
      const ready = await win.webContents.executeJavaScript(
        `typeof globalThis.__rebelNavigateForTool === 'function' && typeof globalThis.__rebelGetCurrentSurfaceForTool === 'function'`,
        true,
      );
      if (ready === true) {
        return true;
      }
    } catch {
      // The renderer can be between HMR/reload states; retry before failing the tool call.
    }

    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_BRIDGE_RETRY_MS));
  }

  return false;
}

export const desktopAppNavigationService: AppNavigationService = {
  async navigateApp(input) {
    // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: app navigation command targets focused window fallback; migrate later to injected main-window navigation target.
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return { kind: 'error', errorCode: 'window-not-found' };
    }

    if ((input.settingsTab !== undefined || input.settingsSection !== undefined) && input.destination !== 'settings') {
      return {
        kind: 'error',
        errorCode: 'invalid-destination-modifiers',
        detail: {
          reason: 'settingsTab and settingsSection can only be used when destination is settings',
          destination: input.destination,
        },
      };
    }

    const target = buildNavigationTarget(input);
    if (!target) {
      return {
        kind: 'error',
        errorCode: 'invalid-destination',
        detail: { destination: input.destination },
      };
    }

    try {
      const bridgeReady = await waitForNavigationBridge(win);
      if (!bridgeReady) {
        return {
          kind: 'error',
          errorCode: 'navigation-failed',
          detail: { destination: input.destination, reason: 'renderer-navigation-bridge-unavailable' },
        };
      }

      const previousSurface = await win.webContents.executeJavaScript(
        'globalThis.__rebelGetCurrentSurfaceForTool?.()',
        true,
      );
      const restoreTarget = typeof previousSurface === 'string'
        && previousSurface !== APP_NAVIGATION_DESTINATION_SURFACES[input.destination]
        ? SURFACE_RESTORE_TARGETS[previousSurface]
        : null;
      registerVisualVerificationRestoreTarget(restoreTarget ?? null);

      await emitVisualVerificationOverlay(win, {
        action: 'show',
        phase: 'navigating',
        message: `Opening ${target.label} for a screenshot`,
        autoHideMs: 8_000,
      });
      await waitForVisualVerificationOverlayCue(win);

      const result = await win.webContents.executeJavaScript(
        `globalThis.__rebelNavigateForTool?.(${JSON.stringify(target.url)})`,
        true,
      );
      if (result !== true) {
        return {
          kind: 'error',
          errorCode: 'navigation-failed',
          detail: { destination: input.destination, url: target.url, result },
        };
      }
      await waitForRendererPaint(win);

      await emitVisualVerificationOverlay(win, {
        action: 'show',
        phase: 'preparing',
        message: `Taking a screenshot of ${target.label}`,
        autoHideMs: 8_000,
      });
      await waitForVisualVerificationOverlayCue(win);

      return {
        kind: 'ok',
        destination: input.destination,
        ...(input.settingsTab !== undefined ? { settingsTab: input.settingsTab } : {}),
        ...(input.settingsSection !== undefined ? { settingsSection: input.settingsSection } : {}),
      };
    } catch (error) {
      logger.warn({ err: error, destination: input.destination }, 'Failed to navigate Rebel app for visual verification');
      return {
        kind: 'error',
        errorCode: 'navigation-failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
