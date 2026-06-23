/**
 * TurnPolicy Stage 5 negative lint fixture — sessionType === 'automation'
 * comparison inside a locked file path.
 *
 * Do not "fix" this file; `turnPipelineLintFixtures.test.ts` runs ESLint
 * with `--no-ignore` and asserts the TurnPolicy fence rule fires here.
 *
 * This file replaces an in-process `ESLint.lintText()` synthetic that
 * passed locally on Node 24 but matched 0 messages on CI Node 20 in
 * `eslint@10` + `esquery@1.7` — the symptom was the
 * `:not(BinaryExpression[left.type='Identifier'][left.name='rendererSessionKind']
 *  > Literal[value='automation'])` exclusion chain over-matching the BinaryExpression
 * literal under that runtime combination. Using a real on-disk fixture
 * routed through the same lintFile (CLI subprocess) path the other fence
 * fixtures use sidesteps the in-process API quirk and exercises the same
 * rule wiring CI uses for `npm run lint`.
 */

const turnOptions: { sessionType?: string } = { sessionType: 'automation' };
if (turnOptions.sessionType === 'automation') {
  console.log('blocked');
}

export {};
