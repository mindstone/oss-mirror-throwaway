/**
 * Tests for the Stage 5 known-structured-error capture ESLint guard.
 *
 * The rule is implemented with ESLint's built-in no-restricted-syntax, so this
 * test drives the real flat config through ESLint's public API instead of a
 * custom RuleTester harness.
 *
 * @see ../../../../eslint.config.mjs
 * @see docs/plans/260503_sentry_capture_contract.md
 */

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSyntheticFixture } from '../../../../test-utils/lint-synthetic-fixture';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const knownStructuredErrorCaptureMessage = 'Use captureKnownCondition() for known structured errors';
const knownConditionTagCaptureMessage = 'Use captureKnownCondition() for known-condition captures (matched tags.condition literal)';
const mobileLegacyCaptureSentryExceptionMessage = 'captureSentryException was removed in Wave 2c';
const noDynamicCaptureMessageRuleId = 'rebel-sentry/no-dynamic-capture-message';

async function lintFixture(relativePath: string, source: string) {
  return lintSyntheticFixture({
    filePath: join(repoRoot, relativePath),
    source,
  });
}

function knownStructuredErrorCaptureMessages(result: Awaited<ReturnType<typeof lintFixture>>) {
  return result.messages.filter(
    message =>
      message.ruleId === 'no-restricted-syntax'
      && message.message.includes(knownStructuredErrorCaptureMessage),
  );
}

function knownConditionTagCaptureMessages(result: Awaited<ReturnType<typeof lintFixture>>) {
  return result.messages.filter(
    message =>
      message.ruleId === 'no-restricted-syntax'
      && message.message.includes(knownConditionTagCaptureMessage),
  );
}

function mobileLegacyCaptureSentryExceptionMessages(result: Awaited<ReturnType<typeof lintFixture>>) {
  return result.messages.filter(
    message =>
      message.ruleId === 'no-restricted-syntax'
      && message.message.includes(mobileLegacyCaptureSentryExceptionMessage),
  );
}

function dynamicCaptureMessageViolations(result: Awaited<ReturnType<typeof lintFixture>>) {
  return result.messages.filter(message => message.ruleId === noDynamicCaptureMessageRuleId);
}

const modelErrorFixture = `
class ModelError extends Error {}
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(new ModelError('fragmented'), { extra: { source: 'fixture' } });
`;

const codexDisconnectedBtsErrorFixture = `
class CodexDisconnectedBtsError extends Error {}
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(new CodexDisconnectedBtsError('disconnected'), { extra: { source: 'fixture' } });
`;

const plainErrorFixture = `
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(new Error('plain'), { extra: { source: 'fixture' } });
`;

const captureKnownConditionFixture = `
class ModelError extends Error {}
declare function captureKnownCondition(condition: string, context: unknown, error: unknown): void;

captureKnownCondition('model_error', { source: 'fixture' }, new ModelError('stable'));
`;

const knownConditionTagFixture = `
declare const err: Error;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(err, { tags: { condition: 'runtime_activity_mapper_failure', provider: 'openai-chat' } });
`;

const multilineKnownConditionTagFixture = `
declare const wrapped: Error;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(wrapped, {
  tags: {
    area: 'runtime-activity',
    condition: 'runtime_activity_mapper_failure',
    provider: 'openai-chat',
  },
  extra: { rawEventType: 'response.created' },
});
`;

const nonKnownConditionTagFixture = `
declare const err: Error;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(err, { tags: { condition: 'something_random' } });
`;

const noConditionTagFixture = `
declare const err: Error;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(err, { tags: { area: 'mcp' } });
`;

const captureKnownConditionTagFixture = `
declare const context: unknown;
declare const error: Error;
declare function captureKnownCondition(condition: string, context: unknown, error: unknown): void;

captureKnownCondition('runtime_activity_mapper_failure', context, error);
`;

const spreadWithInlineTagsFixture = `
declare const err: Error;
declare const base: { extra: { source: string } };
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(err, { ...base, tags: { condition: 'runtime_activity_mapper_failure', provider: 'openai-chat' } });
`;

const computedKeyConditionFixture = `
declare const err: Error;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(err, { tags: { ['condition']: 'runtime_activity_mapper_failure' } });
`;

const templateLiteralConditionFixture = `
declare const err: Error;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(err, { tags: { condition: \`runtime_activity_mapper_failure\` } });
`;

