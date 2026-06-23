/**
 * Shared Sentry Vite plugin configuration for legacy build configs.
 *
 * Used by vite.main.config.mjs, vite.preload.config.mjs, and vite.renderer.config.mjs
 * to avoid duplicating ~45 LOC of Sentry setup in each file.
 *
 * NOTE: electron.vite.config.ts uses a different plugin API (sentryConfig.ts) — do NOT
 * consolidate it here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sentryVitePlugin } from '@sentry/vite-plugin';

/**
 * Parse an env-var string to a boolean toggle.
 * Returns `true` for "1"/"true"/"yes"/"on", `false` for "0"/"false"/"no"/"off",
 * or `undefined` for missing / unrecognised values.
 */
export const parseToggle = (value) => {
  if (!value) {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
};

/**
 * Read the `version` field from the package.json at the given root directory.
 */
export const getPackageVersion = (rootDir) => {
  try {
    const pkgJson = readFileSync(resolve(rootDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(pkgJson);
    return typeof parsed?.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Compute the Sentry release name from env vars and package version.
 * Prefers `SENTRY_RELEASE` when set, otherwise builds
 * `{appIdentifier}@{version}` using `BUILD_CHANNEL`.
 */
export const buildSentryRelease = (rootDir) => {
  const explicit = process.env.SENTRY_RELEASE;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  const version = getPackageVersion(rootDir) ?? 'dev';
  const channel = (process.env.BUILD_CHANNEL ?? 'stable').trim() || 'stable';
  const appIdentifier = channel !== 'stable' ? `mindstone-rebel-${channel}` : 'mindstone-rebel';
  return `${appIdentifier}@${version}`;
};

/**
 * Determine whether sourcemap upload to Sentry is enabled.
 * Requires `SENTRY_AUTH_TOKEN` to be set, and either an explicit
 * `SENTRY_UPLOAD_SOURCEMAPS` toggle or a CI/production environment.
 */
export const resolveSourcemapUpload = () => {
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
  const explicitUploadToggle = parseToggle(process.env.SENTRY_UPLOAD_SOURCEMAPS);
  const isCiBuild =
    process.env.CI === 'true' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.NODE_ENV === 'production';
  return Boolean(sentryAuthToken) && (explicitUploadToggle ?? isCiBuild);
};

/**
 * Factory that creates the Sentry Vite plugin for legacy (non-electron-vite) builds.
 *
 * @param {string} rootDir - Absolute path to the project root (pass `__dirname` from the config)
 * @param {string[]} filesToDeleteAfterUpload - Glob patterns for maps to delete after upload
 * @returns The configured `sentryVitePlugin` instance
 */
export const createLegacySentryPlugin = (rootDir, filesToDeleteAfterUpload) =>
  sentryVitePlugin({
    org: process.env.SENTRY_ORG ?? 'mindstone',
    project: process.env.SENTRY_PROJECT ?? 'rebel',
    authToken: process.env.SENTRY_AUTH_TOKEN,
    telemetry: false,
    disable: !resolveSourcemapUpload(),
    release: {
      name: buildSentryRelease(rootDir),
      inject: false,
    },
    sourcemaps: {
      filesToDeleteAfterUpload,
    },
  });
