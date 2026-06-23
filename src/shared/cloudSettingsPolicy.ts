/**
 * Cloud Settings Policy — Local-Only Settings Protection
 *
 * Centralizes the definition of which AppSettings keys are local-only
 * (must never be sent to cloud or overwritten by cloud values) and provides
 * utility functions for stripping and merging them.
 *
 * Used by:
 * - cloudRouter.ts (forwardSettingsGet, forwardSettingsUpdate)
 * - cloudMigrationService.ts (prepareCloudSettings)
 */
import type { AppSettings } from './types/settings';
import { isSensitiveKeyName } from './utils/redactionPatterns';

/**
 * Settings keys that are local-only and must never be sent to cloud
 * or overwritten by cloud values.
 *
 * - cloudInstance: connection config (how the desktop reaches the cloud service)
 * - coreDirectory: local filesystem path to the workspace
 * - mcpConfigFile: local filesystem path to super-mcp-router.json
 * - enforceSoftwareEngineerEvidence: desktop-only contribution-flow gate flag
 * - dailySparkMode: desktop-only Home card preference; no cloud/mobile surface in v1
 * - efficiencyMode / efficiencyModeBaseline: desktop-only "lite" preset; cloud
 *   and mobile have different runtime profiles. (The underlying sub-settings
 *   that Efficiency Mode writes through to continue to sync — by design, so the
 *   user's cloud Rebel also goes quieter.)
 * - personaQuipsEnabled / cpuEmbeddingIdleDisposalEnabled: desktop-only —
 *   renderer flavour text and embedding-worker lifecycle have no cloud surface.
 * - telemetry: OSS-build telemetry creds + opt-in toggle (sentryDsn,
 *   rudderWriteKey, rudderDataPlaneUrl). MUST be local-only — these are the
 *   user's own credentials and must never leave the device via cloud sync.
 *   Top-level (not nested) precisely so this top-level-only strip removes it.
 */
const LOCAL_ONLY_SETTINGS_KEYS_ARRAY = [
  'cloudInstance',
  'coreDirectory',
  'mcpConfigFile',
  'managedCloudEnabled',
  'enforceSoftwareEngineerEvidence',
  'dailySparkMode',
  'efficiencyMode',
  'efficiencyModeBaseline',
  'personaQuipsEnabled',
  'cpuEmbeddingIdleDisposalEnabled',
  'telemetry',
] as const satisfies readonly (keyof AppSettings)[];

export const LOCAL_ONLY_SETTINGS_KEYS = new Set<keyof AppSettings>(
  LOCAL_ONLY_SETTINGS_KEYS_ARRAY,
);

const LOCAL_ONLY_EXPERIMENTAL_SETTINGS_KEYS_ARRAY = [
  'cloudSlackWorkspace',
  'inboundAuthorPolicyBackup',
  // Desktop-only filesystem/mount experiment (no FUSE on cloud/mobile). The
  // cloud-liveness prober + the 3 descent decision points are desktop-only, so
  // syncing the flag to cloud/mobile would enable nothing there. Stage-11 parity
  // note: if cloud/mobile ever gain an equivalent local-indexing surface, revisit.
  'cloudSymlinkIndexing',
] as const satisfies readonly (keyof NonNullable<AppSettings['experimental']>)[];

const LOCAL_ONLY_EXPERIMENTAL_SETTINGS_KEYS = new Set<keyof NonNullable<AppSettings['experimental']>>(
  LOCAL_ONLY_EXPERIMENTAL_SETTINGS_KEYS_ARRAY,
);

/**
 * Experimental keys that are intentionally cloud-synced.
 *
 * Keep these out of `LOCAL_ONLY_EXPERIMENTAL_SETTINGS_KEYS`.
 */
export const CLOUD_SYNCED_EXPERIMENTAL_SETTINGS_KEYS = new Set([
  'agentInstanceId',
  'inboundAuthorPolicy',
  'inboundAuthorPolicyBypassActive',
] as const);

/**
 * Meeting-bot settings that are intentionally cloud-synced via `settings:update`.
 * Keep this aligned with MeetingBotSettings + mobile/desktop expectations.
 */
export const CLOUD_SYNCED_MEETING_BOT_KEYS = new Set([
  'triggerPhrase',
  'localRecordingTriggerListening',
] as const);

function stripLocalExperimentalSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (!LOCAL_ONLY_EXPERIMENTAL_SETTINGS_KEYS.has(key as typeof LOCAL_ONLY_EXPERIMENTAL_SETTINGS_KEYS extends Set<infer T> ? T : never)) {
      cleaned[key] = nestedValue;
    }
  }
  return cleaned;
}

/** Strip local-only fields from settings before sending to cloud. */
export function stripLocalSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!LOCAL_ONLY_SETTINGS_KEYS.has(key as typeof LOCAL_ONLY_SETTINGS_KEYS extends Set<infer T> ? T : never)) {
      cleaned[key] = key === 'experimental' ? stripLocalExperimentalSettings(value) : value;
    }
  }
  return cleaned;
}

const MAX_STRIP_DEPTH = 15;

/**
 * SSOT deep secret-scrub. Returns a deep clone with every key whose NAME
 * matches `isSensitiveKeyName` replaced by `blankValue` (default
 * null). Non-secret keys + nested structure are preserved. Used both for the
 * cloud client response and for backup copies (never the live settings file).
 */
export function deepScrubSensitiveKeys(
  value: unknown,
  blankValue: unknown = null,
): unknown {
  function walk(obj: unknown, depth: number): unknown {
    if (depth > MAX_STRIP_DEPTH || obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((item) => walk(item, depth + 1));

    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKeyName(key)) {
        result[key] = blankValue;
      } else {
        result[key] = walk(nested, depth + 1);
      }
    }
    return result;
  }
  return walk(value, 0);
}

/**
 * Deep-strip sensitive values from a settings object for client consumption.
 * Returns a deep clone with all secret-bearing keys set to null.
 *
 * The cloud server stores settings WITH secrets (needed for agent turns).
 * This function is for the GET /api/settings HTTP response to mobile/web
 * clients, which only need preferences and feature flags.
 */
export function stripSensitiveSettingsForClient(settings: Record<string, unknown>): Record<string, unknown> {
  return deepScrubSensitiveKeys(settings, null) as Record<string, unknown>;
}

/** Merge local-only fields back into cloud settings response. */
export function mergeLocalSettings(
  cloudSettings: Record<string, unknown>,
  localSettings: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...cloudSettings };
  for (const key of LOCAL_ONLY_SETTINGS_KEYS) {
    if (localSettings[key] !== undefined) {
      merged[key] = localSettings[key];
    }
  }
  const localExperimental = localSettings.experimental;
  if (localExperimental && typeof localExperimental === 'object' && !Array.isArray(localExperimental)) {
    const cloudExperimental = merged.experimental && typeof merged.experimental === 'object' && !Array.isArray(merged.experimental)
      ? merged.experimental as Record<string, unknown>
      : {};
    const restoredLocalExperimental: Record<string, unknown> = {};
    for (const key of LOCAL_ONLY_EXPERIMENTAL_SETTINGS_KEYS) {
      const value = (localExperimental as Record<string, unknown>)[key];
      if (value !== undefined) {
        restoredLocalExperimental[key] = value;
      }
    }
    if (Object.keys(restoredLocalExperimental).length > 0) {
      merged.experimental = {
        ...cloudExperimental,
        ...restoredLocalExperimental,
      };
    }
  }
  return merged;
}
