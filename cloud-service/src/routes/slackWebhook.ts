import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto, { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cloudStorePathOnlyFactory } from '../services/cloudStorePathFactory';
import { createScopedLogger, type Logger } from '@core/logger';
import {
  buildInboundAuthorPolicyRevision,
  evaluateInboundAuthor,
  type InboundAuthorContext as InboundAuthorGateContext,
  type InboundAuthorPolicy as InboundAuthorGatePolicy,
} from '@core/services/inboundAuthorGates';
import { SLACK_INBOUND_AUTHOR_GATE } from '@core/services/inboundAuthorGates/slackInboundAuthorGate';
import type { InboundAuthorPrincipal } from '@core/services/inboundAuthorGates/types';
import type { ExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import { WebhookAuthError, type HeadersLike, type InboundVerificationDropResult } from '@core/services/externalConversation/externalConversationAdapter';
import type { SlackThreadContext } from '@core/services/externalConversation/externalContext';
import { formatThreadHistoryDigest, SlackThreadHistoryError } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import { normalizeAuthorId } from '@core/services/inboundAuthorPolicy/normalizeAuthorId';
import { extractMentionedUserIds, extractMessageText, type SlackBlock } from '@core/services/externalConversation/slackMentionParser';
import { extractSlackThreadIdentity } from '@core/services/externalConversation/slackThreadIdentity';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import { getErrorReporter } from '@core/errorReporter';
import { mapWithConcurrencyLimit } from '@core/utils/concurrencyLimit';
import { hashTeamId, redactSlackError } from '@shared/utils/teamIdHash';
import type { AppSettings } from '@shared/types';
import {
  InboundAuthorPolicySchemaVersion,
  type InboundAuthorPolicy,
} from '@rebel/shared';
import {
  SLACK_WORKSPACE_CHANGED_CHANNEL,
  SLACK_WORKSPACE_DISCONNECTED_CHANNEL,
  SlackWorkspaceChangedSchema,
  SlackWorkspaceDisconnectedSchema,
} from '@shared/ipc/channels/slack';
import { sendJson, sendRouteError, RouteError, readRawBody } from '../httpUtils';
import { getSettings, updateSettings } from '@core/services/settingsStore/index';
import { getExternalConversationService, slackThreadAdapterInstance } from '../services/externalConversationServiceFactory';
import { registerSlackInboundReplayHandler } from '../services/slackInboundReplayRegistry';
import { createSlackPendingInboundLog, SLACK_PENDING_INBOUND_RAW_BODY_MAX_BYTES, type PendingInboundLog } from '../services/slackPendingInboundLog';
import { createSlackWorkspaceStore, type SlackWorkspaceStore } from '../services/slackWorkspaceStore';
import {
  buildSlackRecentSenderPrincipalKey,
  createSlackRecentSendersStore,
  type SlackRecentSendersStore,
} from '../services/slackRecentSendersStore';
import {
  SlackInboundRateLimiter,
  slackInboundRateLimiter,
} from '../services/slackInboundRateLimiter';
import { slackWebhookIpRateLimiter, slackWebhookTeamRateLimiter, type TeamRateLimiter } from '../services/teamRateLimiter';
import {
  hashPrincipalUserId,
  logInboundAuthorDrop,
  summarizePolicyForLog,
} from '../services/inboundAuthorDropLog';
import {
  SLACK_MESSAGE_METADATA_MAX_BYTES,
  SlackMessageMetadataSchema,
} from '@core/services/externalConversation/slackOutboundMetadata';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';

const log = createScopedLogger({ service: 'slackWebhookRoute' });

const SLACK_MISSING_OWNER_NOTICE_KEY = 'slack-owner-identity-missing';
const UNKNOWN_INBOUND_AUTHOR_ID = 'UNKNOWN';

const SlackEventPayloadSchema = z.object({
  team_id: z.string().optional(),
  event_id: z.string(),
  event: z.object({
    type: z.string(),
    team_id: z.string().optional(),
    channel_type: z.enum(['channel', 'group', 'im', 'mpim']).optional(),
    text: z.string().optional(),
    blocks: z.array(z.unknown()).optional(),
    bot_id: z.string().optional(),
    metadata: SlackMessageMetadataSchema.optional(),
  }).passthrough(),
}).passthrough().refine((payload) => Boolean(payload.team_id || payload.event.team_id), {
  message: 'Slack event payload must include team_id at top level or event.team_id',
});

const SlackUrlVerificationSchema = z.object({
  type: z.literal('url_verification'),
  challenge: z.string(),
});

const IGNORED_SLACK_MESSAGE_SUBTYPES = new Set([
  'message_changed',
  'message_deleted',
  'channel_join',
  'channel_leave',
  'message_replied',
  'bot_message',
  'thread_broadcast',
  'pinned_item',
  'channel_topic',
  'channel_purpose',
  'me_message',
  'tombstone',
]);

type ChannelType = 'channel' | 'group' | 'im' | 'mpim';
type InboundSurfaceChannelType = 'channel' | 'im' | 'mpim';
type SlackUserProfile = { displayName?: string; handle?: string };

interface SlackWebhookRouteDeps {
  pendingLog: PendingInboundLog;
  workspaceStore: SlackWorkspaceStore;
  recentSendersStore: SlackRecentSendersStore;
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  log: Logger;
  broadcast: (channel: string, payload: unknown) => void;
  hasOpenBroadcastClient: () => boolean;
  pendingDeliveries: { cancelByTeamId(teamId: string): void };
  teamRateLimiter: TeamRateLimiter;
  preVerifyIpRateLimiter: TeamRateLimiter;
  inboundRateLimiter: SlackInboundRateLimiter;
}

let testDeps: Partial<SlackWebhookRouteDeps> | null = null;
const loggedDisabledTeams = new Set<string>();
const loggedNotConnectedTeams = new Set<string>();
const loggedTeamMismatchPairs = new Set<string>();
const loggedThreadHistoryUnavailableThreads = new Set<string>();
const inflightWebhookEvents = new Map<string, { promise: Promise<void>; startedAt: number }>();
const INFLIGHT_EVENT_TTL_MS = 60 * 1000;
const REPLAY_CONCURRENCY = 5;
const SLACK_THREAD_HISTORY_TIMEOUT_MS = 5000;
const ACK_ONLY_UNSUPPORTED_ENVELOPE_TYPES = new Set([
  'app_rate_limited',
]);
const EMPTY_THREAD_HISTORY_DIGEST = {
  digest: '',
  filteredCount: 0,
} as const;

const LEGACY_PERMISSIVE_INBOUND_AUTHOR_POLICY: InboundAuthorPolicy = {
  inboundAuthorPolicySchemaVersion: InboundAuthorPolicySchemaVersion,
  policyRevision: 0,
  mode: 'legacyPermissive',
  allowlist: { slack: [] },
  blocklist: { slack: [] },
  surfaceTrusted: { slack: [] },
  agentAllowlist: { slack: [] },
  notices: {
    upgradeReviewPending: false,
  },
};

const storeFactory = cloudStorePathOnlyFactory;

function deps(): SlackWebhookRouteDeps {
  return {
    pendingLog: testDeps?.pendingLog ?? createSlackPendingInboundLog({ storeFactory }),
    workspaceStore: testDeps?.workspaceStore ?? createSlackWorkspaceStore({ storeFactory }),
    recentSendersStore: testDeps?.recentSendersStore ?? createSlackRecentSendersStore({ storeFactory }),
    getSettings: testDeps?.getSettings ?? getSettings,
    updateSettings: testDeps?.updateSettings ?? updateSettings,
    log: testDeps?.log ?? log,
    // dynamic-broadcast-reviewed: default Slack-webhook route broadcast dep — forwards the `channel`
    // the route emits (conversations:*/inbox:* declared at their own emit-sites); no channel of its own.
    broadcast: testDeps?.broadcast ?? ((channel, payload) => cloudEventBroadcaster.broadcast(channel, payload)),
    hasOpenBroadcastClient: testDeps?.hasOpenBroadcastClient ?? (() => cloudEventBroadcaster.hasOpenClient()),
    pendingDeliveries: testDeps?.pendingDeliveries ?? {
      cancelByTeamId(teamId: string) {
        slackThreadAdapterInstance?.cancelByTeamId(teamId);
      },
    },
    teamRateLimiter: testDeps?.teamRateLimiter ?? slackWebhookTeamRateLimiter,
    preVerifyIpRateLimiter: testDeps?.preVerifyIpRateLimiter ?? slackWebhookIpRateLimiter,
    inboundRateLimiter: testDeps?.inboundRateLimiter ?? slackInboundRateLimiter,
  };
}

export function __setSlackWebhookRouteDepsForTesting(overrides: Partial<SlackWebhookRouteDeps> | null): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    testDeps = overrides;
    if (!overrides) {
      loggedDisabledTeams.clear();
      loggedNotConnectedTeams.clear();
      loggedTeamMismatchPairs.clear();
      loggedThreadHistoryUnavailableThreads.clear();
      slackWebhookTeamRateLimiter.reset();
      slackWebhookIpRateLimiter.reset();
    }
  }
}

