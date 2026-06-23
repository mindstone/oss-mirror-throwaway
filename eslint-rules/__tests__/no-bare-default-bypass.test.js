import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const rule = require('../no-bare-default-bypass.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

ruleTester.run('no-bare-default-bypass', rule, {
  valid: [
    {
      name: 'sanctioned: assertNever bare call',
      code: `
        function f(value: 'a' | 'b'): string {
          switch (value) {
            case 'a': return 'A';
            case 'b': return 'B';
            default: assertNever(value);
          }
        }
      `,
    },
    {
      name: 'sanctioned: return assertNever',
      code: `
        function f(value: 'a' | 'b'): string {
          switch (value) {
            case 'a': return 'A';
            case 'b': return 'B';
            default: return assertNever(value);
          }
        }
      `,
    },
    {
      name: 'sanctioned: assertNever with extra args (Stage 1.5 widened signature)',
      code: `
        function f(value: 'a' | 'b'): string {
          switch (value) {
            case 'a': return 'A';
            case 'b': return 'B';
            default: return assertNever(value, 'context');
          }
        }
      `,
    },
    {
      name: 'sanctioned: invariant(false, ...) bare',
      code: `
        function f(value: 'a' | 'b'): string {
          switch (value) {
            case 'a': return 'A';
            case 'b': return 'B';
            default: invariant(false, 'unhandled');
          }
        }
      `,
    },
    {
      name: 'sanctioned: assertNever inside block-form default',
      code: `
        function f(value: 'a' | 'b'): string {
          switch (value) {
            case 'a': return 'A';
            case 'b': return 'B';
            default: {
              return assertNever(value);
            }
          }
        }
      `,
    },
    {
      name: 'allowed: returns a real fallback value (not undefined)',
      code: `
        function f(value: 'a' | 'b' | string): string {
          switch (value) {
            case 'a': return 'A';
            case 'b': return 'B';
            default: return 'fallback';
          }
        }
      `,
    },
    {
      name: 'allowed: throws (already failing loud)',
      code: `
        function f(value: 'a' | 'b'): string {
          switch (value) {
            case 'a': return 'A';
            case 'b': return 'B';
            default: throw new Error('unhandled');
          }
        }
      `,
    },
    {
      name: 'allowed: TS-only never-assertion block (Stage 6 territory)',
      code: `
        function f(value: 'a' | 'b'): string {
          switch (value) {
            case 'a': return 'A';
            case 'b': return 'B';
            default: {
              const _exhaustive: never = value;
              void _exhaustive;
              return 'fallback';
            }
          }
        }
      `,
    },
    {
      name: 'allowed: multi-statement observable-bypass block (logging + bail)',
      code: `
        function f(value: string): string | undefined {
          switch (value) {
            case 'a': return 'A';
            default: {
              console.warn('unrecognised value', { value });
              return undefined;
            }
          }
        }
      `,
    },
    {
      name: 'allowed: invariant with non-literal-false predicate is not sanctioned but body is non-bypass',
      code: `
        function f(value: 'a' | 'b' | string): string {
          switch (value) {
            case 'a': return 'A';
            default: return value.toUpperCase();
          }
        }
      `,
    },
  ],
  invalid: [
    {
      name: 'fires: bare break',
      code: `
        function f(value: string): string {
          switch (value) {
            case 'a': return 'A';
            default: break;
          }
          return 'x';
        }
      `,
      errors: [{ messageId: 'bareDefaultBypass', data: { kind: 'break' } }],
    },
    {
      name: 'fires: bare return (no value)',
      code: `
        function f(value: string): void {
          switch (value) {
            case 'a': console.log('A'); break;
            default: return;
          }
        }
      `,
      errors: [{ messageId: 'bareDefaultBypass', data: { kind: 'return' } }],
    },
    {
      name: 'fires: return undefined',
      code: `
        function f(value: string): string | undefined {
          switch (value) {
            case 'a': return 'A';
            default: return undefined;
          }
        }
      `,
      errors: [{ messageId: 'bareDefaultBypass', data: { kind: 'return undefined' } }],
    },
    {
      name: 'fires: empty default body',
      code: `
        function f(value: string): string {
          switch (value) {
            case 'a': return 'A';
            default:
          }
          return 'x';
        }
      `,
      errors: [{ messageId: 'bareDefaultBypass', data: { kind: 'empty default' } }],
    },
    {
      name: 'fires: empty default block',
      code: `
        function f(value: string): string {
          switch (value) {
            case 'a': return 'A';
            default: {}
          }
          return 'x';
        }
      `,
      errors: [{ messageId: 'bareDefaultBypass', data: { kind: 'empty block' } }],
    },
    {
      name: 'fires: block-wrapped bare break (the trivial-evasion vector)',
      code: `
        function f(value: string): string {
          switch (value) {
            case 'a': return 'A';
            default: { break; }
          }
          return 'x';
        }
      `,
      errors: [{ messageId: 'bareDefaultBypass', data: { kind: 'block-wrapped break' } }],
    },
    {
      name: 'fires: block-wrapped return undefined (the trivial-evasion vector)',
      code: `
        function f(value: string): string | undefined {
          switch (value) {
            case 'a': return 'A';
            default: { return undefined; }
          }
        }
      `,
      errors: [{ messageId: 'bareDefaultBypass', data: { kind: 'block-wrapped return undefined' } }],
    },
  ],
});

describe('rebel-switch-exhaustiveness/no-bare-default-bypass', () => {
  it('exposes a rule meta description', () => {
    expect(rule.meta?.docs?.description).toBeTruthy();
  });
});
