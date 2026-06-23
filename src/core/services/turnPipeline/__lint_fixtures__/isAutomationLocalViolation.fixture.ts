/**
 * TurnPolicy Stage 5 negative lint fixture — `const isAutomation` local
 * inside a locked file path. Do not "fix"; the lint-fixture test asserts
 * the fence rule fires here.
 */

const isAutomation = true;
if (isAutomation) {
  console.log('blocked');
}

export {};
