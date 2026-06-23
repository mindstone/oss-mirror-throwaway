/**
 * TurnPolicy Stage 5 negative lint fixture — optional-chaining
 * `turnOptions?.sessionType === 'automation'`. Do not "fix"; the
 * lint-fixture test asserts the fence rule fires.
 */

const turnOptions: { sessionType?: string } | undefined = { sessionType: 'automation' };
if (turnOptions?.sessionType === 'automation') {
  console.log('blocked');
}

export {};