function headersFromRequest(req: IncomingMessage): HeadersLike {
  return {
    get(name: string) {
      const val = req.headers[name.toLowerCase()];
      return Array.isArray(val) ? val[0] : val;
    },
  };
}

function payloadHash(rawBody: Buffer | string): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function isDropResult(value: SlackThreadContext | InboundVerificationDropResult): value is InboundVerificationDropResult {
  return value.kind !== 'slack-thread';
}

function shouldMarkReplayDropProcessed(args: {
  result: InboundVerificationDropResult;
  eventId: string;
  teamIdHash: string;
  log: Logger;
}): boolean {
  const { result, eventId, teamIdHash, log: replayLog } = args;
  switch (result.kind) {
    case 'self-mention-ignored':
    case 'signature-invalid':
      return true;
    case 'workspace-not-connected':
      return false;
    default:
      replayLog.warn({
        event: 'slack_replay_unexpected_drop_kind',
        kind: (result as { kind?: string }).kind,
        eventId,
        teamIdHash,
      }, 'slack_replay_unexpected_drop_kind');
      return false;
  }
}

function channelTypeFromPayload(payload: z.infer<typeof SlackEventPayloadSchema>): ChannelType {
  return payload.event.channel_type ?? 'channel';
}

function classifyInboundChannelType(payload: z.infer<typeof SlackEventPayloadSchema>): InboundSurfaceChannelType {
  const channelType = channelTypeFromPayload(payload);
  if (channelType === 'im' || channelType === 'mpim') {
    return channelType;
  }
  return 'channel';
}

function nullableTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deriveOwnerFromPolicy(
  _policy: InboundAuthorPolicy,
  slackWorkspace: { authedUserId?: string } | null,
): string | null {
  const authedUserId = nullableTrimmedString(slackWorkspace?.authedUserId);
  if (!authedUserId) return null;
  return normalizeAuthorId('slack', authedUserId);
}

function resolvePolicyForEvaluation(args: {
  policy: InboundAuthorPolicy;
  ownerNormalizedAuthorId: string | null;
}): InboundAuthorGatePolicy {
  if (!args.ownerNormalizedAuthorId) return args.policy;
  return {
    ...args.policy,
    ownerNormalizedAuthorId: args.ownerNormalizedAuthorId,
  };
}

function slackEventRecord(payload: z.infer<typeof SlackEventPayloadSchema>): Record<string, unknown> {
  return payload.event as Record<string, unknown>;
}

function extractSlackBotAppId(payload: z.infer<typeof SlackEventPayloadSchema>): string | null {
  const eventRecord = slackEventRecord(payload);
  const botProfile = eventRecord.bot_profile;
  if (typeof botProfile !== 'object' || botProfile === null) return null;
  return nullableTrimmedString((botProfile as Record<string, unknown>).app_id);
}

function extractSlackUserProfile(payload: z.infer<typeof SlackEventPayloadSchema>): SlackUserProfile {
  const eventRecord = slackEventRecord(payload);
  const userProfile = eventRecord.user_profile;
  if (typeof userProfile !== 'object' || userProfile === null) {
    return {};
  }

  return {
    displayName: nullableTrimmedString((userProfile as Record<string, unknown>).display_name) ?? undefined,
    handle: nullableTrimmedString((userProfile as Record<string, unknown>).name) ?? undefined,
  };
}

function extractMetadataAgentInstanceId(payload: z.infer<typeof SlackEventPayloadSchema>): string | null {
  return nullableTrimmedString(payload.event.metadata?.event_payload?.agentInstanceId);
}

function resolvePrincipalFromEvent(args: {
  payload: z.infer<typeof SlackEventPayloadSchema>;
  fallbackUserId?: string;
}): {
  principal: InboundAuthorPrincipal | null;
  eventBotId: string | null;
  eventUserId: string | null;
  metadataAgentInstanceId: string | null;
} {
  const eventRecord = slackEventRecord(args.payload);
  const eventBotId = nullableTrimmedString(args.payload.event.bot_id);
  const eventUserId = nullableTrimmedString(eventRecord.user);
  const metadataAgentInstanceId = extractMetadataAgentInstanceId(args.payload);

  if (eventBotId) {
    const agentAuthorId = metadataAgentInstanceId
      ?? normalizeAuthorId('slack', extractSlackBotAppId(args.payload) ?? eventBotId);
    return {
      principal: {
        kind: 'agent',
        normalizedAuthorId: agentAuthorId,
      },
      eventBotId,
      eventUserId,
      metadataAgentInstanceId,
    };
  }

  const resolvedUserId = eventUserId ?? nullableTrimmedString(args.fallbackUserId);
  if (resolvedUserId) {
    return {
      principal: {
        kind: 'human',
        normalizedAuthorId: normalizeAuthorId('slack', resolvedUserId),
      },
      eventBotId,
      eventUserId,
      metadataAgentInstanceId,
    };
  }

  return {
    principal: null,
    eventBotId,
    eventUserId,
    metadataAgentInstanceId,
  };
}

function persistMissingOwnerIdentityNotice(args: {
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
}): void {
  const current = args.getSettings();
  const dismissedAnnouncements = current.dismissedAnnouncements ?? {};
  if (dismissedAnnouncements[SLACK_MISSING_OWNER_NOTICE_KEY] === false) {
    return;
  }

  args.updateSettings({
    dismissedAnnouncements: {
      ...dismissedAnnouncements,
      [SLACK_MISSING_OWNER_NOTICE_KEY]: false,
    },
  });
}

function syncInboundAuthorPolicyBypassStatus(args: {
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  logger: Logger;
  eventId: string;
  teamIdHash: string;
}): AppSettings {
  const inboundAuthorPolicyBypassActive = process.env.REBEL_INBOUND_AUTHOR_POLICY_BYPASS === '1';
  const currentBypassFlag = args.settings.experimental?.inboundAuthorPolicyBypassActive;
  if (
    currentBypassFlag === inboundAuthorPolicyBypassActive
    || (currentBypassFlag === undefined && !inboundAuthorPolicyBypassActive)
  ) {
    return args.settings;
  }

  const nextSettings: AppSettings = {
    ...args.settings,
    experimental: {
      ...(args.settings.experimental ?? {}),
      inboundAuthorPolicyBypassActive,
    },
  };

  try {
    args.updateSettings({
      experimental: nextSettings.experimental,
    });
  } catch (error) {
    args.logger.warn({
      event: 'slack_inbound_policy_bypass_status_sync_failed',
      eventId: args.eventId,
      teamIdHash: args.teamIdHash,
      error: redactSlackError(error),
    }, 'slack_inbound_policy_bypass_status_sync_failed');
  }

  return nextSettings;
}

function logInboundAuthorAllow(args: {
  logger: Logger;
  eventId: string;
  teamIdHash: string;
  principal: InboundAuthorPrincipal;
  surfaceId: string;
  gateId: string;
  reason: string;
  policyRevision: string;
}): void {
  args.logger.info({
    event: 'slack_inbound_allowed_author_policy',
    eventId: args.eventId,
    teamIdHash: args.teamIdHash,
    principalUserIdHash: hashPrincipalUserId(args.principal.kind, args.principal.normalizedAuthorId),
    principalKind: args.principal.kind,
    surfaceId: args.surfaceId,
    decision: 'allow',
    gateId: args.gateId,
    reason: args.reason,
    policyRevision: args.policyRevision,
  }, 'slack_inbound_allowed_author_policy');
}

function logInboundOtherRebelDetected(args: {
  logger: Logger;
  eventId: string;
  teamIdHash: string;
  principal: InboundAuthorPrincipal;
  surfaceId: string;
  policyRevision: string;
}): void {
  args.logger.info({
    event: 'slack_inbound_other_rebel_detected',
    eventId: args.eventId,
    teamIdHash: args.teamIdHash,
    principalUserIdHash: hashPrincipalUserId(args.principal.kind, args.principal.normalizedAuthorId),
    principalKind: args.principal.kind,
    surfaceId: args.surfaceId,
    decision: 'allow',
    gateId: 'self_message',
    reason: 'metadata_agent_instance_id_mismatch',
    policyRevision: args.policyRevision,
  }, 'slack_inbound_other_rebel_detected');
}

function slackIdsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return normalizeAuthorId('slack', a) === normalizeAuthorId('slack', b);
}

function buildInboundPrincipalRateLimitKey(args: {
  teamId: string;
  principal: InboundAuthorPrincipal;
}): string {
  return buildSlackRecentSenderPrincipalKey({
    transport: 'slack',
    teamId: args.teamId,
    principalKind: args.principal.kind,
    normalizedAuthorId: args.principal.normalizedAuthorId,
  });
}

