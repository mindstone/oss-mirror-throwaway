/**
 * Exhaustiveness guard for discriminated unions.
 *
 * Use inside the `default` arm of a `switch` over a discriminant value to make
 * the TypeScript compiler reject any future extension of the union that isn't
 * also handled at the call site.
 *
 * This is the compile-time exhaustiveness companion to `invariant()` for
 * runtime contracts. Both throw `InvariantViolationError` so invariant-style
 * failures share one structured error subclass.
 */
import { InvariantViolationError } from './invariant';

export function assertNever(x: never, context?: string): never {
  const contextSuffix = context ? ` (${context})` : '';
  throw new InvariantViolationError(
    `Unreachable: unhandled discriminant${contextSuffix} ${String(x)}`,
  );
}
