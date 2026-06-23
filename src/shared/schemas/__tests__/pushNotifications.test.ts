/**
 * Tests for `src/shared/schemas/pushNotifications.ts`.
 *
 * Verifies the discriminated-union schema, builder helpers, and dedup-key
 * derivation. The dedup-key tests are bit-identity guards: the legacy
 * format `${type}:${kind ?? 'default'}:${sessionId ?? 'none'}` must be
 * preserved exactly so this refactor introduces zero behavioural change
 * at the deduplication level.
 *
 * @see docs/plans/finished/260502_typed_push_notification_payload.md
 */

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PUSH_KINDS,
  CONVERSATION_PUSH_KINDS,
  PushNotificationDataSchema,
  buildApprovalPush,
  buildCoachingPush,
  buildConversationPush,
  buildMeetingAnalysisCompletePush,
  buildPushDedupKey,
  getPushDedupKind,
  type PushNotificationData,
} from '../pushNotifications';

// ─── Builders produce parseable payloads ──────────────────────────────

describe('builders produce schema-valid payloads', () => {
  it.each(CONVERSATION_PUSH_KINDS)(
    'buildConversationPush(kind=%s) parses',
    (kind) => {
      const payload = buildConversationPush({ kind, sessionId: 'sess_123' });
      expect(PushNotificationDataSchema.parse(payload)).toEqual({
        type: 'conversation',
        kind,
        sessionId: 'sess_123',
      });
    },
  );

  it.each(APPROVAL_PUSH_KINDS)(
    'buildApprovalPush(kind=%s, sessionId=set) parses',
    (kind) => {
      const payload = buildApprovalPush({ kind, sessionId: 'sess_456' });
      expect(PushNotificationDataSchema.parse(payload)).toEqual({
        type: 'approval',
        kind,
        sessionId: 'sess_456',
      });
    },
  );

  it.each(APPROVAL_PUSH_KINDS)(
    'buildApprovalPush(kind=%s, sessionId=undefined) parses',
    (kind) => {
      const payload = buildApprovalPush({ kind });
      expect(PushNotificationDataSchema.parse(payload)).toEqual({
        type: 'approval',
        kind,
        // sessionId omitted entirely (zod strips undefined for optional fields)
      });
    },
  );

  it('buildCoachingPush() parses with sessionId', () => {
    const payload = buildCoachingPush({ sessionId: 'sess_789' });
    expect(PushNotificationDataSchema.parse(payload)).toEqual({
      type: 'coaching',
      kind: 'coaching-card',
      sessionId: 'sess_789',
    });
  });

  it('buildCoachingPush() parses without sessionId', () => {
    const payload = buildCoachingPush({});
    expect(PushNotificationDataSchema.parse(payload)).toEqual({
      type: 'coaching',
      kind: 'coaching-card',
    });
  });

  it('buildMeetingAnalysisCompletePush() parses', () => {
    const payload = buildMeetingAnalysisCompletePush({
      sessionId: 'sess_meet',
      meetingTitle: 'Q3 Planning',
    });
    expect(PushNotificationDataSchema.parse(payload)).toEqual({
      type: 'meeting-analysis-complete',
      sessionId: 'sess_meet',
      meetingTitle: 'Q3 Planning',
    });
  });
});

// ─── Builder edge cases (empty / whitespace sessionId normalisation) ──

describe('builders normalise empty/whitespace optional sessionId to undefined', () => {
  it.each(['', '   ', '\t\n'])(
    'buildApprovalPush(sessionId=%j) → omits',
    (raw) => {
      const payload = buildApprovalPush({ kind: 'tool-approval', sessionId: raw });
      expect(payload.sessionId).toBeUndefined();
    },
  );

  it.each(['', '   ', '\t\n'])(
    'buildCoachingPush(sessionId=%j) → omits',
    (raw) => {
      const payload = buildCoachingPush({ sessionId: raw });
      expect(payload.sessionId).toBeUndefined();
    },
  );

  it('builder preserves leading/trailing whitespace-trimmed sessionId', () => {
    const payload = buildApprovalPush({ kind: 'tool-approval', sessionId: '  sess_x  ' });
    expect(payload.sessionId).toBe('sess_x');
  });
});

// ─── Schema rejects malformed payloads ────────────────────────────────

