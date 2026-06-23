jest.mock('@rebel/cloud-client', () => ({
  hashForBreadcrumb: (value: string) => `hashed-${value}`,
}));

import {
  buildMeetingChunkOrphanBreadcrumb,
  resolveMeetingChunkOrphanSignal,
} from '../utils/meetingChunkOrphanContinuity';

describe('meetingChunkOrphanContinuity', () => {
  it('returns a signal when companion session is missing and not deduped', () => {
    const signal = resolveMeetingChunkOrphanSignal({
      meetingSessionId: 'meeting-1',
      companionSessionId: 'session-missing',
      knownSessionIds: new Set(['session-a']),
      currentSessionId: 'session-b',
      emittedKeys: new Set(),
    });

    expect(signal).toEqual({
      dedupeKey: 'meeting-1:session-missing',
      normalizedCompanionSessionId: 'session-missing',
    });
  });

  it('returns null when signal is already emitted', () => {
    const signal = resolveMeetingChunkOrphanSignal({
      meetingSessionId: 'meeting-1',
      companionSessionId: 'session-missing',
      knownSessionIds: new Set(),
      currentSessionId: null,
      emittedKeys: new Set(['meeting-1:session-missing']),
    });

    expect(signal).toBeNull();
  });

  it('returns null when companion exists locally', () => {
    const signal = resolveMeetingChunkOrphanSignal({
      meetingSessionId: 'meeting-1',
      companionSessionId: 'session-existing',
      knownSessionIds: new Set(['session-existing']),
      currentSessionId: null,
      emittedKeys: new Set(),
    });

    expect(signal).toBeNull();
  });

  it('builds the orphan breadcrumb payload', () => {
    const event = buildMeetingChunkOrphanBreadcrumb('session-missing');
    expect(event).toEqual({
      family: 'continuity-state',
      message: 'transition',
      level: 'warning',
      data: {
        sessionIdHash: 'hashed-session-missing',
        from: 'cloud_active',
        to: 'cloud_active',
        reason: 'attachment-orphan-detected',
        direction: 'meeting-chunk-drain',
        label: 'missing-companion-session',
      },
    });
  });
});
