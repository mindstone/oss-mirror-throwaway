import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';

const require = createRequire(import.meta.url);
const rule = require('../no-unused-result.js');

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'no-unused-result');

// Type-aware RuleTester: the rule reads parser services, so cases are
// type-checked against fixtures/no-unused-result/tsconfig.json. Each case's
// `filename` must live in that dir so the typed parser includes it.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: {
      // projectService + allowDefaultProject gives the inline RuleTester code
      // type information without each virtual case file needing to be listed in
      // a tsconfig (the type-aware rule reads parser services).
      projectService: {
        allowDefaultProject: ['*.ts'],
        defaultProject: 'tsconfig.json',
        // Each RuleTester case is one virtual default-project file; the default
        // cap is 8. This is test-only (no real linting perf impact).
        maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 50,
      },
      tsconfigRootDir: fixtureDir,
    },
  },
});

const RESULT_UNION = `
  type R = { ok: true; value: number } | { ok: false; error: string };
  declare function doWork(): R;
`;
const SUCCESS_UNION = `
  type R = { success: true; data: number } | { success: false; error: string };
  declare function doWork(): R;
`;
const ASYNC_RESULT_UNION = `
  type R = { ok: true; value: number } | { ok: false; error: string };
  declare function doWork(): Promise<R>;
`;

describe('no-unused-result', () => {
  ruleTester.run('no-unused-result', rule, {
    valid: [
      {
        name: 'void-returning call is fine',
        filename: join(fixtureDir, 'valid-void.ts'),
        code: `declare function log(): void; log();`,
      },
      {
        name: 'plain { ok: boolean } is NOT a discriminated union (no false-positive)',
        filename: join(fixtureDir, 'valid-bool.ts'),
        code: `declare function f(): { ok: boolean; data?: number }; f();`,
      },
      {
        name: 'DOM-style { ok: boolean } via Response-like shape is not flagged',
        filename: join(fixtureDir, 'valid-response.ts'),
        code: `declare function fetchish(): { ok: boolean; status: number }; fetchish();`,
      },
      {
        name: 'consumed result (assigned) is fine',
        filename: join(fixtureDir, 'valid-consumed.ts'),
        code: `${RESULT_UNION} const r = doWork(); if (!r.ok) throw new Error(r.error);`,
      },
      {
        name: 'explicit void opt-out is fine',
        filename: join(fixtureDir, 'valid-voided.ts'),
        code: `${RESULT_UNION} void doWork();`,
      },
      {
        name: 'returned result is fine',
        filename: join(fixtureDir, 'valid-returned.ts'),
        code: `${RESULT_UNION} function wrap(): R { return doWork(); }`,
      },
      {
        name: 'OUT OF SCOPE: union discriminated on `status` (not ok/success) is not flagged',
        filename: join(fixtureDir, 'valid-status-discriminant.ts'),
        code: `
          type R = { status: 'ok'; value: number } | { status: 'error'; error: string };
          declare function doWork(): R;
          doWork();
        `,
      },
    ],
    invalid: [
      {
        name: 'discarded { ok: true } | { ok: false } result',
        filename: join(fixtureDir, 'invalid-ok.ts'),
        code: `${RESULT_UNION} doWork();`,
        errors: [{ messageId: 'unusedResult' }],
      },
      {
        name: 'discarded { success: true } | { success: false } result',
        filename: join(fixtureDir, 'invalid-success.ts'),
        code: `${SUCCESS_UNION} doWork();`,
        errors: [{ messageId: 'unusedResult' }],
      },
      {
        name: 'discarded awaited Promise<result union>',
        filename: join(fixtureDir, 'invalid-async.ts'),
        code: `${ASYNC_RESULT_UNION} async function run() { await doWork(); }`,
        errors: [{ messageId: 'unusedResult' }],
      },
      {
        name: 'discarded bare Promise<result union> (getAwaitedType unwraps)',
        filename: join(fixtureDir, 'invalid-bare-promise.ts'),
        code: `${ASYNC_RESULT_UNION} doWork();`,
        errors: [{ messageId: 'unusedResult' }],
      },
      {
        name: 'discarded Result | undefined still has the false arm',
        filename: join(fixtureDir, 'invalid-nullable.ts'),
        code: `${RESULT_UNION.replace('declare function doWork(): R;', 'declare function doWork(): R | undefined;')} doWork();`,
        errors: [{ messageId: 'unusedResult' }],
      },
      {
        name: 'discarded Promise<Result> | undefined (awaited-type flattens the union)',
        filename: join(fixtureDir, 'invalid-nullable-promise.ts'),
        code: `${ASYNC_RESULT_UNION.replace('declare function doWork(): Promise<R>;', 'declare function doWork(): Promise<R> | undefined;')} doWork();`,
        errors: [{ messageId: 'unusedResult' }],
      },
    ],
  });
});
