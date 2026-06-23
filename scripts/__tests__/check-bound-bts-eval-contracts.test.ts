import { describe, expect, it } from 'vitest';
import type { BoundBtsEvalContractManifestEntry } from '../../evals/bts-bound-eval-contracts.manifest';
import {
  checkBoundBtsEvalContracts,
  scanBoundBtsEvalContractSource,
} from '../check-bound-bts-eval-contracts';

const syntheticEntry: BoundBtsEvalContractManifestEntry = {
  id: 'synthetic-bound-eval',
  evalFile: 'evals/synthetic-bound-eval.ts',
  evalContractExport: 'syntheticEvalContract',
  productionModule: 'src/core/services/syntheticProductionService.ts',
  productionContractExports: ['buildProductionPrompt', 'PRODUCTION_JSON_SCHEMA'],
  identityBindings: [
    { productionExport: 'buildProductionPrompt', evalContractPath: ['buildPrompt'] },
    { productionExport: 'PRODUCTION_JSON_SCHEMA', evalContractPath: ['wireOutputSchema'] },
  ],
  generationModelCallFunctions: ['callWithModelAuthAware'],
};

describe('check-bound-bts-eval-contracts', () => {
  it('passes against the current bound eval manifest files', () => {
    expect(checkBoundBtsEvalContracts()).toEqual([]);
  });

  it('flags synthetic local generation prompt and schema mirrors', () => {
    const violations = scanBoundBtsEvalContractSource(
      syntheticEntry,
      `
        import { callWithModelAuthAware } from '../src/core/services/behindTheScenesClient';

        const LOCAL_JSON_SCHEMA = {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        };

        function buildPrompt(input: string): string {
          return \`Local generation prompt: \${input}\`;
        }

        export async function run(settings: unknown, model: string): Promise<void> {
          const prompt = buildPrompt('fixture');
          await callWithModelAuthAware(settings, model, {
            messages: [{ role: 'user' as const, content: prompt }],
            outputFormat: { type: 'json_schema' as const, schema: LOCAL_JSON_SCHEMA },
          });
        }
      `,
    );

    expect(violations.map((violation) => violation.kind)).toEqual([
      'local-generation-schema',
      'local-generation-prompt',
    ]);
  });

  it('allows eval-local judge prompts and judge schemas when they do not feed generation outputFormat', () => {
    const violations = scanBoundBtsEvalContractSource(
      syntheticEntry,
      `
        import { callWithModelAuthAware } from '../src/core/services/behindTheScenesClient';
        import {
          buildProductionPrompt,
          PRODUCTION_JSON_SCHEMA,
        } from '../src/core/services/syntheticProductionService';

        const JUDGE_JSON_SCHEMA = {
          type: 'object',
          properties: { captured: { type: 'boolean' } },
        };

        function buildJudgePrompt(summary: string): string {
          return \`Judge this summary: \${summary}\`;
        }

        export async function run(settings: unknown, model: string): Promise<void> {
          const prompt = buildProductionPrompt('fixture');
          await callWithModelAuthAware(settings, model, {
            messages: [{ role: 'user' as const, content: prompt }],
            outputFormat: { type: 'json_schema' as const, schema: PRODUCTION_JSON_SCHEMA },
          });

          await callWithModelAuthAware(settings, model, {
            messages: [{ role: 'user' as const, content: buildJudgePrompt('summary') }],
            maxTokens: 256,
          });

          JSON.stringify(JUDGE_JSON_SCHEMA);
        }
      `,
    );

    expect(violations).toEqual([]);
  });
});
