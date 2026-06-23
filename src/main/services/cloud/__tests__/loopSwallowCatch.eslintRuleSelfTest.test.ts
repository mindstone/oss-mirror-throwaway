import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const RULE_ID = 'no-restricted-syntax';
const RULE_MESSAGE_FRAGMENT = 'Loop catch swallow guard';
const VIOLATION_FIXTURE = 'src/main/services/cloud/__eslintViolationFixtures__/loopSwallowCatch.ts';

function createEslint(): ESLint {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.mjs'),
    ignore: false,
    errorOnUnmatchedPattern: true,
  });
}

function hasLoopSwallowMessage(
  messages: readonly { ruleId?: string | null; message: string }[],
): boolean {
  return messages.some((message) =>
    message.ruleId === RULE_ID &&
    typeof message.message === 'string' &&
    message.message.includes(RULE_MESSAGE_FRAGMENT),
  );
}

const SAFE_LOOP_SOURCE = `
type FixtureLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
};

export async function memoizesFailures(
  items: readonly string[],
  log: FixtureLogger,
  failures: Map<string, unknown>,
  runItem: (item: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    try {
      await runItem(item);
    } catch (err) {
      failures.set(item, err);
      log.warn({ err, item }, 'item failed');
    }
  }
}

export async function rethrowsFailures(
  items: readonly string[],
  log: FixtureLogger,
  runItem: (item: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    try {
      await runItem(item);
    } catch (err) {
      log.warn({ err, item }, 'item failed');
      throw err;
    }
  }
}

export async function exitsOnFailure(
  items: readonly string[],
  log: FixtureLogger,
  runItem: (item: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    try {
      await runItem(item);
    } catch (err) {
      log.warn({ err, item }, 'item failed');
      return;
    }
  }
}
`;

describe('loop-swallow catch lint guard', () => {
  it('flags logging-plus-counter catches inside scoped background loops', async () => {
    const eslint = createEslint();

    const [result] = await eslint.lintFiles([path.join(REPO_ROOT, VIOLATION_FIXTURE)]);

    expect(
      hasLoopSwallowMessage(result.messages),
      `Expected ${VIOLATION_FIXTURE} to trigger ${RULE_ID}`,
    ).toBe(true);
  });

  it('allows loop catches that memoize, throw, or exit the loop body', async () => {
    const eslint = createEslint();

    const [result] = await eslint.lintText(SAFE_LOOP_SOURCE, {
      filePath: path.join(REPO_ROOT, 'src/main/services/cloud/cloudWorkspaceSync.ts'),
    });

    expect(result.messages.filter((message) => message.fatal)).toEqual([]);
    expect(hasLoopSwallowMessage(result.messages)).toBe(false);
  });

  it('does not apply outside the scoped background-pass globs', async () => {
    const eslint = createEslint();

    const [result] = await eslint.lintText(SAFE_LOOP_SOURCE, {
      filePath: path.join(REPO_ROOT, 'src/main/services/mcpService.ts'),
    });

    expect(result.messages.filter((message) => message.fatal)).toEqual([]);
    expect(hasLoopSwallowMessage(result.messages)).toBe(false);
  });
});
