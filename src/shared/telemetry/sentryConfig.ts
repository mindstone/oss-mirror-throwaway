const getEnvVar = (key: string): string | undefined => {
  const normalizedKey = key.toUpperCase();
  // Check process.env first (works for main process with shell env vars)
  if (typeof process !== 'undefined' && typeof process.env === 'object') {
    const value = process.env[normalizedKey];
    if (value !== undefined) {
      return value;
    }
  }
  // Check import.meta.env for Vite-loaded env vars
  const readFromImportMeta = (envKey: string): string | undefined => {
    if (typeof import.meta !== 'undefined' && (import.meta as unknown as Record<string, unknown>)?.env) {
      const metaEnv = (import.meta as unknown as Record<string, Record<string, unknown>>).env;
      const value = metaEnv[envKey];
      if (typeof value === 'string') {
        return value;
      }
    }
    return undefined;
  };

  // Try multiple prefixes to support both renderer (VITE_*) and main (MAIN_VITE_*) processes
  // electron-vite only exposes MAIN_VITE_* to main process and VITE_* to renderer
  return (
    readFromImportMeta(normalizedKey) ??
    readFromImportMeta(`VITE_${normalizedKey}`) ??
    readFromImportMeta(`MAIN_VITE_${normalizedKey}`)
  );
};

const normalizeOptionalEnvValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseSampleRate = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, 0), 1);
};

const normalizeBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
};

export const resolveSentryDsn = (): string | undefined =>
  normalizeOptionalEnvValue(getEnvVar('SENTRY_DSN'));

/**
 * OSS opt-in Sentry credentials, as supplied by the user via
 * `settings.telemetry` (LOCAL_ONLY). Mirrors the relevant fields of
 * `TelemetrySettings` without importing the heavy settings module into this
 * env-only config file (this file is shared by main + renderer and must stay
 * dependency-light).
 */
export interface OssTelemetryCreds {
  enabled?: boolean;
  sentryDsn?: string;
}

/**
 * OSS-aware Sentry DSN resolution — the no-phone-home gate.
 *
 * - OSS build: returns the user-supplied DSN ONLY when telemetry is explicitly
 *   enabled AND a non-empty DSN is present. NEVER falls back to env /
 *   app-config / a Mindstone DSN. (`undefined` → caller skips Sentry init.)
 * - Enterprise build (`isOss === false`): identical to today —
 *   `resolveSentryDsn()` reads the `SENTRY_DSN` env var.
 *
 * Each surface passes its own `isOss` signal (main: `PlatformConfig.isOss`;
 * renderer: `rendererIsOss()`) and, for OSS, the user creds it read from the
 * appropriate local-only source. This keeps the gate BEFORE any client
 * construction on every surface.
 */
export const resolveSentryDsnForBuild = (
  isOss: boolean,
  ossCreds?: OssTelemetryCreds,
): string | undefined => {
  if (isOss) {
    if (!ossCreds?.enabled) {
      return undefined;
    }
    return normalizeOptionalEnvValue(ossCreds.sentryDsn);
  }
  return resolveSentryDsn();
};

export const describeSentryDsnForLog = (dsn: string): string => {
  try {
    return new URL(dsn).host;
  } catch {
    return 'configured-dsn';
  }
};

export const SENTRY_DSN = resolveSentryDsn();
export const SENTRY_ENVIRONMENT = getEnvVar('SENTRY_ENVIRONMENT') ?? 'production';
export const SENTRY_ORG = getEnvVar('SENTRY_ORG') ?? 'mindstone';
export const SENTRY_PROJECT = getEnvVar('SENTRY_PROJECT') ?? 'rebel';
// Note: SENTRY_AUTH_TOKEN is intentionally NOT exported here.
// Auth tokens are secrets and should only be used at build time (CI) for sourcemap uploads.
// The token is passed via SENTRY_AUTH_TOKEN env var in GitHub Actions.

export const DEFAULT_TRACES_SAMPLE_RATE = parseSampleRate(
  getEnvVar('SENTRY_TRACES_SAMPLE_RATE'),
  0.1
);
export const DEFAULT_PROFILES_SAMPLE_RATE = parseSampleRate(
  getEnvVar('SENTRY_PROFILES_SAMPLE_RATE'),
  0
);
// Session Replay disabled by default due to performance impact on Windows
// (rrweb-based DOM mutation tracking causes UI lag during streaming)
// Can be re-enabled via env vars if needed for debugging
export const DEFAULT_REPLAYS_SESSION_SAMPLE_RATE = parseSampleRate(
  getEnvVar('SENTRY_REPLAYS_SESSION_SAMPLE_RATE'),
  0
);
export const DEFAULT_REPLAYS_ERROR_SAMPLE_RATE = parseSampleRate(
  getEnvVar('SENTRY_REPLAYS_ERROR_SAMPLE_RATE'),
  0
);

