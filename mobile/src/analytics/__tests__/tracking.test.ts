/**
 * Stage B3 — the typed event taxonomy (`tracking.ts`) maps each user-facing
 * wrapper to the correct event name + properties on the gated `analytics`
 * singleton. These tests assert the WRAPPER → singleton contract; the singleton
 * itself (gating, surface tag, redaction) is covered by analytics.test.ts /
 * redaction.test.ts. We mock the singleton so these tests are pure mapping
 * assertions and never touch the SDK.
 */

const mockTrack = jest.fn();
const mockIdentify = jest.fn();
const mockReset = jest.fn();

jest.mock('../analytics', () => ({
  analytics: {
    track: (...args: unknown[]) => mockTrack(...args),
    identify: (...args: unknown[]) => mockIdentify(...args),
    reset: (...args: unknown[]) => mockReset(...args),
  },
}));

import { tracking, identifyByEmail, resetIdentity } from '../tracking';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('app lifecycle events', () => {
  it('appOpened → "App Opened"', () => {
    tracking.appOpened();
    expect(mockTrack).toHaveBeenCalledWith('App Opened');
  });

  it('appBackgrounded → "App Backgrounded"', () => {
    tracking.appBackgrounded();
    expect(mockTrack).toHaveBeenCalledWith('App Backgrounded');
  });
});

describe('pairing lifecycle events', () => {
  it('pair.started → "Pair Started" with method', () => {
    tracking.pair.started('scan');
    expect(mockTrack).toHaveBeenCalledWith('Pair Started', { method: 'scan' });
  });

  it('pair.succeeded → "Pair Succeeded" with method', () => {
    tracking.pair.succeeded('manual');
    expect(mockTrack).toHaveBeenCalledWith('Pair Succeeded', { method: 'manual' });
  });

  it('pair.failed → "Pair Failed" with method + coarse reason (no raw error)', () => {
    tracking.pair.failed('scan', 'auth');
    expect(mockTrack).toHaveBeenCalledWith('Pair Failed', { method: 'scan', reason: 'auth' });
  });

  it('pair.unpaired → "Unpaired"', () => {
    tracking.pair.unpaired();
    expect(mockTrack).toHaveBeenCalledWith('Unpaired');
  });
});

describe('navigation', () => {
  it('screenViewed → "Screen Viewed" with route name', () => {
    tracking.screenViewed('(tabs)/inbox');
    expect(mockTrack).toHaveBeenCalledWith('Screen Viewed', { name: '(tabs)/inbox' });
  });
});

describe('key UI actions (no content, UI-origin only)', () => {
  it('messageSent → "Message Sent" with shape-only props (never content)', () => {
    tracking.messageSent({ source: 'text', hasAttachments: true, online: false });
    expect(mockTrack).toHaveBeenCalledWith('Message Sent', {
      source: 'text',
      hasAttachments: true,
      online: false,
    });
    // Belt-and-braces: no content-shaped property is ever passed.
    const props = mockTrack.mock.calls[0][1] as Record<string, unknown>;
    expect(props).not.toHaveProperty('prompt');
    expect(props).not.toHaveProperty('message');
    expect(props).not.toHaveProperty('content');
  });

  it('voiceRecordingCompleted → "Voice Recording Completed" with durationMs only', () => {
    tracking.voiceRecordingCompleted({ durationMs: 4200 });
    expect(mockTrack).toHaveBeenCalledWith('Voice Recording Completed', { durationMs: 4200 });
  });

  it('approvalResolved (approved) → "Approval Resolved" with resolution + allowForSession', () => {
    tracking.approvalResolved({ resolution: 'approved', allowForSession: true });
    expect(mockTrack).toHaveBeenCalledWith('Approval Resolved', {
      resolution: 'approved',
      allowForSession: true,
    });
  });

  it('approvalResolved (denied) → "Approval Resolved"', () => {
    tracking.approvalResolved({ resolution: 'denied' });
    expect(mockTrack).toHaveBeenCalledWith('Approval Resolved', { resolution: 'denied' });
  });

  it('inboxActionTapped → "Inbox Action Tapped" with action enum', () => {
    tracking.inboxActionTapped({ action: 'execute' });
    expect(mockTrack).toHaveBeenCalledWith('Inbox Action Tapped', { action: 'execute' });
  });
});

describe('identity (matches desktop: identify by email, reset on unpair)', () => {
  it('identifyByEmail → singleton.identify(email)', () => {
    identifyByEmail('worker@example.com');
    expect(mockIdentify).toHaveBeenCalledWith('worker@example.com');
  });

  it('resetIdentity → singleton.reset() (keeps anonymousId by default)', () => {
    resetIdentity();
    expect(mockReset).toHaveBeenCalledWith();
  });
});

describe('taxonomy is a focused, boring set (no core/agent events)', () => {
  it('never references excluded core-origin event names', () => {
    // Drive every wrapper, then assert no excluded (server-side) event leaked.
    tracking.appOpened();
    tracking.appBackgrounded();
    tracking.pair.started('scan');
    tracking.pair.succeeded('scan');
    tracking.pair.failed('scan', 'network');
    tracking.pair.unpaired();
    tracking.screenViewed('(tabs)/index');
    tracking.messageSent({ source: 'voice', hasAttachments: false, online: true });
    tracking.voiceRecordingCompleted({ durationMs: 1000 });
    tracking.approvalResolved({ resolution: 'approved' });
    tracking.inboxActionTapped({ action: 'archive' });

    const emittedEvents = mockTrack.mock.calls.map((call) => call[0] as string);
    const EXCLUDED = [
      'Agent Turn Completed',
      'Agent Turn Error',
      'STT Transcription Completed',
      'Daily Cost Summary',
      'Memory Update Turn Completed',
      'Daily Time Saved Summary',
      'Watchdog Self-Resolved',
    ];
    for (const excluded of EXCLUDED) {
      expect(emittedEvents).not.toContain(excluded);
    }
    // The full mobile set is small (the partition is intentionally boring).
    expect(new Set(emittedEvents).size).toBeLessThanOrEqual(12);
  });
});
