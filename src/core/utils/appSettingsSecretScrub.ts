import { deepScrubSensitiveKeys } from '@shared/cloudSettingsPolicy';

const SECRET_PLACEHOLDER = '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Blank every secret-bearing field (by key name) in a *copy* of app-settings
 * destined for an on-disk backup (migration backup, pre-cloud backup).
 *
 * Reuses the single SSOT name-pattern deep scrubber
 * ({@link deepScrubSensitiveKeys} keyed off `isSensitiveKeyName` in
 * `@shared/utils/redactionPatterns`) so this never drifts from the
 * cloud-client sensitive-key list. Secret keys are replaced with an empty
 * string; non-secret keys and nested structure are preserved.
 *
 * MUST only be applied to backup copies, never the live settings file.
 */
export function scrubAppSettingsSecretsForBackup<T>(settings: T): T {
  if (!isRecord(settings)) {
    return settings;
  }
  return deepScrubSensitiveKeys(settings, SECRET_PLACEHOLDER) as T;
}
