#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseDotenv } from "dotenv";

import { resolveAppSettingsPath } from "../evals/app-settings-path";
import {
  assertNoManagedValueConflicts,
  asRecord,
  chmodEnvFilePrivate,
  cleanEnvValue,
  type EnvMergeDisposition,
  type EnvMergePreviewEntry,
  formatEnvMergePreviewEntry,
  planEnvFileMerge,
  readAppSettings,
  sanitizeEnvKeyName,
  writeEnvFileAtomically,
} from "../evals/env-capture-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DISPLAY_PATH = ".env.test";
const OUTPUT_FILENAME = ".env.test";

type Logger = Pick<Console, "log" | "error">;

type SourceEnvKey =
  | "ANTHROPIC_API_KEY"
  | "OPENROUTER_API_KEY"
  | "OPENAI_API_KEY";
type TargetEnvKey =
  | "TEST_ANTHROPIC_API_KEY"
  | "TEST_CLAUDE_API_KEY"
  | "TEST_OPENROUTER_API_KEY"
  | "TEST_OPENAI_API_KEY";

const LIVE_API_KEY_MAPPINGS: ReadonlyArray<{
  source: SourceEnvKey;
  targets: readonly TargetEnvKey[];
}> = [
  {
    source: "ANTHROPIC_API_KEY",
    targets: ["TEST_ANTHROPIC_API_KEY", "TEST_CLAUDE_API_KEY"],
  },
  {
    source: "OPENROUTER_API_KEY",
    targets: ["TEST_OPENROUTER_API_KEY"],
  },
  {
    source: "OPENAI_API_KEY",
    targets: ["TEST_OPENAI_API_KEY"],
  },
];

const LIVE_MANAGED_ENV_KEYS: ReadonlySet<TargetEnvKey> = new Set(
  LIVE_API_KEY_MAPPINGS.flatMap((mapping) => mapping.targets),
);

/**
 * Fallback source for providers whose app auth carries no API key — e.g.
 * Anthropic signed in via OAuth, where app-settings holds an OAuth token and
 * no `apiKey`. The gitignored per-machine eval key file already holds raw
 * `<PROVIDER>_API_KEY=` lines for eval runs, so capture reuses it.
 */
const EVALS_KEYS_ENV_RELATIVE_PATH = path.join(
  "evals",
  "configs",
  ".local",
  "keys.env",
);
const EVALS_KEYS_ENV_DISPLAY_PATH = "evals/configs/.local/keys.env";

/**
 * Managed marker appended to fallback-sourced values in `.env.test`. Baked
 * into the merged VALUE so a re-capture sees the identical string and stays
 * idempotent ("unchanged"), while a drifted underlying key surfaces as the
 * usual requires-`--force` managed update. dotenv (which loads `.env.test`
 * in vitest.setup.ts) strips unquoted inline ` # ...` comments, so tests see
 * the bare key.
 */
export const EVALS_FALLBACK_MARKER = " # source: evals keys.env";

/**
 * Read the eval key file for fallback values. Resolved relative to THIS
 * checkout's repo root: the file is gitignored and per-machine, so a git
 * worktree does NOT inherit the primary checkout's copy — copy it across if
 * capture reports the fallback unavailable. Missing/unreadable file is a
 * normal condition (returns an empty map), not an error.
 */