function recordDeniedAttempt(args: {
  recentSendersStore: SlackRecentSendersStore;
  teamId: string;
  principal: InboundAuthorPrincipal;
  payload: z.infer<typeof SlackEventPayloadSchema>;
  channelType: InboundSurfaceChannelType;
  logger: Logger;
  eventId: string;
  teamIdHash: string;
  metadataAgentInstanceId?: string | null;
}): void {
  if (args.principal.kind !== 'human' && args.principal.kind !== 'agent') {
    return;
  }

  const userProfile = args.principal.kind === 'human'
    ? extractSlackUserProfile(args.payload)
    : { displayName: undefined, handle: undefined };
  const eventRecord = slackEventRecord(args.payload);
  const rawAuthorId = args.principal.kind === 'human'
    ? (nullableTrimmedString(eventRecord.user) ?? args.principal.normalizedAuthorId)
    : (args.metadataAgentInstanceId ?? args.principal.normalizedAuthorId);
  const rawChannel = eventRecord.channel;
  const channelId = nullableTrimmedString(rawChannel)
    ?? (
      typeof rawChannel === 'object'
      && rawChannel !== null
      ? nullableTrimmedString((rawChannel as { id?: unknown }).id)
      : null
    )
    ?? 'unknown';

  try {
    args.recentSendersStore.recordAttempt({
      transport: 'slack',
      teamId: args.teamId,
      principalKind: args.principal.kind,
      authorId: rawAuthorId,
      normalizedAuthorId: args.principal.normalizedAuthorId,
      displayName: args.principal.kind === 'human' ? userProfile.displayName : undefined,
      handle: args.principal.kind === 'human' ? userProfile.handle : undefined,
      channelId,
      channelType: args.channelType,
    });
  } catch (err) {
    args.logger.warn({
      event: 'slack_recent_sender_record_failed',
      eventId: args.eventId,
      teamIdHash: args.teamIdHash,
      error: redactSlackError(err),
    }, 'slack_recent_sender_record_failed');
  }
}

function projectSlackThreadIdentity(
  payload: z.infer<typeof SlackEventPayloadSchema>,
  teamId: string,
): SlackThreadContext['identity'] | null {
  const event = payload.event as Record<string, unknown>;
  const channel = (
    typeof event.channel === 'string'
    || (typeof event.channel === 'object' && event.channel !== null)
  )
    ? (event.channel as string | { id?: string })
    : undefined;
  const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : undefined;
  const ts = typeof event.ts === 'string' ? event.ts : undefined;

  return extractSlackThreadIdentity({
    team: teamId,
    channel,
    thread_ts: threadTs,
    ts,
  });
}

function slackBlocksFromPayload(payload: z.infer<typeof SlackEventPayloadSchema>): SlackBlock[] | undefined {
  const blocks = payload.event.blocks;
  if (!Array.isArray(blocks)) return undefined;
  return blocks.filter((block): block is SlackBlock => (
    typeof block === 'object'
    && block !== null
    && 'type' in block
    && typeof (block as { type?: unknown }).type === 'string'
  ));
}

function inflightKey(teamId: string, eventId: string): string {
  return `${teamId}:${eventId}`;
}

function sweepInflightEvents(now: number): void {
  for (const [key, entry] of inflightWebhookEvents) {
    if (now - entry.startedAt > INFLIGHT_EVENT_TTL_MS) {
      inflightWebhookEvents.delete(key);
    }
  }
}

function threadHistoryUnavailableKey(context: SlackThreadContext): string {
  const { teamId, channelId, threadTs } = context.identity;
  return `${teamId}:${channelId}:${threadTs}`;
}

function logThreadHistoryUnavailable(args: {
  log: Logger;
  eventId: string;
  teamIdHash: string;
  reason: string;
  timeoutMs?: number;
}): void {
  args.log.warn({
    event: 'slack_thread_history_unavailable',
    eventId: args.eventId,
    teamIdHash: args.teamIdHash,
    reason: args.reason,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  }, 'slack_thread_history_unavailable');
}

function logThreadHistoryUnavailableOnce(args: Parameters<typeof logThreadHistoryUnavailable>[0] & { context: SlackThreadContext }): void {
  const key = threadHistoryUnavailableKey(args.context);
  if (loggedThreadHistoryUnavailableThreads.has(key)) return;
  loggedThreadHistoryUnavailableThreads.add(key);
  logThreadHistoryUnavailable(args);
}

function shouldDedupThreadHistoryUnavailable(reason: string): boolean {
  return reason === '401' || reason === '403' || reason === 'missing' || reason === 'token_revoked';
}

function resolveInboundAuthorPolicy(settings: AppSettings): InboundAuthorPolicy {
  return settings.experimental?.inboundAuthorPolicy ?? LEGACY_PERMISSIVE_INBOUND_AUTHOR_POLICY;
}

function resolveInboundAuthorPolicyDropLogContext(routeDeps: SlackWebhookRouteDeps): {
  policyRevision: string;
  policySummary: ReturnType<typeof summarizePolicyForLog>;
} {
  const policy = resolveInboundAuthorPolicy(routeDeps.getSettings());
  return {
    policyRevision: buildInboundAuthorPolicyRevision(policy),
    policySummary: summarizePolicyForLog(policy),
  };
}

