/**
 * Shared Vitest mock factory for `@core/utils/authEnvUtils`.
 *
 * Motivation: prevent silent-masking when new helpers are added to
 * `authEnvUtils` (or when existing helpers gain new gating semantics). Before
 * this helper, seven test files each stubbed the module independently — any
 * additive change in `authEnvUtils` required a synchronized edit across all
 * seven, and missing one let the stale stub silently paper over the change.
 *
 * Defaults represent an API-key direct-Anthropic user, which matches the
 * baseline BTS test fixture. Tests can override per-helper via the
 * `overrides` argument, OR per-test via `vi.mocked(fnReference).mockReturnValue*(...)`
 * after importing the helper from the real module.
 *
 * Usage (simple default):
 *
 *     vi.mock('@core/utils/authEnvUtils', () => createAuthEnvUtilsMock());
 *
 * Usage (override at module level):
 *
 *     vi.mock('@core/utils/authEnvUtils', () =>
 *       createAuthEnvUtilsMock({ isUsingOpenRouter: true, isDirectAnthropicConfig: false }),
 *     );
 *
 * Usage (override per-test):
 *
 *     import { hasValidAuth } from '@core/utils/authEnvUtils';
 *     beforeEach(() => {
 *       vi.mocked(hasValidAuth).mockReturnValue(true);
 *     });
 *
 * See: docs/plans/260422_routing_followups_mock_and_kind.md (F1).
 */
import { vi } from 'vitest';

export interface AuthEnvUtilsMockOverrides {
  /** Default: true */
  hasValidAuth?: boolean;
  /** Default: false */
  isUsingOAuth?: boolean;
  /** Default: false */
  isUsingOpenRouter?: boolean;
  /**
   * Default: true — matches the R1 direct-Anthropic-shortcut invariant that
   * BTS tests exercise. Flip to false when the test scenario explicitly
   * represents a non-direct-Anthropic user (Codex, OpenRouter, profile-only).
   */
  isDirectAnthropicConfig?: boolean;
  /** Default: {} */
  getAuthEnvVars?: Record<string, string>;
}

/**
 * Factory for a full `@core/utils/authEnvUtils` mock module object.
 *
 * Note: this name collides with a separate helper at
 * `src/main/services/__tests__/agentTurnExecutor.testHarness.ts` that takes a
 * `MockFactories` argument. They coexist via distinct import paths; no test
 * file imports both.
 */
export function createAuthEnvUtilsMock(overrides: AuthEnvUtilsMockOverrides = {}) {
  return {
    hasValidAuth: vi.fn().mockReturnValue(overrides.hasValidAuth ?? true),
    isUsingOAuth: vi.fn().mockReturnValue(overrides.isUsingOAuth ?? false),
    isUsingOpenRouter: vi.fn().mockReturnValue(overrides.isUsingOpenRouter ?? false),
    isDirectAnthropicConfig: vi.fn().mockReturnValue(overrides.isDirectAnthropicConfig ?? true),
    getAuthEnvVars: vi.fn().mockReturnValue(overrides.getAuthEnvVars ?? {}),
  };
}
