import { describe, expect, it } from 'vitest';
import { bugReportChannels } from '../bugReport';

/**
 * FOLD-IN-4 (Phase 7, GPT F5): per-field byte caps are enforced at the IPC
 * contract — the trust boundary — not just in the renderer dialog. The outbox
 * only has aggregate retention caps, so an unbounded `description` /
 * `screenshotBase64` would otherwise be able to reach disk.
 */
describe('bug-report:submit-bug request contract — byte caps', () => {
  const schema = bugReportChannels['bug-report:submit-bug'].request;

  const base = {
    description: 'something broke',
    urgency: 'medium' as const,
  };

  it('accepts a description at the 5000-char limit', () => {
    expect(schema.safeParse({ ...base, description: 'x'.repeat(5000) }).success).toBe(true);
  });

  it('rejects a description over 5000 chars at the contract', () => {
    const result = schema.safeParse({ ...base, description: 'x'.repeat(5001) });
    expect(result.success).toBe(false);
  });

  it('rejects oversized stepsToReproduce / expectedBehavior at the contract', () => {
    expect(schema.safeParse({ ...base, stepsToReproduce: 'x'.repeat(5001) }).success).toBe(false);
    expect(schema.safeParse({ ...base, expectedBehavior: 'x'.repeat(5001) }).success).toBe(false);
  });

  it('accepts a ~5MB screenshot (≈6.7MB base64) but rejects an over-cap base64 blob', () => {
    // A legitimate 5MB image encodes to ~6.7MB base64 — under the 7MB cap.
    expect(schema.safeParse({ ...base, screenshotBase64: 'A'.repeat(6_700_000) }).success).toBe(true);
    // An oversized base64 payload is rejected at the boundary, not silently
    // persisted to the outbox.
    expect(schema.safeParse({ ...base, screenshotBase64: 'A'.repeat(7_000_001) }).success).toBe(false);
  });
});
