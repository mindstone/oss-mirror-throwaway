/**
 * Slack IPC Handlers
 *
 * Handles all slack:* IPC channels for Slack workspace management.
 * Uses OAuth 2.0 with deep link redirect via Cloudflare.
 * 
 * Architecture (B6): Per-workspace server instances
 * - Each authenticated workspace becomes its own MCP server (e.g., "Slack-mindstone")
 * - This enables multi-workspace support with proper account disambiguation
 */

import type { IpcMainInvokeEvent } from 'electron';
import { slackChannels } from '@shared/ipc/contracts';
import { registerHandler } from './utils/registerHandler';
import {
  getSlackWorkspaces,
  getSlackTokensForWorkspace,
  getSlackConfigDir,
  startSlackAuth,
  removeSlackWorkspace,
  cancelSlackAuth,
} from '../services/slackAuthService';
import { logger } from '@core/logger';
import {
  resolveOAuthCredentials,
  slackCredentialSource,
} from '../services/oauthCredentials';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { upsertMcpServerEntry, removeMcpServerEntry } from '../services/mcpConfigManager';
import { removeMcpServerWithCleanup } from '../services/mcpServerRemovalService';
import { buildSlackInstancePayload } from '../services/bundledMcpManager';
import { generateWorkspaceInstanceId } from '@shared/utils/mcpInstanceUtils';
import { getSlackApiBaseUrl } from '@shared/utils/slackApiBaseUrl';
import { resolveMcpConfigPath, reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral } from '../services/mcpService';
import { MCP_RESTART_CONTEXT_SLACK_CONNECT } from '@shared/utils/mcpRestartContexts';
import { getSettings } from '../settingsStore';
import { notifySlackWorkspaceConnected } from '../services/slackWorkspaceNotifier';

type SlackUserInfoResponse = {
  ok: boolean;
  error?: string;
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  };
};

type SlackUserListMember = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
  };
};

type SlackUserListResponse = {
  ok: boolean;
  error?: string;
  members?: SlackUserListMember[];
  response_metadata?: { next_cursor?: string };
};

type ResolvedSlackAuthor = {
  id: string;
  teamId: string;
  displayName?: string;
  realName?: string;
  handle?: string;
  email?: string;
};

const slackUserCache = new Map<string, {
  expiresAt: number;
  user: {
    id: string;
    displayName?: string;
    realName?: string;
    email?: string;
  } | null;
}>();

const SLACK_USER_CACHE_TTL_MS = 10 * 60 * 1000;
const SLACK_AUTHOR_RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;
const SLACK_USERS_LIST_PAGE_LIMIT = 200;
const SLACK_USERS_LIST_MAX_PAGES = 10;

const slackAuthorResolutionCache = new Map<string, { expiresAt: number; result: ResolvedSlackAuthor[] }>();

function slackApiUrl(path: string): URL {
  return new URL(path, getSlackApiBaseUrl());
}

function normalizeSlackUserId(userId: string): string | null {
  const trimmed = userId.trim();
  const mention = trimmed.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/i);
  const candidate = mention?.[1] ?? trimmed;
  return /^[UW][A-Z0-9]+$/i.test(candidate) ? candidate.toUpperCase() : null;
}

function normalizeAuthorQuery(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

function memberToAuthor(member: SlackUserListMember, teamId: string): ResolvedSlackAuthor | null {
  if (!member.id || !/^[UW][A-Z0-9]+$/.test(member.id)) return null;
  return {
    id: member.id.toUpperCase(),
    teamId,
    displayName: member.profile?.display_name?.trim() || undefined,
    realName: member.profile?.real_name?.trim() || member.real_name?.trim() || undefined,
    handle: member.name?.trim() || undefined,
    email: member.profile?.email?.trim() || undefined,
  };
}

function authorMatchesQuery(author: ResolvedSlackAuthor, normalizedQuery: string): boolean {
  if (author.id.toLowerCase() === normalizedQuery) return true;
  if (author.handle && author.handle.toLowerCase() === normalizedQuery) return true;
  if (author.displayName && author.displayName.toLowerCase() === normalizedQuery) return true;
  if (author.realName && author.realName.toLowerCase() === normalizedQuery) return true;
  if (author.email && author.email.toLowerCase() === normalizedQuery) return true;
  return false;
}

async function fetchSlackUsersListPage(
  token: string,
  cursor: string | undefined,
): Promise<SlackUserListResponse> {
  const url = slackApiUrl('/api/users.list');
  url.searchParams.set('limit', String(SLACK_USERS_LIST_PAGE_LIMIT));
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    return { ok: false, error: `http_${response.status}` };
  }
  return await response.json() as SlackUserListResponse;
}

