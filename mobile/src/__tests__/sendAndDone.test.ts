/**
 * sendAndDoneInBackground tests — detached socket, event-driven mark-as-done, timeout safety.
 */

const mockClose = jest.fn();
const mockSocket = { close: mockClose };
let capturedOnEvent: ((event: unknown) => void) | undefined;
let capturedOnError: ((err: unknown) => void) | undefined;
let capturedOnClose: (() => void) | undefined;

const mockCreateSocket = jest.fn<typeof mockSocket, unknown[]>(
  (_req: unknown, onEvent: unknown, onError: unknown, onClose: unknown) => {
    capturedOnEvent = onEvent as (event: unknown) => void;
    capturedOnError = onError as (err: unknown) => void;
    capturedOnClose = onClose as () => void;
    return mockSocket;
  },
);

const mockUpdateSession = jest.fn().mockResolvedValue(undefined);

jest.mock('@rebel/cloud-client', () => ({
  createAgentTurnSocket: (...args: unknown[]) => mockCreateSocket(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  // Brand constructor is an identity cast at runtime; mirror that here.
  asCloudMeetingSessionId: (value: string) => value,
}));

import { sendAndDoneInBackground } from '../utils/sendAndDone';
import { asCloudMeetingSessionId } from '@rebel/cloud-client';
import type { WebFileAttachment } from '@rebel/cloud-client';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  capturedOnEvent = undefined;
  capturedOnClose = undefined;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('sendAndDoneInBackground', () => {
  it('opens a socket with correct sessionId and prompt', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    expect(mockCreateSocket).toHaveBeenCalledWith(
      { sessionId: 'sess-1', prompt: 'Hello' },
      expect.any(Function),
      expect.any(Function), // onError — surfaces pre-ack failures to caller
      expect.any(Function),
    );
  });

  it('does NOT mark done on turn_started alone (waits for the persisted outcome)', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });

    // turn_started only acks; the real outcome (success vs terminal error)
    // arrives on turn_persisted. Marking done here was the silent-failure bug.
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('marks session done (canonical doneAt) when the turn persists as a result', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'result' });

    // doneAt is the canonical lifecycle field, set to a real timestamp.
    // resolvedAt is a distinct co-write (preserved).
    expect(mockUpdateSession).toHaveBeenCalledWith('sess-1', {
      doneAt: expect.any(Number),
      resolvedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    const patch = mockUpdateSession.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.doneAt).toBeGreaterThan(0);
    expect(patch.resolvedAt).toBe(patch.doneAt);
    expect(mockClose).toHaveBeenCalled();
  });

  it('marks session done when the turn persists with no outcome field (older server)', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1' });

    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalled();
  });

  it('ignores non-turn events', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    capturedOnEvent!({ type: 'text_delta', text: 'hi' });

    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('does not archive twice on duplicate turn_persisted', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'result' });
    capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'result' });

    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
  });

  it('falls back to marking done after the persisted-ack timeout (legacy server)', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    expect(mockUpdateSession).not.toHaveBeenCalled();

    // 60s pass with no turn_persisted → fall back to marking done.
    jest.advanceTimersByTime(60_000);
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalled();
  });

  it('marks done when the socket closes after ack without a persisted ack (legacy server)', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    // Legacy server closes after streaming the result, no turn_persisted.
    capturedOnClose!();

    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
  });

  it('closes socket after 30s timeout if turn_started never fires', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    expect(mockClose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(30_000);
    expect(mockClose).toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it('clears the turn_started timeout once turn_started fires (no pre-ack failure)', () => {
    const onFailureBeforeAck = jest.fn();
    sendAndDoneInBackground('sess-1', 'Hello', undefined, { onFailureBeforeAck });

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    // The 30s turn_started timeout must be cleared so it can't fire a spurious
    // pre-ack failure now that we wait for the persisted outcome.
    jest.advanceTimersByTime(30_000);

    expect(onFailureBeforeAck).not.toHaveBeenCalled();
    // Not yet closed — still waiting for the persisted outcome (or its 60s fallback).
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('returns close function that cleans up', () => {
    const handle = sendAndDoneInBackground('sess-1', 'Hello');

    handle.close();
    expect(mockClose).toHaveBeenCalled();
  });

  it('clears timeout on socket close callback', () => {
    sendAndDoneInBackground('sess-1', 'Hello');

    capturedOnClose!();
    jest.advanceTimersByTime(30_000);

    // Socket was already closed externally — timeout should be cleared, no double action
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('handles archive rejection gracefully', async () => {
    mockUpdateSession.mockRejectedValueOnce(new Error('Network error'));
    const onArchiveError = jest.fn();

    sendAndDoneInBackground('sess-1', 'Hello', undefined, { onArchiveError });

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'result' });

    // Flush promise queue — should not throw
    await Promise.resolve();
    expect(mockUpdateSession).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
    expect(onArchiveError).toHaveBeenCalledWith('Couldn\'t mark done — will stay in your conversations');
  });

  it('passes attachments to socket when provided', () => {
    const attachments: WebFileAttachment[] = [
      { id: 'att-1', type: 'image', mimeType: 'image/png', base64Data: 'data', name: 'photo.png' } as WebFileAttachment,
    ];
    sendAndDoneInBackground('sess-1', 'See attached', attachments);

    expect(mockCreateSocket).toHaveBeenCalledWith(
      { sessionId: 'sess-1', prompt: 'See attached', attachments },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('omits attachments from socket when empty array', () => {
    sendAndDoneInBackground('sess-1', 'No attachments', []);

    expect(mockCreateSocket).toHaveBeenCalledWith(
      { sessionId: 'sess-1', prompt: 'No attachments' },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('forwards meetingSessionId and recordingActive to socket request', () => {
    sendAndDoneInBackground('sess-1', 'Meeting question', undefined, {
      meetingSessionId: asCloudMeetingSessionId('meeting-cloud-1'),
      recordingActive: true,
    });

    expect(mockCreateSocket).toHaveBeenCalledWith(
      {
        sessionId: 'sess-1',
        prompt: 'Meeting question',
        meetingSessionId: 'meeting-cloud-1',
        recordingActive: true,
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  describe('onFailureBeforeAck — draft preservation for send-and-done', () => {
    it('fires with reason=error when socket errors before turn_started', () => {
      const onFailureBeforeAck = jest.fn();
      sendAndDoneInBackground('sess-1', 'draft', undefined, { onFailureBeforeAck });

      capturedOnError!(new Error('WS error'));

      expect(onFailureBeforeAck).toHaveBeenCalledWith('error');
    });

    it('fires with reason=closed when socket closes before turn_started', () => {
      const onFailureBeforeAck = jest.fn();
      sendAndDoneInBackground('sess-1', 'draft', undefined, { onFailureBeforeAck });

      capturedOnClose!();

      expect(onFailureBeforeAck).toHaveBeenCalledWith('closed');
    });

    it('fires with reason=timeout when 30s elapses without turn_started', () => {
      const onFailureBeforeAck = jest.fn();
      sendAndDoneInBackground('sess-1', 'draft', undefined, { onFailureBeforeAck });

      jest.advanceTimersByTime(30_000);

      expect(onFailureBeforeAck).toHaveBeenCalledWith('timeout');
    });

    it('does NOT fire after turn_started (ack received)', () => {
      const onFailureBeforeAck = jest.fn();
      sendAndDoneInBackground('sess-1', 'draft', undefined, { onFailureBeforeAck });

      capturedOnEvent!({ type: 'turn_started', turnId: 't1' });
      // A late close after ack must not trigger pre-ack failure.
      capturedOnClose!();

      expect(onFailureBeforeAck).not.toHaveBeenCalled();
    });

    // One-shot guard: a single failed attempt may trigger BOTH onError and
    // onClose (and also timeout if the socket never closes in time). The
    // caller must only be notified once so it doesn't double-toast or
    // double-enqueue a recovery queue item.
    it('fires onFailureBeforeAck at most once when error + close both occur', () => {
      const onFailureBeforeAck = jest.fn();
      sendAndDoneInBackground('sess-1', 'draft', undefined, { onFailureBeforeAck });

      capturedOnError!(new Error('WS error'));
      capturedOnClose!();

      expect(onFailureBeforeAck).toHaveBeenCalledTimes(1);
      expect(onFailureBeforeAck).toHaveBeenCalledWith('error');
    });

    it('fires onFailureBeforeAck at most once when timeout + close both occur', () => {
      const onFailureBeforeAck = jest.fn();
      sendAndDoneInBackground('sess-1', 'draft', undefined, { onFailureBeforeAck });

      jest.advanceTimersByTime(30_000);
      // Timeout closed the socket, which in turn triggers onClose.
      capturedOnClose!();

      expect(onFailureBeforeAck).toHaveBeenCalledTimes(1);
      expect(onFailureBeforeAck).toHaveBeenCalledWith('timeout');
    });
  });

  // Stage 2b — terminal failure AFTER ack must not be marked done silently.
  // A turn that starts but then persists with outcome:"error" (e.g. the
  // Mindstone managed subscription is unreachable from cloud → missing-mindstone)
  // produced no assistant reply. Previously sendAndDone marked done on
  // turn_started and closed the socket, so this signal never arrived and the
  // user saw "sent, done" with no response and no error.
  describe('onTerminalFailure — terminal error / tombstone after ack', () => {
    it('does NOT mark done and surfaces a recoverable failure when the turn persists as an error', () => {
      const onTerminalFailure = jest.fn();
      const onFailureBeforeAck = jest.fn();
      sendAndDoneInBackground('sess-1', 'Hello, world.', undefined, {
        onTerminalFailure,
        onFailureBeforeAck,
      });

      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
      // Cloud streams the terminal route error, then persists outcome:"error".
      capturedOnEvent!({
        type: 'error',
        error: "Your Mindstone subscription isn't ready yet. Open subscription settings, then try again.",
        errorKind: 'connection-not-configured',
        provider: 'Mindstone',
      });
      capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'error' });

      // Must NOT be silently marked done.
      expect(mockUpdateSession).not.toHaveBeenCalled();
      // Must surface a recoverable terminal failure (not a pre-ack failure).
      expect(onFailureBeforeAck).not.toHaveBeenCalled();
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
      const failure = onTerminalFailure.mock.calls[0][0];
      expect(failure.kind).toBe('terminal-error');
      expect(failure.provider).toBe('Mindstone');
      // Honest mobile copy — NOT the misleading "isn't ready yet" string.
      expect(failure.userMessage).toContain('runs on your computer for now');
      expect(failure.userMessage).not.toContain("isn't ready yet");
      expect(mockClose).toHaveBeenCalled();
    });

    it('surfaces a session-tombstoned terminal failure (deleted session) and does NOT mark done', () => {
      const onTerminalFailure = jest.fn();
      sendAndDoneInBackground('sess-1', 'Hello', undefined, { onTerminalFailure });

      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
      capturedOnEvent!({ type: 'session_tombstoned', sessionId: 'sess-1' });

      expect(mockUpdateSession).not.toHaveBeenCalled();
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
      expect(onTerminalFailure.mock.calls[0][0].kind).toBe('session-tombstoned');
      expect(mockClose).toHaveBeenCalled();
    });

    it('surfaces a tombstone even before turn_started (idempotent-replay / fast gate)', () => {
      const onTerminalFailure = jest.fn();
      const onFailureBeforeAck = jest.fn();
      sendAndDoneInBackground('sess-1', 'Hello', undefined, {
        onTerminalFailure,
        onFailureBeforeAck,
      });

      // Server gates and signals tombstone before any turn_started.
      capturedOnEvent!({ type: 'session_tombstoned', sessionId: 'sess-1' });

      expect(mockUpdateSession).not.toHaveBeenCalled();
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
      expect(onTerminalFailure.mock.calls[0][0].kind).toBe('session-tombstoned');
      // A subsequent close must not also fire a pre-ack failure (one-shot).
      capturedOnClose!();
      expect(onFailureBeforeAck).not.toHaveBeenCalled();
    });

    it('does not mark done after a terminal failure even if a late turn_persisted result arrives', () => {
      const onTerminalFailure = jest.fn();
      sendAndDoneInBackground('sess-1', 'Hello', undefined, { onTerminalFailure });

      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
      capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'error' });
      // A stray late event must not flip the outcome to done.
      capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'result' });

      expect(mockUpdateSession).not.toHaveBeenCalled();
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    });
  });

  // F1 (Stage 2c) — a CURRENT server (turn_started.supportsPersistedAck === true)
  // that never sends turn_persisted is an abnormal/failed delivery, NOT success.
  // The legacy fallback (mark-done on close/timeout without turn_persisted) must
  // apply ONLY to legacy/unknown servers (no supportsPersistedAck advertised).
  // Mirrors submitTurnViaSocket's PersistedAckMissingError guard.
  describe('persisted-ack guard — ack-capable (current) servers', () => {
    it('does NOT mark done on socket close without turn_persisted when supportsPersistedAck', () => {
      const onTerminalFailure = jest.fn();
      sendAndDoneInBackground('sess-1', 'Hello', undefined, { onTerminalFailure });

      // Current server advertises persisted-ack support on turn_started.
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1', supportsPersistedAck: true });
      // Socket closes with NO turn_persisted — abnormal for a current server.
      capturedOnClose!();

      // Must NOT silently archive as success.
      expect(mockUpdateSession).not.toHaveBeenCalled();
      // Must surface a recoverable failure instead.
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
      expect(onTerminalFailure.mock.calls[0][0].kind).toBe('delivery-failed');
    });

    it('does NOT mark done on the 60s ack timeout when supportsPersistedAck', () => {
      const onTerminalFailure = jest.fn();
      sendAndDoneInBackground('sess-1', 'Hello', undefined, { onTerminalFailure });

      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1', supportsPersistedAck: true });
      jest.advanceTimersByTime(60_000);

      expect(mockUpdateSession).not.toHaveBeenCalled();
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
      expect(onTerminalFailure.mock.calls[0][0].kind).toBe('delivery-failed');
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
