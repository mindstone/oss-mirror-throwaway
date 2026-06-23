import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RULE_ID = 'rebel-space-scan/no-disallowed-scanspaces-side-effects';
const WRITABLE_RULE_MESSAGE_FRAGMENT = 'scanSpacesWithSideEffects() is restricted';
const LEGACY_RULE_MESSAGE_FRAGMENT = 'scanSpaces() must pass explicit `{ skipAutoFix: true }`';
const WRITABLE_VIOLATION_FIXTURE = 'src/main/services/__eslintViolationFixtures__/scanSpacesWithSideEffects.ts';
const LEGACY_FALLBACK_FIXTURE = 'src/main/services/__eslintViolationFixtures__/scanSpacesLegacyFallback.ts';
const NAMESPACE_IMPORT_FIXTURE = 'src/main/services/__eslintViolationFixtures__/scanSpacesNamespaceImport.ts';
const ALIASED_IMPORT_FIXTURE = 'src/main/services/__eslintViolationFixtures__/scanSpacesAliasedImport.ts';
const LEGACY_NAMESPACE_FALLBACK_FIXTURE = 'src/main/services/__eslintViolationFixtures__/scanSpacesLegacyNamespaceFallback.ts';
const LEGACY_ALIASED_FALLBACK_FIXTURE = 'src/main/services/__eslintViolationFixtures__/scanSpacesLegacyAliasedFallback.ts';
const READ_ONLY_ALLOWED_FIXTURE = 'src/main/services/__eslintViolationFixtures__/scanSpacesReadOnlyAllowed.ts';

function createEslint(): ESLint {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.mjs'),
    ignore: false,
    errorOnUnmatchedPattern: true,
  });
}

function hasRuleMessage(
  messages: readonly { ruleId?: string | null; message: string }[],
  fragment: string,
): boolean {
  return messages.some((message) =>
    message.ruleId === RULE_ID &&
    typeof message.message === 'string' &&
    message.message.includes(fragment),
  );
}

describe('scanSpacesWithSideEffects writable-call lint guard', () => {
  it('flags calls outside allowlisted writable-scan sites', async () => {
    const eslint = createEslint();

    const fixturePath = path.join(REPO_ROOT, WRITABLE_VIOLATION_FIXTURE);
    const [result] = await eslint.lintFiles([fixturePath]);
    const hasViolation = hasRuleMessage(result.messages, WRITABLE_RULE_MESSAGE_FRAGMENT);

    expect(hasViolation, `Expected ${WRITABLE_VIOLATION_FIXTURE} to trigger ${RULE_ID}`).toBe(true);
  });

  it('flags legacy scanSpaces() fallback calls without explicit skipAutoFix: true', async () => {
    const eslint = createEslint();

    const fixturePath = path.join(REPO_ROOT, LEGACY_FALLBACK_FIXTURE);
    const [result] = await eslint.lintFiles([fixturePath]);
    const hasViolation = hasRuleMessage(result.messages, LEGACY_RULE_MESSAGE_FRAGMENT);

    expect(hasViolation, `Expected ${LEGACY_FALLBACK_FIXTURE} to trigger ${RULE_ID}`).toBe(true);
  });

  it.each([
    {
      name: 'writable namespace import',
      fixture: NAMESPACE_IMPORT_FIXTURE,
      messageFragment: WRITABLE_RULE_MESSAGE_FRAGMENT,
    },
    {
      name: 'writable aliased import',
      fixture: ALIASED_IMPORT_FIXTURE,
      messageFragment: WRITABLE_RULE_MESSAGE_FRAGMENT,
    },
    {
      name: 'legacy compatibility wrapper through namespace import',
      fixture: LEGACY_NAMESPACE_FALLBACK_FIXTURE,
      messageFragment: LEGACY_RULE_MESSAGE_FRAGMENT,
    },
    {
      name: 'legacy compatibility wrapper through aliased import',
      fixture: LEGACY_ALIASED_FALLBACK_FIXTURE,
      messageFragment: LEGACY_RULE_MESSAGE_FRAGMENT,
    },
  ])('flags $name bypass fixtures', async ({ name, fixture, messageFragment }) => {
    const eslint = createEslint();
    const [result] = await eslint.lintFiles([path.join(REPO_ROOT, fixture)]);

    expect(
      hasRuleMessage(result.messages, messageFragment),
      `Expected ${name} to trigger ${RULE_ID}`,
    ).toBe(true);
  });

  it('allows legacy scanSpaces() only when explicitly marked read-only', async () => {
    const eslint = createEslint();
    const [result] = await eslint.lintFiles([path.join(REPO_ROOT, READ_ONLY_ALLOWED_FIXTURE)]);

    const hasViolation = result.messages.some((message) => message.ruleId === RULE_ID);
    expect(result.messages.filter((message) => message.fatal)).toEqual([]);
    expect(hasViolation).toBe(false);
  });
});