function readEvalsKeysEnvFallback(repoRoot: string): Map<string, string> {
  const keysEnvPath = path.join(repoRoot, EVALS_KEYS_ENV_RELATIVE_PATH);
  const entries = new Map<string, string>();
  if (!fs.existsSync(keysEnvPath)) {
    return entries;
  }
  const parsed = parseDotenv(fs.readFileSync(keysEnvPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    const cleaned = cleanEnvValue(value);
    if (cleaned !== null) {
      entries.set(key, cleaned);
    }
  }
  return entries;
}

export interface CaptureLiveApiKeysOptions {
  apply?: boolean;
  force?: boolean;
  appSettingsPath?: string;
  appSettings?: Record<string, unknown>;
  repoRoot?: string;
  pid?: number;
  logger?: Logger;
}

export interface CaptureLiveApiPreviewEntry {
  key: TargetEnvKey | string;
  disposition: EnvMergeDisposition;
  fingerprint?: string;
  existingFingerprint?: string;
  capturedFingerprint?: string;
}

export interface CaptureLiveApiKeysResult {
  outputPath: string;
  outputDisplayPath: string;
  envFileContents: string;
  preview: CaptureLiveApiPreviewEntry[];
  capturedCount: number;
  wroteFile: boolean;
}

export interface ParsedLiveApiCliArgs {
  apply: boolean;
  force: boolean;
  appSettingsPath?: string;
  help: boolean;
}

export function buildLiveApiKeysOutputPath(repoRoot: string): string {
  return path.join(repoRoot, OUTPUT_FILENAME);
}

function sourceToDefaultTestKey(sourceKey: SourceEnvKey): TargetEnvKey {
  const base = sourceKey.replace(/_API_KEY$/, "");
  return `TEST_${sanitizeEnvKeyName(base)}_API_KEY` as TargetEnvKey;
}

function buildLiveApiSourceEntries(
  appSettings: Record<string, unknown>,
): Map<SourceEnvKey, string | null> {
  const entries = new Map<SourceEnvKey, string | null>();
  const claudeSettings = asRecord(appSettings.claude);
  entries.set("ANTHROPIC_API_KEY", cleanEnvValue(claudeSettings?.apiKey));

  const providerKeys = asRecord(appSettings.providerKeys);
  entries.set("OPENAI_API_KEY", cleanEnvValue(providerKeys?.openai));

  const providerOpenRouterKey = cleanEnvValue(providerKeys?.openrouter);
  const openRouterSettings = asRecord(appSettings.openRouter);
  const oauthFallback = cleanEnvValue(openRouterSettings?.oauthToken);
  entries.set("OPENROUTER_API_KEY", providerOpenRouterKey ?? oauthFallback);

  return entries;
}

export function buildLiveApiEnvEntries(
  appSettings: Record<string, unknown>,
  evalsKeysFallback: ReadonlyMap<string, string> = new Map(),
): Map<TargetEnvKey, string | null> {
  const credentialCandidates = buildLiveApiSourceEntries(appSettings);
  const entries = new Map<TargetEnvKey, string | null>();

  for (const mapping of LIVE_API_KEY_MAPPINGS) {
    // App settings win; the evals key file only fills providers app settings
    // cannot supply (OAuth auth ⇒ no API key). Fallback-sourced values carry
    // the managed marker so their provenance is visible in .env.test and the
    // merge stays idempotent across re-captures.
    const appSettingsCandidate = credentialCandidates.get(mapping.source) ?? null;
    const fallbackCandidate = evalsKeysFallback.get(mapping.source) ?? null;
    const candidate =
      appSettingsCandidate ??
      (fallbackCandidate === null
        ? null
        : `${fallbackCandidate}${EVALS_FALLBACK_MARKER}`);
    for (const target of mapping.targets) {
      entries.set(target, candidate);
    }
    if (!mapping.targets.includes(sourceToDefaultTestKey(mapping.source))) {
      throw new Error(`Invalid live-API key mapping for ${mapping.source}.`);
    }
  }

  return entries;
}

function printDryRunPreview(
  preview: EnvMergePreviewEntry<TargetEnvKey>[],
  appSettingsPath: string,
  logger: Logger,
): void {
  logger.log(`Dry-run preview from ${appSettingsPath}:`);
  for (const entry of preview) {
    logger.log(`- ${entry.key}: ${formatEnvMergePreviewEntry(entry)}`);
  }
  logger.log(
    `Dry run only. Re-run with --apply to merge captured values into ${OUTPUT_DISPLAY_PATH}; unmanaged lines are preserved.`,
  );
  logger.log(
    `Note: when app settings hold no API key for a provider (e.g. Anthropic signed in via OAuth), capture falls back to ${EVALS_KEYS_ENV_DISPLAY_PATH} (gitignored, per-machine; worktrees need their own copy).`,
  );
}

export function captureLiveApiKeys(
  options: CaptureLiveApiKeysOptions = {},
): CaptureLiveApiKeysResult {
  const logger = options.logger ?? console;
  const apply = options.apply === true;
  const force = options.force === true;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const outputPath = buildLiveApiKeysOutputPath(repoRoot);
  const appSettingsPath =
    options.appSettingsPath ??
    (options.appSettings
      ? "<injected app-settings>"
      : resolveAppSettingsPath());
  const appSettings = options.appSettings ?? readAppSettings(appSettingsPath);
  const evalsKeysFallback = readEvalsKeysEnvFallback(repoRoot);
  const envEntries = buildLiveApiEnvEntries(appSettings, evalsKeysFallback);
  const fallbackSourcedKeys = [...envEntries.entries()]
    .filter(([, value]) => value?.endsWith(EVALS_FALLBACK_MARKER) ?? false)
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));
  if (fallbackSourcedKeys.length > 0) {
    logger.log(
      `Sourced from ${EVALS_KEYS_ENV_DISPLAY_PATH} (no API key in app settings — e.g. OAuth auth): ${fallbackSourcedKeys.join(", ")}. Marked in ${OUTPUT_DISPLAY_PATH} with '${EVALS_FALLBACK_MARKER.trim()}'.`,
    );
  }
  const existingContents = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8")
    : null;
  const mergePlan = planEnvFileMerge({
    existingContents,
    entries: envEntries,
    managedKeys: LIVE_MANAGED_ENV_KEYS,
    force,
  });
  const preview = mergePlan.preview;
  const envFileContents = mergePlan.contents;
  const capturedCount = [...envEntries.values()].filter(
    (value) => value !== null,
  ).length;

  if (!apply) {
    printDryRunPreview(preview, appSettingsPath, logger);
    return {
      outputPath,
      outputDisplayPath: OUTPUT_DISPLAY_PATH,
      envFileContents,
      preview,
      capturedCount,
      wroteFile: false,
    };
  }

  if (!force) {
    assertNoManagedValueConflicts({
      outputDisplayPath: OUTPUT_DISPLAY_PATH,
      conflicts: mergePlan.requiresForceKeys,
    });
  }

  const shouldWrite = existingContents !== envFileContents;
  if (shouldWrite) {
    writeEnvFileAtomically({
      outputPath,
      envFileContents,
      pid: options.pid ?? process.pid,
    });
  } else {
    chmodEnvFilePrivate(outputPath);
  }

  logger.log(
    `Captured ${capturedCount} key(s) to ${OUTPUT_DISPLAY_PATH} (merged; unmanaged lines preserved).`,
  );

  return {
    outputPath,
    outputDisplayPath: OUTPUT_DISPLAY_PATH,
    envFileContents,
    preview,
    capturedCount,
    wroteFile: shouldWrite,
  };
}

