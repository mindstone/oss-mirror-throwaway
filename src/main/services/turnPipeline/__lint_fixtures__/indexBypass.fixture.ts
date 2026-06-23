/**
 * R1 negative lint fixture — index-barrel bypass form.
 *
 * Even if a future agent re-exports a phase impl from `index.ts`, the
 * barrel-import path is restricted by the phase-to-phase rule. This pairs
 * with the `index.ts` structural test that asserts "type-only exports".
 *
 * The phase-to-phase ESLint rule MUST flag this file. See
 * `__lint_fixtures__/README.md`.
 *
 * Do not "fix" this file; it is a negative test.
 */

import type { AdmittedTurn } from '@main/services/turnPipeline';

// Trivial export so this file is a valid TS module + uses the import.
export const negativeLintFixture: 'indexBypass' = 'indexBypass';
export type FixtureType = AdmittedTurn;
