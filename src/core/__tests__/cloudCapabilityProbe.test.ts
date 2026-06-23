import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearCloudCapabilityProbeForTesting,
  isCloudCapabilityAdvertised,
  peekCloudCapabilities,
  setCloudCapabilityProbe,
} from '../cloudCapabilityProbe';

describe('cloudCapabilityProbe (Stage B1a)', () => {
  beforeEach(() => {
    clearCloudCapabilityProbeForTesting();
  });

  it('returns null when no probe is installed', () => {
    expect(peekCloudCapabilities()).toBeNull();
    expect(isCloudCapabilityAdvertised('session-content-refs')).toBe(false);
  });

  it('returns null when the installed probe reports null (pre-negotiation)', () => {
    setCloudCapabilityProbe(() => null);
    expect(peekCloudCapabilities()).toBeNull();
    expect(isCloudCapabilityAdvertised('session-content-refs')).toBe(false);
  });

  it('returns the snapshot reported by the probe', () => {
    setCloudCapabilityProbe(() => ['session-content-refs', 'session-event-delta-push']);
    const snapshot = peekCloudCapabilities();
    expect(snapshot).toEqual(['session-content-refs', 'session-event-delta-push']);
    expect(isCloudCapabilityAdvertised('session-content-refs')).toBe(true);
    expect(isCloudCapabilityAdvertised('session-event-delta-push')).toBe(true);
    expect(isCloudCapabilityAdvertised('does-not-exist')).toBe(false);
  });

  it('reflects later probe replacements', () => {
    setCloudCapabilityProbe(() => ['session-content-refs']);
    expect(isCloudCapabilityAdvertised('session-content-refs')).toBe(true);

    setCloudCapabilityProbe(() => []);
    expect(isCloudCapabilityAdvertised('session-content-refs')).toBe(false);
  });
});