type SlackWorkspaceMemberFetchResult =
  | { kind: 'ok'; members: ResolvedSlackAuthor[] }
  | { kind: 'auth_failed'; error: string }
  | { kind: 'no_workspace' }
  | { kind: 'transport_error'; error: string };

async function fetchSlackWorkspaceMembers(teamId: string): Promise<SlackWorkspaceMemberFetchResult> {
  const cacheKey = teamId;
  const cached = slackAuthorResolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { kind: 'ok', members: cached.result };
  }
  const tokens = await getSlackTokensForWorkspace(teamId);
  const candidateTokens = Array.from(new Set([
    tokens?.botToken,
    tokens?.userToken,
  ].filter((token): token is string => Boolean(token))));
  if (candidateTokens.length === 0) {
    return { kind: 'no_workspace' };
  }

  let lastError: string | null = null;
  let lastAuthError: string | null = null;
  for (const token of candidateTokens) {
    const collected: ResolvedSlackAuthor[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    let pageOk = true;
    while (pageCount < SLACK_USERS_LIST_MAX_PAGES) {
      const page = await fetchSlackUsersListPage(token, cursor);
      pageCount += 1;
      if (!page.ok) {
        lastError = page.error ?? 'users_list_failed';
        if (page.error && SLACK_AUTH_ERRORS.has(page.error)) {
          lastAuthError = page.error;
        }
        pageOk = false;
        break;
      }
      for (const member of page.members ?? []) {
        if (member.deleted) continue;
        const author = memberToAuthor(member, teamId);
        if (author) collected.push(author);
      }
      cursor = page.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    if (pageOk) {
      slackAuthorResolutionCache.set(cacheKey, {
        expiresAt: Date.now() + SLACK_AUTHOR_RESOLUTION_CACHE_TTL_MS,
        result: collected,
      });
      return { kind: 'ok', members: collected };
    }
  }

  logger.warn(
    { teamId, error: lastError ?? 'unknown' },
    'Slack workspace member fetch failed across all candidate tokens',
  );
  if (lastAuthError) {
    return { kind: 'auth_failed', error: lastAuthError };
  }
  return { kind: 'transport_error', error: lastError ?? 'unknown' };
}

type SlackUserResolutionFailure =
  | { kind: 'not_found' }
  | { kind: 'auth_failed'; error?: string }
  | { kind: 'deactivated' }
  | { kind: 'transport_error'; error?: string };

type SlackUserResolutionOutcome =
  | { kind: 'resolved'; user: { id: string; displayName?: string; realName?: string; email?: string } }
  | SlackUserResolutionFailure;

const SLACK_AUTH_ERRORS = new Set(['not_authed', 'token_revoked', 'account_inactive', 'invalid_auth']);

function classifySlackApiError(error: string | undefined): SlackUserResolutionFailure {
  if (error && SLACK_AUTH_ERRORS.has(error)) {
    return { kind: 'auth_failed', error };
  }
  if (error === 'user_not_found') {
    return { kind: 'not_found' };
  }
  return { kind: 'transport_error', error };
}

async function resolveSlackUserFromWorkspace(teamId: string, userId: string): Promise<SlackUserResolutionOutcome> {
  const cacheKey = `${teamId}:${userId}`;
  const cached = slackUserCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user
      ? { kind: 'resolved', user: cached.user }
      : { kind: 'not_found' };
  }

  const tokens = await getSlackTokensForWorkspace(teamId);
  const candidateTokens = Array.from(new Set([
    tokens?.botToken,
    tokens?.userToken,
  ].filter((token): token is string => Boolean(token))));

  if (candidateTokens.length === 0) {
    return { kind: 'auth_failed', error: 'no_token' };
  }

  let lastFailure: SlackUserResolutionFailure | null = null;

  for (const token of candidateTokens) {
    const url = slackApiUrl('/api/users.info');
    url.searchParams.set('user', userId);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ teamId, userId, err: message }, 'Slack user resolution transport error');
      lastFailure = { kind: 'transport_error', error: message };
      continue;
    }

    if (!response.ok) {
      logger.warn(
        { teamId, userId, status: response.status },
        'Slack user resolution HTTP error',
      );
      lastFailure = { kind: 'transport_error', error: `http_${response.status}` };
      continue;
    }

    let parsed: SlackUserInfoResponse;
    try {
      parsed = await response.json() as SlackUserInfoResponse;
    } catch (err) {
      lastFailure = { kind: 'transport_error', error: err instanceof Error ? err.message : 'invalid_response' };
      continue;
    }

    if (!parsed.ok) {
      logger.warn(
        { teamId, userId, error: parsed.error ?? 'unknown' },
        'Slack user resolution failed',
      );
      lastFailure = classifySlackApiError(parsed.error);
      if (lastFailure.kind === 'auth_failed') continue;
      if (lastFailure.kind === 'not_found') {
        slackUserCache.set(cacheKey, { expiresAt: Date.now() + SLACK_USER_CACHE_TTL_MS, user: null });
        return lastFailure;
      }
      continue;
    }

    if (!parsed.user?.id) {
      lastFailure = { kind: 'not_found' };
      continue;
    }

    if (parsed.user.deleted === true) {
      slackUserCache.set(cacheKey, { expiresAt: Date.now() + SLACK_USER_CACHE_TTL_MS, user: null });
      return { kind: 'deactivated' };
    }

    const user = {
      id: parsed.user.id,
      displayName: parsed.user.profile?.display_name || undefined,
      realName: parsed.user.profile?.real_name || parsed.user.real_name || parsed.user.name || undefined,
      email: parsed.user.profile?.email || undefined,
    };
    slackUserCache.set(cacheKey, { expiresAt: Date.now() + SLACK_USER_CACHE_TTL_MS, user });
    return { kind: 'resolved', user };
  }

  return lastFailure ?? { kind: 'not_found' };
}

