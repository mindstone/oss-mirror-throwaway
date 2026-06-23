/**
 * Meeting bot backend config resolution.
 *
 * Resolution order is env vars first, then an optional injected provider. The
 * commercial desktop build registers a provider via `@private/mindstone`; OSS,
 * cloud-service, and mobile stay env-only / broken-by-default. This module must
 * not import `@private/mindstone` directly because that alias is desktop-only.
 */

export type MeetingBotBackendConfigKey = 'url' | 'authKey';

export interface ProvidedMeetingBotBackendConfig {
  url?: string;
  authKey?: string;
}

export interface MeetingBotBackendConfigProvider {
  get(): ProvidedMeetingBotBackendConfig | null;
}

export type ResolvedMeetingBotBackendConfig =
  | { configured: true; url: string; authKey: string }
  | { configured: false; missing: MeetingBotBackendConfigKey[] };

export const MEETING_BOT_BACKEND_CONFIG_MISSING_REASON = 'meeting_bot_backend_config_missing';

const normalizeConfigValue = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const readEnv = (name: string): string | null => normalizeConfigValue(process.env[name]);

let backendConfigProvider: MeetingBotBackendConfigProvider | null = null;

type NormalizedMeetingBotBackendConfig = Record<MeetingBotBackendConfigKey, string | null>;

const hasCompleteConfigPair = (
  config: NormalizedMeetingBotBackendConfig,
): config is Record<MeetingBotBackendConfigKey, string> => Boolean(config.url && config.authKey);

const countPresentConfigFields = (config: NormalizedMeetingBotBackendConfig): number =>
  Number(Boolean(config.url)) + Number(Boolean(config.authKey));

const missingFieldsFromSource = (
  config: NormalizedMeetingBotBackendConfig,
): MeetingBotBackendConfigKey[] => {
  const missing: MeetingBotBackendConfigKey[] = [];
  if (!config.url) missing.push('url');
  if (!config.authKey) missing.push('authKey');
  return missing;
};

const missingFieldsForIncompleteSources = (
  envConfig: NormalizedMeetingBotBackendConfig,
  providerConfig: NormalizedMeetingBotBackendConfig,
): MeetingBotBackendConfigKey[] => {
  const envPresent = countPresentConfigFields(envConfig);
  const providerPresent = countPresentConfigFields(providerConfig);

  if (envPresent > providerPresent) {
    return missingFieldsFromSource(envConfig);
  }
  if (providerPresent > envPresent) {
    return missingFieldsFromSource(providerConfig);
  }

  // Equal partial sources cannot form a safe pair without mixing sources.
  return ['url', 'authKey'];
};

/**
 * Register the fallback meeting-bot backend config provider. Called at desktop
 * bootstrap with the value from `@private/mindstone/bootstrap`. Pass `null` to
 * clear it in tests.
 */
export function setMeetingBotBackendConfigProvider(
  provider: MeetingBotBackendConfigProvider | null,
): void {
  backendConfigProvider = provider;
}

export function resolveMeetingBotBackendConfig(): ResolvedMeetingBotBackendConfig {
  const envConfig: NormalizedMeetingBotBackendConfig = {
    url: readEnv('MEETING_BOT_BACKEND_URL'),
    authKey: readEnv('MEETING_BOT_BACKEND_AUTH_KEY'),
  };
  if (hasCompleteConfigPair(envConfig)) {
    return { configured: true, url: envConfig.url, authKey: envConfig.authKey };
  }

  const provided = backendConfigProvider?.get() ?? null;
  const providerConfig: NormalizedMeetingBotBackendConfig = {
    url: normalizeConfigValue(provided?.url),
    authKey: normalizeConfigValue(provided?.authKey),
  };
  if (hasCompleteConfigPair(providerConfig)) {
    return { configured: true, url: providerConfig.url, authKey: providerConfig.authKey };
  }

  return {
    configured: false,
    missing: missingFieldsForIncompleteSources(envConfig, providerConfig),
  };
}

export class MeetingBotBackendConfigError extends Error {
  readonly code = MEETING_BOT_BACKEND_CONFIG_MISSING_REASON;
  readonly missing: MeetingBotBackendConfigKey[];

  constructor(missing: MeetingBotBackendConfigKey[]) {
    super('Meeting bot backend is not configured');
    this.name = 'MeetingBotBackendConfigError';
    this.missing = missing;
  }
}

export function meetingBotBackendConfigMissingLogContext(
  missing: MeetingBotBackendConfigKey[],
): {
  service: 'meetingBot';
  reason: typeof MEETING_BOT_BACKEND_CONFIG_MISSING_REASON;
  missing: MeetingBotBackendConfigKey[];
} {
  return {
    service: 'meetingBot',
    reason: MEETING_BOT_BACKEND_CONFIG_MISSING_REASON,
    missing,
  };
}
