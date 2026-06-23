/**
 * Shared normalization helper for the user-set "Finish line" criterion.
 *
 * The criterion is persisted on `AgentSession.finishLine`, on
 * `AutomationDefinition.finishLine`, and
 * forwarded per turn via `AgentTurnRequest.finishLine`. Every persistence
 * boundary (UI save, CLI option parse, Zod transform, cloud patch, turn
 * admission) routes user-provided strings through this helper so the
 * downstream behavior contract — non-empty trimmed string up to
 * {@link FINISH_LINE_MAX_LENGTH} characters, or `undefined` — holds uniformly.
 *
 * See `docs/plans/260515_finish_line.md` for the broader design.
 */

// The constant lives in @shared because IPC schemas (preload-reachable) need it
// and the preload Vite build only resolves @shared, not @core.  Import locally
// AND re-export so `normalizeFinishLine` below can reference it AND downstream
// `@core` consumers can keep importing the constant from this module.
import { FINISH_LINE_MAX_LENGTH } from '@shared/utils/finishLine';
export { FINISH_LINE_MAX_LENGTH };

export function normalizeFinishLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > FINISH_LINE_MAX_LENGTH ? trimmed.slice(0, FINISH_LINE_MAX_LENGTH) : trimmed;
}