describe('schema rejects malformed payloads', () => {
  it('rejects missing type', () => {
    const result = PushNotificationDataSchema.safeParse({ sessionId: 's' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown type', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'mystery',
      sessionId: 's',
    });
    expect(result.success).toBe(false);
  });

  it('rejects conversation without sessionId', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'conversation',
      kind: 'turn-complete',
    });
    expect(result.success).toBe(false);
  });

  it('rejects conversation with empty-string sessionId', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'conversation',
      kind: 'turn-complete',
      sessionId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects conversation with unknown kind', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'conversation',
      kind: 'mystery-kind',
      sessionId: 's',
    });
    expect(result.success).toBe(false);
  });

  it('rejects approval with unknown kind', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'approval',
      kind: 'mystery-kind',
    });
    expect(result.success).toBe(false);
  });

  it('rejects coaching with wrong kind literal', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'coaching',
      kind: 'tool-approval',
    });
    expect(result.success).toBe(false);
  });

  it('rejects meeting-analysis-complete without sessionId', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'meeting-analysis-complete',
      meetingTitle: 't',
    });
    expect(result.success).toBe(false);
  });

  it('rejects meeting-analysis-complete without meetingTitle', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'meeting-analysis-complete',
      sessionId: 's',
    });
    expect(result.success).toBe(false);
  });

  it('rejects approval with empty-string sessionId (when present)', () => {
    const result = PushNotificationDataSchema.safeParse({
      type: 'approval',
      kind: 'tool-approval',
      sessionId: '',
    });
    expect(result.success).toBe(false);
  });
});

// ─── Schema strips unknown keys (Expo wire-format resilience) ─────────

describe('schema strips unknown keys', () => {
  // Zod `.object()` strips unknown keys by default. Apple's APNS shim
  // and Android's FCM transport may inject extra keys (e.g., `_aps`,
  // `notification_id`); the schema should tolerate them.
  it('strips an extra _aps-style shim key', () => {
    const raw = {
      type: 'conversation',
      kind: 'turn-complete',
      sessionId: 'sess_x',
      _aps: { sound: 'default' },
      notification_id: 'apns-12345',
    };
    const parsed = PushNotificationDataSchema.parse(raw);
    expect(parsed).toEqual({
      type: 'conversation',
      kind: 'turn-complete',
      sessionId: 'sess_x',
    });
    expect((parsed as Record<string, unknown>)._aps).toBeUndefined();
  });
});

// ─── Round-trip via JSON.stringify (Expo wire format) ─────────────────

describe('payloads round-trip cleanly through JSON.stringify', () => {
  it.each<PushNotificationData>([
    buildConversationPush({ kind: 'turn-complete', sessionId: 'a' }),
    buildApprovalPush({ kind: 'tool-approval', sessionId: 'b' }),
    buildApprovalPush({ kind: 'staged-file' }),
    buildCoachingPush({ sessionId: 'c' }),
    buildCoachingPush({}),
    buildMeetingAnalysisCompletePush({ sessionId: 'd', meetingTitle: 'Demo' }),
  ])('round-trips %j', (payload) => {
    const wire = JSON.stringify(payload);
    const reparsed = PushNotificationDataSchema.parse(JSON.parse(wire));
    expect(reparsed).toEqual(payload);
  });
});

// ─── Dedup-key bit-identity (preserves legacy format) ─────────────────

describe('buildPushDedupKey preserves legacy `${type}:${kind ?? default}:${sessionId ?? none}` format', () => {
  it('conversation/turn-complete with sessionId', () => {
    expect(
      buildPushDedupKey(buildConversationPush({ kind: 'turn-complete', sessionId: 's1' })),
    ).toBe('conversation:turn-complete:s1');
  });

  it('approval/staged-file without sessionId', () => {
    expect(
      buildPushDedupKey(buildApprovalPush({ kind: 'staged-file' })),
    ).toBe('approval:staged-file:none');
  });

  it('approval/tool-approval with sessionId', () => {
    expect(
      buildPushDedupKey(buildApprovalPush({ kind: 'tool-approval', sessionId: 's2' })),
    ).toBe('approval:tool-approval:s2');
  });

  it('coaching/coaching-card without sessionId', () => {
    expect(
      buildPushDedupKey(buildCoachingPush({})),
    ).toBe('coaching:coaching-card:none');
  });

  it('coaching/coaching-card with sessionId', () => {
    expect(
      buildPushDedupKey(buildCoachingPush({ sessionId: 's3' })),
    ).toBe('coaching:coaching-card:s3');
  });

  it('meeting-analysis-complete falls back to "default" kind segment', () => {
    expect(
      buildPushDedupKey(
        buildMeetingAnalysisCompletePush({ sessionId: 's4', meetingTitle: 'Q3 Planning' }),
      ),
    ).toBe('meeting-analysis-complete:default:s4');
  });
});

describe('getPushDedupKind matches buildPushDedupKey middle segment', () => {
  it('returns kind for conversation/approval/coaching', () => {
    expect(getPushDedupKind(buildConversationPush({ kind: 'question', sessionId: 's' }))).toBe('question');
    expect(getPushDedupKind(buildApprovalPush({ kind: 'memory-approval' }))).toBe('memory-approval');
    expect(getPushDedupKind(buildCoachingPush({}))).toBe('coaching-card');
  });

  it('returns "default" for meeting-analysis-complete (kind-less variant)', () => {
    expect(
      getPushDedupKind(
        buildMeetingAnalysisCompletePush({ sessionId: 's', meetingTitle: 't' }),
      ),
    ).toBe('default');
  });
});
