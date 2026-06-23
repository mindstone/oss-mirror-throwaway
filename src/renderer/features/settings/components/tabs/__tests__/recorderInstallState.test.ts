import { describe, expect, it } from 'vitest';
import { shouldShowRecorderInstallAffordance } from '../recorderInstallState';

describe('shouldShowRecorderInstallAffordance', () => {
  it('shows only when the recorder is explicitly absent', () => {
    expect(shouldShowRecorderInstallAffordance({ installed: false })).toBe(true);
    expect(shouldShowRecorderInstallAffordance({ installed: true })).toBe(false);
    expect(shouldShowRecorderInstallAffordance(null)).toBe(false);
  });
});