async function maybePrefetchThreadHistory(args: {
  context: SlackThreadContext;
  eventId: string;
  eventTs?: string;
  teamIdHash: string;
  ownerUserId?: string;
  settings: AppSettings;
  log: Logger;
}): Promise<{ digest: string; filteredCount: number }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), SLACK_THREAD_HISTORY_TIMEOUT_MS);
  const fetchStartedAt = Date.now();

  try {
    const replies = await slackThreadAdapterInstance?.getThreadHistory(
      args.context.identity.channelId,
      args.context.identity.threadTs,
      ctrl.signal,
    ) ?? [];
    const inboundAuthorPolicy = resolveInboundAuthorPolicy(args.settings);
    const policySummary = summarizePolicyForLog(inboundAuthorPolicy);
    const digest = formatThreadHistoryDigest(replies, {
      excludeEventTs: args.eventTs,
      inboundAuthorPolicy,
      ownerNormalizedAuthorId: args.ownerUserId ? normalizeAuthorId('slack', args.ownerUserId) : null,
      teamId: args.context.identity.teamId,
      surfaceId: args.context.identity.channelId,
      onReplyFiltered: ({ reply, decision, error }) => {
        const normalizedAuthorId = reply.author.normalizedAuthorId?.trim() || 'UNKNOWN';
        logInboundAuthorDrop({
          logger: args.log,
          eventId: args.eventTs ?? args.context.identity.threadTs,
          teamIdHash: args.teamIdHash,
          principalUserIdHash: hashPrincipalUserId(reply.author.kind, normalizedAuthorId),
          principalKind: reply.author.kind,
          surfaceId: args.context.identity.channelId,
          decision: 'drop_context',
          gateId: decision.gateId,
          reason: decision.reason,
          policyRevision: decision.policyRevision,
          policySummary,
          logEvent: error ? 'slack_digest_predicate_error' : undefined,
        });
      },
    });
    args.log.info({
      event: 'slack_thread_history_fetched',
      eventId: args.eventId,
      teamIdHash: args.teamIdHash,
      replyCount: replies.length,
      filteredCount: digest.filteredCount,
      fetchMs: Math.max(1, Date.now() - fetchStartedAt),
    }, 'slack_thread_history_fetched');
    return digest;
  } catch (err) {
    if (err instanceof SlackThreadHistoryError && err.reason === '429') {
      args.log.warn({
        event: 'slack_thread_history_rate_limited',
        eventId: args.eventId,
        teamIdHash: args.teamIdHash,
        retryAfter: err.retryAfter,
      }, 'slack_thread_history_rate_limited');
      return EMPTY_THREAD_HISTORY_DIGEST;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      logThreadHistoryUnavailable({
        log: args.log,
        eventId: args.eventId,
        teamIdHash: args.teamIdHash,
        reason: 'timeout',
        timeoutMs: SLACK_THREAD_HISTORY_TIMEOUT_MS,
      });
      return EMPTY_THREAD_HISTORY_DIGEST;
    }
    const reason = err instanceof SlackThreadHistoryError ? err.reason : 'unknown';
    if (shouldDedupThreadHistoryUnavailable(reason)) {
      logThreadHistoryUnavailableOnce({
        log: args.log,
        context: args.context,
        eventId: args.eventId,
        teamIdHash: args.teamIdHash,
        reason,
      });
    } else {
      logThreadHistoryUnavailable({
        log: args.log,
        eventId: args.eventId,
        teamIdHash: args.teamIdHash,
        reason,
      });
    }
    return EMPTY_THREAD_HISTORY_DIGEST;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractTeamId(rawBody: unknown): string | null {
  if (typeof rawBody !== 'object' || rawBody === null) return null;
  const body = rawBody as Record<string, unknown>;
  if (typeof body.team_id === 'string' && body.team_id.length > 0) return body.team_id;
  if (typeof body.event === 'object' && body.event !== null) {
    const ev = body.event as Record<string, unknown>;
    if (typeof ev.team_id === 'string' && ev.team_id.length > 0) return ev.team_id;
  }
  return null;
}

function sourceIpFromRequest(req: IncomingMessage | undefined): string {
  if (!req) return 'unknown';
  const forwardedFor = req.headers['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof firstForwarded === 'string' && firstForwarded.trim()) {
    return firstForwarded.split(',')[0]?.trim() || 'unknown';
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

function enqueueBeforeAck(routeDeps: SlackWebhookRouteDeps, payload: z.infer<typeof SlackEventPayloadSchema>, teamId: string, rawBody: string): void {
  if (Buffer.byteLength(rawBody, 'utf8') > SLACK_PENDING_INBOUND_RAW_BODY_MAX_BYTES) {
    routeDeps.log.warn({ eventId: payload.event_id, teamIdHash: hashTeamId(teamId), rawBodyBytes: Buffer.byteLength(rawBody, 'utf8') }, 'Slack inbound payload too large for durable replay; dropping');
    return;
  }
  routeDeps.pendingLog.enqueue({
    eventId: payload.event_id,
    teamId,
    payloadHash: payloadHash(rawBody),
    rawBody,
    receivedAt: Date.now(),
  });
}

function parseSlackEventBody(rawText: string, routeDeps: SlackWebhookRouteDeps): unknown | null {
  try {
    return JSON.parse(rawText);
  } catch (err) {
    routeDeps.log.warn({
      event: 'slack_webhook_schema_invalid',
      stage: 'json',
      payloadBytes: Buffer.byteLength(rawText ?? '', 'utf8'),
      errorMessage: err instanceof Error ? err.message : String(err),
    }, 'slack_webhook_schema_invalid');
    return null;
  }
}

function logSlackMetadataParseFailed(args: {
  routeDeps: SlackWebhookRouteDeps;
  rawPayload: unknown;
  teamId: string;
  reason: string;
  metadataBytes?: number;
  issuePaths?: string[];
}): void {
  const payloadRecord = typeof args.rawPayload === 'object' && args.rawPayload !== null
    ? args.rawPayload as Record<string, unknown>
    : {};
  const eventRecord = typeof payloadRecord.event === 'object' && payloadRecord.event !== null
    ? payloadRecord.event as Record<string, unknown>
    : {};
  const eventId = typeof payloadRecord.event_id === 'string' ? payloadRecord.event_id : 'unknown';
  const surfaceId = typeof eventRecord.channel === 'string' ? eventRecord.channel : 'unknown';
  const { policyRevision, policySummary } = resolveInboundAuthorPolicyDropLogContext(args.routeDeps);

  logInboundAuthorDrop({
    logger: args.routeDeps.log,
    eventId,
    teamIdHash: hashTeamId(args.teamId),
    principalUserIdHash: hashPrincipalUserId('unknown', 'unknown'),
    principalKind: 'unknown',
    surfaceId,
    decision: 'drop_metadata_parse_failed',
    gateId: 'metadata-parse',
    reason: args.reason,
    policyRevision,
    policySummary,
    extra: {
      metadataBytes: args.metadataBytes,
      issuePaths: args.issuePaths,
    },
    logEvent: 'slack_metadata_parse_failed',
  });
}

function sanitizeSlackEventMetadata(
  rawPayload: unknown,
  teamId: string,
  routeDeps: SlackWebhookRouteDeps,
): unknown {
  if (typeof rawPayload !== 'object' || rawPayload === null) return rawPayload;
  const payloadRecord = rawPayload as Record<string, unknown>;
  if (typeof payloadRecord.event !== 'object' || payloadRecord.event === null) return rawPayload;

  const eventRecord = payloadRecord.event as Record<string, unknown>;
  if (!('metadata' in eventRecord) || eventRecord.metadata === undefined) return rawPayload;
  const metadata = eventRecord.metadata;

  let metadataBytes: number | undefined;
  try {
    metadataBytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  } catch {
    logSlackMetadataParseFailed({
      routeDeps,
      rawPayload,
      teamId,
      reason: 'metadata_non_serializable',
    });
    const { metadata: _omitMetadata, ...eventWithoutMetadata } = eventRecord;
    return { ...payloadRecord, event: eventWithoutMetadata };
  }

  if (metadataBytes > SLACK_MESSAGE_METADATA_MAX_BYTES) {
    logSlackMetadataParseFailed({
      routeDeps,
      rawPayload,
      teamId,
      reason: 'metadata_too_large',
      metadataBytes,
    });
    const { metadata: _omitMetadata, ...eventWithoutMetadata } = eventRecord;
    return { ...payloadRecord, event: eventWithoutMetadata };
  }

  const parsedMetadata = SlackMessageMetadataSchema.safeParse(metadata);
  if (!parsedMetadata.success) {
    logSlackMetadataParseFailed({
      routeDeps,
      rawPayload,
      teamId,
      reason: 'metadata_schema_invalid',
      metadataBytes,
      issuePaths: parsedMetadata.error.issues.map((issue) => issue.path.join('.')),
    });
    const { metadata: _omitMetadata, ...eventWithoutMetadata } = eventRecord;
    return { ...payloadRecord, event: eventWithoutMetadata };
  }

  return {
    ...payloadRecord,
    event: {
      ...eventRecord,
      metadata: parsedMetadata.data,
    },
  };
}

function parseSlackEventPayload(
  rawPayload: unknown,
  teamId: string,
  routeDeps: SlackWebhookRouteDeps,
): z.infer<typeof SlackEventPayloadSchema> | null {
  const payloadWithSanitizedMetadata = sanitizeSlackEventMetadata(rawPayload, teamId, routeDeps);
  const parsedPayload = SlackEventPayloadSchema.safeParse(payloadWithSanitizedMetadata);
  if (!parsedPayload.success) {
    const payloadRecord = typeof rawPayload === 'object' && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};
    const eventRecord = typeof payloadRecord.event === 'object' && payloadRecord.event !== null
      ? (payloadRecord.event as Record<string, unknown>)
      : {};
    let payloadBytes = -1;
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(rawPayload) ?? '', 'utf8');
    } catch {
      payloadBytes = -1;
    }

    routeDeps.log.warn({
      event: 'slack_webhook_schema_invalid',
      stage: 'schema',
      eventId: typeof payloadRecord.event_id === 'string' ? payloadRecord.event_id : 'unknown',
      teamIdHash: hashTeamId(teamId),
      eventType: typeof eventRecord.type === 'string' ? eventRecord.type : 'unknown',
      envelopeType: typeof payloadRecord.type === 'string' ? payloadRecord.type : 'unknown',
      payloadBytes,
      issuePaths: parsedPayload.error.issues.map((issue) => issue.path.join('.')),
      issueCodes: parsedPayload.error.issues.map((issue) => issue.code),
    }, 'slack_webhook_schema_invalid');
    return null;
  }
  return parsedPayload.data;
}

function isTokensRevokedEvent(payload: z.infer<typeof SlackEventPayloadSchema>): boolean {
  return payload.event.type === 'tokens_revoked';
}

function logDisabledOnce(routeDeps: SlackWebhookRouteDeps, teamId: string): void {
  if (loggedDisabledTeams.has(teamId)) return;
  loggedDisabledTeams.add(teamId);
  routeDeps.log.info({ teamIdHash: hashTeamId(teamId) }, 'slack_webhook_dropped_disabled');
}

function logNotConnectedOnce(
  routeDeps: SlackWebhookRouteDeps,
  key: string,
  teamId: string | null,
  eventTeamId: string,
): void {
  if (loggedNotConnectedTeams.has(key)) return;
  loggedNotConnectedTeams.add(key);
  routeDeps.log.warn({
    teamIdHash: teamId ? hashTeamId(teamId) : null,
    eventTeamIdHash: hashTeamId(eventTeamId),
  }, 'slack_webhook_dropped_not_connected');
}

function logTeamMismatchOnce(routeDeps: SlackWebhookRouteDeps, workspaceTeamId: string, eventTeamId: string): void {
  const key = `${workspaceTeamId}:${eventTeamId}`;
  if (loggedTeamMismatchPairs.has(key)) return;
  loggedTeamMismatchPairs.add(key);
  routeDeps.log.warn({
    workspaceTeamIdHash: hashTeamId(workspaceTeamId),
    eventTeamIdHash: hashTeamId(eventTeamId),
  }, 'slack_webhook_dropped_team_mismatch');
}

function dropSecretUnavailable(routeDeps: SlackWebhookRouteDeps, res: ServerResponse, req: IncomingMessage | undefined, teamId: string): void | Promise<void> {
  routeDeps.log.warn({ code: 'SIGNING_SECRET_UNAVAILABLE', teamIdHash: hashTeamId(teamId) }, 'slack_webhook_dropped_secret_unavailable');
  return sendJson(res, 200, { ok: true, dropped: true, reason: 'secret_unavailable' }, req);
}

function logSignatureFailure(routeDeps: SlackWebhookRouteDeps, teamId: string, error: WebhookAuthError): void {
  routeDeps.log.warn({
    event: 'slack_signature_failure',
    teamIdHash: hashTeamId(teamId),
    code: error.code,
  }, 'slack_signature_failure');
}

function safeBroadcastWorkspaceChanged(routeDeps: SlackWebhookRouteDeps, payload: unknown): void {
  const parsed = SlackWorkspaceChangedSchema.safeParse(payload);
  if (!parsed.success) {
    routeDeps.log.warn({ error: parsed.error.flatten() }, 'Slack workspace changed broadcast payload failed schema validation');
    return;
  }
  try {
    routeDeps.broadcast(SLACK_WORKSPACE_CHANGED_CHANNEL, parsed.data);
  } catch (err) {
    routeDeps.log.warn({ err: redactSlackError(err) }, 'Slack workspace changed broadcast failed');
  }
}

