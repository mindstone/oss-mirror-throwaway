/**
 * Settings IPC Handlers
 *
 * Handles all settings:* IPC channels for application configuration,
 * MCP management, and file/directory selection dialogs.
 *
 * Extracted from src/main/index.ts as part of Stage 1 IPC modularization.
 */

import type { BrowserWindow } from 'electron';
import type { HandlerInvokeContext, HandlerInvokeEvent } from '@core/handlerRegistry';
import type { KeyValueStore } from '@core/store';
import { getElectronModule } from '@core/lazyElectron';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { getPlatformConfig } from '@core/platform';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type {
  AppSettings,
  McpServerUpsertPayload,
  McpServerConfigDetails,
  McpRouterPathPatchPayload,
  McpConfigMutationResult,
  ModelProviderType,
  ModelProfile,
  ProviderKeyId,
} from '@shared/types';
import { getWorkingModelProfile } from '@shared/types';
import { logger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';

import { normalizeSettings } from '@shared/utils/settingsUtils';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { applyEfficiencyMode } from '@shared/utils/efficiencyMode';
import { mergeIncomingProfilesPreservingLearned } from '@shared/utils/learnedLimitsMergeGuard';
import { isUserDataReadOnly } from '@core/userDataWriteGate';
import { INTERNAL_ENV_KEYS } from '@core/mcpInternalEnvKeys';
import { normalizeApiKey, resolveProfileApiKey } from '@shared/utils/providerKeys';
import { evaluateProviderReadinessRule } from '@core/services/automation/automationRules';
import { validateProviderCredentials } from '@core/utils/validateProviderCredentials';
import { buildSettingsUpsertRestartContext, buildMcpServerToggleRestartContext } from '@shared/utils/mcpRestartContexts';
import { getApiKey, getOAuthToken } from '@core/rebelCore/settingsAccessors';
import { isWithinRoot } from '@core/utils/pathSafety';
import { getCodexAuthProvider } from '@core/codexAuth';
import { ProviderRouter, resolveProviderRoutePlan } from '@core/rebelCore/providerRouting';
import { isProxyDispatch, type ProviderRouteDecision } from '@core/rebelCore/providerRouteDecision';
import type { ProviderRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import type { ModelChoice, RoleId } from '@shared/types/modelChoice';
import { resolveOpenRouterApiKey } from '../services/localModelProxyServer';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { buildCompletionsUrl } from '@shared/utils/modelNormalization';
import { finalizeChatCompletionsBody } from '@core/services/chatCompletionsParamCapability';
import {
  describeMcpConfiguration,
  resolveMcpConfigPath,
  fetchPackageTools,
  invalidateConnectedPackagesCache,
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution,
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral,
  restartSuperMcpForConfigChangeAndAwaitExecution,
  validateMcpServerAfterConfigChange,
} from '../services/mcpService';
import { superMcpHttpManager } from '../services/superMcpHttpManager';

import { workspaceWatcherService } from '../services/workspaceWatcherService';
import { libraryBroadcaster } from '../services/libraryBroadcaster';
import { clearPluginIdentityCache } from './plugins/shared';
import {
  ensureRouterConfigFile,
  upsertMcpServerEntry,
  patchRouterConfigPaths,
  readMcpServerDetails,
  touchMcpServerLastConnected,
  setMcpToolEnabled,
  setMcpServerDisabled,
  isServerDisabled,
  findExistingCatalogServer,
} from '../services/mcpConfigManager';
import { removeMcpServerWithCleanup } from '../services/mcpServerRemovalService';
import {
  buildSplitRebelInboxPayload,
  buildSplitRebelMeetingsPayload,
  buildSplitRebelSearchAndConversationsPayload,
  buildSplitRebelAutomationsPayload,
  buildSplitRebelSpacesPayload,
  buildSplitRebelSettingsPayload,
  buildSplitRebelMcpConnectorsPayload,
  buildSplitRebelPluginsPayload,
  isSelfConfiguringMcp,
  buildSelfConfiguringMcpPayload,
  getProviderKeyMapping,
  migrateLegacyWrapperSettingsIfNeeded,
  migrateRebelTaskQueueToInbox,
  DISCOURSE_CUSTOM_SERVERS,
  writeDiscourseProfile,
  buildDiscourseWritePayload,
  buildStandaloneDiscoursePayload,
  buildPayloadFromCatalog,
  findRebelOssConnectorsUsingProviderKey,
  lookupCatalogEntry,
  resolveConnectorCatalogPath,
} from '../services/bundledMcpManager';

import { createLibrarySymlink, createAgentsMdSymlink, createClaudeMdSymlink } from '../services/systemSettingsSync';
import { ensureChiefOfStaffSpace } from '../services/spaceService';
import { getUsername } from '../utils/systemUtils';
import { stopWatching as stopFileWatching } from '../services/fileWatcherService';
import { gracefulShutdownServicesOnly } from '../services/gracefulShutdown';
import { rewritePath } from '../services/spaceService';
import { proxyManager } from '../services/localModelProxyServer';
import { getFrequentToolsWithCounts, clearToolUsage } from '../services/toolUsageStore';
import { markJourneyDayComplete, getOnboardingJourney } from '../services/achievementsStore';
import { getCurrentJourneyDay } from '../services/achievementsEvaluator';
import axios from 'axios';
import { z } from 'zod';
import {
  ApiKeyValidationRequestSchema,
  type ApiKeyValidationRequest,
} from '@shared/ipc/contracts';
import { registerHandler } from './utils/registerHandler';
import type { AutomationScheduler } from '../services/automationScheduler';
import {
  VALIDATION_TIMEOUT_MS,
  validateOpenAiKey,
  validateClaudeKey,
  validateElevenLabsKey,
} from '../services/apiKeyValidation';
import { getManagedMcpInstallService } from '../services/managedMcpInstallServiceInstance';
import { startOfficeSidecar, stopOfficeSidecar } from '../services/officeSidecarManager';
import { probeMcpUrlForOAuth } from '@core/services/oauthProbe';
import {
  mergeUpdateModePayload,
  type UpdateModeCatalogSetupField,
} from '../services/mergeUpdateModePayload';

const extractZendeskHostnameFromUserInput = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .split('/')[0]
      .split('?')[0]
      .split('#')[0]
      .split(':')[0];
  }
};

function validateZendeskSubdomain(input: string): string {
  const hostname = extractZendeskHostnameFromUserInput(input);
  let subdomain = hostname.trim().toLowerCase().replace(/\.$/, '');

  if (subdomain.endsWith('.zendesk.com')) {
    subdomain = subdomain.slice(0, -'.zendesk.com'.length);
  }

  if (subdomain.includes('.')) {
    throw new Error(
      'Invalid Zendesk subdomain: should be just the subdomain part (e.g., "acme" for acme.zendesk.com)',
    );
  }

  const singleCharRegex = /^[a-z0-9]$/;
  const multiCharRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

  if (subdomain.length === 0) {
    throw new Error('Zendesk subdomain cannot be empty');
  }

  if (subdomain.length === 1) {
    if (!singleCharRegex.test(subdomain)) {
      throw new Error('Invalid Zendesk subdomain: must contain only letters, numbers, and hyphens');
    }
  } else if (!multiCharRegex.test(subdomain)) {
    throw new Error(
      'Invalid Zendesk subdomain: must contain only letters, numbers, and hyphens, and cannot start or end with a hyphen',
    );
  }

  return subdomain;
}

const hasProviderCredentialRelevantSettingsChange = (
  previous: AppSettings,
  next: AppSettings,
): boolean => {
  if (previous.activeProvider !== next.activeProvider) {
    return true;
  }

  const previousAnthropicKey = normalizeApiKey(getApiKey(previous));
  const nextAnthropicKey = normalizeApiKey(getApiKey(next));
  if (previousAnthropicKey !== nextAnthropicKey) {
    return true;
  }

  if (Boolean(previous.openRouter?.enabled) !== Boolean(next.openRouter?.enabled)) {
    return true;
  }

  const previousOpenRouterToken = normalizeApiKey(previous.openRouter?.oauthToken);
  const nextOpenRouterToken = normalizeApiKey(next.openRouter?.oauthToken);
  return previousOpenRouterToken !== nextOpenRouterToken;
};

const evaluateProviderReadiness = (settings: AppSettings): 'ready' | 'blocked' => {
  const codexConnected = (() => {
    try {
      return getCodexAuthProvider().isConnected();
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'settingsHandlers.evaluateProviderReadiness',
        reason: 'codex-auth-provider-unwired-treat-as-disconnected',
      });
      return false;
    }
  })();
  const credentialState = validateProviderCredentials(settings, codexConnected);
  return evaluateProviderReadinessRule({ credentialState }).status;
};

const didProviderReadinessRepair = (previous: AppSettings, next: AppSettings): boolean =>
  evaluateProviderReadiness(previous) === 'blocked' && evaluateProviderReadiness(next) === 'ready';

const broadcastSettingsExternalUpdate = (): void => {
  try {
    getBroadcastService().sendToAllWindows('settings:external-update');
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'settingsHandlers.broadcastSettingsExternalUpdate',
      reason: 'broadcast-service-unavailable',
    });
  }
};

const triggerSchedulerCatchUpSweep = (getScheduler?: () => AutomationScheduler): void => {
  if (!getScheduler) {
    return;
  }
  try {
    getScheduler().handleAppLaunch();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to trigger automation catch-up sweep after provider credential repair');
  }
};

/**
 * Dependencies injected from main process
 */
export interface SettingsHandlerDeps {
  /** Get the current application settings */
  getSettings: () => AppSettings;
  /** Get the settings store for updates */
  getSettingsStore: () => KeyValueStore<AppSettings>;
  /** Ensure settings are normalized */
  ensureNormalizedSettings: () => void;
  /** Apply voice activation hotkey (non-fatal, returns result) */
  applyVoiceActivationHotkey: (hotkey: string | null) => { success: boolean; error?: string };
  /** Pending hotkey for fallback */
  getPendingVoiceActivationHotkey: () => string | null;
  setPendingVoiceActivationHotkey: (hotkey: string | null) => void;
  /** Broadcast diagnostics update */
  broadcastDiagnosticsUpdate: () => void;
  /** Schedule diagnostics expiry */
  scheduleDiagnosticsExpiry: () => void;
  /** Get window for event sender */
  getWindowForEvent: (sender: HandlerInvokeContext['sender']) => BrowserWindow | null;
  /** Get automation scheduler (optional for cloud service) */
  getScheduler?: () => AutomationScheduler;
}

type CatalogStaticConfigEntry = Record<string, unknown> & {
  mcpConfig?: {
    env?: unknown;
    headers?: unknown;
  };
};

const filterPlaceholderFreeStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const filtered: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue === 'string' && !entryValue.includes('{{')) {
      filtered[key] = entryValue;
    }
  }
  return filtered;
};

const mergeCatalogStaticConfigIntoPayload = async (
  payload: McpServerUpsertPayload,
): Promise<McpServerUpsertPayload> => {
  if (typeof payload.catalogId !== 'string') {
    return payload;
  }

  try {
    const catalogRaw = JSON.parse(await fs.readFile(resolveConnectorCatalogPath(), 'utf8'));
    const catalog = (catalogRaw?.connectors ?? []) as Record<string, unknown>[];
    const catalogEntry = lookupCatalogEntry(payload.catalogId, catalog) as CatalogStaticConfigEntry | undefined;
    if (!catalogEntry) {
      throw new Error(`Catalog entry not found: ${payload.catalogId}`);
    }

    const catalogEnv = filterPlaceholderFreeStringRecord(catalogEntry.mcpConfig?.env);
    const catalogHeaders = filterPlaceholderFreeStringRecord(catalogEntry.mcpConfig?.headers);
    const hasCatalogEnv = Object.keys(catalogEnv).length > 0;
    const hasCatalogHeaders = Object.keys(catalogHeaders).length > 0;

    if (!hasCatalogEnv && !hasCatalogHeaders) {
      return payload;
    }

    return {
      ...payload,
      ...(hasCatalogEnv ? { env: { ...catalogEnv, ...(payload.env ?? {}) } } : {}),
      ...(hasCatalogHeaders ? { headers: { ...catalogHeaders, ...(payload.headers ?? {}) } } : {}),
    };
  } catch (err) {
    logger.warn(
      { err, catalogId: payload.catalogId },
      'Failed to merge catalog static env on upsert; using payload as-is',
    );
    return payload;
  }
};

/**
 * Ensure Ollama is running for a local model profile.
 * Resolves the inference strategy from the model catalog and platform info,
 * then starts (or verifies) the Ollama process.
 */
