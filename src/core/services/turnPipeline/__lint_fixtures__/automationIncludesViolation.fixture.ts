/**
 * TurnPolicy Stage 5 negative lint fixture — literal `'automation'`
 * inside an Array.includes() call. Do not "fix"; the lint-fixture test
 * asserts the fence rule fires on the Literal['automation'] tokens.
 */

const hasAutomation = [/* literal */ 'automation'].includes('automation');
if (hasAutomation) {
  console.log('blocked');
}

export {};
