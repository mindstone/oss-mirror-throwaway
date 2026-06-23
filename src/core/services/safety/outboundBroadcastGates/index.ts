/**
 * Outbound-broadcast safety gate registry.
 *
 * The generic hook in `publicBroadcastSafetyHook.ts` consults this module to
 * decide (a) whether a tool call counts as posting to a public broadcast
 * surface and (b) how to render the PII-evaluation prompt and user-facing
 * block message for that connector.
 *
 * Adding a new connector means dropping a `<connector>Gates.ts` file beside
 * `slackGates.ts` and registering it in the array below — no edits to the
 * generic hook required.
 */

import type { OutboundBroadcastGate, OutboundBroadcastTarget } from './types';
import { SLACK_OUTBOUND_BROADCAST_GATE } from './slackGates';

const OUTBOUND_BROADCAST_GATES: ReadonlyArray<OutboundBroadcastGate> = [
  SLACK_OUTBOUND_BROADCAST_GATE,
];

const MCP_ROUTER_USE_TOOL = 'mcp__super-mcp-router__use_tool';

/**
 * Union of all outbound-broadcast tool IDs across every gate. Used for cheap
 * membership checks (e.g. channel-name enrichment in approval cards) without
 * pulling content-extraction logic into the consumer.
 */
export const OUTBOUND_BROADCAST_TOOL_IDS: ReadonlySet<string> = new Set(
  OUTBOUND_BROADCAST_GATES.flatMap((gate) => gate.outboundToolIds),
);

function findGateForTool(toolName: string, toolInput: unknown): OutboundBroadcastGate | null {
  for (const gate of OUTBOUND_BROADCAST_GATES) {
    const tools = gate.outboundToolIds as ReadonlyArray<string>;
    if (tools.includes(toolName)) return gate;

    if (toolName === MCP_ROUTER_USE_TOOL && toolInput && typeof toolInput === 'object') {
      const innerToolId = (toolInput as Record<string, unknown>).tool_id;
      if (typeof innerToolId === 'string' && tools.includes(innerToolId)) return gate;
    }
  }
  return null;
}

/**
 * Resolve a tool call to its outbound-broadcast target, including the
 * extracted reply content. Returns null if:
 *   - no registered gate claims this tool name (not a broadcast tool)
 *   - the gate claims it but reply content is missing/non-string (nothing to
 *     evaluate; hook should short-circuit)
 */
export function resolveOutboundBroadcastTarget(
  toolName: string,
  toolInput: unknown,
): OutboundBroadcastTarget | null {
  const gate = findGateForTool(toolName, toolInput);
  if (!gate) return null;

  const replyContent = gate.extractReplyContent(toolName, toolInput);
  if (!replyContent) return null;

  return {
    gateId: gate.id,
    replyContent,
    promptContext: gate.promptContext,
    userFacingSurfaceLabel: gate.userFacingSurfaceLabel,
    privateAlternativeSuggestion: gate.privateAlternativeSuggestion,
    denyAudienceWarning: gate.denyAudienceWarning,
  };
}

export type { OutboundBroadcastGate, OutboundBroadcastTarget, OutboundBroadcastPromptContext } from './types';
