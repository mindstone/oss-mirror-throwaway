import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { lintSyntheticFixture } from '../../test-utils/lint-synthetic-fixture';

const require = createRequire(import.meta.url);
const rule = require('../no-raw-bts-model-read.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

const nonAllowlistedFilename = 'src/core/rebelCore/randomProductionFile.ts';

ruleTester.run('no-raw-bts-model-read', rule, {
  valid: [
    {
      name: 'allows behindTheScenesModel writes',
      filename: nonAllowlistedFilename,
      code: "settings.behindTheScenesModel = 'foo';",
    },
    {
      name: 'allows behindTheScenesModel deletes',
      filename: nonAllowlistedFilename,
      code: 'delete settings.behindTheScenesModel;',
    },
    {
      name: 'allows behindTheScenesOverrides writes',
      filename: nonAllowlistedFilename,
      code: 'settings.behindTheScenesOverrides = { summarization: "foo" };',
    },
    {
      name: 'allows behindTheScenesOverrides deletes',
      filename: nonAllowlistedFilename,
      code: 'delete settings.behindTheScenesOverrides;',
    },
  ],
  invalid: [
    {
      name: 'flags direct behindTheScenesModel reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: 'const x = settings.behindTheScenesModel;',
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags optional-chain behindTheScenesModel reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: 'const x = settings?.behindTheScenesModel;',
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags computed-literal behindTheScenesModel reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: "const x = settings['behindTheScenesModel'];",
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags computed-template behindTheScenesModel reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: 'const x = settings[`behindTheScenesModel`];',
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags destructuring behindTheScenesModel reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: 'const { behindTheScenesModel } = settings;',
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags direct behindTheScenesOverrides reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: 'const x = settings.behindTheScenesOverrides;',
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags optional-chain behindTheScenesOverrides reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: 'const x = settings?.behindTheScenesOverrides;',
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags computed-literal behindTheScenesOverrides reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: "const x = settings['behindTheScenesOverrides'];",
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags computed-template behindTheScenesOverrides reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: 'const x = settings[`behindTheScenesOverrides`];',
      errors: [{ messageId: 'noRawRead' }],
    },
    {
      name: 'flags destructuring behindTheScenesOverrides reads in non-allowlisted files',
      filename: nonAllowlistedFilename,
      code: 'const { behindTheScenesOverrides } = settings;',
      errors: [{ messageId: 'noRawRead' }],
    },
  ],
});

describe('no-raw-bts-model-read config allowlist', () => {
  const code = `
    export function readBtsModel(settings: { behindTheScenesModel?: string }) {
      return settings.behindTheScenesModel;
    }
  `;

  it('does not apply the BTS raw-read rule to allowlisted files', async () => {
    const result = await lintSyntheticFixture({
      filePath: 'src/shared/utils/modelChoiceCodec.ts',
      source: code,
    });

    expect(result.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'bts-flow-shape/no-raw-bts-model-read' }),
      ]),
    );
  });

  it('applies the BTS raw-read rule to non-allowlisted files', async () => {
    const result = await lintSyntheticFixture({
      filePath: nonAllowlistedFilename,
      source: code,
    });

    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'bts-flow-shape/no-raw-bts-model-read' }),
      ]),
    );
  });
});
