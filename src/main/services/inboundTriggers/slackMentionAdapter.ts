/**
 * Slack @-Mention Adapter
 *
 * Polls Slack's `search.messages` API for @-mentions of the bot user and
 * converts them into `InboundTrigger` objects for the framework to process.
 *
 * Key design decisions:
 * - Uses raw `fetch` (not @slack/web-api) to avoid adding a main-process dependency
 * - Uses user token for search (requires `search:read` scope)
 * - Uses bot token for acknowledgment replies and identity resolution
 * - Oldest-first processing to prevent mention loss
 * - Best-effort acknowledgment ("On it!") via direct `chat.postMessage`
 */

import { createScopedLogger, type Logger } from '@core/logger';
import { isSlackAuthErrorCode } from '@core/services/inboundTriggers/slackAuthErrorCodes';
import { getSettings } from '@core/services/settingsStore/index';
import { extractSlackThreadIdentity } from '@core/services/externalConversation/slackThreadIdentity';
import type { SlackThreadContext } from '@core/services/externalConversation/externalContext';
import { buildOutboundMetadata } from '@core/services/externalConversation/slackOutboundMetadata';
import {
  createPublicChannelSafetyHookForSlack,
  wrapInboundSlackMessageForAgent,
  type SlackPromptSafetyContext,
} from '@core/services/inboundTriggers/slackPromptSafety';
import {
  getSlackWorkspaces,
  getSlackWorkspaceDetails,
  refreshSlackTokens,
} from '../slackAuthService';
import type { AppSettings } from '@shared/types';
import type { SlackPollGate } from '@shared/utils/slackPollGate';
import { getSlackApiBaseUrl } from '@shared/utils/slackApiBaseUrl';
import { hashTeamId } from '@shared/utils/teamIdHash';
import type { InboundTrigger, InboundTriggerAdapter, InboundTriggerSafetyHook } from './types';
import { createPublicBroadcastSafetyHook } from './publicBroadcastSafetyHook';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';

const log = createScopedLogger({ service: 'slackMentionAdapter' });
const SLACK_POLLING_INFLIGHT_LRU_CAPACITY = 500;
const SLACK_POLLING_INFLIGHT_LRU_TTL_MS = 60 * 60 * 1000;
const slackPollingInflightEventIds = new Map<string, number>();

// ---------------------------------------------------------------------------
// Token resilience — auth error detection and per-workspace reauth tracking
// ---------------------------------------------------------------------------

/**
 * Track workspaces where token refresh has permanently failed.
 * Maps teamId → epoch-ms when the failure was flagged.
 * Prevents repeated refresh attempts on every 60-second poll cycle.
 */
const workspaceReauthState = new Map<string, number>();

/** After a permanent auth failure, wait before retrying (in case user re-authenticates). */
const REAUTH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Slack API response types (minimal, matching the shapes we consume)
// ---------------------------------------------------------------------------

interface SlackSearchMatch {
  ts: string;
  text: string;
  channel: { id: string; name: string };
  user: string;
  username?: string;
  thread_ts?: string;
  permalink?: string;
}

interface SlackSearchResponse {
  ok: boolean;
  error?: string;
  messages?: {
    matches: SlackSearchMatch[];
  };
}

interface SlackPostMessageResponse {
  ok: boolean;
  error?: string;
}

interface SlackConversationsInfoResponse {
  ok: boolean;
  error?: string;
  channel?: {
    name?: string;
    is_private?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
    is_group?: boolean;
  };
}

/** Discriminated result from searchMentions to distinguish auth errors from other failures. */
interface SearchMentionsResult {
  matches: SlackSearchMatch[] | null;
  authError: boolean;
}

