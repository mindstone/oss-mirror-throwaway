/**
 * Types for the outbound-broadcast safety gate registry.
 *
 * A "public broadcast surface" is any external surface where a reply is
 * visible to more recipients than just the inbound sender + Rebel:
 *   - a Slack/Discord/Teams public channel
 *   - a GitHub or Linear public issue/PR (visible to all watchers)
 *   - a mailing list reply
 *   - a group chat with many participants
 *
 * Before Rebel posts a reply into such a surface, the generic hook in
 * `src/main/services/inboundTriggers/publicBroadcastSafetyHook.ts` asks an
 * LLM whether the reply contains PII that shouldn't be broadcast. This file
 * defines the connector-data contract that hook consumes; per-connector data
 * lives in sibling files (e.g. `slackGates.ts`).
 */

/**
 * Static descriptors used to render the PII-evaluation prompt for the
 * connector. Each field is a noun phrase substituted into the externalized
 * prompt template at `rebel-system/prompts/safety/public-broadcast.md`.
 *
 * These are intentionally per-connector strings rather than free-form text so
 * a new connector cannot accidentally drop a critical concept (audience,
 * surface, inbound trigger description) from the rendered prompt.
 */
export interface OutboundBroadcastPromptContext {
  /**
   * Singular noun phrase for the surface kind, used after "PUBLIC " in the
   * prompt body. Examples:
   *   - Slack: `"Slack channel"`
   *   - Discord: `"Discord channel"`
   *   - GitHub issue: `"GitHub issue"`
   *   - Mailing list: `"mailing list thread"`
   */
  readonly surfaceKind: string;

  /**
   * Short noun phrase describing how the user triggered Rebel into this turn.
   * Examples:
   *   - Slack: `"a user's @-mention"`
   *   - GitHub: `"a user's @-mention in an issue comment"`
   *   - Email: `"an email addressed to Rebel"`
   */
  readonly inboundTriggerDescription: string;

  /**
   * One-sentence statement describing who can see broadcast messages on this
   * surface. Renders verbatim into the prompt body. Examples:
   *   - Slack: `"Everyone in the workspace can see messages in public channels."`
   *   - Discord: `"Everyone in the server can see messages in public channels."`
   *   - GitHub: `"Everyone watching the repository can see public issue comments."`
   *
   * Single-sentence form (rather than separate audience/surface fields)
   * because the natural phrasing varies per-connector and decomposition
   * produces awkward sentence templates.
   */
  readonly audienceVisibilityStatement: string;
}

/**
 * Per-connector configuration consumed by the generic outbound-broadcast
 * safety hook. Each gate is one connector worth of data; the hook never
 * branches on connector identity.
 */
export interface OutboundBroadcastGate {
  /**
   * Stable identifier for logging and debug surfaces. Not user-visible.
   */
  readonly id: string;

  /**
   * Tool names/IDs that count as "posting a reply to the broadcast surface".
   * Includes both bare tool names and the inner `tool_id` exposed by the
   * MCP super-router's `use_tool` forwarding pattern. The hook consults the
   * registry-level flattened set for membership; this list is per-gate so a
   * single registry traversal can locate the right gate.
   */
  readonly outboundToolIds: ReadonlyArray<string>;

  /**
   * Pull the reply text out of the tool input. Returns null if the input
   * lacks a recognizable content field (in which case the hook short-circuits
   * — there's nothing to evaluate).
   *
   * Implementations should handle both the bare-tool shape (e.g.
   * `{ text: "..." }`) and the MCP-router forwarding shape (e.g.
   * `{ tool_id: "...", args: { text: "..." } }`) for tools listed in
   * {@link outboundToolIds}.
   */
  extractReplyContent(toolName: string, toolInput: unknown): string | null;

  /**
   * Strings substituted into the PII-evaluation prompt template.
   */
  readonly promptContext: OutboundBroadcastPromptContext;

  /**
   * Surface label woven into the agent-facing deny reason when Rebel refuses
   * to send the reply. Should read naturally after "this public ":
   *   - Slack: `"Slack channel"` → "this public Slack channel was blocked"
   *   - GitHub: `"GitHub issue"`
   *   - Mailing list: `"mailing list thread"`
   */
  readonly userFacingSurfaceLabel: string;

  /**
   * Connector-appropriate suggestion for routing private content through a
   * non-broadcast channel. Renders into the agent-facing deny reason so the
   * LLM can propose a sensible alternative on the retry. Examples:
   *   - Slack: `"DM you or use a private channel"`
   *   - Discord: `"send you a DM"`
   *   - GitHub: `"file a private security issue or contact you over email"`
   */
  readonly privateAlternativeSuggestion: string;

  /**
   * One-sentence statement that owns the "this is broadcast and the audience
   * is X" warning in the agent-facing deny reason. Renders verbatim.
   * Examples:
   *   - Slack: `"This is a PUBLIC channel — your reply would be visible to everyone in the workspace."`
   *   - Discord: `"This is a PUBLIC channel — your reply would be visible to everyone in the server."`
   *   - GitHub: `"This is a public issue — your reply would be visible to everyone watching the repository."`
   *
   * Kept as a single per-connector string (rather than further-decomposed
   * audience + surface fields) because the natural phrasing varies enough
   * per surface that decomposition produces awkward templates.
   */
  readonly denyAudienceWarning: string;
}

/**
 * Resolved gate-plus-content tuple returned from registry lookup. Carries
 * everything the hook needs to render the prompt, block message, and logs
 * without re-traversing the registry.
 */
export interface OutboundBroadcastTarget {
  readonly gateId: string;
  readonly replyContent: string;
  readonly promptContext: OutboundBroadcastPromptContext;
  readonly userFacingSurfaceLabel: string;
  readonly privateAlternativeSuggestion: string;
  readonly denyAudienceWarning: string;
}
