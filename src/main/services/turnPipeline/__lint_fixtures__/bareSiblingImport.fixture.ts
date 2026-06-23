/**
 * R1 negative lint fixture — bare sibling import form.
 *
 * The phase-to-phase ESLint rule MUST flag this file. See
 * `__lint_fixtures__/README.md`.
 *
 * Do not "fix" this file; it is a negative test.
 */

import type { AdmittedTurn } from './turnAdmission';

// Trivial export so this file is a valid TS module + uses the import.
export const negativeLintFixture: 'bareSiblingImport' = 'bareSiblingImport';
export type FixtureType = AdmittedTurn;
