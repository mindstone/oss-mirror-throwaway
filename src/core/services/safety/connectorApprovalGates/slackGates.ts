/**
 * Slack-specific approval gate data.
 *
 * Detection rules and user-facing reason strings for Slack are isolated here so
 * the generic safety hook in `toolSafetyService.ts` stays connector-agnostic.
 * Wording is preserved verbatim from the original implementation to avoid any
 * subtle UX drift.
 *
 * If another connector needs a similar override (e.g. Microsoft Teams DMs,
 * private Notion comments, GitHub direct messages), add a sibling file here
 * and register it in `index.ts`.
 */

import type {
  CohabitedTrustGate,
  InboundAutoApproveGate,
  ToolApprovalContext,
} from './types';

function isSlackTool(ctx: ToolApprovalContext): boolean {
  const pkg = (ctx.packageId ?? ctx.routerPackageId ?? '').toLowerCase();
  const tool = ctx.effectiveToolId.toLowerCase();
  return pkg.includes('slack') || tool.includes('slack');
}

function looksLikeSlackDm(ctx: ToolApprovalContext): boolean {
  const tool = ctx.effectiveToolId.toLowerCase();
  if (tool.includes('open_slack_dm') || tool.includes('direct_message')) return true;
  const channel = ctx.routerArgs.channel_id ?? ctx.routerArgs.channelId ?? ctx.routerArgs.channel;
  return typeof channel === 'string' && /^D[A-Z0-9]/i.test(channel);
}

function safetyPromptExplicitlyAllowsSlackDms(safetyPrompt: string): boolean {
  const normalized = safetyPrompt.toLowerCase();
  const mentionsSlack = normalized.includes('slack');
  const mentionsDirectMessage =
    /\bdms?\b/.test(normalized) ||
    normalized.includes('direct message') ||
    normalized.includes('private message');
  const grantsPermission =
    normalized.includes('allowed') ||
    normalized.includes('allow') ||
    normalized.includes('may ') ||
    normalized.includes('can ') ||
    normalized.includes('without asking') ||
    normalized.includes('automatically');

  return mentionsSlack && mentionsDirectMessage && grantsPermission;
}

export const SLACK_DIRECT_MESSAGE_TRUST_GATE: CohabitedTrustGate = {
  id: 'slack-direct-message',
  matches: (ctx) => isSlackTool(ctx) && looksLikeSlackDm(ctx),
  hasExplicitPermission: safetyPromptExplicitlyAllowsSlackDms,
  reason:
    'Slack direct messages require approval unless your current Safety Rules explicitly allow Slack DMs.',
};

export const SLACK_INBOUND_REPLY_GATE: InboundAutoApproveGate = {
  id: 'slack-inbound-reply',
  toolIds: ['reply_to_slack_thread', 'post_slack_message'],
  reason: 'Slack reply auto-approved',
};
