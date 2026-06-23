import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

const FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  'utils',
  '__lint_fixtures__',
  'originAutomationDriftGuard',
);

const RULE_CONFIG: ['error', ...Array<{ selector: string; message: string }>] = [
  'error',
  {
    selector:
      "BinaryExpression[operator='==='][left.type='MemberExpression'][left.property.name='origin'][right.value='automation']",
    message: 'origin automation equality violation',
  },
  {
    selector:
      "BinaryExpression[operator='!=='][left.type='MemberExpression'][left.property.name='origin'][right.value='automation']",
    message: 'origin automation inequality violation',
  },
  {
    selector:
      "BinaryExpression[operator='==='][left.type='Identifier'][left.name=/^(origin|currentSessionOrigin)$/][right.value='automation']",
    message: 'origin automation equality violation',
  },
  {
    selector:
      "BinaryExpression[operator='!=='][left.type='Identifier'][left.name=/^(origin|currentSessionOrigin)$/][right.value='automation']",
    message: 'origin automation inequality violation',
  },
];

function lintFixture(fileName: string): ReturnType<Linter['verify']> {
  const filePath = path.join(FIXTURE_DIR, fileName);
  const source = readFileSync(filePath, 'utf8');
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(
    source,
    [
      {
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
        rules: {
          'no-restricted-syntax': RULE_CONFIG,
        },
      },
    ],
    { filename: fileName.replace(/\.ts$/, '.js') },
  );
}

describe('origin automation drift guard selector', () => {
  it('flags member origin comparisons against automation', () => {
    const messages = lintFixture('positive.fixture.ts');
    const restrictedMessages = messages.filter(
      (message) => message.ruleId === 'no-restricted-syntax',
    );

    expect(restrictedMessages).toHaveLength(4);
    expect(restrictedMessages.map((message) => message.message).sort()).toEqual([
      'origin automation equality violation',
      'origin automation equality violation',
      'origin automation inequality violation',
      'origin automation inequality violation',
    ]);
  });

  it('does not flag kind or sessionType automation comparisons', () => {
    const messages = lintFixture('negative.fixture.ts');
    const restrictedMessages = messages.filter(
      (message) => message.ruleId === 'no-restricted-syntax',
    );

    expect(restrictedMessages).toEqual([]);
  });
});
