#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAppSettingsPath } from '../../evals/app-settings-path';
import { HermeticEvalConfigSchema, type HermeticEvalConfig } from '../../evals/configs/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT_DISPLAY_PATH = 'evals/configs/.local/default.json';
const SNAPSHOT_PATH_SEGMENTS = ['evals', 'configs', '.local', 'default.json'] as const;
const DEFAULT_WORKING_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENROUTER_SELECTED_MODEL = 'openai/gpt-5.4';

const ACTIVE_PROVIDERS = new Set(['anthropic', 'openrouter', 'codex']);
const MODEL_PROVIDER_TYPES = new Set([
  'anthropic',
  'openai',
  'google',
  'together',
  'cerebras',
  'openrouter',
  'other',
  'local',
]);
const THINKING_EFFORTS = new Set(['xhigh', 'high', 'medium', 'low']);
const PERMISSION_MODES = new Set(['bypassPermissions', 'plan']);
const TOOL_SAFETY_LEVELS = new Set(['permissive', 'balanced', 'cautious']);
const SPACE_TYPES = new Set([
  'chief-of-staff',
  'personal',
  'company',
  'team',
  'project',
  'operator',
  'other',
]);
const SPACE_SHARING_LEVELS = new Set(['private', 'restricted', 'team', 'company-wide', 'public']);
const SPACE_STORAGE_PROVIDERS = new Set([
  'google_drive',
  'onedrive',
  'dropbox',
  'box',
  'icloud',
  'local',
  'other',
]);

type Logger = Pick<Console, 'log' | 'error'>;

export interface SnapshotLiveSettingsOptions {
  apply?: boolean;
  force?: boolean;
  appSettingsPath?: string;
  repoRoot?: string;
  pid?: number;
  logger?: Logger;
}

export interface SnapshotLiveSettingsResult {
  outputPath: string;
  outputDisplayPath: string;
  config: HermeticEvalConfig;
  configContents: string;
  wroteFile: boolean;
  warnings: string[];
}

export interface ParsedCliArgs {
  apply: boolean;
  force: boolean;
  appSettingsPath?: string;
  help: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cleanNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return cleanString(value) ?? undefined;
}

