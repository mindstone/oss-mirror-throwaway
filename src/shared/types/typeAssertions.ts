/**
 * Compile-time type assertion helpers.
 *
 * `IsExactStrict<A, B>` detects type drift that the loose
 * `IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false`
 * helper silently approved.
 *
 * Three compounding silent-green bugs in the original loose helper were
 * verified empirically during S2-CH and S2-D Stage 2 reviews:
 *
 *   1. **Optional-vs-absent drift**: `IsExact<{ x?: T }, {}>` resolved to `true`
 *      because TS structural assignability treats optional-undefined as
 *      interchangeable with an absent property.
 *   2. **Discriminated-union drift**: a structural-property-walk approach using
 *      `keyof A` distributes over unions to the *intersection* of keys, so
 *      variant-specific fields are silently ignored. Critical because
 *      `ManualAgentEvent` is a 19-variant discriminated union — without
 *      union-aware equality, the type-parity gate would silently pass on
 *      massive variant-level drift.
 *   3. **Intersection vs flattened forms** (S2-D Stage 2 finding): the
 *      function-signature invariance trick treats `{ a; b } & { c }` as NOT
 *      structurally equal to `{ a; b; c }` even though both produce the same
 *      assignable shape. The manifest-derived `AgentEventFromManifest` arrives
 *      in intersection form (`{ type } & PayloadOf<...> & { timestamp; seq?; }`),
 *      while the Zod-inferred `ZodAgentEvent` arrives flattened. Without
 *      normalisation the gate is over-strict on this representational
 *      difference. Verified by an empirical probe in `tmp/agent-tests/`.
 *
 * `IsExactStrict` combines the canonical type-fest function-signature
 * invariance pattern with a `Simplify` normalisation pass that flattens
 * intersection forms. The combination preserves all drift-detection power
 * verified for the original (optional-vs-absent, union variant, nested
 * optional, value-type, key-set) while eliminating the intersection-vs-flat
 * false negative.
 */

/**
 * Flatten an object type by walking through `keyof T` and re-emitting the
 * properties as a single object literal. This collapses intersection forms
 * (`A & B`) into flattened object form (`{ ...A; ...B }`) without losing
 * optional modifiers or value types.
 *
 * The empty-intersection (`& {}`) at the end nudges the compiler to actually
 * apply the mapped type rather than lazily preserve the original form. This
 * is the standard `Simplify` workaround used by type-fest and similar
 * libraries.
 *
 * **Narrowed to true objects only** (not arrays, functions, primitives, or
 * top types like `unknown`/`any`). Per Gemini S2-D Stage 2 review: a naive
 * `{ [K in keyof T]: T[K] } & {}` silently equates `unknown` with `{}`
 * (because `keyof unknown` is `never`), and equates primitives like `string`
 * with their prototype-shape (because `keyof string` includes `charAt`,
 * `length`, etc.). Narrowing protects the strict-equality contract on
 * `unknown`, primitives, arrays, and functions — Zod-heavy consumers of
 * `z.unknown()` and similar shapes need the strict behaviour preserved.
 *
 * Verified empirically post-fix:
 *   - `IsExactStrict<unknown, {}>` → `false` ✓
 *   - `IsExactStrict<string, { length: number }>` → `false` ✓
 *   - `IsExactStrict<{ a; b } & { c }, { a; b; c }>` → `true` ✓ (the case this
 *     primitive exists for)
 */
type Simplify<T> =
  T extends readonly unknown[] ? T :
  T extends (...args: never[]) => unknown ? T :
  T extends object ? { [K in keyof T]: T[K] } & {} :
  T;

/**
 * Distribute `Simplify` across a union so each member is independently
 * normalised. Critical for discriminated-union types where each variant may
 * arrive in intersection form (e.g. `{ type: 'a' } & PayloadA`).
 *
 * Note: this distributes over the top-level union but does NOT recurse into
 * nested object properties. AgentEvent and AgentSession do not have nested
 * intersections requiring normalisation; see `typeAssertions.test.ts` for the
 * documented behavioural contract.
 */
type DistributiveSimplify<T> = T extends infer U ? Simplify<U> : never;

/**
 * Strict structural type equality.
 *
 * Returns `true` only when `A` and `B` are structurally identical including:
 *   - exact key sets at every depth
 *   - matching optional-vs-required modifiers at every depth
 *   - matching value types (invariant — no width relaxation)
 *   - matching union shapes (variant-by-variant)
 *
 * Catches drift classes that the loose `IsExact<>` silently approved, including
 * `{ x?: T }` vs `{}`, discriminated-union variant-level drift, and nested
 * optional drift inside otherwise-matching object hierarchies.
 *
 * Treats intersection-form (`A & B`) and flattened-form (`{ ...A; ...B }`) as
 * structurally equivalent, since they have the same set of valid values.
 */
export type IsExactStrict<A, B> =
  (<T>() => T extends DistributiveSimplify<A> ? 1 : 2) extends (<T>() => T extends DistributiveSimplify<B> ? 1 : 2)
    ? true
    : false;

// eslint-disable-next-line @typescript-eslint/naming-convention -- compile-time helper, underscore prefix marks it as such
export type AssertExact<_T extends true> = never;
