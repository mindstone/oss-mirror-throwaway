import { describe, it, expect } from 'vitest';
import type { IsExactStrict, AssertExact } from '../typeAssertions';

// All assertions below are compile-time. If any fails, `npm run lint:ts` will fail.

// Compile-time positive controls
// eslint-disable-next-line @typescript-eslint/naming-convention
type _PosTrivialEqual = AssertExact<IsExactStrict<{ a: string }, { a: string }>>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _PosOptionalEqual = AssertExact<IsExactStrict<{ a?: string }, { a?: string }>>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _PosNoKeysEqual = AssertExact<IsExactStrict<Record<string, never>, Record<string, never>>>;

// Compile-time NEGATIVE controls — these resolve to `false`, so the runtime
// `expect(...).toBe(false)` checks below are how we surface them in the test
// runner. They also serve as documentation of what the strict helper catches.

describe('IsExactStrict — drift detection', () => {
  it('catches the regression: { x?: T } vs {} (optional-vs-absent drift)', () => {
    const v: IsExactStrict<{ a?: string }, Record<string, never>> = false;
    expect(v).toBe(false);
  });

  it('catches required-vs-optional drift on the same key', () => {
    const v: IsExactStrict<{ a: string }, { a?: string }> = false;
    expect(v).toBe(false);
  });

  it('catches missing key on B (A has key, B does not)', () => {
    const v: IsExactStrict<{ a: string; b: number }, { a: string }> = false;
    expect(v).toBe(false);
  });

  it('catches extra key on B (B has key, A does not)', () => {
    const v: IsExactStrict<{ a: string }, { a: string; b: number }> = false;
    expect(v).toBe(false);
  });

  it('catches value-type mismatch on a required key', () => {
    const v: IsExactStrict<{ a: string }, { a: number }> = false;
    expect(v).toBe(false);
  });

  it('catches value-type mismatch on an optional key', () => {
    const v: IsExactStrict<{ a?: string }, { a?: number }> = false;
    expect(v).toBe(false);
  });

  it('catches discriminated union drift when one variant is missing', () => {
    const v: IsExactStrict<{ type: 'a' } | { type: 'b' }, { type: 'a' }> = false;
    expect(v).toBe(false);
  });

  it('catches discriminated union drift when one variant has different fields (per-variant drift)', () => {
    // Critical case for ManualAgentEvent: each variant must match the corresponding
    // Zod variant. A structural-walk helper using `keyof` would silently approve this
    // because keyof distributes to the intersection of variant keys.
    const v: IsExactStrict<
      { type: 'a'; a: string } | { type: 'b'; b: string },
      { type: 'a' } | { type: 'b' }
    > = false;
    expect(v).toBe(false);
  });

  it('catches nested optional drift inside an otherwise matching object', () => {
    const v: IsExactStrict<{ a: { b: string } }, { a: { b?: string } }> = false;
    expect(v).toBe(false);
  });

  it('catches deeply nested optional-vs-absent drift', () => {
    // Critical case for AgentEvent surface: nested objects like `mcpAppUiMeta`,
    // `billingMeta`, etc. must match deeply. A non-recursive helper would only
    // check the top-level optional and silently approve nested drift.
    const v: IsExactStrict<{ meta?: { x?: string } }, { meta?: Record<string, never> }> = false;
    expect(v).toBe(false);
  });

  it('treats a broad string index signature as different from a named property shape', () => {
    const v: IsExactStrict<{ [k: string]: number }, { a: number }> = false;
    expect(v).toBe(false);
  });

  it('returns true for identical optional shapes', () => {
    const v: IsExactStrict<{ a?: string }, { a?: string }> = true;
    expect(v).toBe(true);
  });

  it('returns true for identical required shapes', () => {
    const v: IsExactStrict<{ a: string; b: number }, { a: string; b: number }> = true;
    expect(v).toBe(true);
  });

  it('returns true for identical mixed (required + optional) shapes', () => {
    const v: IsExactStrict<{ a: string; b?: number }, { a: string; b?: number }> = true;
    expect(v).toBe(true);
  });
});

describe('IsExactStrict — intersection normalisation', () => {
  it('treats top-level intersection and flat object forms as equivalent', () => {
    const leftToRight: IsExactStrict<{ a: string } & { b: number }, { a: string; b: number }> = true;
    const rightToLeft: IsExactStrict<{ a: string; b: number }, { a: string } & { b: number }> = true;

    expect(leftToRight).toBe(true);
    expect(rightToLeft).toBe(true);
  });

  it('treats discriminated-union variants in intersection form as equivalent to flat variants', () => {
    type IntersectedVariants =
      | ({ type: 'a' } & { a: string })
      | ({ type: 'b' } & { b: number });
    type FlatVariants = { type: 'a'; a: string } | { type: 'b'; b: number };

    const leftToRight: IsExactStrict<IntersectedVariants, FlatVariants> = true;
    const rightToLeft: IsExactStrict<FlatVariants, IntersectedVariants> = true;

    expect(leftToRight).toBe(true);
    expect(rightToLeft).toBe(true);
  });

  it('documents that nested intersections are not recursively normalised', () => {
    // Current `DistributiveSimplify` distributes across unions and flattens
    // the outer object shape only. Nested intersection-vs-flat equivalence
    // remains false.
    const v: IsExactStrict<
      { outer: { a: string } & { b: number } },
      { outer: { a: string; b: number } }
    > = false;

    expect(v).toBe(false);
  });

  it('continues to catch optional-key drift after intersection simplification', () => {
    const v: IsExactStrict<{ a: string } & { b?: number }, { a: string }> = false;

    expect(v).toBe(false);
  });
});

describe('IsExactStrict — non-object types preserved', () => {
  // Regression coverage for Gemini's S2-D Stage 2 finding: a naive
  // `Simplify<T> = { [K in keyof T]: T[K] } & {}` silently equates `unknown`
  // with `{}` and primitives with prototype-shaped objects. The narrowed
  // `Simplify` (objects only) preserves strict equality for these cases.

  it('does NOT equate unknown with the empty object', () => {
    // `keyof unknown` is `never`, which a naive Simplify maps to `{}`.
    const v: IsExactStrict<unknown, Record<string, never>> = false;
    expect(v).toBe(false);
  });

  it('does NOT equate unknown with an arbitrary object shape', () => {
    const v: IsExactStrict<unknown, { a: string }> = false;
    expect(v).toBe(false);
  });

  it('does NOT equate primitive string with its prototype shape', () => {
    // A naive Simplify maps `string` through `keyof string` (charAt, length, ...).
    const v: IsExactStrict<string, { length: number }> = false;
    expect(v).toBe(false);
  });

  it('does NOT equate primitive number with an object', () => {
    const v: IsExactStrict<number, { toFixed: (digits?: number) => string }> = false;
    expect(v).toBe(false);
  });

  it('preserves strict equality for matching primitives', () => {
    const v: IsExactStrict<string, string> = true;
    expect(v).toBe(true);
  });

  it('preserves strict equality for matching arrays', () => {
    const v: IsExactStrict<readonly string[], readonly string[]> = true;
    expect(v).toBe(true);
  });

  it('does NOT equate readonly array with mutable array of the same element type', () => {
    const v: IsExactStrict<readonly string[], string[]> = false;
    expect(v).toBe(false);
  });

  it('does NOT equate function type with an object type', () => {
    type Fn = (x: number) => string;
    const v: IsExactStrict<Fn, { length: number; name: string }> = false;
    expect(v).toBe(false);
  });
});
