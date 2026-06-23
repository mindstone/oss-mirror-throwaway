/**
 * Profile chat/JSON-compatibility markers for the Behind-The-Scenes client.
 *
 * Extracted from `behindTheScenesClient.ts` in Stage 7 so the profile-http
 * transport adapter and the structured-output fallback orchestration share one
 * implementation without a circular import. Behaviour is preserved exactly.
 *
 * Both markers are sticky settings mutations (persisted via the main-side store)
 * and both deliberately SKIP Codex auto-profiles, which are uneditable from the
 * UI and re-seeded from constants on reconnect — persisting an incompatible
 * verdict against them would lock the resolver out of the user's chosen model
 * with no recovery path. (Invariant 10; PM guard.)
 */
import { createScopedLogger } from '@core/logger';
import { getSettings, updateSettings } from '@core/services/settingsStore';
import { isCodexAutoProfile } from '@shared/utils/codexDefaults';

const log = createScopedLogger({ service: 'behindTheScenesClient' });

/**
 * Atomically mark a profile as chat-incompatible via main-side store.
 * Uses getSettings() + updateSettings() (no IPC round-trip, no renderer race).
 * Idempotent — skips if already marked.
 */
export function markProfileChatIncompatible(profileId: string): void {
  try {
    const settings = getSettings();
    const profiles = settings.localModel?.profiles;
    if (!profiles) return;
    const target = profiles.find(p => p.id === profileId);
    if (!target || target.chatCompatibility === 'incompatible') return;

    // Auto-profiles cannot be edited or cleared through the UI (they are
    // filtered out of LocalModelSection and re-seeded from constants on
    // reconnect). Persisting an incompatible verdict against them silently
    // locks the resolver out of the user's chosen model with no recovery
    // path. ID-based check matches the canonical helper in codexDefaults.ts.
    if (isCodexAutoProfile({ id: target.id })) {
      log.info(
        { profileId, profileName: target.name },
        'Skipped chat-incompatible auto-mark on auto-managed profile (uneditable from UI)',
      );
      return;
    }

    const updatedProfiles = profiles.map(p =>
      p.id === profileId
        ? { ...p, chatCompatibility: 'incompatible' as const, chatCompatibilityCheckedAt: new Date().toISOString() }
        : p
    );
    updateSettings({ localModel: { ...settings.localModel!, profiles: updatedProfiles } });
    log.info({ profileId, profileName: target.name }, 'Auto-marked profile as chat-incompatible after runtime error');
  } catch (err) {
    log.warn({ profileId, err: err instanceof Error ? err.message : String(err) }, 'Failed to auto-mark profile as chat-incompatible');
  }
}

/**
 * Atomically mark a profile as JSON-incompatible via main-side store.
 * Uses getSettings() + updateSettings() (no IPC round-trip, no renderer race).
 * Idempotent — skips if already marked.
 */
export function markProfileJsonIncompatible(profileId: string): void {
  try {
    const settings = getSettings();
    const profiles = settings.localModel?.profiles;
    if (!profiles) return;
    const target = profiles.find(p => p.id === profileId);
    if (!target || target.jsonCompatibility === 'incompatible') return;

    // Auto-profiles cannot be edited or cleared through the UI (they are
    // filtered out of LocalModelSection and re-seeded from constants on
    // reconnect). Persisting an incompatible verdict against them silently
    // locks the resolver out of the user's chosen model with no recovery
    // path. ID-based check matches the canonical helper in codexDefaults.ts.
    if (isCodexAutoProfile({ id: target.id })) {
      log.info(
        { profileId, profileName: target.name },
        'Skipped JSON-incompatible auto-mark on auto-managed profile (uneditable from UI)',
      );
      return;
    }

    const updatedProfiles = profiles.map(p =>
      p.id === profileId
        ? { ...p, jsonCompatibility: 'incompatible' as const, jsonCompatibilityCheckedAt: new Date().toISOString() }
        : p
    );
    updateSettings({ localModel: { ...settings.localModel!, profiles: updatedProfiles } });
    log.info({ profileId, profileName: target.name }, 'Auto-marked profile as JSON-incompatible after runtime structured-output failure');
  } catch (err) {
    log.warn({ profileId, err: err instanceof Error ? err.message : String(err) }, 'Failed to auto-mark profile as JSON-incompatible');
  }
}
