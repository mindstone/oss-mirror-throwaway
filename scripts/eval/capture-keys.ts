#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAppSettingsPath } from "../../evals/app-settings-path";
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
} from "../../evals/env-capture-core";

// Canonical home: evals/env-capture-core.ts. Re-exported for existing tests/imports.
export {
  fingerprintValue,
  sanitizeEnvKeyName,
} from "../../evals/env-capture-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const KEYS_ENV_DISPLAY_PATH = "evals/configs/.local/keys.env";
const KEYS_ENV_PATH_SEGMENTS = [
  "evals",
  "configs",
  ".local",
  "keys.env",
] as const;
const LEGACY_ENV_DISPLAY_PATH = ".env" + ".evals";
const LEGACY_ENV_FILENAME = ".env" + ".evals";
const LEGACY_ENV_PATH_SEGMENTS = ["evals", LEGACY_ENV_FILENAME] as const;

const STANDARD_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "TOGETHER_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

type Logger = Pick<Console, "log" | "error">;

export interface CaptureKeysOptions {
  apply?: boolean;
  force?: boolean;
  appSettingsPath?: string;
  repoRoot?: string;
  pid?: number;
  logger?: Logger;
}

export interface CapturePreviewEntry {
  key: string;
  disposition: EnvMergeDisposition;
  fingerprint?: string;
  existingFingerprint?: string;
  capturedFingerprint?: string;
}

export interface CaptureKeysResult {
  outputPath: string;
  outputDisplayPath: string;
  envFileContents: string;
  preview: CapturePreviewEntry[];
  capturedCount: number;
  wroteFile: boolean;
}

export interface ParsedCliArgs {
  apply: boolean;
  force: boolean;
  appSettingsPath?: string;
  help: boolean;
}

function buildOutputPath(repoRoot: string): string {
  return path.join(repoRoot, ...KEYS_ENV_PATH_SEGMENTS);
}

function buildLegacyEnvPath(repoRoot: string): string {
  return path.join(repoRoot, ...LEGACY_ENV_PATH_SEGMENTS);
}

export function extractCredentialCandidates(
  appSettings: Record<string, unknown>,
): Map<string, string | null> {
  const candidates = new Map<string, string | null>();
  for (const standardKey of STANDARD_ENV_KEYS) {
    candidates.set(standardKey, null);
  }

  const claudeSettings = asRecord(appSettings.claude);
  candidates.set("ANTHROPIC_API_KEY", cleanEnvValue(claudeSettings?.apiKey));

  const providerKeys = asRecord(appSettings.providerKeys);
  candidates.set("OPENAI_API_KEY", cleanEnvValue(providerKeys?.openai));
  candidates.set("GOOGLE_API_KEY", cleanEnvValue(providerKeys?.google));
  candidates.set("TOGETHER_API_KEY", cleanEnvValue(providerKeys?.together));
  candidates.set("CEREBRAS_API_KEY", cleanEnvValue(providerKeys?.cerebras));

  const providerOpenRouterKey = cleanEnvValue(providerKeys?.openrouter);
  const openRouterSettings = asRecord(appSettings.openRouter);
  const oauthFallback = cleanEnvValue(openRouterSettings?.oauthToken);
  candidates.set("OPENROUTER_API_KEY", providerOpenRouterKey ?? oauthFallback);

  const customProviders = Array.isArray(appSettings.customProviders)
    ? appSettings.customProviders
    : [];
  for (const customProviderRaw of customProviders) {
    const customProvider = asRecord(customProviderRaw);
    if (!customProvider) {
      continue;
    }
    const name =
      typeof customProvider.name === "string" ? customProvider.name : null;
    if (!name || name.trim().length === 0) {
      continue;
    }

    const envKey = `${sanitizeEnvKeyName(name)}_API_KEY`;
    const apiKey = cleanEnvValue(customProvider.apiKey);
    if (apiKey !== null) {
      candidates.set(envKey, apiKey);
      continue;
    }
    if (!candidates.has(envKey)) {
      candidates.set(envKey, null);
    }
  }

  return candidates;
}

function printDryRunPreview(
  preview: EnvMergePreviewEntry[],
  appSettingsPath: string,
  logger: Logger,
): void {
  logger.log(`Dry-run preview from ${appSettingsPath}:`);
  for (const entry of preview) {
    logger.log(`- ${entry.key}: ${formatEnvMergePreviewEntry(entry)}`);
  }
  logger.log(
    `Dry run only. Re-run with --apply to merge captured values into ${KEYS_ENV_DISPLAY_PATH}; unmanaged lines are preserved.`,
  );
}

export function captureKeys(
  options: CaptureKeysOptions = {},
): CaptureKeysResult {
  const logger = options.logger ?? console;
  const apply = options.apply === true;
  const force = options.force === true;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const outputPath = buildOutputPath(repoRoot);
  const legacyEnvPath = buildLegacyEnvPath(repoRoot);
  if (fs.existsSync(legacyEnvPath) && fs.existsSync(outputPath)) {
    const message = `Both ${LEGACY_ENV_DISPLAY_PATH} (legacy) and ${KEYS_ENV_DISPLAY_PATH} are present. Delete ${LEGACY_ENV_DISPLAY_PATH} to proceed.`;
    logger.error(message);
    throw new Error(message);
  }
  const appSettingsPath = options.appSettingsPath ?? resolveAppSettingsPath();
  const appSettings = readAppSettings(appSettingsPath);
  const credentialCandidates = extractCredentialCandidates(appSettings);
  const managedKeys = new Set(credentialCandidates.keys());
  const existingContents = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8")
    : null;
  const mergePlan = planEnvFileMerge({
    existingContents,
    entries: credentialCandidates,
    managedKeys,
    force,
  });
  const preview = mergePlan.preview;
  const envFileContents = mergePlan.contents;
  const capturedCount = [...credentialCandidates.values()].filter(
    (value) => value !== null,
  ).length;

  if (!apply) {
    printDryRunPreview(preview, appSettingsPath, logger);
    return {
      outputPath,
      outputDisplayPath: KEYS_ENV_DISPLAY_PATH,
      envFileContents,
      preview,
      capturedCount,
      wroteFile: false,
    };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (!force) {
    assertNoManagedValueConflicts({
      outputDisplayPath: KEYS_ENV_DISPLAY_PATH,
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
    `Captured ${capturedCount} key(s) to ${KEYS_ENV_DISPLAY_PATH} (merged; unmanaged lines preserved). Run \`set -a; source ${KEYS_ENV_DISPLAY_PATH}; set +a\` to load them into your shell.`,
  );

  return {
    outputPath,
    outputDisplayPath: KEYS_ENV_DISPLAY_PATH,
    envFileContents,
    preview,
    capturedCount,
    wroteFile: shouldWrite,
  };
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
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
      "Usage: npx tsx scripts/eval/capture-keys.ts [--apply] [--force] [--app-settings-path <path>]",
      `Merges captured managed eval keys into ${KEYS_ENV_DISPLAY_PATH}; unmanaged lines are preserved. Use --force only to change existing non-empty managed values.`,
    ].join("\n"),
  );
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const parsedArgs = parseCliArgs(argv);
  if (parsedArgs.help) {
    printUsage(console);
    return;
  }

  captureKeys({
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
      `[eval:capture-keys] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
