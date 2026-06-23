import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getPlatformConfig } from '@core/platform';

const CONFIG_DIRECTORY = 'config';
const CONFIG_FILE = 'app-config.json';
const DISABLED_SENTINEL = 'DISABLED';

export type RuntimeConfig = Record<string, unknown>;

let cachedConfig: RuntimeConfig | null | undefined;

const uniquePaths = (paths: (string | null | undefined)[]): string[] => {
  const seen = new Set<string>();
  for (const candidate of paths) {
    if (!candidate) {
      continue;
    }
    const normalized = path.resolve(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
    }
  }
  return Array.from(seen);
};

const getCandidatePaths = (): string[] => {
  const packagedPath =
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, CONFIG_DIRECTORY, CONFIG_FILE)
      : undefined;
  const cwdPath = path.join(process.cwd(), CONFIG_DIRECTORY, CONFIG_FILE);

  let appAdjacentPath: string | undefined;
  try {
    const appPath = getPlatformConfig().appPath;
    // In dev this points to out/main, in prod inside app.asar
    appAdjacentPath = path.join(appPath, '..', CONFIG_DIRECTORY, CONFIG_FILE);
  } catch {
    appAdjacentPath = undefined;
  }

  return uniquePaths([packagedPath, appAdjacentPath, cwdPath]);
};

const readConfig = (): RuntimeConfig | null => {
  for (const candidate of getCandidatePaths()) {
    try {
      if (!existsSync(candidate)) {
        continue;
      }
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as RuntimeConfig;
      return parsed;
    } catch (error) {
      // Skip invalid paths but continue trying other candidates
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[runtime-config] Failed to read ${candidate}: ${(error as Error).message}`);
      }
    }
  }
  return null;
};

export const loadRuntimeConfig = (): RuntimeConfig | null => {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }
  cachedConfig = readConfig();
  return cachedConfig;
};

export const getConfigValue = <T = unknown>(keys: string[], fallback?: T): T | undefined => {
  const config = loadRuntimeConfig();
  if (!config) {
    return fallback;
  }

  let current: unknown = config;
  for (const key of keys) {
    if (current == null || typeof current !== 'object' || !(key in current)) {
      return fallback;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current === undefined ? fallback : (current as T);
};

/**
 * Whether the prod-capable renderer perf monitor (Stage 3 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`) should be
 * enabled in packaged / non-dev builds.
 *
 * KILLSWITCH ACTIVE — always returns `false`. The Stage 3 prod code path
 * (renderer `usePerformanceMonitor` prod mode + main-side
 * `rendererPerfMonitorService` cache + `ipcMain.on('log:event', ...)`
 * perf-summary branch) has confirmed HIGH-severity PII leak paths:
 *
 *   - `scrubAttribution` does not URL-decode `%XX` before its whitespace /
 *     title heuristic, so user document titles like
 *     `/doc/meeting%20notes%20with%20Alice.pdf` pass through unredacted.
 *   - Pseudo-protocols (`javascript:`, `data:`, `blob:`, `file:`,
 *     `vbscript:`) pass through unredacted because they lack `://`.
 *   - The main `ipcMain.on('log:event', ...)` handler logs the full
 *     untrusted `context: {...}` at `info` BEFORE scrub validation; info-level
 *     logs become Sentry breadcrumbs via `src/core/logger.ts` and pino
 *     redaction only strips `apiKey` / `voiceApiKey`.
 *   - `batchEndMs` validation accepts `Number.MAX_SAFE_INTEGER`, allowing a
 *     single malformed (or malicious) renderer payload to permanently
 *     poison the cache and silently blind all subsequent perf summaries.
 *
 * Until those fixes ship + pass a security re-review, the prod path must
 * be unreachable. Killswitch chosen (rather than removing the code) because
 * the Stage 1/2/4/5 plumbing still references these modules, the flag is
 * the narrowest choke-point, and the work-in-progress implementation is
 * useful reference material for the follow-up refinement.
 *
 * Dev mode (`import.meta.env.DEV === true` in the renderer) is unaffected:
 * the hook stays in `'dev'` mode using console-only logging, which does
 * NOT flow through the vulnerable main-side cache / Sentry breadcrumb path.
 *
 * Re-enabling checklist (tracked in Stage 3 refinement plan):
 *   1. URL-decode `%XX` before every scrub check (inc. test fixtures).
 *   2. Add DANGEROUS_PROTOCOL_RE check for `javascript:|data:|blob:|file:|vbscript:|chrome-extension:|moz-extension:`.
 *   3. Sanitize perf-summary context BEFORE logging in the main IPC relay;
 *      log only the cleaned payload.
 *   4. Upper-bound `batchEndMs` at `Date.now() + 5min` (clock-skew tolerance).
 *   5. Use `batchEndMs`-based staleness (not `receivedAtMs`) so a 20-min-old
 *      late delivery correctly expires.
 *   6. Zero-emit gate must require `longTasks.length > 0` (input-lag alone
 *      must not trigger a batch).
 *   7. Re-run security-lens review; require approve=yes severity<=medium.
 */
export const getProdPerfMonitorEnabled = (): boolean => {
  return false;
  // Legacy gating preserved for the refinement plan; unreachable while the
  // killswitch above returns false:
  //   if (process.env.REBEL_PROD_PERF_MONITOR === '1') return true;
  //   return getConfigValue<boolean>(['prodPerfMonitor']) === true;
};

/**
 * Runtime config payload exposed to the renderer via preload.
 *
 * Merges the on-disk `app-config.json` with computed overlays (currently
 * `prodPerfMonitor`, which takes env + config file into account). Returns
 * an object even when no config file is present so consumers can read the
 * overlay fields unconditionally.
 */
export const getRuntimeConfigForRenderer = (): Record<string, unknown> => {
  const base = loadRuntimeConfig() ?? {};
  return {
    ...base,
    prodPerfMonitor: getProdPerfMonitorEnabled(),
  };
};

const isDisabledValue = (value: string | undefined | null): boolean => {
  if (typeof value !== 'string') {
    return false;
  }
  return value.trim() === DISABLED_SENTINEL;
};

type ResolveSecretOptions = {
  path: string[];
  envVar?: string;
  required?: boolean;
};

export const resolveConfigSecret = ({
  path,
  envVar,
  required = false
}: ResolveSecretOptions): string | undefined => {
  const candidate = getConfigValue<string>(path);
  if (candidate && !isDisabledValue(candidate)) {
    return candidate;
  }

  if (envVar) {
    const envCandidate = process.env[envVar];
    if (envCandidate && !isDisabledValue(envCandidate)) {
      return envCandidate;
    }
  }

  if (required) {
    const key = envVar ?? path.join('.');
    throw new Error(`Missing required secret for ${key}`);
  }

  return undefined;
};
