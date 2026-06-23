/**
 * Slack outbound-broadcast gate.
 *
 * Slack-specific data only. The generic safety hook in
 * `publicBroadcastSafetyHook.ts` consumes this through the registry; no Slack
 * logic lives in the hook itself.
 *
 * Prompt-context strings here are calibrated so the rendered prompt for Slack
 * is byte-identical to the pre-abstraction wording the existing 47 eval
 * fixtures in `evals/public-channel-safety.ts` were calibrated against.
 */

import type { OutboundBroadcastGate } from './types';

/**
 * Slack tool ids that target a public channel for broadcast. Exported so
 * Slack-specific enrichment paths (e.g. approval-card channel-name lookup in
 * `safetyPromptHandlers.ts`) can share the same source of truth as the
 * outbound-broadcast gate without conflating Slack with the broadcast concept
 * itself.
 */
export const SLACK_OUTBOUND_TOOL_IDS = [
  'reply_to_slack_thread',
  'post_slack_message',
  'send_slack_message',
] as const;

const MCP_ROUTER_USE_TOOL = 'mcp__super-mcp-router__use_tool';

function extractReplyContent(toolName: string, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;

  if ((SLACK_OUTBOUND_TOOL_IDS as ReadonlyArray<string>).includes(toolName)) {
    const input = toolInput as Record<string, unknown>;
    return typeof input.text === 'string' ? input.text : null;
  }

  if (toolName === MCP_ROUTER_USE_TOOL) {
    const input = toolInput as Record<string, unknown>;
    const args = input.args as Record<string, unknown> | undefined;
    const text = args?.text;
    return typeof text === 'string' ? text : null;
  }

  return null;
}

export const SLACK_OUTBOUND_BROADCAST_GATE: OutboundBroadcastGate = {
  id: 'slack-public-channel',
  outboundToolIds: SLACK_OUTBOUND_TOOL_IDS,
  extractReplyContent,
  promptContext: {
    surfaceKind: 'Slack channel',
    inboundTriggerDescription: "a user's @-mention",
    audienceVisibilityStatement:
      'Everyone in the workspace can see messages in public channels.',
  },
  userFacingSurfaceLabel: 'Slack channel',
  privateAlternativeSuggestion: 'DM you or use a private channel',
  denyAudienceWarning:
    'This is a PUBLIC channel — your reply would be visible to everyone in the workspace.',
};
