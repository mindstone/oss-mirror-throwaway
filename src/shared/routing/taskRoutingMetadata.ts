/**
 * Per-task model routing metadata — the single source of truth for the shape
 * of the `routing:tasks:<json>` status-event wire payload.
 *
 * This type crosses a trust boundary: the core orchestrator serializes a
 * `Record<string, TaskRoutingMetadata>` into a `routing:tasks:` status string
 * (`rebelCoreQuery.ts`), and the renderer parses it back into the same shape to
 * drive per-task model badges in `MissionProgressCard`
 * (`turnStepContext.ts` `parseModelByTaskId`). Before this type was lifted to
 * `@shared`, the two sides declared field-identical-but-independent types, so a
 * field rename on the producer would silently break the renderer parse with no
 * compile error and no test failure. Importing this one definition on both
 * sides converts that drift class into a compile-time error.
 *
 * The renderer parser hard-codes these exact field names and value domains
 * (`model: string`, optional `effort: string`, strict `isSubAgent === true`,
 * `subAgentContext ∈ {scoped, contextual}`); keep them stable.
 */
export type TaskRoutingMetadata = {
  /** Effective model id the task's badge displays. Empty/missing ⇒ task dropped by the renderer. */
  model: string;
  /** Optional reasoning-effort label. */
  effort?: string;
  /** Strict `true` marks a sub-agent (delegation) task — drives the Bot icon/name. */
  isSubAgent?: boolean;
  /** Sub-agent context propagation mode; only these two literals are accepted by the renderer. */
  subAgentContext?: 'scoped' | 'contextual';
};