function safeBroadcastWorkspaceDisconnected(routeDeps: SlackWebhookRouteDeps, payload: unknown): void {
  const parsed = SlackWorkspaceDisconnectedSchema.safeParse(payload);
  if (!parsed.success) {
    routeDeps.log.warn({ error: parsed.error.flatten() }, 'Slack workspace disconnected broadcast payload failed schema validation');
    return;
  }
  try {
    routeDeps.broadcast(SLACK_WORKSPACE_DISCONNECTED_CHANNEL, parsed.data);
  } catch (err) {
    routeDeps.log.warn({ err: redactSlackError(err) }, 'Slack workspace disconnected broadcast failed');
  }
}

function handleTokensRevokedEvent(routeDeps: SlackWebhookRouteDeps, payload: z.infer<typeof SlackEventPayloadSchema>, teamId: string): { status: number; body: Record<string, unknown> } {
  const workspace = routeDeps.workspaceStore.get();
  if (!workspace || workspace.teamId !== teamId) {
    routeDeps.log.info({
      eventTeamIdHash: hashTeamId(teamId),
      workspaceTeamIdHash: workspace?.teamId ? hashTeamId(workspace.teamId) : null,
    }, 'slack_webhook_tokens_revoked_no_workspace');
    return { status: 200, body: { ok: true, dropped: true, reason: 'tokens_revoked_no_workspace' } };
  }

  const occurredAt = Date.now();
  routeDeps.workspaceStore.updateStatus('needs_reconnect', {
    code: 'tokens_revoked',
    message: 'Slack tokens were revoked.',
    occurredAt,
  });
  safeBroadcastWorkspaceChanged(routeDeps, {
    teamId: workspace.teamId,
    teamName: workspace.teamName,
    status: 'needs_reconnect',
    reason: 'tokens_revoked',
    ...(typeof workspace.peerInstanceCount === 'number'
      ? { peerInstanceCount: workspace.peerInstanceCount }
      : {}),
    occurredAt,
  });
  safeBroadcastWorkspaceDisconnected(routeDeps, {
    teamId: workspace.teamId,
    reason: 'tokens_revoked',
    occurredAt,
  });
  routeDeps.pendingDeliveries.cancelByTeamId(workspace.teamId);
  routeDeps.log.info({ teamIdHash: hashTeamId(workspace.teamId) }, 'slack_webhook_tokens_revoked_handled');
  return { status: 200, body: { ok: true, action: 'tokens_revoked_handled' } };
}

export async function handleSlackWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (process.env.REBEL_DISABLE_CLOUD_WEBHOOK_ADAPTERS) {
      res.setHeader('Retry-After', '300');
      return sendJson(res, 503, { error: 'Service Unavailable' }, req);
    }

    if (req.method !== 'POST') {
      throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
    }

    const { raw, parsed } = await readRawBody(req);
    const urlVerification = SlackUrlVerificationSchema.safeParse(parsed);
    if (urlVerification.success) {
      return sendJson(res, 200, { challenge: urlVerification.data.challenge }, req);
    }

    return await dispatchSlackInboundRaw({
      rawBody: raw,
      headers: headersFromRequest(req),
      req,
      res,
      returnSlackAuthFailureAsDropped: false,
    });
  } catch (err) {
    if (res.headersSent) return;
    if (err instanceof RouteError) {
      return sendRouteError(res, req, err);
    }
    log.error({ err }, 'Unhandled slack webhook handler error');
    return sendRouteError(res, req, new RouteError('INTERNAL_ERROR', {
      status: 500,
      message: 'An unexpected error occurred',
    }));
  }
}

export async function dispatchSlackInboundRaw(args: {
  rawBody: Buffer;
  headers: HeadersLike;
  req?: IncomingMessage;
  res: ServerResponse;
  returnSlackAuthFailureAsDropped: boolean;
}): Promise<void> {
  const startTime = Date.now();
  const routeDeps = deps();
  const rawText = args.rawBody.toString('utf8');
  const rawPayload = parseSlackEventBody(rawText, routeDeps);
  if (rawPayload === null) {
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'invalid_body' }, args.req);
  }
  const teamId = extractTeamId(rawPayload);
  if (!teamId) {
    routeDeps.log.warn({ event: 'slack_webhook_no_team_id' }, 'slack_webhook_no_team_id');
    return sendJson(args.res, 400, { error: 'NO_TEAM_ID' }, args.req);
  }
  const teamIdHash = hashTeamId(teamId);
  const payloadRecord = typeof rawPayload === 'object' && rawPayload !== null
    ? (rawPayload as Record<string, unknown>)
    : {};
  const envelopeType = typeof payloadRecord.type === 'string' ? payloadRecord.type : undefined;

  if (
    envelopeType &&
    envelopeType !== 'event_callback' &&
    envelopeType !== 'url_verification' &&
    ACK_ONLY_UNSUPPORTED_ENVELOPE_TYPES.has(envelopeType)
  ) {
    routeDeps.log.warn({
      event: 'slack_webhook_unsupported_envelope_type',
      teamIdHash,
      envelopeType,
    }, 'slack_webhook_unsupported_envelope_type');
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'unsupported_envelope_type' }, args.req);
  }

  const parsedPayload = parseSlackEventPayload(rawPayload, teamId, routeDeps);
  if (parsedPayload === null) {
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'invalid_body' }, args.req);
  }

  routeDeps.log.info({
    event: 'slack_webhook_received',
    eventId: parsedPayload.event_id,
    teamIdHash,
    eventType: parsedPayload.event?.type ?? 'unknown',
    channelType: channelTypeFromPayload(parsedPayload),
    payloadBytes: args.rawBody.length,
  }, 'slack_webhook_received');

  const sourceIp = sourceIpFromRequest(args.req);
  const preVerifyLimit = routeDeps.preVerifyIpRateLimiter.consume(sourceIp);
  if (!preVerifyLimit.allowed) {
    args.res.setHeader('Retry-After', String(preVerifyLimit.retryAfter));
    routeDeps.log.warn({
      event: 'slack_webhook_rate_limited',
      scope: 'pre_verify_ip',
      teamIdHash,
      ip: sourceIp,
      retryAfter: preVerifyLimit.retryAfter,
    }, 'slack_webhook_rate_limited');
    return sendJson(args.res, 429, { retryAfter: preVerifyLimit.retryAfter }, args.req);
  }
  const tokensRevoked = isTokensRevokedEvent(parsedPayload);

  if (tokensRevoked) {
    const adapter = slackThreadAdapterInstance;
    if (!adapter) {
      throw new RouteError('INTERNAL_ERROR', { status: 500, message: 'ExternalConversationService not initialized' });
    }
    try {
      await adapter.verifyRequestSignatureForInbound(args.rawBody, args.headers);
    } catch (err) {
      if (err instanceof WebhookAuthError) {
        logSignatureFailure(routeDeps, teamId, err);
        if (err.code === 'REPLAY') return sendJson(args.res, 200, { ok: true }, args.req);
        if (err.code === 'SIGNING_SECRET_UNAVAILABLE') {
          return dropSecretUnavailable(routeDeps, args.res, args.req, teamId);
        }
        if (args.returnSlackAuthFailureAsDropped) {
          routeDeps.log.warn({ code: err.code, teamIdHash }, 'Managed Slack inbound failed Slack signature verification; dropping');
          return sendJson(args.res, 200, { ok: true, dropped: true }, args.req);
        }
        throw new RouteError('UNAUTHORIZED', { status: 401, message: err.message });
      }
      throw err;
    }
    const handled = handleTokensRevokedEvent(routeDeps, parsedPayload, teamId);
    return sendJson(args.res, handled.status, handled.body, args.req);
  }

  if (routeDeps.getSettings().experimental?.slackCloudWebhookEnabled !== true) {
    logDisabledOnce(routeDeps, teamId);
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'cloud_webhook_disabled' }, args.req);
  }

  const workspace = routeDeps.workspaceStore.get();
  if (!workspace || workspace.status === 'disconnected') {
    logNotConnectedOnce(
      routeDeps,
      `workspace_not_connected:${teamId}`,
      workspace?.teamId ?? null,
      teamId,
    );
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'workspace_not_connected' }, args.req);
  }
  if (workspace.status === 'needs_reconnect') {
    logNotConnectedOnce(
      routeDeps,
      `workspace_needs_reconnect:${workspace.teamId}:${teamId}`,
      workspace.teamId,
      teamId,
    );
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'workspace_needs_reconnect' }, args.req);
  }
  if (workspace.status !== 'connected') {
    logNotConnectedOnce(
      routeDeps,
      `workspace_not_connected:${workspace.teamId}:${teamId}`,
      workspace.teamId,
      teamId,
    );
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'workspace_not_connected' }, args.req);
  }
  if (workspace.teamId !== teamId) {
    logTeamMismatchOnce(routeDeps, workspace.teamId, teamId);
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'workspace_team_id_mismatch' }, args.req);
  }

  const service = getExternalConversationService();
  const adapter = slackThreadAdapterInstance;
  if (!service || !adapter) {
    throw new RouteError('INTERNAL_ERROR', { status: 500, message: 'ExternalConversationService not initialized' });
  }

  try {
    await adapter.verifyRequestSignatureForInbound(args.rawBody, args.headers);
  } catch (err) {
    if (err instanceof WebhookAuthError) {
      logSignatureFailure(routeDeps, teamId, err);
      if (err.code === 'REPLAY') return sendJson(args.res, 200, { ok: true }, args.req);
      if (err.code === 'SIGNING_SECRET_UNAVAILABLE') {
        return dropSecretUnavailable(routeDeps, args.res, args.req, teamId);
      }
      if (args.returnSlackAuthFailureAsDropped) {
        routeDeps.log.warn({ code: err.code, teamIdHash }, 'Managed Slack inbound failed Slack signature verification; dropping');
        return sendJson(args.res, 200, { ok: true, dropped: true }, args.req);
      }
      throw new RouteError('UNAUTHORIZED', { status: 401, message: err.message });
    }
    throw err;
  }

  const rateLimit = routeDeps.teamRateLimiter.consume(teamId);
  if (!rateLimit.allowed) {
    args.res.setHeader('Retry-After', String(rateLimit.retryAfter));
    routeDeps.log.warn({
      event: 'slack_webhook_rate_limited',
      scope: 'verified_team',
      teamIdHash,
      retryAfter: rateLimit.retryAfter,
    }, 'slack_webhook_rate_limited');
    return sendJson(args.res, 429, { retryAfter: rateLimit.retryAfter }, args.req);
  }

  let verified: SlackThreadContext | InboundVerificationDropResult;
  try {
    verified = await adapter.verifyInbound(args.rawBody, args.headers);
  } catch (err) {
    if (err instanceof WebhookAuthError) {
      logSignatureFailure(routeDeps, teamId, err);
      if (err.code === 'REPLAY') return sendJson(args.res, 200, { ok: true }, args.req);
      if (err.code === 'SIGNING_SECRET_UNAVAILABLE') {
        return dropSecretUnavailable(routeDeps, args.res, args.req, teamId);
      }
      if (args.returnSlackAuthFailureAsDropped) {
        routeDeps.log.warn({ code: err.code, teamIdHash }, 'Managed Slack inbound failed Slack signature verification; dropping');
        return sendJson(args.res, 200, { ok: true, dropped: true }, args.req);
      }
      throw new RouteError('UNAUTHORIZED', { status: 401, message: err.message });
    }
    throw err;
  }

  if (isDropResult(verified)) {
    if (verified.kind === 'signature-invalid') {
      routeDeps.log.warn({ teamIdHash, reason: verified.reason }, 'Slack inbound malformed; dropping');
    }
    return sendJson(args.res, 200, { ok: true, dropped: true }, args.req);
  }

  const projectedIdentity = projectSlackThreadIdentity(parsedPayload, teamId);
  if (!projectedIdentity) {
    routeDeps.log.warn({
      event: 'slack_thread_identity_extraction_failed',
      eventId: parsedPayload.event_id,
      teamIdHash,
    }, 'slack_thread_identity_extraction_failed');
    return sendJson(args.res, 200, { ok: true, dropped: true, reason: 'thread_identity_extraction_failed' }, args.req);
  }
  const projectedContext: SlackThreadContext = {
    ...verified,
    identity: projectedIdentity,
  };

  enqueueBeforeAck(routeDeps, parsedPayload, teamId, rawText);
  sendJson(args.res, 200, { ok: true }, args.req);

  processAsyncWithInflight({
    service,
    context: projectedContext,
    payload: parsedPayload,
    recentSendersStore: routeDeps.recentSendersStore,
    inboundRateLimiter: routeDeps.inboundRateLimiter,
    botUserId: workspace.botUserId,
    ownerUserId: workspace.authedUserId,
    getSettings: routeDeps.getSettings,
    updateSettings: routeDeps.updateSettings,
    pendingLog: routeDeps.pendingLog,
    log: routeDeps.log,
    hasOpenBroadcastClient: routeDeps.hasOpenBroadcastClient,
    teamIdHash,
    startTime,
  }).catch((err: unknown) => {
    routeDeps.log.error({
      event: 'slack_webhook_async_error',
      eventId: parsedPayload.event_id,
      teamIdHash,
      error: redactSlackError(err),
      err: redactSlackError(err),
      phase: 'processAsync',
      durationMs: Math.max(1, Date.now() - startTime),
    }, 'slack_webhook_async_error');
    getErrorReporter().captureException(err, { area: 'external-conversation', phase: 'slack-webhook-async' });
  });
}

