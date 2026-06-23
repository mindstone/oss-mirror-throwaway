import http from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPlatformConfig } from '@core/platform';
import { getHandlerRegistry } from '@core/handlerRegistry';
import { getBroadcastService } from '@core/broadcastService';
import { getBuiltinPluginService } from '@core/rebelCore/pluginServiceProvider';
import { isProfileReference, profileReferenceId } from '@core/rebelCore/providerRouteDecision';
import { validatePluginSource } from './pluginSourceValidator';
import { DateTime } from 'luxon';
import { createScopedLogger } from '@core/logger';
import { isFeatureEnabled } from '@core/featureGating';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { getRecentDiagnosticContext } from '@core/services/diagnostics/recentDiagnosticContext';
import { formatRecentDiagnosticEvents } from '@core/services/diagnostics/recentEventsFormatter';
import { tailRecentMainLogs } from '@main/services/recentLogsTail';
import { listRecentLogFilePaths } from '@main/services/recentLogFilePaths';

const log = createScopedLogger({ service: 'bundledInboxBridge' });
import {
  addInboxItem,
  updateInboxItem,
  removeInboxItem,
  getInboxState,
  getInboxFeedbackExamples,
  setInboxItemArchived,
  setInboxItemQuadrant,
  type InboxFeedbackQuery,
  type InboxMutationInput
} from '@main/services/inboxStore';
import { sessionCoachingScheduler } from '@main/services/sessionCoachingScheduler';
import type { InboxItem, InboxHistoryEntry, InboxQuadrant, AgentSession, SpaceType, ThemePreference, AppSettings } from '@shared/types';
import { getPrimaryMcpAppFallbackTextsFromEvents } from '@shared/utils/mcpAppFallbackText';
import { getSettings } from '@core/services/settingsStore';
import { findCatalogEntryById } from '@core/services/connectorCatalogService';
import {
  getCurrentModel,
  getThinkingModel,
  getThinkingProfileId,
  getWorkingProfileId,
} from '@core/rebelCore/settingsAccessors';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { runSystemHealthCheck, generateShareableReport } from '@main/services/systemHealthService';
import {
  authenticateMcpServer,
  reloadSuperMcpNowForChatPackageMaterialization,
  resolveMcpConfigPath,
  restartSuperMcpForConfigChangeAndAwaitExecution,
} from '@main/services/mcpService';
import { upsertMcpServerEntry, removeMcpServerEntry, getMcpServerNames, setMcpToolEnabled, ensureRouterConfigFile, findExistingCatalogServer, readMcpServerDetails } from '@main/services/mcpConfigManager';
import { probeMcpUrlForOAuth } from '@core/services/oauthProbe';
import { removeMcpServerWithCleanup, performPostRemovalCleanup } from '@main/services/mcpServerRemovalService';
import { semanticSearchWithStatus, getIndexStatus } from '@main/services/fileIndexService';
import * as sourceMetadataStore from '@main/services/sourceMetadataStore';

/**
 * Status-aware semantic search adapter for `sourceMetadataStore.searchSources`.
 * Maps the file index service's `FileSearchStatus` onto the core-local
 * `SourceSearchStatus` (identical string values; structurally assignable).
 * Defined here
 * — and mirrored in the plugin handler — so both source-search callers route
 * through `semanticSearchWithStatus`, sharing its once-per-workspace Sentry
 * capture. `searchSources` itself adds no capture (avoids double-counting).
 */
const sourceSemanticSearchAdapter = async (
  query: string,
  options: { limit?: number; threshold?: number; pathPrefix?: string },
): Promise<{ status: sourceMetadataStore.SourceSearchStatus; results: Array<{ relativePath: string; score: number }> }> => {
  // Explicit MCP source search (rebel_search_sources) — enable the lexical
  // exemption so an exact keyword match survives the vector-cosine floor (F9).
  const r = await semanticSearchWithStatus(query, { ...options, lexicalExemption: true });
  return { status: r.status, results: r.results };
};
import * as entityMetadataStore from '@main/services/entityMetadataStore';
import path from 'node:path';
import { joinPortablePath } from '@core/utils/portablePath';
import {
  PREP_ENRICHMENT_FIELDS,
  type MeetingUtility,
  type PrepGoalAlignment,
} from '@core/services/prepAlignmentTypes';
import {
  getCachedMeetings,
  setCachedMeetings,
  reapplySkipState,
  updateMeetingPrepPath,
  getTodaysMeetings,
  renderSyncIssue,
  makeSyncIssue,
  type CachedMeeting,
  type SyncIssue,
} from '@main/services/meetingCacheStore';
import { attachPrepPathsFromDisk } from '@main/services/meetingPrepReconciler';
import {
  getMeetingsInRange,
  getMissedMeetings,
} from '@main/services/meetingHistoryStore';
import type { MeetingBotService } from '@main/services/meetingBot/meetingBotService';
import { linkPrepToExistingTranscript, determineTargetSpace } from '@main/services/meetingBot/transcriptStorage';
import { buildSlackInstancePayload, buildMicrosoft365MailPayload, buildMicrosoft365CalendarPayload, buildMicrosoft365FilesPayload, buildMicrosoft365TeamsPayload, buildMicrosoft365SharePointPayload, MICROSOFT_SERVER_BASE_NAMES, resolveConnectorCatalogPath, lookupCatalogEntry, buildPayloadFromCatalog } from '@main/services/bundledMcpManager';
import { validateOpenAiKey, validateClaudeKey, validateElevenLabsKey } from '@main/services/apiKeyValidation';
import { MODEL_CATALOG } from '@shared/data/modelCatalog';
import { CLAUDE_TIERS, type QualityTierId } from '@shared/data/qualityTiers';
import { getIdentityParamName, type IdentityKind } from '@shared/identityKinds';
import { AutomationDefinitionPatchSchema } from '@shared/ipc/schemas/automations';
import { AutomationSchedule } from '@shared/utils/automationSchedule';
import { startSlackAuth, getSlackTokensForWorkspace, getSlackConfigDir } from '@main/services/slackAuthService';
import { notifySlackWorkspaceConnected } from '@main/services/slackWorkspaceNotifier';
import { startMicrosoftAuth, getMicrosoftConfigDir, getMicrosoftAccounts, getExtraScopesForAccount } from '@main/services/microsoftAuthService';
import { startSalesforceAuth, getSalesforceConfigDir } from '@main/services/salesforceAuthService';
import { resolveOAuthCredentials, slackCredentialSource, microsoftCredentialSource, salesforceCredentialSource, resolveMicrosoftClientId, resolveSalesforceCredentials } from '@main/services/oauthCredentials';
import { archivePluginInSpace, restorePluginInSpace, forkPluginInSpace, copyPluginToSpace, movePluginToSpace, scanSpacePlugins } from '@main/services/pluginSpaceService';
import { stopOfficeSidecar } from '@main/services/officeSidecarManager';

import type { McpServerUpsertPayload, AutomationToolGrant } from '@shared/types';
import { generateWorkspaceInstanceId } from '@shared/utils/mcpInstanceUtils';
import {
  classifyContributionPath,
  tryParseNonCanonicalError,
} from '@shared/utils/contributionPathClassifier';
import {
  buildSuccessDecision,
  buildDeferredDecision,
  buildRejectedDecision,
  deriveSoftwareEngineerRecoveryGuidance,
  GUIDANCE_PRESETS,
  type Decision,
} from '@shared/contribution/decisionEnvelope';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import type { AutomationDefinitionPatch, AutomationScheduler } from '@main/services/automationScheduler';
import { validateAutomationFilePath } from '@main/utils/automationFileValidation';
import { validateSpacePath, readSpaceReadmeFrontmatter, updateSpaceFrontmatter, scanSpaces, createSpace, invalidateSpaceScanCache } from '@core/services/space/spaceService';
import { getRebelAuthProvider } from '@core/rebelAuth';

const FEEDBACK_SOURCE_KINDS = ['text', 'workspace', 'automation', 'role', 'meeting', 'conversation'] as const;
const FEEDBACK_CATEGORIES = ['user-request', 'automation', 'meeting-action', 'follow-up', 'system', 'uncategorized'] as const;

const pickFeedbackQuery = (payload: Record<string, unknown> | null): InboxFeedbackQuery => ({
  limit: typeof payload?.limit === 'number' ? payload.limit : undefined,
  maxAgeDays: typeof payload?.maxAgeDays === 'number' ? payload.maxAgeDays : undefined,
  sourceKind: typeof payload?.sourceKind === 'string' && (FEEDBACK_SOURCE_KINDS as readonly string[]).includes(payload.sourceKind)
    ? payload.sourceKind as InboxFeedbackQuery['sourceKind']
    : undefined,
  automationId: typeof payload?.automationId === 'string' ? payload.automationId : undefined,
  automationName: typeof payload?.automationName === 'string' ? payload.automationName : undefined,
  category: typeof payload?.category === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(payload.category)
    ? payload.category as InboxFeedbackQuery['category']
    : undefined,
});
import { getAllUseCases, addUseCase, type UseCaseRecord, type AddUseCaseResult } from '@main/services/useCaseLibraryStore';
import { redactObjectDeep } from '@main/utils/logRedaction';
import { searchConversationsWithStatus } from '@main/services/conversationIndexService';
import { getIncrementalSessionStore } from '@main/services/incrementalSessionStore';
import { generateConversationSummary } from '@main/services/conversationSummaryService';
import { getSafetyPromptWithMeta, getSafetyPromptVersion, getSafetyPrompt, updateSafetyPrompt } from '@core/safetyPromptStore';
import { getActivityLog, addVersionChangeEntry } from '@core/safetyActivityLogStore';
import { clearCache as clearSafetyPromptCache, consolidateSafetyPrompt } from '@core/safetyPromptLogic';
import { broadcastSafetyPromptUpdated } from '@main/ipc/safetyPromptHandlers';


// ── Connector catalog cache ──────────────────────────────────
let cachedCatalog: Record<string, unknown>[] | null = null;

function loadConnectorCatalog(): Record<string, unknown>[] {
  if (cachedCatalog) return cachedCatalog;
  try {
    const catalogPath = resolveConnectorCatalogPath();
    const parsed = JSON.parse(fsSync.readFileSync(catalogPath, 'utf8'));
    cachedCatalog = (parsed?.connectors ?? []) as Record<string, unknown>[];
  } catch (err) {
    log.error({ err }, 'Failed to load connector catalog');
    cachedCatalog = [];
  }
  return cachedCatalog;
}

function getWritableModels(settings: AppSettings): NonNullable<AppSettings['models']> {
  return {
    // eslint-disable-next-line no-restricted-properties -- Bundled Inbox writes need a whole-model namespace clone before patching specific fields.
    ...(settings.models ?? {}),
  } as NonNullable<AppSettings['models']>;
}

/** Check whether a catalog entry requires OAuth authentication. */
function catalogEntryRequiresAuth(entry: Record<string, unknown>): boolean {
  if (entry.bundledConfig != null && typeof entry.bundledConfig === 'object') {
    const authType = (entry.bundledConfig as Record<string, unknown>).authType;
    if (authType === 'oauth' || authType === 'oauth-user-provided') return true;
  }
  if (entry.mcpConfig != null && typeof entry.mcpConfig === 'object') {
    if ((entry.mcpConfig as Record<string, unknown>).oauth === true) return true;
  }
  return false;
}

// Bridge-route copy for the `/mcp/upsert-server` missing-identity warning. The
// `'identifier'` fallback covers the `paramName === null` (kind === 'none') branch,
// which the gate at handleBundledInboxBridgeRequest excludes today — so the fallback
// is unreachable in production. Exported so tests can lock per-paramName copy without
// mounting an HTTP fixture per kind. Not for use outside the bridge route.
export function buildMissingIdentityWarningNextStep(
  serverName: string,
  accountIdentity: IdentityKind | undefined,
): string {
  const paramName = getIdentityParamName(accountIdentity) ?? 'identifier';
  return `Warning: "${serverName}" was added without an associated ${paramName}. This connector supports multiple accounts — re-add with the ${paramName} parameter to create a properly named instance. Without it, adding a second account later may conflict.`;
}

let activeBridgeToken: string | null = null;

export const setBundledInboxBridgeToken = (token: string | null): void => {
  activeBridgeToken = token;
};

let passThroughRevisitEmitted = false;

function emitPassThroughRevisitOnce(): void {
  if (passThroughRevisitEmitted) return;
  passThroughRevisitEmitted = true;
  captureKnownCondition(
    'pass_through_redaction_policy',
    { policy: 'raw-pass-through', userOverride: true, revisitTrigger: 'secret-leak-incident' },
  );
}

export const resetPassThroughRevisitForTests = (): void => {
  passThroughRevisitEmitted = false;
};

let automationSchedulerGetter: (() => AutomationScheduler) | null = null;

export const setAutomationSchedulerGetter = (getter: () => AutomationScheduler): void => {
  automationSchedulerGetter = getter;
};

let meetingBotServiceGetter: (() => MeetingBotService) | null = null;

export const setMeetingBotServiceGetter = (getter: () => MeetingBotService): void => {
  meetingBotServiceGetter = getter;
};

type McpCatalogUpsertPayload = McpServerUpsertPayload & {
  setupFields?: Record<string, string>;
};

type SourceSearchPayload = {
  query?: string;
  sourceTypes?: string[];
  participants?: string[];
  dateRange?: {
    relative?: string;
    after?: string;
    before?: string;
  };
  limit?: number;
};

type EntitySearchPayload = {
  query?: string;
  email?: string;
  company?: string;
  entityType?: 'person' | 'company';
  noInteractionSince?: string;
  limit?: number;
};

type EntityResolvePayload = {
  email?: string;
  name?: string;
};

type MeetingsPopulatePayload = {
  meetings?: unknown[];
  syncWarnings?: unknown[];
};

type MeetingPrepUpdatePayload = {
  meetingId?: string;
  prepPath?: string;
};

type MeetingPrepSavePayload = {
  meetingStartTime?: string;
  meetingTitle?: string;
  prepContent?: string;
  participants?: string[];
  meetingId?: string;
};

type MeetingPrepLookupPayload = {
  meetingDate?: string;
  meetingTitle?: string;
  meetingId?: string;
};

type FocusPrepEnrichmentPayload = {
  filePath?: string;
  goalAlignment?: unknown;
  meetingUtility?: unknown;
};

type MeetingsHistoryPayload = {
  startDate?: string;
  endDate?: string;
};

type MeetingsMissedPayload = {
  since?: string;
};

type ScheduleMeetingBotPayload = {
  meetingUrl?: string;
  meetingTitle?: string;
  scheduledFor?: string | null;
};

type SpaceConfigUpdates = {
  rebel_space_description?: string;
  emails?: string[];
};

type SpaceUpdateConfigPayload = {
  spacePath?: string;
  updates?: SpaceConfigUpdates;
};

type ConversationsListPayload = {
  limit?: number;
  excludeCurrentSession?: string;
};

type ConversationSearchPayload = {
  query?: string;
  limit?: number;
};

type ConversationSendPayload = {
  text?: string;
  sendMessage?: boolean;
  switchToConversation?: boolean;
};

type CreateSpacePayload = {
  name?: string;
  targetPath?: string;
  description?: string;
  type?: SpaceType;
  createSubfolders?: boolean;
};

const SETTINGS_UPDATE_ACCENT_COLORS = ['purple', 'blue', 'indigo', 'teal', 'rose', 'orange', 'amber', 'slate'] as const;
const SETTINGS_UPDATE_FONT_SCALES = ['small', 'default', 'large'] as const;
const SETTINGS_UPDATE_UI_DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
const SETTINGS_UPDATE_CONVERSATION_WIDTHS = ['narrow', 'medium', 'wide'] as const;

type AccentColor = (typeof SETTINGS_UPDATE_ACCENT_COLORS)[number];
type FontScale = (typeof SETTINGS_UPDATE_FONT_SCALES)[number];
type UiDensity = (typeof SETTINGS_UPDATE_UI_DENSITIES)[number];
type ConversationWidth = (typeof SETTINGS_UPDATE_CONVERSATION_WIDTHS)[number];

type LowRiskSettingsUpdates = {
  theme?: ThemePreference;
  indexingEnabled?: boolean;
  gpuEmbeddingEnabled?: boolean;
  backgroundEnhancement?: boolean;
  streaming?: {
    enabled?: boolean;
  };
  accentColor?: AccentColor;
  fontScale?: FontScale;
  uiDensity?: UiDensity;
  conversationWidth?: ConversationWidth;
};

type SettingsUpdatePayload = {
  updates?: LowRiskSettingsUpdates;
};

type VocabularyUpdatePayload = {
  action?: 'add' | 'remove' | 'replace';
  terms?: unknown[];
};

const MEETING_UTILITY_VALUES: ReadonlySet<MeetingUtility> = new Set([
  'productive',
  'blocker',
  'noise',
  'travel',
]);

const isMeetingUtility = (value: unknown): value is MeetingUtility =>
  typeof value === 'string' && MEETING_UTILITY_VALUES.has(value as MeetingUtility);

const parseGoalAlignmentPayload = (value: unknown): PrepGoalAlignment[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const parsed: PrepGoalAlignment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.goal !== 'string' || typeof candidate.space !== 'string') {
      return null;
    }

    const goal = candidate.goal.trim();
    const space = candidate.space.trim();
    if (!goal || !space) {
      return null;
    }

    parsed.push({ goal, space });
  }

  return parsed;
};

const serializeFrontmatterScalar = (value: unknown): string => {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
};

const serializeFrontmatterAttribute = (key: string, value: unknown): string[] => {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${key}: []`];
    }

    const lines = [`${key}:`];
    for (const item of value) {
      lines.push(`  - ${serializeFrontmatterScalar(item)}`);
    }
    return lines;
  }

  return [`${key}: ${serializeFrontmatterScalar(value)}`];
};

const buildFrontmatterLines = (attributes: Record<string, unknown>): string[] => {
  const lines = ['---'];
  for (const [key, value] of Object.entries(attributes)) {
    lines.push(...serializeFrontmatterAttribute(key, value));
  }
  lines.push('---');
  return lines;
};

type UseCaseAddResponse = {
  added: boolean;
  reason: string;
  title: string;
  replacedId?: string;
};

type PluginCreatePayload = {
  id?: string;
  name?: string;
  source?: string;
  description?: string;
  documentation?: string;
  version?: string;
  permissions?: string[];
  externalDomains?: string[];
  role?: string;
};

type PluginIdPayload = {
  id?: string;
};

type PluginOpenPayload = {
  id?: string;
  params?: Record<string, unknown>;
};

type PluginForkPayload = {
  id?: string;
  targetId?: string;
  targetSpace?: string;
};

type PluginSpaceTransferPayload = {
  id?: string;
  sourceSpace?: string;
  targetSpace?: string;
};

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const bumpPatchVersion = (version: string): string => {
  const parts = version.split('.');
  if (parts.length === 3) {
    const patch = parseInt(parts[2], 10);
    if (!isNaN(patch)) {
      return `${parts[0]}.${parts[1]}.${patch + 1}`;
    }
  }
  return '0.1.1';
};

const toIsoDate = (dateTime: DateTime): string => {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Luxon DateTime values in this flow are always valid calendar dates.
  return dateTime.toISODate()!;
};

/**
 * Resolve relative date strings to ISO date range (YYYY-MM-DD).
 * Uses Luxon for consistent ISO week handling (Monday = 1).
 *
 * Supported values:
 * - "today", "yesterday"
 * - "this_week", "last_week" (ISO weeks: Mon-Sun)
 * - "this_month", "last_month"
 * - "last_7_days", "last_30_days"
 *
 * @returns { after, before } with ISO date strings, or null if unrecognized
 */
function resolveRelativeDate(relative: string): { after: string; before: string } | null {
  const now = DateTime.local();
  const today = now.startOf('day');

  switch (relative.toLowerCase()) {
    case 'today':
      return {
        after: toIsoDate(today),
        before: toIsoDate(today),
      };

    case 'yesterday': {
      const yesterday = today.minus({ days: 1 });
      return {
        after: toIsoDate(yesterday),
        before: toIsoDate(yesterday),
      };
    }

    case 'this_week': {
      // ISO week: Monday is day 1
      const startOfWeek = today.startOf('week');
      const endOfWeek = today.endOf('week').startOf('day');
      return {
        after: toIsoDate(startOfWeek),
        before: toIsoDate(endOfWeek),
      };
    }

    case 'last_week': {
      const lastWeekStart = today.startOf('week').minus({ weeks: 1 });
      const lastWeekEnd = today.startOf('week').minus({ days: 1 });
      return {
        after: toIsoDate(lastWeekStart),
        before: toIsoDate(lastWeekEnd),
      };
    }

    case 'this_month': {
      const startOfMonth = today.startOf('month');
      const endOfMonth = today.endOf('month').startOf('day');
      return {
        after: toIsoDate(startOfMonth),
        before: toIsoDate(endOfMonth),
      };
    }

    case 'last_month': {
      const lastMonthStart = today.startOf('month').minus({ months: 1 });
      const lastMonthEnd = today.startOf('month').minus({ days: 1 });
      return {
        after: toIsoDate(lastMonthStart),
        before: toIsoDate(lastMonthEnd),
      };
    }

    case 'last_7_days': {
      return {
        after: toIsoDate(today.minus({ days: 6 })),
        before: toIsoDate(today),
      };
    }

    case 'last_30_days': {
      return {
        after: toIsoDate(today.minus({ days: 29 })),
        before: toIsoDate(today),
      };
    }

    default:
      return null;
  }
}

const formatTimestamp = (value: number | string | null | undefined): string => {
  if (value === null || value === undefined) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'unknown' : date.toISOString();
};

const quoteMarkdownBlock = (text: string): string => text.split('\n').map((line) => `> ${line}`).join('\n');

const getPrimaryMcpAppFallbackTextsForMessage = (
  session: AgentSession,
  message: AgentSession['messages'][number],
): string[] => {
  if (message.role !== 'assistant' && message.role !== 'result') {
    return [];
  }
  return getPrimaryMcpAppFallbackTextsFromEvents(session.eventsByTurn?.[message.turnId]);
};

const resolveConversationSessionId = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as { sessionId?: unknown; url?: unknown };
  let sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
  const url = typeof data.url === 'string' ? data.url : undefined;

  if (!sessionId && url) {
    const match = url.match(/rebel:\/\/conversation\/([a-f0-9-]+)/i);
    if (match) sessionId = match[1];
  }

  return sessionId ?? null;
};

const formatConversationExport = (session: AgentSession): { content: string; filename: string; messageCount: number } => {
  const visibleMessages = session.messages.filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant' || message.role === 'result') &&
      !message.isHidden &&
      (message.text?.trim() || getPrimaryMcpAppFallbackTextsForMessage(session, message).length > 0)
  );

  const createdAt = formatTimestamp(session.createdAt);
  const updatedAt = formatTimestamp(session.updatedAt);
  const exportedAt = new Date().toISOString();
  const title = session.title?.trim() || 'Untitled';

  const lines: string[] = [];
  lines.push('# Conversation Export');
  lines.push(`**Session ID:** ${session.id}`);
  lines.push(`**Title:** ${title}`);
  lines.push(`**Created:** ${createdAt}`);
  lines.push(`**Updated:** ${updatedAt}`);
  lines.push(`**Exported:** ${exportedAt}`);
  lines.push(`**Message count:** ${visibleMessages.length}`);
  lines.push(`**URL:** ${formatNavigationUrl({ type: 'sessions', sessionId: session.id })}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Transcript');
  lines.push('');

  visibleMessages.forEach((message, index) => {
    const roleLabel = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Rebel' : 'Rebel (result)';
    const timestamp = formatTimestamp(message.createdAt);
    lines.push(`### ${index + 1}. ${roleLabel} — ${timestamp}`);

    if (message.attachments?.length) {
      lines.push('**Attachments:**');
      for (const attachment of message.attachments) {
        const location = attachment.relativePath || attachment.path;
        lines.push(`- ${attachment.name} (${location}, ${attachment.size} bytes)`);
      }
      lines.push('');
    }

    lines.push('````text');
    lines.push(message.text ?? '');
    lines.push('````');
    lines.push('');

    const primaryFallbackTexts = getPrimaryMcpAppFallbackTextsForMessage(session, message);
    if (primaryFallbackTexts.length > 0) {
      lines.push('**Interactive view fallback:**');
      lines.push(quoteMarkdownBlock(primaryFallbackTexts.join('\n\n')));
      lines.push('');
    }
  });

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const safeTitle = title
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 30) || 'conversation';
  const filename = `rebel-conversation-${safeTitle}-${dateStr}-${timeStr}.md`;

  return {
    content: lines.join('\n'),
    filename,
    messageCount: visibleMessages.length,
  };
};

/**
 * Restart Super-MCP to pick up config changes.
 * Delegates to the shared restart primitive in mcpService.
 */
async function restartSuperMcp(configPath: string): Promise<void> {
  // Deliberate execution-awaiting opt-in (260610 API split): the bridge
  // state machine must not advance until the restart has actually completed.
  await restartSuperMcpForConfigChangeAndAwaitExecution(configPath, 'bundled-inbox-bridge');
}

async function reloadSuperMcpForChatMaterialization(
  configPath: string,
  logContext: string,
  reason: NonNullable<Parameters<typeof reloadSuperMcpNowForChatPackageMaterialization>[2]>,
): Promise<void> {
  await reloadSuperMcpNowForChatPackageMaterialization(configPath, `bundled-inbox-bridge:${logContext}`, reason);
}

/**
 * Send HTTP response, then reload Super-MCP immediately after a short delay.
 *
 * IMPORTANT: Use this instead of awaiting the reload in HTTP handlers. Awaiting
 * before responding will hang the calling MCP tool because the reload restarts
 * the HTTP server handling the request.
 *
 * Delay rationale (don't drop below this without re-testing):
 * The bridge HTTP response unwinds through a deep async chain before the
 * caller (the renderer) sees success — child reads HTTP body → returns from
 * bridgeRequest → formats MCP tool result → JSON-RPC over stdio to Super-MCP →
 * Super-MCP JSON-RPC over stdio to main → main resolves IPC await → renderer
 * unblocks. Restarting Super-MCP kills its child processes and severs the
 * stdio pipes mid-flight. setImmediate fires in the same tick as the socket
 * write — empirically too early: TCP buffering + child stdio + IPC layers
 * haven't completed. A 1500ms delay gives the response time to settle while
 * still being imperceptible to the user.
 *
 * See docs-private/postmortems/260430_salesforce_oauth_browser_never_opens_settings.md
 * for the diagnostic trail.
 */
const SUPER_MCP_RESTART_AFTER_AUTH_DELAY_MS = 1500;

function respondThenReloadSuperMcpForChatMaterialization(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  configPath: string,
  logContext: string,
  reason: NonNullable<Parameters<typeof reloadSuperMcpNowForChatPackageMaterialization>[2]>,
): void {
  writeJson(res, 200, body);
  setTimeout(() => {
    reloadSuperMcpForChatMaterialization(configPath, logContext, reason).catch(err => {
      log.warn({ err, configPath }, `Super-MCP immediate materialization reload failed after ${logContext}`);
    });
  }, SUPER_MCP_RESTART_AFTER_AUTH_DELAY_MS);
}

const parseJsonBody = <T extends Record<string, unknown> = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        if (chunks.length === 0) {
          resolve({} as T);
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
};

function writeJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function parseOptionalNumberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const authenticate = (req: http.IncomingMessage): boolean => {
  if (!activeBridgeToken) {
    return false;
  }
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) {
    return false;
  }
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token.length > 0 && token === activeBridgeToken;
};

function hashBearerPrefix(authHeader: string | null | undefined): string {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return 'unknown';
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (token.length === 0) {
    return 'unknown';
  }
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

const getEnvironmentSnapshot = () => {
  const now = new Date();

  let coreDirectory: string | null = null;
  try {
    const settings = getSettings();
    coreDirectory = settings.coreDirectory;
  } catch {
    coreDirectory = null;
  }

  const homeDir = os.homedir();

  let user: string | null = null;
  try {
    user = process.env['USER'] || process.env['USERNAME'] || os.userInfo().username || null;
  } catch {
    user = process.env['USER'] || process.env['USERNAME'] || null;
  }

  const shell = process.env['SHELL'] || process.env['ComSpec'] || null;

  let timezone: string | null = null;
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    timezone = resolved && typeof resolved === 'string' ? resolved : null;
  } catch {
    timezone = null;
  }

  return {
    platform: {
      os: os.platform(),
      release: os.release(),
      arch: os.arch()
    },
    node: {
      version: process.version
    },
    process: {
      pid: process.pid,
      cwd: process.cwd()
    },
    time: {
      iso: now.toISOString(),
      local: now.toString(),
      timezone,
      timezoneOffsetMinutes: -now.getTimezoneOffset()
    },
    workspace: {
      coreDirectory,
      hasWorkspace: typeof coreDirectory === 'string' && coreDirectory.trim().length > 0
    },
    env: {
      homeDir,
      user,
      shell
    }
  };
};

