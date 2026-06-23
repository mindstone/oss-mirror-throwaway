/**
 * @intent-marker Unified External Conversation Architecture Stage 1
 *
 * Part of the unified external-conversation architecture (intent-critical).
 * Source of truth for intent: docs/plans/260502_unified_external_conversation_architecture.md
 *
 * KEY INVARIANTS (do not weaken without re-reading the planning doc):
 *  - Transport-agnostic core (§3 invariant 2)
 *  - Cross-surface parity (§3 invariant 5)
 *  - Provenance on every cross-surface broadcast (§3 Spec Reader)
 *  - Adapter-shaped extension point (§2 success criteria)
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { createScopedLogger, type Logger } from '@core/logger';
import { createStore } from '@core/storeFactory';
import { getSettings } from '@core/services/settingsStore/index';
import type { BroadcastService } from '@core/broadcastService';
import { LruCache } from '@core/utils/lruCache';
import { extractAgentAssistantText } from '@core/agentRuntimeTypes';
import type { AgentAssistantMessage } from '@core/agentRuntimeTypes';
import {
  buildInboundAuthorPolicyRevision,
  evaluateInboundAuthor,
  type InboundAuthorDecision as InboundAuthorGateDecision,
  type InboundAuthorPolicy as InboundAuthorGatePolicy,
} from '@core/services/inboundAuthorGates';
import { SLACK_INBOUND_AUTHOR_GATE } from '@core/services/inboundAuthorGates/slackInboundAuthorGate';
import { normalizeAuthorId } from '@core/services/inboundAuthorPolicy/normalizeAuthorId';
import { fireAndForget } from '@shared/utils/fireAndForget';
import {
  createPublicChannelSafetyHookForSlack,
  wrapInboundSlackMessageForAgent,
  type SlackPromptSafetyContext,
} from '@core/services/inboundTriggers/slackPromptSafety';
import { isSlackAuthErrorCode } from '@core/services/inboundTriggers/slackAuthErrorCodes';
import { hashTeamId, isUserActionable, redactSlackError } from '@shared/utils/teamIdHash';
import { getSlackApiBaseUrl } from '@shared/utils/slackApiBaseUrl';
import {
  SLACK_WORKSPACE_CHANGED_CHANNEL,
  SLACK_WORKSPACE_DISCONNECTED_CHANNEL,
  SlackWorkspaceChangedSchema,
  SlackWorkspaceDisconnectedSchema,
} from '@shared/ipc/channels/slack';
import {
  InboundAuthorPolicySchemaVersion,
  type InboundAuthorPolicy as SharedInboundAuthorPolicy,
} from '@rebel/shared';
import {
  ExternalConversationAdapter,
  DeliveryResult,
  WebhookAuthError,
  HeadersLike,
  type InboundVerificationDropResult,
} from '../externalConversationAdapter';
import { SlackThreadContext, type SlackThreadContextMetadata } from '../externalContext';
import { AgentResponse, ToolProvider } from '../types';
import { buildOutboundMetadata, type SlackMessageMetadata } from '../slackOutboundMetadata';

const defaultLog = createScopedLogger({ service: 'slackThreadAdapter' });

const MAX_LRU_SIZE = 200;
export const SLACK_USER_CACHE_MAX = 200;
export const SLACK_USER_CACHE_TTL_MS = 60 * 60 * 1000;
export const SLACK_USER_CACHE_NEG_TTL_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [2000, 8000, 30000];
const SLACK_REPLY_CHUNK_SIZE = 3500;
const SLACK_MAX_REPLY_CHUNKS = 5;
export const SLACK_THREAD_HISTORY_PREFETCH_LIMIT = 20;
const UNKNOWN_INBOUND_AUTHOR_ID = 'UNKNOWN';

const LEGACY_PERMISSIVE_DIGEST_POLICY: SharedInboundAuthorPolicy = {
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

function slackApiUrl(path: string): URL {
  return new URL(path, getSlackApiBaseUrl());
}

function slackApiUrlString(path: string): string {
  return slackApiUrl(path).toString();
}

function resolveSlackOutboundIntent(channelId: string): 'thread_reply' | 'dm_reply' {
  const normalized = channelId.trim().toUpperCase();
  return normalized.startsWith('D') ? 'dm_reply' : 'thread_reply';
}

type ChannelType = 'channel' | 'group' | 'im' | 'mpim';

type SlackWorkspaceStatus = 'connected' | 'needs_reconnect' | 'disconnecting' | 'disconnected';

interface SlackWorkspaceRecordLike {
  teamId: string;
  teamName: string;
  teamDomain?: string;
  botUserId: string;
  botToken: string;
  authedUserId?: string;
  provisionMode?: 'managed' | 'byok';
  installedAt: number;
  lastSeenAt?: number;
  status: SlackWorkspaceStatus;
  lastError?: { code: string; message: string; occurredAt: number };
}

export interface SlackWorkspaceStoreLike {
  get(): SlackWorkspaceRecordLike | null;
  set(record: SlackWorkspaceRecordLike): void;
  updateStatus(status: SlackWorkspaceStatus, error?: SlackWorkspaceRecordLike['lastError']): void;
  updateLastSeen(): void;
  clear(): void;
}

export type SlackInboundVerificationResult = SlackThreadContext | InboundVerificationDropResult;

interface PendingDelivery {
  id: string;
  context: SlackThreadContext;
  conversationId: string;
  message: AgentResponse;
  attempt: number;
  addedAt: number;
  chunksSent?: number;
  cancelledAt?: number;
}

interface SlackAdapterStoreSchema extends Record<string, unknown> {
  processedEvents: { id: string; timestamp: number }[];
  pendingDeliveries: Record<string, unknown>;
}

interface SlackThreadAdapterDeps {
  signingSecret?: string | null;
  signingSecretProvider?: (workspace: SlackWorkspaceRecordLike | null, rawBody: Buffer) => Promise<string | null> | string | null;
  workspaceStore: SlackWorkspaceStoreLike;
  fetchImpl?: typeof fetch;
  broadcast?: BroadcastService;
  log?: Logger;
}

interface VerifyInboundOptions {
  allowProcessedReplay?: boolean;
  allowStaleTimestamp?: boolean;
}

export interface ParsedSlackEvent {
  teamId: string;
  channelId: string;
  threadTs: string;
  userId: string | null;
  channelName: string | null;
}

export interface SlackClient {
  token: string;
  teamId: string;
  teamName: string | null;
  teamDomain: string | null;
  fetchImpl?: typeof fetch;
}

const SLACK_USERS_INFO_AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
] as const);

const SlackApiOkSchema = z.object({ ok: z.literal(true) }).passthrough();
const SlackApiErrorSchema = z.object({ ok: z.literal(false), error: z.string().optional() }).passthrough();
const SlackConversationsRepliesSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  messages: z.array(z.object({
    ts: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    text: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export interface SlackThreadHistoryReplyAuthor {
  kind: 'human' | 'agent' | 'unknown';
  normalizedAuthorId?: string;
}

export interface SlackThreadHistoryReply {
  ts: string;
  author: SlackThreadHistoryReplyAuthor;
  text: string;
}

export interface FormatThreadHistoryDigestOptions {
  excludeEventTs?: string | null;
  inboundAuthorPolicy?: SharedInboundAuthorPolicy | null;
  ownerNormalizedAuthorId?: string | null;
  teamId?: string;
  surfaceId?: string;
  onReplyFiltered?: (args: {
    reply: SlackThreadHistoryReply;
    decision: InboundAuthorGateDecision;
    error?: unknown;
  }) => void;
}

export interface FormattedThreadHistoryDigest {
  digest: string;
  filteredCount: number;
}

export type SlackThreadHistoryUnavailableReason =
  | '401'
  | '403'
  | 'missing'
  | 'token_revoked'
  | '429'
  | '5xx'
  | 'network'
  | 'malformed'
  | 'unknown';

export class SlackThreadHistoryError extends Error {
  readonly reason: SlackThreadHistoryUnavailableReason;
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(
    reason: SlackThreadHistoryUnavailableReason,
    message: string,
    details: { status?: number; retryAfter?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'SlackThreadHistoryError';
    this.reason = reason;
    this.status = details.status;
    this.retryAfter = details.retryAfter;
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}
const SlackUserInfoSchema = z.union([
  z.object({
    ok: z.literal(true),
    user: z.object({
      id: z.string().optional(),
      name: z.string().nullable().optional(),
      real_name: z.string().nullable().optional(),
      profile: z.object({
        display_name: z.string().nullable().optional(),
        real_name: z.string().nullable().optional(),
      }).passthrough().optional(),
    }).passthrough(),
  }).passthrough(),
  SlackApiErrorSchema,
]);
const SlackConversationInfoSchema = z.union([
  z.object({
    ok: z.literal(true),
    channel: z.object({
      id: z.string().optional(),
      name: z.string().nullable().optional(),
    }).passthrough(),
  }).passthrough(),
  SlackApiErrorSchema,
]);
const SlackTeamInfoSchema = z.union([
  z.object({
    ok: z.literal(true),
    team: z.object({
      id: z.string().optional(),
      name: z.string().nullable().optional(),
      domain: z.string().nullable().optional(),
    }).passthrough(),
  }).passthrough(),
  SlackApiErrorSchema,
]);

interface SlackTeamInfo {
  teamName: string | null;
  teamDomain: string | null;
}

function isSlackThreadContext(value: SlackInboundVerificationResult): value is SlackThreadContext {
  return value.kind === 'slack-thread';
}

function normalizeChannelType(value: unknown): ChannelType {
  return value === 'group' || value === 'im' || value === 'mpim' ? value : 'channel';
}

function isPublicChannel(channelType: ChannelType): boolean {
  return channelType === 'channel';
}

function inferChannelTypeFromChannelId(channelId: string | undefined | null): ChannelType | undefined {
  const trimmed = (channelId ?? '').trim().toUpperCase();
  if (!trimmed) return undefined;
  const prefix = trimmed.charAt(0);
  if (prefix === 'D') return 'im';
  if (prefix === 'G') return 'group';
  if (prefix === 'C') return 'channel';
  return undefined;
}

function buildSlackInitialPrompt(
  ctx: SlackThreadContext,
  rawText: string,
  channelType: ChannelType,
): string {
  const safetyContext: SlackPromptSafetyContext = {
    rawText,
    channelType,
    authorUserId: ctx.metadata.userId ?? 'unknown',
    isPublicChannel: isPublicChannel(channelType),
  };

  const lines: string[] = [
    `You were mentioned in a Slack thread in channel ${ctx.identity.channelId}.`,
    `Team ID: ${ctx.identity.teamId}`,
    `Channel ID: ${ctx.identity.channelId}`,
    `Thread TS: ${ctx.identity.threadTs}`,
  ];

  const publicChannelSafety = createPublicChannelSafetyHookForSlack(safetyContext);
  if (publicChannelSafety) {
    lines.push('', ...publicChannelSafety.promptLines);
  }

  lines.push(
    '',
    wrapInboundSlackMessageForAgent(safetyContext),
    '',
    'Instructions:',
    '1. Do what they asked.',
    '2. Reply in this Slack thread by calling reply_to_slack_thread. You MUST call the tool — saying you posted is not the same as posting. The user only sees what arrives via reply_to_slack_thread.',
  );

  return lines.join('\n');
}

function nullableTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pickSlackUserName(user: z.infer<typeof SlackUserInfoSchema> & { ok: true }): string | null {
  return (
    nullableTrimmed(user.user.profile?.display_name)
    ?? nullableTrimmed(user.user.profile?.real_name)
    ?? nullableTrimmed(user.user.real_name)
    ?? nullableTrimmed(user.user.name)
  );
}

export function buildSlackPermalink(args: {
  teamDomain: string | null | undefined;
  channelId: string;
  ts: string;
  threadTs?: string | null;
}): string | null {
  const teamDomain = nullableTrimmed(args.teamDomain);
  if (!teamDomain || !args.channelId || !args.ts) return null;
  const [seconds, micros = ''] = args.ts.split('.');
  if (!seconds) return null;
  const paddedMicros = micros.padEnd(6, '0').slice(0, 6);
  const baseUrl = `https://${teamDomain}.slack.com/archives/${args.channelId}/p${seconds}${paddedMicros}`;
  if (args.threadTs && args.threadTs !== args.ts) {
    return `${baseUrl}?thread_ts=${encodeURIComponent(args.threadTs)}&cid=${encodeURIComponent(args.channelId)}`;
  }
  return baseUrl;
}

function formatSlackThreadHistoryTimestamp(ts: string): string {
  const seconds = Number.parseInt(ts.split('.')[0] ?? '', 10);
  if (!Number.isFinite(seconds)) return ts || 'unknown time';
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    '-',
    pad(date.getUTCMonth() + 1),
    '-',
    pad(date.getUTCDate()),
    ' ',
    pad(date.getUTCHours()),
    ':',
    pad(date.getUTCMinutes()),
  ].join('');
}

export function formatThreadHistoryDigest(
  replies: SlackThreadHistoryReply[],
  options: FormatThreadHistoryDigestOptions = {},
): FormattedThreadHistoryDigest {
  const policy = options.inboundAuthorPolicy ?? LEGACY_PERMISSIVE_DIGEST_POLICY;
  const ownerNormalizedAuthorId = nullableTrimmed(options.ownerNormalizedAuthorId);
  const policyForEvaluation: InboundAuthorGatePolicy = ownerNormalizedAuthorId
    ? { ...policy, ownerNormalizedAuthorId }
    : policy;
  const fallbackPolicyRevision = buildInboundAuthorPolicyRevision(policyForEvaluation);

  const allowedReplies: SlackThreadHistoryReply[] = [];
  let filteredCount = 0;

  for (const reply of replies) {
    const normalizedAuthorId = nullableTrimmed(reply.author.normalizedAuthorId);

    if (policy.mode === 'legacyPermissive') {
      const isBlocklisted = Boolean(
        normalizedAuthorId
        && policy.blocklist?.slack?.includes(normalizedAuthorId),
      );
      if (isBlocklisted) {
        const decision: InboundAuthorGateDecision = {
          decision: 'deny',
          gateId: 'legacy_blocklist',
          reason: 'blocklist',
          policyRevision: fallbackPolicyRevision,
        };
        filteredCount += 1;
        options.onReplyFiltered?.({ reply, decision });
        continue;
      }
      allowedReplies.push(reply);
      continue;
    }

    const normalizedAuthorIdForGate = normalizedAuthorId ?? UNKNOWN_INBOUND_AUTHOR_ID;

    try {
      const decision = evaluateInboundAuthor({
        connector: 'slack',
        teamId: options.teamId ?? 'unknown',
        surfaceId: options.surfaceId ?? 'unknown',
        principalKind: reply.author.kind,
        normalizedAuthorId: normalizedAuthorIdForGate,
        principal: {
          kind: reply.author.kind,
          normalizedAuthorId: normalizedAuthorIdForGate,
        },
      }, policyForEvaluation, [SLACK_INBOUND_AUTHOR_GATE]);

      if (decision.decision === 'allow') {
        allowedReplies.push(reply);
        continue;
      }

      filteredCount += 1;
      options.onReplyFiltered?.({ reply, decision });
    } catch (error) {
      const decision: InboundAuthorGateDecision = {
        decision: 'deny',
        gateId: 'digest-author-predicate',
        reason: 'predicate_error',
        policyRevision: fallbackPolicyRevision,
      };
      filteredCount += 1;
      options.onReplyFiltered?.({ reply, decision, error });
    }
  }

  const filtered = allowedReplies
    .filter((reply) => reply.ts !== options.excludeEventTs)
    .slice(-SLACK_THREAD_HISTORY_PREFETCH_LIMIT);

  if (filtered.length === 0) {
    return {
      digest: '',
      filteredCount,
    };
  }

  const lines = filtered.map((reply) => {
    const user = nullableTrimmed(reply.author.normalizedAuthorId) ?? 'Unknown user';
    const timestamp = formatSlackThreadHistoryTimestamp(reply.ts);
    return `[${user}, ${timestamp}]: ${reply.text.trim().replace(/```/g, "''")}`;
  });

  return {
    digest: ['Prior thread context:', ...lines].join('\n'),
    filteredCount,
  };
}

function deriveThreadHistoryReplyAuthor(message: { user?: string; bot_id?: string }): SlackThreadHistoryReplyAuthor {
  const normalizedUser = nullableTrimmed(message.user);
  if (normalizedUser) {
    return {
      kind: 'human',
      normalizedAuthorId: normalizeAuthorId('slack', normalizedUser),
    };
  }

  const normalizedBotId = nullableTrimmed(message.bot_id);
  if (normalizedBotId) {
    return {
      kind: 'agent',
      normalizedAuthorId: normalizeAuthorId('slack', normalizedBotId),
    };
  }

  return {
    kind: 'unknown',
  };
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (Array.from(remaining).length > maxChars) {
    const chars = Array.from(remaining);
    let lastNewlineAt = -1;
    let lastSpaceAt = -1;
    for (let index = 0; index < maxChars; index += 1) {
      if (chars[index] === '\n') lastNewlineAt = index;
      if (chars[index] === ' ') lastSpaceAt = index;
    }

    let splitAt = lastNewlineAt;
    if (splitAt < Math.floor(maxChars * 0.5)) splitAt = lastSpaceAt;
    if (splitAt < Math.floor(maxChars * 0.5)) splitAt = maxChars;
    chunks.push(chars.slice(0, splitAt).join('').trimEnd());
    remaining = chars.slice(splitAt).join('').trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function extractAgentResponseText(response: AgentResponse): string {
  if (response.type !== 'assistant') return '';
  return extractAgentAssistantText(response as AgentAssistantMessage).trim();
}

function deliveryRetryAfter(seconds: number): DeliveryResult {
  return {
    status: 'transient-failure',
    reason: 'Slack rate-limited',
    retryAfterSec: seconds,
    retryAt: Date.now() + seconds * 1000,
  };
}

function deliveryAttemptNumber(delivery: PendingDelivery | undefined): number {
  return (delivery?.attempt ?? 0) + 1;
}

function deliveryFailureReasonCode(reason: string): string {
  const slackReason = /Slack (?:auth|delivery) error: (?<code>[a-z0-9_]+)/i.exec(reason)?.groups?.['code'];
  if (slackReason) {
    return slackReason;
  }
  return reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export class SlackThreadAdapter implements ExternalConversationAdapter<SlackThreadContext> {
  public readonly kind = 'slack-thread';
  private readonly signingSecret: string;
  private readonly store: ReturnType<typeof createStore<SlackAdapterStoreSchema>>;
  private readonly lruProcessedEvents = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly workspaceStore: SlackWorkspaceStoreLike;
  private readonly signingSecretProvider?: SlackThreadAdapterDeps['signingSecretProvider'];
  private readonly broadcast?: BroadcastService;
  private readonly log: Logger;
  private readonly chunksSentByDeliveryId = new Map<string, number>();
  private readonly scheduledRetries = new Map<string, { timer: NodeJS.Timeout; teamId: string }>();
  private readonly userNameCache = new LruCache<string | null>({
    maxEntries: SLACK_USER_CACHE_MAX,
    ttlMs: SLACK_USER_CACHE_TTL_MS,
  });
  private readonly teamInfoCacheByTeamId = new Map<string, SlackTeamInfo>();

  constructor(deps: SlackThreadAdapterDeps) {
    this.signingSecret = deps.signingSecret ?? '';
    this.signingSecretProvider = deps.signingSecretProvider;
    this.workspaceStore = deps.workspaceStore;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.broadcast = deps.broadcast;
    this.log = deps.log ?? defaultLog;
    this.store = createStore<SlackAdapterStoreSchema>({
      name: 'slackThreadAdapter',
      defaults: {
        processedEvents: [],
        pendingDeliveries: {},
      },
    });
    this.initLru();
  }

  private initLru(): void {
    const events = (this.store.get('processedEvents') as { id: string; timestamp: number }[]) || [];
    for (const ev of events) this.lruProcessedEvents.add(ev.id);
  }

  private recordProcessedEvent(eventId: string): void {
    this.lruProcessedEvents.add(eventId);
    let events = (this.store.get('processedEvents') as { id: string; timestamp: number }[]) || [];
    events.push({ id: eventId, timestamp: Date.now() });

    if (events.length > MAX_LRU_SIZE) {
      const removed = events.slice(0, events.length - MAX_LRU_SIZE);
      events = events.slice(events.length - MAX_LRU_SIZE);
      for (const ev of removed) this.lruProcessedEvents.delete(ev.id);
    }

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const validEvents = events.filter((e) => e.timestamp > oneHourAgo);
    if (validEvents.length !== events.length) {
      this.lruProcessedEvents.clear();
      for (const ev of validEvents) this.lruProcessedEvents.add(ev.id);
    }

    this.store.set('processedEvents', validEvents);
  }

  public isEventProcessed(eventId: string): boolean {
    return this.lruProcessedEvents.has(eventId);
  }

  private verifyRequestSignatureWithSecret(
    rawBody: Buffer,
    headers: HeadersLike,
    signingSecret: string,
    options: Pick<VerifyInboundOptions, 'allowStaleTimestamp'> = {},
  ): void {
    const timestampStr = headers.get('x-slack-request-timestamp');
    const signature = headers.get('x-slack-signature');

    if (!timestampStr || !signature) {
      throw new WebhookAuthError('Missing Slack signature headers', 'MISSING_HEADERS', false);
    }

    const timestamp = Number.parseInt(timestampStr, 10);
    if (Number.isNaN(timestamp)) {
      throw new WebhookAuthError('Invalid Slack request timestamp', 'INVALID_TIMESTAMP', false);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!options.allowStaleTimestamp && Math.abs(nowSeconds - timestamp) > 5 * 60) {
      throw new WebhookAuthError('Slack request timestamp outside of 5-minute window', 'STALE_TIMESTAMP', false);
    }

    const sigBasestring = `v0:${timestamp}:${rawBody.toString('utf8')}`;
    const expectedSignature = `v0=${crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex')}`;

    let isValid = false;
    try {
      isValid = crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
    } catch {
      isValid = false;
    }

    if (!isValid) {
      throw new WebhookAuthError('Slack signature mismatch', 'SIGNATURE_MISMATCH', false);
    }
  }

  verifyRequestSignature(rawBody: Buffer, headers: HeadersLike, options: Pick<VerifyInboundOptions, 'allowStaleTimestamp'> = {}): void {
    if (!this.signingSecret) {
      throw new WebhookAuthError('Slack signing secret unavailable', 'SIGNING_SECRET_UNAVAILABLE', false);
    }
    this.verifyRequestSignatureWithSecret(rawBody, headers, this.signingSecret, options);
  }

  async verifyRequestSignatureForInbound(
    rawBody: Buffer,
    headers: HeadersLike,
    options: Pick<VerifyInboundOptions, 'allowStaleTimestamp'> = {},
  ): Promise<void> {
    const record = this.workspaceStore.get();
    const signingSecret = this.signingSecretProvider
      ? await this.signingSecretProvider(record, rawBody)
      : this.signingSecret;
    if (!signingSecret) {
      throw new WebhookAuthError('Slack signing secret unavailable', 'SIGNING_SECRET_UNAVAILABLE', false);
    }
    this.verifyRequestSignatureWithSecret(rawBody, headers, signingSecret, options);
  }

  async replayInbound(rawBody: Buffer, headers: HeadersLike): Promise<SlackInboundVerificationResult> {
    return this.verifyInbound(rawBody, headers, {
      allowProcessedReplay: false,
      allowStaleTimestamp: true,
    });
  }

  private async replayInboundForTrustedLog(rawBody: Buffer, headers: HeadersLike): Promise<SlackInboundVerificationResult> {
    return this.verifyInbound(rawBody, headers, {
      allowProcessedReplay: true,
      allowStaleTimestamp: true,
    });
  }

  /**
   * Replay a Slack event that Rebel already wrote to the trusted pending-inbound
   * log. Public HTTP routes must never call this; they must verify Slack's HMAC
   * headers. Replay signs with this adapter's injected signing secret so env
   * rotation/unset values after startup do not strand durable events.
   */
  async replayInboundFromTrustedLog(rawBody: Buffer, receivedAt: number): Promise<SlackInboundVerificationResult> {
    const record = this.workspaceStore.get();
    const signingSecret = this.signingSecretProvider
      ? await this.signingSecretProvider(record, rawBody)
      : this.signingSecret;
    if (!signingSecret) {
      throw new WebhookAuthError('Slack signing secret unavailable', 'SIGNING_SECRET_UNAVAILABLE', false);
    }
    const timestamp = Math.floor(receivedAt / 1000).toString();
    const signature = `v0=${crypto
      .createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${rawBody.toString('utf8')}`)
      .digest('hex')}`;
    return this.replayInboundForTrustedLog(rawBody, {
      get(name: string) {
        if (name === 'x-slack-request-timestamp') return timestamp;
        if (name === 'x-slack-signature') return signature;
        return null;
      },
    });
  }

  async verifyInbound(rawBody: Buffer, headers: HeadersLike, options: VerifyInboundOptions = {}): Promise<SlackInboundVerificationResult> {
    await this.verifyRequestSignatureForInbound(rawBody, headers, { allowStaleTimestamp: options.allowStaleTimestamp });

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookAuthError('Invalid JSON payload', 'INVALID_JSON', false);
    }

    const payloadRecord = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    const event = payloadRecord?.event && typeof payloadRecord.event === 'object'
      ? payloadRecord.event as Record<string, unknown>
      : null;
    if (!payloadRecord || !event) {
      throw new WebhookAuthError('Missing event payload', 'MISSING_EVENT', false);
    }

    const record = this.workspaceStore.get();
    const payloadTeamId = typeof payloadRecord.team_id === 'string'
      ? payloadRecord.team_id
      : (typeof event.team_id === 'string' ? event.team_id : undefined);
    const effectiveTeamId = payloadTeamId ?? record?.teamId;
    if (!record || record.status !== 'connected') {
      this.log.info(
        { teamIdHash: effectiveTeamId ? hashTeamId(effectiveTeamId) : undefined, status: record?.status ?? 'missing' },
        'Slack inbound dropped because workspace is not connected',
      );
      return { kind: 'workspace-not-connected' };
    }

    if (typeof event.user === 'string' && event.user === record.botUserId) {
      this.log.info({ teamIdHash: hashTeamId(record.teamId), channelId: event.channel }, 'Slack inbound self-mention ignored');
      return { kind: 'self-mention-ignored' };
    }

    const eventId = typeof payloadRecord.event_id === 'string' ? payloadRecord.event_id : undefined;
    if (eventId) {
      const scopeKey = `${effectiveTeamId ?? record.teamId}:${eventId}`;
      if (this.isEventProcessed(scopeKey) && !options.allowProcessedReplay) {
        throw new WebhookAuthError('Replay detected', 'REPLAY', false);
      }
      if (!this.isEventProcessed(scopeKey)) this.recordProcessedEvent(scopeKey);
    }

    const channelId = typeof event.channel === 'string' ? event.channel : undefined;
    const eventType = typeof event.type === 'string' ? event.type : undefined;
    const channelType = normalizeChannelType(event.channel_type);
    if (!channelId) {
      if (eventType === 'message' && channelType === 'im') {
        this.log.warn({ teamIdHash: hashTeamId(record.teamId), eventType, channelType }, 'Slack DM payload missing channel');
        return { kind: 'signature-invalid', reason: 'missing_dm_channel' };
      }
      throw new WebhookAuthError('Missing channel in event', 'MISSING_CHANNEL', false);
    }

    const eventTs = typeof event.ts === 'string' ? event.ts : undefined;
    const threadTs = typeof event.thread_ts === 'string'
      ? event.thread_ts
      : eventTs;
    if (!threadTs) {
      throw new WebhookAuthError('Missing Slack thread timestamp', 'MISSING_THREAD_TS', false);
    }

    return {
      kind: 'slack-thread',
      identity: {
        teamId: effectiveTeamId ?? record.teamId,
        channelId,
        threadTs,
      },
      metadata: {
        userId: typeof event.user === 'string' ? event.user : undefined,
        userName: null,
        userDisplayName: null,
        channelName: typeof event.channel_name === 'string' ? event.channel_name : null,
        teamName: record.teamName ?? null,
        permalink: buildSlackPermalink({
          teamDomain: record.teamDomain ?? null,
          channelId,
          ts: eventTs ?? threadTs,
          threadTs,
        }),
        channelType,
      },
    };
  }

  formatInitialPrompt(ctx: SlackThreadContext, eventText: string, channelType: ChannelType): string;
  formatInitialPrompt(args: { intent?: string; userText?: string; context: SlackThreadContext; pageContext?: { title?: string; url?: string; selection?: string; text?: string } }): string;
  formatInitialPrompt(
    first: SlackThreadContext | { intent?: string; userText?: string; context: SlackThreadContext; pageContext?: { title?: string; url?: string; selection?: string; text?: string } },
    eventText?: string,
    channelType: ChannelType = 'channel',
  ): string {
    if ('kind' in first) {
      return buildSlackInitialPrompt(first, eventText ?? '', channelType);
    }
    const ctx = first.context;
    const rawText = first.userText ?? '';
    const effectiveChannelType = ctx.metadata.channelType
      ?? inferChannelTypeFromChannelId(ctx.identity.channelId)
      ?? 'channel';
    return buildSlackInitialPrompt(ctx, rawText, effectiveChannelType);
  }

  async enrichContextMetadata(context: SlackThreadContext): Promise<SlackThreadContext> {
    const record = this.workspaceStore.get();
    if (!record || record.status !== 'connected') {
      return {
        ...context,
        metadata: {
          ...context.metadata,
          userName: context.metadata.userName ?? context.metadata.userDisplayName ?? null,
          channelName: context.metadata.channelName ?? null,
          teamName: context.metadata.teamName ?? null,
          permalink: context.metadata.permalink ?? null,
        },
      };
    }

    const metadata = await this.enrichMetadata({
      teamId: context.identity.teamId,
      channelId: context.identity.channelId,
      threadTs: context.identity.threadTs,
      userId: context.metadata.userId ?? null,
      channelName: context.metadata.channelName ?? null,
    }, {
      token: record.botToken,
      teamId: record.teamId,
      teamName: record.teamName,
      teamDomain: record.teamDomain ?? null,
      fetchImpl: this.fetchImpl,
    });

    return {
      ...context,
      metadata: {
        ...context.metadata,
        ...metadata,
        permalink: context.metadata.permalink ?? metadata.permalink,
        userDisplayName: metadata.userName,
      },
    };
  }

  /**
   * Fetches user/channel/team metadata for Slack context chips. Results are cached where useful,
   * failures become null fields the chip can render around, and callers must keep this off the
   * webhook ack path.
   */
  async enrichMetadata(thread: ParsedSlackEvent, slackClient: SlackClient): Promise<SlackThreadContextMetadata> {
    const teamInfo = await this.resolveTeamInfo(slackClient);
    const userName = thread.userId
      ? await this.resolveUserName(thread.teamId, thread.userId, slackClient)
      : null;
    const channelName = thread.channelName
      ?? (await this.resolveChannelName(thread.teamId, thread.channelId, slackClient));

    return {
      userId: thread.userId ?? undefined,
      userName,
      userDisplayName: userName,
      channelName,
      teamName: teamInfo.teamName,
      permalink: buildSlackPermalink({
        teamDomain: teamInfo.teamDomain,
        channelId: thread.channelId,
        ts: thread.threadTs,
      }),
    };
  }

  private async resolveUserName(teamId: string, userId: string, slackClient: SlackClient): Promise<string | null> {
    const cacheKey = `${teamId}:${userId}`;
    const cached = this.userNameCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const url = slackApiUrl('/api/users.info');
    url.searchParams.set('user', userId);

    let response: Response;
    try {
      response = await (slackClient.fetchImpl ?? this.fetchImpl)(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${slackClient.token}` },
      });
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(teamId), user_id: userId }, 'slack.usersinfo.lookup_failed');
      return null;
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.log.warn({ teamIdHash: hashTeamId(teamId), user_id: userId, status: response.status }, 'slack.usersinfo.unauthorized');
      this.userNameCache.set(cacheKey, null, SLACK_USER_CACHE_NEG_TTL_MS);
      return null;
    }

    if (!response.ok) {
      this.log.warn({ teamIdHash: hashTeamId(teamId), user_id: userId, status: response.status }, 'slack.usersinfo.http_error');
      return null;
    }

    let parsed: z.infer<typeof SlackUserInfoSchema>;
    try {
      parsed = SlackUserInfoSchema.parse(await response.json());
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(teamId), user_id: userId }, 'slack.usersinfo.malformed_response');
      return null;
    }

    if (!parsed.ok) {
      if (parsed.error === 'user_not_found') {
        this.log.warn({ teamIdHash: hashTeamId(teamId), user_id: userId, error: parsed.error }, 'slack.usersinfo.user_not_found');
        this.userNameCache.set(cacheKey, null, SLACK_USER_CACHE_NEG_TTL_MS);
        return null;
      }
      if (SLACK_USERS_INFO_AUTH_ERROR_CODES.has(parsed.error ?? '')) {
        this.log.warn({ teamIdHash: hashTeamId(teamId), user_id: userId, error: parsed.error }, 'slack.usersinfo.unauthorized');
        this.userNameCache.set(cacheKey, null, SLACK_USER_CACHE_NEG_TTL_MS);
        return null;
      }
      this.log.warn({ teamIdHash: hashTeamId(teamId), user_id: userId, error: parsed.error ?? 'unknown' }, 'slack.usersinfo.lookup_failed');
      return null;
    }

    const name = pickSlackUserName(parsed);
    this.userNameCache.set(cacheKey, name, SLACK_USER_CACHE_TTL_MS);
    return name;
  }

  private async resolveChannelName(teamId: string, channelId: string, slackClient: SlackClient): Promise<string | null> {
    const url = slackApiUrl('/api/conversations.info');
    url.searchParams.set('channel', channelId);

    let response: Response;
    try {
      response = await (slackClient.fetchImpl ?? this.fetchImpl)(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${slackClient.token}` },
      });
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(teamId), channel_id: channelId }, 'slack.conversationsinfo.lookup_failed');
      return null;
    }

    if (!response.ok) {
      this.log.warn({ teamIdHash: hashTeamId(teamId), channel_id: channelId, status: response.status }, 'slack.conversationsinfo.http_error');
      return null;
    }

    try {
      const parsed = SlackConversationInfoSchema.parse(await response.json());
      if (parsed.ok) return nullableTrimmed(parsed.channel.name);
      this.log.warn({ teamIdHash: hashTeamId(teamId), channel_id: channelId, error: parsed.error ?? 'unknown' }, 'slack.conversationsinfo.lookup_failed');
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(teamId), channel_id: channelId }, 'slack.conversationsinfo.malformed_response');
    }
    return null;
  }

  private async resolveTeamInfo(slackClient: SlackClient): Promise<SlackTeamInfo> {
    const cached = this.teamInfoCacheByTeamId.get(slackClient.teamId);
    if (cached) return cached;

    const initial: SlackTeamInfo = {
      teamName: nullableTrimmed(slackClient.teamName),
      teamDomain: nullableTrimmed(slackClient.teamDomain),
    };
    if (initial.teamDomain) {
      this.teamInfoCacheByTeamId.set(slackClient.teamId, initial);
      return initial;
    }

    let response: Response;
    try {
      response = await (slackClient.fetchImpl ?? this.fetchImpl)(slackApiUrlString('/api/team.info'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${slackClient.token}` },
      });
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(slackClient.teamId) }, 'slack.teaminfo.lookup_failed');
      this.teamInfoCacheByTeamId.set(slackClient.teamId, initial);
      return initial;
    }

    if (!response.ok) {
      this.log.warn({ teamIdHash: hashTeamId(slackClient.teamId), status: response.status }, 'slack.teaminfo.http_error');
      this.teamInfoCacheByTeamId.set(slackClient.teamId, initial);
      return initial;
    }

    try {
      const parsed = SlackTeamInfoSchema.parse(await response.json());
      if (parsed.ok) {
        const resolved = {
          teamName: nullableTrimmed(parsed.team.name) ?? initial.teamName,
          teamDomain: nullableTrimmed(parsed.team.domain) ?? initial.teamDomain,
        };
        this.teamInfoCacheByTeamId.set(slackClient.teamId, resolved);
        return resolved;
      }
      this.log.warn({ teamIdHash: hashTeamId(slackClient.teamId), error: parsed.error ?? 'unknown' }, 'slack.teaminfo.lookup_failed');
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(slackClient.teamId) }, 'slack.teaminfo.malformed_response');
    }

    this.teamInfoCacheByTeamId.set(slackClient.teamId, initial);
    return initial;
  }

  /**
   * @deprecated No production caller currently wires adapter context tools into
   * the agent runtime. Keep these descriptors reserved for the future
   * external-conversation tool wiring tracked in
   * docs/plans/260502_unified_external_conversation_architecture.md.
   */
  getContextTools(context: SlackThreadContext): ToolProvider[] {
    return [
      {
        name: 'slack_post_in_thread',
        description: 'Post a message in the current Slack thread',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        execute: async (input: unknown) => {
          const parsed = z.object({ text: z.string().min(1) }).parse(input ?? {});
          const record = this.workspaceStore.get();
          if (!record || record.status !== 'connected') throw new Error('No Slack workspace connected');
          const metadata = buildOutboundMetadata(
            resolveSlackOutboundIntent(context.identity.channelId),
            {
              settings: getSettings(),
              workspace: {
                authedUserId: record.authedUserId,
                teamId: record.teamId,
              },
              threadScope: context.identity.threadTs,
              log: this.log,
            },
          );
          return this.postMessage(
            record,
            context.identity.channelId,
            context.identity.threadTs,
            parsed.text,
            metadata,
          );
        },
      },
      {
        // NOTE: tool descriptors here are placeholders per predecessor plan §13 (Stage 6).
        // Agent-runtime execution wiring for adapter context tools is deferred to a future
        // stage. Until then, slack_get_thread_history is exposed in tests but not callable
        // by the agent. Mirror the same gap in browserTab and officeDocument adapters.
        name: 'slack_get_thread_history',
        description: 'Get the most recent messages in the Slack thread this conversation is bound to. Returns sanitized message text + sender + timestamp; no avatars, no files.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', minimum: 1, maximum: 50, default: 20 } },
        },
        execute: async (input: unknown) => {
          const parsed = z.object({ limit: z.number().int().min(1).max(50).default(20) }).parse(input ?? {});
          return this.getThreadHistory(context.identity.channelId, context.identity.threadTs, undefined, parsed.limit);
        },
      },
    ];
  }

  async getThreadHistory(
    channelId: string,
    threadTs: string,
    signal?: AbortSignal,
    limit = SLACK_THREAD_HISTORY_PREFETCH_LIMIT,
  ): Promise<SlackThreadHistoryReply[]> {
    const record = this.workspaceStore.get();
    if (!record || record.status !== 'connected') throw new Error('No Slack workspace connected');
    const cappedLimit = Math.max(1, Math.min(limit, SLACK_THREAD_HISTORY_PREFETCH_LIMIT));

    const url = slackApiUrl('/api/conversations.replies');
    url.searchParams.set('channel', channelId);
    url.searchParams.set('ts', threadTs);
    url.searchParams.set('limit', String(cappedLimit));

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${record.botToken}` },
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new SlackThreadHistoryError('network', 'Slack conversations.replies network error', { cause: err });
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new SlackThreadHistoryError('401', 'Slack conversations.replies HTTP 401', { status: response.status });
      }
      if (response.status === 403) {
        throw new SlackThreadHistoryError('403', 'Slack conversations.replies HTTP 403', { status: response.status });
      }
      if (response.status === 404) {
        throw new SlackThreadHistoryError('missing', 'Slack conversations.replies HTTP 404', { status: response.status });
      }
      if (response.status === 429) {
        throw new SlackThreadHistoryError('429', 'Slack conversations.replies HTTP 429', {
          status: response.status,
          retryAfter: response.headers.get('retry-after') ?? undefined,
        });
      }
      if (response.status >= 500) {
        throw new SlackThreadHistoryError('5xx', `Slack conversations.replies HTTP ${response.status}`, { status: response.status });
      }
      throw new SlackThreadHistoryError('unknown', `Slack conversations.replies HTTP ${response.status}`, { status: response.status });
    }

    let parsed: z.infer<typeof SlackConversationsRepliesSchema>;
    try {
      parsed = SlackConversationsRepliesSchema.parse(await response.json());
    } catch (err) {
      throw new SlackThreadHistoryError('malformed', 'Slack conversations.replies returned malformed JSON', { cause: err });
    }
    if (!parsed.ok) {
      const errorCode = parsed.error ?? 'unknown';
      if (errorCode === 'token_revoked' || errorCode === 'tokens_revoked') {
        throw new SlackThreadHistoryError('token_revoked', `Slack conversations.replies error: ${errorCode}`);
      }
      if (errorCode === 'channel_not_found' || errorCode === 'not_in_channel' || errorCode === 'thread_not_found' || errorCode === 'message_not_found') {
        throw new SlackThreadHistoryError('missing', `Slack conversations.replies error: ${errorCode}`);
      }
      if (errorCode === 'rate_limited') {
        throw new SlackThreadHistoryError('429', 'Slack conversations.replies error: rate_limited', {
          retryAfter: response.headers.get('retry-after') ?? undefined,
        });
      }
      if (isSlackAuthErrorCode(errorCode)) {
        throw new SlackThreadHistoryError('401', `Slack conversations.replies auth error: ${errorCode}`);
      }
      throw new SlackThreadHistoryError('unknown', `Slack conversations.replies error: ${errorCode}`);
    }

    return (parsed.messages ?? []).slice(-cappedLimit).map((message) => ({
      ts: message.ts ?? '',
      author: deriveThreadHistoryReplyAuthor(message),
      text: message.text ?? '',
    }));
  }

  async resumePendingDeliveries(): Promise<void> {
    const pendingDeliveries = (this.store.get('pendingDeliveries') as Record<string, PendingDelivery>) || {};
    await Promise.all(Object.values(pendingDeliveries).map(async (delivery) => {
      if (delivery.cancelledAt) {
        this.removePendingDelivery(delivery.id);
        return;
      }
      this.scheduleRetry(delivery);
    }));
  }

  cancelByTeamId(teamId: string): void {
    for (const [deliveryId, scheduled] of this.scheduledRetries.entries()) {
      if (scheduled.teamId !== teamId) continue;
      clearTimeout(scheduled.timer);
      this.scheduledRetries.delete(deliveryId);
    }

    const pendingDeliveries = (this.store.get('pendingDeliveries') as Record<string, PendingDelivery>) || {};
    let cancelledCount = 0;
    const nextDeliveries: Record<string, PendingDelivery> = {};
    const broadcasts: Array<{
      deliveryId: string;
      conversationId: string;
    }> = [];
    const cancelledAt = Date.now();

    for (const delivery of Object.values(pendingDeliveries)) {
      if (delivery.context.identity.teamId !== teamId) {
        nextDeliveries[delivery.id] = delivery;
        continue;
      }

      cancelledCount += 1;
      const cancelledDelivery = { ...delivery, cancelledAt };
      broadcasts.push({
        deliveryId: cancelledDelivery.id,
        conversationId: cancelledDelivery.conversationId,
      });
      this.chunksSentByDeliveryId.delete(cancelledDelivery.id);
    }

    if (cancelledCount > 0) {
      this.store.set('pendingDeliveries', nextDeliveries);
      for (const cancelledDelivery of broadcasts) {
        try {
          this.broadcast?.sendToAllWindows('external-delivery:failed', {
            deliveryId: cancelledDelivery.deliveryId,
            conversationId: cancelledDelivery.conversationId,
            teamId,
            reason: 'workspace_disconnected',
            permanent: true,
          });
        } catch (err) {
          this.log.warn({ err: redactSlackError(err), deliveryId: cancelledDelivery.deliveryId, teamIdHash: hashTeamId(teamId) }, 'Slack pending-delivery cancellation broadcast failed');
        }
      }
      this.log.info({ teamIdHash: hashTeamId(teamId), cancelledCount }, 'Cancelled pending Slack deliveries for disconnected workspace');
    }
  }

  private scheduleRetry(delivery: PendingDelivery): void {
    if (delivery.attempt >= RETRY_DELAYS_MS.length) {
      this.log.error({
        event: 'slack_delivery_failed_permanent',
        teamIdHash: hashTeamId(delivery.context.identity.teamId),
        conversationId: delivery.conversationId,
        attempt: delivery.attempt,
        reason: 'retries_exhausted',
        userActionable: false,
      }, 'slack_delivery_failed_permanent');
      this.log.warn({ id: delivery.id }, 'Exhausted retries for Slack delivery');
      try {
        this.broadcast?.sendToAllWindows('external-delivery:failed', {
          deliveryId: delivery.id,
          conversationId: delivery.conversationId,
          teamId: delivery.context.identity.teamId,
          reason: 'retries_exhausted',
          permanent: true,
        });
      } catch (err) {
        this.log.warn({
          err: redactSlackError(err),
          deliveryId: delivery.id,
          teamIdHash: hashTeamId(delivery.context.identity.teamId),
        }, 'Slack retries-exhausted broadcast failed');
      }
      this.removePendingDelivery(delivery.id);
      return;
    }

    const delay = RETRY_DELAYS_MS[delivery.attempt];
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    const finalDelay = Math.max(0, delay + jitter);

    delivery.attempt += 1;
    this.savePendingDelivery(delivery);

    const existing = this.scheduledRetries.get(delivery.id);
    if (existing) {
      clearTimeout(existing.timer);
      this.scheduledRetries.delete(delivery.id);
    }

    const timer = setTimeout(() => {
      this.scheduledRetries.delete(delivery.id);
      fireAndForget(this.attemptDelivery(delivery), 'slackThreadAdapter.retryAttemptDelivery');
    }, finalDelay);
    this.scheduledRetries.set(delivery.id, { timer, teamId: delivery.context.identity.teamId });
  }

  private savePendingDelivery(delivery: PendingDelivery): void {
    const pendingDeliveries = (this.store.get('pendingDeliveries') as Record<string, PendingDelivery>) || {};
    pendingDeliveries[delivery.id] = delivery;
    this.store.set('pendingDeliveries', pendingDeliveries);
  }

  private removePendingDelivery(id: string): void {
    const pendingDeliveries = (this.store.get('pendingDeliveries') as Record<string, PendingDelivery>) || {};
    delete pendingDeliveries[id];
    this.store.set('pendingDeliveries', pendingDeliveries);
    this.chunksSentByDeliveryId.delete(id);
    const scheduled = this.scheduledRetries.get(id);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduledRetries.delete(id);
    }
  }

  private safeBroadcastWorkspaceChanged(record: SlackWorkspaceRecordLike, occurredAt: number): void {
    const parsed = SlackWorkspaceChangedSchema.safeParse({
      teamId: record.teamId,
      teamName: record.teamName,
      status: 'needs_reconnect',
      occurredAt,
    });
    if (!parsed.success) {
      this.log.warn({ error: parsed.error.flatten(), teamIdHash: hashTeamId(record.teamId) }, 'Slack workspace changed broadcast payload failed schema validation');
      return;
    }
    try {
      this.broadcast?.sendToAllWindows(SLACK_WORKSPACE_CHANGED_CHANNEL, parsed.data);
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(record.teamId) }, 'Slack workspace changed broadcast failed');
    }
  }

  private safeBroadcastWorkspaceDisconnected(teamId: string, reason: 'tokens_revoked' | 'invalid_auth', occurredAt: number): void {
    const parsed = SlackWorkspaceDisconnectedSchema.safeParse({ teamId, reason, occurredAt });
    if (!parsed.success) {
      this.log.warn({ error: parsed.error.flatten(), teamIdHash: hashTeamId(teamId), reason }, 'Slack workspace disconnected broadcast payload failed schema validation');
      return;
    }
    try {
      this.broadcast?.sendToAllWindows(SLACK_WORKSPACE_DISCONNECTED_CHANNEL, parsed.data);
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(teamId), reason }, 'Slack workspace disconnected broadcast failed');
    }
  }

  private async postMessage(
    record: SlackWorkspaceRecordLike,
    channel: string,
    threadTs: string,
    text: string,
    metadata: SlackMessageMetadata | null,
  ): Promise<DeliveryResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(slackApiUrlString('/api/chat.postMessage'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${record.botToken}`,
        },
        body: JSON.stringify({
          channel,
          thread_ts: threadTs,
          text,
          unfurl_links: false,
          unfurl_media: false,
          ...(metadata ? { metadata } : {}),
        }),
      });
    } catch (err) {
      return { status: 'transient-failure', reason: err instanceof Error ? err.message : 'Slack chat.postMessage network error', retryAfterSec: 5 };
    }

    if (!response.ok) {
      return { status: 'transient-failure', reason: `Slack chat.postMessage HTTP ${response.status}`, retryAfterSec: 1 };
    }

    let parsed: z.infer<typeof SlackApiOkSchema> | z.infer<typeof SlackApiErrorSchema>;
    try {
      parsed = z.union([SlackApiOkSchema, SlackApiErrorSchema]).parse(await response.json());
    } catch (err) {
      this.log.warn({ err: redactSlackError(err), teamIdHash: hashTeamId(record.teamId) }, 'Slack chat.postMessage returned malformed JSON');
      return { status: 'transient-failure', reason: 'Slack chat.postMessage returned malformed JSON', retryAfterSec: 5 };
    }

    if (parsed.ok === true) return { status: 'delivered' };

    const errorCode = parsed.error ?? 'unknown';
    if (isSlackAuthErrorCode(errorCode) || errorCode === 'tokens_revoked') {
      const reason = errorCode === 'token_revoked' || errorCode === 'tokens_revoked' ? 'tokens_revoked' : 'invalid_auth';
      const occurredAt = Date.now();
      this.workspaceStore.updateStatus('needs_reconnect', {
        code: errorCode,
        message: `Slack chat.postMessage: ${errorCode}`,
        occurredAt,
      });
      this.safeBroadcastWorkspaceChanged(record, occurredAt);
      this.safeBroadcastWorkspaceDisconnected(record.teamId, reason, occurredAt);
      return { status: 'permanent-failure', reason: `Slack auth error: ${errorCode}`, userActionable: true };
    }

    if (errorCode === 'channel_not_found' || errorCode === 'not_in_channel' || errorCode === 'is_archived') {
      return { status: 'permanent-failure', reason: `Slack delivery error: ${errorCode}`, userActionable: false };
    }

    if (errorCode === 'rate_limited') {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
      return deliveryRetryAfter(Number.isFinite(retryAfter) ? retryAfter : 1);
    }

    return { status: 'transient-failure', reason: `Slack chat.postMessage error: ${errorCode}`, retryAfterSec: 5 };
  }

  private async attemptDelivery(delivery: PendingDelivery): Promise<DeliveryResult> {
    const pendingDeliveries = (this.store.get('pendingDeliveries') as Record<string, PendingDelivery>) || {};
    const currentDelivery = pendingDeliveries[delivery.id];
    if (!currentDelivery || currentDelivery.cancelledAt) {
      this.log.info({ deliveryId: delivery.id, teamIdHash: hashTeamId(delivery.context.identity.teamId) }, 'Slack pending delivery no longer exists; skipping retry');
      return { status: 'permanent-failure', reason: 'Slack delivery is no longer pending', userActionable: false };
    }

    const result = await this.deliverNow(currentDelivery.context, currentDelivery.message, currentDelivery);
    if (result.status === 'delivered' || result.status === 'permanent-failure') {
      this.removePendingDelivery(currentDelivery.id);
      return result;
    }
    this.scheduleRetry(currentDelivery);
    return result;
  }

  private async deliverNow(context: SlackThreadContext, message: AgentResponse, delivery?: PendingDelivery): Promise<DeliveryResult> {
    const deliveryStartTime = Date.now();
    const currentAttempt = deliveryAttemptNumber(delivery);
    const logCompleted = (outcome: 'success' | 'failed_permanent' | 'failed_transient'): void => {
      this.log.info({
        event: 'slack_delivery_completed',
        teamIdHash: hashTeamId(context.identity.teamId),
        conversationId: delivery?.conversationId ?? '',
        outcome,
        attempts: currentAttempt,
        durationMs: Math.max(1, Date.now() - deliveryStartTime),
      }, 'slack_delivery_completed');
    };
    const record = this.workspaceStore.get();
    if (!record || record.status !== 'connected') {
      this.log.error({
        event: 'slack_delivery_failed_permanent',
        teamIdHash: hashTeamId(context.identity.teamId),
        conversationId: delivery?.conversationId ?? '',
        attempt: currentAttempt,
        reason: 'workspace_not_connected',
        userActionable: true,
      }, 'slack_delivery_failed_permanent');
      logCompleted('failed_permanent');
      return { status: 'permanent-failure', reason: 'Slack workspace not connected', userActionable: true };
    }

    const text = extractAgentResponseText(message);
    if (!text.trim()) {
      this.log.error({
        event: 'slack_delivery_failed_permanent',
        teamIdHash: hashTeamId(context.identity.teamId),
        conversationId: delivery?.conversationId ?? '',
        attempt: currentAttempt,
        reason: 'agent_response_empty',
        userActionable: false,
      }, 'slack_delivery_failed_permanent');
      logCompleted('failed_permanent');
      return { status: 'permanent-failure', reason: 'Agent response is empty', userActionable: false };
    }

    const chunks = splitIntoChunks(text, SLACK_REPLY_CHUNK_SIZE);
    const willTruncate = chunks.length > SLACK_MAX_REPLY_CHUNKS;
    const sendChunks = willTruncate ? chunks.slice(0, SLACK_MAX_REPLY_CHUNKS) : chunks;
    if (willTruncate && sendChunks.length > 0) {
      sendChunks[sendChunks.length - 1] = `${sendChunks[sendChunks.length - 1]}\n\n_Reply truncated — see Rebel app for the full response._`;
    }

    // Slack has no idempotency key for chat.postMessage. We persist a per-delivery
    // chunk cursor so transient retry after chunk N resumes at N+1 instead of
    // reposting chunks already visible in Slack. If a permanent failure happens
    // mid-batch, posted chunks remain in Slack and we log for manual review.
    const startIndex = delivery
      ? Math.min(delivery.chunksSent ?? this.chunksSentByDeliveryId.get(delivery.id) ?? 0, sendChunks.length)
      : 0;
    const outboundMetadata = buildOutboundMetadata(
      resolveSlackOutboundIntent(context.identity.channelId),
      {
        settings: getSettings(),
        workspace: {
          authedUserId: record.authedUserId,
          teamId: record.teamId,
        },
        threadScope: context.identity.threadTs,
        log: this.log,
      },
    );

    for (let index = startIndex; index < sendChunks.length; index += 1) {
      const chunk = sendChunks[index];
      const chunkStartTime = Date.now();
      this.log.debug({
        event: 'slack_delivery_attempted',
        teamIdHash: hashTeamId(context.identity.teamId),
        conversationId: delivery?.conversationId ?? '',
        attempt: currentAttempt,
        chunksSent: index,
        chunkChars: chunk.length,
      }, 'slack_delivery_attempted');
      const result = await this.postMessage(
        record,
        context.identity.channelId,
        context.identity.threadTs,
        chunk,
        outboundMetadata,
      );
      if (result.status !== 'delivered') {
        if (delivery && index > 0 && result.status === 'permanent-failure') {
          this.log.warn(
            {
              deliveryId: delivery.id,
              conversationId: delivery.conversationId,
              chunksPosted: index,
              totalChunks: sendChunks.length,
              reason: result.reason,
            },
            `partial delivery: ${index} of ${sendChunks.length} chunks posted; manual review may be required`,
          );
        }
        if (result.status === 'permanent-failure') {
          const reason = deliveryFailureReasonCode(result.reason);
          this.log.error({
            event: 'slack_delivery_failed_permanent',
            teamIdHash: hashTeamId(context.identity.teamId),
            conversationId: delivery?.conversationId ?? '',
            attempt: currentAttempt,
            reason,
            userActionable: result.userActionable || isUserActionable(reason),
          }, 'slack_delivery_failed_permanent');
        }
        logCompleted(result.status === 'permanent-failure' ? 'failed_permanent' : 'failed_transient');
        return result;
      }
      this.log.info({
        event: 'slack_delivery_succeeded',
        teamIdHash: hashTeamId(context.identity.teamId),
        conversationId: delivery?.conversationId ?? '',
        attempt: currentAttempt,
        durationMs: Math.max(1, Date.now() - chunkStartTime),
        chunkBytes: Buffer.byteLength(chunk, 'utf8'),
      }, 'slack_delivery_succeeded');
      if (delivery) {
        delivery.chunksSent = index + 1;
        this.chunksSentByDeliveryId.set(delivery.id, delivery.chunksSent);
        this.savePendingDelivery(delivery);
      }
    }

    this.workspaceStore.updateLastSeen();
    logCompleted('success');
    return { status: 'delivered' };
  }

  async deliverResponse(args: { context: SlackThreadContext; conversationId: string; message: AgentResponse }): Promise<DeliveryResult> {
    const deliveryId = crypto.randomUUID();
    const delivery: PendingDelivery = {
      id: deliveryId,
      context: args.context,
      conversationId: args.conversationId,
      message: args.message,
      attempt: 0,
      addedAt: Date.now(),
    };

    this.savePendingDelivery(delivery);
    return this.attemptDelivery(delivery);
  }
}

export const __test = {
  splitIntoChunks,
  extractAgentResponseText,
  isSlackThreadContext,
  buildSlackPermalink,
};