interface SlackMentionAdapterOptions {
  slackPollGate?: SlackPollGate;
  log?: Logger;
  markPolledNow?: (sourceId: string, timestamp: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine if a timestamp string looks like a millisecond epoch (>13 digits)
 * vs a Slack ts format ("1234567890.123456").
 * The framework provides millisecond epoch strings on first-enable; subsequent
 * polls use Slack's native ts format.
 */
function toSlackTs(ts: string): string {
  // Slack ts format contains a dot: "1234567890.123456"
  if (ts.includes('.')) {
    return ts;
  }
  // Millisecond epoch: 13+ digit numeric string
  const num = Number(ts);
  if (!Number.isNaN(num) && ts.length >= 13) {
    return String(num / 1000);
  }
  // Fallback: return as-is
  return ts;
}

function slackApiUrl(path: string): string {
  return new URL(path, getSlackApiBaseUrl()).toString();
}

/**
 * Compare two Slack timestamps. Returns true if `a` > `b`.
 * Slack timestamps are string-formatted floats: "1234567890.123456"
 */
function slackTsGreaterThan(a: string, b: string): boolean {
  return Number(a) > Number(b);
}

/**
 * Build a unique message ID for dedup: `${sourceId}:${channelId}:${ts}`
 */
function buildMessageId(sourceId: string, channelId: string, ts: string): string {
  return `${sourceId}:${channelId}:${ts}`;
}

function buildInflightEventKey(teamId: string, eventId: string): string {
  return `${teamId}:${eventId}`;
}

function resolveSlackAcknowledgmentIntent(channelId: string): 'thread_open' | 'dm_reply' {
  const normalized = channelId.trim().toUpperCase();
  return normalized.startsWith('D') ? 'dm_reply' : 'thread_open';
}

function pruneInflightEventIds(now = Date.now()): void {
  for (const [key, insertedAt] of slackPollingInflightEventIds) {
    if (now - insertedAt > SLACK_POLLING_INFLIGHT_LRU_TTL_MS) {
      slackPollingInflightEventIds.delete(key);
    }
  }

  while (slackPollingInflightEventIds.size > SLACK_POLLING_INFLIGHT_LRU_CAPACITY) {
    const oldestKey = slackPollingInflightEventIds.keys().next().value;
    if (!oldestKey) break;
    slackPollingInflightEventIds.delete(oldestKey);
  }
}

function hasInflightEvent(teamId: string, eventId: string): boolean {
  pruneInflightEventIds();
  return slackPollingInflightEventIds.has(buildInflightEventKey(teamId, eventId));
}

function rememberInflightEvent(teamId: string, eventId: string): void {
  slackPollingInflightEventIds.delete(buildInflightEventKey(teamId, eventId));
  slackPollingInflightEventIds.set(buildInflightEventKey(teamId, eventId), Date.now());
  pruneInflightEventIds();
}

function forgetInflightEvent(teamId: string, eventId: string): void {
  slackPollingInflightEventIds.delete(buildInflightEventKey(teamId, eventId));
}

function buildSlackThreadContext(args: {
  sourceId: string;
  match: SlackSearchMatch;
  teamName?: string | null;
}): SlackThreadContext | null {
  const identity = extractSlackThreadIdentity({
    team: args.sourceId,
    channel: args.match.channel,
    ts: args.match.ts,
    thread_ts: args.match.thread_ts,
  });
  if (!identity) {
    return null;
  }

  return {
    kind: 'slack-thread',
    identity,
    metadata: {
      userId: args.match.user,
      userName: args.match.username ?? null,
      userDisplayName: args.match.username ?? null,
      channelName: args.match.channel.name,
      teamName: args.teamName ?? null,
      permalink: args.match.permalink ?? null,
    },
  };
}

/**
 * Derive an `after:YYYY-MM-DD` date string from a Slack timestamp.
 * Used to narrow search results and avoid fetching ancient history.
 */
function slackTsToAfterDate(slackTs: string): string {
  const epochSeconds = Number(slackTs.split('.')[0]);
  // Subtract 1 day to account for timezone differences and search index lag
  const date = new Date((epochSeconds - 86400) * 1000);
  return date.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Channel name cache — used by safety prompt handlers to enrich blocked
// action context with human-readable channel names.
// ---------------------------------------------------------------------------

const slackChannelNameCache = new Map<string, string>();
const CHANNEL_CACHE_MAX_SIZE = 500;

/**
 * Look up a cached Slack channel name by ID.
 * Populated during poll() from search results and checkIsPublicChannel().
 */
export function getSlackChannelNameFromCache(channelId: string): string | undefined {
  return slackChannelNameCache.get(channelId);
}

function cacheChannelName(channelId: string, name: string): void {
  if (slackChannelNameCache.size >= CHANNEL_CACHE_MAX_SIZE) {
    const firstKey = slackChannelNameCache.keys().next().value;
    if (firstKey) slackChannelNameCache.delete(firstKey);
  }
  slackChannelNameCache.set(channelId, name);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SlackMentionAdapter implements InboundTriggerAdapter {
  readonly id = 'slack-mention';
  readonly displayName = 'Slack @-mentions';
  private readonly slackPollGate?: SlackPollGate;
  private readonly instanceLog: Logger;
  private readonly markPolledNowCallback?: (sourceId: string, timestamp: string) => void;
  private readonly pauseStateByTeamId = new Map<string, boolean>();

  constructor(options: SlackMentionAdapterOptions = {}) {
    this.slackPollGate = options.slackPollGate;
    this.instanceLog = options.log ?? log;
    this.markPolledNowCallback = options.markPolledNow;
  }

  // -----------------------------------------------------------------------
  // InboundTriggerAdapter interface
  // -----------------------------------------------------------------------

  async isConfigured(): Promise<boolean> {
    const workspaces = await getSlackWorkspaces() ?? [];
    for (const ws of workspaces) {
      const details = await getSlackWorkspaceDetails(ws.teamId);
      if (details?.userToken && details.botUserId) {
        return true;
      }
    }
    return false;
  }

  async checkPrerequisites(): Promise<{ ready: boolean; reason: string | null }> {
    const workspaces = (await getSlackWorkspaces()) ?? [];
    if (workspaces.length === 0) {
      return { ready: false, reason: 'No Slack workspace connected.' };
    }
    for (const ws of workspaces) {
      const details = await getSlackWorkspaceDetails(ws.teamId);
      if (!details?.userToken) {
        return { ready: false, reason: `Workspace "${ws.teamName}" is missing search permissions. Disconnect and reconnect Slack to grant them.` };
      }
      if (!details.authedUserId) {
        return { ready: false, reason: 'Slack connection needs to be refreshed. Disconnect and reconnect Slack to enable this feature.' };
      }
    }
    return { ready: true, reason: null };
  }

  async getSourceIds(): Promise<string[]> {
    const workspaces = (await getSlackWorkspaces()) ?? [];
    const sourceIds: string[] = [];
    for (const ws of workspaces) {
      const details = await getSlackWorkspaceDetails(ws.teamId);
      // Only include workspaces that have a user token (required for search)
      if (details?.userToken && details.botUserId) {
        sourceIds.push(ws.teamId);
      }
    }
    return sourceIds;
  }

  async poll(
    sourceId: string,
    lastSeenTs: string | null,
    processedIds: Set<string>
  ): Promise<InboundTrigger | null> {
    // Skip workspaces flagged as needing re-authentication (cooldown prevents spam)
    const reauthFlaggedAt = workspaceReauthState.get(sourceId);
    if (reauthFlaggedAt != null) {
      if (Date.now() - reauthFlaggedAt < REAUTH_COOLDOWN_MS) {
        log.debug({ sourceId }, 'Skipping poll — workspace needs re-authentication (cooldown active)');
        return null;
      }
      // Cooldown elapsed — clear flag and retry (tokens may have been refreshed externally)
      log.info({ sourceId }, 'Reauth cooldown elapsed, retrying poll');
      workspaceReauthState.delete(sourceId);
    }

    const gateResult = this.slackPollGate?.shouldPause(sourceId);
    if (gateResult?.paused) {
      const wasPaused = this.pauseStateByTeamId.get(sourceId) === true;
      if (!wasPaused) {
        this.markPolledNow(sourceId);
      }
      this.logPauseTransitionOnce(sourceId, gateResult.reason);
      return null;
    }
    this.logResumeTransitionOnce(sourceId);

    let details = await getSlackWorkspaceDetails(sourceId);
    if (!details) {
      log.warn({ sourceId }, 'Workspace details not found — skipping');
      return null;
    }

    if (!details.userToken) {
      log.debug({ sourceId }, 'No user token for workspace — skipping (search:read requires user token)');
      return null;
    }

    if (!details.botUserId) {
      log.error({ sourceId }, 'No botUserId for workspace — cannot search for mentions');
      return null;
    }

    // Convert lastSeenTs to Slack ts format if it's a millisecond epoch
    const slackLastSeenTs = lastSeenTs ? toSlackTs(lastSeenTs) : null;

    // Build date filter to narrow search window (avoids fetching ancient history)
    const afterDate = slackLastSeenTs ? slackTsToAfterDate(slackLastSeenTs) : undefined;

    // Call Slack search.messages API (desc order, then filter + sort client-side)
    // Search for `<@BOT_USER_ID>` which is how Slack encodes @-mentions in message text
    let searchResult = await this.searchMentions(details.userToken, details.botUserId, afterDate, details.authedUserId);

    // On auth error, attempt token refresh and retry once
    if (searchResult.authError) {
      log.warn({ sourceId, error: 'auth_error' }, 'Token expired for workspace, attempting refresh...');
      const refreshed = await refreshSlackTokens(sourceId);
      if (refreshed) {
        log.info({ sourceId }, 'Token refreshed successfully, retrying search');
        // Re-read workspace details with refreshed tokens
        details = (await getSlackWorkspaceDetails(sourceId)) ?? details;
        if (details?.userToken) {
          searchResult = await this.searchMentions(details.userToken, details.botUserId, afterDate, details.authedUserId);
        }
      }
      // If refresh failed or retry still has auth error, pause polling for this workspace
      if (!refreshed || searchResult.authError) {
        log.error({ sourceId }, 'Token refresh failed — Slack mentions paused until reconnection or cooldown');
        workspaceReauthState.set(sourceId, Date.now());
        return null;
      }
    }

    const matches = searchResult.matches;
    if (!matches) {
      return null; // Non-auth error already logged
    }

    // Filter and find the oldest unprocessed mention
    const filtered = matches.filter((match) => {
      // Filter: must be after lastSeenTs
      if (slackLastSeenTs && !slackTsGreaterThan(match.ts, slackLastSeenTs)) {
        return false;
      }
      // Filter: ignore self-mentions (bot mentioning itself)
      if (match.user === details.botUserId) {
        return false;
      }
      // Filter: only process mentions from the authenticated user (defense-in-depth)
      if (details.authedUserId && match.user !== details.authedUserId) {
        return false;
      }
      // Filter: skip already-processed messages
      const messageId = buildMessageId(sourceId, match.channel.id, match.ts);
      if (processedIds.has(messageId)) {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      return null;
    }

    // Sort ascending (oldest first) — API returns sorted, but be defensive
    filtered.sort((a, b) => Number(a.ts) - Number(b.ts));

    const oldest = filtered[0];
    const messageId = buildMessageId(sourceId, oldest.channel.id, oldest.ts);
    const eventId = oldest.ts;
    const teamIdHash = hashTeamId(sourceId);

    if (this.markPolledNowCallback && hasInflightEvent(sourceId, eventId)) {
      this.instanceLog.info(
        { eventId, teamIdHash, reason: 'duplicate-in-process' },
        'slack_polling_inflight_skip',
      );
      this.markSourceCursor(sourceId, oldest.ts);
      return null;
    }

    const workspacesForMetadata = (await getSlackWorkspaces()) ?? [];
    const workspace = workspacesForMetadata.find((ws) => ws.teamId === sourceId);
    const slackThreadCtx = buildSlackThreadContext({
      sourceId,
      match: oldest,
      teamName: workspace?.teamName ?? null,
    });
    if (!slackThreadCtx) {
      this.instanceLog.warn(
        { eventId, teamIdHash, reason: 'missing-team-channel-or-thread-ts' },
        'slack_thread_identity_extraction_failed',
      );
    } else if (this.markPolledNowCallback) {
      rememberInflightEvent(sourceId, eventId);
    }

    // Determine if channel is public (best-effort — defaults to assuming public for safety)
    const isPublicChannel = await this.checkIsPublicChannel(
      oldest.channel.id,
      details.botToken
    );

    // Cache channel name for downstream enrichment (safety prompt principle options)
    cacheChannelName(oldest.channel.id, oldest.channel.name);

    return {
      adapterId: this.id,
      sourceId,
      timestamp: oldest.ts,
      messageId,
      summary: `Slack mention in #${oldest.channel.name}`,
      context: {
        channelId: oldest.channel.id,
        channelName: oldest.channel.name,
        messageTs: oldest.ts,
        threadTs: oldest.thread_ts ?? oldest.ts,
        userId: oldest.user,
        ownerUserId: details.authedUserId,
        username: oldest.username,
        text: oldest.text,
        permalink: oldest.permalink,
        botToken: details.botToken,
        isPublicChannel,
      },
      ...(slackThreadCtx ? { externalContext: slackThreadCtx } : {}),
    };
  }

  buildPrompt(trigger: InboundTrigger): string {
    const ctx = trigger.context as {
      channelId: string;
      channelName: string;
      messageTs: string;
      threadTs: string;
      userId: string;
      username?: string;
      text: string;
      isPublicChannel: boolean;
    };

    const userLabel = ctx.username ?? ctx.userId;
    const safetyContext: SlackPromptSafetyContext = {
      rawText: ctx.text,
      channelType: ctx.isPublicChannel ? 'channel' : 'group',
      authorUserId: ctx.userId,
      isPublicChannel: ctx.isPublicChannel,
    };
    const lines: string[] = [
      `You were @-mentioned in Slack by ${userLabel} in #${ctx.channelName}.`,
    ];

    const publicChannelSafety = createPublicChannelSafetyHookForSlack(safetyContext);
    if (publicChannelSafety) {
      lines.push(
        '',
        ...publicChannelSafety.promptLines,
      );
    }

    lines.push(
      '',
      wrapInboundSlackMessageForAgent(safetyContext),
      '',
      'Instructions:',
      '1. Do what they asked',
      '2. Reply to the Slack thread with your results using reply_to_slack_thread',
      '',
      `Channel ID: ${ctx.channelId}`,
      `Thread TS: ${ctx.threadTs}`,
    );

    return lines.join('\n');
  }

  buildDisplayMessage(trigger: InboundTrigger): string {
    const ctx = trigger.context as {
      channelName: string;
      username?: string;
      userId: string;
      text: string;
    };
    const userLabel = ctx.username ?? ctx.userId;
    // Replace Slack user mention markup (<@U123> or <@U123|displayname>) with readable text
    const cleanText = ctx.text
      .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/gi, '@Rebel')
      .trim();
    return `**@${userLabel}** in **#${ctx.channelName}**:\n> ${cleanText}`;
  }

  async postAcknowledgment(trigger: InboundTrigger): Promise<void> {
    const ctx = trigger.context as {
      channelId: string;
      threadTs: string;
      botToken: string;
      ownerUserId?: string;
    };
    const metadata = buildOutboundMetadata(
      resolveSlackAcknowledgmentIntent(ctx.channelId),
      {
        settings: getSettings(),
        workspace: { authedUserId: ctx.ownerUserId },
        threadScope: ctx.threadTs,
        log,
      },
    );

    try {
      const response = await fetch(slackApiUrl('/api/chat.postMessage'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: ctx.channelId,
          text: 'On it!',
          thread_ts: ctx.threadTs,
          ...(metadata ? { metadata } : {}),
        }),
      });

      const data: SlackPostMessageResponse = await response.json();
      if (!data.ok) {
        log.warn(
          { error: data.error, channelId: ctx.channelId },
          'Acknowledgment chat.postMessage failed'
        );
      }
    } catch (err) {
      log.warn(
        { err, channelId: ctx.channelId },
        'Acknowledgment request failed'
      );
    }
  }

  getDefaultIntervalMs(): number {
    return 60_000; // 60 seconds
  }

  /**
   * Advance the desktop polling cursor without calling Slack search.messages.
   * When cloud becomes canonical, we prefer missing mentions from the paused
   * window (cloud handled them) over double-responding after polling resumes.
   */
  markPolledNow(sourceId: string): string {
    const timestamp = String(Date.now());
    this.markSourceCursor(sourceId, timestamp);
    return timestamp;
  }

  releaseDuplicateGuard(trigger: InboundTrigger): void {
    const ctx = trigger.externalContext;
    if (ctx?.kind !== 'slack-thread') return;
    forgetInflightEvent(ctx.identity.teamId, trigger.timestamp);
  }

  createSafetyHook(trigger: InboundTrigger, settings: AppSettings): InboundTriggerSafetyHook | null {
    const isPublicChannel = (trigger.context.isPublicChannel as boolean) ?? true;
    return createPublicBroadcastSafetyHook(
      isPublicChannel,
      settings,
      undefined, // turnLogger — not available at this point; hook uses its own scoped logger
      undefined, // sessionId — will be set by the executor
      undefined, // turnId
      resolveBtsModel(settings, 'safety')
    ) as InboundTriggerSafetyHook | null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Check if a channel is public by calling conversations.info.
   * Defaults to true (assume public) on failure for safety.
   */
  private async checkIsPublicChannel(
    channelId: string,
    botToken: string
  ): Promise<boolean> {
    try {
      const url = new URL('/api/conversations.info', getSlackApiBaseUrl());
      url.searchParams.set('channel', channelId);
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      const data: SlackConversationsInfoResponse = await response.json();
      if (!data.ok || !data.channel) {
        log.debug({ channelId, error: data.error }, 'conversations.info failed — assuming public');
        return true;
      }

      const ch = data.channel;
      // Cache the channel name if available (for safety prompt enrichment)
      if (ch.name) {
        cacheChannelName(channelId, ch.name);
      }
      // DMs and group DMs are private; is_private covers private channels
      if (ch.is_im || ch.is_mpim || ch.is_private || ch.is_group) {
        return false;
      }

      return true;
    } catch (err) {
      log.debug({ err, channelId }, 'conversations.info request failed — assuming public');
      return true;
    }
  }

  private markSourceCursor(sourceId: string, timestamp: string): void {
    this.markPolledNowCallback?.(sourceId, timestamp);
  }

  /**
   * Call Slack's search.messages API to find mentions of the bot.
   * Searches for `<@botUserId>` which is how Slack encodes @-mentions in message text.
   * Uses desc order to get most recent results first (then caller filters + sorts).
   * Includes `after:` date constraint when available to avoid fetching ancient history.
   * When authedUserId is provided, restricts results to mentions from that user only.
   *
   * Returns a discriminated result so the caller can distinguish auth errors
   * (recoverable via token refresh) from other failures.
   */
  private async searchMentions(
    userToken: string,
    botUserId: string,
    afterDate?: string,
    authedUserId?: string
  ): Promise<SearchMentionsResult> {
    try {
      let query = `<@${botUserId}>`;
      if (authedUserId) {
        query += ` from:<@${authedUserId}>`;
      }
      if (afterDate) {
        query += ` after:${afterDate}`;
      }

      const response = await fetch(slackApiUrl('/api/search.messages'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          query,
          sort: 'timestamp',
          sort_dir: 'desc',
          count: '20',
        }),
      });

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        log.warn(
          { retryAfterSeconds: retryAfter },
          'Slack search API rate limited (429) — will retry next cycle'
        );
        return { matches: null, authError: false };
      }

      const data: SlackSearchResponse = await response.json();

      if (!data.ok) {
        if (isSlackAuthErrorCode(data.error)) {
          log.error(
            { error: data.error },
            'Slack search failed due to authentication error'
          );
          return { matches: null, authError: true };
        }
        log.warn({ error: data.error }, 'Slack search.messages API error');
        return { matches: null, authError: false };
      }

      const matches = data.messages?.matches ?? [];
      log.info(
        { query, matchCount: matches.length },
        'Slack search.messages completed'
      );
      return { matches, authError: false };
    } catch (err) {
      log.warn({ err }, 'Slack search.messages network request failed');
      return { matches: null, authError: false };
    }
  }

  private logPauseTransitionOnce(teamId: string, reason: string | null): void {
    if (this.pauseStateByTeamId.get(teamId) === true) return;
    this.pauseStateByTeamId.set(teamId, true);
    this.instanceLog.info({ teamId, reason }, 'slack_poll_paused_cloud_canonical');
  }

  private logResumeTransitionOnce(teamId: string): void {
    const wasPaused = this.pauseStateByTeamId.get(teamId) === true;
    this.pauseStateByTeamId.set(teamId, false);
    if (!wasPaused) return;
    this.instanceLog.info({ teamId }, 'slack_poll_resumed_cloud_unreachable_or_disabled');
  }
}

export const slackMentionAdapterTestHooks = {
  clearSlackPollingInflightEventIds(): void {
    slackPollingInflightEventIds.clear();
  },
  hasInflightEvent,
};
