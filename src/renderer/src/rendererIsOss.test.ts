import { describe, it, expect } from 'vitest';
import { rendererIsOss } from './rendererIsOss';

describe('rendererIsOss', () => {
  // Under vitest there is no vite `define`, so the `__REBEL_IS_OSS__` literal is
  // absent and the typeof guard must fall back to `false` (non-OSS) rather than
  // throwing a ReferenceError. This is the contract the Stage 3 telemetry gate
  // relies on: tests inject OSS behaviour via PlatformConfig.isOss, never via
  // this build literal.
  it('falls back to false when the build define is absent (vitest / non-vite)', () => {
    expect(typeof __REBEL_IS_OSS__).toBe('undefined');
    expect(rendererIsOss()).toBe(false);
  });

  it('does not throw a ReferenceError when the define is absent', () => {
    expect(() => rendererIsOss()).not.toThrow();
  });
});
