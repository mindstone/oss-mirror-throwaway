import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const RULE_ID = 'rebel-virtualizer-lifetime/reviewed-get-item-key';
const RULE_MESSAGE_FRAGMENT = 'Renderer virtualizer getItemKey guard';
const VIOLATION_FIXTURE =
  'src/renderer/features/agent-session/components/__eslintViolationFixtures__/virtualizerGetItemKey.tsx';

function createEslint(): ESLint {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.mjs'),
    ignore: false,
    errorOnUnmatchedPattern: true,
  });
}

function hasVirtualizerGetItemKeyMessage(
  messages: readonly { ruleId?: string | null; message: string }[],
): boolean {
  return messages.some((message) =>
    message.ruleId === RULE_ID &&
    typeof message.message === 'string' &&
    message.message.includes(RULE_MESSAGE_FRAGMENT),
  );
}

const ACKNOWLEDGED_SOURCE = `
import { useVirtualizer } from '@tanstack/react-virtual';

export function AckedVirtualizerFixture(): JSX.Element {
  // virtualizer-remount-reviewed: pane keyed by currentSessionId at mount site
  const virtualizer = useVirtualizer({
    count: 1,
    getScrollElement: () => null,
    estimateSize: () => 40,
    getItemKey: (index) => \`message-\${index}\`,
  });

  return <div data-count={virtualizer.getVirtualItems().length} />;
}
`;

const UNKEYED_SOURCE = `
import { useVirtualizer } from '@tanstack/react-virtual';

export function PlainVirtualizerFixture(): JSX.Element {
  const virtualizer = useVirtualizer({
    count: 1,
    getScrollElement: () => null,
    estimateSize: () => 40,
  });

  return <div data-count={virtualizer.getVirtualItems().length} />;
}
`;

describe('virtualizer getItemKey lint guard', () => {
  it('flags useVirtualizer calls with getItemKey in the scoped renderer chokepoint', async () => {
    const eslint = createEslint();

    const [result] = await eslint.lintFiles([path.join(REPO_ROOT, VIOLATION_FIXTURE)]);

    expect(
      hasVirtualizerGetItemKeyMessage(result.messages),
      `Expected ${VIOLATION_FIXTURE} to trigger ${RULE_ID}`,
    ).toBe(true);
  });

  it('allows reviewed call sites with an explicit virtualizer-remount acknowledgement', async () => {
    const eslint = createEslint();

    const [result] = await eslint.lintText(ACKNOWLEDGED_SOURCE, {
      filePath: path.join(REPO_ROOT, 'src/renderer/features/agent-session/components/ConversationPane.tsx'),
    });

    expect(result.messages.filter((message) => message.fatal)).toEqual([]);
    expect(hasVirtualizerGetItemKeyMessage(result.messages)).toBe(false);
  });

  it('allows useVirtualizer calls without custom item keys', async () => {
    const eslint = createEslint();

    const [result] = await eslint.lintText(UNKEYED_SOURCE, {
      filePath: path.join(REPO_ROOT, 'src/renderer/features/agent-session/components/ConversationPane.tsx'),
    });

    expect(result.messages.filter((message) => message.fatal)).toEqual([]);
    expect(hasVirtualizerGetItemKeyMessage(result.messages)).toBe(false);
  });
});
