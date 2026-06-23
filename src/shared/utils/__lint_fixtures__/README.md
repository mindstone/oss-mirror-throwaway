# Models-namespace lint fixtures

Negative lint fixtures for the `no-restricted-properties` `claude` ban (Stage 2
of `docs/plans/260505_canonical_settings_accessor_and_lint_enforced_read_path.md`).

These files contain deliberate violations and are excluded from `npm run lint`.
The dedicated `src/shared/utils/__tests__/modelsNamespaceLintFixtures.test.ts`
runs ESLint over them with `--no-ignore` to assert the rule fires on each
shape.

Do NOT "fix" these files; they are durable regression tests.

| Fixture | Shape | Why we want this caught |
|---|---|---|
| `bareClaudeRead.fixture.ts` | `settings.claude.apiKey` | Most common direct read |
| `bareModelsRead.fixture.ts` | (reserved — `.models` ban not yet enabled; Stage 4) |
| `spreadClaude.fixture.ts` | `...settings.claude` | Spread/alias propagation |
| `aliasRootClaude.fixture.ts` | `const c = settings.claude; c.apiKey` | Alias-root pattern from `evals/knowledge-work-setup.ts` |
