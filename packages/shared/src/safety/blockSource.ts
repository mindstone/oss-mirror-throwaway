import { z } from 'zod';

/** Canonical block-source taxonomy. SINGLE SOURCE OF TRUTH — all surfaces import from here. */
export const BlockSourceSchema = z.enum([
  'safety_prompt',
  'sensitivity_eval',
  'structural_policy',
  'eval_error',
]);
export type BlockSource = z.infer<typeof BlockSourceSchema>;

/** Tool-domain subset (the tool hook only meaningfully produces these two). */
export const ToolBlockSourceSchema = z.enum(['safety_prompt', 'eval_error']);
export type ToolBlockSource = z.infer<typeof ToolBlockSourceSchema>;

export const SAFETY_PROMPT_BLOCKED_PREFIX = 'Safety Rules blocked:';

export function backfillToolBlockSource(
  blockedBy: ToolBlockSource | undefined,
  reason: string | undefined,
): ToolBlockSource | undefined {
  if (blockedBy) {
    return blockedBy;
  }
  if (reason?.startsWith(SAFETY_PROMPT_BLOCKED_PREFIX)) {
    return 'safety_prompt';
  }
  return undefined;
}
