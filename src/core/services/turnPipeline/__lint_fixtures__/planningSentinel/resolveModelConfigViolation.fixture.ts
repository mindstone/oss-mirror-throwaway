/**
 * Negative lint fixture for the planning-sentinel-as-mode-trigger guard
 * (PM 260603_plan_mode_synthetic_claude_planning_sentinel_creds, REBEL-655 rec #3).
 *
 * BANNED: passing `PREFERRED_PLANNING_MODEL` positionally into `resolveModelConfig`
 * to trigger plan mode — the killed sentinel-substitution pattern. Asserted to
 * produce a `no-restricted-syntax` error by planningSentinelLintFixtures.test.ts.
 *
 * This file is intentionally lint-dirty; it lives under `__lint_fixtures__/`
 * (globally ignored by `npm run lint`) and is only linted by the fixture test.
 */
import { PREFERRED_PLANNING_MODEL, resolveModelConfig } from '@shared/utils/modelNormalization';

export function reintroduceSentinelSubstitution(requestedModel: string, hasThinkingProfile: boolean) {
  // The exact pre-REBEL-655 shape: substitute the synthetic Claude sentinel as the
  // "thinking model" whenever any thinking profile exists.
  return resolveModelConfig(
    requestedModel,
    hasThinkingProfile ? PREFERRED_PLANNING_MODEL : null,
    false,
  );
}
