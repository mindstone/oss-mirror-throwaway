# `turnPipeline/__lint_fixtures__/` — Negative Lint Fixtures

These files are **deliberately invalid** under the R1 phase-to-phase import
rule defined in `eslint.config.mjs` (the block matching
`src/main/services/turnPipeline/*.ts`). They exist so that
`turnPipeline.lintFixtures.test.ts` can shell out to ESLint and assert the
rule fires.

## Files

- `bareSiblingImport.fixture.ts` — relative `./turnAdmission` form.
- `pathAliasImport.fixture.ts` — `@main/services/turnPipeline/turnAdmission`.
- `indexBypass.fixture.ts` — `@main/services/turnPipeline` barrel re-import.

## Why fixtures, not unit tests against ESLint API

ESLint's flat-config + `RuleTester` API requires the rule to be a separate
plugin module. The phase-to-phase rule is a `no-restricted-imports`
configuration entry; the cleanest assertion is "running ESLint over these
fixtures produces N errors." That's what `turnPipeline.lintFixtures.test.ts`
does.

## Future agents

- Do **not** "fix" these files. They are negative tests.
- Do **not** add them to the production tsconfig — they're listed in
  `tsconfig.eslint.json` ignore patterns (and the parent dir is excluded
  via `__lint_fixtures__` in build configs).
- Add a new fixture **only if** you add a new bypass form to the
  phase-to-phase rule.
