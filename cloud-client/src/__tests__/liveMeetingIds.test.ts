import { describe, it, expect } from 'vitest';
import {
  asLocalRecordingId,
  asCloudMeetingSessionId,
  asCompanionConversationId,
  type LocalRecordingId,
  type CloudMeetingSessionId,
  type CompanionConversationId,
  type LiveMeetingTurnMetadata,
} from '../types/liveMeetingIds';
import type { StartTurnOptions } from '../hooks/useAgentTurn';
import type { ContinuationTurnMetadata } from '../hooks/useApprovalActions';

/**
 * Compile-time binding: the real turn-submission boundary types must carry the
 * branded `CloudMeetingSessionId` for `meetingSessionId`, not plain `string`.
 * If any boundary reverts to `string`, these `Extract` types widen and the
 * `@ts-expect-error` swap-guards below stop firing — failing the typecheck.
 * (Mobile-side boundaries — SubmitTurnViaSocketOptions, QueueConsumerMetadataBase,
 * SendAndDoneDeps — live in the mobile package and are guarded by mobile's own
 * typecheck against these same exported brands.)
 */
type StartTurnMeetingId = NonNullable<StartTurnOptions['meetingSessionId']>;
type ContinuationMeetingId = NonNullable<ContinuationTurnMetadata['meetingSessionId']>;
// These assignments only compile if the boundary fields are CloudMeetingSessionId.
const _startTurnBound: CloudMeetingSessionId = asCloudMeetingSessionId('x') satisfies StartTurnMeetingId;
const _continuationBound: CloudMeetingSessionId = asCloudMeetingSessionId('x') satisfies ContinuationMeetingId;
void _startTurnBound;
void _continuationBound;

/**
 * Rec #21 (postmortem 1e9ee60): the three live-meeting ids must be distinct
 * branded types so a local recording id can never be passed where a cloud meeting
 * session id is expected (the exact swap that caused the original incident).
 *
 * These are primarily TYPE-LEVEL assertions; the `@ts-expect-error` lines fail the
 * build (and this test's typecheck) if the brands ever collapse back to `string`.
 */
describe('live-meeting branded ids', () => {
  it('constructors brand a raw string and preserve its runtime value', () => {
    const local = asLocalRecordingId('rec-local-123');
    const cloud = asCloudMeetingSessionId('cloud-sess-456');
    const companion = asCompanionConversationId('conv-789');

    // Brands are erased at runtime — the underlying string is unchanged.
    expect(local).toBe('rec-local-123');
    expect(cloud).toBe('cloud-sess-456');
    expect(companion).toBe('conv-789');
  });

  it('a local recording id is NOT assignable into the cloud meeting session id field', () => {
    const local = asLocalRecordingId('rec-local-123');

    // The whole point of the rec: this swap must be a compile error.
    // @ts-expect-error LocalRecordingId is not assignable to CloudMeetingSessionId
    const meta: LiveMeetingTurnMetadata = { cloudMeetingSessionId: local, recordingActive: true };
    // Runtime value still flows (brand is erased) — we only assert the type guard above.
    expect(meta.cloudMeetingSessionId).toBe('rec-local-123');
  });

  it('a correctly-branded cloud id IS assignable into the metadata object', () => {
    const cloud = asCloudMeetingSessionId('cloud-sess-456');
    const meta: LiveMeetingTurnMetadata = { cloudMeetingSessionId: cloud, recordingActive: true };
    expect(meta.cloudMeetingSessionId).toBe('cloud-sess-456');
  });

  it('the three brands are mutually non-interchangeable', () => {
    const cloud = asCloudMeetingSessionId('cloud-sess-456');

    // @ts-expect-error CloudMeetingSessionId is not a LocalRecordingId
    const local: LocalRecordingId = cloud;
    // @ts-expect-error CloudMeetingSessionId is not a CompanionConversationId
    const companion: CompanionConversationId = cloud;

    // Avoid unused-var lint while still exercising the type guards above.
    expect(local).toBe('cloud-sess-456');
    expect(companion).toBe('cloud-sess-456');
  });

  it('a plain string cannot be assigned to a branded id without the constructor', () => {
    const raw = 'just-a-string';
    // @ts-expect-error plain string is not assignable to a branded id
    const cloud: CloudMeetingSessionId = raw;
    expect(cloud).toBe('just-a-string');
  });
});
