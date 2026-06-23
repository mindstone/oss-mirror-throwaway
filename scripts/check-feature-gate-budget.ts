/**
 * Counts exported `function` declarations in
 * `src/core/rebelCore/providerFeatureGuards.ts` and fails CI if the count is
 * at or above the budget cap. Trigger B from the Stage 7 reassessment block of
 * docs/plans/260505_typed_provider_capability_matrix.md: when the predicate
 * count grows to 8 or more within 8 weeks, the typed-capability-matrix
 * heavy plan in Appendix A becomes the right next move and the light plan's
 * "predicate per gate" pattern starts paying for itself less than the matrix
 * approach would.
 *
 * Hitting the cap is NOT a failure of the predicate module; it is the signal
 * that the matrix work should be reassessed. Treat a CI failure here as a
 * "stop and revisit the plan" tripwire.
 *
 * Usage: npx tsx scripts/check-feature-gate-budget.ts
 *
 * Wired into validate:fast (per the plan's Q-6: mandatory, not optional).
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const TARGET_FILE = 'src/core/rebelCore/providerFeatureGuards.ts';
const BUDGET_CAP = 8;
const PLAN_DOC = 'docs/plans/260505_typed_provider_capability_matrix.md';

function main(): void {
  const absPath = resolve(process.cwd(), TARGET_FILE);
  if (!existsSync(absPath)) {
    console.error(`✘ ${TARGET_FILE} does not exist; cannot enforce predicate budget.`);
    process.exit(1);
  }

  const source = readFileSync(absPath, 'utf8');
  // Counts every common predicate-export shape — sync function declarations,
  // async function declarations, and arrow-form const exports — so a future
  // agent who picks `export const myPredicate = (...)` or
  // `export async function ...` over the conventional sync-function shape
  // can't quietly bypass the Trigger B tripwire. Phase 7 Opus reviewer
  // flagged the original `^export function ` regex as single-form fragile.
  const matches = source.match(/^export (?:async )?function \w+|^export const \w+\s*=/gm) ?? [];
  const count = matches.length;

  console.log(`Provider feature gate predicate budget`);
  console.log(`  File   : ${TARGET_FILE}`);
  console.log(`  Count  : ${count}`);
  console.log(`  Budget : <${BUDGET_CAP} (cap inclusive of last allowed predicate at ${BUDGET_CAP - 1})`);

  if (count >= BUDGET_CAP) {
    console.error('');
    console.error(`✘ Predicate count (${count}) is at or above the budget cap (${BUDGET_CAP}).`);
    console.error('');
    console.error(`  Trigger B from ${PLAN_DOC} has fired:`);
    console.error('  3+ new feature-gates added within 8 weeks signals that the typed');
    console.error('  capability-matrix work in Appendix A is overdue. Stop adding');
    console.error('  predicates and reassess the plan with the user.');
    console.error('');
    process.exit(1);
  }

  console.log('✔ Predicate count within budget.');
}

main();
