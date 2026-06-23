import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const rule = require('../no-default-model-literal.js');
const {
  NO_DEFAULT_MODEL_LITERAL_ALLOWLIST,
  FORBIDDEN_LITERAL,
  FORBIDDEN_IDENTIFIER,
  PLAN_DOC,
} = rule;

const PRODUCTION_FILE = 'src/main/services/agentTurnExecutor.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

ruleTester.run('no-default-model-literal', rule, {
  valid: [
    {
      name: 'allows provider-aware helper as the fallback',
      filename: PRODUCTION_FILE,
      code: `
        function resolve(settings) {
          return getCurrentModel(settings) ?? getDefaultModelForProvider(settings, 'working');
        }
      `,
    },
    {
      name: 'allows DEFAULT_MODEL import without using it as a fallback',
      filename: PRODUCTION_FILE,
      code: `
        import { DEFAULT_MODEL } from '@shared/utils/modelNormalization';
        const KNOWN = new Set([DEFAULT_MODEL]);
      `,
    },
    {
      name: 'allows DEFAULT_MODEL as a property value (provider-already-resolved context)',
      filename: PRODUCTION_FILE,
      code: `
        function applyAnthropicDefaults() {
          return { models: { model: DEFAULT_MODEL } };
        }
      `,
    },
    {
      name: 'allows the literal in a const-declaration site',
      filename: PRODUCTION_FILE,
      code: `
        export const ANTHROPIC_DEFAULT_WORKING_MODEL = 'claude-sonnet-4-6';
      `,
    },
    {
      name: 'allows the literal as a property value (non-fallback context)',
      filename: PRODUCTION_FILE,
      code: `
        const SAMPLE = { label: 'Sonnet 4.6', modelValue: 'claude-sonnet-4-6' };
      `,
    },
    {
      name: 'allows fallback patterns in allowlisted file: openRouterModels.ts',
      filename: 'src/shared/data/openRouterModels.ts',
      code: `
        function resolve(entry) {
          return entry?.sdkModel ?? 'claude-sonnet-4-6';
        }
      `,
    },
    {
      name: 'allows fallback patterns in allowlisted file: promptCacheWarmupService.ts',
      filename: 'src/main/services/promptCacheWarmupService.ts',
      code: `
        function resolve(model) {
          return model ?? 'claude-sonnet-4-6';
        }
      `,
    },
    {
      name: 'allows fallback patterns in allowlisted file: useCaseGeneratorService.ts',
      filename: 'src/main/services/useCaseGeneratorService.ts',
      code: `
        function resolve(model) {
          return model ?? DEFAULT_MODEL;
        }
      `,
    },
  ],
  invalid: [
    {
      name: 'flags `?? \'claude-sonnet-4-6\'` in production file',
      filename: PRODUCTION_FILE,
      code: `
        function resolve(model) {
          return model ?? 'claude-sonnet-4-6';
        }
      `,
      errors: 1,
    },
    {
      name: 'flags `?? DEFAULT_MODEL` in production file',
      filename: PRODUCTION_FILE,
      code: `
        function resolve(model) {
          return model ?? DEFAULT_MODEL;
        }
      `,
      errors: 1,
    },
    {
      name: 'flags `|| \'claude-sonnet-4-6\'` in production file',
      filename: PRODUCTION_FILE,
      code: `
        function resolve(model) {
          return model || 'claude-sonnet-4-6';
        }
      `,
      errors: 1,
    },
    {
      name: 'flags `|| DEFAULT_MODEL` in production file',
      filename: PRODUCTION_FILE,
      code: `
        function resolve(model) {
          return model || DEFAULT_MODEL;
        }
      `,
      errors: 1,
    },
    {
      name: 'flags bare `return \'claude-sonnet-4-6\'`',
      filename: PRODUCTION_FILE,
      code: `
        function resolve() {
          return 'claude-sonnet-4-6';
        }
      `,
      errors: 1,
    },
    {
      name: 'flags bare `return DEFAULT_MODEL`',
      filename: PRODUCTION_FILE,
      code: `
        function resolve() {
          return DEFAULT_MODEL;
        }
      `,
      errors: 1,
    },
    {
      name: 'flags ternary consequent literal',
      filename: PRODUCTION_FILE,
      code: `
        function resolve(cond, x) {
          return cond ? 'claude-sonnet-4-6' : x;
        }
      `,
      errors: 1,
    },
    {
      name: 'flags ternary alternate identifier',
      filename: PRODUCTION_FILE,
      code: `
        function resolve(cond, x) {
          return cond ? x : DEFAULT_MODEL;
        }
      `,
      errors: 1,
    },
  ],
});

describe('NO_DEFAULT_MODEL_LITERAL_ALLOWLIST contract', () => {
  it('contains exactly the three documented entries', () => {
    expect(NO_DEFAULT_MODEL_LITERAL_ALLOWLIST).toHaveLength(3);
  });

  it('lists exactly the three documented file paths in the documented order', () => {
    expect(NO_DEFAULT_MODEL_LITERAL_ALLOWLIST.map((entry) => entry.file)).toEqual([
      'src/shared/data/openRouterModels.ts',
      'src/main/services/promptCacheWarmupService.ts',
      'src/main/services/useCaseGeneratorService.ts',
    ]);
  });

  it('requires every entry to carry a non-empty precondition string naming the guard', () => {
    for (const entry of NO_DEFAULT_MODEL_LITERAL_ALLOWLIST) {
      expect(entry.precondition, `Entry ${entry.file} must have a non-empty precondition`).toBeTypeOf('string');
      expect(entry.precondition.trim().length, `Entry ${entry.file} precondition must be non-empty`).toBeGreaterThan(20);
    }
  });

  it('requires every entry to link back to the remediation plan doc', () => {
    for (const entry of NO_DEFAULT_MODEL_LITERAL_ALLOWLIST) {
      expect(entry.planLink, `Entry ${entry.file} must reference the plan`).toBe(PLAN_DOC);
    }
  });

  it('exports the forbidden literal + identifier used by the rule', () => {
    expect(FORBIDDEN_LITERAL).toBe('claude-sonnet-4-6');
    expect(FORBIDDEN_IDENTIFIER).toBe('DEFAULT_MODEL');
  });

  it('plan-doc constant points at the remediation plan filename', () => {
    expect(PLAN_DOC).toBe('docs/plans/260514_openrouter_sonnet_bypass_remediation.md');
  });
});
