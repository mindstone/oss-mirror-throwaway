import { describe, it, expect } from 'vitest';
import type { Event } from '@sentry/core';
import { isExpectedCiE2eNoise } from './sentry';

const evt = (e: Partial<Event>): Event => e as Event;

describe('isExpectedCiE2eNoise (REBEL-184/183/185)', () => {
  it('drops AgentSessionError by exception TYPE even when the message is the human string', () => {
    // The real E2E-mock shape: type carries "AgentSessionError", value is the
    // humanised message (does NOT contain the literal type name).
    expect(isExpectedCiE2eNoise(evt({
      exception: { values: [{ type: 'AgentSessionError', value: 'Model not found. Please check your model selection.' }] },
    }))).toBe(true);
  });

  it('still drops the legacy "Turn cancelled by user" value match', () => {
    expect(isExpectedCiE2eNoise(evt({
      exception: { values: [{ type: 'Error', value: 'Turn cancelled by user' }] },
    }))).toBe(true);
  });

  it('keeps a genuine error (different type, non-matching message)', () => {
    expect(isExpectedCiE2eNoise(evt({
      exception: { values: [{ type: 'TypeError', value: 'Cannot read properties of undefined' }] },
    }))).toBe(false);
  });
});