export function parseLiveApiCliArgs(argv: string[]): ParsedLiveApiCliArgs {
  const parsed: ParsedLiveApiCliArgs = {
    apply: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (arg === "--apply=false") {
      parsed.apply = false;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--app-settings-path") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Expected a path after --app-settings-path.");
      }
      parsed.appSettingsPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printUsage(logger: Logger): void {
  logger.log(
    [
      "Usage: npx tsx scripts/capture-live-api-keys.ts [--apply] [--force] [--app-settings-path <path>]",
      `Merges captured managed live keys into ${OUTPUT_DISPLAY_PATH}; unmanaged lines are preserved. Use --force only to change existing non-empty managed values.`,
      `Providers without an API key in app settings (e.g. OAuth-auth Anthropic) fall back to ${EVALS_KEYS_ENV_DISPLAY_PATH}; such lines are marker-commented in ${OUTPUT_DISPLAY_PATH}.`,
    ].join("\n"),
  );
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const parsedArgs = parseLiveApiCliArgs(argv);
  if (parsedArgs.help) {
    printUsage(console);
    return;
  }

  captureLiveApiKeys({
    apply: parsedArgs.apply,
    force: parsedArgs.force,
    appSettingsPath: parsedArgs.appSettingsPath,
  });
}

function isDirectExecution(): boolean {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(
      `[capture-live-api-keys] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
