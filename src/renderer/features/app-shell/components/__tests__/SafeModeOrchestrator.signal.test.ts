/**
 * Locks the producer condition for the test-mode `superMcpStartupFailed` boot-smoke
 * signal (GPT Stage-15 review F1). The boot-smoke's classifier is tested separately
 * (scripts/__tests__/check-packaged-app-boot-smoke.test.ts); this guards the SOURCE
 * so the gate can't silently stop firing — and, critically, can't start firing for
 * real users (the isE2EMode guard is the "don't break real Rebel" safety property).
 */
import { describe, expect, it } from 'vitest';
import { shouldRecordTestModeSuperMcpFailure } from '../SafeModeOrchestrator';

describe('shouldRecordTestModeSuperMcpFailure', () => {
  it('records ONLY in E2E mode (real users — isE2EMode=false — never record: the safety property)', () => {
    expect(shouldRecordTestModeSuperMcpFailure(false, true, false)).toBe(false);
  });

  it('records when E2E + onboarding complete + not in safe mode (mirrors the real-user recovery condition)', () => {
    expect(shouldRecordTestModeSuperMcpFailure(true, true, false)).toBe(true);
  });

  it('does NOT record before onboarding is complete (matches the real-user dialog gate)', () => {
    expect(shouldRecordTestModeSuperMcpFailure(true, false, false)).toBe(false);
    expect(shouldRecordTestModeSuperMcpFailure(true, undefined, false)).toBe(false);
  });

  it('does NOT record when already in safe mode (recovery already handled)', () => {
    expect(shouldRecordTestModeSuperMcpFailure(true, true, true)).toBe(false);
  });
});
