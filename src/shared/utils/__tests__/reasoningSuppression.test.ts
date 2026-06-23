import { describe, expect, it } from 'vitest';

import {
  resolveProfileReasoningEffort,
  shouldSuppressProfileReasoning,
} from '../reasoningSuppression';

/**
 * The suppression gate behind Sentry REBEL-5RJ: a `providerType:'other'` gateway
 * that mistranslates `reasoning_effort` into a native thinking shape the model
 * rejects must never receive `reasoning_effort`. The single signal is the
 * auto-detected `thinkingCompatibility === 'incompatible'` verdict (set by the
 * Test button). Both the egress paths (via `@core/rebelCore/modelLimits`, which
 * re-exports these), the renderer's read-only thinking display, and the planner
 * routing catalogue read through this gate, so the wire and the UI can't diverge.
 */
describe('shouldSuppressProfileReasoning', () => {
  it('suppresses when thinking is auto-detected incompatible (Test button)', () => {
    expect(shouldSuppressProfileReasoning({ thinkingCompatibility: 'incompatible' })).toBe(true);
  });

  it.each(['unknown', 'compatible', undefined] as const)(
    'does NOT suppress when thinkingCompatibility=%s',
    (compat) => {
      expect(shouldSuppressProfileReasoning({ thinkingCompatibility: compat })).toBe(false);
    },
  );
});

describe('resolveProfileReasoningEffort', () => {
  it('returns undefined for an incompatible profile even with an effort set', () => {
    expect(
      resolveProfileReasoningEffort({ thinkingCompatibility: 'incompatible', reasoningEffort: 'high' }),
    ).toBeUndefined();
  });

  it('returns the configured effort when reasoning is allowed', () => {
    expect(
      resolveProfileReasoningEffort({ thinkingCompatibility: 'compatible', reasoningEffort: 'high' }),
    ).toBe('high');
  });

  it('returns undefined when no effort is configured (and not suppressed)', () => {
    expect(resolveProfileReasoningEffort({ reasoningEffort: undefined })).toBeUndefined();
  });

  it('preserves the effort when compatibility is unknown', () => {
    expect(
      resolveProfileReasoningEffort({ thinkingCompatibility: 'unknown', reasoningEffort: 'medium' }),
    ).toBe('medium');
  });
});