export async function ensureOllamaForLocalProfile(profile: ModelProfile): Promise<void> {
  const { ollamaService } = await import('../services/ollamaService');
  const { resolveStrategy, CONSERVATIVE_STRATEGY } = await import('@core/services/localInference/inferenceStrategy');
  const { getCatalogEntryByTag } = await import('@core/services/localInference/modelCatalog');

  const catalogEntry = profile.model ? getCatalogEntryByTag(profile.model) : undefined;
  if (!catalogEntry) {
    // Unknown model (not in curated catalog) — start with conservative defaults
    logger.warn({ model: profile.model }, 'Local model not in catalog, using conservative strategy');
    await ollamaService.ensureRunning(CONSERVATIVE_STRATEGY);
    return;
  }

  const totalMemoryGB = getPlatformConfig().totalMemoryBytes / (1024 * 1024 * 1024);
  const desiredContext = profile.contextWindow ?? catalogEntry.contextWindowDefault;
  const { strategy } = resolveStrategy(totalMemoryGB, catalogEntry, desiredContext);

  logger.info({ model: profile.model, strategy: strategy.id }, 'Ensuring Ollama is running for local profile');
  await ollamaService.ensureRunning(strategy);

  // Preload model into VRAM so the first inference request is fast.
  // Ollama's /api/generate with no prompt triggers a load-only operation.
  if (profile.model) {
    try {
      const { OLLAMA_API_URL } = await import('@core/services/localInference/ollamaTypes');
      logger.info({ model: profile.model }, 'Preloading local model into VRAM');
      await fetch(`${OLLAMA_API_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: profile.model, keep_alive: '10m' }),
        signal: AbortSignal.timeout(120_000),
      });
      logger.info({ model: profile.model }, 'Local model preloaded into VRAM');
    } catch (err) {
      logger.warn({ err, model: profile.model }, 'Model preload failed (will load on first request)');
    }
  }
}

/**
 * Register all settings IPC handlers
 */
/** Lazy-load desktop-only electron APIs (dialog, app lifecycle). Returns null in cloud. */
function getDesktopElectron(): typeof import('electron') | null {
  return getElectronModule();
}

function extractJsonCandidate(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1).trim();
  }

  const bracketStart = trimmed.indexOf('[');
  const bracketEnd = trimmed.lastIndexOf(']');
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return trimmed.slice(bracketStart, bracketEnd + 1).trim();
  }

  return trimmed;
}

function isJsonParseable(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    const candidate = extractJsonCandidate(trimmed);
    if (!candidate || candidate === trimmed) return false;
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      return false;
    }
  }
}

function headersToRecord(headers: ProviderRoutePlan['headers']): Record<string, string> {
  return Object.fromEntries(headers.map(([key, value]) => [key, value]));
}

function routePlanChatCompletionsProviderType(plan: ProviderRoutePlan): ModelProviderType | undefined {
  switch (plan.decision.provider) {
    case 'anthropic':
      return 'anthropic';
    case 'codex':
      return 'openai';
    case 'openrouter':
      return 'openrouter';
    case 'local':
      return 'local';
    case 'profile':
      return plan.decision.credentialSource === 'openai-api-key' ? 'openai' : undefined;
  }
}

function providerErrorMessage(error: unknown, fallbackModel: string): string {
  const axiosErr = error as { code?: string; response?: { status?: number; data?: unknown }; message?: string };
  const status = axiosErr?.response?.status;
  const data = axiosErr?.response?.data as Record<string, unknown> | undefined;
  const providerMessage = typeof data?.error === 'string' ? data.error
    : typeof data?.error === 'object' && data.error !== null && typeof (data.error as Record<string, unknown>).message === 'string'
      ? (data.error as Record<string, unknown>).message as string
      : undefined;

  return providerMessage
    ?? (axiosErr?.code === 'ECONNREFUSED' ? 'Could not connect to the model endpoint. Is it running?'
    : axiosErr?.code === 'ECONNABORTED' ? `Request timed out after ${VALIDATION_TIMEOUT_MS / 1000}s.`
    : status === 401 ? 'Authentication failed. Check your provider credentials.'
    : status === 403 ? 'Access denied. Your credentials may lack access to this model.'
    : status === 404 ? `Model "${fallbackModel}" was not found by the selected provider.`
    : status === 429 ? 'Rate limited or quota exceeded. Try again shortly.'
    : axiosErr?.message ?? 'Model test failed.');
}

function modelResponseSnippetFromAnthropic(data: unknown): string | undefined {
  const response = data as { content?: Array<{ type?: string; text?: string }> };
  const text = response.content
    ?.map((block) => block.type === 'text' ? block.text : undefined)
    .filter((part): part is string => Boolean(part))
    .join('');
  return text ? text.slice(0, 120) : undefined;
}

function modelResponseSnippetFromChatCompletions(data: unknown): string | undefined {
  const response = data as { choices?: Array<{ message?: { content?: string } }> };
  const text = response.choices?.[0]?.message?.content;
  return text ? text.slice(0, 120) : undefined;
}

function modelChoiceToRouteInput(args: {
  role: RoleId;
  choice: ModelChoice;
  settings: AppSettings;
  codexConnected: boolean;
}): {
  ok: true;
  input: Parameters<typeof ProviderRouter.forTurn>[0];
} | { ok: false; error: string } {
  const choice = args.choice;
  switch (choice.kind) {
    case 'model':
      return {
        ok: true,
        input: {
          settings: args.settings,
          model: choice.modelId,
          role: args.role === 'thinking' ? 'planning' : 'execution',
          codexConnectivity: args.codexConnected ? 'connected' : 'disconnected',
        },
      };
    case 'profile': {
      const profile = args.settings.localModel?.profiles?.find((candidate) => candidate.id === choice.profileId) ?? null;
      if (!profile) {
        return { ok: false, error: 'Selected profile no longer exists.' };
      }
      return {
        ok: true,
        input: {
          settings: args.settings,
          model: `profile:${choice.profileId}`,
          profile,
          role: args.role === 'thinking' ? 'planning' : 'execution',
          codexConnectivity: args.codexConnected ? 'connected' : 'disconnected',
        },
      };
    }
    case 'inherit':
    case 'auto':
    case 'off':
      return { ok: false, error: 'There is no specific model to test for this choice.' };
    default: {
      const _exhaustive: never = choice;
      return _exhaustive;
    }
  }
}

async function runtimeContextForTestDecision(
  settings: AppSettings,
  decision: ProviderRouteDecision,
): Promise<Parameters<typeof resolveProviderRoutePlan>[1]> {
  let proxyBaseURL: string | null = null;
  let proxyAuthToken: string | null = null;
  if (isProxyDispatch(decision.dispatchPath)) {
    proxyBaseURL = proxyManager.getUrl() ?? await proxyManager.ensureRunningForBts();
    proxyAuthToken = proxyManager.getAuthToken();
  }

  const decisionProfile = decision.profileId
    ? settings.localModel?.profiles?.find((profile) => profile.id === decision.profileId) ?? null
    : null;

  return {
    proxyBaseURL,
    proxyAuthToken,
    turnId: `settings-inline-test-${Date.now()}`,
    anthropicApiKey: getApiKey(settings),
    anthropicOAuthToken: getOAuthToken(settings),
    openRouterOAuthToken: settings.openRouter?.oauthToken ?? resolveOpenRouterApiKey(),
    profileApiKey: decisionProfile
      ? resolveProfileApiKey(decisionProfile, settings.providerKeys, settings.customProviders)
      : null,
    endpointBaseURL: decisionProfile?.serverUrl ?? null,
    codexAuthProvider: getCodexAuthProvider(),
    processEnv: process.env as Record<string, string>,
    logLevel: 'debug',
  };
}

async function probeProviderRoutePlan(plan: ProviderRoutePlan): Promise<{
  success: boolean;
  latencyMs?: number;
  modelResponse?: string;
  error?: string;
}> {
  if (plan.decision.kind === 'terminal') {
    return {
      success: false,
      error: plan.invalidReason
        ? `This model cannot be tested yet: ${plan.invalidReason.replace(/-/g, ' ')}.`
        : 'This model cannot be tested with the current provider settings.',
    };
  }

  const startMs = Date.now();
  const headers = headersToRecord(plan.headers);
  try {
    switch (plan.decision.transport) {
      case 'anthropic-direct':
      case 'openrouter-proxy':
      case 'codex-proxy':
      case 'anthropic-compatible-local-proxy': {
        const baseURL = plan.proxyRequired ? plan.proxyBaseURL : 'https://api.anthropic.com';
        if (!baseURL) {
          return { success: false, error: 'The local provider proxy is not available yet.' };
        }
        const response = await axios.post(
          `${baseURL.replace(/\/$/, '')}/v1/messages`,
          {
            model: plan.decision.wireModelId,
            messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
            max_tokens: 16,
          },
          { headers, timeout: VALIDATION_TIMEOUT_MS },
        );
        return {
          success: true,
          latencyMs: Date.now() - startMs,
          modelResponse: modelResponseSnippetFromAnthropic(response.data),
        };
      }
      case 'openai-compatible-http':
      case 'local-openai-compatible-http': {
        const baseURL = plan.endpoint?.baseURL;
        if (!baseURL) {
          return { success: false, error: 'The model endpoint is missing.' };
        }
        const body = finalizeChatCompletionsBody(
          {
            model: plan.decision.wireModelId,
            messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
            max_completion_tokens: 16,
          },
          {
            modelId: plan.decision.wireModelId,
            providerType: routePlanChatCompletionsProviderType(plan),
            log: logger,
          },
        );
        const response = await axios.post(
          buildCompletionsUrl(baseURL),
          body,
          { headers, timeout: VALIDATION_TIMEOUT_MS },
        );
        return {
          success: true,
          latencyMs: Date.now() - startMs,
          modelResponse: modelResponseSnippetFromChatCompletions(response.data),
        };
      }
    }
    return { success: false, error: 'This model route is not testable yet.' };
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - startMs,
      error: providerErrorMessage(error, plan.decision.wireModelId),
    };
  }
}

function asStringRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractRebelOssPackageSpec(catalogEntry: Record<string, unknown> | undefined): string | null {
  if (!catalogEntry || catalogEntry.provider !== 'rebel-oss') {
    return null;
  }

  const mcpConfig = asStringRecord(catalogEntry.mcpConfig);
  if (!mcpConfig || mcpConfig.command !== 'npx' || !Array.isArray(mcpConfig.args)) {
    throw new Error('Rebel OSS connector catalog entry is missing an npx package spec.');
  }

  const args = mcpConfig.args.filter((arg): arg is string => typeof arg === 'string');
  const yesIndex = args.findIndex((arg) => arg === '-y' || arg === '--yes');
  if (yesIndex === -1 || yesIndex + 1 >= args.length) {
    throw new Error('Rebel OSS connector catalog entry is missing an npx package spec.');
  }

  return args[yesIndex + 1] ?? null;
}

export function registerSettingsHandlers(deps: SettingsHandlerDeps): void {
  const {
    getSettings,
    getSettingsStore,
    ensureNormalizedSettings,
    applyVoiceActivationHotkey,
    getPendingVoiceActivationHotkey: _getPendingVoiceActivationHotkey,
    setPendingVoiceActivationHotkey,
    broadcastDiagnosticsUpdate,
    scheduleDiagnosticsExpiry,
    getWindowForEvent,
    getScheduler,
  } = deps;

  /**
   * Helper to get resolved MCP config path or throw
   */
  const getResolvedMcpPathOrThrow = (): { settings: AppSettings; resolvedPath: string } => {
    ensureNormalizedSettings();
    const settingsStore = getSettingsStore();
    const settings = settingsStore.store;
    const resolvedPath = resolveMcpConfigPath(settings);
    if (!resolvedPath) {
      throw new Error('Configure an MCP config file first.');
    }
    return { settings, resolvedPath };
  };

  /**
   * Check if a file path is within the userData directory.
   * We only modify configs in userData; external configs get wrapped in a router.
   */
  const isPathInUserData = (filePath: string): boolean => {
    const resolved = path.resolve(filePath);
    const userData = path.resolve(getPlatformConfig().userDataPath);
    return isWithinRoot(resolved, userData);
  };

  /**
   * Get the super-mcp router config path in userData
   */
  const getUserDataRouterPath = (): string => {
    return path.join(getPlatformConfig().userDataPath, 'mcp', 'super-mcp-router.json');
  };

  const isOfficeConnectorPayload = (payload: Pick<McpServerUpsertPayload, 'name' | 'catalogId'>): boolean => {
    return payload.name === 'RebelOffice' || payload.catalogId === 'bundled-office';
  };

  /**
   * Upsert an MCP server entry and restart Super-MCP to pick up changes.
   * Settings IPC handler for upsert + restart. The bridge uses a separate
   * path (respondThenReloadSuperMcpForChatMaterialization) because it must send
   * the HTTP response first.
   */
  const upsertMcpServerAndRestart = async (
    configPath: string,
    payload: McpServerUpsertPayload
  ): Promise<{ backupPath: string | null }> => {
    const result = await upsertMcpServerEntry(configPath, payload);
    
    // Restart Super-MCP to pick up the new/updated server.
    // Deliberate execution-awaiting opt-in (260610 API split): settings
    // upsert intentionally waits for the restart to complete.
    try {
      await restartSuperMcpForConfigChangeAndAwaitExecution(configPath, buildSettingsUpsertRestartContext(payload.name));
      logger.debug({ serverName: payload.name }, 'Super-MCP restarted after MCP config change');
    } catch (restartError) {
      logger.warn({ err: restartError, serverName: payload.name }, 'Super-MCP restart failed after MCP config change');
    }
    
    // Day 13: "Connected new MCP" - complete if it's Day 13
    // Skip internal Rebel server (not user-initiated connection)
    if (payload.name !== 'Rebel') {
      const currentDay = getCurrentJourneyDay();
      if (currentDay === 13) {
        const journey = getOnboardingJourney();
        if (journey.journeyStartedAt && !journey.completedDays.includes(13)) {
          markJourneyDayComplete(13);
          logger.info({ serverName: payload.name }, 'Day 13 journey task completed: MCP connected');
        }
      }
    }
    
    return result;
  };

  // -------------------------------------------------------------------------
  // settings:validate-openai-key
  // -------------------------------------------------------------------------
  registerHandler('settings:validate-openai-key', async (_event, reqRaw: unknown) => {
    const parsed = ApiKeyValidationRequestSchema.safeParse(reqRaw);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((e) => e.message).join('; '));
    }
    const req = parsed.data as ApiKeyValidationRequest;
    return validateOpenAiKey(req.apiKey, {
      organizationId: req.organizationId,
      modelId: req.modelId,
      deepValidate: req.deepValidate,
    });
  });

  // -------------------------------------------------------------------------
  // settings:validate-claude-key
  // -------------------------------------------------------------------------
  registerHandler('settings:validate-claude-key', async (_event, reqRaw: unknown) => {
    const parsed = ApiKeyValidationRequestSchema.safeParse(reqRaw);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((e) => e.message).join('; '));
    }
    const req = parsed.data as ApiKeyValidationRequest;
    return validateClaudeKey(req.apiKey, { modelId: req.modelId });
  });

  // -------------------------------------------------------------------------
  // settings:validate-elevenlabs-key
  // -------------------------------------------------------------------------
  registerHandler('settings:validate-elevenlabs-key', async (_event, reqRaw: unknown) => {
    const parsed = ApiKeyValidationRequestSchema.safeParse(reqRaw);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((e) => e.message).join('; '));
    }
    const req = parsed.data as ApiKeyValidationRequest;
    return validateElevenLabsKey(req.apiKey);
  });

  // -------------------------------------------------------------------------
  // settings:get
  // -------------------------------------------------------------------------
  registerHandler('settings:get', () => {
    return getSettings();
  });

  // -------------------------------------------------------------------------
  // settings:update
  // -------------------------------------------------------------------------
  registerHandler('settings:update', async (_event, incoming: Partial<AppSettings>) => {
    // Shallow-merge the incoming payload over the current persisted settings
    // BEFORE any normalization/write. The renderer (and other callers) may send
    // either a full settings document or a bare partial (e.g. `{ cloudInstance }`
    // from the cloud-provisioning flow). Treating a bare partial as the whole
    // document and running it through `normalizeSettings` back-fills every missing
    // field with DEFAULTS — most damagingly `onboardingCompleted` → false
    // (re-onboarding) and `voice` → defaults (wiping STT credentials). Merging over
    // `previous` makes a partial update incapable of dropping unrelated fields.
    //
    // This mirrors the core `updateSettings()` helper (`@core/services/settingsStore`,
    // `normalizeSettings({ ...current, ...partial })`) and the cloud-side
    // `PATCH /api/settings` route, both of which already merge partials. A shallow
    // top-level merge is sufficient: every caller sends nested objects (`voice`,
    // `models`, `cloudInstance`, …) whole, and no caller relies on full-replace
    // semantics to delete a top-level key by omission — field removal is done by
    // sending an explicit cleared value (e.g. `CLOUD_INSTANCE_CLEARED` on disconnect),
    // not by omission. See docs/plans/260622_mobile-setup-investigation.
    //
    // The cloud dual-write forward (ElectronHandlerRegistry → cloudRouter.forward)
    // receives the ORIGINAL `args` (the bare partial) independently and merges it
    // cloud-side, so this local merge does not affect cloud parity.
    const previous = getSettings();
    let next: AppSettings = { ...previous, ...incoming };

    // Efficiency Mode coordination (260524_performance_mode):
    // When the master toggle transitions, route through `applyEfficiencyMode`
    // so the baseline-snapshot + write-through (or restore) happens atomically
    // server-side. This guarantees correctness regardless of which sub-setting
    // values the renderer happens to send in the same payload.
    const requestedMode = next.efficiencyMode;
    const isTransition =
      (requestedMode === 'on' || requestedMode === 'off') &&
      previous.efficiencyMode !== requestedMode;
    // Server-side enforcement of the Efficiency Mode invariant. Two cases:
    //   (1) A real transition: route through the helper so the baseline is
    //       snapshotted on enable / restored on disable, regardless of which
    //       sub-setting values the renderer happened to send.
    //   (2) An unchanged `on` payload (e.g. a stale full-settings save raced
    //       with a concurrent enable): re-apply the Efficiency preset so the
    //       sub-settings and baseline cannot be silently regressed. This is
    //       cheap because `applyEfficiencyMode` is pure and idempotent —
    //       enabling-when-already-on preserves the existing baseline.
    if (isTransition || requestedMode === 'on') {
      const transformed = applyEfficiencyMode(previous, requestedMode === 'on');
      next = {
        ...next,
        efficiencyMode: transformed.efficiencyMode,
        efficiencyModeBaseline: transformed.efficiencyModeBaseline,
        dailySparkMode: transformed.dailySparkMode,
        heroChoiceRunMode: transformed.heroChoiceRunMode,
        timeSavedEstimation: transformed.timeSavedEstimation,
        personaQuipsEnabled: transformed.personaQuipsEnabled,
        cpuEmbeddingIdleDisposalEnabled: transformed.cpuEmbeddingIdleDisposalEnabled,
      };
      if (isTransition) {
        logger.info(
          { from: previous.efficiencyMode ?? 'off', to: requestedMode },
          'Efficiency Mode transition applied (write-through with baseline backup)',
        );
        // Mid-flight cancellation: abort any in-flight delight LLM calls so
        // they don't write to the cost ledger / store after the user has opted out.
        if (requestedMode === 'on') {
          const { abortEfficiencyModeInFlight } = await import('../services/efficiencyModeSignal');
          abortEfficiencyModeInFlight();
        }
      }
    }

    const normalized = normalizeSettings(next);
    // Stage 2: preserve locally-stored auto-learned provenance against
    // stale cloud-sync writes (a fresh ceiling that hasn't yet round-tripped
    // through the cloud must not be overwritten by an older incoming doc).
    // See docs/plans/260503_unify_learned_limits_into_profiles.md.
    const guarded = mergeIncomingProfilesPreservingLearned(getSettings(), normalized);
    const migrated = await migrateLegacyWrapperSettingsIfNeeded(guarded);
    const hasCredentialRelevantChange = hasProviderCredentialRelevantSettingsChange(previous, migrated);
    const shouldTriggerCredentialRepairCatchUp =
      hasCredentialRelevantChange && didProviderReadinessRepair(previous, migrated);

    if (isUserDataReadOnly()) {
      // Return the normalized input so the renderer's draft stays in sync
      // with what the user sees. The store write would be silently blocked
      // by the version-gate proxy anyway; returning stale stored values
      // causes the UI to revert user selections after auto-save.
      return migrated;
    }

    // Migrate RebelTaskQueue to RebelInbox in MCP config if needed
    const mcpConfigPath = resolveMcpConfigPath(migrated);
    if (mcpConfigPath) {
      try {
        await migrateRebelTaskQueueToInbox(mcpConfigPath);
      } catch {
        // Ignore migration errors - not critical
      }
    }

    const settingsStore = getSettingsStore();
    const previousSettings = settingsStore.store;
    settingsStore.store = migrated;

    // When the user explicitly removes their Anthropic API key, synchronously
    // clear it from the cached auth config so applyAuthConfigToSettings won't
    // re-provision it on the next auth config event.
    if (getApiKey(previousSettings) && !getApiKey(migrated)) {
      getRebelAuthProvider().clearCachedProviderKey('anthropic');
    }

    // Try to register hotkey but don't fail settings save if it can't be registered
    // (e.g., on Linux where Ctrl+Alt+Space may be used by the desktop environment)
    // Note: applyVoiceActivationHotkey is non-fatal and returns a result instead of throwing
    const hotkeyResult = applyVoiceActivationHotkey(migrated.voice.activationHotkey ?? null);
    if (!hotkeyResult.success) {
      logger.warn({ error: hotkeyResult.error }, 'Voice activation hotkey registration failed - settings saved but hotkey unavailable');
      setPendingVoiceActivationHotkey(migrated.voice.activationHotkey ?? null);
    }

    // Note: Google Workspace feature flag only gates the UI for adding new accounts.
    // Existing accounts/MCPs are never removed based on feature flag state - users can
    // remove them explicitly via Settings > Connectors if desired.

    // Create symlinks and Chief-of-Staff space when workspace is configured
    if (migrated.coreDirectory && migrated.coreDirectory !== previousSettings.coreDirectory) {
      // Stage 4 invalidation: new workspace → plugin-identity membership is
      // workspace-scoped, so every coreDirectory transition must flush the cache.
      // (The workspace-rename path at `settings:rename-workspace` relaunches
      // the app, so its cache is moot; this `settings:update` path does not.)
      clearPluginIdentityCache('settings:update-coreDirectory-changed');
      const coreDir = migrated.coreDirectory; // captured for use in callbacks (TS can't narrow across async closures)
      createLibrarySymlink(coreDir)
        .then(() => createAgentsMdSymlink(coreDir))
        .then(() => createClaudeMdSymlink(coreDir))
        .then(() => ensureChiefOfStaffSpace(coreDir, undefined, {
          // FOX-3072: let the repair sync back into settings.spaces so checkSpaceSharingConfig
          // stays green and isVerifiedChiefOfStaff remains authoritative.
          getSpaces: () => getSettings().spaces,
          updateSpaces: (spaces) => {
            const store = getSettingsStore();
            store.store = normalizeSettings({ ...store.store, spaces });
          },
        }))
        .then(() => {
          // Semantic file indexing is now opt-in via workspace panel
          logger.debug({ coreDirectory: coreDir }, 'Workspace changed, semantic indexing available on-demand');
        })
        .catch((error) => {
          logger.warn({ err: error }, 'Failed to create workspace symlinks/spaces or start file indexing');
        });

      // Trigger shared drive reconciliation when workspace is first configured
      // Only fires when coreDirectory transitions from null → value (onboarding completion)
      // If auth config isn't cached yet, fetchAuthConfig will handle reconciliation instead
      if (!previousSettings.coreDirectory) {
        const driveConfig = getRebelAuthProvider().getSharedDriveConfig();
        if (driveConfig) {
          import('../services/sharedDriveService').then(({ reconcileSharedDriveSpaces }) => {
            fireAndForget(reconcileSharedDriveSpaces(driveConfig), 'settingsHandlers.reconcileSharedDriveSpaces');
          }).catch((err) => {
            logger.warn({ err }, 'Failed to import sharedDriveService for reconciliation');
          });
        }
      }

      // Update workspace file watcher to new directory (for UI refresh)
      // New consolidated watcher (runs alongside old for testing)
      workspaceWatcherService.start(migrated.coreDirectory);
      libraryBroadcaster.start();

      // Restart SuperMCP so REBEL_WORKSPACE_PATH env var picks up new workspace
      superMcpHttpManager.requestDebouncedRestartWhenIdle({
        configPath: resolveMcpConfigPath(migrated) ?? getUserDataRouterPath(),
        context: 'workspace-change',
      }).catch((err) => {
        logger.warn({ err }, 'SuperMCP restart failed after workspace change');
      });
    } else if (!migrated.coreDirectory && previousSettings.coreDirectory) {
      // Workspace was removed - stop watching
      clearPluginIdentityCache('settings:update-coreDirectory-removed');
      fireAndForget(workspaceWatcherService.stop(), 'settingsHandlers.workspaceWatcherStop');
      fireAndForget(stopFileWatching(), 'settingsHandlers.stopFileWatching');

      // Restart SuperMCP to clear stale REBEL_WORKSPACE_PATH
      superMcpHttpManager.requestDebouncedRestartWhenIdle({
        configPath: resolveMcpConfigPath(migrated) ?? getUserDataRouterPath(),
        context: 'workspace-removal',
      }).catch((err) => {
        logger.warn({ err }, 'SuperMCP restart failed after workspace removal');
      });
    }

    // Local model proxy lifecycle management
    const previousProfile = getWorkingModelProfile(previousSettings);
    const currentProfile = getWorkingModelProfile(migrated);

    // Debug: log profile state changes
    logger.debug(
      {
        previousActiveId: previousSettings.localModel?.activeProfileId,
        currentActiveId: migrated.localModel?.activeProfileId,
        previousProfileCount: previousSettings.localModel?.profiles?.length ?? 0,
        currentProfileCount: migrated.localModel?.profiles?.length ?? 0,
        previousProfileName: previousProfile?.name ?? null,
        currentProfileName: currentProfile?.name ?? null,
        isProxyRunning: proxyManager.isRunning(),
      },
      'Local model proxy lifecycle check'
    );

    if (currentProfile && !previousProfile) {
      // Profile just activated — ensure Ollama running for local profiles, then start proxy
      const activateProfile = async (): Promise<void> => {
        if (currentProfile.providerType === 'local') {
          await ensureOllamaForLocalProfile(currentProfile);
        }
        await proxyManager.setBaseProfile(currentProfile);
        logger.info({ proxyUrl: proxyManager.getUrl(), profileName: currentProfile.name }, 'Local model proxy server started');
      };
      activateProfile().catch((error) => {
        logger.error({ err: error }, 'Failed to start local model proxy server');
      });
    } else if (!currentProfile && previousProfile) {
      // Profile just deactivated — clearBaseProfile auto-stops if no council routes
      logger.info(
        { previousProfileName: previousProfile.name, previousActiveId: previousProfile.id },
        'Stopping proxy due to profile deactivation'
      );
      proxyManager.clearBaseProfile();
      // Stop Ollama when switching away from a local profile
      if (previousProfile.providerType === 'local') {
        import('../services/ollamaService').then(({ ollamaService }) => {
          ollamaService.stop().catch((err) => {
            logger.warn({ err }, 'Failed to stop Ollama after local profile deactivation');
          });
        }).catch((err) => {
          logger.warn({ err }, 'Failed to import ollamaService for deactivation');
        });
      }
    } else if (currentProfile && previousProfile && proxyManager.isRunning()) {
      // Check if profile changed or profile settings changed
      const profileChanged =
        currentProfile.id !== previousProfile.id ||
        currentProfile.serverUrl !== previousProfile.serverUrl ||
        currentProfile.model !== previousProfile.model ||
        currentProfile.apiKey !== previousProfile.apiKey;

      if (profileChanged) {
        // If switching to a local profile (or between local profiles), ensure Ollama is running
        const updateProfile = async (): Promise<void> => {
          if (currentProfile.providerType === 'local') {
            await ensureOllamaForLocalProfile(currentProfile);
          }
          await proxyManager.setBaseProfile(currentProfile);
          logger.info({ proxyUrl: proxyManager.getUrl(), profileName: currentProfile.name }, 'Local model proxy base profile updated');
        };
        updateProfile().catch((error) => {
          logger.error({ err: error }, 'Failed to update local model proxy profile');
        });
        // Stop Ollama if switching FROM local to a cloud profile
        if (previousProfile.providerType === 'local' && currentProfile.providerType !== 'local') {
          import('../services/ollamaService').then(({ ollamaService }) => {
            ollamaService.stop().catch((err) => {
              logger.warn({ err }, 'Failed to stop Ollama after switching away from local profile');
            });
          }).catch((err) => {
            logger.warn({ err }, 'Failed to import ollamaService for profile switch');
          });
        }
      }
    }

    // GPU embedding backend lifecycle management
    // Check if GPU embedding setting changed, or if the Efficiency Mode-controlled
    // CPU embedding idle-disposal flag changed. The CPU flag is read by the
    // embedding service via `updateCpuIdleDisposalFromSettings`, which is also
    // invoked from `applyEmbeddingBackendFromSettings`. Without this branch a
    // user toggling Efficiency Mode persists `cpuEmbeddingIdleDisposalEnabled`
    // but the live timer doesn't activate until the next restart or unrelated
    // GPU change. See `docs/plans/260524_performance_mode.md`.
    const gpuSettingChanged = migrated.gpuEmbeddingEnabled !== previousSettings.gpuEmbeddingEnabled;
    const cpuIdleDisposalChanged =
      migrated.cpuEmbeddingIdleDisposalEnabled !== previousSettings.cpuEmbeddingIdleDisposalEnabled;
    if (gpuSettingChanged || cpuIdleDisposalChanged) {
      // Import dynamically to avoid circular dependencies at module load time
      import('../services/embeddingService').then(({ applyEmbeddingBackendFromSettings }) => {
        applyEmbeddingBackendFromSettings(migrated)
          .then(() => {
            logger.info(
              {
                gpuEnabled: migrated.gpuEmbeddingEnabled !== false,
                cpuIdleDisposal: migrated.cpuEmbeddingIdleDisposalEnabled,
                trigger: gpuSettingChanged ? 'gpu' : 'cpu-idle-disposal',
              },
              'Embedding backend settings applied',
            );
          })
          .catch((error) => {
            logger.warn({ err: error }, 'Failed to apply embedding backend settings');
          });
      }).catch((err) => {
        logger.error({ err }, 'Failed to import embeddingService for GPU settings');
      });
    }

    // Calendar sync mode switching
    // Toggle between direct MCP sync (free) and LLM automation (for other calendars)
    const calendarSettingChanged = 
      migrated.calendar?.useOtherCalendarProvider !== previousSettings.calendar?.useOtherCalendarProvider;
    if (calendarSettingChanged) {
      // Sync automation enabled state with the setting (synchronous, before async direct-sync toggle)
      if (getScheduler) {
        try {
          getScheduler().setCalendarSyncAutomationEnabled(!!migrated.calendar?.useOtherCalendarProvider);
        } catch (err) {
          logger.warn({ err }, 'Failed to sync calendar automation enabled state');
        }
      }

      // Import dynamically to avoid circular dependencies
      import('../services/calendarSyncScheduler').then(async ({ startDirectCalendarSync, stopDirectCalendarSync }) => {
        if (migrated.calendar?.useOtherCalendarProvider) {
          // User enabled "other calendars" - stop direct sync, LLM automation will handle it
          logger.info('Switching to LLM-based calendar sync (other calendar providers enabled)');
          await stopDirectCalendarSync();
        } else {
          // User disabled "other calendars" - start direct sync
          logger.info('Switching to direct calendar sync (Google/Microsoft only)');
          fireAndForget(startDirectCalendarSync(), 'settingsHandlers.startDirectCalendarSync');
        }
      }).catch((err) => {
        logger.error({ err }, 'Failed to switch calendar sync mode');
      });
    }

    const selectedCalendarsChanged =
      JSON.stringify(migrated.calendar?.selectedCalendars ?? {}) !==
      JSON.stringify(previousSettings.calendar?.selectedCalendars ?? {});
    if (selectedCalendarsChanged && !migrated.calendar?.useOtherCalendarProvider) {
      import('../services/calendarSyncScheduler').then(async ({ triggerDirectCalendarSync }) => {
        logger.info('Calendar selection changed; triggering direct calendar sync');
        await triggerDirectCalendarSync();
      }).catch((err) => {
        logger.error({ err }, 'Failed to trigger direct calendar sync after calendar selection change');
      });
    }

    // Generic providerKeys-rotation handler — covers OpenAI Image, nano-banana,
    // gamma, and any future rebel-oss connector declaring providerKeyMapping in
    // bundledConfig. Replaces the OpenAI-specific block deleted at Stage 2a.
    const configPath = resolveMcpConfigPath(migrated);
    if (configPath) {
      const providerIds = new Set<ProviderKeyId>([
        ...(Object.keys(previousSettings.providerKeys ?? {}) as ProviderKeyId[]),
        ...(Object.keys(migrated.providerKeys ?? {}) as ProviderKeyId[]),
      ]);

      for (const providerId of providerIds) {
        const previousProviderKey = normalizeApiKey(previousSettings.providerKeys?.[providerId]);
        const currentProviderKey = normalizeApiKey(migrated.providerKeys?.[providerId]);
        if (previousProviderKey === currentProviderKey) {
          continue;
        }

        const cohort = await findRebelOssConnectorsUsingProviderKey(providerId);
        for (const connector of cohort) {
          try {
            const payload = await buildPayloadFromCatalog(
              connector.catalogEntry as Parameters<typeof buildPayloadFromCatalog>[0],
              {
                email: connector.email,
                providerKeys: migrated.providerKeys,
                workspacePath: migrated.coreDirectory ?? undefined,
              },
            );
            if (!payload) continue;
            payload.name = connector.serverName;
            await upsertMcpServerAndRestart(configPath, payload);
          } catch (err) {
            logger.warn(
              {
                err,
                providerId,
                catalogId: connector.catalogId,
                serverName: connector.serverName,
              },
              'Failed to restart rebel-oss connector after provider key change',
            );
          }
        }
      }
    }

    if (hasCredentialRelevantChange) {
      broadcastSettingsExternalUpdate();
    }
    if (shouldTriggerCredentialRepairCatchUp) {
      triggerSchedulerCatchUpSweep(getScheduler);
    }

    broadcastDiagnosticsUpdate();
    scheduleDiagnosticsExpiry();
    return settingsStore.store;
  });

  // -------------------------------------------------------------------------
  // settings:get-default-workspace
  // -------------------------------------------------------------------------
  registerHandler('settings:get-default-workspace', () => {
    const platform = getPlatformConfig();
    // On Windows, default to %USERPROFILE%\Mindstone Rebel (e.g. C:\Users\jamie\Mindstone Rebel)
    // to avoid Controlled Folder Access (CFA) blocking writes to Documents.
    // CFA protects Documents, Pictures, Videos, Music, Favorites by default — but NOT
    // the user profile root itself. This matches the pattern of OneDrive/Dropbox.
    // On macOS/Linux, keep the existing Documents default (CFA is Windows-only).
    const parentDir = platform.platform === 'win32'
      ? platform.homePath
      : platform.documentsPath;
    const suggested = path.join(parentDir, 'Mindstone Rebel');
    return suggested;
  });

  // -------------------------------------------------------------------------
  // settings:choose-directory
  // -------------------------------------------------------------------------
  registerHandler('settings:choose-directory', async (
    event: HandlerInvokeEvent,
    payload?: { defaultPath?: string },
  ) => {
    const electron = getDesktopElectron();
    if (!electron) return null;
    const win = getWindowForEvent(event?.sender);
    const result = await electron.dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: payload?.defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // -------------------------------------------------------------------------
  // settings:choose-file
  // -------------------------------------------------------------------------
  registerHandler('settings:choose-file', async (
    event: HandlerInvokeEvent,
    filters?: Electron.FileFilter[],
  ) => {
    const electron = getDesktopElectron();
    if (!electron) return null;
    const win = getWindowForEvent(event?.sender);
    const result = await electron.dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
      properties: ['openFile'],
      filters:
        filters && filters.length > 0
          ? filters
          : [
              {
                name: 'Prompt & Config Files',
                extensions: ['txt', 'md', 'json', 'jsonc', 'yaml', 'yml']
              }
            ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // -------------------------------------------------------------------------
  // settings:choose-file-in-directory
  // -------------------------------------------------------------------------
  // Opens a file picker starting in a specific directory.
  // If returnRelative is true, returns the path relative to baseDir.
  // If the selected file is outside baseDir, returns null.
  registerHandler('settings:choose-file-in-directory', async (
    event: HandlerInvokeEvent,
    payload: { baseDir: string; filters?: Electron.FileFilter[]; returnRelative?: boolean },
  ) => {
    const electron = getDesktopElectron();
    if (!electron) return null;
    const { baseDir, filters, returnRelative } = payload;
    const win = getWindowForEvent(event?.sender);
    
    const result = await electron.dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
      defaultPath: baseDir,
      properties: ['openFile'],
      filters: filters && filters.length > 0
        ? filters
        : [{ name: 'Skill files', extensions: ['md'] }]
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    
    const selectedPath = result.filePaths[0];
    const resolvedBase = path.resolve(baseDir);
    const resolvedSelected = path.resolve(selectedPath);
    
    // Ensure the selected file is within the base directory
    if (!isWithinRoot(resolvedSelected, resolvedBase)) {
      logger.warn({ selectedPath, baseDir }, 'Selected file is outside the allowed directory');
      return null;
    }
    
    if (returnRelative) {
      return path.relative(resolvedBase, resolvedSelected);
    }
    
    return selectedPath;
  });

  // -------------------------------------------------------------------------
  // settings:choose-directory-in-directory
  // -------------------------------------------------------------------------
  // Opens a directory picker starting in a specific directory.
  // If returnRelative is true, returns the path relative to baseDir.
  // If the selected directory is outside baseDir, returns null.
  registerHandler('settings:choose-directory-in-directory', async (
    event: HandlerInvokeEvent,
    payload: { baseDir: string; returnRelative?: boolean },
  ) => {
    const electron = getDesktopElectron();
    if (!electron) return null;
    const { baseDir, returnRelative } = payload;
    const win = getWindowForEvent(event?.sender);
    
    const result = await electron.dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
      defaultPath: baseDir,
      properties: ['openDirectory']
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    
    const selectedPath = result.filePaths[0];
    const resolvedBase = path.resolve(baseDir);
    const resolvedSelected = path.resolve(selectedPath);
    
    // Ensure the selected directory is within the base directory
    if (!isWithinRoot(resolvedSelected, resolvedBase)) {
      logger.warn({ selectedPath, baseDir }, 'Selected directory is outside the allowed directory');
      return null;
    }
    
    if (returnRelative) {
      return path.relative(resolvedBase, resolvedSelected);
    }
    
    return selectedPath;
  });

  // -------------------------------------------------------------------------
  // settings:choose-executable
  // -------------------------------------------------------------------------
  registerHandler('settings:choose-executable', async (event: HandlerInvokeEvent) => {
    const electron = getDesktopElectron();
    if (!electron) return null;
    const win = getWindowForEvent(event?.sender);
    const result = await electron.dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // -------------------------------------------------------------------------
  // settings:mcp-summary
  // -------------------------------------------------------------------------
  registerHandler('settings:mcp-summary', async (_event, params?: { settings?: AppSettings | null; skipMetadata?: boolean }) => {
    const override = params?.settings;
    const skipMetadata = params?.skipMetadata ?? false;
    if (override) {
      try {
        const normalizedOverride = normalizeSettings(override);
        return await describeMcpConfiguration(normalizedOverride, skipMetadata);
      } catch (error) {
        logger.error({ err: error }, 'Failed to describe MCP summary for override settings');
        throw error;
      }
    }
    const settings = getSettings();
    return await describeMcpConfiguration(settings, skipMetadata);
  });

  // -------------------------------------------------------------------------
  // settings:mcp-ensure-managed
  // -------------------------------------------------------------------------
  // Creates the Super-MCP router config file if it doesn't exist.
  // The router can contain direct mcpServers entries and/or configPaths for external configs.
  registerHandler('settings:mcp-ensure-managed', async () => {
    const routerPath = getUserDataRouterPath();
    try {
      await ensureRouterConfigFile(routerPath);
      logger.info({ configPath: routerPath }, 'Ensured Super-MCP router config exists');
    } catch (error) {
      logger.error({ err: error, configPath: routerPath }, 'Failed to create Super-MCP router config file');
      throw new Error('Unable to create Super-MCP router config file.');
    }
    return { configPath: routerPath };
  });

  // -------------------------------------------------------------------------
  // settings:mcp-get-server
  // -------------------------------------------------------------------------
  registerHandler('settings:mcp-get-server', async (_event, serverName: string) => {
    const { resolvedPath } = getResolvedMcpPathOrThrow();
    try {
      return await readMcpServerDetails(resolvedPath, serverName);
    } catch (error) {
      logger.error({ err: error, resolvedPath, serverName }, 'Failed to load MCP server details');
      throw error instanceof Error ? error : new Error('Unable to load MCP server details.');
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-list-tools
  // -------------------------------------------------------------------------
  // List tools for a specific MCP server with pagination support.
  // Used by the tool visibility UI to display tools within a connector.
  registerHandler('settings:mcp-list-tools', async (_event, reqRaw: unknown) => {
    // Validate request shape
    const parsed = z.object({
      serverId: z.string().min(1),
      pageToken: z.string().nullable().optional(),
    }).safeParse(reqRaw);
    if (!parsed.success) {
      throw new Error(`Invalid request: ${parsed.error.issues.map((e) => e.message).join('; ')}`);
    }
    const { serverId, pageToken } = parsed.data;

    try {
      const result = await fetchPackageTools(serverId, pageToken);
      return result;
    } catch (error) {
      // Preserve error details from Super-MCP (which may throw { code, message, data })
      const errMsg = error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : 'Unable to list MCP tools.';
      logger.error({ err: error, serverId }, 'Failed to list MCP tools');
      throw new Error(errMsg);
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-add-rebel-server
  // -------------------------------------------------------------------------
  registerHandler('settings:mcp-add-rebel-server', async () => {
    const { settings, resolvedPath } = getResolvedMcpPathOrThrow();
    try {
      // Add split Rebel MCPs (meetings only when unlocked)
      const payloads = [
        buildSplitRebelInboxPayload(),
        ...(settings.meetingBotUnlocked === true ? [buildSplitRebelMeetingsPayload()] : []),
        buildSplitRebelSearchAndConversationsPayload(),
        buildSplitRebelAutomationsPayload(),
        buildSplitRebelSpacesPayload(),
        buildSplitRebelSettingsPayload(),
        buildSplitRebelMcpConnectorsPayload(),
        buildSplitRebelPluginsPayload()
      ];
      let result: { backupPath?: string | null } = {};
      for (const payload of payloads) {
        result = await upsertMcpServerAndRestart(resolvedPath, payload);
      }
      // Skip router metadata/health fetching - it's slow (talks to Super-MCP) and can spawn MCPs.
      const summary = await describeMcpConfiguration(settings, true);
      const response: McpConfigMutationResult = {
        summary,
        backupPath: result.backupPath ?? undefined
      };
      return response;
    } catch (error) {
      logger.error({ err: error, resolvedPath }, 'Failed to add split Rebel MCPs');
      throw error instanceof Error ? error : new Error('Unable to add split Rebel MCP servers.');
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-add-bundled-server
  // -------------------------------------------------------------------------
  // Adds a bundled MCP server with optional credentials.
  // - API-key MCPs with credentialEnvVars: credentials passed via env vars
  // - OAuth MCPs: authenticate_* tools handle OAuth flow
  registerHandler('settings:mcp-add-bundled-server', async (_event, request: { 
    serverName: string;
    apiKey?: string;
    credentials?: Record<string, string>;
    email?: string;
    scopeTier?: 'readonly' | 'full';
    catalogId?: string;
    mode?: 'create' | 'update';
  }) => {
    const { settings, resolvedPath } = getResolvedMcpPathOrThrow();
    const { serverName, apiKey, credentials } = request;
    const mode = request.mode ?? 'create';
    // Normalize email: trim whitespace, treat empty as undefined
    const email = request.email?.trim() || undefined;

    let existingUpdateEntry: McpServerConfigDetails | null = null;
    if (mode === 'update') {
      try {
        existingUpdateEntry = await readMcpServerDetails(resolvedPath, request.serverName);
      } catch {
        throw new Error('Cannot update — connector entry not found');
      }
    }
    
    // Discourse connectors use profile-file auth (not env vars or BUNDLED_MCP_CATALOG).
    // RebelsCommunityWrite uses OAuth (User API Key flow) — profile is written by discourseAuthService.
    // Standalone Discourse uses admin API key entered via setupFields.
    if ((DISCOURSE_CUSTOM_SERVERS as readonly string[]).includes(serverName)) {
      let payload: McpServerUpsertPayload;
      if (serverName === 'RebelsCommunityWrite') {
        // OAuth flow: profile already written by discourseAuthService, just register the MCP
        payload = buildDiscourseWritePayload();
      } else {
        const apiKey = credentials?.apiKey?.trim() || '';
        const apiUsername = credentials?.apiUsername?.trim() || '';
        if (!apiKey || !apiUsername) {
          throw new Error('Discourse API Key and Username are required.');
        }
        const siteUrl = credentials?.siteUrl?.trim() || '';
        if (!siteUrl) {
          throw new Error('Discourse Site URL is required.');
        }
        try { new URL(siteUrl); } catch {
          throw new Error('Invalid Discourse Site URL. Must be a valid URL (e.g., https://community.example.com).');
        }
        let hostname: string;
        try { hostname = new URL(siteUrl).hostname; } catch { hostname = siteUrl; }
        await writeDiscourseProfile(`discourse-${hostname}`, { siteUrl, apiKey, apiUsername });
        payload = buildStandaloneDiscoursePayload({ siteUrl, apiKey, apiUsername });
      }

      const result = await upsertMcpServerAndRestart(resolvedPath, payload);
      const summary = await describeMcpConfiguration(settings, true);
      return { summary, backupPath: result.backupPath } as McpConfigMutationResult;
    }

    // Check if this is a known bundled or rebel-oss connector.
    //
    // Rebel-oss connectors are matched by EITHER:
    //   - explicit catalogId on the request (preferred — canonical identifier), OR
    //   - the runtime serverName matching catalog `bundledConfig.serverName` (legacy/create-mode).
    //
    // Update-mode callers pass the existing super-mcp-router.json entry name as `serverName`,
    // which can diverge from `bundledConfig.serverName` (e.g. an entry keyed "Runway ML" when
    // the catalog now uses "Runway"). Without the catalogId fallback we'd reject the update.
    const isRebelOssConnector = !isSelfConfiguringMcp(serverName) && (() => {
      const catalogRaw = JSON.parse(fsSync.readFileSync(resolveConnectorCatalogPath(), 'utf8'));
      const connectors = (catalogRaw?.connectors ?? []) as Array<{ id?: string; provider?: string; bundledConfig?: { serverName?: string } }>;
      if (request.catalogId) {
        if (connectors.some(c => c.provider === 'rebel-oss' && c.id === request.catalogId)) {
          return true;
        }
      }
      return connectors.some(c => c.provider === 'rebel-oss' && c.bundledConfig?.serverName === serverName);
    })();

    if (!isSelfConfiguringMcp(serverName) && !isRebelOssConnector) {
      throw new Error(`Unknown bundled server: ${serverName}`);
    }

    // rebel-oss connectors MUST go through buildPayloadFromCatalog — they don't exist in BUNDLED_MCP_CATALOG.
    // If catalogId is missing, look it up from the catalog by serverName.
    const effectiveCatalogId = request.catalogId ?? (isRebelOssConnector
      ? (() => {
        const catalogRaw = JSON.parse(fsSync.readFileSync(resolveConnectorCatalogPath(), 'utf8'));
        const connectors = (catalogRaw?.connectors ?? []) as Array<{ id?: string; provider?: string; bundledConfig?: { serverName?: string } }>;
        return connectors.find(c => c.provider === 'rebel-oss' && c.bundledConfig?.serverName === serverName)?.id;
      })()
      : undefined);

    if (mode === 'update' && existingUpdateEntry) {
      const existingCatalogId = existingUpdateEntry.catalogId ?? null;
      const incomingCatalogId = effectiveCatalogId ?? null;
      const existingEmail = existingUpdateEntry.email?.trim().toLowerCase() ?? '';
      const incomingEmail = email?.toLowerCase() ?? '';
      if (existingCatalogId !== incomingCatalogId || existingEmail !== incomingEmail) {
        throw new Error('Connector identity mismatch — refusing to update');
      }
    }

    // Side-file connectors (Discourse standalone) keep credentials in a separate
    // accounts/profile file. v1 update mode requires all fields re-supplied so the side-file
    // stays in sync — silently merging from the side-file is a follow-up.

    if (serverName === 'OpenAIImageGeneration' || effectiveCatalogId === 'openai-image-generation') {
      const openaiKey = settings.providerKeys?.openai?.trim() ?? '';
      if (!openaiKey) {
        throw new Error('Add an OpenAI API key in Settings → Provider Keys before connecting Image Generation.');
      }
    }

    // Build payload: use catalog-aware path when catalogId is provided (handles multi-entry MCPs like EmailImap)
    // rebel-oss connectors with mcpConfig also flow through here (no special early return needed)
    let payload: McpServerUpsertPayload;
    let catalogEntryForInstall: Record<string, unknown> | undefined;

    if (effectiveCatalogId) {
      const catalogRaw = JSON.parse(fsSync.readFileSync(resolveConnectorCatalogPath(), 'utf8'));
      const catalog = (catalogRaw?.connectors ?? []) as Record<string, unknown>[];
      const catalogEntry = lookupCatalogEntry(effectiveCatalogId, catalog);
      if (catalogEntry) {
        catalogEntryForInstall = catalogEntry;
        const builtPayload = await buildPayloadFromCatalog(
          catalogEntry as Parameters<typeof buildPayloadFromCatalog>[0],
          {
            email,
            setupFields: credentials,
            providerKeys: settings.providerKeys,
            workspacePath: settings.coreDirectory ?? undefined,
            scopeTier: request.scopeTier,
          },
        );
        if (!builtPayload) {
          throw new Error(`Connector "${effectiveCatalogId}" is handled out-of-band but no registration path is available.`);
        }
        payload = builtPayload;
      } else {
        payload = await buildSelfConfiguringMcpPayload(serverName, {
          email,
          apiKey: apiKey || undefined,
          credentials: credentials && Object.keys(credentials).length > 0 ? credentials : undefined,
          scopeTier: request.scopeTier,
        });
      }
    } else {
      payload = await buildSelfConfiguringMcpPayload(serverName, {
        email,
        apiKey: apiKey || undefined,
        credentials: credentials && Object.keys(credentials).length > 0 ? credentials : undefined,
        scopeTier: request.scopeTier,
      });
    }
    
    // Idempotent upsert: if a server with the same catalogId (+ email for multi-instance) already exists,
    // update it in place using the existing entry's server name so credential rotation / reconfigure
    // targets the existing entry instead of creating a duplicate. The underlying upsertMcpServerAndRestart
    // uses replace semantics on payload.name, so overwriting payload.name with the existing name makes
    // the write target the same config key.
    if (payload.catalogId) {
      const existing = await findExistingCatalogServer(resolvedPath, payload.catalogId, email);
      if (existing.exists && existing.serverName) {
        logger.info(
          { catalogId: payload.catalogId, email, existingServerName: existing.serverName, incomingName: payload.name },
          'Existing MCP server matched by catalogId+email; performing in-place update',
        );
        payload.name = existing.serverName;
      }
    }

    if (mode === 'update' && existingUpdateEntry) {
      // Refuse if the resolved upsert target diverges from the entry whose secrets we plan to
      // preserve. Without this guard, the merge would copy old credentials from
      // request.serverName into a save written to a different config key — masking a real
      // identity collision behind a successful save.
      if (payload.name !== existingUpdateEntry.name) {
        throw new Error('Connector identity mismatch — refusing to update');
      }
      const catalogSetupFields = Array.isArray(catalogEntryForInstall?.setupFields)
        ? catalogEntryForInstall.setupFields as UpdateModeCatalogSetupField[]
        : [];
      payload = mergeUpdateModePayload(
        existingUpdateEntry,
        payload,
        catalogSetupFields,
        INTERNAL_ENV_KEYS,
      );
    }
    
    try {
      const packageSpec = extractRebelOssPackageSpec(catalogEntryForInstall);
      const connectorDisplayName = typeof catalogEntryForInstall?.name === 'string'
        ? catalogEntryForInstall.name
        : payload.name;
      if (packageSpec) {
        const managedInstallService = getManagedMcpInstallService();
        if (!managedInstallService) {
          logger.error(
            { packageSpec, catalogId: payload.catalogId, serverName: payload.name },
            'Managed MCP install service unavailable while preparing rebel-oss connector',
          );
          throw new Error(`Couldn't prepare ${connectorDisplayName} — install service is not ready. Please retry.`);
        }

        logger.info(
          { packageSpec, catalogId: payload.catalogId, serverName: payload.name },
          'Preparing rebel-oss connector managed install before enabling',
        );
        try {
          await managedInstallService.install({ packageSpec });
        } catch (installError) {
          logger.error(
            { packageSpec, catalogId: payload.catalogId, serverName: payload.name, err: installError },
            'Managed MCP install failed while preparing rebel-oss connector',
          );
          throw new Error(`Couldn't prepare ${connectorDisplayName} — install failed. Please retry.`);
        }
      }

      const result = await upsertMcpServerAndRestart(resolvedPath, payload);

      if (isOfficeConnectorPayload(payload)) {
        try {
          await startOfficeSidecar();
        } catch (sidecarError) {
          logger.error(
            { packageSpec, catalogId: payload.catalogId, serverName: payload.name, err: sidecarError },
            'Office sidecar start after add failed',
          );
          throw new Error("Couldn't start Microsoft Office — sidecar failed to start. Please retry.");
        }
      }

      // If this connector uses a shared provider key, save it for reuse
      const mapping = getProviderKeyMapping(serverName);
      if (mode === 'create' && mapping && apiKey) {
        const providerIds = Object.values(mapping);
        if (providerIds.length > 0) {
          const currentSettings = getSettings();
          const updatedKeys = { ...currentSettings.providerKeys };
          for (const providerId of providerIds) {
            if (providerId && !updatedKeys[providerId]) {
              updatedKeys[providerId] = apiKey;
            }
          }
          const settingsStore = getSettingsStore();
          settingsStore.store = normalizeSettings({ ...currentSettings, providerKeys: updatedKeys });
        }
      }

      const summary = await describeMcpConfiguration(settings, true);
      const response: McpConfigMutationResult = {
        summary,
        backupPath: result.backupPath
      };
      return response;
    } catch (error) {
      logger.error({ err: error, resolvedPath, serverName }, 'Failed to add bundled MCP server');
      throw error instanceof Error ? error : new Error(`Unable to add bundled MCP server: ${serverName}`);
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-validate-server
  // -------------------------------------------------------------------------
  registerHandler('settings:mcp-validate-server', async (_event, request: { serverName: string }) => {
    const { resolvedPath } = getResolvedMcpPathOrThrow();
    const serverName = request.serverName.trim();
    if (!serverName) {
      throw new Error('Server name is required.');
    }

    const validation = await validateMcpServerAfterConfigChange(serverName);
    if (validation.status === 'ok') {
      await touchMcpServerLastConnected(resolvedPath, serverName);
    }
    return validation;
  });

  // -------------------------------------------------------------------------
  // settings:mcp-upsert-server
  // -------------------------------------------------------------------------
  registerHandler('settings:mcp-upsert-server', async (_event, payload: McpServerUpsertPayload) => {
    const { settings, resolvedPath } = getResolvedMcpPathOrThrow();
    // ── Auto-detect OAuth for custom HTTP/SSE URLs added via Settings UI ──
    // Mirrors the agent-driven path in bundledInboxBridge.ts. Users adding a custom
    // MCP through AddConnectionModal / ExpandedConnectionCard / ToolsTab typically
    // don't know whether the URL requires OAuth; probe with an unauthenticated
    // `initialize` and flip `oauth: true` on a 401. Fail closed on 'unknown'
    // (timeouts, typos) so we never trigger spurious browser popups.
    //
    // Only runs when: caller did not explicitly set `oauth`, `url` is present and
    // http(s) (skipping stdio servers with a url field via the probe's own guard).
    if (
      payload.oauth !== true &&
      payload.oauth !== false &&
      typeof payload.url === 'string' &&
      payload.url.trim().length > 0
    ) {
      try {
        const probe = await probeMcpUrlForOAuth(payload.url);
        if (probe.classification === 'oauth') {
          logger.info({ serverName: payload.name, url: payload.url, statusCode: probe.statusCode }, 'OAuth probe classified server as OAuth; setting oauth:true on payload');
          payload = { ...payload, oauth: true };
        }
      } catch (probeErr) {
        logger.warn({ err: probeErr, serverName: payload.name, url: payload.url }, 'OAuth probe threw unexpectedly; continuing without classification');
      }
    }
    payload = await mergeCatalogStaticConfigIntoPayload(payload);
    try {
      const result = await upsertMcpServerAndRestart(resolvedPath, payload);
      // Skip metadata fetching - it's slow (talks to Super-MCP) and will be stale
      const summary = await describeMcpConfiguration(settings, true);
      const response: McpConfigMutationResult = {
        summary,
        backupPath: result.backupPath
      };
      return response;
    } catch (error) {
      logger.error({ err: error, resolvedPath }, 'Failed to upsert MCP server');
      throw error;
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-remove-server
  // -------------------------------------------------------------------------
  registerHandler('settings:mcp-remove-server', async (_event, serverName: string) => {
    const { settings, resolvedPath } = getResolvedMcpPathOrThrow();
    try {
      // Use centralized removal service for consistent cleanup
      // (removes config entry, tool stats, refreshes caches and Super-MCP)
      const result = await removeMcpServerWithCleanup(resolvedPath, serverName);

      if (serverName === 'RebelOffice') {
        void stopOfficeSidecar().catch((err) => {
          logger.warn({ err }, 'office-sidecar stop after remove failed');
        });
      }
      
      // Skip metadata fetching - it's slow and stale after restart
      const summary = await describeMcpConfiguration(settings, true);
      const response: McpConfigMutationResult = {
        summary,
        backupPath: result.backupPath
      };
      return response;
    } catch (error) {
      logger.error({ err: error, resolvedPath, serverName }, 'Failed to remove MCP server');
      throw error;
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-router-path
  // -------------------------------------------------------------------------
  // Smart router path handling:
  // - If current config is in userData → modify it directly
  // - If current config is external → create router in userData, migrate, then modify
  registerHandler('settings:mcp-router-path', async (_event, payload: McpRouterPathPatchPayload) => {
    const settingsStore = getSettingsStore();
    ensureNormalizedSettings();
    const settings = settingsStore.store;
    const currentConfigPath = resolveMcpConfigPath(settings);
    const routerPath = getUserDataRouterPath();

    try {
      let targetPath: string;
      let didMigrate = false;

      if (!currentConfigPath) {
        // No config exists - create router in userData
        await ensureRouterConfigFile(routerPath);
        settingsStore.store = normalizeSettings({ ...settings, mcpConfigFile: routerPath });
        targetPath = routerPath;
        logger.info({ configPath: routerPath }, 'Created router config for mcp-router-path (no existing config)');
      } else if (isPathInUserData(currentConfigPath)) {
        // Config is in userData - we can modify it directly
        targetPath = currentConfigPath;
      } else {
        // Config is external - create router in userData, add external config to it
        await ensureRouterConfigFile(routerPath);
        // Add the external config to configPaths
        const externalExists = await fs.access(currentConfigPath).then(() => true).catch(() => false);
        if (externalExists) {
          await patchRouterConfigPaths(routerPath, { action: 'add', path: currentConfigPath });
          logger.info({ configPath: routerPath, externalConfig: currentConfigPath }, 'Added external config to new router');
        }
        // Update pointer to router
        settingsStore.store = normalizeSettings({ ...settings, mcpConfigFile: routerPath });
        targetPath = routerPath;
        didMigrate = true;
        logger.info({ configPath: routerPath, previousConfig: currentConfigPath }, 'Migrated to router config for external config');
      }

      // Now add/remove the requested path
      const result = await patchRouterConfigPaths(targetPath, payload);
      const newSettings = settingsStore.store;
      // Skip router metadata/health fetching - it's slow (talks to Super-MCP) and can spawn MCPs.
      const summary = await describeMcpConfiguration(newSettings, true);

      // If we migrated, reconfigure Super-MCP HTTP with full cache refresh.
      // Resolve-on-deferral, NOT Detached (merge synthesis, see the three-form
      // chooser in mcpService): the response `summary` is computed above and
      // nothing below reads router state, so when the restart defers behind
      // active agent turns this resolves promptly ({ queued: true }) instead
      // of pinning the IPC; the idle path still awaits the executed restart.
      // Context byte-identical.
      if (didMigrate && superMcpHttpManager.isConfigured()) {
        try {
          const { queued } = await reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral(routerPath, { context: 'settings-migration' });
          logger.info({ queued, configPath: routerPath }, 'Super-MCP reconfigure requested after settings migration');
        } catch (httpErr) {
          logger.warn({ err: httpErr }, 'Failed to reconfigure Super-MCP HTTP after migration');
        }
      } else {
        // Just invalidate cache if no migration (no reconfigure needed)
        invalidateConnectedPackagesCache();
      }

      const response: McpConfigMutationResult = {
        summary,
        backupPath: result.backupPath
      };
      return response;
    } catch (error) {
      logger.error({ err: error, payload }, 'Failed to patch Super-MCP config paths');
      throw error;
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-restart-super-mcp
  // -------------------------------------------------------------------------
  // Restarts Super-MCP HTTP server with automatic retry logic.
  registerHandler('settings:mcp-restart-super-mcp', async () => {
    try {
      // Ensure config file exists
      ensureNormalizedSettings();
      const settingsStore = getSettingsStore();
      const settings = settingsStore.store;
      
      // Get config path from settings, or create default router in userData
      let configPath = resolveMcpConfigPath(settings);
      if (!configPath) {
        configPath = getUserDataRouterPath();
        await ensureRouterConfigFile(configPath);
        settingsStore.store = normalizeSettings({
          ...settings,
          mcpConfigFile: configPath
        });
        logger.info({ configPath }, 'Created Super-MCP router config during restart');
      }
      
      // Deliberate Stage 7 UX call: Settings manual restart now waits behind
      // active agent turns instead of killing the router mid-turn.
      // Execution-awaiting opt-in by name (260610 API split): the response
      // below genuinely depends on the restart having completed (isRunning).
      await restartSuperMcpForConfigChangeAndAwaitExecution(configPath, 'settings-manual-restart');
      const state = superMcpHttpManager.getState();
      if (state.isRunning) {
        logger.info(
          { state, configPath },
          'Super-MCP HTTP server restarted via IPC'
        );
        
        return {
          success: true,
          isRunning: state.isRunning,
          port: state.port || undefined,
          url: state.url || undefined
        };
      } else {
        logger.error(
          { state, configPath },
          'Super-MCP HTTP server restart request completed but manager is not running'
        );
        return {
          success: false,
          isRunning: false,
          error: 'Super-MCP restart did not leave the manager running'
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restart Super-MCP';
      logger.error({ err: error }, 'Failed to restart Super-MCP HTTP server');
      return {
        success: false,
        isRunning: false,
        error: message
      };
    }
  });

  // -------------------------------------------------------------------------
  // settings:ensure-workspace-symlinks
  // -------------------------------------------------------------------------
  // Creates workspace symlinks synchronously (awaits completion).
  // Called during onboarding to ensure rebel-system is available for the agent.
  registerHandler('settings:ensure-workspace-symlinks', async () => {
    const settings = getSettings();
    const coreDirectory = settings.coreDirectory;

    if (!coreDirectory) {
      logger.debug('ensure-workspace-symlinks: no coreDirectory configured');
      return { success: false, rebelSystemPath: null };
    }

    try {
      await createLibrarySymlink(coreDirectory);
      await createAgentsMdSymlink(coreDirectory);
      await createClaudeMdSymlink(coreDirectory);
      // Auto-populate USERNAME for Chief-of-Staff template
      const username = getUsername();
      const variables = username ? { USERNAME: username } : undefined;
      await ensureChiefOfStaffSpace(coreDirectory, variables, {
        // FOX-3072: settings-side reconciliation on repair.
        getSpaces: () => getSettings().spaces,
        updateSpaces: (spaces) => {
          const store = getSettingsStore();
          store.store = normalizeSettings({ ...store.store, spaces });
        },
      });

      const rebelSystemPath = path.join(coreDirectory, 'rebel-system');
      logger.info({ coreDirectory, rebelSystemPath }, 'Workspace symlinks created successfully');
      return { success: true, rebelSystemPath };
    } catch (error) {
      logger.error({ err: error, coreDirectory }, 'Failed to create workspace symlinks');
      return { success: false, rebelSystemPath: null };
    }
  });

  // -------------------------------------------------------------------------
  // settings:test-local-model
  // -------------------------------------------------------------------------
  // Test connection to an OpenAI-compatible local model server and list available models.
  registerHandler('settings:test-local-model', async (_event, { serverUrl }) => {
    try {
      // Normalize URL (remove trailing slash)
      const baseUrl = serverUrl.replace(/\/$/, '');
      
      // Use OpenAI-compatible /v1/models endpoint (works with LocalAI, Ollama, LM Studio, vLLM)
      const response = await axios.get(`${baseUrl}/v1/models`, { timeout: 5000 });
      const models = response.data?.data?.map((m: Record<string, unknown>) => m.id) ?? [];
      logger.info({ serverUrl, modelCount: models.length }, 'Local model connection test succeeded');
      return { success: true, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      const isConnectError = message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT');
      const friendlyMessage = isConnectError
        ? `Could not connect to server at ${serverUrl}. Is the server running?`
        : message;
      logger.warn({ err: error, serverUrl }, 'Local model connection test failed');
      return { success: false, error: friendlyMessage };
    }
  });

  // -------------------------------------------------------------------------
  // settings:test-model-profile
  // -------------------------------------------------------------------------
  // Test a model profile by sending a minimal chat completion request.
  // Returns success/failure, latency, and a snippet of the model's response.
  registerHandler('settings:test-model-profile', async (_event, req) => {
    const { serverUrl, model, apiKey, providerType, customProviderId } = req;
    const settings = getSettings();
    let resolvedKey = resolveProfileApiKey(
      { apiKey: apiKey ?? undefined, providerType: (providerType ?? 'other') as ModelProviderType, customProviderId },
      settings.providerKeys,
      settings.customProviders,
    );
    // OpenRouter uses OAuth tokens stored in encrypted storage (desktop) or settings (cloud)
    if (!resolvedKey && providerType === 'openrouter') {
      resolvedKey = resolveOpenRouterApiKey();
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolvedKey) {
      headers['Authorization'] = `Bearer ${resolvedKey}`;
    }
    const completionsUrl = buildCompletionsUrl(serverUrl);
    const startMs = Date.now();
    try {
      const basicProbeBody = finalizeChatCompletionsBody(
        {
          model: model || undefined,
          messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
          max_completion_tokens: 16,
        },
        { modelId: model || undefined, providerType: providerType as ModelProviderType | undefined, log: logger },
      );
      const response = await axios.post(
        completionsUrl,
        basicProbeBody,
        { headers, timeout: VALIDATION_TIMEOUT_MS },
      );
      const latencyMs = Date.now() - startMs;
      const content = response.data?.choices?.[0]?.message?.content ?? '';
      let jsonIncompatible: boolean | undefined;
      try {
        const jsonProbeBody = finalizeChatCompletionsBody(
          {
            model: model || undefined,
            messages: [
              { role: 'system', content: 'Respond with valid JSON only.' },
              {
                role: 'user',
                content: 'Respond with exactly this JSON object and nothing else: {"status":"ok"}',
              },
            ],
            max_completion_tokens: 32,
            response_format: { type: 'json_object' },
          },
          { modelId: model || undefined, providerType: providerType as ModelProviderType | undefined, log: logger },
        );
        const jsonResponse = await axios.post(
          completionsUrl,
          jsonProbeBody,
          { headers, timeout: VALIDATION_TIMEOUT_MS },
        );
        const jsonContent = jsonResponse.data?.choices?.[0]?.message?.content ?? '';
        jsonIncompatible = isJsonParseable(jsonContent) ? false : true;
      } catch (jsonProbeError: unknown) {
        const jsonAxiosErr = jsonProbeError as { code?: string; response?: { status?: number } };
        logger.warn(
          { serverUrl, model, code: jsonAxiosErr?.code, status: jsonAxiosErr?.response?.status },
          'Model profile JSON capability probe failed; leaving compatibility unknown',
        );
      }
      let thinkingIncompatible: boolean | undefined;
      try {
        // CHAT_COMPLETIONS_CHOKEPOINT_ALLOWLIST: intentionally sends raw reasoning_effort to test endpoint support.
        await axios.post(
          completionsUrl,
          {
            model: model || undefined,
            messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
            max_completion_tokens: 16,
            reasoning_effort: 'low',
          },
          { headers, timeout: VALIDATION_TIMEOUT_MS },
        );
        thinkingIncompatible = false;
      } catch (thinkingProbeError: unknown) {
        const thinkingAxiosErr = thinkingProbeError as { code?: string; response?: { status?: number } };
        const thinkingStatus = thinkingAxiosErr?.response?.status;
        if (thinkingStatus === 400 || thinkingStatus === 422) {
          thinkingIncompatible = true;
        } else {
          logger.warn(
            { serverUrl, model, code: thinkingAxiosErr?.code, status: thinkingStatus },
            'Model profile thinking capability probe failed; leaving compatibility unknown',
          );
        }
      }
      let toolUseIncompatible: boolean | undefined;
      try {
        const toolUseProbeBody = finalizeChatCompletionsBody(
          {
            model: model || undefined,
            messages: [{ role: 'user', content: 'What is the weather?' }],
            max_completion_tokens: 32,
            tools: [{
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the current weather',
                parameters: { type: 'object', properties: { location: { type: 'string' } } },
              },
            }],
          },
          { modelId: model || undefined, providerType: providerType as ModelProviderType | undefined, log: logger },
        );
        await axios.post(
          completionsUrl,
          toolUseProbeBody,
          { headers, timeout: VALIDATION_TIMEOUT_MS },
        );
        toolUseIncompatible = false;
      } catch (toolUseProbeError: unknown) {
        const toolUseAxiosErr = toolUseProbeError as { code?: string; response?: { status?: number; data?: unknown } };
        const toolUseStatus = toolUseAxiosErr?.response?.status;
        if (toolUseStatus === 400 || toolUseStatus === 404 || toolUseStatus === 422) {
          toolUseIncompatible = true;
        } else {
          logger.warn(
            { serverUrl, model, code: toolUseAxiosErr?.code, status: toolUseStatus },
            'Model profile tool-use capability probe failed; leaving compatibility unknown',
          );
        }
      }
      logger.info({ serverUrl, model, latencyMs }, 'Model profile test succeeded');
      return { success: true, latencyMs, modelResponse: content.slice(0, 120), jsonIncompatible, thinkingIncompatible, toolUseIncompatible };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startMs;
      const axiosErr = err as { code?: string; response?: { status?: number; data?: unknown } };
      const status = axiosErr?.response?.status;
      const data = axiosErr?.response?.data as Record<string, unknown> | undefined;
      const errObj = err as { message?: string };

      // Extract provider error message from response body
      const providerMessage = typeof data?.error === 'string' ? data.error
        : typeof data?.error === 'object' && data.error !== null && typeof (data.error as Record<string, unknown>).message === 'string'
          ? (data.error as Record<string, unknown>).message as string
          : undefined;

      // Detect chat-incompatibility (OpenAI "not a chat model" pattern)
      let chatIncompatible: boolean | undefined;
      if (status === 404 && providerMessage) {
        const lower = providerMessage.toLowerCase();
        if (lower.includes('not a chat model') || (lower.includes('not supported') && lower.includes('chat/completions'))) {
          chatIncompatible = true;
        }
      }

      const detail = providerMessage
        ?? (axiosErr?.code === 'ECONNREFUSED' ? `Could not connect to ${serverUrl}. Is the server running?`
        : axiosErr?.code === 'ECONNABORTED' ? `Request timed out after ${VALIDATION_TIMEOUT_MS / 1000}s.`
        : status === 401 ? 'Authentication failed. Check your API key.'
        : status === 403 ? 'Access denied. Your key may lack permissions for this model.'
        : status === 404 && chatIncompatible ? "This model doesn't support chat. It uses a completions-only endpoint — try a different model."
        : status === 404 ? `Model "${model ?? '(default)'}" not found on this server.`
        : status === 429 ? 'Rate limited or quota exceeded. Try again shortly.'
        : errObj?.message ?? 'Connection failed.');
      logger.warn({ serverUrl, model, status, latencyMs, chatIncompatible }, 'Model profile test failed');
      return { success: false, latencyMs, error: detail, chatIncompatible };
    }
  });

  // -------------------------------------------------------------------------
  // settings:test-model-choice
  // -------------------------------------------------------------------------
  // Test a RoleRow model choice by resolving the same provider route plan used
  // for turns, then sending a minimal one-shot probe through that plan.
  registerHandler('settings:test-model-choice', async (_event, req) => {
    const settings = normalizeSettings(req.settings);
    const codexAuthProvider = getCodexAuthProvider();
    const routeInput = modelChoiceToRouteInput({
      role: req.role,
      choice: req.choice,
      settings,
      codexConnected: codexAuthProvider.isConnected(),
    });
    if (!routeInput.ok) {
      return { success: false, error: routeInput.error };
    }

    try {
      const decision = ProviderRouter.forTurn(routeInput.input);
      const plan = await resolveProviderRoutePlan(
        { kind: 'forTurn', input: routeInput.input },
        await runtimeContextForTestDecision(settings, decision),
      );
      const result = await probeProviderRoutePlan(plan);
      logger.info(
        {
          role: req.role,
          success: result.success,
          transport: plan.decision.transport,
          dispatchPath: plan.decision.dispatchPath,
          invalidReason: plan.invalidReason,
          latencyMs: result.latencyMs,
        },
        'Model choice inline test completed',
      );
      return result;
    } catch (error) {
      const message = error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Model test failed.';
      logger.warn({ err: error, role: req.role }, 'Model choice inline test failed before probe completed');
      return { success: false, error: message };
    }
  });

  // -------------------------------------------------------------------------
  // settings:list-local-models
  // -------------------------------------------------------------------------
  // List available models from an OpenAI-compatible local model server.
  registerHandler('settings:list-local-models', async (_event, { serverUrl }) => {
    try {
      const baseUrl = serverUrl.replace(/\/$/, '');
      const response = await axios.get(`${baseUrl}/v1/models`, { timeout: 5000 });
      const models = response.data?.data?.map((m: Record<string, unknown>) => ({
        name: m.id,
        size: undefined,
        modifiedAt: undefined,
      })) ?? [];
      return { models };
    } catch (error) {
      logger.warn({ err: error, serverUrl }, 'Failed to list local models');
      return { models: [] };
    }
  });

  // -------------------------------------------------------------------------
  // settings:get-frequent-tools
  // -------------------------------------------------------------------------
  // Returns frequently used tools for the Settings UI.
  // Uses same selection algorithm as system prompt injection for consistency.
  registerHandler('settings:get-frequent-tools', () => {
    return getFrequentToolsWithCounts();
  });

  // -------------------------------------------------------------------------
  // settings:reset-tool-usage
  // -------------------------------------------------------------------------
  // Resets tool usage statistics to empty state.
  registerHandler('settings:reset-tool-usage', () => {
    const success = clearToolUsage();
    if (success) {
      logger.info('Tool usage statistics reset via IPC');
    } else {
      logger.warn('Tool usage reset failed - store may be in read-only mode');
    }
    return { success };
  });

  // -------------------------------------------------------------------------
  // settings:add-trusted-tool
  // -------------------------------------------------------------------------
  registerHandler(
    'settings:add-trusted-tool',
    async (_event: HandlerInvokeEvent, args: { toolId: string; displayName?: string; serverHint?: string }) => {
      // F-R3-3 / Stage 4 R2: Fail explicitly in read-only mode with a typed error
      // code so ApprovalTransport consumers can classify (same shape as set-space-safety-level).
      if (isUserDataReadOnly()) {
        logger.warn(
          { event: 'settings.add-trusted-tool.rejected', reason: 'read_only', toolId: args.toolId },
          'Rejected add-trusted-tool — read-only mode',
        );
        return { success: false, error: 'READ_ONLY', toolId: args.toolId };
      }

      const { bareToolId } = await import('@shared/utils/trustedToolNormalization');
      const settingsStore = getSettingsStore();
      const current = settingsStore.store;
      const trustedTools = current.trustedTools ?? [];

      // Normalize to bare tool ID before storing and deduplicating.
      // Legacy entries may have "packageId/toolId" format; strip the prefix.
      const canonicalId = bareToolId(args.toolId);

      // Deduplicate against canonical form — silent no-op if already present
      if (trustedTools.some((t) => bareToolId(t.toolId) === canonicalId)) {
        return { success: true };
      }

      settingsStore.store = {
        ...current,
        trustedTools: [
          ...trustedTools,
          {
            toolId: canonicalId,
            displayName: args.displayName,
            serverHint: args.serverHint,
            addedAt: Date.now(),
          },
        ],
      };

      logger.info({ toolId: args.toolId }, 'Added trusted tool atomically');
      return { success: true };
    },
  );

  // -------------------------------------------------------------------------
  // settings:set-space-safety-level
  // -------------------------------------------------------------------------
  // Narrow-slice channel for setting a single space's safety level.
  // Avoids exposing full AppSettings over cloud IPC (D11 in approval consolidation plan).
  // F-R2-2: resolves the get→merge→update race in mobile/desktop adapters.
  registerHandler(
    'settings:set-space-safety-level',
    async (_event: HandlerInvokeEvent, args: { spaceId: string; level: string }) => {
      // F-R3-3: Fail explicitly in read-only mode instead of silently returning success.
      // Other callers of settingsStore.store= use the Proxy's silent-success behavior;
      // only narrow channels fail loudly.
      if (isUserDataReadOnly()) {
        logger.warn(
          { event: 'settings.set-space-safety-level.rejected', reason: 'read_only', spaceId: args.spaceId },
          'Rejected set-space-safety-level — read-only mode',
        );
        return { success: false, error: 'READ_ONLY' };
      }

      const settingsStore = getSettingsStore();
      const current = settingsStore.store;

      // F-R3-2: Reject unknown spaceId — normalizeSettings strips unknown paths,
      // so writing blindly would silently no-op. Chief-of-Staff is hardcoded to
      // permissive and never stored in spaceSafetyLevels.
      const knownPaths = new Set(
        (current.spaces ?? [])
          .filter(s => s.type !== 'chief-of-staff')
          .map(s => s.path),
      );
      if (!knownPaths.has(args.spaceId)) {
        logger.info(
          { event: 'settings.set-space-safety-level.rejected', reason: 'unknown_space', spaceId: args.spaceId },
          'Rejected set-space-safety-level for unknown spaceId',
        );
        return { success: false, error: 'UNKNOWN_SPACE_ID', spaceId: args.spaceId };
      }

      const spaceSafetyLevels = {
        ...(current.spaceSafetyLevels ?? {}),
        [args.spaceId]: args.level as 'permissive' | 'balanced' | 'cautious',
      };
      settingsStore.store = normalizeSettings({
        ...current,
        spaceSafetyLevels,
      });
      logger.info({ spaceId: args.spaceId, level: args.level }, 'Set space safety level atomically');
      return { success: true };
    },
  );

  // -------------------------------------------------------------------------
  // settings:rename-workspace
  // -------------------------------------------------------------------------
  // Rename the workspace (coreDirectory) folder.
  // Requires app restart to apply new paths cleanly.
  // Flow: validate → set flag → shutdown services → rename → update settings → clear flag → relaunch

  /**
   * Validate a proposed new workspace path.
   * Checks: doesn't exist, no invalid chars, not reserved name, parent is writable.
   */
  const validateNewWorkspacePath = async (newPath: string): Promise<void> => {
    const newName = path.basename(newPath);
    const parentDir = path.dirname(newPath);

    // Check if path already exists
    try {
      await fs.access(newPath);
      throw new Error(`A folder named "${newName}" already exists at this location.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err; // Re-throw non-ENOENT errors (including our own)
      }
      // ENOENT is expected - path doesn't exist, which is good
    }

    // Check for invalid filesystem characters
    const invalidCharsWindows = /[<>:"/\\|?*]/;
    const invalidCharsUnix = /\//;
    const invalidChars = process.platform === 'win32' ? invalidCharsWindows : invalidCharsUnix;
    if (invalidChars.test(newName)) {
      throw new Error(`The name "${newName}" contains invalid characters.`);
    }

    // Check for Windows reserved names
    if (process.platform === 'win32') {
      const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
      if (reservedNames.test(newName)) {
        throw new Error(`"${newName}" is a reserved system name on Windows.`);
      }
    }

    // Check parent directory is writable
    try {
      await fs.access(parentDir, fs.constants.W_OK);
    } catch {
      throw new Error(`Cannot write to parent directory: ${parentDir}`);
    }
  };

  /**
   * Rename a file/folder with retry logic for Windows transient errors.
   */
  const safeRenameWorkspace = async (oldPath: string, newPath: string, maxRetries = 5): Promise<void> => {
    const isRetryableError = (code?: string) =>
      code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';

    for (let i = 0; i < maxRetries; i++) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!isRetryableError(code) || i === maxRetries - 1) {
          throw err;
        }
        // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, i)));
      }
    }
  };

  registerHandler('settings:rename-workspace', async (_event, { newName }: { newName: string }) => {
    const settingsStore = getSettingsStore();
    ensureNormalizedSettings();
    const settings = settingsStore.store;
    const oldPath = settings.coreDirectory;

    if (!oldPath) {
      throw new Error('No workspace is configured.');
    }

    const trimmedName = newName.trim();
    if (!trimmedName) {
      throw new Error('Workspace name cannot be empty.');
    }

    const newPath = path.join(path.dirname(oldPath), trimmedName);

    // If same path, nothing to do
    if (newPath === oldPath) {
      return { success: true, oldPath, newPath, requiresRestart: false };
    }

    // 1. Validate new path
    await validateNewWorkspacePath(newPath);

    // 2. Set crash recovery flag
    (settingsStore.set as (key: string, value: unknown) => void)('workspaceRenameInProgress', {
      oldPath,
      newPath,
      startedAt: Date.now(),
    });

    try {
      // 3. Stop all services gracefully to release file handles
      logger.info({ oldPath, newPath }, 'Stopping services for workspace rename');
      await gracefulShutdownServicesOnly();

      // 4. Perform the rename with retry logic
      logger.info({ oldPath, newPath }, 'Renaming workspace folder');
      await safeRenameWorkspace(oldPath, newPath);

      // 5. Update settings atomically - use rewritePath for absolute paths
      const updatedCoreDirectory = newPath;
      const updatedMcpConfigFile = settings.mcpConfigFile
        ? rewritePath(settings.mcpConfigFile, oldPath, newPath)
        : settings.mcpConfigFile;

      settingsStore.set('coreDirectory', updatedCoreDirectory);
      if (updatedMcpConfigFile !== settings.mcpConfigFile) {
        settingsStore.set('mcpConfigFile', updatedMcpConfigFile);
      }

      // 6. Clear crash recovery flag
      settingsStore.delete('workspaceRenameInProgress');

      logger.info({ oldPath, newPath }, 'Workspace renamed successfully, relaunching app');

      // 7. Relaunch the app (desktop-only)
      const electron = getDesktopElectron();
      if (electron) {
        electron.app.relaunch();
        electron.app.quit();
      }

      return { success: true, oldPath, newPath, requiresRestart: true };
    } catch (err) {
      // Clear flag on error - the rename failed
      settingsStore.delete('workspaceRenameInProgress');
      const message = err instanceof Error ? err.message : 'Unknown error during workspace rename';
      logger.error({ err, oldPath, newPath }, 'Workspace rename failed');
      throw new Error(`Failed to rename workspace: ${message}`);
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-toggle-tool
  // -------------------------------------------------------------------------
  // Enable or disable a specific MCP tool.
  // Updates the userDisabledToolsByServer field in the Super-MCP router config.
  // Super-MCP will hot-reload the config automatically.
  //
  // IMPORTANT: Always writes to the userData router config, not the resolved
  // mcpConfigFile path. This ensures we never mutate external configs (Cursor,
  // Claude Desktop, user configs). Super-MCP merges userDisabledToolsByServer
  // from all config files, so disabling a tool in the router config will apply
  // to servers defined in external configs too.
  registerHandler('settings:mcp-toggle-tool', async (_event, reqRaw: unknown) => {
    // Validate request shape
    const parsed = z.object({
      serverId: z.string().min(1),
      toolName: z.string().min(1),
      enabled: z.boolean(),
    }).safeParse(reqRaw);
    
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid request: ${parsed.error.issues.map((e) => e.message).join('; ')}`,
      };
    }
    
    const { serverId, toolName, enabled } = parsed.data;
    
    try {
      // Always use userData router config to avoid mutating external configs
      const routerPath = getUserDataRouterPath();
      await ensureRouterConfigFile(routerPath);

      // Guard: prevent re-enabling admin-disabled tools (defense-in-depth)
      if (enabled) {
        try {
          const authConfig = getRebelAuthProvider().getCachedAuthConfig();
          if (authConfig === null) {
            // Common pre-init / cloud-sentinel / first-fetch-in-flight path. Amendment A1.1
            // (Phase 6 fix per Behavioral-Safety F1): the silent-catch replacement only logged
            // on `throw`; the `null` short-circuit silently allowed the re-enable. Log explicitly
            // so admin policy bypasses are observable. Behaviour preserved (defense-in-depth fail open).
            logger.warn({ serverId, toolName }, 'Auth config unavailable (provider uninitialized, cloud sentinel, or first fetch in-flight); admin-disabled re-enable guard skipped — failing open');
          } else if (authConfig.disabledConnectorTools) {
            const serverDetails = await readMcpServerDetails(routerPath, serverId);
            const catalogId = serverDetails.catalogId;
            if (catalogId) {
              const entry = authConfig.disabledConnectorTools[catalogId];
              if (entry?.disabledTools?.includes(toolName)) {
                return {
                  success: false,
                  error: 'This tool has been disabled by your organization\'s administrator.',
                };
              }
            }
          }
        } catch (err) {
          logger.warn({ err, serverId, toolName }, 'Failed to check admin-disabled tool before toggling MCP tool');
        }
      }

      await setMcpToolEnabled(routerPath, serverId, toolName, enabled);
      
      logger.info(
        { serverId, toolName, enabled, configPath: routerPath },
        `MCP tool ${enabled ? 'enabled' : 'disabled'}`
      );
      
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to toggle MCP tool';
      logger.error({ err: error, serverId, toolName, enabled }, 'Failed to toggle MCP tool');
      return { success: false, error: errorMsg };
    }
  });

  // -------------------------------------------------------------------------
  // settings:mcp-toggle-server-enabled
  // -------------------------------------------------------------------------
  // Toggle a server between enabled and disabled state.
  // Disabled servers are excluded from tool routing but remain visible in settings.
  //
  // This handler:
  // 1. Reads current disabled state from the router config
  // 2. Toggles the state (enabled -> disabled or disabled -> enabled)
  // 3. Restarts Super-MCP to apply the change
  // 4. Invalidates connected packages cache to refresh system prompt context
  registerHandler('settings:mcp-toggle-server-enabled', async (_event, reqRaw: unknown) => {
    // Validate request shape
    const parsed = z.object({
      serverId: z.string().min(1),
    }).safeParse(reqRaw);

    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid request: ${parsed.error.issues.map((e) => e.message).join('; ')}`,
      };
    }

    const { serverId } = parsed.data;

    try {
      // Always use userData router config to avoid mutating external configs
      const routerPath = getUserDataRouterPath();
      await ensureRouterConfigFile(routerPath);

      // Check current disabled state and toggle it
      const currentlyDisabled = await isServerDisabled(routerPath, serverId);
      const newDisabledState = !currentlyDisabled;

      // Update the config
      await setMcpServerDisabled(routerPath, serverId, newDisabledState);

      // Restart Super-MCP to pick up the change
      // Note: start() returns early if already running, so we use reconfigureSuperMcpWithCacheRefreshAndAwaitExecution
      // which does a proper stop + restart + cache invalidation.
      // Fire-and-forget — deliberately NOT awaited: the restart can be deferred up
      // to 30 min while agent turns drain, and awaiting pinned the toggle spinner
      // on that deferral (same class as the connector-disconnect hang, see
      // docs/plans/260610_gworkspace-mcp-error-disconnect-hang/PLAN.md). The
      // disabled-state config is already written; awaiting would not make tools
      // (un)available any sooner — the same turn-drain gates the restart either way.
      // A restart failure no longer fails this IPC; it stays observed via this
      // catch plus the manager's own restart-error logging. The context carries
      // the toggled serverId (`mcp-server-toggle:<serverId>`) so the renderer's
      // deferred-op tracker (UnifiedConnectionsPanel) can exact-match the queued
      // state to the toggled card — keep in sync with
      // buildMcpServerToggleRestartContext. The inner try/catch future-proofs a
      // synchronous throw before a promise is returned (unreachable while the fn
      // stays async): without it the handler's outer catch would fail the IPC
      // even though the config write already succeeded.
      try {
        void reconfigureSuperMcpWithCacheRefreshAndAwaitExecution(routerPath, {
          context: buildMcpServerToggleRestartContext(serverId),
        }).catch((err) => {
          logger.warn({ err, serverId, configPath: routerPath }, 'Super-MCP reconfigure after server toggle failed (restart may be needed)');
        });
      } catch (err) {
        logger.warn({ err, serverId, configPath: routerPath }, 'Super-MCP reconfigure after server toggle failed (restart may be needed)');
      }

      logger.info(
        { serverId, disabled: newDisabledState, configPath: routerPath },
        `MCP server ${newDisabledState ? 'disabled' : 'enabled'}`
      );

      if (serverId === 'RebelOffice') {
        if (newDisabledState) {
          void stopOfficeSidecar().catch((err) => {
            logger.warn({ err }, 'office-sidecar stop after toggle failed');
          });
        } else {
          void startOfficeSidecar().catch((err) => {
            logger.warn({ err }, 'office-sidecar start after toggle failed');
          });
        }
      }

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to toggle MCP server';
      logger.error({ err: error, serverId }, 'Failed to toggle MCP server enabled state');
      return { success: false, error: errorMsg };
    }
  });

  logger.info('Registered settings IPC handlers');
}