describe('Stage 5 Sentry known-structured-error capture ESLint guard', () => {
  it('flags literal ModelError captureException instances in src/core', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-modelError-instance.ts',
      modelErrorFixture,
    );

    const matches = knownStructuredErrorCaptureMessages(result);

    expect(matches).toHaveLength(1);
    expect(matches[0].message).toContain('captureKnownCondition');
  });

  it('flags literal CodexDisconnectedBtsError captureException instances in src/main/services', async () => {
    const result = await lintFixture(
      'src/main/services/__fixtures__/lint/captureException-codexBtsError-instance.ts',
      codexDisconnectedBtsErrorFixture,
    );

    expect(knownStructuredErrorCaptureMessages(result)).toHaveLength(1);
  });

  it('flags literal ModelError captureException instances in cloud-service/src', async () => {
    const result = await lintFixture(
      'cloud-service/src/__fixtures__/lint/captureException-modelError-instance.ts',
      modelErrorFixture,
    );

    expect(knownStructuredErrorCaptureMessages(result)).toHaveLength(1);
  });

  it('allows plain Error literal captureException instances inside selected layers', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-plainError.ts',
      plainErrorFixture,
    );

    expect(knownStructuredErrorCaptureMessages(result)).toHaveLength(0);
  });

  it('allows captureKnownCondition for ModelError instances inside selected layers', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureKnownCondition-modelError.ts',
      captureKnownConditionFixture,
    );

    expect(knownStructuredErrorCaptureMessages(result)).toHaveLength(0);
  });

  it('allows the documented eslint-disable escape hatch with justification suffix', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-modelError-with-disable-comment.ts',
      modelErrorFixture.replace(
        "reporter.captureException(new ModelError('fragmented'), { extra: { source: 'fixture' } });",
        [
          '// eslint-disable-next-line no-restricted-syntax -- captureException-justified: legacy capture parity fixture',
          "reporter.captureException(new ModelError('fragmented'), { extra: { source: 'fixture' } });",
        ].join('\n'),
      ),
    );

    expect(knownStructuredErrorCaptureMessages(result)).toHaveLength(0);
  });

  it('does not flag the same literal capture outside the selected layers', async () => {
    const result = await lintFixture(
      'src/renderer/__fixtures__/lint/captureException-modelError-instance.ts',
      modelErrorFixture,
    );

    expect(knownStructuredErrorCaptureMessages(result)).toHaveLength(0);
  });
});

describe('Stage 2 Sentry known-condition tag capture ESLint guard', () => {
  it('flags literal known-condition tag captureException calls in src/core', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-known-condition-tag.ts',
      knownConditionTagFixture,
    );

    const matches = knownConditionTagCaptureMessages(result);

    expect(matches).toHaveLength(1);
    expect(matches[0].message).toContain('captureKnownCondition');
  });

  it('flags literal known-condition tag captureException calls in src/main/services', async () => {
    const result = await lintFixture(
      'src/main/services/__fixtures__/lint/captureException-known-condition-tag.ts',
      knownConditionTagFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(1);
  });

  it('flags literal known-condition tag captureException calls in cloud-service/src', async () => {
    const result = await lintFixture(
      'cloud-service/src/__fixtures__/lint/captureException-known-condition-tag.ts',
      knownConditionTagFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(1);
  });

  it('flags the multi-line production-shape known-condition tag canary', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-known-condition-tag-multiline.ts',
      multilineKnownConditionTagFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(1);
  });

  it('does not flag literal known-condition tag captureException calls outside the selected layers', async () => {
    const result = await lintFixture(
      'src/renderer/__fixtures__/lint/captureException-known-condition-tag.ts',
      knownConditionTagFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(0);
  });

  it('does not flag non-KnownCondition condition tag literals', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-non-known-condition-tag.ts',
      nonKnownConditionTagFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(0);
  });

  it('does not flag captureException calls without a condition tag', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-no-condition-tag.ts',
      noConditionTagFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(0);
  });

  it('does not flag captureKnownCondition wrapper calls for known conditions', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureKnownCondition-runtime-activity.ts',
      captureKnownConditionTagFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(0);
  });

  it('allows the documented eslint-disable escape hatch for known-condition tag captures', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-known-condition-tag-with-disable-comment.ts',
      knownConditionTagFixture.replace(
        "reporter.captureException(err, { tags: { condition: 'runtime_activity_mapper_failure', provider: 'openai-chat' } });",
        [
          '// eslint-disable-next-line no-restricted-syntax -- captureException-justified: legacy capture parity fixture',
          "reporter.captureException(err, { tags: { condition: 'runtime_activity_mapper_failure', provider: 'openai-chat' } });",
        ].join('\n'),
      ),
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(0);
  });

  it('flags spread-with-inline-tags object literal shapes (selector uses descendant matching)', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-spread-with-inline-tags.ts',
      spreadWithInlineTagsFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(1);
  });

  it('does not flag computed-key condition properties (intentional gap; Layer-2 runtime guard handles)', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-computed-condition-key.ts',
      computedKeyConditionFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(0);
  });

  it('does not flag template-literal condition values (intentional gap; Layer-2 runtime guard handles)', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-template-literal-condition.ts',
      templateLiteralConditionFixture,
    );

    expect(knownConditionTagCaptureMessages(result)).toHaveLength(0);
  });
});

const mobileLegacyImportFixture = `
import { captureSentryException } from '../utils/sentry';
void captureSentryException;
`;

const mobileLegacyMultiImportFixture = `
import { mobileErrorReporter, captureSentryException } from '../utils/sentry';
void mobileErrorReporter;
void captureSentryException;
`;

