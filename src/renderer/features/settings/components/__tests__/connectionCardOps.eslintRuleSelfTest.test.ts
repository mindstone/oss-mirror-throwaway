import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const RULE_ID = 'no-restricted-syntax';
const RULE_MESSAGE_FRAGMENT = 'Connection cards must use ConnectionCardOps';

async function lintFixture(relativePath: string) {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.mjs'),
    ignore: false,
    errorOnUnmatchedPattern: true,
  });
  const [result] = await eslint.lintFiles([path.join(REPO_ROOT, relativePath)]);
  return result;
}

describe('connection-card ops ESLint guard', () => {
  it('flags raw restart-family settingsApi globals in card-family files', async () => {
    const result = await lintFixture(
      'src/renderer/features/settings/components/__lint_fixtures__/connectionCardOps/rawGlobals.fixture.tsx',
    );

    const matches = result.messages.filter((message) =>
      message.ruleId === RULE_ID &&
      typeof message.message === 'string' &&
      message.message.includes(RULE_MESSAGE_FRAGMENT),
    );

    expect(matches).toHaveLength(4);
  });

  it('does not flag out-of-family settingsApi members', async () => {
    const result = await lintFixture(
      'src/renderer/features/settings/components/__lint_fixtures__/connectionCardOps/allowedSettingsApi.fixture.tsx',
    );

    const matches = result.messages.filter((message) =>
      message.ruleId === RULE_ID &&
      typeof message.message === 'string' &&
      message.message.includes(RULE_MESSAGE_FRAGMENT),
    );

    expect(matches).toHaveLength(0);
  });
});
