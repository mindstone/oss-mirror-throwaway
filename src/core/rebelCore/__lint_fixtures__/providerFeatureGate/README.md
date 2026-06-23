# Provider feature gate lint fixtures

Negative lint fixtures for the `providerFeatureGateGuardSelectors` rule (Stage 1
of `docs/plans/260505_typed_provider_capability_matrix.md`).

These files contain deliberate violations and are excluded from `npm run lint`
via the top-level `ignores` block in `eslint.config.mjs`. The dedicated test
runner shells out to ESLint with `--no-ignore` to assert each shape fires.

Do NOT "fix" these files; they are durable regression tests.

| Fixture | Shape | Why we want this caught |
|---|---|---|
| `equality_violation.fixture.ts` | `this.providerType === 'openai'` | Most common direct gate (Bug B hotfix shape) |
| `negation_violation.fixture.ts` | `this.providerType !== 'openai'` | Negation form (Bug B's actual shape) |
| `switch_violation.fixture.ts` | `switch (this.providerType) { case 'openai': … }` | Switch dispatch (Opus MA-1) |
| `set_membership_violation.fixture.ts` | `MY_SET.has(obj.providerType)` | Set/Map membership (existed at BTS 1418) |
| `array_membership_violation.fixture.ts` | `[…].includes(obj.providerType)` | Array membership |
| `kind_equality_violation.fixture.ts` | `target.kind === 'anthropic-direct'` | Discriminator literal gate |
| `kind_switch_violation.fixture.ts` | `switch (target.kind) { … }` | Switch on `target.kind` discriminator |
| `bare_identifier_acknowledged_hole.fixture.ts` | `function foo(providerType: string) { if (providerType === 'openai') {} }` | Documents acknowledged bare-identifier hole — should NOT fire |
