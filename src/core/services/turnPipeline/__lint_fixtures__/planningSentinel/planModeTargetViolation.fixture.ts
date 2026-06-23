/**
 * Negative lint fixture for the planning-sentinel-as-mode-trigger guard.
 *
 * BANNED: handing `PREFERRED_PLANNING_MODEL` to the typed plan-mode accessor as a
 * raw trigger value — also re-creates the sentinel-as-mode-trigger pathology.
 * Asserted to produce a `no-restricted-syntax` error.
 *
 * Lint-dirty by design; only linted by planningSentinelLintFixtures.test.ts.
 */
import { PREFERRED_PLANNING_MODEL, planModeTargetFromThinkingModel } from '@shared/utils/modelNormalization';

export function reintroduceSentinelTarget(workingModel: string) {
  return planModeTargetFromThinkingModel(PREFERRED_PLANNING_MODEL, workingModel);
}
