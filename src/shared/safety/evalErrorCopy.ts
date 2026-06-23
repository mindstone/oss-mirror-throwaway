/**
 * Honest copy for safety-evaluator operational failures.
 *
 * These messages are used when Rebel cannot run the safety check and must ask
 * the user for approval instead of auto-screening.
 */

export const EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS = [
  'blocked',
  'risky',
  'safety rules blocked',
] as const;

export function buildEvalErrorAgentReason(toolDisplayName?: string): string {
  const actionLabel = toolDisplayName ? `"${toolDisplayName}"` : 'This action';
  return `SAFETY CHECK COULDN'T RUN (TEMPORARY GLITCH)

${actionLabel} has been queued for user approval and has NOT run yet.

Do not retry this tool in this turn.
If the user asks, tell them it is queued for approval and will run after they approve it.`;
}

export function buildEvalErrorUserReason(): string {
  return "Rebel couldn't run its safety check (a temporary glitch), so it's checking with you before this runs.";
}