async function processAsync(args: {
  service: ExternalConversationService;
  context: SlackThreadContext;
  payload: z.infer<typeof SlackEventPayloadSchema>;
  recentSendersStore: SlackRecentSendersStore;
  inboundRateLimiter: SlackInboundRateLimiter;
  botUserId: string;
  ownerUserId?: string;
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  pendingLog: PendingInboundLog;
  log: Logger;
  hasOpenBroadcastClient: () => boolean;
  teamIdHash: string;
  startTime: number;
  claim?: { acquired: true; ownerToken: string };
  /**
   * Set when this call is replaying a stale pending-inbound log entry. Carries
   * the original receivedAt and the computed age so downstream broadcasts can
   * surface a "delayed" notice instead of pretending the message just arrived.
   */
  replayMetadata?: { replayed: true; ageMs: number; replayedAt: number };
}): Promise<void> {
  const {
    service,
    context,
    payload,
    recentSendersStore,
    inboundRateLimiter,
    botUserId,
    ownerUserId,
    getSettings,
    updateSettings: persistSettingsUpdate,
    pendingLog,
    log: processLog,
    hasOpenBroadcastClient,
    teamIdHash,
    startTime,
  } = args;
  let settings = getSettings();
  settings = syncInboundAuthorPolicyBypassStatus({
    settings,
    updateSettings: persistSettingsUpdate,
    logger: processLog,
    eventId: payload.event_id,
    teamIdHash,
  });
  const inboundAuthorPolicyBypassEnabled = process.env.REBEL_INBOUND_AUTHOR_POLICY_BYPASS === '1';
  const eventSubtype = typeof payload.event.subtype === 'string' ? payload.event.subtype : undefined;
  const isIgnoredMessageSubtype = payload.event.type === 'message'
    && eventSubtype !== undefined
    && IGNORED_SLACK_MESSAGE_SUBTYPES.has(eventSubtype);
  if ((payload.event.type !== 'message' && payload.event.type !== 'app_mention') || isIgnoredMessageSubtype) {
    pendingLog.markProcessed(payload.event_id);
    return;
  }
  if (payload.event.type === 'message' && eventSubtype !== undefined) {
    processLog.info({
      event: 'slack_unknown_subtype',
      subtype: eventSubtype,
      teamIdHash,
    }, 'slack_unknown_subtype');
  }

  const channelType = channelTypeFromPayload(payload);
  const inboundSurfaceChannelType = classifyInboundChannelType(payload);
  const blocks = slackBlocksFromPayload(payload);
  const policy = resolveInboundAuthorPolicy(settings);
  const ownerNormalizedAuthorId = deriveOwnerFromPolicy(policy, { authedUserId: ownerUserId });
  const policyForEvaluation = resolvePolicyForEvaluation({
    policy,
    ownerNormalizedAuthorId,
  });
  const policyRevision = buildInboundAuthorPolicyRevision(policyForEvaluation);
  const policySummary = summarizePolicyForLog(policy);
  const surfaceId = context.identity.channelId;
  const principalFromEvent = resolvePrincipalFromEvent({
    payload,
    fallbackUserId: context.metadata?.userId,
  });

  if (!principalFromEvent.principal) {
    logInboundAuthorDrop({
      logger: processLog,
      eventId: payload.event_id,
      teamIdHash,
      principalUserIdHash: hashPrincipalUserId('unknown', UNKNOWN_INBOUND_AUTHOR_ID),
      principalKind: 'unknown',
      surfaceId,
      decision: 'drop_no_author_identity',
      gateId: 'principal_derivation',
      reason: 'missing_user_and_bot_id',
      policyRevision,
      policySummary,
      logEvent: 'slack_inbound_dropped_no_author_identity',
    });
    pendingLog.markProcessed(payload.event_id);
    return;
  }

  const principal = principalFromEvent.principal;
  const ownAgentInstanceId = nullableTrimmedString(settings.experimental?.agentInstanceId);
  const metadataAgentInstanceId = principalFromEvent.metadataAgentInstanceId;
  const botIdMatchesWorkspaceBotUser = slackIdsMatch(principalFromEvent.eventBotId, botUserId);
  const userMatchesWorkspaceBotUser = slackIdsMatch(principalFromEvent.eventUserId, botUserId);

  if (
    ownAgentInstanceId
    && metadataAgentInstanceId
    && ownAgentInstanceId === metadataAgentInstanceId
  ) {
    logInboundAuthorDrop({
      logger: processLog,
      eventId: payload.event_id,
      teamIdHash,
      principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
      principalKind: principal.kind,
      surfaceId,
      decision: 'drop_self_message',
      gateId: 'self_message',
      reason: 'metadata_agent_instance_id_matches',
      policyRevision,
      policySummary,
      logEvent: 'slack_inbound_dropped_self_message_metadata',
    });
    pendingLog.markProcessed(payload.event_id);
    return;
  }

  const isOtherRebelBotMessage = Boolean(
    ownAgentInstanceId
    && metadataAgentInstanceId
    && ownAgentInstanceId !== metadataAgentInstanceId
    && botIdMatchesWorkspaceBotUser,
  );

  if (isOtherRebelBotMessage) {
    logInboundOtherRebelDetected({
      logger: processLog,
      eventId: payload.event_id,
      teamIdHash,
      principal,
      surfaceId,
      policyRevision,
    });
  } else if (botIdMatchesWorkspaceBotUser) {
    logInboundAuthorDrop({
      logger: processLog,
      eventId: payload.event_id,
      teamIdHash,
      principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
      principalKind: principal.kind,
      surfaceId,
      decision: 'drop_self_message',
      gateId: 'self_message',
      reason: 'bot_id_matches_workspace_bot_user_id',
      policyRevision,
      policySummary,
      logEvent: 'slack_inbound_dropped_self_message',
    });
    pendingLog.markProcessed(payload.event_id);
    return;
  } else if (userMatchesWorkspaceBotUser) {
    logInboundAuthorDrop({
      logger: processLog,
      eventId: payload.event_id,
      teamIdHash,
      principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
      principalKind: principal.kind,
      surfaceId,
      decision: 'drop_self_message',
      gateId: 'self_message',
      reason: 'user_matches_workspace_bot_user_id',
      policyRevision,
      policySummary,
      logEvent: 'slack_inbound_dropped_self_message_user',
    });
    pendingLog.markProcessed(payload.event_id);
    return;
  }

  if (payload.event.type === 'message') {
    const mentionedUserIds = extractMentionedUserIds({ text: payload.event.text, blocks });
    if (channelType !== 'im' && !mentionedUserIds.has(botUserId)) {
      logInboundAuthorDrop({
        logger: processLog,
        eventId: payload.event_id,
        teamIdHash,
        principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
        principalKind: principal.kind,
        surfaceId,
        decision: 'drop_no_bot_mention',
        gateId: 'mention_gate',
        reason: 'bot_mention_required_for_non_im',
        policyRevision,
        policySummary,
        extra: {
          channelType,
        },
        logEvent: 'slack_inbound_dropped_no_bot_mention',
      });
      pendingLog.markProcessed(payload.event_id);
      return;
    }
  }

  if (!inboundAuthorPolicyBypassEnabled && policy.mode === 'ownerOnly' && principal.kind === 'human' && !ownerNormalizedAuthorId) {
    logInboundAuthorDrop({
      logger: processLog,
      eventId: payload.event_id,
      teamIdHash,
      principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
      principalKind: principal.kind,
      surfaceId,
      decision: 'drop_no_owner_identity',
      gateId: 'slack_owner_allowlist',
      reason: 'owner_identity_missing',
      policyRevision,
      policySummary,
      logEvent: 'slack_inbound_dropped_no_owner_identity',
    });
    recordDeniedAttempt({
      recentSendersStore,
      teamId: context.identity.teamId,
      principal,
      payload,
      channelType: inboundSurfaceChannelType,
      logger: processLog,
      eventId: payload.event_id,
      teamIdHash,
      metadataAgentInstanceId,
    });
    try {
      persistMissingOwnerIdentityNotice({
        getSettings,
        updateSettings: persistSettingsUpdate,
      });
    } catch (err) {
      processLog.warn({
        event: 'slack_missing_owner_notice_persist_failed',
        eventId: payload.event_id,
        teamIdHash,
        error: redactSlackError(err),
      }, 'slack_missing_owner_notice_persist_failed');
    }
    pendingLog.markProcessed(payload.event_id);
    return;
  }

  const isOwnerPrincipal = principal.kind === 'human'
    && Boolean(ownerNormalizedAuthorId)
    && principal.normalizedAuthorId === ownerNormalizedAuthorId;
  const principalKey = buildInboundPrincipalRateLimitKey({
    teamId: context.identity.teamId,
    principal,
  });
  const principalRateLimit = inboundRateLimiter.consume(principalKey, isOwnerPrincipal);
  if (!principalRateLimit.allowed) {
    logInboundAuthorDrop({
      logger: processLog,
      eventId: payload.event_id,
      teamIdHash,
      principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
      principalKind: principal.kind,
      surfaceId,
      decision: 'drop_rate_limited',
      gateId: 'inbound_rate_limit',
      reason: 'principal_rate_limited',
      policyRevision,
      policySummary,
      logEvent: 'slack_inbound_dropped_rate_limited',
    });
    if (principal.kind === 'human') {
      recordDeniedAttempt({
        recentSendersStore,
        teamId: context.identity.teamId,
        principal,
        payload,
        channelType: inboundSurfaceChannelType,
        logger: processLog,
        eventId: payload.event_id,
        teamIdHash,
        metadataAgentInstanceId,
      });
    }
    pendingLog.markProcessed(payload.event_id);
    return;
  }

  let allowDecision:
    | ReturnType<typeof evaluateInboundAuthor>
    | {
      gateId: string;
      reason: string;
      policyRevision: string;
    };

  if (inboundAuthorPolicyBypassEnabled) {
    processLog.warn({
      event: 'slack_inbound_author_policy_bypassed',
      eventId: payload.event_id,
      teamIdHash,
      principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
      principalKind: principal.kind,
      surfaceId,
      decision: 'allow',
      gateId: 'policy_bypass',
      reason: 'REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1',
      policyRevision,
      mode: policy.mode,
      eventType: payload.event.type,
      eventSubtype,
      channelType,
      metadataAgentInstanceId: metadataAgentInstanceId ?? null,
      principalKey,
    }, 'slack_inbound_author_policy_bypassed');
    allowDecision = {
      gateId: 'policy_bypass',
      reason: 'policy_bypass',
      policyRevision,
    };
  } else {
    const inboundAuthorContext: InboundAuthorGateContext = {
      connector: 'slack',
      teamId: context.identity.teamId,
      surfaceId,
      principalKind: principal.kind,
      normalizedAuthorId: principal.normalizedAuthorId,
      principal,
      surfaceTrusted: policy.surfaceTrusted?.slack?.includes(surfaceId) ?? false,
    };

    let decision: ReturnType<typeof evaluateInboundAuthor>;
    try {
      decision = evaluateInboundAuthor(
        inboundAuthorContext,
        policyForEvaluation,
        [SLACK_INBOUND_AUTHOR_GATE],
      );
    } catch (error) {
      const reason = (
        error instanceof Error
          ? error.message
          : String(error ?? 'unknown_evaluator_error')
      ).slice(0, 200) || 'unknown_evaluator_error';
      logInboundAuthorDrop({
        logger: processLog,
        eventId: payload.event_id,
        teamIdHash,
        principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
        principalKind: principal.kind,
        surfaceId,
        decision: 'drop',
        gateId: 'evaluator_error',
        reason,
        policyRevision,
        policySummary,
        logEvent: 'slack_inbound_gate_evaluator_error',
      });
      if (principal.kind === 'human') {
        recordDeniedAttempt({
          recentSendersStore,
          teamId: context.identity.teamId,
          principal,
          payload,
          channelType: inboundSurfaceChannelType,
          logger: processLog,
          eventId: payload.event_id,
          teamIdHash,
          metadataAgentInstanceId,
        });
      }
      pendingLog.markProcessed(payload.event_id);
      return;
    }

    if (decision.decision === 'deny') {
      logInboundAuthorDrop({
        logger: processLog,
        eventId: payload.event_id,
        teamIdHash,
        principalUserIdHash: hashPrincipalUserId(principal.kind, principal.normalizedAuthorId),
        principalKind: principal.kind,
        surfaceId,
        decision: 'drop',
        gateId: decision.gateId,
        reason: decision.reason,
        policyRevision: decision.policyRevision,
        policySummary,
      });
      if (principal.kind === 'human' || (principal.kind === 'agent' && isOtherRebelBotMessage)) {
        recordDeniedAttempt({
          recentSendersStore,
          teamId: context.identity.teamId,
          principal,
          payload,
          channelType: inboundSurfaceChannelType,
          logger: processLog,
          eventId: payload.event_id,
          teamIdHash,
          metadataAgentInstanceId,
        });
      }
      pendingLog.markProcessed(payload.event_id);
      return;
    }

    allowDecision = decision;
  }

  logInboundAuthorAllow({
    logger: processLog,
    eventId: payload.event_id,
    teamIdHash,
    principal,
    surfaceId,
    gateId: allowDecision.gateId,
    reason: allowDecision.reason,
    policyRevision: allowDecision.policyRevision,
  });

  const claim = args.claim ?? pendingLog.claimEventProcessing({
    teamId: context.identity.teamId,
    eventId: payload.event_id,
  });
  if (!claim.acquired) {
    processLog.info({
      event: 'slack_webhook_dedup_skip',
      eventId: payload.event_id,
      teamIdHash,
      reason: claim.priorState,
    }, 'slack_webhook_dedup_skip');
    return;
  }

  const ownerToken = claim.ownerToken;
  const text = extractMessageText({ text: payload.event.text, blocks });
  const formattedPrompt = typeof slackThreadAdapterInstance?.formatInitialPrompt === 'function'
    ? slackThreadAdapterInstance.formatInitialPrompt(context, text, channelType)
    : text;
  // The HTTP 200 ack is already sent before this async path runs. We enrich
  // before conversation creation so the Slack chip is fresh the first time it renders.
  const enrichedContext = typeof slackThreadAdapterInstance?.enrichContextMetadata === 'function'
    ? await slackThreadAdapterInstance.enrichContextMetadata(context)
    : context;
  const { conversationId, isNewConversation } = conversationScopeResolver.resolve(enrichedContext, randomUUID());
  let injectText = formattedPrompt;
  let digestFilteredCount = 0;
  if (!isNewConversation && settings.experimental?.slackInboundThreadHistory !== false) {
    const historyDigest = await maybePrefetchThreadHistory({
      context: enrichedContext,
      eventId: payload.event_id,
      eventTs: typeof payload.event.ts === 'string' ? payload.event.ts : undefined,
      teamIdHash,
      ownerUserId,
      settings,
      log: processLog,
    });
    digestFilteredCount = historyDigest.filteredCount;
    if (historyDigest.digest) {
      injectText = `${historyDigest.digest}\n\n${formattedPrompt}`;
    }
  }
  const contextWithDigest: SlackThreadContext = digestFilteredCount > 0
    ? {
      ...enrichedContext,
      metadata: {
        ...enrichedContext.metadata,
        digestFilteredCount,
      },
    }
    : enrichedContext;

  if (isNewConversation) {
    await service.createConversation(enrichedContext, {
      userText: text,
      ...(args.replayMetadata ? { replayMetadata: args.replayMetadata } : {}),
    });
  } else {
    await service.injectMessage({
      conversationId,
      context: contextWithDigest,
      text: injectText,
      ...(args.replayMetadata ? { replayMetadata: args.replayMetadata } : {}),
    });
  }

  // Cloud broadcast deferral guard: if no OPEN WS client received the
  // conversations:start-requested broadcast that just fired inside
  // service.createConversation/injectMessage, do NOT mark the entry processed.
  // It will sit in the durable pending log until a client connects, at which
  // point externalConversationServiceFactory's onClientConnected hook re-drives
  // replayPendingSlackInbound.
  //
  // The check is a snapshot taken AFTER the synchronous broadcast loop
  // completes. Since broadcast() only sends to clients in OPEN state and the
  // loop is synchronous, a client transitioning CONNECTING -> OPEN cannot
  // observe the broadcast mid-loop. Any post-loop connect is caught by the
  // on-connect replay path.
  if (!hasOpenBroadcastClient()) {
    processLog.warn({
      event: 'slack_broadcast_deferred_no_consumer',
      teamIdHash,
      eventId: payload.event_id,
      conversationId,
      isNewConversation,
      durationMs: Math.max(1, Date.now() - startTime),
    }, 'slack_broadcast_deferred_no_consumer');
    pendingLog.markBroadcastDeferred({
      teamId: context.identity.teamId,
      eventId: payload.event_id,
      ownerToken,
    });
    return;
  }

  processLog.info({
    event: 'slack_webhook_dispatched',
    eventId: payload.event_id,
    teamIdHash,
    conversationId,
    isNewConversation,
    processMs: Math.max(1, Date.now() - startTime),
    durationMs: Math.max(1, Date.now() - startTime),
  }, 'slack_webhook_dispatched');

  pendingLog.releaseAfterSuccess({
    teamId: context.identity.teamId,
    eventId: payload.event_id,
    ownerToken,
  });
}

