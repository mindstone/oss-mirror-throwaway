import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { modelRoleForRouteRole } from '../providerRouting';
import type { ProviderRouteRole } from '../providerRouteDecision';

describe('modelRoleForRouteRole', () => {
  // The canonical, single-authority mapping from the routing layer's role
  // taxonomy onto the user-facing capability tier (ModelRoleTier). These cases
  // pin the exact behaviour the previous inline ternary produced (execution +
  // subagent both resolve to the working tier; bts -> the cheap 'background'
  // tier), so the exhaustiveness-checked refactor is provably behaviour-preserving.
  it.each([
    ['execution', 'working'],
    ['planning', 'thinking'],
    ['bts', 'background'],
    ['subagent', 'working'],
  ] as const)('maps route-role %s -> tier %s', (route, expected) => {
    expect(modelRoleForRouteRole(route as ProviderRouteRole)).toBe(expected);
  });
});