function fingerprintText(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function buildOutputPath(repoRoot: string): string {
  return path.join(repoRoot, ...SNAPSHOT_PATH_SEGMENTS);
}

function readAppSettings(filePath: string): Record<string, unknown> {
  let rawAppSettings: string;
  try {
    rawAppSettings = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read app-settings.json at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawAppSettings);
  } catch (error) {
    throw new Error(
      `Failed to parse app-settings.json at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const appSettings = asRecord(parsed);
  if (!appSettings) {
    throw new Error(`Invalid app-settings.json at ${filePath}: expected a JSON object.`);
  }
  return appSettings;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mapProfiles(
  rawProfiles: unknown,
  warnings: string[],
): HermeticEvalConfig['profiles'] {
  if (!Array.isArray(rawProfiles)) {
    return [];
  }

  const mapped: HermeticEvalConfig['profiles'] = [];
  for (let index = 0; index < rawProfiles.length; index += 1) {
    const profileRaw = asRecord(rawProfiles[index]);
    if (!profileRaw) {
      warnings.push(`Skipping localModel.profiles[${index}] because it is not an object.`);
      continue;
    }

    const id = cleanString(profileRaw.id);
    const name = cleanString(profileRaw.name);
    const serverUrl = cleanString(profileRaw.serverUrl);
    const model = cleanString(profileRaw.model);
    if (!id || !name || !serverUrl || !model) {
      warnings.push(
        `Skipping localModel.profiles[${index}] because id, name, serverUrl, or model is missing.`,
      );
      continue;
    }

    const providerTypeRaw = cleanString(profileRaw.providerType) ?? 'other';
    const providerType = MODEL_PROVIDER_TYPES.has(providerTypeRaw) ? providerTypeRaw : 'other';
    if (providerTypeRaw !== providerType) {
      warnings.push(
        `localModel.profiles[${index}] has unsupported providerType "${providerTypeRaw}"; using "other".`,
      );
    }

    const profile: HermeticEvalConfig['profiles'][number] = {
      id,
      name,
      providerType: providerType as HermeticEvalConfig['profiles'][number]['providerType'],
      serverUrl,
      model,
      createdAt: readNumber(profileRaw.createdAt) ?? 0,
    };

    const customProviderId = cleanString(profileRaw.customProviderId);
    if (customProviderId) {
      profile.customProviderId = customProviderId;
    }

    if (profileRaw.authSource === 'codex-subscription') {
      profile.authSource = 'codex-subscription';
    }

    const reasoningEffort = cleanString(profileRaw.reasoningEffort);
    if (reasoningEffort && THINKING_EFFORTS.has(reasoningEffort)) {
      profile.reasoningEffort = reasoningEffort as HermeticEvalConfig['profiles'][number]['reasoningEffort'];
    } else if (reasoningEffort) {
      warnings.push(
        `Ignoring localModel.profiles[${index}].reasoningEffort "${reasoningEffort}" because it is unsupported.`,
      );
    }

    mapped.push(profile);
  }

  return mapped;
}

function mapCustomProviders(
  rawCustomProviders: unknown,
  warnings: string[],
): HermeticEvalConfig['customProviders'] {
  if (!Array.isArray(rawCustomProviders)) {
    return [];
  }

  const mapped: HermeticEvalConfig['customProviders'] = [];
  for (let index = 0; index < rawCustomProviders.length; index += 1) {
    const providerRaw = asRecord(rawCustomProviders[index]);
    if (!providerRaw) {
      warnings.push(`Skipping customProviders[${index}] because it is not an object.`);
      continue;
    }

    const id = cleanString(providerRaw.id);
    const name = cleanString(providerRaw.name);
    const serverUrl = cleanString(providerRaw.serverUrl);
    if (!id || !name || !serverUrl) {
      warnings.push(
        `Skipping customProviders[${index}] because id, name, or serverUrl is missing.`,
      );
      continue;
    }

    const provider: HermeticEvalConfig['customProviders'][number] = {
      id,
      name,
      serverUrl,
    };

    const providerType = cleanString(providerRaw.providerType);
    if (providerType) {
      provider.providerType = providerType;
    }

    const envVarName = cleanString(providerRaw.envVarName);
    if (envVarName) {
      provider.envVarName = envVarName;
    }

    mapped.push(provider);
  }

  return mapped;
}

function mapTrustedTools(
  rawTrustedTools: unknown,
  warnings: string[],
): NonNullable<NonNullable<HermeticEvalConfig['toolSafety']>['trustedTools']> {
  if (!Array.isArray(rawTrustedTools)) {
    return [];
  }

  const mapped: NonNullable<NonNullable<HermeticEvalConfig['toolSafety']>['trustedTools']> = [];
  for (let index = 0; index < rawTrustedTools.length; index += 1) {
    const toolRaw = asRecord(rawTrustedTools[index]);
    if (!toolRaw) {
      warnings.push(`Skipping trustedTools[${index}] because it is not an object.`);
      continue;
    }

    const toolId = cleanString(toolRaw.toolId);
    if (!toolId) {
      warnings.push(`Skipping trustedTools[${index}] because toolId is missing.`);
      continue;
    }

    const trustedTool: NonNullable<NonNullable<HermeticEvalConfig['toolSafety']>['trustedTools']>[number] = {
      toolId,
      addedAt: readNumber(toolRaw.addedAt) ?? 0,
    };

    const displayName = cleanString(toolRaw.displayName);
    if (displayName) {
      trustedTool.displayName = displayName;
    }

    const serverHint = cleanString(toolRaw.serverHint);
    if (serverHint) {
      trustedTool.serverHint = serverHint;
    }

    mapped.push(trustedTool);
  }

  return mapped;
}

function mapSpaces(
  rawSpaces: unknown,
  warnings: string[],
): HermeticEvalConfig['workspace']['spaces'] {
  if (!Array.isArray(rawSpaces)) {
    return [];
  }

  const mapped: HermeticEvalConfig['workspace']['spaces'] = [];
  for (let index = 0; index < rawSpaces.length; index += 1) {
    const spaceRaw = asRecord(rawSpaces[index]);
    if (!spaceRaw) {
      warnings.push(`Skipping spaces[${index}] because it is not an object.`);
      continue;
    }

    const name = cleanString(spaceRaw.name);
    const spacePath = cleanString(spaceRaw.path);
    if (!name || !spacePath) {
      warnings.push(`Skipping spaces[${index}] because name or path is missing.`);
      continue;
    }

    const typeRaw = cleanString(spaceRaw.type) ?? 'other';
    const type = SPACE_TYPES.has(typeRaw) ? typeRaw : 'other';
    if (typeRaw !== type) {
      warnings.push(`spaces[${index}].type "${typeRaw}" is unsupported; using "other".`);
    }

    const sharingRaw = cleanString(spaceRaw.sharing);
    const sharing = sharingRaw && SPACE_SHARING_LEVELS.has(sharingRaw) ? sharingRaw : undefined;
    if (sharingRaw && !sharing) {
      warnings.push(`Ignoring spaces[${index}].sharing "${sharingRaw}" because it is unsupported.`);
    }

    const storageProviderRaw = cleanString(spaceRaw.storageProvider);
    const storageProvider =
      storageProviderRaw && SPACE_STORAGE_PROVIDERS.has(storageProviderRaw)
        ? storageProviderRaw
        : undefined;
    if (storageProviderRaw && !storageProvider) {
      warnings.push(
        `Ignoring spaces[${index}].storageProvider "${storageProviderRaw}" because it is unsupported.`,
      );
    }

    const space: HermeticEvalConfig['workspace']['spaces'][number] = {
      name,
      path: spacePath,
      type: type as HermeticEvalConfig['workspace']['spaces'][number]['type'],
      isSymlink: readBoolean(spaceRaw.isSymlink) ?? false,
      createdAt: readNumber(spaceRaw.createdAt) ?? 0,
    };

    const sourcePath = cleanString(spaceRaw.sourcePath);
    if (sourcePath) {
      space.sourcePath = sourcePath;
    }
    if (storageProvider) {
      space.storageProvider = storageProvider as HermeticEvalConfig['workspace']['spaces'][number]['storageProvider'];
    }

    const companyName = cleanString(spaceRaw.companyName);
    if (companyName) {
      space.companyName = companyName;
    }

    if (sharing) {
      space.sharing = sharing as HermeticEvalConfig['workspace']['spaces'][number]['sharing'];
    }

    const description = cleanString(spaceRaw.description);
    if (description) {
      space.description = description;
    }

    const writable = readBoolean(spaceRaw.writable);
    if (writable !== undefined) {
      space.writable = writable;
    }

    const hasReadme = readBoolean(spaceRaw.hasReadme);
    if (hasReadme !== undefined) {
      space.hasReadme = hasReadme;
    }

    mapped.push(space);
  }

  return mapped;
}

function mapStringRecord(
  rawRecord: unknown,
  warnings: string[],
  pathLabel: string,
): Record<string, string> | undefined {
  const value = asRecord(rawRecord);
  if (!value) {
    return undefined;
  }

  const mapped: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalized = cleanString(rawValue);
    if (normalized === null) {
      warnings.push(`Ignoring ${pathLabel}.${key} because it is not a non-empty string.`);
      continue;
    }
    mapped[key] = normalized;
  }
  return mapped;
}

export function mapAppSettingsToHermeticConfig(appSettings: Record<string, unknown>): {
  config: HermeticEvalConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  warnings.push(
    'No stable app-settings field maps directly to HermeticEvalConfig.cliProvider; snapshot uses `cliProvider: "auto"`.',
  );
  warnings.push(
    'No stable app-settings field maps directly to HermeticEvalConfig.bundle.background; snapshot leaves `bundle.background` as null.',
  );

  const claudeSettings = asRecord(appSettings.claude);
  const modelsSettings = asRecord(appSettings.models);
  const modelSettings = claudeSettings ?? modelsSettings ?? {};
  if (!claudeSettings && modelsSettings) {
    warnings.push('appSettings.claude is missing; using appSettings.models for model/default mappings.');
  }

  const workingModel = cleanString(modelSettings.model) ?? DEFAULT_WORKING_MODEL;
  if (!cleanString(modelSettings.model)) {
    warnings.push(
      `Missing appSettings.claude.model (or appSettings.models.model); using "${DEFAULT_WORKING_MODEL}" for bundle.working.`,
    );
  }

  const thinkingModelRaw = cleanString(modelSettings.thinkingModel);
  const bundleThinking =
    thinkingModelRaw && thinkingModelRaw !== workingModel ? thinkingModelRaw : null;

  const activeProviderRaw = cleanString(appSettings.activeProvider);
  const activeProvider =
    activeProviderRaw && ACTIVE_PROVIDERS.has(activeProviderRaw)
      ? (activeProviderRaw as HermeticEvalConfig['activeProvider'])
      : undefined;
  if (activeProviderRaw && !activeProvider) {
    warnings.push(
      `Ignoring appSettings.activeProvider "${activeProviderRaw}" because it is unsupported.`,
    );
  }

  const defaults: Partial<HermeticEvalConfig['defaults']> = {};
  const backgroundFallback = cleanString(appSettings.backgroundFallback);
  if (backgroundFallback) {
    defaults.backgroundFallback = backgroundFallback;
  }

  const localInferenceCloudFallback = cleanString(appSettings.localInferenceCloudFallback);
  if (localInferenceCloudFallback) {
    defaults.localInferenceCloudFallback = localInferenceCloudFallback;
  }

  const behindTheScenesModel = cleanString(appSettings.behindTheScenesModel);
  if (behindTheScenesModel) {
    defaults.behindTheScenesModel = behindTheScenesModel;
  }

  const behindTheScenesOverrides = mapStringRecord(
    appSettings.behindTheScenesOverrides,
    warnings,
    'behindTheScenesOverrides',
  );
  if (behindTheScenesOverrides) {
    defaults.behindTheScenesOverrides = behindTheScenesOverrides;
  }

  const permissionModeRaw = cleanString(modelSettings.permissionMode);
  if (permissionModeRaw && PERMISSION_MODES.has(permissionModeRaw)) {
    defaults.permissionMode = permissionModeRaw as HermeticEvalConfig['defaults']['permissionMode'];
  } else if (permissionModeRaw) {
    warnings.push(
      `Ignoring appSettings.claude.permissionMode "${permissionModeRaw}" because it is unsupported.`,
    );
  }

  const longContextFallbackModel = cleanString(modelSettings.longContextFallbackModel);
  if (longContextFallbackModel) {
    defaults.longContextFallbackModel = longContextFallbackModel;
  }

  if (typeof modelSettings.longContextFallbackProfileId === 'string') {
    defaults.longContextFallbackProfileId = modelSettings.longContextFallbackProfileId.trim();
  }

  const thinkingFallback = cleanString(modelSettings.thinkingFallback);
  if (thinkingFallback) {
    defaults.thinkingFallback = thinkingFallback;
  }

  const workingFallback = cleanString(modelSettings.workingFallback);
  if (workingFallback) {
    defaults.workingFallback = workingFallback;
  }

  const openRouterSettings = asRecord(appSettings.openRouter);
  const openRouterEnabled = readBoolean(openRouterSettings?.enabled) ?? false;
  const openRouterSelectedModel =
    cleanString(openRouterSettings?.selectedModel) ?? DEFAULT_OPENROUTER_SELECTED_MODEL;
  const openRouter: HermeticEvalConfig['openRouter'] = {
    enabled: openRouterEnabled,
    selectedModel: openRouterSelectedModel,
  };
  if (openRouterSettings && 'baseUrl' in openRouterSettings) {
    const baseUrl = cleanNullableString(openRouterSettings.baseUrl);
    if (baseUrl !== undefined) {
      openRouter.baseUrl = baseUrl;
    } else {
      warnings.push(
        'Ignoring appSettings.openRouter.baseUrl because it is not a non-empty string/null.',
      );
    }
  }

  const workspace: Partial<HermeticEvalConfig['workspace']> = {};
  const companyName = cleanNullableString(appSettings.companyName);
  if (companyName !== undefined) {
    workspace.companyName = companyName;
  }

  const coreDirectory = cleanNullableString(appSettings.coreDirectory);
  if (coreDirectory !== undefined) {
    workspace.indexSourceCoreDirectory = coreDirectory;
  }

  const mcpConfigFile = cleanNullableString(appSettings.mcpConfigFile);
  if (mcpConfigFile !== undefined) {
    workspace.mcpConfigFile = mcpConfigFile;
  }

  workspace.spaces = mapSpaces(appSettings.spaces, warnings);

  const toolSafetyLevelRaw = cleanString(appSettings.toolSafetyLevel);
  const toolSafetyLevel =
    toolSafetyLevelRaw && TOOL_SAFETY_LEVELS.has(toolSafetyLevelRaw)
      ? (toolSafetyLevelRaw as NonNullable<NonNullable<HermeticEvalConfig['toolSafety']>['level']>)
      : undefined;
  if (toolSafetyLevelRaw && !toolSafetyLevel) {
    warnings.push(
      `Ignoring appSettings.toolSafetyLevel "${toolSafetyLevelRaw}" because it is unsupported.`,
    );
  }

  const trustedTools = mapTrustedTools(appSettings.trustedTools, warnings);
  const toolSafety: HermeticEvalConfig['toolSafety'] =
    toolSafetyLevel || Array.isArray(appSettings.trustedTools)
      ? {
        ...(toolSafetyLevel ? { level: toolSafetyLevel } : {}),
        ...(Array.isArray(appSettings.trustedTools) ? { trustedTools } : {}),
      }
      : undefined;

  const experimentalSettings = asRecord(appSettings.experimental);
  const experimental: Partial<HermeticEvalConfig['experimental']> = {};
  if (experimentalSettings && typeof experimentalSettings.localInferenceEnabled === 'boolean') {
    experimental.localInferenceEnabled = experimentalSettings.localInferenceEnabled;
  }

  const enforceSoftwareEngineerEvidence =
    typeof appSettings.enforceSoftwareEngineerEvidence === 'boolean'
      ? appSettings.enforceSoftwareEngineerEvidence
      : undefined;

  const candidateConfig = {
    schemaVersion: '1.0',
    bundle: {
      thinking: bundleThinking,
      working: workingModel,
      background: null,
    },
    cliProvider: 'auto',
    useCodex: activeProvider === 'codex',
    ...(activeProvider ? { activeProvider } : {}),
    profiles: mapProfiles(asRecord(appSettings.localModel)?.profiles, warnings),
    customProviders: mapCustomProviders(appSettings.customProviders, warnings),
    openRouter,
    defaults,
    workspace,
    ...(toolSafety ? { toolSafety } : {}),
    experimental,
    ...(enforceSoftwareEngineerEvidence !== undefined
      ? { enforceSoftwareEngineerEvidence }
      : {}),
  };

  return {
    config: HermeticEvalConfigSchema.parse(candidateConfig),
    warnings,
  };
}

function ensureWritableOutput(
  outputPath: string,
  nextBytes: Buffer,
  force: boolean,
): { shouldWrite: boolean } {
  if (!fs.existsSync(outputPath)) {
    return { shouldWrite: true };
  }

  const existingBytes = fs.readFileSync(outputPath);
  if (existingBytes.equals(nextBytes)) {
    return { shouldWrite: false };
  }

  if (!force) {
    throw new Error(
      `Refusing to overwrite ${SNAPSHOT_DISPLAY_PATH}: existing fingerprint ${fingerprintText(existingBytes)} does not match new fingerprint ${fingerprintText(nextBytes)}. Re-run with --force to overwrite.`,
    );
  }

  return { shouldWrite: true };
}

function printWarnings(warnings: string[], logger: Logger): void {
  if (warnings.length === 0) {
    return;
  }
  logger.log('Warnings:');
  for (const warning of warnings) {
    logger.log(`- ${warning}`);
  }
}

export function snapshotLiveSettings(
  options: SnapshotLiveSettingsOptions = {},
): SnapshotLiveSettingsResult {
  const logger = options.logger ?? console;
  const apply = options.apply === true;
  const force = options.force === true;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const outputPath = buildOutputPath(repoRoot);
  const appSettingsPath = options.appSettingsPath ?? resolveAppSettingsPath();
  const appSettings = readAppSettings(appSettingsPath);
  const { config, warnings } = mapAppSettingsToHermeticConfig(appSettings);
  const configContents = `${JSON.stringify(config, null, 2)}\n`;
  const configBytes = Buffer.from(configContents, 'utf8');

  if (!apply) {
    logger.log(`Dry-run preview from ${appSettingsPath}.`);
    printWarnings(warnings, logger);
    logger.log(`Dry run only. Re-run with --apply to write ${SNAPSHOT_DISPLAY_PATH}.`);
    return {
      outputPath,
      outputDisplayPath: SNAPSHOT_DISPLAY_PATH,
      config,
      configContents,
      wroteFile: false,
      warnings,
    };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const { shouldWrite } = ensureWritableOutput(outputPath, configBytes, force);
  if (shouldWrite) {
    const tempPath = `${outputPath}.tmp.${options.pid ?? process.pid}`;
    try {
      fs.writeFileSync(tempPath, configContents, { encoding: 'utf8', mode: 0o644 });
      fs.renameSync(tempPath, outputPath);
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }

  fs.chmodSync(outputPath, 0o644);
  printWarnings(warnings, logger);
  logger.log(
    'Snapshotted live settings to evals/configs/.local/default.json. Review and tweak; run with `--config evals/configs/.local/default.json`.',
  );

  return {
    outputPath,
    outputDisplayPath: SNAPSHOT_DISPLAY_PATH,
    config,
    configContents,
    wroteFile: shouldWrite,
    warnings,
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
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (arg === '--force') {
      parsed.force = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--app-settings-path') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Expected a path after --app-settings-path.');
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
    'Usage: npx tsx scripts/eval/snapshot-live-settings.ts [--apply] [--force] [--app-settings-path <path>]',
  );
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const parsedArgs = parseCliArgs(argv);
  if (parsedArgs.help) {
    printUsage(console);
    return;
  }

  snapshotLiveSettings({
    apply: parsedArgs.apply,
    force: parsedArgs.force,
    appSettingsPath: parsedArgs.appSettingsPath,
  });
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(
      `[eval:snapshot-live-settings] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
