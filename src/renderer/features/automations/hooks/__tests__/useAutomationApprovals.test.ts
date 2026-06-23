import { describe, expect, it } from 'vitest';
import { getAutomationReasonDisplayText } from '../useAutomationApprovals';

describe('getAutomationReasonDisplayText', () => {
  it('falls back to tool summary for current fail-closed safety eval reason', () => {
    const result = getAutomationReasonDisplayText(
      "Rebel can't complete the safety check (provider error). This often clears on its own — if it keeps happening, restart Rebel or raise a bug and we'll look into it.",
      'Run bash: npm test',
    );

    expect(result).toBe('Run bash: npm test');
  });

  it('falls back to tool summary for legacy fail-closed safety eval reason (back-compat)', () => {
    const result = getAutomationReasonDisplayText(
      'Safety evaluation unavailable — please try again or approve one-time',
      'Run bash: npm test',
    );

    expect(result).toBe('Run bash: npm test');
  });

  it('keeps specific reasons and strips the safety prefix', () => {
    const result = getAutomationReasonDisplayText(
      'Safety Rules blocked: This command removes files recursively',
      'Run bash: rm -rf build',
    );

    expect(result).toBe('This command removes files recursively');
  });
});
