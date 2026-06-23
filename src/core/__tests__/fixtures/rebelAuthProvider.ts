import { NULL_REBEL_AUTH_PROVIDER } from '@core/rebelAuth';
import type { RebelAuthProvider } from '@core/rebelAuth';

/**
 * Test fixture: produces a `RebelAuthProvider` mock derived from
 * `NULL_REBEL_AUTH_PROVIDER` with caller-supplied overrides. Used by Stage 2+
 * consumer tests to mock `getRebelAuthProvider()` cheaply without inventing a
 * full impl per test.
 */
export function createMockRebelAuthProvider(
  overrides?: Partial<RebelAuthProvider>,
): RebelAuthProvider {
  return { ...NULL_REBEL_AUTH_PROVIDER, ...overrides };
}
