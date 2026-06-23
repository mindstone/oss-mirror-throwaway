/**
 * Positive (clean) lint fixture for the planning-sentinel-as-mode-trigger guard.
 *
 * SANCTIONED: `PREFERRED_PLANNING_MODEL` used as a fallback *value* — never passed
 * into a model-resolution call to trigger plan mode. These are the legitimate
 * remaining uses the guard must NOT flag:
 *   - auth-failure direct-client fallback (decode into a branded RoutingModelId),
 *   - registry/log fallback labelling,
 *   - settings/UI seed values,
 *   - comparison against the constant.
 * Asserted to produce ZERO `no-restricted-syntax` planning-sentinel errors.
 *
 * Lint-dirty for OTHER rules is tolerated; the fixture test filters to the
 * planning-sentinel message specifically.
 */
import { PREFERRED_PLANNING_MODEL } from '@shared/utils/modelNormalization';

declare function decodeTurnRoutingModelOrThrow(value: string, source: string): string;
declare function addTurnFallback(turnId: string, entry: Record<string, unknown>): void;
declare function resolveModelConfig(working: string, thinking: unknown, ext: boolean): unknown;

export function sanctionedAuthFailureFallback(turnId: string, baseModel: string, planModeTarget: unknown) {
  // Auth-failure fallback: decode the constant into a real branded RoutingModelId.
  const fallbackRoutingModel = decodeTurnRoutingModelOrThrow(PREFERRED_PLANNING_MODEL, 'planning fallback');

  // Registry/log fallback labelling — a value, not a resolution trigger.
  addTurnFallback(turnId, { type: 'model', to: PREFERRED_PLANNING_MODEL, reason: 'thinking-profile-auth-failure' });

  // UI/settings seed value.
  const heroChoice = { model: PREFERRED_PLANNING_MODEL };

  // Comparison against the constant (1M downgrade guard shape).
  const isPreferred = baseModel !== PREFERRED_PLANNING_MODEL;

  // The sanctioned resolution call threads the TYPED target, never the raw sentinel.
  const config = resolveModelConfig(baseModel, planModeTarget, false);

  return { fallbackRoutingModel, heroChoice, isPreferred, config };
}

export function sanctionedReturn() {
  return PREFERRED_PLANNING_MODEL;
}