export type SentryChannel = 'stable' | 'beta' | 'dev';

export const buildSentryRelease = (
  version?: string | null,
  channel?: SentryChannel
): string => {
  const explicit = getEnvVar('SENTRY_RELEASE');
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  const resolvedVersion = version && version.trim() ? version.trim() : 'dev';
  // Format: mindstone-rebel@{version} for stable, mindstone-rebel-{channel}@{version} for beta/dev
  const appIdentifier = channel && channel !== 'stable' 
    ? `mindstone-rebel-${channel}` 
    : 'mindstone-rebel';
  return `${appIdentifier}@${resolvedVersion}`;
};

export const shouldEnableSentry = (params: {
  isPackaged?: boolean;
  dsn?: string;
} = {}): boolean => {
  // Key-presence semantics (aligned with `collectCommonSentryOptions`'
  // `dsnOverride`): when a `dsn` key is supplied (the OSS path always passes it,
  // value possibly `undefined`), use it verbatim and do NOT fall back to the
  // env DSN — "key present + empty" means "do not enable". Only when the key is
  // omitted entirely (enterprise) do we read the env DSN. This stops an OSS-off
  // build (gate said no → empty DSN) from re-enabling via `SENTRY_DSN` env.
  const hasDsn = Object.prototype.hasOwnProperty.call(params, 'dsn');
  const resolvedDsn = hasDsn
    ? normalizeOptionalEnvValue(params.dsn)
    : (normalizeOptionalEnvValue(params.dsn) ?? resolveSentryDsn());
  if (!resolvedDsn) {
    return false;
  }
  const override = normalizeBoolean(getEnvVar('SENTRY_ENABLED'));
  if (override !== undefined) {
    return override;
  }
  return true;
};

/**
 * True when `SENTRY_ENABLED` is explicitly set to a false-ish value at runtime
 * ('0'/'false'/'no'/'off'). Distinct from `shouldEnableSentry` (which also
 * requires a DSN): this asks only "did the operator explicitly turn Sentry
 * OFF?". The main process uses it to propagate runtime suppression to the
 * renderer (whose own enablement is build-inlined and can't see runtime env)
 * via the `--rebel-sentry-disabled` additionalArguments flag.
 */
export const isSentryExplicitlyDisabledByEnv = (): boolean =>
  normalizeBoolean(getEnvVar('SENTRY_ENABLED')) === false;

export const collectCommonSentryOptions = (params: {
  releaseVersion?: string | null;
  environment?: string;
  isPackaged?: boolean;
  channel?: SentryChannel;
  /**
   * Pre-resolved DSN, used by callers that have already applied the OSS
   * no-phone-home gate (`resolveSentryDsnForBuild`). When the key is present
   * (including a value of `undefined`/`null`), this DSN is used verbatim —
   * NEVER the `SENTRY_DSN` env var. `undefined`/`null` therefore means
   * "explicitly no DSN, do not init" on the OSS path. Enterprise callers OMIT
   * the key entirely to keep env behaviour.
   */
  dsnOverride?: string | null | undefined;
} = {}) => {
  const { releaseVersion, environment, isPackaged, channel } = params;
  // Distinguish "key omitted" (enterprise → read env) from "key present but
  // empty" (OSS gate said no → must NOT fall back to env).
  const hasOverride = Object.prototype.hasOwnProperty.call(params, 'dsnOverride');
  const dsn = hasOverride ? (params.dsnOverride ?? undefined) : resolveSentryDsn();
  return {
    dsn,
    release: buildSentryRelease(releaseVersion ?? undefined, channel),
    environment: environment ?? SENTRY_ENVIRONMENT,
    enabled: shouldEnableSentry({ isPackaged, dsn }),
    tracesSampleRate: DEFAULT_TRACES_SAMPLE_RATE,
    profilesSampleRate: DEFAULT_PROFILES_SAMPLE_RATE,
    replaysSessionSampleRate: DEFAULT_REPLAYS_SESSION_SAMPLE_RATE,
    replaysOnErrorSampleRate: DEFAULT_REPLAYS_ERROR_SAMPLE_RATE
  };
};

export const sentryBuildConstants = {
  org: SENTRY_ORG,
  project: SENTRY_PROJECT
};
