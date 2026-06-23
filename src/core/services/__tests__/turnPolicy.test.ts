import { describe, expect, it, vi } from 'vitest';
import type { SessionType } from '@core/services/promptTemplateService';
import { AUTOMATION_HARD_CEILING_MS } from '@core/services/turnPipeline/watchdogConstants';
import type { TurnPolicy } from '@core/types/turnPolicy';
import {
  derivePolicy,
  getDefaultPolicyForSessionType,
  POLICY_DEFAULTS,
} from '../turnPolicy';

const INTERACTIVE_POLICY_LITERAL: TurnPolicy = {
  prefetchUrls: true,
  semanticContext: 'sync',
  autoInjectPastConversations: true,
  watchdogHardCeilingMs: null,
  watchdogAbortsDuringApprovalWait: false,
  lane: 'foreground',
  promptSessionMode: 'interactive',
  origin: 'manual',
};

const AUTOMATION_POLICY_LITERAL: TurnPolicy = {
  prefetchUrls: false,
  semanticContext: 'off',
  autoInjectPastConversations: false,
  watchdogHardCeilingMs: AUTOMATION_HARD_CEILING_MS,
  watchdogAbortsDuringApprovalWait: true,
  lane: 'background',
  promptSessionMode: 'automation',
  origin: 'automation',
};

describe('turnPolicy', () => {
  it("derivePolicy('interactive') returns the frozen default", () => {
    expect(derivePolicy('interactive')).toEqual(INTERACTIVE_POLICY_LITERAL);
  });

  it("derivePolicy('automation') returns the frozen default", () => {
    expect(derivePolicy('automation')).toEqual(AUTOMATION_POLICY_LITERAL);
  });

  it("derivePolicy('cli') and derivePolicy('mcp_server') match interactive except for promptSessionMode", () => {
    expect(derivePolicy('cli')).toEqual({
      ...INTERACTIVE_POLICY_LITERAL,
      promptSessionMode: 'cli',
    });
    expect(derivePolicy('mcp_server')).toEqual({
      ...INTERACTIVE_POLICY_LITERAL,
      promptSessionMode: 'mcp_server',
    });
  });

  it("derivePolicy('automation', { lane: 'foreground' }) returns automation with lane foreground and preserves all other fields", () => {
    expect(derivePolicy('automation', { lane: 'foreground' })).toEqual({
      ...AUTOMATION_POLICY_LITERAL,
      lane: 'foreground',
    });
  });

  it("derivePolicy('automation', { semanticContext: 'sync', prefetchUrls: true }) composes multiple overrides", () => {
    expect(derivePolicy('automation', { semanticContext: 'sync', prefetchUrls: true })).toEqual({
      ...AUTOMATION_POLICY_LITERAL,
      semanticContext: 'sync',
      prefetchUrls: true,
    });
  });

  it("derivePolicy(undefined) returns interactive policy silently (no log noise)", () => {
    const logger = { warn: vi.fn() };

    expect(derivePolicy(undefined, undefined, logger)).toEqual(INTERACTIVE_POLICY_LITERAL);
    // The undefined-default path is intentionally silent: the migration assertions
    // (turnPolicyAgreement) already detect divergence between legacy and policy
    // branches. A separate warning here would bloat replay-test traces without
    // adding signal. See Stage 1 implementation note in the planning doc.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("derivePolicy('onboarding-coach' as SessionType) returns interactive policy with no warning", () => {
    const logger = { warn: vi.fn() };
    const onboardingCoachSessionType = 'onboarding-coach' as unknown as SessionType;

    expect(derivePolicy(onboardingCoachSessionType, undefined, logger)).toEqual(INTERACTIVE_POLICY_LITERAL);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("derivePolicy('garbage' as SessionType) throws with wire contract drift message", () => {
    const unknownSessionType = 'garbage' as unknown as SessionType;

    expect(() => derivePolicy(unknownSessionType)).toThrowError(/wire contract drift/i);
  });

  it('returned policy is a fresh object on each derivePolicy call', () => {
    const first = derivePolicy('interactive');
    const second = derivePolicy('interactive');

    expect(first).not.toBe(second);
  });

  it('POLICY_DEFAULTS is frozen', () => {
    expect(Object.isFrozen(POLICY_DEFAULTS)).toBe(true);
  });

  it("getDefaultPolicyForSessionType('automation') returns a frozen reference matching the automation policy literal", () => {
    const defaultAutomationPolicy = getDefaultPolicyForSessionType('automation');

    expect(defaultAutomationPolicy).toBe(POLICY_DEFAULTS.automation);
    expect(Object.isFrozen(defaultAutomationPolicy)).toBe(true);
    expect(defaultAutomationPolicy).toEqual(AUTOMATION_POLICY_LITERAL);
  });
});
