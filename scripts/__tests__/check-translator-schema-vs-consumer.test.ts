import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeTranslatorSchemaVsConsumer } from '../check-translator-schema-vs-consumer';

const FIXTURE_PATH = path.join(process.cwd(), 'tmp', 'translator-check-fixture.ts');
const REAL_TRANSLATOR_PATH = path.join(
  process.cwd(),
  'src',
  'core',
  'services',
  'codexResponsesTranslator.ts',
);

function runFixture(sourceText: string) {
  return analyzeTranslatorSchemaVsConsumer({
    filePath: FIXTURE_PATH,
    sourceText,
  });
}

function reportText(result: ReturnType<typeof runFixture>): string {
  return [...result.warnings, ...result.output].join('\n');
}

describe('check-translator-schema-vs-consumer', () => {
  it('passes when schema defaults/options match consumer reads', () => {
    const result = runFixture(`
      import { z } from 'zod';

      export const ResponsesApiResponseSchema = z.object({
        id: z.string().catch(''),
        model: z.string().catch(''),
        output: z.array(z.unknown()).catch([]),
        usage: z.object({
          input_tokens: z.number().catch(0),
        }).optional(),
      });

      export function translateResponsesToChatCompletion(body: any) {
        for (const item of body.output) {
          void item;
        }
        return {
          id: body.id,
          model: body.model,
          promptTokens: body.usage?.input_tokens ?? 0,
        };
      }
    `);

    expect(result.exitCode).toBe(0);
    expect(reportText(result)).toContain('schema and consumer agree');
  });

  it('fails when schema requires a field the consumer does not require', () => {
    const result = runFixture(`
      import { z } from 'zod';

      export const ResponsesApiResponseSchema = z.object({
        output: z.array(z.unknown()).catch([]),
        unusedStrictField: z.string(),
      });

      export function translateResponsesToChatCompletion(body: any) {
        for (const item of body.output) {
          void item;
        }
        return {};
      }
    `);

    expect(result.exitCode).toBe(1);
    expect(reportText(result)).toContain('unusedStrictField');
    expect(result.violations.some((v) => v.kind === 'schema-overstrict')).toBe(true);
  });

  it('fails when consumer unsafely reads a field the schema does not validate', () => {
    const result = runFixture(`
      import { z } from 'zod';

      export const ResponsesApiResponseSchema = z.object({
        output: z.array(z.unknown()).catch([]),
      });

      export function translateResponsesToChatCompletion(body: any) {
        for (const item of body.output) {
          void item;
        }
        for (const item of body.unvalidatedItems) {
          void item;
        }
        return {};
      }
    `);

    expect(result.exitCode).toBe(1);
    expect(reportText(result)).toContain('unvalidatedItems');
    expect(result.violations.some((v) => v.kind === 'consumer-understrict')).toBe(true);
  });

  it('skips checks when a durable translator-check-disable reason is present', () => {
    const result = runFixture(`
      import { z } from 'zod';

      // translator-check-disable: integrating-new-codex-shape
      export const ResponsesApiResponseSchema = z.object({
        unusedStrictField: z.string(),
      });

      export function translateResponsesToChatCompletion(_body: any) {
        return {};
      }
    `);

    expect(result.exitCode).toBe(0);
    expect(result.skipped).toBe(true);
    expect(reportText(result)).toContain('translator-check-disable exercised');
    expect(reportText(result)).toContain('integrating-new-codex-shape');
  });

  it('ignores banned translator-check-disable reasons and still runs', () => {
    const result = runFixture(`
      import { z } from 'zod';

      // translator-check-disable: WIP
      export const ResponsesApiResponseSchema = z.object({
        unusedStrictField: z.string(),
      });

      export function translateResponsesToChatCompletion(_body: any) {
        return {};
      }
    `);

    expect(result.exitCode).toBe(1);
    expect(reportText(result)).toContain('ignored banned translator-check-disable reason "WIP"');
    expect(reportText(result)).toContain('unusedStrictField');
  });

  it('fails if a defaulted passthrough field is made strict again', () => {
    const result = runFixture(`
      import { z } from 'zod';

      export const ResponsesApiResponseSchema = z.object({
        id: z.string(),
        output: z.array(z.unknown()).catch([]),
      });

      export function translateResponsesToChatCompletion(body: any) {
        for (const item of body.output) {
          void item;
        }
        return { id: body.id };
      }
    `);

    expect(result.exitCode).toBe(1);
    expect(reportText(result)).toContain('id');
    expect(result.violations.some((v) => v.kind === 'schema-overstrict' && v.field === 'id')).toBe(true);
  });

  it('passes against the real Codex Responses translator', () => {
    const result = analyzeTranslatorSchemaVsConsumer({
      filePath: REAL_TRANSLATOR_PATH,
    });

    expect(result.exitCode).toBe(0);
    expect(reportText(result)).toContain('✓ ResponsesApiResponseSchema: schema and consumer agree');
  });
});
