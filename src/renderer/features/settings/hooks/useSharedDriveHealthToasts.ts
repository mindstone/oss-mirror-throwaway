import { useEffect, useRef } from 'react';
import { useToast } from '@renderer/components/ui/Toast';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SharedDriveHealthResult {
  provider: string;
  appStatus: 'running' | 'not_running' | 'unknown';
  offlineStatus: 'available' | 'online-only' | 'unknown';
  spacePaths: string[];
}

// ---------------------------------------------------------------------------
// Provider display names & help URLs
// ---------------------------------------------------------------------------

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
};

// ---------------------------------------------------------------------------
// Message builders (exported for testing)
// ---------------------------------------------------------------------------

export function buildAppNotRunningMessage(provider: string): string {
  const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  return `${displayName} needs to be running so your linked shared spaces stay in sync.`;
}

export function buildOnlineOnlyMessage(_provider: string): string {
  return 'Shared space files aren\'t available offline.';
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Listens for `shared-drive:health-warning` broadcasts from the main process
 * and shows provider-specific toast notifications.
 *
 * Features:
 * - Checks `dismissedDriveHealthWarnings` in settings — skip dismissed providers
 * - Deduplicates: one toast per provider per session (via useRef<Set>)
 * - "Don't remind me" action persists dismiss in settings
 */
export function useSharedDriveHealthToasts(): void {
  const { showToast } = useToast();
  const shownProvidersRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = window.api.onSharedDriveHealthWarning(
      async (results: SharedDriveHealthResult[]) => {
        // Read current settings to check dismissed providers
        let dismissedProviders: string[] = [];
        try {
          const settings = await window.settingsApi.get();
          dismissedProviders = settings.dismissedDriveHealthWarnings ?? [];
        } catch {
          // If settings read fails, proceed without dismiss filtering
        }

        for (const result of results) {
          const { provider, appStatus, offlineStatus } = result;

          // Skip dismissed providers
          if (dismissedProviders.includes(provider)) continue;

          // Skip already-shown providers this session
          if (shownProvidersRef.current.has(provider)) continue;

          // Determine which warning to show (prioritize app-not-running)
          let message: string | null = null;
          if (appStatus === 'not_running') {
            message = buildAppNotRunningMessage(provider);
          } else if (offlineStatus === 'online-only') {
            message = buildOnlineOnlyMessage(provider);
          }

          if (!message) continue;

          // Mark as shown for this session
          shownProvidersRef.current.add(provider);

          const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

          showToast({
            title: displayName,
            description: message,
            variant: 'warning',
            duration: Infinity, // Persistent until user dismisses
            action: {
              label: "Don't remind me",
              onClick: () => {
                // Persist dismiss in settings
                void (async () => {
                  try {
                    const currentSettings = await window.settingsApi.get();
                    const current = currentSettings.dismissedDriveHealthWarnings ?? [];
                    if (!current.includes(provider)) {
                      await window.settingsApi.update({
                        dismissedDriveHealthWarnings: [...current, provider],
                      } as Parameters<typeof window.settingsApi.update>[0]);
                    }
                  } catch {
                    // Best-effort — toast is already dismissed visually
                  }
                })();
              },
            },
          });
        }
      },
    );

    return () => unsubscribe();
  }, [showToast]);
}