function processAsyncWithInflight(args: Parameters<typeof processAsync>[0]): Promise<void> {
  const now = Date.now();
  sweepInflightEvents(now);
  const key = inflightKey(args.context.identity.teamId, args.payload.event_id);
  const existing = inflightWebhookEvents.get(key);
  if (existing) {
    args.log.info({
      event: 'slack_webhook_inflight_dedup_joined',
      eventId: args.payload.event_id,
      teamIdHash: args.teamIdHash,
      waitMs: Math.max(0, now - existing.startedAt),
    }, 'slack_webhook_inflight_dedup_joined');
    return existing.promise;
  }

  const promise = processAsync(args).finally(() => {
    inflightWebhookEvents.delete(key);
  });
  inflightWebhookEvents.set(key, { promise, startedAt: now });
  return promise;
}

export async function replayPendingSlackInbound(): Promise<void> {
  const adapter = slackThreadAdapterInstance;
  if (!adapter) return;
  const routeDeps = deps();
  const service = getExternalConversationService();
  const entries = routeDeps.pendingLog.drainUnprocessed();
  await mapWithConcurrencyLimit(entries, REPLAY_CONCURRENCY, async (entry) => {
    const teamIdHash = hashTeamId(entry.teamId);
    const claim = routeDeps.pendingLog.tryResumeClaim({ teamId: entry.teamId, eventId: entry.eventId });
    if (!claim.acquired) {
      routeDeps.log.info({
        event: 'slack_webhook_dedup_skip',
        eventId: entry.eventId,
        teamIdHash,
        reason: claim.priorState,
      }, 'slack_webhook_dedup_skip');
      return;
    }
    const rawBody = Buffer.from(entry.rawBody, 'utf8');

    // Defense-in-depth: the durable log is treated as trusted (we skip Slack signature
    // re-verification on replay), so verify the persisted payloadHash matches the
    // raw body before calling replayInboundFromTrustedLog. A mismatch indicates the
    // log file was corrupted or tampered with on disk; drop the entry rather than
    // replay attacker-controlled data through the trusted path.
    const expectedHash = payloadHash(entry.rawBody);
    if (expectedHash !== entry.payloadHash) {
      routeDeps.log.warn({
        event: 'slack_replay_payload_hash_mismatch',
        eventId: entry.eventId,
        teamIdHash,
      }, 'slack_replay_payload_hash_mismatch');
      routeDeps.pendingLog.markProcessed(entry.eventId);
      return;
    }

    let parsed: z.infer<typeof SlackEventPayloadSchema>;
    let replayTeamId: string | null;
    const logReplayParseFailure = (error?: unknown): void => {
      routeDeps.log.warn({
        event: 'slack_replay_payload_parse_failed',
        eventId: entry.eventId,
        teamIdHash,
        error: error instanceof Error ? error.message : String(error ?? 'invalid_payload'),
      }, 'slack_replay_payload_parse_failed');
      routeDeps.pendingLog.markProcessed(entry.eventId);
    };

    try {
      const rawPayload = parseSlackEventBody(entry.rawBody, routeDeps);
      if (rawPayload === null) {
        logReplayParseFailure('invalid_json');
        return;
      }
      replayTeamId = extractTeamId(rawPayload);
      const parsedPayload = parseSlackEventPayload(rawPayload, entry.teamId, routeDeps);
      if (parsedPayload === null) {
        logReplayParseFailure('invalid_schema');
        return;
      }
      parsed = parsedPayload;
    } catch (error) {
      logReplayParseFailure(error);
      return;
    }
    if (!replayTeamId) {
      routeDeps.pendingLog.markProcessed(entry.eventId);
      return;
    }
    routeDeps.log.warn({ eventId: entry.eventId, teamIdHash }, 'slack_replay_potential_duplicate');

    // Replay is deliberately biased toward "maybe double-deliver" rather than
    // silent loss: the pending log is marked processed only after injection
    // succeeds, so a crash between injectMessage and markProcessed can replay.
    // The adapter's processed-event LRU is a best-effort guard for same-process
    // restart races; it cannot protect across a cold process restart.
    let verified: SlackThreadContext | InboundVerificationDropResult;
    try {
      verified = await adapter.replayInboundFromTrustedLog(rawBody, entry.receivedAt);
    } catch (err) {
      if (err instanceof WebhookAuthError && err.code === 'REPLAY') {
        routeDeps.pendingLog.markProcessed(entry.eventId);
        return;
      }
      throw err;
    }
    if (isDropResult(verified)) {
      if (shouldMarkReplayDropProcessed({
        result: verified,
        eventId: entry.eventId,
        teamIdHash: hashTeamId(replayTeamId),
        log: routeDeps.log,
      })) {
        routeDeps.pendingLog.markProcessed(entry.eventId);
      }
      return;
    }
    const replayedAt = Date.now();
    const ageMs = Math.max(0, replayedAt - entry.receivedAt);
    await processAsync({
      service,
      context: verified,
      payload: parsed,
      recentSendersStore: routeDeps.recentSendersStore,
      inboundRateLimiter: routeDeps.inboundRateLimiter,
      botUserId: routeDeps.workspaceStore.get()?.botUserId ?? '',
      ownerUserId: routeDeps.workspaceStore.get()?.authedUserId,
      getSettings: routeDeps.getSettings,
      updateSettings: routeDeps.updateSettings,
      pendingLog: routeDeps.pendingLog,
      log: routeDeps.log,
      hasOpenBroadcastClient: routeDeps.hasOpenBroadcastClient,
      teamIdHash: hashTeamId(replayTeamId),
      startTime: replayedAt,
      claim: { acquired: true, ownerToken: claim.ownerToken },
      replayMetadata: { replayed: true, ageMs, replayedAt },
    });
  });
}

// Register replay handler at module-load so the externalConversationServiceFactory
// can trigger inbound replay without an import cycle on this module.
registerSlackInboundReplayHandler(replayPendingSlackInbound);
