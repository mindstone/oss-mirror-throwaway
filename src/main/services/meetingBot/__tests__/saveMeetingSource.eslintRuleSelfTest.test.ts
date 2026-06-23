import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const RULE_ID = 'no-restricted-syntax';
const RULE_MESSAGE_FRAGMENT = 'Route saves through saveMeetingSource';

// These fixtures are globally ignored by default. This self-test intentionally
// loads them through the ESLint Node API with { ignore: false }.
// Do NOT run `npx eslint <fixture>` for manual verification (it will be
// skipped by ignore patterns); run:
//   npx vitest run src/main/services/meetingBot/__tests__/saveMeetingSource.eslintRuleSelfTest.test.ts
const VIOLATION_FIXTURES = [
  'src/main/services/meetingBot/__eslintViolationFixtures__/directEmit.ts',
  'src/main/services/meetingBot/externalProviders/__eslintViolationFixtures__/directEmit.ts',
  'src/main/services/plaud/__eslintViolationFixtures__/directEmit.ts',
  'src/main/services/physicalRecording/__eslintViolationFixtures__/directEmit.ts',
];

describe('saveMeetingSource ESLint direct-emit guard', () => {
  it.each(VIOLATION_FIXTURES)(
    'flags fixture %s',
    async (fixtureRelativePath) => {
      const eslint = new ESLint({
        cwd: REPO_ROOT,
        overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.mjs'),
        ignore: false,
        errorOnUnmatchedPattern: true,
      });

      const fixturePath = path.join(REPO_ROOT, fixtureRelativePath);
      const [result] = await eslint.lintFiles([fixturePath]);
      const hasViolation = result.messages.some((message) =>
        message.ruleId === RULE_ID &&
        typeof message.message === 'string' &&
        message.message.includes(RULE_MESSAGE_FRAGMENT),
      );

      expect(
        hasViolation,
        `Expected ${fixtureRelativePath} to trigger ${RULE_ID}`,
      ).toBe(true);
    },
  );
});