// =============================================================================
// Inbox Query and Filtering Helpers
// =============================================================================

type InboxQueryFilter = {
  /** Include archived items (default: false - only active items) */
  includeArchived?: boolean;
  /** Only archived items (mutually exclusive with includeArchived) */
  archivedOnly?: boolean;
  /** Include execution history entries */
  includeHistory?: boolean;
  /** Filter by quadrant: 'do_now', 'schedule', 'delegate', 'consider' */
  quadrant?: string;
  /** Filter by urgent flag */
  urgent?: boolean;
  /** Filter by important flag */
  important?: boolean;
  /** Filter items added after this timestamp (epoch ms or ISO string) */
  addedAfter?: number | string;
  /** Filter items added before this timestamp (epoch ms or ISO string) */
  addedBefore?: number | string;
  /** Search in title and text (case-insensitive substring match) */
  search?: string;
  /** Maximum items to return (default: no limit for query endpoint) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort field: 'addedAt', 'title', 'quadrant' */
  sortBy?: 'addedAt' | 'title' | 'quadrant';
  /** Sort order: 'asc' or 'desc' (default: desc for addedAt, asc for title) */
  sortOrder?: 'asc' | 'desc';
};

/**
 * Get quadrant from urgent/important flags
 */
const getQuadrant = (item: InboxItem): InboxQuadrant => {
  const urgent = item.urgent ?? false;
  const important = item.important ?? true;
  if (urgent && important) return 'do-now';
  if (!urgent && important) return 'schedule';
  if (urgent && !important) return 'delegate';
  return 'consider';
};

/**
 * Parse timestamp from various formats
 */
const parseTimestamp = (value: number | string | undefined): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Try ISO date first
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date.getTime();
    // Try epoch string
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
};

/**
 * Filter and sort inbox items based on query parameters
 */
const queryInboxItems = (filter: InboxQueryFilter): {
  items: InboxItem[];
  history: InboxHistoryEntry[];
  total: number;
  totalActive: number;
  totalArchived: number;
  totalHistory: number;
} => {
  const state = getInboxState();
  
  // Start with all items
  let items = [...state.items];
  let history: InboxHistoryEntry[] = [];
  
  // Track totals before filtering
  const totalActive = state.items.filter(i => !i.archived).length;
  const totalArchived = state.items.filter(i => i.archived).length;
  const totalHistory = state.history.length;
  
  // Filter by archived status
  if (filter.archivedOnly) {
    items = items.filter(i => i.archived === true);
  } else if (!filter.includeArchived) {
    items = items.filter(i => !i.archived);
  }
  
  // Include history if requested
  if (filter.includeHistory) {
    history = [...state.history];
  }
  
  // Filter by quadrant
  if (filter.quadrant) {
    const normalizedQuadrant = filter.quadrant.toLowerCase().replace(/_/g, '-');
    items = items.filter(i => getQuadrant(i) === normalizedQuadrant);
  }
  
  // Filter by urgent flag
  if (filter.urgent !== undefined) {
    items = items.filter(i => (i.urgent ?? false) === filter.urgent);
  }
  
  // Filter by important flag
  if (filter.important !== undefined) {
    items = items.filter(i => (i.important ?? true) === filter.important);
  }
  
  // Filter by addedAt range
  const addedAfter = parseTimestamp(filter.addedAfter);
  const addedBefore = parseTimestamp(filter.addedBefore);
  if (addedAfter !== null) {
    items = items.filter(i => i.addedAt >= addedAfter);
    if (filter.includeHistory) {
      history = history.filter(h => h.addedAt >= addedAfter);
    }
  }
  if (addedBefore !== null) {
    items = items.filter(i => i.addedAt <= addedBefore);
    if (filter.includeHistory) {
      history = history.filter(h => h.addedAt <= addedBefore);
    }
  }
  
  // Search filter
  if (filter.search && filter.search.trim()) {
    const searchLower = filter.search.toLowerCase().trim();
    const matchesSearch = (i: InboxItem) =>
      i.title.toLowerCase().includes(searchLower) ||
      i.text.toLowerCase().includes(searchLower) ||
      (i.tags?.some(t => t.includes(searchLower)) ?? false);
    items = items.filter(matchesSearch);
    if (filter.includeHistory) {
      history = history.filter(matchesSearch);
    }
  }
  
  // Sort items
  const sortBy = filter.sortBy ?? 'addedAt';
  const sortOrder = filter.sortOrder ?? (sortBy === 'addedAt' ? 'desc' : 'asc');
  const sortMultiplier = sortOrder === 'desc' ? -1 : 1;
  
  items.sort((a, b) => {
    switch (sortBy) {
      case 'title':
        return sortMultiplier * a.title.localeCompare(b.title);
      case 'quadrant': {
        const quadrantOrder: Record<InboxQuadrant, number> = {
          'do-now': 0, 'schedule': 1, 'delegate': 2, 'consider': 3
        };
        return sortMultiplier * (quadrantOrder[getQuadrant(a)] - quadrantOrder[getQuadrant(b)]);
      }
      case 'addedAt':
      default:
        return sortMultiplier * (a.addedAt - b.addedAt);
    }
  });
  
  // Track total after filtering but before pagination
  const total = items.length;
  
  // Apply pagination
  const offset = filter.offset ?? 0;
  if (offset > 0) {
    items = items.slice(offset);
    if (filter.includeHistory) {
      history = history.slice(offset);
    }
  }
  if (filter.limit !== undefined && filter.limit > 0) {
    items = items.slice(0, filter.limit);
    if (filter.includeHistory) {
      history = history.slice(0, filter.limit);
    }
  }
  
  return { items, history, total, totalActive, totalArchived, totalHistory };
};

/**
 * Get inbox statistics by quadrant and status
 */
const getInboxStats = (): {
  total: number;
  active: number;
  archived: number;
  history: number;
  byQuadrant: Record<string, number>;
  byQuadrantArchived: Record<string, number>;
  oldestActiveAt: number | null;
  newestActiveAt: number | null;
} => {
  const state = getInboxState();
  
  const activeItems = state.items.filter(i => !i.archived);
  const archivedItems = state.items.filter(i => i.archived);
  
  const byQuadrant: Record<string, number> = {
    'do_now': 0, 'schedule': 0, 'delegate': 0, 'consider': 0
  };
  const byQuadrantArchived: Record<string, number> = {
    'do_now': 0, 'schedule': 0, 'delegate': 0, 'consider': 0
  };
  
  for (const item of activeItems) {
    const q = getQuadrant(item).replace('-', '_');
    byQuadrant[q] = (byQuadrant[q] ?? 0) + 1;
  }
  
  for (const item of archivedItems) {
    const q = getQuadrant(item).replace('-', '_');
    byQuadrantArchived[q] = (byQuadrantArchived[q] ?? 0) + 1;
  }
  
  // Find oldest and newest active items
  let oldestActiveAt: number | null = null;
  let newestActiveAt: number | null = null;
  for (const item of activeItems) {
    if (oldestActiveAt === null || item.addedAt < oldestActiveAt) {
      oldestActiveAt = item.addedAt;
    }
    if (newestActiveAt === null || item.addedAt > newestActiveAt) {
      newestActiveAt = item.addedAt;
    }
  }
  
  return {
    total: state.items.length,
    active: activeItems.length,
    archived: archivedItems.length,
    history: state.history.length,
    byQuadrant,
    byQuadrantArchived,
    oldestActiveAt,
    newestActiveAt,
  };
};

type BulkOperation = 
  | { action: 'archive'; ids: string[] }
  | { action: 'unarchive'; ids: string[] }
  | { action: 'delete'; ids: string[] }
  | { action: 'move_quadrant'; ids: string[]; urgent: boolean; important: boolean }
  | { action: 'archive_quadrant'; quadrant: string }
  | { action: 'delete_quadrant'; quadrant: string }
  | { action: 'archive_all' }
  | { action: 'delete_archived' };

/**
 * Execute bulk operation on inbox items
 */
const executeBulkOperation = (op: BulkOperation): {
  success: boolean;
  affected: number;
  message: string;
} => {
  const state = getInboxState();
  let affected = 0;
  
  switch (op.action) {
    case 'archive': {
      for (const id of op.ids) {
        const item = state.items.find(i => i.id === id);
        if (item && !item.archived) {
          setInboxItemArchived(id, true);
          affected++;
        }
      }
      return { success: true, affected, message: `Archived ${affected} item(s)` };
    }
    
    case 'unarchive': {
      for (const id of op.ids) {
        const item = state.items.find(i => i.id === id);
        if (item && item.archived) {
          setInboxItemArchived(id, false);
          affected++;
        }
      }
      return { success: true, affected, message: `Unarchived ${affected} item(s)` };
    }
    
    case 'delete': {
      for (const id of op.ids) {
        const item = state.items.find(i => i.id === id);
        if (item) {
          removeInboxItem(id);
          affected++;
        }
      }
      return { success: true, affected, message: `Deleted ${affected} item(s)` };
    }
    
    case 'move_quadrant': {
      for (const id of op.ids) {
        const item = state.items.find(i => i.id === id);
        if (item) {
          setInboxItemQuadrant(id, op.urgent, op.important);
          affected++;
        }
      }
      const quadrantName = op.urgent && op.important ? 'Do Now' :
                          !op.urgent && op.important ? 'Schedule' :
                          op.urgent && !op.important ? 'Delegate' : 'Consider';
      return { success: true, affected, message: `Moved ${affected} item(s) to ${quadrantName}` };
    }
    
    case 'archive_quadrant': {
      const normalizedQuadrant = op.quadrant.toLowerCase().replace(/_/g, '-');
      const itemsInQuadrant = state.items.filter(i => !i.archived && getQuadrant(i) === normalizedQuadrant);
      for (const item of itemsInQuadrant) {
        setInboxItemArchived(item.id, true);
        affected++;
      }
      return { success: true, affected, message: `Archived ${affected} item(s) from ${op.quadrant}` };
    }
    
    case 'delete_quadrant': {
      const normalizedQuadrant = op.quadrant.toLowerCase().replace(/_/g, '-');
      const itemsInQuadrant = state.items.filter(i => getQuadrant(i) === normalizedQuadrant);
      for (const item of itemsInQuadrant) {
        removeInboxItem(item.id);
        affected++;
      }
      return { success: true, affected, message: `Deleted ${affected} item(s) from ${op.quadrant}` };
    }
    
    case 'archive_all': {
      const activeItems = state.items.filter(i => !i.archived);
      for (const item of activeItems) {
        setInboxItemArchived(item.id, true);
        affected++;
      }
      return { success: true, affected, message: `Archived all ${affected} active item(s)` };
    }
    
    case 'delete_archived': {
      const archivedItems = state.items.filter(i => i.archived);
      for (const item of archivedItems) {
        removeInboxItem(item.id);
        affected++;
      }
      return { success: true, affected, message: `Deleted ${affected} archived item(s)` };
    }
    
    default:
      return { success: false, affected: 0, message: 'Unknown bulk operation' };
  }
};

export const bundledInboxBridgeStateReducer = executeBulkOperation;

export const handleBundledInboxBridgeRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  try {
    if (!authenticate(req)) {
      writeJson(res, 401, { success: false, error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/inbox') {
      const state = getInboxState();
      writeJson(res, 200, { success: true, items: state.items });
      return;
    }

    if (req.method === 'GET' && req.url === '/environment') {
      const snapshot = getEnvironmentSnapshot();
      writeJson(res, 200, { success: true, environment: snapshot });
      return;
    }

    if (req.method === 'POST' && req.url === '/inbox/add') {
      const payload = await parseJsonBody<InboxMutationInput & Record<string, unknown>>(req);
      if (!payload || typeof payload.title !== 'string' || payload.title.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Title is required.' });
        return;
      }
      const id = randomUUID();
      const result = addInboxItem({ ...payload, id });
      if (result.redirected && result.redirectTarget === 'coach') {
        try {
          sessionCoachingScheduler.addAutomationInsight({
            insightId: id,
            title: payload.title,
            text: payload.text,
          });
        } catch (err) {
          log.warn({ err, title: payload.title }, 'Failed to route bridge-redirected item to Coach');
        }
      }
      writeJson(res, 200, {
        success: true,
        accepted: result.accepted,
        redirected: result.redirected,
        redirectTarget: result.redirectTarget,
        rejectedReason: result.rejectedReason,
        itemId: result.itemId,
        items: result.state.items,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/inbox/update') {
      const payload = await parseJsonBody(req);
      if (!payload || typeof payload.id !== 'string' || payload.id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Item id is required.' });
        return;
      }
      try {
        const nextState = updateInboxItem(payload.id, payload);
        writeJson(res, 200, { success: true, items: nextState.items });
      } catch (error) {
        writeJson(res, 404, { success: false, error: (error as Error).message });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/inbox/remove') {
      const payload = await parseJsonBody(req);
      if (!payload || typeof payload.id !== 'string' || payload.id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Item id is required.' });
        return;
      }
      const nextState = removeInboxItem(payload.id);
      writeJson(res, 200, { success: true, items: nextState.items });
      return;
    }

    if (req.method === 'POST' && req.url === '/inbox/feedback') {
      const payload = await parseJsonBody<Record<string, unknown>>(req);
      const examples = getInboxFeedbackExamples(pickFeedbackQuery(payload));
      writeJson(res, 200, { success: true, examples });
      return;
    }

    // Advanced inbox query with filtering, pagination, and sorting
    if (req.method === 'POST' && req.url === '/inbox/query') {
      const payload = await parseJsonBody<InboxQueryFilter>(req);
      const result = queryInboxItems(payload);
      writeJson(res, 200, {
        success: true,
        items: result.items,
        history: result.history,
        total: result.total,
        totalActive: result.totalActive,
        totalArchived: result.totalArchived,
        totalHistory: result.totalHistory,
        hasMore: (payload.offset ?? 0) + result.items.length < result.total,
      });
      return;
    }

    // Inbox statistics
    if (req.method === 'GET' && req.url === '/inbox/stats') {
      const stats = getInboxStats();
      writeJson(res, 200, { success: true, ...stats });
      return;
    }

    // Bulk operations
    if (req.method === 'POST' && req.url === '/inbox/bulk') {
      const payload = await parseJsonBody<BulkOperation>(req);
      if (!payload || !payload.action) {
        writeJson(res, 400, { success: false, error: 'Bulk operation action is required.' });
        return;
      }
      const result = executeBulkOperation(payload);
      writeJson(res, result.success ? 200 : 400, result);
      return;
    }

    // Diagnostics endpoints for RebelDiagnostics MCP server
    if (req.method === 'GET' && req.url === '/diagnostics/health-check') {
      const settings = getSettings();
      const report = await runSystemHealthCheck(settings, { tier: 'full' });
      writeJson(res, 200, { success: true, report });
      return;
    }

    if (req.method === 'GET' && req.url === '/diagnostics/quick-check') {
      const settings = getSettings();
      const report = await runSystemHealthCheck(settings, { tier: 'quick' });
      writeJson(res, 200, { success: true, report });
      return;
    }

    if (req.method === 'GET' && req.url === '/diagnostics/export') {
      const settings = getSettings();
      const report = await runSystemHealthCheck(settings, { tier: 'full' });
      const markdown = generateShareableReport(report);
      writeJson(res, 200, { success: true, markdown });
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', 'http://x');
    if (parsedUrl.pathname === '/diagnostics/recent-events' && req.method === 'GET') {
      try {
        const limit = parseOptionalNumberParam(parsedUrl.searchParams.get('limit'));
        const windowHours = parseOptionalNumberParam(parsedUrl.searchParams.get('windowHours'));
        const ctx = await getRecentDiagnosticContext({ limit, windowHours });
        const { markdown, entryCount } = formatRecentDiagnosticEvents(ctx);
        writeJson(res, 200, {
          success: true,
          markdown,
          eventCount: entryCount,
          readerAvailable: ctx.readerAvailable,
        });
      } catch (err) {
        log.error({ err, endpoint: '/diagnostics/recent-events' }, 'Bridge endpoint failed');
        captureKnownCondition(
          'bridge_recent_events_failure',
          { endpoint: '/diagnostics/recent-events' },
          err instanceof Error ? err : new Error(String(err)),
        );
        writeJson(res, 500, { success: false, error: 'Failed to read diagnostic events.' });
      }
      return;
    }

    if (parsedUrl.pathname === '/diagnostics/recent-logs' && req.method === 'GET') {
      try {
        const maxBytes = parseOptionalNumberParam(parsedUrl.searchParams.get('maxBytes'));
        const maxLines = parseOptionalNumberParam(parsedUrl.searchParams.get('maxLines'));
        const result = await tailRecentMainLogs({ maxBytes, maxLines });
        writeJson(res, 200, {
          success: true,
          content: result.content,
          lines: result.lines,
          bytesReturned: result.bytesReturned,
          bytesAvailable: result.bytesAvailable,
          truncated: result.truncated,
          filesRead: result.filesRead.map((file) => ({
            basename: path.basename(file.path),
            bytesRead: file.bytesRead,
          })),
          errors: result.errors.map((error) => ({
            basename: path.basename(error.path),
            reason: error.reason,
          })),
        });
        log.info({
          endpoint: '/diagnostics/recent-logs',
          status: 200,
          lines: result.lines,
          bytesReturned: result.bytesReturned,
          bytesAvailable: result.bytesAvailable,
          truncated: result.truncated,
          bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
          filesReadCount: result.filesRead.length,
          errorsCount: result.errors.length,
        }, 'Raw-log read access');
        emitPassThroughRevisitOnce();
      } catch (err) {
        log.error({ err, endpoint: '/diagnostics/recent-logs' }, 'Bridge endpoint failed');
        captureKnownCondition(
          'bridge_recent_logs_failure',
          { endpoint: '/diagnostics/recent-logs' },
          err instanceof Error ? err : new Error(String(err)),
        );
        writeJson(res, 500, { success: false, error: 'Failed to read recent log lines.' });
        log.info({
          endpoint: '/diagnostics/recent-logs',
          status: 500,
          bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
        }, 'Raw-log read access (failed)');
      }
      return;
    }

    if (parsedUrl.pathname === '/diagnostics/log-file-paths' && req.method === 'GET') {
      try {
        const result = await listRecentLogFilePaths();
        writeJson(res, 200, {
          success: true,
          logDir: result.logDir,
          files: result.files.map((file) => ({
            basename: file.basename,
            size: file.size,
            mtimeMs: file.mtimeMs,
            mtimeIso: file.mtimeIso,
          })),
          totalBytes: result.totalBytes,
          errors: result.errors.map((error) => ({
            basename: path.basename(error.path),
            reason: error.reason,
          })),
        });
        log.info({
          endpoint: '/diagnostics/log-file-paths',
          status: 200,
          filesCount: result.files.length,
          totalBytes: result.totalBytes,
          errorsCount: result.errors.length,
          bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
        }, 'Log-file-paths read access');
      } catch (err) {
        log.error({ err, endpoint: '/diagnostics/log-file-paths' }, 'Bridge endpoint failed');
        captureKnownCondition(
          'bridge_log_file_paths_failure',
          { endpoint: '/diagnostics/log-file-paths' },
          err instanceof Error ? err : new Error(String(err)),
        );
        log.info({
          endpoint: '/diagnostics/log-file-paths',
          status: 500,
          bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
        }, 'Log-file-paths read access (failed)');
        writeJson(res, 500, { success: false, error: 'Failed to read log file metadata.' });
      }
      return;
    }

    // MCP configuration endpoints
    if (req.method === 'GET' && req.url === '/mcp/list-servers') {
      const settings = getSettings();
      const configPath = resolveMcpConfigPath(settings);
      if (!configPath) {
        writeJson(res, 200, { success: true, servers: {}, configPaths: [], configured: false });
        return;
      }
      try {
        const raw = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(raw);
        writeJson(res, 200, {
          success: true,
          servers: config.mcpServers || {},
          configPaths: config.configPaths || [],
          configured: true
        });
      } catch (error) {
        log.error({ err: error, configPath }, 'Failed to read MCP config');
        writeJson(res, 500, { success: false, error: 'Failed to read MCP configuration.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/mcp/upsert-server') {
      const settings = getSettings();
      const configPath = resolveMcpConfigPath(settings);
      if (!configPath) {
        writeJson(res, 400, { success: false, error: 'No MCP config file configured. Visit Settings → Connectors first.' });
        return;
      }
      const payload = await parseJsonBody<McpCatalogUpsertPayload & Record<string, unknown>>(req);

      // ── Catalog-aware routing: catalogId present → build payload from catalog ──
      if (payload?.catalogId) {
        const catalog = loadConnectorCatalog();
        const catalogEntry = lookupCatalogEntry(payload.catalogId, catalog);

        if (!catalogEntry) {
          // Unknown catalogId and no name → error
          if (!payload.name) {
            writeJson(res, 400, { success: false, error: `Unknown catalog entry: "${payload.catalogId}". Use rebel_mcp_search_connectors to find valid IDs.` });
            return;
          }
          // Has name → fall through to raw upsert below (backward compat)
        } else {
          // Normalize email at the boundary (trim whitespace for consistent dedup + naming)
          const trimmedEmail = payload.email?.trim() || undefined;

          // Duplicate detection (shared helper — same logic as settings:mcp-add-bundled-server IPC handler)
          const existing = await findExistingCatalogServer(configPath, payload.catalogId, trimmedEmail);
          if (existing.exists) {
            const requiresAuth = catalogEntryRequiresAuth(catalogEntry);
            writeJson(res, 200, {
              success: true,
              outcome: 'already_exists',
              serverName: existing.serverName,
              requiresAuth,
              nextStep: requiresAuth
                ? `Server already connected. Authentication may still be needed — use authenticate(package_id: "${existing.serverName}") or Settings → Connectors.`
                : 'Server already connected and ready to use.',
            });
            return;
          }

          // Build payload from catalog entry
          try {
            const builtPayload = await buildPayloadFromCatalog(
              catalogEntry as Parameters<typeof buildPayloadFromCatalog>[0],
              {
                email: trimmedEmail,
                setupFields: payload.setupFields,
                providerKeys: settings.providerKeys,
                workspacePath: settings.coreDirectory ?? undefined,
              },
            );
            if (!builtPayload) {
              throw new Error(`Connector "${payload.catalogId}" is handled by a dedicated desktop registration flow and cannot be added through the bridge.`);
            }

            const backupResult = await upsertMcpServerEntry(configPath, builtPayload);
            log.info({ catalogId: payload.catalogId, serverName: builtPayload.name }, 'MCP server added from catalog via bridge');

            // Office sidecar is started lazily by server.cjs on first tool call — no eager start needed.

            const requiresAuth = catalogEntryRequiresAuth(catalogEntry);
            const accountIdentity = (catalogEntry as Record<string, unknown>).accountIdentity as IdentityKind | undefined;
            const paramName = getIdentityParamName(accountIdentity);
            const missingIdentity = paramName === 'email' && !trimmedEmail;
            const catalogSetupFields = ((catalogEntry as Record<string, unknown>).setupFields as Array<{ id: string }>) || [];
            const requiresSetup = (catalogEntry as Record<string, unknown>).requiresSetup === true;
            const hasUnfilledSetupFields = requiresSetup && catalogSetupFields.length > 0
              && catalogSetupFields.some(f => !payload.setupFields?.[f.id]?.trim());

            let nextStep: string;
            if (missingIdentity) {
              nextStep = buildMissingIdentityWarningNextStep(builtPayload.name, accountIdentity);
            } else if (requiresAuth) {
              nextStep = `Server "${builtPayload.name}" added. OAuth authentication required — use authenticate(package_id: "${builtPayload.name}") in chat, or go to Settings → Connectors to complete setup.`;
            } else if (hasUnfilledSetupFields) {
              const missing = catalogSetupFields.filter(f => !payload.setupFields?.[f.id]?.trim()).map(f => f.id);
              nextStep = `Server "${builtPayload.name}" added but still needs configuration. Missing setup fields: ${missing.join(', ')}. Provide them via setupFields or the connector will self-configure on first use.`;
            } else {
              nextStep = `Server "${builtPayload.name}" added and ready to use.`;
            }

            respondThenReloadSuperMcpForChatMaterialization(res, {
              success: true,
              outcome: 'added',
              requiresAuth,
              serverName: builtPayload.name,
              missingIdentity: missingIdentity ? (accountIdentity ?? 'email') : undefined,
              nextStep,
              backupPath: backupResult.backupPath,
            }, configPath, 'catalog upsert', 'chat-package-materialization');
            return;
          } catch (err) {
            log.error({ err, catalogId: payload.catalogId }, 'Failed to build catalog payload');
            writeJson(res, 500, { success: false, error: (err as Error).message || 'Failed to build payload from catalog entry.' });
            return;
          }
        }
      }

      // ── Raw upsert (no catalogId, or unknown catalogId with name present) ──
      const rawPayload: McpServerUpsertPayload = payload;
      if (!rawPayload || typeof rawPayload.name !== 'string' || rawPayload.name.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Server name is required.' });
        return;
      }

      // ── Auto-detect OAuth for custom HTTP/SSE URLs ──
      // The agent typically has only the URL when adding a custom MCP, so it has no
      // reliable way to know whether `oauth: true` should be set. Probe the URL with
      // an unauthenticated MCP `initialize` request: a 401 response means the server
      // requires authentication and we flip the flag before persist. This closes the
      // REBEL-1H7 Round-2 gap where Monologue was saved as a plain HTTP server,
      // `requiresAuth` stayed false, and the agent never told the user to authenticate.
      // See docs-private/postmortems/260424_rebel_1h7_*.md.
      //
      // Only runs when:
      //   - caller did not explicitly set `oauth` (respect explicit caller intent);
      //   - `url` is present (stdio servers don't need this);
      //   - probe returns 'oauth' (fail closed on 'unknown' so typo'd URLs don't
      //     trigger spurious browser popups).
      if (rawPayload.oauth !== true && rawPayload.oauth !== false && typeof rawPayload.url === 'string' && rawPayload.url.trim().length > 0) {
        try {
          const probe = await probeMcpUrlForOAuth(rawPayload.url);
          if (probe.classification === 'oauth') {
            log.info({ serverName: rawPayload.name, url: rawPayload.url, statusCode: probe.statusCode }, 'OAuth probe classified server as OAuth; setting oauth:true on payload');
            rawPayload.oauth = true;
          }
        } catch (probeErr) {
          // Probe is best-effort — never block the add on a probe failure.
          log.warn({ err: probeErr, serverName: rawPayload.name, url: rawPayload.url }, 'OAuth probe threw unexpectedly; continuing without classification');
        }
      }

      try {
        const result = await upsertMcpServerEntry(configPath, rawPayload);
        // `upsertMcpServerEntry` trims the name on persist (see mcpConfigManager.ts).
        // Use the trimmed form in all caller-facing fields so agent-follow-up calls
        // (e.g. `authenticate(package_id: ...)`) target the canonical persisted key.
        const canonicalName = rawPayload.name.trim();
        log.info({ configPath, serverName: canonicalName, oauthFlag: rawPayload.oauth === true }, 'MCP server upserted via bridge');

        // Office sidecar is started lazily by server.cjs on first tool call — no eager start here.

        // Custom (non-catalog) OAuth connectors set `oauth: true` on the raw payload.
        // Surface the same `requiresAuth` + `nextStep` contract as the catalog branch so
        // the agent knows to call `authenticate(package_id: ...)` to trigger browser auth.
        // Without this, the agent silently succeeds and the user is stuck with an
        // unauthenticated server. See docs-private/investigations/260424_REBEL-1H7_*.md.
        const requiresAuth = rawPayload.oauth === true;
        const nextStep = requiresAuth
          ? `Server "${canonicalName}" added. OAuth authentication required — use authenticate(package_id: "${canonicalName}") in chat, or go to Settings → Connectors to complete setup.`
          : `Server "${canonicalName}" added and ready to use.`;

        respondThenReloadSuperMcpForChatMaterialization(res, {
          success: true,
          outcome: 'added',
          serverName: canonicalName,
          requiresAuth,
          nextStep,
          backupPath: result.backupPath,
        }, configPath, 'raw upsert', 'chat-package-materialization');
      } catch (error) {
        log.error({ err: error, configPath }, 'Failed to upsert MCP server');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to add server.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/mcp/remove-server') {
      const settings = getSettings();
      const configPath = resolveMcpConfigPath(settings);
      if (!configPath) {
        writeJson(res, 400, { success: false, error: 'No MCP config file configured.' });
        return;
      }
      const payload = await parseJsonBody(req);
      if (!payload || typeof payload.name !== 'string' || payload.name.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Server name is required.' });
        return;
      }
      try {
        // Use centralized removal service with skipPostCleanup to avoid blocking on reconfigure.
        // We'll trigger cleanup asynchronously after responding to avoid severing the HTTP connection.
        const result = await removeMcpServerWithCleanup(configPath, payload.name, { skipPostCleanup: true });
        log.info({ configPath, serverName: payload.name, toolsRemoved: result.toolsRemoved }, 'MCP server removed via bridge');

        // Stop the Office sidecar when RebelOffice connector is disabled
        if (payload.name === 'RebelOffice') {
          stopOfficeSidecar().catch(err => {
            log.warn({ err }, 'Failed to stop Office sidecar after connector disable');
          });
        }

        // Respond BEFORE post-cleanup to avoid killing the HTTP connection
        writeJson(res, 200, {
          success: true,
          backupPath: result.backupPath
        });

        // Run post-cleanup (reconfigure Super-MCP, refresh tool index) asynchronously
        setImmediate(() => {
          performPostRemovalCleanup(configPath).catch(err => {
            log.warn({ err, serverName: payload.name }, 'Post-removal cleanup failed (non-fatal)');
          });
        });
      } catch (error) {
        log.error({ err: error, configPath }, 'Failed to remove MCP server');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to remove server.' });
      }
      return;
    }

    // Authenticate an MCP server (OAuth flow)
    // Uses the same authenticateMcpServer() as the settings IPC handler, bypassing
    // Super-MCP tool routing so it works even after a Super-MCP restart. Required by
    // the `rebel_mcp_authenticate` tool in rebel-system/server.cjs — without this
    // route, the tool returns 404 and custom OAuth MCPs cannot trigger browser auth.
    // Removed by commit eff9ee3d8 (2026-03-06), restored to fix REBEL-1H7.
    // See docs-private/investigations/260424_REBEL-1H7_custom_mcp_oauth_not_triggering.md.
    if (req.method === 'POST' && req.url === '/mcp/authenticate') {
      const payload = await parseJsonBody(req);
      const serverId = payload?.serverId;
      if (!serverId || typeof serverId !== 'string') {
        writeJson(res, 400, { success: false, error: 'serverId is required.' });
        return;
      }
      try {
        const result = await authenticateMcpServer(serverId);
        writeJson(res, 200, result);
      } catch (error) {
        log.error({ err: error, serverId }, 'Failed to authenticate MCP server via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Authentication failed.' });
      }
      return;
    }

    // Disable a specific tool on an MCP server
    // Writes to userData router config (never external configs) - same pattern as settings:mcp-toggle-tool IPC
    if (req.method === 'POST' && req.url === '/mcp/disable-tool') {
      const payload = await parseJsonBody(req);
      const serverId = payload?.serverId;
      const toolName = payload?.toolName;
      if (typeof serverId !== 'string' || serverId.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'serverId is required (the MCP server name, e.g. "Gmail" or "GoogleWorkspace-you-work-com").' });
        return;
      }
      if (typeof toolName !== 'string' || toolName.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'toolName is required (short tool name, e.g. "send_email").' });
        return;
      }
      try {
        const routerPath = path.join(getPlatformConfig().userDataPath, 'mcp', 'super-mcp-router.json');
        await ensureRouterConfigFile(routerPath);
        await setMcpToolEnabled(routerPath, serverId, toolName, false);
        log.info({ serverId, toolName, configPath: routerPath }, 'MCP tool disabled via bridge');
        writeJson(res, 200, { success: true, serverId, toolName, enabled: false });
      } catch (error) {
        log.error({ err: error, serverId, toolName }, 'Failed to disable MCP tool');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to disable tool.' });
      }
      return;
    }

    // Slack authentication endpoint
    if (req.method === 'POST' && req.url === '/bundled/slack/start-auth') {
      const settings = getSettings();
      const configPath = resolveMcpConfigPath(settings);
      if (!configPath) {
        writeJson(res, 400, { success: false, error: 'No MCP config file configured.' });
        return;
      }
      try {
        const credentials = resolveOAuthCredentials(slackCredentialSource);
        if (!credentials) {
          writeJson(res, 400, {
            success: false,
            error: 'Slack OAuth credentials not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in your environment.',
          });
          return;
        }
        // Start OAuth - don't auto-open browser, return URL for agent to show
        const { authUrl, completion } = startSlackAuth(credentials.clientId, credentials.clientSecret, { autoOpen: false });
        
        // Return auth URL immediately so agent can show clickable link to user
        writeJson(res, 200, { success: true, status: 'auth_pending', authUrl });
        
        // Wait for OAuth to complete in background, then update MCP config
        completion.then(async ({ teamId, teamName }) => {
          const tokens = await getSlackTokensForWorkspace(teamId);
          if (tokens?.botToken) {
            // Resolve OAuth credentials for token refresh support
            const oauthCreds = resolveOAuthCredentials(slackCredentialSource);
            // Create per-workspace instance (e.g., "Slack-mindstone") for multi-workspace support
            const slackPayload = buildSlackInstancePayload({
              teamId,
              teamName,
              botToken: tokens.botToken,
              userToken: tokens.userToken,
              configPath: getSlackConfigDir(),
              clientId: oauthCreds?.clientId,
              clientSecret: oauthCreds?.clientSecret,
            });
            await upsertMcpServerEntry(configPath, slackPayload);
            const instanceId = generateWorkspaceInstanceId('Slack', teamName);
            log.info({ configPath, teamName, instanceId }, 'Slack workspace instance configured via bridge');
            notifySlackWorkspaceConnected(teamId, teamName);

            // Clean up any legacy base "Slack" entry to prevent duplicates
            try {
              await removeMcpServerEntry(configPath, 'Slack');
              log.info('Removed legacy base Slack entry (replaced by workspace instance)');
            } catch {
              // Non-fatal: the entry may not exist
            }
          }
          // Restart Super-MCP to pick up changes
          try {
            await restartSuperMcp(configPath);
          } catch (restartError) {
            log.warn({ err: restartError }, 'Super-MCP restart failed after Slack auth');
          }
        }).catch((error) => {
          log.error({ err: error }, 'Slack OAuth completion failed');
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to authenticate Slack');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Slack authentication failed.' });
      }
      return;
    }

    // Microsoft authentication endpoint
    // Supports optional `additionalScopes` body param for incremental consent (e.g., SharePoint)
    if (req.method === 'POST' && req.url === '/bundled/microsoft/start-auth') {
      const settings = getSettings();
      const configPath = resolveMcpConfigPath(settings);
      if (!configPath) {
        writeJson(res, 400, { success: false, error: 'No MCP config file configured.' });
        return;
      }
      try {
        const clientId = resolveMicrosoftClientId(microsoftCredentialSource);
        if (!clientId) {
          writeJson(res, 400, {
            success: false,
            error: 'Microsoft 365 credentials not configured. Set MICROSOFT_CLIENT_ID in your environment.',
          });
          return;
        }

        // Parse optional body for incremental consent params
        const body = await parseJsonBody(req);
        let additionalScopes = Array.isArray(body?.additionalScopes) ? body.additionalScopes as string[] : undefined;

        // When additional scopes are requested, resolve loginHint from the default account.
        // Also, on reconnection (no explicit additionalScopes), preserve previously-granted
        // scopes to prevent regression from org/SharePoint back to personal OneDrive only.
        // Fall back to any existing account (e.g. expired) if no active account found.
        let loginHint: string | undefined;
        const accounts = await getMicrosoftAccounts();
        const existingAccount = accounts.find((a) => a.status === 'active') ?? accounts[0];
        if (additionalScopes) {
          loginHint = existingAccount?.email;
        } else if (existingAccount) {
          const extras = await getExtraScopesForAccount(existingAccount.email);
          if (extras.length > 0) {
            additionalScopes = extras;
            loginHint = existingAccount.email;
            log.info({ email: existingAccount.email, extraScopes: extras }, 'Bridge reconnecting with preserved scopes');
          }
        }

        // Start OAuth - this opens browser and waits for callback
        const email = await startMicrosoftAuth(clientId, additionalScopes, loginHint);
        // After successful auth, update all Microsoft MCP configs (including SharePoint)
        const configDir = getMicrosoftConfigDir();
        const microsoftConfig = { clientId, configDir, email };
        await upsertMcpServerEntry(configPath, buildMicrosoft365MailPayload(microsoftConfig));
        await upsertMcpServerEntry(configPath, buildMicrosoft365CalendarPayload(microsoftConfig));
        await upsertMcpServerEntry(configPath, buildMicrosoft365FilesPayload(microsoftConfig));
        await upsertMcpServerEntry(configPath, buildMicrosoft365TeamsPayload(microsoftConfig));
        await upsertMcpServerEntry(configPath, buildMicrosoft365SharePointPayload(microsoftConfig));
        // Clean up legacy static entries now that instance entries exist
        try {
          const serverNames = await getMcpServerNames(configPath);
          for (const baseName of MICROSOFT_SERVER_BASE_NAMES) {
            if (serverNames.includes(baseName) &&
                serverNames.some((n) => n.startsWith(`${baseName}-`) && n.length > baseName.length + 1)) {
              await removeMcpServerEntry(configPath, baseName);
            }
          }
        } catch (cleanupErr) {
          log.warn({ err: cleanupErr }, 'Failed to cleanup legacy Microsoft MCP entries');
        }
        log.info({ configPath, email }, 'Microsoft authenticated and all MCPs configured via bridge');
        // Respond before restart to avoid hanging the calling MCP tool
        respondThenReloadSuperMcpForChatMaterialization(res, { success: true, email }, configPath, 'Microsoft auth', 'chat-oauth-connect-ready');
      } catch (error) {
        log.error({ err: error }, 'Failed to authenticate Microsoft');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Microsoft authentication failed.' });
      }
      return;
    }

    // Salesforce authentication endpoint
    if (req.method === 'POST' && req.url === '/bundled/salesforce/start-auth') {
      const settings = getSettings();
      const configPath = resolveMcpConfigPath(settings);
      if (!configPath) {
        writeJson(res, 400, { success: false, error: 'No MCP config file configured.' });
        return;
      }
      try {
        // Salesforce is BYOK: credentials come from env (dev/CI) or, for end users, the
        // Connected App key/secret the setup UI saved to settings. The Salesforce-specific
        // resolver applies that precedence (env → settings → provider).
        const credentials = resolveSalesforceCredentials(salesforceCredentialSource);
        if (!credentials) {
          writeJson(res, 400, {
            success: false,
            error: 'Salesforce OAuth credentials not configured. Set SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET in your environment.',
          });
          return;
        }
        // Start OAuth - this opens browser and waits for callback
        const username = await startSalesforceAuth(credentials.clientId, credentials.clientSecret);
        // After successful auth, refresh the existing MCP config entry.
        //
        // CRITICAL: read-modify-write, NOT replace. The entry was already
        // populated correctly by `mcpAddBundledServer` (Settings flow) or
        // by a previous OAuth — including:
        //   - `email` (user-provided account label, drives Settings card UI)
        //   - `MCP_HOST_BRIDGE_STATE` + `MCP_BRIDGE_CONFIGURE_ENDPOINT` (bridge
        //     mode env from the catalog template — without these the MCP child
        //     falls into broken `standalone_oauth` mode, see Round 3 in
        //     docs/plans/260430_salesforce_oauth_browser_never_opens_settings.md)
        //   - `description`, `catalogId`, `command`, `args`
        // Wholesale-replacing here drops all of those (REPLACE semantics on
        // upsertMcpServerEntry — see src/core/services/mcpConfigManager.ts:506).
        //
        // SALESFORCE_CLIENT_ID + SALESFORCE_CLIENT_SECRET are required even
        // in bridge mode — the OSS package uses bridge ONLY for the initial
        // `salesforce_connect_account` flow; everything else (data calls,
        // token refresh) goes through jsforce client-side, which needs the
        // OAuth client creds in env to build its `oauth2` config. Without
        // them, the access token works for ~2hr then refresh fails silently
        // → every subsequent tool call surfaces as "OAuth token expired".
        // The OSS package logs a stderr warning when bridge state and client
        // creds are both set, but uses bridge mode regardless (precedence is
        // explicit). We accept the warning to get refresh working.
        const configDir = getSalesforceConfigDir();
        let existing: Awaited<ReturnType<typeof readMcpServerDetails>> | null = null;
        try {
          existing = await readMcpServerDetails(configPath, 'Salesforce');
        } catch {
          // Entry doesn't exist yet (e.g. agent-initiated reconnect on a
          // fresh install). We'll synthesize a minimal one below.
        }
        const mergedEnv: Record<string, string> = {
          ...(existing?.env ?? {}),
          // SALESFORCE_CONFIG_DIR is owned by the host — always re-assert it
          // in case the catalog template / placeholder resolution drifted.
          SALESFORCE_CONFIG_DIR: configDir,
          // Required for client-side jsforce token refresh (see comment above).
          SALESFORCE_CLIENT_ID: credentials.clientId,
          SALESFORCE_CLIENT_SECRET: credentials.clientSecret,
        };
        // Use existing email if present; fall back to OAuth-returned username
        // (which IS an email-shaped account identifier for Salesforce orgs).
        const email = existing?.email ?? username;
        // Catalog is the source of truth for the Salesforce OSS package pin
        // (per docs/plans/260525_oss_release_automation.md v2). The previous
        // legacy '@mindstone-engineering/mcp-server-salesforce' literal was
        // an unversioned silent fallback that masked catalog-load failures
        // and lagged behind the published @mindstone scope.
        const salesforceCatalogEntry = findCatalogEntryById('bundled-salesforce');
        let salesforceArgs = existing?.args;
        if (salesforceArgs == null) {
          const catalogArgs = salesforceCatalogEntry?.mcpConfig?.args;
          if (!catalogArgs || catalogArgs.length === 0) {
            throw new Error(
              'Catalog entry "bundled-salesforce" missing mcpConfig.args. The connector catalog is the source of truth for OSS package pins; falling back to a hardcoded version is no longer supported (per docs/plans/260525_oss_release_automation.md v2). This indicates a P0 catalog-load issue.',
            );
          }
          salesforceArgs = catalogArgs;
        }
        await upsertMcpServerEntry(configPath, {
          name: 'Salesforce',
          transport: 'stdio',
          command: existing?.command ?? salesforceCatalogEntry?.mcpConfig?.command ?? 'npx',
          args: [...salesforceArgs],
          description:
            existing?.description ??
            'Salesforce CRM - accounts, contacts, opportunities, leads, and SOQL queries',
          catalogId: existing?.catalogId ?? 'bundled-salesforce',
          email,
          env: mergedEnv,
          lastConnectedAt: Date.now(),
        });
        log.info({ configPath, username }, 'Salesforce authenticated and MCP configured via bridge');
        // Respond before restart to avoid hanging the calling MCP tool
        respondThenReloadSuperMcpForChatMaterialization(res, { success: true, username }, configPath, 'Salesforce auth', 'chat-oauth-connect-ready');
      } catch (error) {
        log.error({ err: error }, 'Failed to authenticate Salesforce');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Salesforce authentication failed.' });
      }
      return;
    }

    // File search endpoint
    if (req.method === 'POST' && req.url === '/file-search') {
      const payload = await parseJsonBody(req);
      const query = payload?.query;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Query is required.' });
        return;
      }

      const status = getIndexStatus();
      if (!status.workspacePath) {
        writeJson(res, 200, {
          success: true,
          results: [],
          message: 'No workspace is currently indexed.'
        });
        return;
      }

      try {
        const limit = typeof payload.limit === 'number' ? Math.min(Math.max(1, payload.limit), 20) : 5;
        const threshold = typeof payload.threshold === 'number' ? Math.max(0, Math.min(1, payload.threshold)) : 0.25;
        const fileTypes = Array.isArray(payload.fileTypes) ? payload.fileTypes : undefined;
        const pathPrefix = typeof payload.pathPrefix === 'string' && payload.pathPrefix.trim().length > 0 ? payload.pathPrefix.trim() : undefined;

        // Explicit MCP file search (rebel_search_files) — enable the lexical
        // exemption so an exact keyword/filename match survives the cosine floor (F9).
        const { status: searchStatus, results } = await semanticSearchWithStatus(query.trim(), { limit, threshold, fileTypes, pathPrefix, lexicalExemption: true });
        if (searchStatus !== 'ok') {
          // Return 200 with success:false so the MCP server renders an honest
          // unavailable state instead of the "No relevant files found" empty path.
          log.warn({ status: searchStatus, query: query.trim() }, 'File search backend unavailable');
          writeJson(res, 200, {
            success: false,
            error:
              searchStatus === 'error'
                ? 'Search is temporarily unavailable.'
                : 'Search is still warming up - your files are being prepared.',
          });
          return;
        }
        writeJson(res, 200, { success: true, results });
      } catch (error) {
        log.error({ err: error }, 'File search failed');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Search failed.' });
      }
      return;
    }

    // Source metadata search endpoint
    if (req.method === 'POST' && req.url === '/sources/search') {
      const payload = await parseJsonBody<SourceSearchPayload>(req);

      try {
        // Resolve dateRange - relative dates take precedence
        let dateRange: { after?: string; before?: string } | undefined;
        if (payload?.dateRange) {
          const relative = typeof payload.dateRange.relative === 'string' ? payload.dateRange.relative : undefined;
          if (relative) {
            // Relative date takes precedence
            const resolved = resolveRelativeDate(relative);
            if (resolved) {
              dateRange = resolved;
            } else {
              log.warn({ relative }, 'Unrecognized relative date value, falling back to explicit dates');
              dateRange = {
                after: typeof payload.dateRange.after === 'string' ? payload.dateRange.after : undefined,
                before: typeof payload.dateRange.before === 'string' ? payload.dateRange.before : undefined,
              };
            }
          } else {
            // Use explicit after/before
            dateRange = {
              after: typeof payload.dateRange.after === 'string' ? payload.dateRange.after : undefined,
              before: typeof payload.dateRange.before === 'string' ? payload.dateRange.before : undefined,
            };
          }
        }

        const params: sourceMetadataStore.SearchSourcesParams = {
          query: typeof payload?.query === 'string' ? payload.query : undefined,
          sourceTypes: Array.isArray(payload?.sourceTypes) ? payload.sourceTypes : undefined,
          participants: Array.isArray(payload?.participants) ? payload.participants : undefined,
          dateRange,
          limit: typeof payload?.limit === 'number' ? Math.min(Math.max(1, payload.limit), 50) : 20,
        };

        // Inject a status-aware semantic search adapter (maps the file index
        // service's FileSearchStatus onto sourceMetadataStore's core-local
        // SourceSearchStatus — identical string values). Routing through
        // semanticSearchWithStatus also gives source searches the existing
        // once-per-workspace `file_index_semantic_search_failed` capture.
        const { sources, totalCount, status } = await sourceMetadataStore.searchSources(
          params,
          sourceSemanticSearchAdapter,
        );

        // Hybrid-honesty rule: only report "unavailable" when semantic was
        // needed AND failed AND yielded nothing (sources empty). When text/
        // metadata results are present, show them silently as success:true even
        // if semantic was down — do NOT hide graceful results or add a degraded
        // note (matches the file-search chief-designer stance).
        if (status !== 'ok' && sources.length === 0) {
          log.warn({ status, query: params.query }, 'Source search backend unavailable');
          writeJson(res, 200, {
            success: false,
            error:
              status === 'error'
                ? 'Search is temporarily unavailable.'
                : 'Search is still warming up - sources are being prepared.',
          });
          return;
        }
        writeJson(res, 200, { success: true, sources, totalCount });
      } catch (error) {
        log.error({ err: error }, 'Source search failed');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Search failed.' });
      }
      return;
    }

    // Entity search endpoint
    if (req.method === 'POST' && req.url === '/entities/search') {
      const payload = await parseJsonBody<EntitySearchPayload>(req);

      try {
        const params: entityMetadataStore.SearchEntitiesParams = {
          name: typeof payload?.query === 'string' ? payload.query : undefined,
          email: typeof payload?.email === 'string' ? payload.email : undefined,
          company: typeof payload?.company === 'string' ? payload.company : undefined,
          entityType: payload?.entityType === 'person' || payload?.entityType === 'company' ? payload.entityType : undefined,
          noInteractionSince: typeof payload?.noInteractionSince === 'string' ? payload.noInteractionSince : undefined,
          limit: typeof payload?.limit === 'number' ? Math.min(Math.max(1, payload.limit), 50) : 20,
        };

        const result = entityMetadataStore.searchEntities(params);
        writeJson(res, 200, { success: true, ...result });
      } catch (error) {
        log.error({ err: error }, 'Entity search failed');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Entity search failed.' });
      }
      return;
    }

    // Entity resolve endpoint
    if (req.method === 'POST' && req.url === '/entities/resolve') {
      const payload = await parseJsonBody<EntityResolvePayload>(req);

      try {
        const email = typeof payload?.email === 'string' ? payload.email.trim() : undefined;
        const name = typeof payload?.name === 'string' ? payload.name.trim() : undefined;

        if (!email && !name) {
          writeJson(res, 400, { success: false, error: 'Either email or name is required.' });
          return;
        }

        let entity: entityMetadataStore.EntityMetadataEntry | undefined;

        if (email) {
          entity = entityMetadataStore.resolveByEmail(email);
        } else if (name) {
          entity = entityMetadataStore.resolveByName(name);
        }

        writeJson(res, 200, {
          success: true,
          found: !!entity,
          entity: entity ?? null,
        });
      } catch (error) {
        log.error({ err: error }, 'Entity resolve failed');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Entity resolve failed.' });
      }
      return;
    }

    // Meeting cache endpoints for RebelMeetings MCP
    if (req.method === 'GET' && req.url === '/meetings/cache') {
      const cache = getCachedMeetings();
      writeJson(res, 200, {
        success: true,
        meetings: cache?.meetings ?? [],
        populatedAt: cache?.populatedAt ?? null,
        lastSyncError: cache?.lastSyncError,
        syncWarnings: cache?.syncWarnings ?? [],
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/meetings/today') {
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const meetings = getTodaysMeetings(userTimeZone);
      writeJson(res, 200, { success: true, meetings });
      return;
    }

    if (req.method === 'POST' && req.url === '/meetings/populate') {
      // Guard: when direct calendar sync is the authoritative source (default),
      // reject LLM-initiated cache writes. The LLM path lacks RSVP filtering,
      // so allowing it to overwrite the cache would include unconfirmed meetings.
      const calSettings = getSettings();
      if (!calSettings.calendar?.useOtherCalendarProvider) {
        log.info('Ignored /meetings/populate — direct calendar sync is authoritative');
        writeJson(res, 200, {
          success: true,
          count: 0,
          skipped: 0,
          warnings: ['Direct calendar sync is active — LLM sync writes are ignored to preserve RSVP filtering.'],
        });
        return;
      }

      const payload = await parseJsonBody<MeetingsPopulatePayload>(req);
      if (!payload || !Array.isArray(payload.meetings)) {
        writeJson(res, 400, { success: false, error: 'meetings array is required.' });
        return;
      }

      // Validate and sanitize meetings before storing
      const validationErrors: string[] = [];
      const sanitizedMeetings: CachedMeeting[] = [];

      for (let i = 0; i < payload.meetings.length; i++) {
        const m = payload.meetings[i];
        if (!m || typeof m !== 'object') {
          validationErrors.push(`meetings[${i}]: not an object`);
          continue;
        }
        const meeting = m as Record<string, unknown>;

        // Required fields
        if (typeof meeting.id !== 'string' || !meeting.id) {
          validationErrors.push(`meetings[${i}]: missing or invalid id`);
          continue;
        }
        if (typeof meeting.calendarEventId !== 'string' || !meeting.calendarEventId) {
          validationErrors.push(`meetings[${i}]: missing or invalid calendarEventId`);
          continue;
        }
        if (typeof meeting.calendarSource !== 'string' || !meeting.calendarSource) {
          validationErrors.push(`meetings[${i}]: missing or invalid calendarSource`);
          continue;
        }
        if (typeof meeting.title !== 'string' || !meeting.title) {
          validationErrors.push(`meetings[${i}]: missing or invalid title`);
          continue;
        }
        if (typeof meeting.startTime !== 'string' || !meeting.startTime) {
          validationErrors.push(`meetings[${i}]: missing or invalid startTime`);
          continue;
        }
        if (typeof meeting.endTime !== 'string' || !meeting.endTime) {
          validationErrors.push(`meetings[${i}]: missing or invalid endTime`);
          continue;
        }

        // Sanitize optional fields - coerce null to undefined, filter invalid values
        const sanitized: CachedMeeting = {
          id: meeting.id,
          calendarEventId: meeting.calendarEventId,
          calendarSource: meeting.calendarSource,
          title: meeting.title,
          startTime: meeting.startTime,
          endTime: meeting.endTime,
          participants: Array.isArray(meeting.participants)
            ? meeting.participants.filter((p: unknown) => typeof p === 'string')
            : [],
        };

        // Only include meetingUrl if it's a valid http(s) URL
        if (typeof meeting.meetingUrl === 'string' && meeting.meetingUrl.trim()) {
          const url = meeting.meetingUrl.trim();
          // Security: only allow http/https URLs to prevent javascript: etc.
          if (url.startsWith('http://') || url.startsWith('https://')) {
            sanitized.meetingUrl = url;
          } else {
            log.debug({ meetingId: meeting.id, url }, 'Rejected non-http meetingUrl');
          }
        }

        sanitizedMeetings.push(sanitized);
      }

      // Log validation errors but don't fail - save what we can
      if (validationErrors.length > 0) {
        log.warn({ errors: validationErrors.slice(0, 10), total: validationErrors.length }, 'Some meetings failed validation');
      }

      // Combine calendar sync warnings with validation errors for visibility.
      // Model-authored strings stay fail-closed-filtered (typeof === 'string')
      // and are wrapped as typed bridge_reported issues at this chokepoint —
      // makeSyncIssue scrubs email-shaped substrings/connector slugs and caps
      // length, so raw model copy is never persisted verbatim (Stage 2,
      // 260611_calendar-followups). The MCP tool schema and prompt contract
      // stay string-typed; structure is imposed here, not asked of the model.
      const calendarIssues: SyncIssue[] = (Array.isArray(payload.syncWarnings)
        ? payload.syncWarnings.filter((w: unknown): w is string => typeof w === 'string')
        : []
      ).map((detail) => makeSyncIssue({ kind: 'bridge_reported' as const, detail }));
      const skippedCount = payload.meetings.length - sanitizedMeetings.length;
      const allIssues: SyncIssue[] = skippedCount > 0
        ? [...calendarIssues, makeSyncIssue({ kind: 'validation_skipped' as const, count: skippedCount })]
        : calendarIssues;

      // Hydrate prepPath from on-disk prep docs, then reapply skip state so
      // explicit skip sentinels always win over disk-scanned paths.
      const skipCal = calSettings.calendar;
      const hydratedMeetings = await attachPrepPathsFromDisk(sanitizedMeetings, calSettings.coreDirectory);
      const finalMeetings = (skipCal?.skippedMeetingIds?.length || skipCal?.prepSkippedTitles?.length)
        ? reapplySkipState(hydratedMeetings, skipCal.skippedMeetingIds ?? [], skipCal.prepSkippedTitles ?? [])
        : hydratedMeetings;
      setCachedMeetings(finalMeetings, allIssues, 'llm-bridge');
      log.info({
        count: finalMeetings.length,
        skipped: skippedCount,
        warnings: allIssues.length
      }, 'Meeting cache populated via bridge');
      writeJson(res, 200, {
        success: true,
        count: sanitizedMeetings.length,
        skipped: skippedCount,
        // Response stays string-typed for the model/MCP contract — derived
        // display-safe strings, same derivation the store persists.
        warnings: allIssues.map(renderSyncIssue)
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/meetings/update-prep') {
      const payload = await parseJsonBody<MeetingPrepUpdatePayload>(req);
      if (!payload || typeof payload.meetingId !== 'string' || typeof payload.prepPath !== 'string') {
        writeJson(res, 400, { success: false, error: 'meetingId and prepPath are required.' });
        return;
      }
      updateMeetingPrepPath(payload.meetingId, payload.prepPath);
      
      // Create two-way link between prep and transcript (if transcript exists)
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (coreDirectory) {
        const absolutePrepPath = path.isAbsolute(payload.prepPath) 
          ? payload.prepPath 
          : path.join(coreDirectory, payload.prepPath);
        
        // Security: Verify path is within workspace (prevent path traversal)
        const resolvedPath = path.resolve(absolutePrepPath);
        const resolvedCore = path.resolve(coreDirectory);
        if (!resolvedPath.startsWith(resolvedCore + path.sep)) {
          log.warn({ prepPath: payload.prepPath }, 'Rejected prep path outside workspace');
          writeJson(res, 400, { success: false, error: 'prepPath must be within workspace' });
          return;
        }
        
        void linkPrepToExistingTranscript(absolutePrepPath).catch((err) => {
          log.warn({ error: err, prepPath: absolutePrepPath }, 'Failed to link prep to transcript');
        });
      }
      
      writeJson(res, 200, { success: true });
      return;
    }

    // Save meeting prep file with frontmatter
    if (req.method === 'POST' && req.url === '/meetings/save-prep') {
      const payload = await parseJsonBody<MeetingPrepSavePayload>(req);
      const { meetingStartTime, meetingTitle, prepContent, participants, meetingId } = payload || {};

      if (typeof meetingStartTime !== 'string' || typeof meetingTitle !== 'string' || typeof prepContent !== 'string') {
        writeJson(res, 400, { success: false, error: 'meetingStartTime, meetingTitle, and prepContent are required.' });
        return;
      }

      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (!coreDirectory) {
        writeJson(res, 400, { success: false, error: 'No workspace configured.' });
        return;
      }

      try {
        // Parse meeting time (expects ISO 8601)
        const meetingDate = new Date(meetingStartTime);
        if (isNaN(meetingDate.getTime())) {
          writeJson(res, 400, { success: false, error: 'Invalid meetingStartTime format. Expected ISO 8601.' });
          return;
        }

        // Determine target space — always CoS (prep lives with transcript for linkage)
        const participantCount = Array.isArray(participants) ? participants.length : 0;
        const target = await determineTargetSpace(participantCount, coreDirectory);
        const targetAbsolutePath = target?.absolutePath ?? coreDirectory;

        // Generate slug from title (max 50 chars, lowercase, alphanumeric + hyphens)
        const slug = meetingTitle
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50);

        // Build path matching transcriptStorage format: memory/sources/yy/MM-MMM/dd/yyMMdd_HHmm_meeting_{slug}-prep.md
        // Use local time to match transcriptStorage conventions
        const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const year = meetingDate.getFullYear();
        const yy = String(year).slice(-2);
        const month = String(meetingDate.getMonth() + 1).padStart(2, '0');
        const monthAbbrev = MONTH_ABBREVS[meetingDate.getMonth()];
        const day = String(meetingDate.getDate()).padStart(2, '0');
        const hours = String(meetingDate.getHours()).padStart(2, '0');
        const minutes = String(meetingDate.getMinutes()).padStart(2, '0');

        const filename = `${yy}${month}${day}_${hours}${minutes}_meeting_${slug}-prep.md`;
        // Use 4-digit year folder (YYYY/) per source-capture SKILL
        const relativePath = joinPortablePath('memory', 'sources', String(year), `${month}-${monthAbbrev}`, day, filename);
        const absolutePath = path.join(targetAbsolutePath, relativePath);

        // Security: Verify path is within workspace
        const resolvedPath = path.resolve(absolutePath);
        const resolvedCore = path.resolve(coreDirectory);
        if (!resolvedPath.startsWith(resolvedCore + path.sep)) {
          writeJson(res, 400, { success: false, error: 'Generated path outside workspace.' });
          return;
        }

        // Check if file already exists (no silent overwrites)
        try {
          await fs.access(absolutePath);
          // File exists - return error
          writeJson(res, 409, {
            success: false,
            error: 'File already exists.',
            existingPath: relativePath,
          });
          return;
        } catch {
          // File doesn't exist - good, continue
        }

        // Helper to sanitize YAML string values (escape quotes, normalize newlines)
        const sanitizeYamlString = (s: string): string =>
          s.replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim();

        // Build frontmatter (all times in UTC)
        const frontmatterLines = [
          '---',
          'type: meeting-prep',
          `title: "${sanitizeYamlString(meetingTitle)}"`,
          `meetingStartTime: ${meetingDate.toISOString()}`,
        ];
        if (meetingId) {
          frontmatterLines.push(`meetingId: "${sanitizeYamlString(meetingId)}"`);
        }
        if (Array.isArray(participants) && participants.length > 0) {
          frontmatterLines.push('participants:');
          for (const p of participants) {
            frontmatterLines.push(`  - "${sanitizeYamlString(String(p))}"`);
          }
        }
        frontmatterLines.push(`created: ${new Date().toISOString()}`);
        frontmatterLines.push('---');

        // Sanitize prep content (strip any --- lines to prevent frontmatter injection)
        // Handles various line endings and trailing whitespace
        const sanitizedContent = prepContent.replace(/^---\s*$/gm, '');

        const markdown = frontmatterLines.join('\n') + '\n\n' + sanitizedContent;

        // Ensure directory exists and write file
        const dir = path.dirname(absolutePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(absolutePath, markdown, 'utf-8');

        log.info({ path: relativePath, meetingTitle }, 'Meeting prep saved via bridge');

        // Auto-link to cache if meeting is in 24h cache and has meetingId
        let linkedToCache = false;
        if (meetingId) {
          const cache = getCachedMeetings();
          const cachedMeeting = cache?.meetings.find(m => m.id === meetingId);
          if (cachedMeeting) {
            updateMeetingPrepPath(meetingId, relativePath);
            linkedToCache = true;
          }
        }

        writeJson(res, 200, {
          success: true,
          path: relativePath,
          linkedToCache,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to save meeting prep');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to save prep.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/focus/enrich-prep-doc') {
      const payload = await parseJsonBody<FocusPrepEnrichmentPayload>(req);
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : '';
      const goalAlignment = parseGoalAlignmentPayload(payload?.goalAlignment);
      const meetingUtility = payload?.meetingUtility;

      if (!filePath || !goalAlignment || !isMeetingUtility(meetingUtility)) {
        writeJson(res, 400, {
          success: false,
          error: 'filePath, goalAlignment, and valid meetingUtility are required.',
        });
        return;
      }

      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (!coreDirectory) {
        writeJson(res, 400, { success: false, error: 'No workspace configured.' });
        return;
      }

      const resolvedCore = path.resolve(coreDirectory);
      const resolvedPath = path.resolve(coreDirectory, filePath);
      if (!resolvedPath.startsWith(resolvedCore + path.sep)) {
        log.warn({ filePath }, 'Rejected prep enrichment path outside workspace');
        writeJson(res, 403, { success: false, error: 'filePath must be within workspace.' });
        return;
      }

      try {
        let content: string;
        try {
          content = await fs.readFile(resolvedPath, 'utf-8');
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') {
            writeJson(res, 404, { success: false, error: 'Prep doc not found.' });
            return;
          }
          throw error;
        }

        const fm = await import('front-matter');
        let parsed: { attributes: Record<string, unknown>; body: string };
        try {
          if (!fm.default.test(content)) {
            writeJson(res, 400, { success: false, error: 'File is not a meeting prep document.' });
            return;
          }
          parsed = fm.default<Record<string, unknown>>(content);
        } catch (error) {
          log.warn({ err: error, filePath: resolvedPath }, 'Failed to parse prep doc frontmatter for enrichment');
          writeJson(res, 500, { success: false, error: 'Failed to parse prep doc.' });
          return;
        }

        if (parsed.attributes.type !== 'meeting-prep') {
          writeJson(res, 400, { success: false, error: 'File is not a meeting prep document.' });
          return;
        }

        const mergedAttributes: Record<string, unknown> = {
          ...parsed.attributes,
          [PREP_ENRICHMENT_FIELDS.goalAlignment]: goalAlignment,
          [PREP_ENRICHMENT_FIELDS.meetingUtility]: meetingUtility,
          [PREP_ENRICHMENT_FIELDS.enrichedAt]: new Date().toISOString(),
          [PREP_ENRICHMENT_FIELDS.enrichedBy]: 'focus-automation',
        };

        const mergedContent = `${buildFrontmatterLines(mergedAttributes).join('\n')}\n${parsed.body}`;
        await fs.writeFile(resolvedPath, mergedContent, 'utf-8');

        writeJson(res, 200, { success: true });
      } catch (error) {
        log.error({ err: error, filePath: resolvedPath }, 'Failed to enrich prep doc');
        writeJson(res, 500, { success: false, error: 'Failed to enrich prep doc.' });
      }
      return;
    }

    // Find meeting prep files by date/title/meetingId
    if (req.method === 'POST' && req.url === '/meetings/find-prep') {
      const payload = await parseJsonBody<MeetingPrepLookupPayload>(req);
      const { meetingDate, meetingTitle, meetingId } = payload || {};

      if (!meetingDate && !meetingId) {
        writeJson(res, 400, { success: false, error: 'At least one of meetingDate or meetingId is required.' });
        return;
      }

      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (!coreDirectory) {
        writeJson(res, 400, { success: false, error: 'No workspace configured.' });
        return;
      }

      try {
        const fm = await import('front-matter');
        const results: Array<{
          path: string;
          title: string;
          meetingStartTime: string;
          meetingId?: string;
          participants?: string[];
          created: string;
          matchScore?: number;
        }> = [];

        // Helper to check a file and extract frontmatter
        const checkFile = async (filePath: string, relativePath: string): Promise<void> => {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            if (!fm.default.test(content)) return;

            const { attributes } = fm.default<Record<string, unknown>>(content);
            if (attributes.type !== 'meeting-prep') return;

            // If searching by meetingId, check for exact match
            if (meetingId && attributes.meetingId !== meetingId) return;

            // If searching by title, compute fuzzy match score
            let matchScore: number | undefined;
            if (meetingTitle && typeof attributes.title === 'string') {
              const titleSlug = meetingTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');
              const attrSlug = String(attributes.title).toLowerCase().replace(/[^a-z0-9]+/g, '-');
              // Simple overlap score
              const overlap = titleSlug.split('-').filter((w: string) => attrSlug.includes(w)).length;
              const total = titleSlug.split('-').length;
              matchScore = total > 0 ? overlap / total : 0;
              // Filter out low matches
              if (matchScore < 0.3) return;
            }

            results.push({
              path: relativePath,
              title: String(attributes.title || ''),
              meetingStartTime: String(attributes.meetingStartTime || ''),
              meetingId: attributes.meetingId ? String(attributes.meetingId) : undefined,
              participants: Array.isArray(attributes.participants) ? attributes.participants.map(String) : undefined,
              created: String(attributes.created || ''),
              matchScore,
            });
          } catch {
            // Skip files that can't be read
          }
        };

        const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        // Helper to scan a directory tree for prep files
        const scanDirectory = async (baseDir: string, basePath: string): Promise<void> => {
          try {
            const years = await fs.readdir(baseDir);
            for (const year of years) {
              const yearPath = path.join(baseDir, year);
              const yearStat = await fs.stat(yearPath).catch(() => null);
              if (!yearStat?.isDirectory()) continue;

              const months = await fs.readdir(yearPath);
              for (const month of months) {
                const monthPath = path.join(yearPath, month);
                const monthStat = await fs.stat(monthPath).catch(() => null);
                if (!monthStat?.isDirectory()) continue;

                // Handle both old format (files directly in month) and new format (day subfolders)
                const monthContents = await fs.readdir(monthPath);
                for (const item of monthContents) {
                  const itemPath = path.join(monthPath, item);
                  const itemStat = await fs.stat(itemPath).catch(() => null);
                  
                  if (itemStat?.isDirectory()) {
                    // New format: day subfolder (memory/sources/YYYY/MM-MMM/DD/)
                    const dayFiles = await fs.readdir(itemPath).catch(() => []);
                    for (const file of dayFiles) {
                      if (!file.endsWith('-prep.md')) continue;
                      const filePath = path.join(itemPath, file);
                      const relativePath = joinPortablePath(basePath, year, month, item, file);
                      await checkFile(filePath, relativePath);
                    }
                  } else if (item.endsWith('-prep.md')) {
                    // Old format: files directly in month folder
                    const relativePath = joinPortablePath(basePath, year, month, item);
                    await checkFile(itemPath, relativePath);
                  }
                }
              }
            }
          } catch {
            // Directory doesn't exist
          }
        };

        // If searching by meetingId, scan all prep files in both locations
        if (meetingId) {
          // Search new location: memory/sources/
          await scanDirectory(path.join(coreDirectory, 'memory', 'sources'), joinPortablePath('memory', 'sources'));
          // Search legacy location: meeting-transcripts/
          await scanDirectory(path.join(coreDirectory, 'meeting-transcripts'), 'meeting-transcripts');
        }

        // If searching by date, scan specific date folder(s)
        if (meetingDate && typeof meetingDate === 'string') {
          const date = new Date(meetingDate);
          if (!isNaN(date.getTime())) {
            // Use local time to match save-prep
            const year = String(date.getFullYear());
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const monthAbbrev = MONTH_ABBREVS[date.getMonth()];
            const day = String(date.getDate()).padStart(2, '0');
            const yy = year.slice(-2);

            // Search new location: memory/sources/YYYY/MM-MMM/DD/
            const newPath = path.join(coreDirectory, 'memory', 'sources', year, `${month}-${monthAbbrev}`, day);
            try {
              const files = await fs.readdir(newPath);
              for (const file of files) {
                if (!file.endsWith('-prep.md')) continue;
                // Match files for this date (yyMMdd prefix)
                if (!file.startsWith(`${yy}${month}${day}`)) continue;
                const filePath = path.join(newPath, file);
                const relativePath = joinPortablePath('memory', 'sources', year, `${month}-${monthAbbrev}`, day, file);
                if (!results.some(r => r.path === relativePath)) {
                  await checkFile(filePath, relativePath);
                }
              }
            } catch {
              // Folder doesn't exist
            }

            // Search legacy location: meeting-transcripts/YYYY/MM/
            const legacyPath = path.join(coreDirectory, 'meeting-transcripts', year, month);
            try {
              const files = await fs.readdir(legacyPath);
              for (const file of files) {
                // Match files for this specific date (old format: YYYY-MM-DD prefix)
                if (!file.startsWith(`${year}-${month}-${day}`) || !file.endsWith('-prep.md')) continue;
                const filePath = path.join(legacyPath, file);
                const relativePath = joinPortablePath('meeting-transcripts', year, month, file);
                if (!results.some(r => r.path === relativePath)) {
                  await checkFile(filePath, relativePath);
                }
              }
            } catch {
              // Folder doesn't exist
            }
          }
        }

        // Sort by match score if available, then by date
        results.sort((a, b) => {
          if (a.matchScore !== undefined && b.matchScore !== undefined) {
            return b.matchScore - a.matchScore;
          }
          return new Date(b.meetingStartTime).getTime() - new Date(a.meetingStartTime).getTime();
        });

        writeJson(res, 200, {
          found: results.length > 0,
          count: results.length,
          files: results,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to find meeting prep');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to search.' });
      }
      return;
    }

    // Meeting history endpoints for RebelMeetings MCP (Stage 6)
    if (req.method === 'POST' && req.url === '/meetings/history') {
      const payload = await parseJsonBody<MeetingsHistoryPayload>(req);
      const { startDate, endDate } = payload || {};

      try {
        // Default to ±7 days if not specified
        const now = new Date();
        const start = startDate ? new Date(startDate) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const end = endDate ? new Date(endDate) : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          writeJson(res, 400, { success: false, error: 'Invalid date format. Use ISO 8601.' });
          return;
        }

        const meetings = getMeetingsInRange(start, end);
        writeJson(res, 200, {
          success: true,
          meetings: meetings.map(m => ({
            id: m.id,
            calendarEventId: m.calendarEventId,
            calendarSource: m.calendarSource,
            title: m.title,
            startTime: m.startTime,
            endTime: m.endTime,
            meetingUrl: m.meetingUrl,
            participants: m.participants,
            transcriptStatus: m.transcriptStatus,
            transcriptPath: m.transcriptPath,
            botScheduled: m.botScheduled,
          })),
          count: meetings.length,
          range: { start: start.toISOString(), end: end.toISOString() },
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to get meeting history');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to get history.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/meetings/missed') {
      const payload = await parseJsonBody<MeetingsMissedPayload>(req);
      const { since } = payload || {};

      try {
        // Default to 7 days ago if not specified
        const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        if (isNaN(sinceDate.getTime())) {
          writeJson(res, 400, { success: false, error: 'Invalid date format. Use ISO 8601.' });
          return;
        }

        const meetings = getMissedMeetings(sinceDate);
        writeJson(res, 200, {
          success: true,
          meetings: meetings.map(m => ({
            id: m.id,
            calendarEventId: m.calendarEventId,
            calendarSource: m.calendarSource,
            title: m.title,
            startTime: m.startTime,
            endTime: m.endTime,
            meetingUrl: m.meetingUrl,
            participants: m.participants,
            transcriptStatus: m.transcriptStatus,
          })),
          count: meetings.length,
          since: sinceDate.toISOString(),
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to get missed meetings');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to get missed meetings.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/meetings/schedule-bot') {
      if (!meetingBotServiceGetter) {
        writeJson(res, 503, { success: false, error: 'Meeting bot service not available.' });
        return;
      }

      const payload = await parseJsonBody<ScheduleMeetingBotPayload>(req);
      const { meetingUrl, meetingTitle, scheduledFor } = payload || {};

      if (!meetingUrl || typeof meetingUrl !== 'string') {
        writeJson(res, 400, { success: false, error: 'meetingUrl is required.' });
        return;
      }

      // Validate scheduledFor if provided
      if (scheduledFor !== undefined && scheduledFor !== null) {
        if (typeof scheduledFor !== 'string') {
          writeJson(res, 400, { success: false, error: 'scheduledFor must be an ISO 8601 date string.' });
          return;
        }
        const scheduledDate = new Date(scheduledFor);
        if (isNaN(scheduledDate.getTime())) {
          writeJson(res, 400, { success: false, error: 'scheduledFor must be a valid ISO 8601 date.' });
          return;
        }
      }

      try {
        const service = meetingBotServiceGetter();
        const result = await service.sendBot({
          meetingUrl,
          meetingTitle: meetingTitle || undefined,
          scheduledFor: scheduledFor || undefined,
        });

        if (result.success) {
          log.info({ meetingUrl, botId: result.botId }, 'Bot scheduled via bridge');
          writeJson(res, 200, { success: true, botId: result.botId });
        } else {
          writeJson(res, 400, { success: false, error: result.error || 'Failed to schedule bot.' });
        }
      } catch (error) {
        log.error({ err: error, meetingUrl }, 'Failed to schedule bot');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to schedule bot.' });
      }
      return;
    }

    // Get live transcript for an active meeting
    if (req.method === 'GET' && req.url === '/meetings/live-transcript') {
      try {
        const { getPendingTranscripts, getPendingTranscript } = await import('@main/services/meetingBot/pendingTranscriptsStore');
        const { getActiveBotState } = await import('@main/services/meetingBot/meetingBotService');
        const fs = await import('node:fs/promises');
        const fm = await import('front-matter');

        // Check for active bot first (real-time state, updated every 3-30 seconds)
        // This is more reliable than pendingTranscript.status which only updates every 5 minutes
        const activeBot = getActiveBotState();
        const isRecording = !!activeBot && (activeBot.uiState === 'recording' || activeBot.uiState === 'joining');
        
        let activeBots: Array<{ botId: string; meetingTitle?: string; meetingUrl: string; liveTranscriptPath?: string; recordingStartTimeMs?: number; createdAt: string }> = [];
        
        if (isRecording && activeBot.botId) {
          // Use the active bot - get full info from pending transcripts
          const pending = getPendingTranscript(activeBot.botId);
          if (pending) {
            activeBots = [pending];
          }
        }
        
        // Fallback: check pendingTranscript.status for edge cases where activeBotState
        // isn't populated (e.g., app just launched, bot was pre-scheduled but not yet activated)
        if (activeBots.length === 0) {
          const pending = getPendingTranscripts();
          activeBots = pending.filter(p => p.status === 'in_meeting');
        }

        if (activeBots.length === 0) {
          writeJson(res, 200, {
            success: true,
            hasActiveMeeting: false,
            message: 'No meetings currently being recorded. Rebel\'s meeting bot is not active in any call right now.',
          });
          return;
        }

        // Return structured info about all active meetings
        const meetings = await Promise.all(activeBots.map(async (bot) => {
          const recordingStartMs = bot.recordingStartTimeMs || new Date(bot.createdAt).getTime();
          const elapsedMinutes = Math.round((Date.now() - recordingStartMs) / 60000);

          // Base meeting info (always available)
          const meetingInfo: Record<string, unknown> = {
            botId: bot.botId,
            meetingTitle: bot.meetingTitle || 'Meeting in Progress',
            meetingUrl: bot.meetingUrl,
            recordingStartedAt: new Date(recordingStartMs).toISOString(),
            elapsedMinutes,
          };

          // Try to read transcript if path exists
          if (bot.liveTranscriptPath) {
            try {
              const rawContent = await fs.readFile(bot.liveTranscriptPath, 'utf-8');
              
              // Parse frontmatter to extract structured metadata
              if (fm.default.test(rawContent)) {
                const parsed = fm.default<Record<string, unknown>>(rawContent);
                const attrs = parsed.attributes;
                
                // Extract participants from frontmatter
                const participants = Array.isArray(attrs.participants) 
                  ? attrs.participants.map(String)
                  : [];
                
                // Get just the transcript body (without frontmatter)
                const transcriptBody = parsed.body.trim();
                
                // Count words in transcript
                const wordCount = transcriptBody.split(/\s+/).filter(w => w.length > 0).length;
                
                meetingInfo.hasTranscript = true;
                meetingInfo.participants = participants;
                meetingInfo.participantCount = participants.length;
                meetingInfo.wordCount = wordCount;
                meetingInfo.lastUpdated = attrs.last_updated || null;
                
                // Include the actual transcript content
                // For very long transcripts (>50k chars), truncate with note
                if (transcriptBody.length > 50000) {
                  meetingInfo.transcript = transcriptBody.slice(-50000); // Keep most recent
                  meetingInfo.transcriptTruncated = true;
                  meetingInfo.transcriptNote = 'Transcript truncated to most recent 50,000 characters. Full transcript available at liveTranscriptPath.';
                } else {
                  meetingInfo.transcript = transcriptBody;
                  meetingInfo.transcriptTruncated = false;
                }
                
                meetingInfo.liveTranscriptPath = bot.liveTranscriptPath;
              } else {
                // File exists but no valid frontmatter - return raw
                meetingInfo.hasTranscript = true;
                meetingInfo.transcript = rawContent;
                meetingInfo.transcriptTruncated = false;
              }
            } catch (err) {
              // File doesn't exist yet (first 30s before flush) or read error
              const errCode = (err as NodeJS.ErrnoException).code;
              if (errCode === 'ENOENT') {
                meetingInfo.hasTranscript = false;
                meetingInfo.transcriptNote = 'Transcript is being captured but not yet written to disk. Try again in ~30 seconds.';
              } else {
                meetingInfo.hasTranscript = false;
                meetingInfo.transcriptError = (err as Error).message;
              }
            }
          } else {
            // No liveTranscriptPath yet - bot is recording but no captions received
            meetingInfo.hasTranscript = false;
            meetingInfo.transcriptNote = 'Recording in progress but no captions received yet. The meeting may have just started.';
          }

          return meetingInfo;
        }));

        writeJson(res, 200, {
          success: true,
          hasActiveMeeting: true,
          activeMeetingCount: meetings.length,
          meetings,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to get live transcript');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to get live transcript.' });
      }
      return;
    }

    // Send a chat message to the active meeting
    if (req.method === 'POST' && req.url === '/meetings/send-chat') {
      try {
        const body = await parseJsonBody(req) as { message?: string };
        const message = typeof body?.message === 'string' ? body.message.trim() : '';
        if (!message) {
          writeJson(res, 400, { success: false, error: 'Message is required' });
          return;
        }

        const { getActiveBotState } = await import('@main/services/meetingBot/meetingBotService');
        const activeBot = getActiveBotState();
        if (!activeBot?.botId) {
          writeJson(res, 400, { success: false, error: 'No active meeting recording. Start a recording first.' });
          return;
        }

        const { sendChatToMeeting } = await import('@main/services/meetingBot/botQAService');
        const result = await sendChatToMeeting(activeBot.botId, message);
        writeJson(res, 200, result);
      } catch (error) {
        log.error({ err: error }, 'Failed to send chat to meeting');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to send chat message.' });
      }
      return;
    }

    // Automations endpoints for RebelAutomations MCP server
    if (req.method === 'GET' && req.url === '/automations') {
      if (!automationSchedulerGetter) {
        writeJson(res, 503, { success: false, error: 'Automation scheduler not available.' });
        return;
      }
      const scheduler = automationSchedulerGetter();
      const state = scheduler.getState();
      writeJson(res, 200, { success: true, definitions: state.definitions, runs: state.runs });
      return;
    }

    if (req.method === 'GET' && req.url === '/automations/models') {
      try {
        const settings = getSettings();
        const { MODEL_OPTIONS } = await import('@shared/utils/modelNormalization');
        const claudeModels = MODEL_OPTIONS.map(m => ({
          id: m.value,
          label: m.label,
          type: 'claude' as const,
          isMainModel: m.isMainModel,
          supportedForAutomations: true,
        }));
        const profiles = (settings.localModel?.profiles ?? []).map(p => ({
          id: `profile:${p.id}`,
          label: p.name,
          type: 'profile' as const,
          isMainModel: true,
          supportedForAutomations: false,
        }));
        // Show effective current models (respecting active profiles)
        const workingProfileId = getWorkingProfileId(settings);
        const workingProfile = workingProfileId
          ? (settings.localModel?.profiles ?? []).find(p => p.id === workingProfileId)
          : null;
        const thinkingProfileId = getThinkingProfileId(settings);
        const thinkingProfile = thinkingProfileId
          ? (settings.localModel?.profiles ?? []).find(p => p.id === thinkingProfileId)
          : null;
        const currentWorking = workingProfile
          ? `${workingProfile.name} (profile)`
          : getCurrentModel(settings) ?? getDefaultModelForProvider(settings);
        const currentThinking = thinkingProfile
          ? `${thinkingProfile.name} (profile)`
          : getThinkingModel(settings) ?? null;
        writeJson(res, 200, {
          success: true,
          models: [...claudeModels, ...profiles],
          current: { working: currentWorking, thinking: currentThinking },
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to list available models');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to list models.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/automations/upsert') {
      if (!automationSchedulerGetter) {
        writeJson(res, 503, { success: false, error: 'Automation scheduler not available.' });
        return;
      }
      const scheduler = automationSchedulerGetter();
      const payload = (await parseJsonBody(req)) as AutomationDefinitionPatch;
      const isUpdate = typeof payload?.id === 'string' && payload.id.trim().length > 0;
      if (!isUpdate) {
        if (!payload || typeof payload.name !== 'string' || payload.name.trim().length === 0) {
          writeJson(res, 400, { success: false, error: 'Automation name is required.' });
          return;
        }
        if (!payload.filePath || typeof payload.filePath !== 'string' || payload.filePath.trim().length === 0) {
          writeJson(res, 400, { success: false, error: 'File path is required.' });
          return;
        }
        if (!payload.schedule || typeof payload.schedule !== 'object') {
          writeJson(res, 400, { success: false, error: 'Schedule is required.' });
          return;
        }
      }
      const existing = isUpdate
        ? scheduler.getState().definitions.find((definition) => definition.id === payload.id)
        : undefined;
      // Validate filePath existence when it's being set or changed
      const newFilePath = payload.filePath?.trim();
      if (newFilePath) {
        let shouldValidate = true;
        if (existing && existing.filePath === newFilePath) {
          shouldValidate = false; // filePath unchanged, skip validation
        }
        if (shouldValidate) {
          try {
            const settings = getSettings();
            if (settings.coreDirectory) {
              await validateAutomationFilePath(newFilePath, settings.coreDirectory);
            }
          } catch (validationError) {
            log.warn({ filePath: newFilePath, err: validationError }, 'Automation filePath validation failed');
            writeJson(res, 400, { success: false, error: (validationError as Error).message });
            return;
          }
        }
      }

      try {
        // BLOCKER 1 fix: extract schedule as unknown FIRST so MCP repairs (event_type,
        // legacy `trigger`, every_n_days without anchorDate) can be normalised by
        // fromUntrusted before the strict AutomationScheduleSchema runs. Validating
        // the rest of the patch via .omit({ schedule: true }) preserves strictness on
        // the non-schedule fields.
        const rawPayload = (payload ?? {}) as Record<string, unknown>;
        const { schedule: rawSchedule, ...payloadWithoutScheduleRaw } = rawPayload;
        const PatchWithoutScheduleSchema = AutomationDefinitionPatchSchema.omit({ schedule: true });
        const parsedPatchWithoutSchedule = PatchWithoutScheduleSchema.parse(payloadWithoutScheduleRaw);

        let normalizedScheduleForUpsert: AutomationDefinitionPatch['schedule'] | undefined;
        if (rawSchedule !== undefined) {
          const normalizedSchedule = AutomationSchedule.fromUntrusted(rawSchedule, {
            source: 'mcp',
            existingCreatedAt: existing?.createdAt,
            now: Date.now(),
          });

          if (!normalizedSchedule.ok) {
            log.warn(
              { automationId: payload.id, reason: normalizedSchedule.error.kind },
              'Rejected automation upsert from bridge: schedule validation failed',
            );
            writeJson(res, 400, {
              success: false,
              error: normalizedSchedule.error.message,
              errorKind: normalizedSchedule.error.kind,
              field: normalizedSchedule.error.field,
            });
            return;
          }

          normalizedScheduleForUpsert = normalizedSchedule.value;
        }

        const payloadForScheduler: AutomationDefinitionPatch = normalizedScheduleForUpsert
          ? { ...parsedPatchWithoutSchedule, schedule: normalizedScheduleForUpsert }
          : parsedPatchWithoutSchedule;

        const result = scheduler.upsertDefinition(payloadForScheduler);
        log.info({ automationName: payload.name }, 'Automation upserted via bridge');
        writeJson(res, 200, { success: true, definition: result });
      } catch (error) {
        if (error instanceof z.ZodError) {
          writeJson(res, 400, { success: false, error: error.message });
          return;
        }
        log.error({ err: error }, 'Failed to upsert automation');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to upsert automation.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/automations/delete') {
      if (!automationSchedulerGetter) {
        writeJson(res, 503, { success: false, error: 'Automation scheduler not available.' });
        return;
      }
      const payload = await parseJsonBody(req);
      if (!payload || typeof payload.id !== 'string' || payload.id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Automation id is required.' });
        return;
      }
      try {
        const scheduler = automationSchedulerGetter();
        const result = scheduler.deleteDefinition(payload.id);
        log.info({ automationId: payload.id }, 'Automation deleted via bridge');
        writeJson(res, 200, { success: true, definitions: result.definitions });
      } catch (error) {
        log.error({ err: error }, 'Failed to delete automation');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to delete automation.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/automations/run-now') {
      if (!automationSchedulerGetter) {
        writeJson(res, 503, { success: false, error: 'Automation scheduler not available.' });
        return;
      }
      const payload = await parseJsonBody(req);
      if (!payload || typeof payload.id !== 'string' || payload.id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Automation id is required.' });
        return;
      }
      try {
        const scheduler = automationSchedulerGetter();
        // IMPORTANT: Do not await the full automation run.
        // This endpoint is used by the RebelAutomations MCP server. Awaiting here causes the
        // MCP tool call to block for the entire automation turn, which can exceed MCP/tool
        // timeouts and make it look like the tool “hangs”.
        const state = scheduler.getState();
        const exists = state.definitions.some((def) => def.id === payload.id);
        if (!exists) {
          writeJson(res, 404, { success: false, error: 'Automation not found.' });
          return;
        }

        const alreadyRunning = state.runs.some(
          (run) => run.automationId === payload.id && run.status === 'running'
        );
        if (alreadyRunning) {
          writeJson(res, 200, { success: true, alreadyRunning: true });
          return;
        }

        void scheduler.runNow(payload.id, 'manual').catch((err) => {
          log.error({ err, automationId: payload.id }, 'Automation run-now request failed (async)');
        });
        log.info({ automationId: payload.id }, 'Automation run-now triggered via bridge (async)');
        writeJson(res, 202, { success: true, started: true });
      } catch (error) {
        log.error({ err: error }, 'Failed to run automation');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to run automation.' });
      }
      return;
    }

    // Automation tool grant endpoints (toolApprovalGrants on AutomationDefinition).
    // Note: upsertDefinition() has side effects (recalculates nextRunAt, reschedules), which
    // are benign for grants-only updates since the schedule itself doesn't change.
    if (req.method === 'GET' && req.url?.startsWith('/automations/tool-grants')) {
      if (!automationSchedulerGetter) {
        writeJson(res, 503, { success: false, error: 'Automation scheduler not available.' });
        return;
      }
      try {
        const parsedUrl = new URL(req.url, 'http://localhost');
        if (parsedUrl.pathname !== '/automations/tool-grants') {
          writeJson(res, 404, { success: false, error: 'Not Found' });
          return;
        }
        const id = parsedUrl.searchParams.get('id');
        if (!id || id.trim().length === 0) {
          writeJson(res, 400, { success: false, error: 'Automation id is required.' });
          return;
        }
        const scheduler = automationSchedulerGetter();
        const state = scheduler.getState();
        const def = state.definitions.find((d) => d.id === id);
        if (!def) {
          writeJson(res, 404, { success: false, error: 'Automation not found.' });
          return;
        }
        writeJson(res, 200, {
          success: true,
          automationId: def.id,
          automationName: def.name,
          grants: def.toolApprovalGrants ?? [],
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to list tool grants');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to list tool grants.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/automations/tool-grants/add') {
      if (!automationSchedulerGetter) {
        writeJson(res, 503, { success: false, error: 'Automation scheduler not available.' });
        return;
      }
      const payload = await parseJsonBody(req);
      if (!payload || typeof payload.id !== 'string' || payload.id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Automation id is required.' });
        return;
      }
      if (typeof payload.toolId !== 'string' || payload.toolId.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Tool id is required.' });
        return;
      }
      try {
        const toolId = payload.toolId.trim();
        const scheduler = automationSchedulerGetter();
        const state = scheduler.getState();
        const def = state.definitions.find((d) => d.id === payload.id);
        if (!def) {
          writeJson(res, 404, { success: false, error: 'Automation not found.' });
          return;
        }
        const existingGrants = def.toolApprovalGrants ?? [];
        const duplicate = existingGrants.some((g) => g.toolId === toolId);
        if (duplicate) {
          writeJson(res, 200, { success: true, duplicate: true });
          return;
        }
        const newGrant: AutomationToolGrant = {
          id: randomUUID(),
          toolId,
          createdAt: Date.now(),
          createdFrom: 'manual',
        };
        scheduler.upsertDefinition({
          id: def.id,
          schedule: def.schedule,
          toolApprovalGrants: [...existingGrants, newGrant],
        } as AutomationDefinitionPatch);
        log.info({ automationId: def.id, toolId: payload.toolId }, 'Tool grant added via bridge');
        writeJson(res, 200, { success: true, grant: newGrant });
      } catch (error) {
        log.error({ err: error }, 'Failed to add tool grant');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to add tool grant.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/automations/tool-grants/remove') {
      if (!automationSchedulerGetter) {
        writeJson(res, 503, { success: false, error: 'Automation scheduler not available.' });
        return;
      }
      const payload = await parseJsonBody(req);
      if (!payload || typeof payload.id !== 'string' || payload.id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Automation id is required.' });
        return;
      }
      if (typeof payload.grantId !== 'string' || payload.grantId.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'Grant id is required.' });
        return;
      }
      try {
        const scheduler = automationSchedulerGetter();
        const state = scheduler.getState();
        const def = state.definitions.find((d) => d.id === payload.id);
        if (!def) {
          writeJson(res, 404, { success: false, error: 'Automation not found.' });
          return;
        }
        const existingGrants = def.toolApprovalGrants ?? [];
        const filtered = existingGrants.filter((g) => g.id !== payload.grantId);
        if (filtered.length === existingGrants.length) {
          writeJson(res, 404, { success: false, error: 'Grant not found.' });
          return;
        }
        scheduler.upsertDefinition({
          id: def.id,
          schedule: def.schedule,
          toolApprovalGrants: filtered,
        } as AutomationDefinitionPatch);
        log.info({ automationId: def.id, grantId: payload.grantId }, 'Tool grant removed via bridge');
        writeJson(res, 200, { success: true });
      } catch (error) {
        log.error({ err: error }, 'Failed to remove tool grant');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to remove tool grant.' });
      }
      return;
    }

    // Space configuration endpoints
    if (req.method === 'POST' && req.url === '/space/get-config') {
      const payload = await parseJsonBody(req);
      const spacePath = payload?.spacePath;

      if (typeof spacePath !== 'string' || spacePath.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'spacePath is required.' });
        return;
      }

      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (!coreDirectory) {
        writeJson(res, 400, { success: false, error: 'No workspace configured.' });
        return;
      }

      try {
        const absolutePath = validateSpacePath(coreDirectory, spacePath);
        const frontmatter = await readSpaceReadmeFrontmatter(absolutePath);

        if (!frontmatter) {
          writeJson(res, 404, { success: false, error: `Space "${spacePath}" not found or has no configuration.` });
          return;
        }

        writeJson(res, 200, { success: true, spacePath, config: frontmatter });
      } catch (error) {
        log.error({ err: error, spacePath }, 'Failed to get space config');
        writeJson(res, 400, { success: false, error: (error as Error).message || 'Failed to get space config.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/space/update-config') {
      const payload = await parseJsonBody<SpaceUpdateConfigPayload>(req);
      const spacePath = payload?.spacePath;
      const updates = payload?.updates;

      if (typeof spacePath !== 'string' || spacePath.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'spacePath is required.' });
        return;
      }

      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        writeJson(res, 400, { success: false, error: 'updates must be an object.' });
        return;
      }

      // Allowlist: only these fields can be updated via MCP tool
      const ALLOWED_UPDATE_FIELDS = ['rebel_space_description', 'emails'];
      const requestedFields = Object.keys(updates);
      const blockedFields = requestedFields.filter(k => !ALLOWED_UPDATE_FIELDS.includes(k));

      if (blockedFields.length > 0) {
        writeJson(res, 400, {
          success: false,
          error: `Cannot update fields via this tool: ${blockedFields.join(', ')}. Use Settings > Spaces instead.`
        });
        return;
      }

      if (requestedFields.length === 0) {
        writeJson(res, 400, { success: false, error: 'No update fields provided.' });
        return;
      }

      // Validate field values
      if (updates.rebel_space_description !== undefined) {
        if (typeof updates.rebel_space_description !== 'string' || updates.rebel_space_description.trim().length === 0) {
          writeJson(res, 400, { success: false, error: 'rebel_space_description must be a non-empty string.' });
          return;
        }
      }

      if (updates.emails !== undefined) {
        if (!Array.isArray(updates.emails) || !updates.emails.every((e: unknown) => typeof e === 'string')) {
          writeJson(res, 400, { success: false, error: 'emails must be an array of strings.' });
          return;
        }
      }

      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (!coreDirectory) {
        writeJson(res, 400, { success: false, error: 'No workspace configured.' });
        return;
      }

      try {
        const absolutePath = validateSpacePath(coreDirectory, spacePath);

        // Read existing frontmatter to prevent legacy AGENTS.md shadowing issues
        const existing = await readSpaceReadmeFrontmatter(absolutePath);
        if (!existing) {
          writeJson(res, 404, { success: false, error: `Space "${spacePath}" not found or has no configuration.` });
          return;
        }

        // Build the update object, preserving rebel_space_description from existing config
        // This prevents creating a README.md without description when updating emails only
        const safeUpdates: Record<string, unknown> = {
          rebel_space_description: existing.rebel_space_description
        };
        if (updates.rebel_space_description !== undefined) {
          safeUpdates.rebel_space_description = updates.rebel_space_description.trim();
        }
        if (updates.emails !== undefined) {
          // Deduplicate and trim emails
          const uniqueEmails = [...new Set(updates.emails.map((e: string) => e.trim()).filter((e: string) => e.length > 0))];
          safeUpdates.emails = uniqueEmails;
        }

        const result = await updateSpaceFrontmatter(absolutePath, safeUpdates);

        if (!result.success) {
          writeJson(res, 500, { success: false, error: result.error || 'Failed to update space config.' });
          return;
        }

        invalidateSpaceScanCache(coreDirectory, 'updateSpaceFrontmatter:bundledInboxBridge');
        log.info({ spacePath, updates: safeUpdates }, 'Space config updated via bridge');
        writeJson(res, 200, { success: true, spacePath, updated: Object.keys(safeUpdates) });
      } catch (error) {
        log.error({ err: error, spacePath }, 'Failed to update space config');
        writeJson(res, 400, { success: false, error: (error as Error).message || 'Failed to update space config.' });
      }
      return;
    }

    // =========================================================================
    // New MCP Tools Batch (2026-01-11)
    // =========================================================================

    // 1. rebel_spaces_list - List all spaces with frontmatter
    if (req.method === 'POST' && req.url === '/spaces/list') {
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (!coreDirectory) {
        writeJson(res, 200, { success: true, spaces: [] });
        return;
      }

      try {
        // Read-only: bundled-inbox listing endpoint must not mutate
        // frontmatter. See docs/plans/260411_shared_space_maintenance.md
        // Stage 3 Refinement.
        const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
        writeJson(res, 200, { success: true, spaces });
      } catch (error) {
        log.error({ err: error }, 'Failed to list spaces');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to list spaces.' });
      }
      return;
    }

    // 2. rebel_settings_get - Get settings with sensitive fields redacted
    if (req.method === 'POST' && req.url === '/settings/get') {
      try {
        const settings = getSettings();
        const redacted = redactObjectDeep(settings);
        writeJson(res, 200, { success: true, settings: redacted });
      } catch (error) {
        log.error({ err: error }, 'Failed to get settings');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to get settings.' });
      }
      return;
    }

    // 3. rebel_conversations_list - List recent conversations
    if (req.method === 'POST' && req.url === '/conversations/list') {
      const payload = await parseJsonBody<ConversationsListPayload>(req);
      const rawLimit = payload?.limit;
      const limit = typeof rawLimit === 'number' ? Math.min(Math.max(1, rawLimit), 50) : 5;
      const excludeCurrentSession = typeof payload?.excludeCurrentSession === 'string' ? payload.excludeCurrentSession : undefined;

      try {
        const store = getIncrementalSessionStore();
        // Bundled inbox conversation picker is user-facing (default filtered list).
        const allSessions = store.listSessions();

        // Filter and sort sessions
        const filteredSessions = allSessions
          // Exclude deleted sessions
          .filter(s => !s.deletedAt)
          // Exclude privacy mode sessions (hard-coded, non-overridable)
          .filter(s => !s.privateMode)
          // Exclude specified current session
          .filter(s => !excludeCurrentSession || s.id !== excludeCurrentSession)
          // Sort by updatedAt descending (most recent first)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          // Apply limit
          .slice(0, limit);

        // Format response
        const sessions = filteredSessions.map(s => ({
          id: s.id,
          title: s.title || null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
          origin: s.origin || 'manual',
          url: formatNavigationUrl({ type: 'sessions', sessionId: s.id }),
        }));

        writeJson(res, 200, { success: true, sessions });
      } catch (error) {
        log.error({ err: error }, 'Failed to list conversations');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to list conversations.' });
      }
      return;
    }

    // 4. rebel_conversations_search - Semantic search across conversations
    if (req.method === 'POST' && req.url === '/conversations/search') {
      const payload = await parseJsonBody<ConversationSearchPayload>(req);
      const query = payload?.query;
      const limit = typeof payload?.limit === 'number' ? Math.min(Math.max(1, payload.limit), 20) : 10;

      if (typeof query !== 'string' || query.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'query is required.' });
        return;
      }

      try {
        // FOX-3003: distinguish a genuine no-match from a backend that is down
        // or still starting. Returning success+[] for an unavailable backend
        // made the MCP tool lie ("No conversations found") during an embedding
        // outage. A genuinely-empty-but-initialized index (including demo mode,
        // which runs against an isolated empty userData dir) returns `ok`+[] and
        // still renders as "No conversations found" — only a transient
        // null/embedding-down/error state returns a non-ok status.
        // Explicit user-driven search (the `rebel_conversations_search` agent tool) →
        // enable the lexical-exemption keep-rule so exact keyword/title matches surface
        // even when their embedding cosine is low (F1). Silent auto-context-injection
        // deliberately does NOT pass this.
        const { status, results } = await searchConversationsWithStatus(query.trim(), { limit, lexicalExemption: true });

        if (status !== 'ok') {
          // Return 200 with success:false so the MCP server renders this via its
          // clean "Search failed: …" path (bridgeRequest throws on non-2xx,
          // which would surface a noisier error to the model). The empty-result
          // "No conversations found" path is only reached for status === 'ok'.
          log.warn({ status, query: query.trim() }, 'Conversation search backend unavailable');
          writeJson(res, 200, {
            success: false,
            error:
              'Conversation search is temporarily unavailable (the search index/embedding service is still starting or unavailable). Try again shortly.',
          });
          return;
        }

        // Add rebel:// URLs for clickable links
        const resultsWithUrls = results.map(r => ({
          ...r,
          url: formatNavigationUrl({ type: 'sessions', sessionId: r.sessionId }),
        }));

        writeJson(res, 200, { success: true, results: resultsWithUrls });
      } catch (error) {
        log.error({ err: error }, 'Conversation search failed');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Search failed.' });
      }
      return;
    }

    // 4. rebel_conversations_get_summary - Get AI summary for conversation
    if (req.method === 'POST' && req.url === '/conversations/get-summary') {
      const payload = await parseJsonBody(req);
      const sessionId = resolveConversationSessionId(payload);

      if (!sessionId) {
        writeJson(res, 400, { success: false, error: 'sessionId or url is required.' });
        return;
      }

      try {
        const store = getIncrementalSessionStore();
        const session = await store.getSession(sessionId);

        if (!session || session.deletedAt || session.privateMode) {
          writeJson(res, 404, { success: false, error: 'Session not found.' });
          return;
        }

        const settings = getSettings();
        const summary = await generateConversationSummary(settings, session);

        writeJson(res, 200, {
          success: true,
          summary,
          fallbackUsed: summary === null,
          sessionId: session.id,
          title: session.title,
          url: formatNavigationUrl({ type: 'sessions', sessionId: session.id }),
        });
      } catch (error) {
        log.error({ err: error, sessionId }, 'Failed to generate conversation summary');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to generate summary.' });
      }
      return;
    }

    // 5. rebel_conversations_export_full - Export full conversation transcript to temp file
    if (req.method === 'POST' && req.url === '/conversations/export-full') {
      const payload = await parseJsonBody(req);
      const sessionId = resolveConversationSessionId(payload);

      if (!sessionId) {
        writeJson(res, 400, { success: false, error: 'sessionId or url is required.' });
        return;
      }

      try {
        const store = getIncrementalSessionStore();
        const session = await store.getSession(sessionId);

        if (!session || session.deletedAt || session.privateMode) {
          writeJson(res, 404, { success: false, error: 'Session not found.' });
          return;
        }

        const exportResult = formatConversationExport(session);

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-export-'));
        const filePath = path.join(tmpDir, exportResult.filename);
        await fs.writeFile(filePath, exportResult.content, { encoding: 'utf-8', mode: 0o600 });

        writeJson(res, 200, {
          success: true,
          filePath,
          filename: exportResult.filename,
          messageCount: exportResult.messageCount,
          sessionId: session.id,
          title: session.title,
          url: formatNavigationUrl({ type: 'sessions', sessionId: session.id }),
        });
      } catch (error) {
        log.error({ err: error, sessionId }, 'Failed to export conversation transcript');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to export conversation.' });
      }
      return;
    }

    // 6. rebel_conversations_send_message - Send a message to an existing conversation
    const sendMatch = req.method === 'POST' && req.url?.match(/^\/conversations\/([a-zA-Z0-9_-]+)\/send$/);
    if (sendMatch) {
      const sessionId = sendMatch[1];
      const payload = await parseJsonBody<ConversationSendPayload>(req);
      const text = payload?.text;
      const sendMessage = payload?.sendMessage !== false; // default true
      const switchToConversation = payload?.switchToConversation === true; // default false

      if (typeof text !== 'string' || text.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'text is required and must be non-empty.' });
        return;
      }

      try {
        const store = getIncrementalSessionStore();
        const session = await store.getSession(sessionId);

        if (!session || session.deletedAt || session.privateMode) {
          writeJson(res, 404, { success: false, error: 'Session not found.' });
          return;
        }

        getBroadcastService().sendToAllWindows('conversations:send-requested', {
          sessionId,
          text: text.trim(),
          sendMessage,
          switchToConversation
        });

        writeJson(res, 200, {
          success: true,
          sessionId,
          url: formatNavigationUrl({ type: 'sessions', sessionId }),
        });
      } catch (error) {
        log.error({ err: error, sessionId }, 'Failed to send message to conversation');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to send message.' });
      }
      return;
    }

    // 6. rebel_conversations_start - Start a new conversation (background or foreground)
    if (req.method === 'POST' && req.url === '/conversations/start') {
      const payload = await parseJsonBody<ConversationSendPayload>(req);
      const text = payload?.text;
      const sendMessage = payload?.sendMessage !== false; // default true
      const switchToConversation = payload?.switchToConversation === true; // default false

      if (typeof text !== 'string' || text.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'text is required and must be non-empty.' });
        return;
      }

      const sessionId = randomUUID();
      getBroadcastService().sendToAllWindows('conversations:start-requested', {
        sessionId,
        text: text.trim(),
        sendMessage,
        switchToConversation
      });

      writeJson(res, 200, {
        success: true,
        sessionId,
        url: formatNavigationUrl({ type: 'sessions', sessionId }),
      });
      return;
    }

    // 6. rebel_mcp_restart - Restart Super-MCP router
    if (req.method === 'POST' && req.url === '/mcp/restart') {
      const settings = getSettings();
      const configPath = resolveMcpConfigPath(settings);

      // Respond BEFORE restarting to avoid killing the calling process
      writeJson(res, 200, { success: true, message: 'Super-MCP restart initiated.' });

      // Restart asynchronously after response
      if (configPath) {
        setImmediate(() => {
          restartSuperMcp(configPath).catch(err => {
            log.error({ err }, 'Super-MCP restart failed');
          });
        });
      }
      return;
    }

    // 6. rebel_spaces_create - Create a new space
    if (req.method === 'POST' && req.url === '/spaces/create') {
      const payload = await parseJsonBody<CreateSpacePayload>(req);
      const name = payload?.name;
      const targetPath = payload?.targetPath;
      const description = payload?.description;
      const type = payload?.type;
      const createSubfolders = payload?.createSubfolders;

      if (typeof name !== 'string' || name.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'name is required.' });
        return;
      }

      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (!coreDirectory) {
        writeJson(res, 400, { success: false, error: 'No workspace configured.' });
        return;
      }

      await getRebelAuthProvider().refreshLicenseTier();
      if (!isFeatureEnabled('spaces:create-additional')) {
        writeJson(res, 403, {
          success: false,
          error: 'Teams license required to create additional spaces.',
        });
        return;
      }

      try {
        // Validate the final space path to prevent traversal
        const finalRelativePath = targetPath ? path.join(targetPath, name.trim()) : name.trim();
        validateSpacePath(coreDirectory, finalRelativePath);

        // Create the space using existing machinery
        const space = await createSpace(coreDirectory, {
          name: name.trim(),
          targetPath: targetPath || undefined,
          description: description || name.trim(),
          type: type || 'other',
          createSubfolders: createSubfolders !== false,
          location: 'workspace', // No symlinks via MCP
        });

        invalidateSpaceScanCache(coreDirectory, 'createSpace:bundledInboxBridge');
        log.info({ spacePath: space.path }, 'Space created via bridge');
        writeJson(res, 200, {
          success: true,
          space: {
            name: space.name,
            path: space.path,
            absolutePath: space.absolutePath,
            description: space.description,
          }
        });
      } catch (error) {
        log.error({ err: error, name }, 'Failed to create space');
        writeJson(res, 400, { success: false, error: (error as Error).message || 'Failed to create space.' });
      }
      return;
    }

    // 7. rebel_settings_update - Update low-risk settings (strict allowlist)
    if (req.method === 'POST' && req.url === '/settings/update') {
      const payload = await parseJsonBody<SettingsUpdatePayload>(req);
      const updates = payload?.updates;

      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        writeJson(res, 400, { success: false, error: 'updates object is required.' });
        return;
      }

      // Strict allowlist - only these fields can be updated
      const ALLOWED_FIELDS = ['theme', 'indexingEnabled', 'gpuEmbeddingEnabled', 'backgroundEnhancement', 'streaming', 'accentColor', 'fontScale', 'uiDensity', 'conversationWidth'];
      const requestedFields = Object.keys(updates);
      const blockedFields = requestedFields.filter(k => !ALLOWED_FIELDS.includes(k));

      if (blockedFields.length > 0) {
        writeJson(res, 400, {
          success: false,
          error: `Cannot update these fields via MCP: ${blockedFields.join(', ')}. Use Settings in the app instead.`
        });
        return;
      }

      if (requestedFields.length === 0) {
        writeJson(res, 400, { success: false, error: 'No update fields provided.' });
        return;
      }

      // Validate types
      if (updates.theme !== undefined && !['light', 'dark', 'system'].includes(updates.theme)) {
        writeJson(res, 400, { success: false, error: 'theme must be "light", "dark", or "system".' });
        return;
      }
      if (updates.indexingEnabled !== undefined && typeof updates.indexingEnabled !== 'boolean') {
        writeJson(res, 400, { success: false, error: 'indexingEnabled must be a boolean.' });
        return;
      }
      if (updates.gpuEmbeddingEnabled !== undefined && typeof updates.gpuEmbeddingEnabled !== 'boolean') {
        writeJson(res, 400, { success: false, error: 'gpuEmbeddingEnabled must be a boolean.' });
        return;
      }
      if (updates.backgroundEnhancement !== undefined && typeof updates.backgroundEnhancement !== 'boolean') {
        writeJson(res, 400, { success: false, error: 'backgroundEnhancement must be a boolean.' });
        return;
      }
      if (updates.streaming !== undefined) {
        if (typeof updates.streaming !== 'object' || updates.streaming === null || Array.isArray(updates.streaming)) {
          writeJson(res, 400, { success: false, error: 'streaming must be an object.' });
          return;
        }
        const streamingKeys = Object.keys(updates.streaming);
        if (streamingKeys.some(k => k !== 'enabled')) {
          writeJson(res, 400, { success: false, error: 'streaming can only contain "enabled" field.' });
          return;
        }
        if (updates.streaming.enabled !== undefined && typeof updates.streaming.enabled !== 'boolean') {
          writeJson(res, 400, { success: false, error: 'streaming.enabled must be a boolean.' });
          return;
        }
      }
      if (updates.accentColor !== undefined && !SETTINGS_UPDATE_ACCENT_COLORS.includes(updates.accentColor)) {
        writeJson(res, 400, { success: false, error: `accentColor must be one of: ${SETTINGS_UPDATE_ACCENT_COLORS.join(', ')}.` });
        return;
      }
      if (updates.fontScale !== undefined && !SETTINGS_UPDATE_FONT_SCALES.includes(updates.fontScale)) {
        writeJson(res, 400, { success: false, error: 'fontScale must be "small", "default", or "large".' });
        return;
      }
      if (updates.uiDensity !== undefined && !SETTINGS_UPDATE_UI_DENSITIES.includes(updates.uiDensity)) {
        writeJson(res, 400, { success: false, error: 'uiDensity must be "compact", "comfortable", or "spacious".' });
        return;
      }
      if (updates.conversationWidth !== undefined && !SETTINGS_UPDATE_CONVERSATION_WIDTHS.includes(updates.conversationWidth)) {
        writeJson(res, 400, { success: false, error: 'conversationWidth must be "narrow", "medium", or "wide".' });
        return;
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();

        // Build safe update object with deep merge for streaming
        const safeUpdates: Record<string, unknown> = {};
        if (updates.theme !== undefined) safeUpdates.theme = updates.theme;
        if (updates.indexingEnabled !== undefined) safeUpdates.indexingEnabled = updates.indexingEnabled;
        if (updates.gpuEmbeddingEnabled !== undefined) safeUpdates.gpuEmbeddingEnabled = updates.gpuEmbeddingEnabled;
        if (updates.backgroundEnhancement !== undefined) safeUpdates.backgroundEnhancement = updates.backgroundEnhancement;
        if (updates.streaming !== undefined) {
          // Deep merge to preserve other streaming.* fields
          safeUpdates.streaming = {
            ...currentSettings.streaming,
            ...updates.streaming
          };
        }
        if (updates.accentColor !== undefined) safeUpdates.accentColor = updates.accentColor;
        if (updates.fontScale !== undefined) safeUpdates.fontScale = updates.fontScale;
        if (updates.uiDensity !== undefined) safeUpdates.uiDensity = updates.uiDensity;
        if (updates.conversationWidth !== undefined) safeUpdates.conversationWidth = updates.conversationWidth;

        updateSettings(safeUpdates);
        log.info({ updates: Object.keys(safeUpdates) }, 'Settings updated via bridge');

        try {
          getBroadcastService().sendToAllWindows('settings:external-update');
        } catch { /* ignore if broadcast unavailable */ }

        writeJson(res, 200, { success: true, updated: Object.keys(safeUpdates) });
      } catch (error) {
        log.error({ err: error }, 'Failed to update settings');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to update settings.' });
      }
      return;
    }

    // POST /auth/set-claude-max-token — REMOVED (Claude Max OAuth deprecated April 2026)
    if (req.method === 'POST' && req.url === '/auth/set-claude-max-token') {
      writeJson(res, 410, { success: false, error: 'Claude Max OAuth has been deprecated. Use an API key instead.' });
      return;
    }

    // =========================================================================
    // Rebel Self-Configuration Endpoints (RebelSettings MCP tools)
    // =========================================================================

    // POST /settings/set-quality-tier - Set model quality tier
    if (req.method === 'POST' && req.url === '/settings/set-quality-tier') {
      const payload = await parseJsonBody(req);
      const tier = payload?.tier;

      const VALID_TIERS = CLAUDE_TIERS.map(t => t.id) as ReadonlyArray<typeof CLAUDE_TIERS[number]['id']>;
      if (!tier || typeof tier !== 'string' || !VALID_TIERS.includes(tier as (typeof VALID_TIERS)[number])) {
        writeJson(res, 400, { success: false, error: `tier is required and must be one of: ${VALID_TIERS.join(', ')}.` });
        return;
      }

      const tierConfig = CLAUDE_TIERS.find(t => t.id === tier);
      if (!tierConfig || !tierConfig.workingModel || !tierConfig.thinkingModel) {
        writeJson(res, 500, { success: false, error: `Quality tier '${tier}' is missing model data.` });
        return;
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();
        const currentModels = getWritableModels(currentSettings);

        updateSettings({
          models: {
            ...currentModels,
            model: tierConfig.workingModel,
            thinkingModel: tierConfig.thinkingModel,
            thinkingEffort: tierConfig.thinkingEffort,
            workingProfileId: undefined,
            thinkingProfileId: undefined,
          },
          localModel: {
            ...currentSettings.localModel,
            profiles: currentSettings.localModel?.profiles ?? [],
            activeProfileId: null,
          },
        });

        log.info({ tier }, 'Quality tier set via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        // `satisfies Record<QualityTierId, string>` locks this map to the tier
        // id union — adding a tier to CLAUDE_TIERS without a message here (or
        // vice versa) is a compile error, so the bridge can never return
        // `message: undefined` for a valid tier.
        const TIER_MESSAGES = {
          quick: 'Switched to Quick. Haiku is fast and surprisingly capable for simple tasks.',
          balanced: 'Back to Balanced. The sensible default, as defaults should be.',
          thorough: 'Switched to Thorough. Sonnet handles the work, Opus does the thinking. A good division of labor.',
          maximum: 'Maximum quality enabled. Opus everywhere, effort cranked up. The full orchestra.',
          // `frontier` (Claude Fable 5) removed while Fable access is withdrawn
          // (2026-06) — re-add here alongside the tier in qualityTiers.ts when
          // access returns (the `satisfies Record<QualityTierId,...>` enforces it).
        } satisfies Record<QualityTierId, string>;

        writeJson(res, 200, { success: true, message: TIER_MESSAGES[tierConfig.id] });
      } catch (error) {
        log.error({ err: error }, 'Failed to set quality tier');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/set-model-roles - Set specific models for working/thinking/background
    if (req.method === 'POST' && req.url === '/settings/set-model-roles') {
      const payload = await parseJsonBody(req);
      const { working, thinking, background, thinkingEffort } = payload ?? {};

      if (!working && !thinking && !background && !thinkingEffort) {
        writeJson(res, 400, { success: false, error: 'At least one of working, thinking, background, or thinkingEffort is required.' });
        return;
      }

      // Validate thinkingEffort
      const VALID_EFFORTS = ['xhigh', 'high', 'medium', 'low'] as const;
      if (thinkingEffort !== undefined && (typeof thinkingEffort !== 'string' || !VALID_EFFORTS.includes(thinkingEffort as (typeof VALID_EFFORTS)[number]))) {
        writeJson(res, 400, { success: false, error: `thinkingEffort must be one of: ${VALID_EFFORTS.join(', ')}.` });
        return;
      }

      // Build set of valid Anthropic model IDs
      const anthropicModelIds = new Set(MODEL_CATALOG.filter(m => m.provider === 'anthropic').map(m => m.id));

      const currentSettings = getSettings();
      const profiles = currentSettings.localModel?.profiles ?? [];

      // Helper to validate a model reference (model ID or profile:<id>)
      const validateModelRef = (ref: unknown, label: string): { isProfile: boolean; profileId?: string; modelId?: string; error?: string } => {
        if (typeof ref !== 'string' || !ref.trim()) {
          return { isProfile: false, error: `${label} must be a non-empty string.` };
        }
        if (isProfileReference(ref)) {
          const profileId = profileReferenceId(ref) ?? '';
          const profile = profiles.find(p => p.id === profileId);
          if (!profile) return { isProfile: true, error: `Profile '${profileId}' not found for ${label}.` };
          return { isProfile: true, profileId };
        }
        if (!anthropicModelIds.has(ref)) {
          return { isProfile: false, error: `Unknown Anthropic model '${ref}' for ${label}. Valid models: ${[...anthropicModelIds].join(', ')}.` };
        }
        return { isProfile: false, modelId: ref };
      };

      try {
        const modelsBase = getWritableModels(currentSettings);
        let behindTheScenesModel: string | undefined;

        if (working !== undefined) {
          const result = validateModelRef(working, 'working');
          if (result.error) { writeJson(res, 400, { success: false, error: result.error }); return; }
          if (result.isProfile) {
            modelsBase.workingProfileId = result.profileId;
          } else {
            modelsBase.model = result.modelId!;
            modelsBase.workingProfileId = undefined;
          }
        }

        if (thinking !== undefined) {
          const result = validateModelRef(thinking, 'thinking');
          if (result.error) { writeJson(res, 400, { success: false, error: result.error }); return; }
          if (result.isProfile) {
            modelsBase.thinkingProfileId = result.profileId;
          } else {
            modelsBase.thinkingModel = result.modelId;
            modelsBase.thinkingProfileId = undefined;
          }
        }

        if (background !== undefined) {
          if (typeof background !== 'string' || !background.trim()) {
            writeJson(res, 400, { success: false, error: 'background must be a non-empty string.' });
            return;
          }
          if (isProfileReference(background)) {
            const profileId = profileReferenceId(background) ?? '';
            const profile = profiles.find(p => p.id === profileId);
            if (!profile) { writeJson(res, 400, { success: false, error: `Profile '${profileId}' not found for background.` }); return; }
            behindTheScenesModel = background;
          } else if (!anthropicModelIds.has(background)) {
            writeJson(res, 400, { success: false, error: `Unknown Anthropic model '${background}' for background.` });
            return;
          } else {
            behindTheScenesModel = background;
          }
        }

        if (thinkingEffort !== undefined) {
          modelsBase.thinkingEffort = thinkingEffort as 'xhigh' | 'high' | 'medium' | 'low';
        }

        const { updateSettings } = await import('@main/settingsStore');
        const settingsUpdate: Partial<AppSettings> = { models: modelsBase };
        if (behindTheScenesModel !== undefined) settingsUpdate.behindTheScenesModel = behindTheScenesModel;

        updateSettings(settingsUpdate);
        log.info({ updates: Object.keys(payload ?? {}) }, 'Model roles updated via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        // Build human-readable response
        const parts: string[] = [];
        if (working) parts.push(`Working: ${working}`);
        if (thinking) parts.push(`Thinking: ${thinking}`);
        if (background) parts.push(`Background: ${background}`);
        if (thinkingEffort) parts.push(`Effort: ${thinkingEffort}`);
        writeJson(res, 200, { success: true, message: `Updated model roles. ${parts.join(', ')}.` });
      } catch (error) {
        log.error({ err: error }, 'Failed to set model roles');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/set-voice - Configure voice settings
    if (req.method === 'POST' && req.url === '/settings/set-voice') {
      const payload = await parseJsonBody(req);
      const { provider, ttsVoice, autoSpeak, voiceInputLanguage } = payload ?? {};

      if (provider === undefined && ttsVoice === undefined && autoSpeak === undefined && voiceInputLanguage === undefined) {
        writeJson(res, 400, { success: false, error: 'At least one voice setting is required.' });
        return;
      }

      const VALID_PROVIDERS = ['openai-whisper', 'elevenlabs-scribe', 'local-parakeet', 'local-moonshine', 'custom-openai'] as const;
      if (provider !== undefined && (typeof provider !== 'string' || !VALID_PROVIDERS.includes(provider as (typeof VALID_PROVIDERS)[number]))) {
        writeJson(res, 400, { success: false, error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}.` });
        return;
      }

      if (ttsVoice !== undefined && typeof ttsVoice !== 'string') {
        writeJson(res, 400, { success: false, error: 'ttsVoice must be a string.' });
        return;
      }

      if (autoSpeak !== undefined && typeof autoSpeak !== 'boolean') {
        writeJson(res, 400, { success: false, error: 'autoSpeak must be a boolean.' });
        return;
      }

      if (voiceInputLanguage !== undefined && typeof voiceInputLanguage !== 'string') {
        writeJson(res, 400, { success: false, error: 'voiceInputLanguage must be a string.' });
        return;
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();

        const voiceUpdate = {
          ...currentSettings.voice,
          ...(provider !== undefined ? { provider: provider as 'openai-whisper' | 'elevenlabs-scribe' | 'local-parakeet' | 'local-moonshine' | 'custom-openai' } : {}),
          ...(ttsVoice !== undefined ? { ttsVoice } : {}),
          ...(autoSpeak !== undefined ? { autoSpeak } : {}),
          ...(voiceInputLanguage !== undefined ? { voiceInputLanguage } : {}),
        };

        // normalizeSettings() handles voice<->ttsVoice normalization automatically
        updateSettings({ voice: voiceUpdate });
        log.info({ updates: Object.keys(payload ?? {}) }, 'Voice settings updated via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        const parts: string[] = [];
        if (provider) parts.push(`Provider: ${provider}`);
        if (ttsVoice) parts.push(`Voice: ${ttsVoice}`);
        if (autoSpeak !== undefined) parts.push(`Auto-speak: ${autoSpeak ? 'on' : 'off'}`);
        if (voiceInputLanguage) parts.push(`Language: ${voiceInputLanguage}`);

        let providerNote = '';
        if (provider) {
          providerNote = ' Voice and model will be auto-normalised for the new provider.';
        }

        writeJson(res, 200, { success: true, message: `Voice settings updated. ${parts.join(', ')}.${providerNote}` });
      } catch (error) {
        log.error({ err: error }, 'Failed to update voice settings');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/activate-model-profile - Activate or deactivate a model profile for a role
    if (req.method === 'POST' && req.url === '/settings/activate-model-profile') {
      const payload = await parseJsonBody(req);
      const profileId = payload?.profileId;
      const role = payload?.role;

      const VALID_ROLES = ['working', 'thinking'] as const;
      if (role === undefined || typeof role !== 'string' || !VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
        writeJson(res, 400, { success: false, error: `role is required and must be one of: ${VALID_ROLES.join(', ')}.` });
        return;
      }

      if (profileId !== undefined && profileId !== null && typeof profileId !== 'string') {
        writeJson(res, 400, { success: false, error: 'profileId must be a string or null.' });
        return;
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();
        const profiles = currentSettings.localModel?.profiles ?? [];

        // Validate profile exists and is enabled (if activating)
        if (profileId) {
          const profile = profiles.find(p => p.id === profileId);
          if (!profile) {
            writeJson(res, 400, { success: false, error: `Profile '${profileId}' not found.` });
            return;
          }
          if (profile.enabled === false) {
            writeJson(res, 400, { success: false, error: `Profile '${profile.name}' is disabled.` });
            return;
          }
        }

        const modelsBase = getWritableModels(currentSettings);
        const localModelBase = {
          ...currentSettings.localModel,
          profiles: currentSettings.localModel?.profiles ?? [],
          activeProfileId: currentSettings.localModel?.activeProfileId ?? null,
        };

        if (role === 'working') {
          modelsBase.workingProfileId = profileId ?? undefined;
          // Must-fix #1: Clear activeProfileId when deactivating working role
          if (!profileId) {
            localModelBase.activeProfileId = null;
          }
        } else {
          modelsBase.thinkingProfileId = profileId ?? undefined;
        }

        updateSettings({ models: modelsBase, localModel: localModelBase });

        const profileName = profileId
          ? profiles.find(p => p.id === profileId)?.name ?? profileId
          : 'Claude';
        const action = profileId ? 'Activated' : 'Deactivated profile for';

        log.info({ profileId, role }, 'Model profile activation updated via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        writeJson(res, 200, {
          success: true,
          message: profileId
            ? `Assigned '${profileName}' as the ${role === 'working' ? 'Working' : 'Thinking'} model.`
            : `${action} ${role === 'working' ? 'Working' : 'Thinking'} role. Claude will handle it.`,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to activate model profile');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // GET /settings/list-model-profiles - List saved model profiles
    if (req.method === 'GET' && req.url === '/settings/list-model-profiles') {
      try {
        const currentSettings = getSettings();
        const profiles = currentSettings.localModel?.profiles ?? [];
        const workingProfileId = getWorkingProfileId(currentSettings);
        const thinkingProfileId = getThinkingProfileId(currentSettings);

        const maskedProfiles = profiles.map(p => ({
          id: p.id,
          name: p.name,
          providerType: p.providerType ?? 'other',
          serverUrl: p.serverUrl ? new URL(p.serverUrl).hostname : null,
          model: p.model ?? null,
          enabled: p.enabled !== false,
          councilEnabled: p.councilEnabled ?? false,
          isWorking: p.id === workingProfileId,
          isThinking: p.id === thinkingProfileId,
          hasApiKey: !!p.apiKey,
        }));

        writeJson(res, 200, {
          success: true,
          profiles: maskedProfiles,
          workingModel: getCurrentModel(currentSettings) ?? null,
          thinkingModel: getThinkingModel(currentSettings) ?? null,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to list model profiles');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/add-model-profile - Add a new model profile
    if (req.method === 'POST' && req.url === '/settings/add-model-profile') {
      const payload = await parseJsonBody(req);
      const { name, providerType, serverUrl, model, apiKey } = payload ?? {};

      if (!name || typeof name !== 'string' || !name.trim()) {
        writeJson(res, 400, { success: false, error: 'name is required.' });
        return;
      }

      const VALID_PROVIDER_TYPES = ['openai', 'google', 'together', 'cerebras', 'local'] as const;
      if (!providerType || typeof providerType !== 'string' || !VALID_PROVIDER_TYPES.includes(providerType as (typeof VALID_PROVIDER_TYPES)[number])) {
        writeJson(res, 400, { success: false, error: `providerType must be one of: ${VALID_PROVIDER_TYPES.join(', ')}. Use Settings UI for 'other' providers.` });
        return;
      }

      // Resolve server URL based on provider type
      const PROVIDER_URLS: Record<string, string> = {
        openai: 'https://api.openai.com/v1',
        google: 'https://generativelanguage.googleapis.com/v1beta/openai',
        together: 'https://api.together.xyz/v1',
        cerebras: 'https://api.cerebras.ai/v1',
      };

      let resolvedUrl = PROVIDER_URLS[providerType as string];
      if (providerType === 'local') {
        if (!serverUrl || typeof serverUrl !== 'string') {
          writeJson(res, 400, { success: false, error: 'serverUrl is required for local providers.' });
          return;
        }
        try {
          const parsedUrl = new URL(serverUrl);
          const hostname = parsedUrl.hostname;
          if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
            writeJson(res, 400, { success: false, error: 'Local provider serverUrl must use localhost or 127.0.0.1.' });
            return;
          }
          resolvedUrl = serverUrl;
        } catch {
          writeJson(res, 400, { success: false, error: 'Invalid serverUrl format.' });
          return;
        }
      }

      if (apiKey !== undefined && typeof apiKey !== 'string') {
        writeJson(res, 400, { success: false, error: 'apiKey must be a string.' });
        return;
      }

      if (model !== undefined && typeof model !== 'string') {
        writeJson(res, 400, { success: false, error: 'model must be a string.' });
        return;
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();
        const profiles = [...(currentSettings.localModel?.profiles ?? [])];

        // Upsert: if profile with same name exists, update it
        const existingIdx = profiles.findIndex(p => p.name === name.trim());
        const profileId = existingIdx >= 0 ? profiles[existingIdx].id : randomUUID();

        const newProfile = {
          id: profileId,
          name: name.trim(),
          providerType: providerType as 'openai' | 'google' | 'together' | 'cerebras' | 'local',
          serverUrl: resolvedUrl,
          model: typeof model === 'string' ? model : undefined,
          apiKey: typeof apiKey === 'string' ? apiKey : undefined,
          createdAt: existingIdx >= 0 ? profiles[existingIdx].createdAt : Date.now(),
          enabled: true,
        };

        if (existingIdx >= 0) {
          profiles[existingIdx] = { ...profiles[existingIdx], ...newProfile };
        } else {
          profiles.push(newProfile);
        }

        updateSettings({
          localModel: {
            ...currentSettings.localModel,
            profiles,
            activeProfileId: currentSettings.localModel?.activeProfileId ?? null,
          },
        });

        log.info({ profileId, providerType, isUpdate: existingIdx >= 0 }, 'Model profile added via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        const action = existingIdx >= 0 ? 'Updated' : 'Added';
        writeJson(res, 200, {
          success: true,
          profileId,
          message: `${action} profile '${name.trim()}' (id: ${profileId}). Use rebel_settings_activate_model_profile to assign it a role.`,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to add model profile');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/edit-model-profile - Edit an existing model profile
    if (req.method === 'POST' && req.url === '/settings/edit-model-profile') {
      const payload = await parseJsonBody(req);
      const profileId = payload?.profileId;

      if (!profileId || typeof profileId !== 'string') {
        writeJson(res, 400, { success: false, error: 'profileId is required.' });
        return;
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();
        const profiles = [...(currentSettings.localModel?.profiles ?? [])];

        const profileIndex = profiles.findIndex(p => p.id === profileId);
        if (profileIndex === -1) {
          writeJson(res, 404, { success: false, error: `Profile '${profileId}' not found.` });
          return;
        }

        const existing = profiles[profileIndex];
        const changes: string[] = [];

        // Apply updates (only provided fields)
        const updated = { ...existing };

        if (payload.name !== undefined && typeof payload.name === 'string' && payload.name.trim()) {
          updated.name = payload.name.trim();
          if (updated.name !== existing.name) changes.push(`name → '${updated.name}'`);
        }
        if (payload.model !== undefined) {
          updated.model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined;
          if (updated.model !== existing.model) changes.push(`model → '${updated.model ?? '(cleared)'}'`);
        }
        if (payload.apiKey !== undefined) {
          if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
            updated.apiKey = payload.apiKey.trim();
            changes.push('apiKey updated');
          } else {
            updated.apiKey = undefined;
            if (existing.apiKey) changes.push('apiKey cleared');
          }
        }

        if (changes.length === 0) {
          writeJson(res, 200, { success: true, message: `No changes to profile '${existing.name}'.` });
          return;
        }

        profiles[profileIndex] = updated;

        updateSettings({
          localModel: {
            ...currentSettings.localModel,
            profiles,
            activeProfileId: currentSettings.localModel?.activeProfileId ?? null,
          },
        });

        log.info({ profileId, changes }, 'Model profile edited via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        writeJson(res, 200, {
          success: true,
          message: `Updated profile '${updated.name}': ${changes.join(', ')}.`,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to edit model profile');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/remove-model-profile - Remove a model profile
    if (req.method === 'POST' && req.url === '/settings/remove-model-profile') {
      const payload = await parseJsonBody(req);
      const profileId = payload?.profileId;

      if (!profileId || typeof profileId !== 'string') {
        writeJson(res, 400, { success: false, error: 'profileId is required.' });
        return;
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();
        const profiles = currentSettings.localModel?.profiles ?? [];

        const profile = profiles.find(p => p.id === profileId);
        if (!profile) {
          writeJson(res, 404, { success: false, error: `Profile '${profileId}' not found.` });
          return;
        }

        const profileName = profile.name;
        const roleClearances: string[] = [];

        // Check if active for any role and clear assignments
        const modelsBase = getWritableModels(currentSettings);
        const localModelBase = {
          ...currentSettings.localModel,
          profiles: profiles.filter(p => p.id !== profileId),
          activeProfileId: currentSettings.localModel?.activeProfileId ?? null,
        };

        if (getWorkingProfileId(currentSettings) === profileId) {
          modelsBase.workingProfileId = undefined;
          roleClearances.push('Working');
        }
        if (getThinkingProfileId(currentSettings) === profileId) {
          modelsBase.thinkingProfileId = undefined;
          roleClearances.push('Thinking');
        }
        if (currentSettings.localModel?.activeProfileId === profileId) {
          localModelBase.activeProfileId = null;
        }

        updateSettings({ models: modelsBase, localModel: localModelBase });

        log.info({ profileId, profileName, roleClearances }, 'Model profile removed via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        const roleNote = roleClearances.length > 0
          ? ` The ${roleClearances.join(' and ')} role${roleClearances.length > 1 ? 's have' : ' has'} reverted to Claude.`
          : ' It wasn\'t assigned to any role.';

        writeJson(res, 200, {
          success: true,
          message: `Removed profile '${profileName}'.${roleNote}`,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to remove model profile');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/set-api-key - Store and validate an API key (HIGHEST RISK)
    if (req.method === 'POST' && req.url === '/settings/set-api-key') {
      const payload = await parseJsonBody(req);
      const provider = payload?.provider;
      const apiKey = payload?.apiKey;

      const VALID_PROVIDERS = ['claude', 'openai', 'elevenlabs', 'google', 'together', 'cerebras'] as const;
      if (!provider || typeof provider !== 'string' || !VALID_PROVIDERS.includes(provider as (typeof VALID_PROVIDERS)[number])) {
        writeJson(res, 400, { success: false, error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}.` });
        return;
      }

      if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        writeJson(res, 400, { success: false, error: 'apiKey is required and must be non-empty.' });
        return;
      }

      const trimmedKey = apiKey.trim();

      // Format validation per provider
      const FORMAT_CHECKS: Record<string, { test: (k: string) => boolean; error: string; prefixLen: number }> = {
        claude: {
          test: (k) => k.startsWith('sk-ant-api'),
          error: 'Claude API key should start with "sk-ant-api".',
          prefixLen: 10,
        },
        openai: {
          test: (k) => k.startsWith('sk-'),
          error: 'OpenAI key should start with "sk-".',
          prefixLen: 3,
        },
        elevenlabs: {
          test: (k) => /^[a-f0-9]{32}$/i.test(k),
          error: 'ElevenLabs key should be a 32-character hex string.',
          prefixLen: 4,
        },
        google: {
          test: (k) => k.startsWith('AIza'),
          error: 'Google key should start with "AIza".',
          prefixLen: 4,
        },
        together: {
          test: (k) => k.length >= 10,
          error: 'Together key should be at least 10 characters.',
          prefixLen: 4,
        },
        cerebras: {
          test: (k) => k.length >= 10,
          error: 'Cerebras key should be at least 10 characters.',
          prefixLen: 4,
        },
      };

      const formatCheck = FORMAT_CHECKS[provider];
      if (!formatCheck.test(trimmedKey)) {
        writeJson(res, 400, { success: false, error: `Invalid key format. ${formatCheck.error}` });
        return;
      }

      // Mask key for safe logging/response
      const prefixLen = formatCheck.prefixLen;
      const maskedKey = trimmedKey.slice(0, prefixLen) + '****' + trimmedKey.slice(-4);

      try {
        // API validation for providers with validators
        if (provider === 'claude' || provider === 'openai' || provider === 'elevenlabs') {
          let validationResult;
          if (provider === 'claude') {
            validationResult = await validateClaudeKey(trimmedKey);
          } else if (provider === 'openai') {
            validationResult = await validateOpenAiKey(trimmedKey);
          } else {
            validationResult = await validateElevenLabsKey(trimmedKey);
          }

          // Strict fail-closed: if validation failed for any reason (including network), reject
          if (!validationResult.ok) {
            writeJson(res, 400, {
              success: false,
              error: `Key validation failed: ${validationResult.message}. Key was NOT saved.`,
            });
            return;
          }
        }

        // Store key via settings:update so provider-key rotation lifecycle hooks fire.
        const settingsUpdateHandler = getHandlerRegistry().get('settings:update');
        if (!settingsUpdateHandler) {
          throw new Error('settings:update handler is unavailable');
        }
        const currentSettings = getSettings();
        const currentModels = getWritableModels(currentSettings);

        switch (provider) {
          case 'claude':
            await settingsUpdateHandler(null, {
              ...currentSettings,
              models: {
                ...currentModels,
                apiKey: trimmedKey,
                authMethod: 'api-key',
              },
            });
            break;
          case 'openai':
            await settingsUpdateHandler(null, {
              ...currentSettings,
              providerKeys: { ...currentSettings.providerKeys, openai: trimmedKey },
            });
            break;
          case 'elevenlabs':
            await settingsUpdateHandler(null, {
              ...currentSettings,
              voice: { ...currentSettings.voice, elevenlabsApiKey: trimmedKey },
            });
            break;
          case 'google':
            await settingsUpdateHandler(null, {
              ...currentSettings,
              providerKeys: { ...currentSettings.providerKeys, google: trimmedKey },
            });
            break;
          case 'together':
            await settingsUpdateHandler(null, {
              ...currentSettings,
              providerKeys: { ...currentSettings.providerKeys, together: trimmedKey },
            });
            break;
          case 'cerebras':
            await settingsUpdateHandler(null, {
              ...currentSettings,
              providerKeys: { ...currentSettings.providerKeys, cerebras: trimmedKey },
            });
            break;
        }

        log.info({ provider }, 'API key stored via bridge');

        // No connector-specific re-registration here: rebel-oss connectors
        // (e.g. openai-image-generation) pick up rotated provider keys on
        // the next super-mcp spawn via cloud-service `mcpEnvResolver`
        // (Stage 0.5) or via the generic settings:update cohort rotation
        // path in `settingsHandlers.ts` (`findRebelOssConnectorsUsingProviderKey`).
        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        const validatedNote = (provider === 'claude' || provider === 'openai' || provider === 'elevenlabs')
          ? ' saved and verified'
          : ' saved (format verified, not validated against API)';

        writeJson(res, 200, {
          success: true,
          message: `${provider.charAt(0).toUpperCase() + provider.slice(1)} key${validatedNote}. Masked: ${maskedKey}`,
        });
      } catch (error) {
        log.error({ err: error, provider }, 'Failed to set API key');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/set-memory-safety-defaults - Set global memory safety defaults
    if (req.method === 'POST' && req.url === '/settings/set-memory-safety-defaults') {
      const payload = await parseJsonBody(req);
      const privateSafety = payload?.private;
      const sharedSafety = payload?.shared;

      if (privateSafety === undefined && sharedSafety === undefined) {
        writeJson(res, 400, { success: false, error: 'At least one of private or shared is required.' });
        return;
      }

      const VALID_LEVELS = ['permissive', 'balanced', 'cautious'] as const;
      if (privateSafety !== undefined && (typeof privateSafety !== 'string' || !VALID_LEVELS.includes(privateSafety as (typeof VALID_LEVELS)[number]))) {
        writeJson(res, 400, { success: false, error: `private must be one of: ${VALID_LEVELS.join(', ')}.` });
        return;
      }

      const VALID_SHARED_LEVELS = ['balanced', 'cautious'] as const;
      if (sharedSafety !== undefined && (typeof sharedSafety !== 'string' || !VALID_SHARED_LEVELS.includes(sharedSafety as (typeof VALID_SHARED_LEVELS)[number]))) {
        writeJson(res, 400, { success: false, error: 'shared must be "balanced" or "cautious". Shared spaces cannot be permissive.' });
        return;
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const safeUpdates: Record<string, unknown> = {};
        if (privateSafety !== undefined) safeUpdates.memorySafetyPrivate = privateSafety;
        if (sharedSafety !== undefined) safeUpdates.memorySafetyShared = sharedSafety;

        updateSettings(safeUpdates);
        log.info({ updates: Object.keys(safeUpdates) }, 'Memory safety defaults updated via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        const LEVEL_DESCRIPTIONS: Record<string, string> = {
          permissive: 'auto-save without asking',
          balanced: 'check before saving sensitive content',
          cautious: 'always ask before saving',
        };

        const parts: string[] = [];
        if (privateSafety) parts.push(`Private spaces: ${privateSafety} (${LEVEL_DESCRIPTIONS[privateSafety]})`);
        if (sharedSafety) parts.push(`Shared spaces: ${sharedSafety} (${LEVEL_DESCRIPTIONS[sharedSafety]})`);

        writeJson(res, 200, { success: true, message: `Memory safety updated. ${parts.join('. ')}.` });
      } catch (error) {
        log.error({ err: error }, 'Failed to set memory safety defaults');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // POST /settings/set-space-safety - Set safety level for a specific space
    if (req.method === 'POST' && req.url === '/settings/set-space-safety') {
      const payload = await parseJsonBody(req);
      const spacePath = payload?.spacePath;
      const level = payload?.level;

      if (!spacePath || typeof spacePath !== 'string') {
        writeJson(res, 400, { success: false, error: 'spacePath is required.' });
        return;
      }

      const VALID_LEVELS = ['permissive', 'balanced', 'cautious'] as const;
      if (!level || typeof level !== 'string' || !VALID_LEVELS.includes(level as (typeof VALID_LEVELS)[number])) {
        writeJson(res, 400, { success: false, error: `level must be one of: ${VALID_LEVELS.join(', ')}.` });
        return;
      }

      try {
        const currentSettings = getSettings();
        const coreDirectory = currentSettings.coreDirectory;

        // Validate space exists
        const spaces = currentSettings.spaces ?? [];
        const spaceConfig = spaces.find(s => s.path === spacePath);
        if (!spaceConfig) {
          // Also check via scanSpaces if coreDirectory is available.
          // Read-only: space-validation lookup must not mutate frontmatter.
          // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
          if (coreDirectory) {
            const scannedSpaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
            const scannedSpace = scannedSpaces.find(s => s.path === spacePath);
            if (!scannedSpace) {
              writeJson(res, 404, { success: false, error: `Space '${spacePath}' not found.` });
              return;
            }
          } else {
            writeJson(res, 404, { success: false, error: `Space '${spacePath}' not found.` });
            return;
          }
        }

        // Chief-of-Staff is always permissive (locked)
        if (spaceConfig?.type === 'chief-of-staff' || spacePath === 'Chief-of-Staff') {
          writeJson(res, 400, { success: false, error: "Chief-of-Staff stays permissive — that one's locked by design. It's your private space." });
          return;
        }

        // Shared spaces cannot be permissive
        const isShared = spaceConfig?.sharing && spaceConfig.sharing !== 'private';
        if (isShared && level === 'permissive') {
          writeJson(res, 400, { success: false, error: "Shared spaces can't be permissive — it's a safety constraint." });
          return;
        }

        const { updateSettings } = await import('@main/settingsStore');
        const currentLevels = currentSettings.spaceSafetyLevels ?? {};
        updateSettings({
          spaceSafetyLevels: { ...currentLevels, [spacePath]: level as 'permissive' | 'balanced' | 'cautious' },
        });

        log.info({ spacePath, level }, 'Space safety level updated via bridge');

        try { getBroadcastService().sendToAllWindows('settings:external-update'); } catch { /* ignore */ }

        writeJson(res, 200, {
          success: true,
          message: `Safety for '${spacePath}' set to ${level}. ${level === 'cautious' ? 'Rebel will ask before saving anything there.' : level === 'balanced' ? 'Rebel will check before saving sensitive content.' : 'Rebel will save automatically.'}`,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to set space safety level');
        writeJson(res, 500, { success: false, error: (error as Error).message });
      }
      return;
    }

    // =========================================================================
    // Transcription Vocabulary Management
    // =========================================================================

    // GET /vocabulary - Get current transcription vocabulary
    if (req.method === 'GET' && req.url === '/vocabulary') {
      const settings = getSettings();
      const vocabulary = settings.voice?.transcriptionVocabulary ?? [];
      writeJson(res, 200, { success: true, vocabulary });
      return;
    }

    // POST /vocabulary/update - Add, remove, or replace vocabulary terms
    if (req.method === 'POST' && req.url === '/vocabulary/update') {
      const payload = await parseJsonBody<VocabularyUpdatePayload>(req);
      const { action, terms } = payload || {};

      // Validate action
      if (!action || !['add', 'remove', 'replace'].includes(action)) {
        writeJson(res, 400, {
          success: false,
          error: 'action is required and must be "add", "remove", or "replace".'
        });
        return;
      }

      // Validate terms
      if (!Array.isArray(terms)) {
        writeJson(res, 400, { success: false, error: 'terms must be an array of strings.' });
        return;
      }

      // Guardrails
      const MAX_TERMS = 200;
      const MAX_TERM_LENGTH = 100;

      // Validate and sanitize terms
      const sanitizedTerms: string[] = [];
      for (const term of terms) {
        if (typeof term !== 'string') {
          writeJson(res, 400, { success: false, error: 'All terms must be strings.' });
          return;
        }
        const trimmed = term.trim();
        if (trimmed.length === 0) continue; // Skip empty strings
        if (trimmed.length > MAX_TERM_LENGTH) {
          writeJson(res, 400, {
            success: false,
            error: `Term "${trimmed.slice(0, 20)}..." exceeds maximum length of ${MAX_TERM_LENGTH} characters.`
          });
          return;
        }
        sanitizedTerms.push(trimmed);
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();
        const currentVocab = currentSettings.voice?.transcriptionVocabulary ?? [];

        let newVocab: string[];
        let added: string[] = [];
        let removed: string[] = [];

        switch (action) {
          case 'add': {
            // Merge and dedupe
            const vocabSet = new Set(currentVocab);
            for (const term of sanitizedTerms) {
              if (!vocabSet.has(term)) {
                added.push(term);
                vocabSet.add(term);
              }
            }
            newVocab = Array.from(vocabSet);
            break;
          }
          case 'remove': {
            const toRemove = new Set(sanitizedTerms);
            newVocab = currentVocab.filter(t => {
              if (toRemove.has(t)) {
                removed.push(t);
                return false;
              }
              return true;
            });
            break;
          }
          case 'replace': {
            // Full replacement with deduplication
            newVocab = [...new Set(sanitizedTerms)];
            // Calculate diff
            const oldSet = new Set(currentVocab);
            const newSet = new Set(newVocab);
            added = newVocab.filter(t => !oldSet.has(t));
            removed = currentVocab.filter(t => !newSet.has(t));
            break;
          }
          default:
            writeJson(res, 400, { success: false, error: 'Invalid action.' });
            return;
        }

        // Check total terms limit
        if (newVocab.length > MAX_TERMS) {
          writeJson(res, 400, {
            success: false,
            error: `Vocabulary would exceed maximum of ${MAX_TERMS} terms (current: ${currentVocab.length}, adding: ${added.length}).`
          });
          return;
        }

        // Update settings
        updateSettings({
          voice: {
            ...currentSettings.voice,
            transcriptionVocabulary: newVocab
          }
        });

        log.info(
          { action, added: added.length, removed: removed.length, total: newVocab.length },
          'Transcription vocabulary updated via bridge'
        );

        writeJson(res, 200, {
          success: true,
          before: currentVocab,
          after: newVocab,
          added,
          removed
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to update vocabulary');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to update vocabulary.' });
      }
      return;
    }

    // =========================================================================
    // Use Case Library Management
    // =========================================================================

    // POST /usecases/list - List use cases (without embeddings for token efficiency)
    if (req.method === 'POST' && req.url === '/usecases/list') {
      const payload = await parseJsonBody(req);
      const limit = typeof payload?.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(payload.limit))) : 10;

      try {
        const allUseCases = getAllUseCases();
        const total = allUseCases.length;

        // Omit embedding field (large arrays, not useful for agent)
        const useCases = allUseCases.slice(0, limit).map((uc: UseCaseRecord) => ({
          id: uc.id,
          title: uc.title,
          description: uc.description,
          prompt: uc.prompt,
          icon: uc.icon,
          qualityRating: uc.qualityRating,
          generatedAt: uc.generatedAt,
          isNew: uc.isNew,
          newUntil: uc.newUntil,
          usageCount: uc.usageCount,
          lastUsedAt: uc.lastUsedAt,
          firstUsedAt: uc.firstUsedAt
        }));

        writeJson(res, 200, { success: true, useCases, total });
      } catch (error) {
        log.error({ err: error }, 'Failed to list use cases');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to list use cases.' });
      }
      return;
    }

    // POST /usecases/add - Add use cases to the library (with semantic deduplication)
    if (req.method === 'POST' && req.url === '/usecases/add') {
      const payload = await parseJsonBody(req);
      const candidates = payload?.useCases;

      if (!Array.isArray(candidates) || candidates.length === 0) {
        writeJson(res, 400, { success: false, error: 'useCases array is required and must not be empty.' });
        return;
      }

      // Validate each candidate
      const validationErrors: { index: number; error: string }[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c || typeof c !== 'object') {
          validationErrors.push({ index: i, error: 'Must be an object.' });
          continue;
        }
        if (typeof c.title !== 'string' || c.title.trim().length === 0) {
          validationErrors.push({ index: i, error: 'title is required and must be non-empty.' });
          continue;
        }
        if (c.title.length > 100) {
          validationErrors.push({ index: i, error: 'title must be 100 characters or less.' });
          continue;
        }
        if (typeof c.description !== 'string' || c.description.trim().length === 0) {
          validationErrors.push({ index: i, error: 'description is required and must be non-empty.' });
          continue;
        }
        if (typeof c.prompt !== 'string' || c.prompt.trim().length === 0) {
          validationErrors.push({ index: i, error: 'prompt is required and must be non-empty.' });
          continue;
        }
      }

      if (validationErrors.length > 0) {
        writeJson(res, 400, {
          success: false,
          error: 'Validation failed for one or more candidates.',
          validationErrors
        });
        return;
      }

      try {
        const results: UseCaseAddResponse[] = [];

        for (const candidate of candidates) {
          const useCaseCandidate = {
            title: candidate.title.trim(),
            description: candidate.description.trim(),
            prompt: candidate.prompt.trim(),
            icon: typeof candidate.icon === 'string' && candidate.icon.trim().length > 0 ? candidate.icon.trim() : '✨',
            qualityRating: typeof candidate.qualityRating === 'number' && Number.isFinite(candidate.qualityRating)
              ? Math.min(100, Math.max(0, candidate.qualityRating))
              : 90
          };

          // foreground_tool — this handler runs in-turn (the agent is awaiting
          // the tool result), so the embedding must skip the background-embedder
          // gate, which otherwise self-deadlocks on the calling turn's own active
          // state (FOX-3331 / Sentry REBEL-5MG).
          const result: AddUseCaseResult = await addUseCase(useCaseCandidate, {
            callerIntent: 'foreground_tool',
          });
          
          // Map the result to a more descriptive format
          let reason: string;
          switch (result.reason) {
            case 'added':
              reason = 'Successfully added to library.';
              break;
            case 'replaced':
              reason = `Added, replacing lower-value use case (${result.replacedId}).`;
              break;
            case 'too_similar':
              reason = 'Not added: too similar to an existing use case.';
              break;
            case 'below_quality':
              reason = 'Not added: quality rating below threshold.';
              break;
            case 'embedding_failed':
              reason = 'Not added: failed to generate embedding.';
              break;
            default:
              reason = result.reason;
          }

          results.push({
            added: result.added,
            reason,
            title: useCaseCandidate.title, // Include title for agent output formatting
            ...(result.replacedId && { replacedId: result.replacedId })
          });
        }

        const addedCount = results.filter(r => r.added).length;
        log.info({ submitted: candidates.length, added: addedCount }, 'Use cases add request processed');

        writeJson(res, 200, { success: true, results });
      } catch (error) {
        log.error({ err: error }, 'Failed to add use cases');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to add use cases.' });
      }
      return;
    }

    // POST /user/identity - Set user's first name and email (for onboarding discovery)
    if (req.method === 'POST' && req.url === '/user/identity') {
      const payload = await parseJsonBody(req);
      const firstName = payload?.firstName;
      const email = payload?.email;

      // At least one field must be provided
      if (!firstName && !email) {
        writeJson(res, 400, { success: false, error: 'At least one of firstName or email is required.' });
        return;
      }

      // Validate firstName if provided
      if (firstName !== undefined && firstName !== null) {
        if (typeof firstName !== 'string') {
          writeJson(res, 400, { success: false, error: 'firstName must be a string.' });
          return;
        }
        const trimmedName = firstName.trim();
        if (trimmedName.length < 2 || trimmedName.length > 30) {
          writeJson(res, 400, { success: false, error: 'firstName must be 2-30 characters.' });
          return;
        }
        if (!/^[A-Za-z]/.test(trimmedName)) {
          writeJson(res, 400, { success: false, error: 'firstName must start with a letter.' });
          return;
        }
        // Reject placeholder values
        const invalidNames = ['null', 'undefined', 'unknown', 'user', 'name', 'n/a', 'none'];
        if (invalidNames.includes(trimmedName.toLowerCase())) {
          writeJson(res, 400, { success: false, error: 'firstName appears to be a placeholder value.' });
          return;
        }
      }

      // Validate email if provided
      if (email !== undefined && email !== null) {
        if (typeof email !== 'string') {
          writeJson(res, 400, { success: false, error: 'email must be a string.' });
          return;
        }
        const trimmedEmail = email.trim().toLowerCase();
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(trimmedEmail)) {
          writeJson(res, 400, { success: false, error: 'email is not a valid email address.' });
          return;
        }
      }

      try {
        const { updateSettings } = await import('@main/settingsStore');
        const currentSettings = getSettings();
        const updates: Record<string, string> = {};

        // Only update if not already set (don't overwrite existing values)
        if (firstName && !currentSettings.userFirstName) {
          updates.userFirstName = firstName.trim();
        }
        if (email && !currentSettings.userEmail) {
          updates.userEmail = email.trim().toLowerCase();
        }

        if (Object.keys(updates).length > 0) {
          updateSettings(updates);
          log.info({ fieldsUpdated: Object.keys(updates) }, 'User identity updated via MCP tool');
        } else {
          log.debug('User identity already set, skipping update');
        }

        writeJson(res, 200, {
          success: true,
          updated: Object.keys(updates),
          skipped: Object.keys(updates).length === 0 ? ['Already set'] : []
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to set user identity');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to set user identity.' });
      }
      return;
    }

    // =========================================================================
    // Safety Prompt Management (MCP tools: rebel_safety_prompt_get/update)
    // =========================================================================

    // POST /safety-prompt/get - Read safety prompt + recent activity
    if (req.method === 'POST' && req.url === '/safety-prompt/get') {
      try {
        const meta = getSafetyPromptWithMeta();
        const recentActivity = getActivityLog().slice(0, 10);
        writeJson(res, 200, {
          success: true,
          prompt: meta.prompt,
          version: meta.version,
          lastUpdatedAt: meta.lastUpdatedAt,
          lastUpdatedBy: meta.lastUpdatedBy,
          recentActivity,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to get safety prompt');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to get safety prompt.' });
      }
      return;
    }

    // POST /safety-prompt/update - Write updated safety prompt
    if (req.method === 'POST' && req.url === '/safety-prompt/update') {
      const payload = await parseJsonBody(req);
      const prompt = payload?.prompt;

      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'prompt (non-empty string) is required.' });
        return;
      }

      // Security: max length guard (50KB)
      if (prompt.length > 50_000) {
        writeJson(res, 400, { success: false, error: 'prompt exceeds maximum length (50,000 characters).' });
        return;
      }

      try {
        const oldVersion = getSafetyPromptVersion();
        updateSafetyPrompt(prompt, 'user');
        clearSafetyPromptCache();

        const newVersion = getSafetyPromptVersion();
        addVersionChangeEntry(oldVersion, newVersion);
        getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });

        // F-R3-4: Cross-surface invalidation — bridge path was uncovered.
        broadcastSafetyPromptUpdated();

        // Fire async consolidation (non-blocking, same pattern as IPC handler)
        const updatedPrompt = getSafetyPrompt();
        const versionAtFireTime = getSafetyPromptVersion();
        consolidateSafetyPrompt(updatedPrompt)
          .then((consolidated) => {
            if (consolidated && consolidated !== updatedPrompt) {
              if (getSafetyPromptVersion() !== versionAtFireTime) {
                log.debug('Skipping consolidation — prompt was modified during consolidation');
                return;
              }
              updateSafetyPrompt(consolidated, 'system');
              clearSafetyPromptCache();
              log.info('Safety Prompt consolidated successfully (via MCP bridge)');
              // F-R3-4: Broadcast after consolidation write via bridge path.
              broadcastSafetyPromptUpdated();
            }
          })
          .catch((err) => {
            log.debug({ err }, 'Safety Prompt consolidation failed (non-critical, via MCP bridge)');
          });

        const meta = getSafetyPromptWithMeta();
        writeJson(res, 200, {
          success: true,
          version: meta.version,
          lastUpdatedAt: meta.lastUpdatedAt,
        });
      } catch (error) {
        log.error({ err: error }, 'Failed to update safety prompt');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to update safety prompt.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/plugins/create') {
      const payload = await parseJsonBody<PluginCreatePayload>(req);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        writeJson(res, 400, { success: false, error: 'Request body must be an object.' });
        return;
      }

      const pluginService = getBuiltinPluginService();
      if (!pluginService) {
        writeJson(res, 500, { success: false, error: 'Plugin service is unavailable.' });
        return;
      }

      const idRaw = payload.id;
      const nameRaw = payload.name;
      const sourceRaw = payload.source;
      const descriptionRaw = payload.description;
      const documentationRaw = payload.documentation;
      const versionRaw = payload.version;
      const permissionsRaw = payload.permissions;
      const externalDomainsRaw = payload.externalDomains;
      const roleRaw = payload.role;

      if (typeof idRaw !== 'string' || idRaw.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }
      if (typeof nameRaw !== 'string' || nameRaw.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'name is required.' });
        return;
      }
      if (typeof sourceRaw !== 'string' || sourceRaw.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'source is required.' });
        return;
      }
      if (descriptionRaw != null && typeof descriptionRaw !== 'string') {
        writeJson(res, 400, { success: false, error: 'description must be a string when provided.' });
        return;
      }
      if (documentationRaw != null && typeof documentationRaw !== 'string') {
        writeJson(res, 400, { success: false, error: 'documentation must be a string when provided.' });
        return;
      }
      if (versionRaw != null && typeof versionRaw !== 'string') {
        writeJson(res, 400, { success: false, error: 'version must be a string when provided.' });
        return;
      }
      if (permissionsRaw !== undefined) {
        if (!Array.isArray(permissionsRaw) || !permissionsRaw.every((p) => typeof p === 'string')) {
          writeJson(res, 400, { success: false, error: 'permissions must be an array of strings when provided.' });
          return;
        }
      }
      if (externalDomainsRaw !== undefined) {
        if (!Array.isArray(externalDomainsRaw) || !externalDomainsRaw.every((d) => typeof d === 'string')) {
          writeJson(res, 400, { success: false, error: 'externalDomains must be an array of strings when provided.' });
          return;
        }
      }
      if (roleRaw !== undefined) {
        if (roleRaw !== 'hero' && roleRaw !== 'utility') {
          writeJson(res, 400, { success: false, error: 'role must be "hero" or "utility" when provided.' });
          return;
        }
      }

      const id = idRaw.trim();
      const name = nameRaw.trim();
      const source = sourceRaw;
      const description = descriptionRaw?.trim();
      const documentation = documentationRaw;
      const requestedVersion = versionRaw?.trim();
      const hasDocumentation = Boolean(documentation?.trim());
      // Preserve undefined vs [] distinction — Stage 2 uses undefined to mean "preserve existing".
      const permissions = permissionsRaw;
      const externalDomains = externalDomainsRaw;
      const role = roleRaw as 'hero' | 'utility' | undefined;

      if (!PLUGIN_ID_PATTERN.test(id)) {
        writeJson(res, 400, { success: false, error: 'id must be lowercase alphanumeric segments separated by hyphens.' });
        return;
      }

      if (name.length === 0) {
        writeJson(res, 400, { success: false, error: 'name must not be empty.' });
        return;
      }

      try {
        const existing = await pluginService.getSource(id);

        // Source-completeness guard — reject hallucinated placeholders, undefined
        // inline handlers, and suspicious size shrinks before they reach the
        // plugin service. The agent reads the 400 body as a tool error and
        // self-corrects. See docs/plans/260527_plugin_agent_experience_overhaul.md
        // — Stage 2.
        const previousSource = existing.ok ? existing.source : undefined;
        const sourceValidationError = validatePluginSource(source, previousSource);
        if (sourceValidationError) {
          log.warn(
            {
              event: 'PLUGIN_SOURCE_VALIDATION_REJECTED',
              pluginId: id,
              isUpdate: existing.ok,
              sourceLength: source.length,
              previousSourceLength: previousSource?.length,
              reasonSummary: sourceValidationError.slice(0, 200),
            },
            '[AUDIT] /plugins/create source validation rejected before pluginService.createOrUpdate',
          );
          writeJson(res, 400, { success: false, error: sourceValidationError });
          return;
        }

        const isUpdate = existing.ok;

        const version = isUpdate && existing.version
          ? bumpPatchVersion(existing.version)
          : (requestedVersion || '0.1.0');

        const changelogEntry = {
          version,
          date: new Date().toISOString().split('T')[0],
          author: 'Rebel',
          summary: isUpdate
            ? description || `Updated plugin "${name}"`
            : description || `Initial version of "${name}"`,
        };

        const existingChangelog = (isUpdate && existing.changelog) || [];
        const changelog = [changelogEntry, ...existingChangelog];

        const result = await pluginService.createOrUpdate(
          {
            id,
            name,
            ...(description ? { description } : {}),
            ...(hasDocumentation ? { documentation } : {}),
            version,
            changelog,
            // Preserve undefined vs [] distinction so Stage 2 can distinguish
            // "not provided — preserve existing" from "explicitly empty".
            ...(permissions !== undefined && { permissions }),
            ...(externalDomains !== undefined && { externalDomains }),
            // role: 'hero' marks the plugin as the marquee plugin in the Library Plugins lens.
            // Honor system; no enforcement. See 260521 plan v3, Stage A0.
            ...(role !== undefined && { role }),
          },
          source,
        );

        if (!result.ok) {
          const errorMessages = (result.errors ?? []).map(
            (e: { type: string; message: string; line?: number; column?: number }) =>
              e.line != null ? `${e.type} (line ${e.line}): ${e.message}` : `${e.type}: ${e.message}`
          );
          writeJson(res, 400, {
            success: false,
            error: errorMessages.join('; ') || 'Failed to create or update plugin.',
            errors: result.errors,
            ...(result.previousCrashes && result.previousCrashes.length > 0 ? { previousCrashes: result.previousCrashes } : {}),
          });
          return;
        }

        // Stage 3A — an elevated-permission new plugin is persisted but held for
        // user security review (not live yet). Hoist the flag + a plain-language
        // message to the top level so the agent surfaces it and does NOT call
        // rebel_plugins_open until the user enables it from Settings → Plugins.
        if (result.pendingSecurityReview) {
          writeJson(res, 200, {
            success: true,
            pendingSecurityReview: true,
            message:
              `Plugin "${name}" was created but is awaiting the user's approval because it requests elevated permissions. ` +
              `It is not active yet. Tell the user it is ready to enable from Settings → Plugins, and do NOT call rebel_plugins_open until they approve it.`,
            result,
          });
          return;
        }

        writeJson(res, 200, { success: true, result });
      } catch (error) {
        log.error({ err: error, id }, 'Failed to create plugin via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to create plugin.' });
      }
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/plugins/list')) {
      const parsedUrl = new URL(req.url, 'http://localhost');
      if (parsedUrl.pathname !== '/plugins/list') {
        writeJson(res, 404, { success: false, error: 'Not Found' });
        return;
      }

      const includeArchived = parsedUrl.searchParams.get('includeArchived') === 'true';

      const pluginService = getBuiltinPluginService();
      if (!pluginService) {
        writeJson(res, 500, { success: false, error: 'Plugin service is unavailable.' });
        return;
      }

      try {
        const plugins = await pluginService.list();

        if (includeArchived) {
          // Also include archived plugins from space scan
          const { plugins: archivedPlugins } = await scanSpacePlugins({ includeArchived: true });
          const activeIds = new Set(plugins.map((p: { id: string }) => p.id));
          const archivedOnly = archivedPlugins
            .filter((sp) => !activeIds.has(sp.pluginId) && sp.manifest.archivedAt)
            .map((sp) => ({
              id: sp.pluginId,
              name: sp.manifest.name,
              description: sp.manifest.description,
              version: sp.manifest.version ?? '0.1.0',
              icon: sp.manifest.icon,
              entryPoint: sp.manifest.entryPoint,
              maturity: sp.manifest.maturity,
              archivedAt: sp.manifest.archivedAt,
              spaceName: sp.spaceName,
              spacePath: sp.spacePath,
            }));
          writeJson(res, 200, { success: true, plugins: [...plugins, ...archivedOnly] });
        } else {
          writeJson(res, 200, { success: true, plugins });
        }
      } catch (error) {
        log.error({ err: error }, 'Failed to list plugins via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to list plugins.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/plugins/get-source') {
      const payload = await parseJsonBody<PluginIdPayload>(req);
      const id = payload?.id;

      if (typeof id !== 'string' || id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }

      const pluginService = getBuiltinPluginService();
      if (!pluginService) {
        writeJson(res, 500, { success: false, error: 'Plugin service is unavailable.' });
        return;
      }

      try {
        const result = await pluginService.getSource(id.trim());
        if (!result.ok) {
          writeJson(res, 404, { success: false, error: result.error });
          return;
        }

        writeJson(res, 200, {
          success: true,
          id: result.manifest.id,
          name: result.manifest.name,
          ...(result.manifest.description ? { description: result.manifest.description } : {}),
          ...(result.documentation ? { documentation: result.documentation } : {}),
          source: result.source,
        });
      } catch (error) {
        log.error({ err: error, id }, 'Failed to get plugin source via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to get plugin source.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/plugins/delete') {
      const payload = await parseJsonBody<PluginIdPayload>(req);
      const id = payload?.id;

      if (typeof id !== 'string' || id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }

      const pluginService = getBuiltinPluginService();
      if (!pluginService) {
        writeJson(res, 500, { success: false, error: 'Plugin service is unavailable.' });
        return;
      }

      try {
        const result = await pluginService.delete(id.trim());
        if (!result.ok) {
          writeJson(res, 400, { success: false, error: result.error });
          return;
        }
        writeJson(res, 200, { success: true });
      } catch (error) {
        log.error({ err: error, id }, 'Failed to delete plugin via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to delete plugin.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/plugins/open') {
      const payload = await parseJsonBody<PluginOpenPayload>(req);
      const id = payload?.id;

      if (typeof id !== 'string' || id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }

      // Validate optional params: must be a flat string→string object, max 10 keys, max 2KB
      let validatedParams: Record<string, string> | undefined;
      const rawParams = payload?.params;
      if (rawParams !== undefined && rawParams !== null) {
        if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
          writeJson(res, 400, { success: false, error: 'params must be an object (not array or null).' });
          return;
        }
        const entries = Object.entries(rawParams as Record<string, unknown>);
        if (entries.length > 10) {
          writeJson(res, 400, { success: false, error: 'params must have at most 10 keys.' });
          return;
        }
        for (const [k, v] of entries) {
          if (typeof k !== 'string' || typeof v !== 'string') {
            writeJson(res, 400, { success: false, error: 'All param keys and values must be strings.' });
            return;
          }
        }
        const serialized = JSON.stringify(rawParams);
        if (serialized.length > 2048) {
          writeJson(res, 400, { success: false, error: 'params exceeds 2KB size limit.' });
          return;
        }
        validatedParams = rawParams as Record<string, string>;
      }

      const pluginService = getBuiltinPluginService();
      if (!pluginService) {
        writeJson(res, 500, { success: false, error: 'Plugin service is unavailable.' });
        return;
      }

      try {
        const result = await pluginService.open(id.trim(), validatedParams);
        if (!result.ok) {
          writeJson(res, 400, { success: false, error: result.error });
          return;
        }
        writeJson(res, 200, { success: true });
      } catch (error) {
        log.error({ err: error, id }, 'Failed to open plugin via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to open plugin.' });
      }
      return;
    }

    // ── Plugin lifecycle endpoints (fork, archive, restore, copy, move) ─────

    if (req.method === 'POST' && req.url === '/plugins/fork') {
      const payload = await parseJsonBody<PluginForkPayload>(req);
      const id = payload?.id;
      if (typeof id !== 'string' || id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }

      const { plugins } = await scanSpacePlugins();
      const found = plugins.find(p => p.pluginId === id);
      if (!found || !found.spacePath) {
        writeJson(res, 404, { success: false, error: `Plugin "${id}" not found.` });
        return;
      }

      const targetId = typeof payload.targetId === 'string' ? payload.targetId.trim() : undefined;
      if (targetId && !PLUGIN_ID_PATTERN.test(targetId)) {
        writeJson(res, 400, { success: false, error: 'targetId must be lowercase alphanumeric segments separated by hyphens.' });
        return;
      }
      let targetSpacePath: string | undefined;
      if (typeof payload.targetSpace === 'string' && payload.targetSpace.trim().length > 0) {
        const settings = getSettings();
        const workspacePath = settings.coreDirectory;
        if (!workspacePath) {
          writeJson(res, 400, { success: false, error: 'No workspace configured.' });
          return;
        }
        try {
          targetSpacePath = validateSpacePath(workspacePath, payload.targetSpace.trim());
        } catch {
          writeJson(res, 400, { success: false, error: 'targetSpace is outside workspace.' });
          return;
        }
      }

      try {
        const result = await forkPluginInSpace(id, found.spacePath, { targetId, targetSpacePath });
        if (!result.ok) {
          writeJson(res, 400, { success: false, error: result.error });
          return;
        }
        writeJson(res, 200, { success: true, result });
      } catch (error) {
        log.error({ err: error, id }, 'Failed to fork plugin via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to fork plugin.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/plugins/archive') {
      const payload = await parseJsonBody<PluginIdPayload>(req);
      const id = payload?.id;
      if (typeof id !== 'string' || id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }

      const { plugins } = await scanSpacePlugins();
      const found = plugins.find(p => p.pluginId === id);
      if (!found || !found.spacePath) {
        writeJson(res, 404, { success: false, error: `Plugin "${id}" not found.` });
        return;
      }

      try {
        const result = await archivePluginInSpace(id, found.spacePath);
        if (!result.ok) {
          writeJson(res, 400, { success: false, error: result.error });
          return;
        }
        writeJson(res, 200, { success: true });
      } catch (error) {
        log.error({ err: error, id }, 'Failed to archive plugin via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to archive plugin.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/plugins/restore') {
      const payload = await parseJsonBody<PluginIdPayload>(req);
      const id = payload?.id;
      if (typeof id !== 'string' || id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }

      const { plugins } = await scanSpacePlugins({ includeArchived: true });
      const found = plugins.find(p => p.pluginId === id);
      if (!found || !found.spacePath) {
        writeJson(res, 404, { success: false, error: `Plugin "${id}" not found.` });
        return;
      }

      try {
        const result = await restorePluginInSpace(id, found.spacePath);
        if (!result.ok) {
          writeJson(res, 400, { success: false, error: result.error });
          return;
        }
        writeJson(res, 200, { success: true });
      } catch (error) {
        log.error({ err: error, id }, 'Failed to restore plugin via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to restore plugin.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/plugins/copy-to-space') {
      const payload = await parseJsonBody<PluginSpaceTransferPayload>(req);
      const id = payload?.id;
      const sourceSpace = payload?.sourceSpace;
      const targetSpace = payload?.targetSpace;

      if (typeof id !== 'string' || id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }
      if (typeof sourceSpace !== 'string' || sourceSpace.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'sourceSpace is required.' });
        return;
      }
      if (typeof targetSpace !== 'string' || targetSpace.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'targetSpace is required.' });
        return;
      }

      const settings = getSettings();
      const workspacePath = settings.coreDirectory;
      if (!workspacePath) {
        writeJson(res, 400, { success: false, error: 'No workspace configured.' });
        return;
      }

      let resolvedSource: string;
      let resolvedTarget: string;
      try {
        resolvedSource = validateSpacePath(workspacePath, sourceSpace.trim());
        resolvedTarget = validateSpacePath(workspacePath, targetSpace.trim());
      } catch {
        writeJson(res, 400, { success: false, error: 'sourceSpace or targetSpace is outside workspace.' });
        return;
      }

      try {
        const result = await copyPluginToSpace(id, resolvedSource, resolvedTarget);
        if (!result.ok) {
          writeJson(res, 400, { success: false, error: result.error });
          return;
        }
        writeJson(res, 200, { success: true, result });
      } catch (error) {
        log.error({ err: error, id, sourceSpace, targetSpace }, 'Failed to copy plugin via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to copy plugin.' });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/plugins/move-to-space') {
      const payload = await parseJsonBody<PluginSpaceTransferPayload>(req);
      const id = payload?.id;
      const sourceSpace = payload?.sourceSpace;
      const targetSpace = payload?.targetSpace;

      if (typeof id !== 'string' || id.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'id is required.' });
        return;
      }
      if (typeof sourceSpace !== 'string' || sourceSpace.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'sourceSpace is required.' });
        return;
      }
      if (typeof targetSpace !== 'string' || targetSpace.trim().length === 0) {
        writeJson(res, 400, { success: false, error: 'targetSpace is required.' });
        return;
      }

      const settings = getSettings();
      const workspacePath = settings.coreDirectory;
      if (!workspacePath) {
        writeJson(res, 400, { success: false, error: 'No workspace configured.' });
        return;
      }

      let resolvedSource: string;
      let resolvedTarget: string;
      try {
        resolvedSource = validateSpacePath(workspacePath, sourceSpace.trim());
        resolvedTarget = validateSpacePath(workspacePath, targetSpace.trim());
      } catch {
        writeJson(res, 400, { success: false, error: 'sourceSpace or targetSpace is outside workspace.' });
        return;
      }

      try {
        const result = await movePluginToSpace(id, resolvedSource, resolvedTarget);
        if (!result.ok) {
          writeJson(res, 400, { success: false, error: result.error });
          return;
        }
        writeJson(res, 200, { success: true, result });
      } catch (error) {
        log.error({ err: error, id, sourceSpace, targetSpace }, 'Failed to move plugin via bridge');
        writeJson(res, 500, { success: false, error: (error as Error).message || 'Failed to move plugin.' });
      }
      return;
    }

    // ── rebel_mcp_report_contribution_state ─────────────────────────
    // Called by the RebelMcpConnectors MCP server when the build/extend
    // skill reports progress at checkpoints.
    if (req.method === 'POST' && req.url === '/contribution/report-state') {
      const payload = await parseJsonBody<{
        sessionId?: string;
        connectorName?: string;
        status?: string;
        localServerPath?: string;
        catalogEntryId?: string;
        prTitle?: string;
        prBody?: string;
      }>(req);

      // Stage 5 observability: redact a filesystem path to its last two
      // segments for structured logs. Full paths stay in in-process logs
      // elsewhere (`createContribution` / `updateContribution`); the success
      // log here is kept lean so aggregation/export is low-risk.
      const redactPath = (p: string | undefined | null): string | null => {
        if (!p) return null;
        const parts = p.split(/[/\\]/).filter(Boolean);
        if (parts.length === 0) return null;
        return parts.slice(-2).join('/');
      };
      const nonCanonicalExpectedPathPrefix = '~/mcp-servers/<api-name>-mcp/';
      const nonCanonicalGuidance =
        'The connector was built outside the canonical ~/mcp-servers/ directory. To submit this connector to the community, move all source files to ~/mcp-servers/<api-name>-mcp/, update the MCP config registration (rebel_mcp_add_server with the new path), then call rebel_mcp_report_contribution_state({status: "ready_to_submit", localServerPath: "~/mcp-servers/<api-name>-mcp/", ...}). See rebel-system/skills/coding/build-custom-mcp-server/SKILL.md for the full build contract.';
      const nonCanonicalShortGuidance =
        'Move the connector into ~/mcp-servers/<api-name>-mcp/, re-register it with rebel_mcp_add_server, then report ready_to_submit again.';
      const buildNonCanonicalPathError = (observedPath: string): string => JSON.stringify({
        reason: 'non-canonical-path',
        observedPath,
        expectedPathPrefix: nonCanonicalExpectedPathPrefix,
        guidance: nonCanonicalGuidance,
      });
      const isAllowedContributionPathClass = (
        pathClass: ReturnType<typeof classifyContributionPath>,
      ): boolean => pathClass === 'canonical' || pathClass === 'connectors-repo';
      const logContributionPathContractViolation = (params: {
        gate: 'bridge-report-state-existing' | 'bridge-report-state-create';
        sessionId: string;
        contributionId: string;
        connectorName?: string;
        path: string | undefined;
        classification: ReturnType<typeof classifyContributionPath>;
      }): void => {
        log.warn(
          {
            reason: 'contribution-path-non-canonical',
            gate: params.gate,
            sessionId: params.sessionId,
            contributionId: params.contributionId,
            connectorName: params.connectorName,
            pathClassRedacted: redactPath(params.path),
            classification: params.classification,
          },
          'Non-canonical contribution path — SKILL.md contract violation',
        );
      };

      if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) {
        writeJson(res, 400, { success: false, error: 'sessionId is required.' });
        return;
      }

      const validStatuses = [
        'draft', 'testing', 'ready_to_submit', 'submitted',
        'ci_pass', 'ci_fail', 'changes_requested', 'approved',
        'rejected', 'published',
      ];

      if (!payload.status || !validStatuses.includes(payload.status)) {
        writeJson(res, 400, {
          success: false,
          error: `status must be one of: ${validStatuses.join(', ')}`,
        });
        return;
      }

      if (typeof payload.localServerPath === 'string' && !payload.localServerPath.trim()) {
        writeJson(res, 400, {
          success: false,
          error: 'localServerPath must be a non-empty string when provided.',
        });
        return;
      }

      try {
        const {
          createContribution,
          getActiveContributionBySession,
          getContributionById,
          getContributionByPath,
          addLinkedSession,
          updateContribution,
        } = await import('@core/services/contributionStore');
        const { canonicalizeConnectorPath } = await import(
          '@core/utils/canonicalConnectorPath'
        );
        const {
          observeContribution,
          buildMissingSeEvidenceTransitionError,
          isMissingSeEvidenceTransitionError,
        } = await import('@core/services/contributionObservationService');

        const localServerPathInput = typeof payload.localServerPath === 'string'
          ? payload.localServerPath.trim()
          : undefined;
        const enforceSoftwareEngineerEvidence = getSettings().enforceSoftwareEngineerEvidence ?? false;

        // Expand tilde: agents pass literal ~/mcp-servers/... but path.resolve does NOT expand ~
        const expandedServerPath = localServerPathInput
          ? (localServerPathInput.startsWith('~/') || localServerPathInput.startsWith('~\\'))
            ? path.join(os.homedir(), localServerPathInput.slice(2))
            : localServerPathInput
          : undefined;

        // Stage 2.D (260426): path-first / session-fallback. Path lookup wins
        // when supplied so cross-session followup reports touch the right
        // record (matrix #3); session fallback covers pathless reports and
        // first-touch flows. When the path-first lookup matches a record
        // from a different session, append the current session via
        // `addLinkedSession` so cross-session linking stays observable.
        const canonicalPathForLookup = expandedServerPath
          ? canonicalizeConnectorPath(expandedServerPath)
          : '';
        let existing = canonicalPathForLookup
          ? getContributionByPath(canonicalPathForLookup)
          : undefined;
        if (!existing) {
          existing = getActiveContributionBySession(payload.sessionId);
        }
        if (existing && !existing.linkedSessionIds.includes(payload.sessionId)) {
          addLinkedSession(existing.id, payload.sessionId);
          // Re-read so downstream side-data writes see the current array.
          existing = getActiveContributionBySession(payload.sessionId)
            ?? existing;
        }

        if (existing) {
          // Stage 4 pragmatic-strict predicate: an agent-tool-call with
          // `status: 'ready_to_submit'` is an INTENT signal (always) AND a
          // fallback-evidence signal (when accompanied by a localServerPath).
          // The promotion service's predicate decides whether the transition
          // fires now or defers until other signals arrive.
          //
          // For non-ready_to_submit status reports (e.g. agent reporting
          // `ci_pass`, `ci_fail`, `submitted`, `published`), the agent owns
          // the transition directly — those aren't promotions to
          // `ready_to_submit` so the predicate doesn't apply. Fall through
          // to direct update.
          const isReadyToSubmitReport =
            payload.status === 'ready_to_submit' && existing.status === 'testing';

          if (isReadyToSubmitReport) {
            // Apply side-data updates first (connectorName, localServerPath,
            // catalogEntryId) so the promotion service sees consistent state.
            const sideDataUpdates: Record<string, unknown> = {};
            if (expandedServerPath && existing.localServerPath !== expandedServerPath) {
              sideDataUpdates.localServerPath = expandedServerPath;
              if (
                isAllowedContributionPathClass(classifyContributionPath(expandedServerPath)) &&
                tryParseNonCanonicalError(existing.lastTransitionError) !== null
              ) {
                sideDataUpdates.lastTransitionError = undefined;
              }
            }
            if (payload.catalogEntryId && existing.catalogEntryId !== payload.catalogEntryId) {
              sideDataUpdates.catalogEntryId = payload.catalogEntryId;
            }
            if (payload.connectorName && existing.connectorName !== payload.connectorName) {
              sideDataUpdates.connectorName = payload.connectorName;
            }
            if (payload.prTitle && existing.prTitle !== payload.prTitle) {
              sideDataUpdates.prTitle = payload.prTitle;
            }
            if (payload.prBody && existing.prBody !== payload.prBody) {
              sideDataUpdates.prBody = payload.prBody;
            }
            if (Object.keys(sideDataUpdates).length > 0) {
              updateContribution(existing.id, sideDataUpdates as Parameters<typeof updateContribution>[1]);
            }

            const pathForCanonicalGate = expandedServerPath ?? existing.localServerPath;
            const pathClass = classifyContributionPath(pathForCanonicalGate);
            if (!isAllowedContributionPathClass(pathClass)) {
              const observedPathForError = typeof pathForCanonicalGate === 'string'
                ? pathForCanonicalGate
                : '';
              const structuredError = buildNonCanonicalPathError(observedPathForError);
              updateContribution(existing.id, { lastTransitionError: structuredError });

              logContributionPathContractViolation({
                gate: 'bridge-report-state-existing',
                sessionId: payload.sessionId,
                contributionId: existing.id,
                connectorName: payload.connectorName ?? existing.connectorName,
                path: typeof pathForCanonicalGate === 'string' ? pathForCanonicalGate : undefined,
                classification: pathClass,
              });

              const nonCanonicalDecision: Decision = buildDeferredDecision({
                build: existing,
                reason: 'non_canonical_path',
                nextAction: 'move_to_canonical_path',
                guidance: nonCanonicalShortGuidance,
              });
              writeJson(res, 202, {
                success: true,
                contributionId: existing.id,
                status: 'testing',
                created: false,
                decision: nonCanonicalDecision,
                // TODO(stage-3): remove legacy promotionDecision/promotionReason/guidance
                // fields once cloud-service is on the new envelope.
                promotionDecision: 'deferred',
                promotionReason: 'non-canonical-path',
                guidance: nonCanonicalShortGuidance,
              });
              return;
            }

            // Stage 3.E (260426): route through `observeContribution`
            // with `kind: 'ready_requested'`. The reducer's predicate
            // (`lastReadyRequestedAt + (lastTestPassedAt ||
            // lastRegisteredAt) + fingerprintMatches`) decides promotion;
            // deferred outcomes carry `reason: 'missing_evidence'` or
            // `reason: 'fingerprint_unavailable'`.
            const result = await observeContribution({
              kind: 'ready_requested',
              sessionId: payload.sessionId,
              localServerPath: expandedServerPath ?? existing.localServerPath ?? '',
              connectorName: payload.connectorName ?? existing.connectorName,
              source: 'bridge-report-state',
            }, {
              enforceSoftwareEngineerEvidence,
            });

            // Re-read to produce the response — the observation might have
            // caused an immediate promotion, or might be deferred. Either
            // way the caller sees the current record state.
            const current = getContributionById(existing.id);
            if (current) {
              log.info(
                {
                  endpoint: '/contribution/report-state',
                  sessionId: payload.sessionId,
                  contributionId: current.id,
                  connectorName: payload.connectorName ?? current.connectorName,
                  reportedStatus: payload.status,
                  existingStatus: existing.status,
                  resultStatus: current.status,
                  created: false,
                  localServerPathRedacted: redactPath(expandedServerPath ?? current.localServerPath ?? null),
                  observationDecision: result.decision,
                  observationReason: result.reason,
                  fingerprintMismatch: result.fingerprintMismatch,
                },
                'contribution/report-state success',
              );
              // Stage 1.A: emit typed Decision envelope. Discriminate on
              // the observation's `ObservationResult.decision` field.
              let decision: Decision;
              if (current.status !== existing.status) {
                decision = buildSuccessDecision('updated', current);
              } else if (result.decision === 'deferred') {
                if (result.reason === 'fingerprint_unavailable') {
                  decision = buildDeferredDecision({
                    build: current,
                    reason: 'fingerprint_unavailable',
                    nextAction: 'run_build',
                    guidance: GUIDANCE_PRESETS.fingerprintUnavailable,
                  });
                } else if (result.reason === 'missing_se_evidence') {
                  const recovery = deriveSoftwareEngineerRecoveryGuidance({
                    invalidationReason: current.lastSoftwareEngineerEvidenceInvalidatedReason,
                  });
                  if (!isMissingSeEvidenceTransitionError(current.lastTransitionError)) {
                    updateContribution(current.id, {
                      lastTransitionError: buildMissingSeEvidenceTransitionError({
                        chatSafeGuidance: recovery.chatSafe,
                      }),
                    });
                  }
                  decision = buildDeferredDecision({
                    build: current,
                    reason: 'missing_evidence',
                    nextAction: 'run_software_engineer_workflow',
                    guidance: recovery.internal,
                    chatSafeGuidance: recovery.chatSafe,
                  });
                } else {
                  decision = buildDeferredDecision({
                    build: current,
                    reason: 'missing_evidence',
                    nextAction: 'run_tests',
                    guidance: GUIDANCE_PRESETS.missingEvidence,
                  });
                }
              } else if (result.decision === 'rejected') {
                decision = buildRejectedDecision({
                  build: current,
                  reason: 'invalid_transition',
                  nextAction: 'wait_for_review',
                  guidance:
                    current.lastTransitionError
                    ?? `Contribution observation was rejected (${result.reason}).`,
                });
              } else {
                // `decision: 'updated'` with no status change means the
                // reducer wrote readiness fields but predicate not yet
                // satisfied (or ready_requested with promote met but the
                // record was already at ready_to_submit so updateContribution
                // returned the record unchanged). Treat as noop.
                log.info(
                  {
                    endpoint: '/contribution/report-state',
                    sessionId: payload.sessionId,
                    contributionId: existing.id,
                    resultDecision: result.decision,
                    resultReason: result.reason,
                  },
                  'observeContribution returned without status change; envelope = noop',
                );
                decision = buildSuccessDecision('noop', current);
              }
              writeJson(res, 200, {
                success: true,
                contributionId: current.id,
                status: current.status,
                created: false,
                decision,
                // TODO(stage-3): remove legacy promotionDecision/promotionReason
                // fields once cloud-service is on the new envelope.
                promotionDecision: result.decision,
                promotionReason: result.reason,
              });
            } else {
              writeJson(res, 500, {
                success: false,
                error: 'Contribution disappeared after observation attempt.',
              });
            }
            return;
          }

          // Non-ready_to_submit report: direct update path (agent-owned
          // transitions like ci_pass, ci_fail, submitted, published).
          const updates: Record<string, unknown> = { status: payload.status };
          if (expandedServerPath && existing.localServerPath !== expandedServerPath) {
            updates.localServerPath = expandedServerPath;
            if (
              isAllowedContributionPathClass(classifyContributionPath(expandedServerPath)) &&
              tryParseNonCanonicalError(existing.lastTransitionError) !== null
            ) {
              updates.lastTransitionError = undefined;
            }
          }
          if (payload.catalogEntryId) updates.catalogEntryId = payload.catalogEntryId;
          if (payload.connectorName) updates.connectorName = payload.connectorName;
          if (payload.prTitle) updates.prTitle = payload.prTitle;
          if (payload.prBody) updates.prBody = payload.prBody;

          const updated = updateContribution(existing.id, updates as Parameters<typeof updateContribution>[1]);
          if (updated === null) {
            // Stage 3: surface the structured transition error so the agent can
            // self-correct on the next turn. `lastTransitionError` on the record
            // was populated by the store's rejection path; re-read to include
            // the "current status + valid next states" message verbatim.
            // Stage 2.D (260426): re-read by id so we get the EXACT record
            // whose transition was rejected.
            const { getContributionById } = await import('@core/services/contributionStore');
            const rejected = getContributionById(existing.id);
            const transitionGuidance =
              rejected?.lastTransitionError
              ?? `Invalid state transition from '${existing.status}' to '${payload.status}'.`;
            // Stage 1.A: invalid-transition rejection moved from HTTP 400 → 200
            // with `decision.kind: 'rejected'` so the wrapper sees the Decision.
            // The wrapper currently throws on every non-2xx response — without
            // this change the agent loses structured visibility into the
            // rejection.
            const rejectedDecision: Decision = buildRejectedDecision({
              build: rejected ?? existing,
              reason: 'invalid_transition',
              nextAction: 'wait_for_review',
              guidance: transitionGuidance,
            });
            writeJson(res, 200, {
              success: false,
              decision: rejectedDecision,
              contributionId: existing.id,
              status: existing.status,
              created: false,
              // TODO(stage-3): remove legacy error/currentStatus/attemptedStatus
              // fields once cloud-service is on the new envelope.
              error: transitionGuidance,
              currentStatus: existing.status,
              attemptedStatus: payload.status,
              // TODO(stage-3): remove legacy promotionDecision/promotionReason/
              // guidance fields once cloud-service is on the new envelope. Per
              // Stage 1 plan Decision 4, every deferred/rejected response
              // mirrors decision.* into the legacy field set for the
              // one-release transition window.
              promotionDecision: 'rejected',
              promotionReason: 'invalid-transition',
              guidance: transitionGuidance,
            });
            return;
          }
          if (updated === undefined) {
            writeJson(res, 404, { success: false, error: 'Contribution not found.' });
            return;
          }

          log.info(
            {
              endpoint: '/contribution/report-state',
              sessionId: payload.sessionId,
              contributionId: updated.id,
              connectorName: payload.connectorName ?? updated.connectorName,
              reportedStatus: payload.status,
              existingStatus: existing.status,
              resultStatus: updated.status,
              created: false,
              localServerPathRedacted: redactPath(expandedServerPath ?? updated.localServerPath ?? null),
              promotionDecision: null,
              promotionReason: null,
            },
            'contribution/report-state success',
          );
          // Stage 1.A: same-status updates (no-op short-circuit in the store)
          // surface as `kind: 'noop'`; genuine transitions surface as
          // `kind: 'updated'`.
          const directUpdateDecision: Decision =
            updated.status === existing.status
              ? buildSuccessDecision('noop', updated)
              : buildSuccessDecision('updated', updated);
          writeJson(res, 200, {
            success: true,
            contributionId: updated.id,
            status: updated.status,
            created: false,
            decision: directUpdateDecision,
          });
        } else {
          // Create new contribution
          if (!payload.connectorName || !payload.connectorName.trim()) {
            writeJson(res, 400, {
              success: false,
              error: 'connectorName is required when creating a new contribution.',
            });
            return;
          }

          // Stage 3.E (260426): a direct-create at `ready_to_submit`
          // (no prior `testing` record) is structurally indistinguishable
          // from `lastReadyRequestedAt` set without prior evidence — the
          // reducer defers via `missing_evidence`. We create the record
          // at `draft` (matrix #22 realignment), then fire a
          // `ready_requested` observation. The reducer's predicate
          // accumulates the readiness assertion durably so a later
          // test-pass / add-server observation promotes via the same
          // predicate path. On non-canonical path the legacy
          // `lastTransitionError` gate still applies (the canonical-path
          // gate is enforced before observation, not by the reducer).
          const isReadyToSubmitCreate = payload.status === 'ready_to_submit';

          if (isReadyToSubmitCreate) {
            const pathClass = classifyContributionPath(expandedServerPath);
            const pathContractViolation = !isAllowedContributionPathClass(pathClass);
            const observedPathForError = typeof expandedServerPath === 'string'
              ? expandedServerPath
              : '';
            // Always defer to draft on direct-create at ready_to_submit
            // (Stage 3 plan § 3.E Decision 2): the reducer enforces
            // evidence; the bridge enforces canonical path.
            {
              const structuredError = pathContractViolation
                ? buildNonCanonicalPathError(observedPathForError)
                : JSON.stringify({
                    reason: 'evidence-insufficient',
                    requestedStatus: 'ready_to_submit',
                  });

              const deferred = createContribution({
                sessionId: payload.sessionId.trim(),
                connectorName: payload.connectorName.trim(),
                status: 'draft',
                attributionMode: 'anonymous',
                ...(expandedServerPath ? { localServerPath: expandedServerPath } : {}),
                ...(payload.catalogEntryId ? { catalogEntryId: payload.catalogEntryId } : {}),
                ...(payload.prTitle ? { prTitle: payload.prTitle } : {}),
                ...(payload.prBody ? { prBody: payload.prBody } : {}),
              });

              // `createContribution` input type does NOT include
              // `lastTransitionError`, so populate it via a follow-up
              // `updateContribution` call.
              updateContribution(deferred.id, {
                lastTransitionError: structuredError,
              });

              if (!pathContractViolation && expandedServerPath) {
                // Stage 3.E: back-channel the readiness assertion via the
                // observation pipeline. The reducer stamps
                // `lastReadyRequestedAt` durably; future test-pass /
                // add-server observations satisfy the predicate.
                const observationResult = await observeContribution({
                  kind: 'ready_requested',
                  sessionId: payload.sessionId,
                  localServerPath: expandedServerPath,
                  connectorName: payload.connectorName,
                  source: 'bridge-report-state',
                }, {
                  enforceSoftwareEngineerEvidence,
                });

                if (observationResult.decision === 'deferred') {
                  const refreshed = getContributionById(deferred.id) ?? deferred;
                  const recovery = deriveSoftwareEngineerRecoveryGuidance({
                    invalidationReason: refreshed.lastSoftwareEngineerEvidenceInvalidatedReason,
                  });
                  if (
                    observationResult.reason === 'missing_se_evidence'
                    && !isMissingSeEvidenceTransitionError(refreshed.lastTransitionError)
                  ) {
                    updateContribution(refreshed.id, {
                      lastTransitionError: buildMissingSeEvidenceTransitionError({
                        chatSafeGuidance: recovery.chatSafe,
                      }),
                    });
                  }
                  const directCreateDecision: Decision = observationResult.reason === 'missing_se_evidence'
                    ? buildDeferredDecision({
                        build: refreshed,
                        reason: 'missing_evidence',
                        nextAction: 'run_software_engineer_workflow',
                        guidance: recovery.internal,
                        chatSafeGuidance: recovery.chatSafe,
                      })
                    : buildDeferredDecision({
                        build: refreshed,
                        reason: pathContractViolation ? 'non_canonical_path' : 'missing_evidence',
                        nextAction: pathContractViolation ? 'move_to_canonical_path' : 'run_tests',
                        guidance: pathContractViolation
                          ? nonCanonicalShortGuidance
                          : GUIDANCE_PRESETS.missingEvidence,
                      });
                  const legacyGuidance =
                    'guidance' in directCreateDecision
                      ? directCreateDecision.guidance
                      : undefined;

                  writeJson(res, 202, {
                    success: true,
                    contributionId: refreshed.id,
                    status: refreshed.status,
                    created: true,
                    decision: directCreateDecision,
                    promotionDecision: 'deferred',
                    promotionReason: 'evidence-insufficient',
                    guidance: legacyGuidance,
                  });
                  return;
                }
              }

              if (pathContractViolation) {
                logContributionPathContractViolation({
                  gate: 'bridge-report-state-create',
                  sessionId: payload.sessionId,
                  contributionId: deferred.id,
                  connectorName: payload.connectorName,
                  path: expandedServerPath,
                  classification: pathClass,
                });
              } else {
                log.warn(
                  {
                    sessionId: payload.sessionId,
                    contributionId: deferred.id,
                    connectorName: payload.connectorName,
                  },
                  'contribution/report-state: direct-create ready_to_submit deferred to draft — Stage 3 reducer enforces evidence accumulation',
                );
              }

              const promotionReason = pathContractViolation
                ? 'non-canonical-path'
                : 'evidence-insufficient';

              log.info(
                {
                  endpoint: '/contribution/report-state',
                  sessionId: payload.sessionId,
                  contributionId: deferred.id,
                  connectorName: payload.connectorName,
                  reportedStatus: payload.status,
                  existingStatus: null,
                  resultStatus: deferred.status,
                  created: true,
                  localServerPathRedacted: redactPath(expandedServerPath),
                  promotionDecision: 'deferred',
                  promotionReason,
                },
                'contribution/report-state success',
              );
              const directCreateGuidance = pathContractViolation
                ? nonCanonicalShortGuidance
                : GUIDANCE_PRESETS.missingEvidence;
              const deferredDecision: Decision = buildDeferredDecision({
                build: deferred,
                reason: pathContractViolation ? 'non_canonical_path' : 'missing_evidence',
                nextAction: pathContractViolation ? 'move_to_canonical_path' : 'run_tests',
                guidance: directCreateGuidance,
              });
              writeJson(res, 202, {
                success: true,
                contributionId: deferred.id,
                status: deferred.status,
                created: true,
                decision: deferredDecision,
                // TODO(stage-3): remove legacy promotionDecision/promotionReason/
                // guidance fields once cloud-service is on the new envelope.
                promotionDecision: 'deferred',
                promotionReason,
                guidance: directCreateGuidance,
              });
              return;
            }
          }

          const contribution = createContribution({
            sessionId: payload.sessionId.trim(),
            connectorName: payload.connectorName.trim(),
            status: payload.status as Parameters<typeof createContribution>[0]['status'],
            attributionMode: 'anonymous',
            ...(expandedServerPath ? { localServerPath: expandedServerPath } : {}),
            ...(payload.catalogEntryId ? { catalogEntryId: payload.catalogEntryId } : {}),
            ...(payload.prTitle ? { prTitle: payload.prTitle } : {}),
            ...(payload.prBody ? { prBody: payload.prBody } : {}),
          });

          log.info(
            {
              endpoint: '/contribution/report-state',
              sessionId: payload.sessionId,
              contributionId: contribution.id,
              connectorName: payload.connectorName,
              reportedStatus: payload.status,
              existingStatus: null,
              resultStatus: contribution.status,
              created: true,
              localServerPathRedacted: redactPath(expandedServerPath),
              promotionDecision: null,
              promotionReason: null,
            },
            'contribution/report-state success',
          );
          // Stage 1.A: brand-new record → kind: 'created'.
          const createdDecision: Decision = buildSuccessDecision('created', contribution);
          writeJson(res, 200, {
            success: true,
            contributionId: contribution.id,
            status: contribution.status,
            created: true,
            decision: createdDecision,
          });
        }
      } catch (error) {
        log.error({ err: error }, 'Failed to report contribution state');
        writeJson(res, 500, { success: false, error: 'Failed to update contribution state.' });
      }
      return;
    }

    writeJson(res, 404, { success: false, error: 'Not Found' });
  } catch (error) {
    log.error({ err: error }, 'Bundled inbox bridge handler failed');
    writeJson(res, 500, { success: false, error: 'Internal error' });
  }
};
