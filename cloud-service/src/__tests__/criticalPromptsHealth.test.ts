/**
 * Option B-lite — surface a missing `critical: true` prompt in the cloud
 * DETAILED `/api/health` readiness check, WITHOUT a Fly crash-loop.
 *
 * This file pins the CHECK layer (`checkCriticalPrompts` + its wiring into
 * `runAllCloudChecks`): the check returns `fail` and names the unavailable
 * prompt id when a critical prompt is missing, and `pass` when all present.
 * `getCriticalPromptWarmStatus()` is mocked so the test controls the warm
 * outcome without touching the real prompt files.
 *
 * The load-bearing CRASH-LOOP REGRESSION GUARD (basic `/api/health` stays
 * HTTP 200/`status:'ok'` even when a critical-prompt check fails, while detailed
 * escalates to `critical`) is exercised through the REAL `server.ts` `/api/health`
 * handler in `cloudBootstrapWarmupIntegration.test.ts` ("Option B-lite crash-loop
 * guard" describe block) — a copied local mapping cannot catch a regression that
 * wires checks into the basic branch, so the guard must hit the actual route.
 *
 * @see cloud-service/src/health/checks.ts (checkCriticalPrompts / runAllCloudChecks)
 * @see cloud-service/src/server.ts (/api/health basic vs detailed)
 * @see cloud-service/src/__tests__/cloudBootstrapWarmupIntegration.test.ts (endpoint-level guard)
 * @see docs/plans/260618_cloud-health-critical-prompt/PLAN.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '@core/services/health/types';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock ONLY the warm-status accessor; keep every other promptFileService export
// real (the module is large and imported transitively elsewhere).
const mockGetCriticalPromptWarmStatus = vi.fn<
  () => { hasRun: boolean; ok: boolean; failedCriticalIds: string[] }
>();
vi.mock('@core/services/promptFileService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/services/promptFileService')>();
  return {
    ...actual,
    getCriticalPromptWarmStatus: () => mockGetCriticalPromptWarmStatus(),
  };
});

// Avoid Super-MCP doing real work in runAllCloudChecks().
vi.mock('@core/services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    isConfigured: vi.fn(() => false),
    checkHealth: vi.fn(async () => true),
  },
}));

import { checkCriticalPrompts, runAllCloudChecks } from '../health/checks';

/**
 * Replicates server.ts DETAILED `/api/health` status derivation (`base.status =
 * hasFailure ? 'critical' : hasWarning ? 'degraded' : 'ok'`, server.ts:626-628)
 * for a check-level assertion that a failing critical-prompt check flips detailed
 * to 'critical'. The BASIC face ('ok') is deliberately NOT simulated here — that
 * regression is pinned at the real endpoint in cloudBootstrapWarmupIntegration.test.ts.
 */
function deriveDetailedStatus(checks: CheckResult[]): string {
  const hasFailure = checks.some((c) => c.status === 'fail');
  const hasWarning = checks.some((c) => c.status === 'warn');
  return hasFailure ? 'critical' : hasWarning ? 'degraded' : 'ok';
}

beforeEach(() => {
  mockGetCriticalPromptWarmStatus.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('checkCriticalPrompts', () => {
  it('returns pass when all critical prompts loaded', async () => {
    mockGetCriticalPromptWarmStatus.mockReturnValue({ hasRun: true, ok: true, failedCriticalIds: [] });

    const result = await checkCriticalPrompts();
    expect(result.id).toBe('cloud-critical-prompts');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('All critical safety prompts loaded');
  });

  it('returns skip when warmup has not run yet', async () => {
    mockGetCriticalPromptWarmStatus.mockReturnValue({ hasRun: false, ok: false, failedCriticalIds: [] });

    const result = await checkCriticalPrompts();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('not run yet');
  });

  it('returns fail naming the unavailable prompt id + remediation', async () => {
    mockGetCriticalPromptWarmStatus.mockReturnValue({
      hasRun: true,
      ok: false,
      failedCriticalIds: ['safety/public-broadcast'],
    });

    const result = await checkCriticalPrompts();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('safety/public-broadcast');
    expect(result.details).toEqual({ failedCriticalIds: ['safety/public-broadcast'] });
    expect(result.remediation).toContain('rebel-system/prompts');
  });

  it('names every failed critical id when multiple are unavailable', async () => {
    mockGetCriticalPromptWarmStatus.mockReturnValue({
      hasRun: true,
      ok: false,
      failedCriticalIds: ['safety/public-broadcast', 'safety/done-evaluation'],
    });

    const result = await checkCriticalPrompts();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('safety/public-broadcast');
    expect(result.message).toContain('safety/done-evaluation');
    expect(result.message).toContain('2 critical safety prompt(s) unavailable');
  });
});

describe('runAllCloudChecks — detailed health reflects the critical-prompt check', () => {
  it('includes the cloud-critical-prompts check (wired into runAllCloudChecks)', async () => {
    mockGetCriticalPromptWarmStatus.mockReturnValue({ hasRun: true, ok: true, failedCriticalIds: [] });

    const checks = await runAllCloudChecks();
    const promptCheck = checks.find((c) => c.id === 'cloud-critical-prompts');
    expect(promptCheck).toBeDefined();
    expect(promptCheck?.status).toBe('pass');
  });

  it('the critical-prompts check does NOT contribute a failure when all prompts present (GREEN)', async () => {
    mockGetCriticalPromptWarmStatus.mockReturnValue({ hasRun: true, ok: true, failedCriticalIds: [] });

    const checks = await runAllCloudChecks();
    const promptCheck = checks.find((c) => c.id === 'cloud-critical-prompts');
    // Pass (not fail): so it never flips the detailed status to 'critical'.
    // (Other unrelated checks may warn in the test env — that's not this check.)
    expect(promptCheck?.status).toBe('pass');
    expect(checks.some((c) => c.id === 'cloud-critical-prompts' && c.status === 'fail')).toBe(false);
  });

  it('detailed status is critical and names the prompt when one is unavailable (RED→reported)', async () => {
    mockGetCriticalPromptWarmStatus.mockReturnValue({
      hasRun: true,
      ok: false,
      failedCriticalIds: ['safety/public-broadcast'],
    });

    const checks = await runAllCloudChecks();
    const promptCheck = checks.find((c) => c.id === 'cloud-critical-prompts');
    expect(promptCheck?.status).toBe('fail');
    expect(promptCheck?.message).toContain('safety/public-broadcast');

    expect(deriveDetailedStatus(checks)).toBe('critical');
  });
});