const mobileLegacyAliasedImportFixture = `
import { captureSentryException as legacyCapture } from '../utils/sentry';
void legacyCapture;
`;

const mobileErrorReporterOnlyImportFixture = `
import { mobileErrorReporter } from '../utils/sentry';
void mobileErrorReporter;
`;

const captureSentryExceptionFromUnrelatedModuleFixture = `
import { captureSentryException } from 'somewhere-else';
void captureSentryException;
`;

describe('Wave 2c mobile captureSentryException tombstone ESLint guard', () => {
  it('flags single-import captureSentryException inside mobile/**', async () => {
    const result = await lintFixture(
      'mobile/src/__fixtures__/lint/captureSentryException-single.ts',
      mobileLegacyImportFixture,
    );

    const matches = mobileLegacyCaptureSentryExceptionMessages(result);

    expect(matches).toHaveLength(1);
    expect(matches[0].message).toContain('mobileErrorReporter.captureException');
  });

  it('flags multi-import captureSentryException inside mobile/**', async () => {
    const result = await lintFixture(
      'mobile/src/__fixtures__/lint/captureSentryException-multi.ts',
      mobileLegacyMultiImportFixture,
    );

    expect(mobileLegacyCaptureSentryExceptionMessages(result)).toHaveLength(1);
  });

  it('flags aliased captureSentryException import inside mobile/** (synthesis fix #11)', async () => {
    const result = await lintFixture(
      'mobile/src/__fixtures__/lint/captureSentryException-aliased.ts',
      mobileLegacyAliasedImportFixture,
    );

    expect(mobileLegacyCaptureSentryExceptionMessages(result)).toHaveLength(1);
  });

  it('does not flag mobileErrorReporter-only imports inside mobile/**', async () => {
    const result = await lintFixture(
      'mobile/src/__fixtures__/lint/mobileErrorReporter-only.ts',
      mobileErrorReporterOnlyImportFixture,
    );

    expect(mobileLegacyCaptureSentryExceptionMessages(result)).toHaveLength(0);
  });

  it('does not flag captureSentryException imports outside mobile/** or non-sentry source paths', async () => {
    const result = await lintFixture(
      'src/renderer/__fixtures__/lint/captureSentryException-from-unrelated.ts',
      captureSentryExceptionFromUnrelatedModuleFixture,
    );

    expect(mobileLegacyCaptureSentryExceptionMessages(result)).toHaveLength(0);
  });
});

const dynamicTemplateErrorFixture = `
declare const reason: string;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(new Error(\`capture failed: \${reason}\`));
`;

const dynamicConcatErrorFixture = `
declare const reason: string;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(new Error('capture failed: ' + reason));
`;

const staticCaptureFixture = `
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(new Error('capture failed'));
`;

const loggerTemplateFixture = `
declare const reason: string;
declare const log: { warn(message: string): void };

log.warn(\`capture failed: \${reason}\`);
`;

const captureKnownConditionDynamicFixture = `
declare const reason: string;
declare function captureKnownCondition(condition: string, context: unknown, error?: Error): void;

captureKnownCondition('model_error', { reason }, new Error(\`capture failed: \${reason}\`));
`;

const explicitFingerprintFixture = `
declare const reason: string;
declare const reporter: { captureException(error: unknown, context?: unknown): void };

reporter.captureException(new Error(\`capture failed: \${reason}\`), {
  fingerprint: ['stable-capture'],
  tags: { condition: 'fixture_condition' },
  extra: { reason },
});
`;

describe('Sentry dynamic-capture-message ESLint guard', () => {
  it('flags dynamic template-literal Error captureException calls', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-dynamic-template.ts',
      dynamicTemplateErrorFixture,
    );

    expect(dynamicCaptureMessageViolations(result)).toHaveLength(1);
  });

  it('flags dynamic concatenated Error captureException calls', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-dynamic-concat.ts',
      dynamicConcatErrorFixture,
    );

    expect(dynamicCaptureMessageViolations(result)).toHaveLength(1);
  });

  it('allows static captureException messages', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-static.ts',
      staticCaptureFixture,
    );

    expect(dynamicCaptureMessageViolations(result)).toHaveLength(0);
  });

  it('does not inspect non-Sentry logging calls', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/logger-template.ts',
      loggerTemplateFixture,
    );

    expect(dynamicCaptureMessageViolations(result)).toHaveLength(0);
  });

  it('allows captureKnownCondition dynamic Error payloads', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureKnownCondition-dynamic-error.ts',
      captureKnownConditionDynamicFixture,
    );

    expect(dynamicCaptureMessageViolations(result)).toHaveLength(0);
  });

  it('allows dynamic messages when explicit fingerprint + tags.condition are provided', async () => {
    const result = await lintFixture(
      'src/core/__fixtures__/lint/captureException-dynamic-with-fingerprint.ts',
      explicitFingerprintFixture,
    );

    expect(dynamicCaptureMessageViolations(result)).toHaveLength(0);
  });
});