/**
 * Register all Slack IPC handlers
 */
export function registerSlackHandlers(): void {
  registerHandler(
    slackChannels['slack:get-workspaces'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        const workspaces = await getSlackWorkspaces();
        return {
          workspaces: workspaces.map((w) => ({
            teamId: w.teamId,
            teamName: w.teamName,
          })),
        };
      } catch (error) {
        logger.error({ err: error }, 'Failed to get Slack workspaces');
        return { workspaces: [] };
      }
    }
  );

  registerHandler(
    slackChannels['slack:start-auth'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        const credentials = resolveOAuthCredentials(slackCredentialSource);
        if (!credentials) {
          const guidance = describeMissingOAuthCredentials('slack');
          return {
            success: false,
            error: guidance.message,
            setupGuidance: guidance,
          };
        }

        const { completion } = startSlackAuth(credentials.clientId, credentials.clientSecret);
        const { teamId, teamName } = await completion;

        // Register per-workspace Slack MCP instance after successful auth
        try {
          const settings = getSettings();
          const resolvedPath = resolveMcpConfigPath(settings);
          if (resolvedPath) {
            const tokens = await getSlackTokensForWorkspace(teamId);
            if (tokens?.botToken) {
              // Resolve OAuth credentials for token refresh support
              const oauthCreds = resolveOAuthCredentials(slackCredentialSource);
              // Create per-workspace instance (e.g., "Slack-mindstone")
              await upsertMcpServerEntry(resolvedPath, buildSlackInstancePayload({
                teamId,
                teamName,
                botToken: tokens.botToken,
                userToken: tokens.userToken,
                configPath: getSlackConfigDir(),
                clientId: oauthCreds?.clientId,
                clientSecret: oauthCreds?.clientSecret,
              }));
              const instanceId = generateWorkspaceInstanceId('Slack', teamName);
              logger.info({ instanceId, teamName }, 'Slack workspace MCP instance registered');

              // Clean up the legacy base "Slack" entry to prevent duplicate connectors
              // The UI pre-adds a generic "Slack" entry before auth; now that we have
              // a per-workspace instance, remove the generic one
              try {
                await removeMcpServerEntry(resolvedPath, 'Slack');
                logger.info('Removed legacy base Slack entry (replaced by workspace instance)');
              } catch (cleanupError) {
                // Non-fatal: the entry may not exist if auth was triggered differently
                logger.debug({ err: cleanupError }, 'No legacy Slack entry to clean up');
              }

              // Hot-reload Super-MCP and refresh caches.
              // Resolve-on-deferral (Stage 4, 260610_gworkspace-mcp-error-disconnect-hang):
              // resolves promptly ({ queued: true }) when the restart is
              // deferred behind active agent turns; idle path still awaits the
              // executed restart. Context byte-identical (renderer deferred-op
              // exact-match).
              try {
                const { queued } = await reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral(resolvedPath, { context: MCP_RESTART_CONTEXT_SLACK_CONNECT });
                logger.info({ teamName, queued }, 'Super-MCP reconfigure requested after Slack connect');
              } catch (reconfigError) {
                logger.warn({ err: reconfigError }, 'Failed to hot-reload Super-MCP (restart may be needed)');
              }
            }
          }
        } catch (mcpError) {
          logger.warn({ err: mcpError }, 'Failed to register Slack MCP after auth');
        }

        notifySlackWorkspaceConnected(teamId, teamName);

        return { success: true, teamName };
      } catch (error) {
        logger.error({ err: error }, 'Failed to start Slack OAuth');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'OAuth failed',
        };
      }
    }
  );

  registerHandler(
    slackChannels['slack:remove-workspace'].channel,
    async (_event: IpcMainInvokeEvent, request: { teamId: string }) => {
      try {
        // Get workspace info BEFORE removal so we can find the instance name
        const workspaces = await getSlackWorkspaces();
        const workspace = workspaces.find(w => w.teamId === request.teamId);
        
        // Remove workspace tokens and config
        await removeSlackWorkspace(request.teamId);

        // Remove the per-workspace MCP instance with full cleanup
        // (removes config entry, tool stats, refreshes caches and Super-MCP)
        if (workspace) {
          try {
            const settings = getSettings();
            const resolvedPath = resolveMcpConfigPath(settings);
            if (resolvedPath) {
              const instanceId = generateWorkspaceInstanceId('Slack', workspace.teamName);
              await removeMcpServerWithCleanup(resolvedPath, instanceId);
              logger.info({ instanceId, teamName: workspace.teamName }, 'Slack workspace MCP instance removed with cleanup');
            }
          } catch (mcpError) {
            logger.warn({ err: mcpError }, 'Failed to remove Slack MCP instance after workspace removal');
          }
        }

        return { success: true };
      } catch (error) {
        logger.error({ err: error }, 'Failed to remove Slack workspace');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Removal failed',
        };
      }
    }
  );

  registerHandler(
    slackChannels['slack:resolve-user'].channel,
    async (_event: IpcMainInvokeEvent, request: { userId: string; packageId?: string; teamId?: string }) => {
      const userId = normalizeSlackUserId(request.userId);
      if (!userId) {
        return { success: false, error: 'Invalid Slack user ID' };
      }

      try {
        const workspaces = await getSlackWorkspaces();
        const requestedPackageId = request.packageId?.trim().toLowerCase();
        const hasExplicitWorkspaceHint = Boolean(request.teamId || requestedPackageId);
        const workspaceCandidates = request.teamId
          ? workspaces.filter((workspace) => workspace.teamId === request.teamId)
          : requestedPackageId
            ? workspaces.filter((workspace) =>
                generateWorkspaceInstanceId('Slack', workspace.teamName).toLowerCase() === requestedPackageId ||
                requestedPackageId === 'slack',
              )
            : workspaces;

        if (hasExplicitWorkspaceHint && workspaceCandidates.length === 0) {
          return { success: false, error: 'Slack workspace not found' };
        }

        const candidates = workspaceCandidates;
        for (const workspace of candidates) {
          const outcome = await resolveSlackUserFromWorkspace(workspace.teamId, userId);
          if (outcome.kind === 'resolved') {
            return { success: true, user: outcome.user };
          }
        }

        return { success: false, error: 'Slack user not found' };
      } catch (error) {
        logger.warn({ err: error, userId }, 'Failed to resolve Slack user');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Slack user lookup failed',
        };
      }
    },
  );

  registerHandler(
    slackChannels['slack:resolve-author-input'].channel,
    async (_event: IpcMainInvokeEvent, request: { query: string; teamId?: string }) => {
      const trimmedQuery = request.query?.trim() ?? '';
      if (!trimmedQuery) {
        return { outcome: 'error', code: 'invalid_input', message: 'Enter a Slack ID, handle, or display name.' } as const;
      }

      // Fast path: already a canonical Slack user id (or <@U…> mention).
      // The handler still calls users.info to verify the account exists and isn't deleted —
      // we never bypass verification for canonical IDs.
      const idCandidate = normalizeSlackUserId(trimmedQuery);
      if (idCandidate) {
        try {
          const workspaces = await getSlackWorkspaces();
          const ordered = request.teamId
            ? workspaces.filter((w) => w.teamId === request.teamId)
            : workspaces;
          if (ordered.length === 0) {
            return { outcome: 'error', code: 'no_workspace', message: 'Connect a Slack workspace first.' } as const;
          }
          let lastFailure: SlackUserResolutionFailure | null = null;
          for (const workspace of ordered) {
            const outcome = await resolveSlackUserFromWorkspace(workspace.teamId, idCandidate);
            if (outcome.kind === 'resolved') {
              return {
                outcome: 'resolved',
                author: {
                  id: outcome.user.id.toUpperCase(),
                  teamId: workspace.teamId,
                  displayName: outcome.user.displayName,
                  realName: outcome.user.realName,
                  email: outcome.user.email,
                },
              } as const;
            }
            lastFailure = outcome;
            if (outcome.kind === 'deactivated') break;
          }
          if (lastFailure?.kind === 'deactivated') {
            return {
              outcome: 'error',
              code: 'deactivated',
              message: `That Slack account is deactivated, so it can't message Rebel. Not adding a ghost.`,
            } as const;
          }
          if (lastFailure?.kind === 'auth_failed') {
            return {
              outcome: 'error',
              code: 'auth_failed',
              message: `Slack wouldn't let Rebel check that person. Reconnect Slack, then try again.`,
            } as const;
          }
          if (lastFailure?.kind === 'transport_error') {
            return { outcome: 'error', code: 'transport_error', message: 'Could not reach Slack to verify that ID.' } as const;
          }
          return {
            outcome: 'error',
            code: 'not_found',
            message: `Couldn't find ${trimmedQuery} in this Slack workspace. Double-check the spelling, or paste their Slack user ID (starts with U).`,
          } as const;
        } catch (err) {
          logger.warn({ err, idCandidate }, 'Slack author ID-path resolution failed');
          return { outcome: 'error', code: 'transport_error', message: 'Could not reach Slack to verify that ID.' } as const;
        }
      }

      // Non-id path: scan workspace member list.
      try {
        const workspaces = await getSlackWorkspaces();
        const candidates = request.teamId
          ? workspaces.filter((w) => w.teamId === request.teamId)
          : workspaces;
        if (candidates.length === 0) {
          return { outcome: 'error', code: 'no_workspace', message: 'Connect a Slack workspace first.' } as const;
        }
        const normalizedQuery = normalizeAuthorQuery(trimmedQuery);
        const matches: ResolvedSlackAuthor[] = [];
        let authFailed = false;
        let transportFailed = false;
        for (const workspace of candidates) {
          const result = await fetchSlackWorkspaceMembers(workspace.teamId);
          if (result.kind === 'auth_failed') {
            authFailed = true;
            continue;
          }
          if (result.kind === 'transport_error') {
            transportFailed = true;
            continue;
          }
          if (result.kind === 'no_workspace') {
            continue;
          }
          for (const member of result.members) {
            if (authorMatchesQuery(member, normalizedQuery)) {
              matches.push(member);
            }
          }
        }
        if (matches.length === 0) {
          if (authFailed) {
            return {
              outcome: 'error',
              code: 'auth_failed',
              message: `Slack wouldn't let Rebel check that person. Reconnect Slack, then try again.`,
            } as const;
          }
          if (transportFailed) {
            return { outcome: 'error', code: 'transport_error', message: 'Could not reach Slack to verify that handle.' } as const;
          }
          return {
            outcome: 'error',
            code: 'not_found',
            message: `Couldn't find ${trimmedQuery} in this Slack workspace. Double-check the spelling, or paste their Slack user ID (starts with U).`,
          } as const;
        }
        if (matches.length === 1) {
          return { outcome: 'resolved', author: matches[0] } as const;
        }
        return {
          outcome: 'error',
          code: 'ambiguous',
          message: `More than one person matched ${trimmedQuery}. Be more specific — try @handle or paste their U-ID.`,
          candidates: matches.slice(0, 5),
        } as const;
      } catch (err) {
        logger.warn({ err, query: trimmedQuery }, 'Slack author resolution scan failed');
        return { outcome: 'error', code: 'transport_error', message: 'Could not reach Slack to verify that handle.' } as const;
      }
    },
  );

  registerHandler(slackChannels['slack:cancel-auth'].channel, async (_event: IpcMainInvokeEvent) => {
    cancelSlackAuth();
  });
}
