const mockCreateAgentTurnSocket = jest.fn<{ close: jest.Mock }, unknown[]>();
const mockHashForBreadcrumb = jest.fn<string, unknown[]>(
  (value: unknown) => `hash:${String(value)}`,
);
const mockRecordContinuityBreadcrumb = jest.fn();

type SocketCallbacks = {
  onEvent: (event: unknown) => void;
  onError: (err: Error) => void;
  onClose: (code: number, reason: string) => void;
  close: jest.Mock;
  request: Record<string, unknown>;
};

const socketCallbacks: SocketCallbacks[] = [];

jest.mock('@rebel/cloud-client', () => ({
  // Pure live-meeting id casts (zero-import module) so a future pure cast added
  // there needs no mock edit. See meetingRecordingContext.test.tsx for rationale.
  ...(jest.requireActual('../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../cloud-client/src/types/liveMeetingIds')),
  createAgentTurnSocket: (...args: unknown[]) => mockCreateAgentTurnSocket(...args),
  hashForBreadcrumb: (...args: unknown[]) => mockHashForBreadcrumb(...args),
}));

jest.mock('./continuityBreadcrumbs', () => ({
  recordContinuityBreadcrumb: (...args: unknown[]) => mockRecordContinuityBreadcrumb(...args),
}));

import { asCloudMeetingSessionId } from '@rebel/cloud-client';
import {
  submitTurnViaSocket,
  PersistedAckMissingError,
  TurnInFlightError,
  TurnFailedError,
} from './submitTurnViaSocket';

function getSocket(index = 0): SocketCallbacks {
  const socket = socketCallbacks[index];
  if (!socket) throw new Error(`No socket at index ${index}`);
  return socket;
}

beforeEach(() => {
  jest.useFakeTimers();
  socketCallbacks.length = 0;
  mockCreateAgentTurnSocket.mockReset();
  mockHashForBreadcrumb.mockClear();
  mockRecordContinuityBreadcrumb.mockClear();

  mockCreateAgentTurnSocket.mockImplementation((...args: unknown[]) => {
    const [request, onEvent, onError, onClose] = args as [
      Record<string, unknown>,
      (event: unknown) => void,
      ((err: Error) => void) | undefined,
      ((code: number, reason: string) => void) | undefined,
    ];
    const close = jest.fn();
    socketCallbacks.push({
      request,
      onEvent,
      onError: onError ?? (() => undefined),
      onClose: onClose ?? (() => undefined),
      close,
    });
    return { close };
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('submitTurnViaSocket', () => {
  it('resolves on turn_persisted (not turn_started)', async () => {
    const resultPromise = submitTurnViaSocket('session-1', 'hello', { clientTurnId: 'client-turn-1' });
    const socket = getSocket(0);

    expect(socket.request).toEqual({
      sessionId: 'session-1',
      prompt: 'hello',
      clientTurnId: 'client-turn-1',
    });

    let settled = false;
    void resultPromise.then(() => { settled = true; });

    socket.onEvent({ type: 'turn_started', turnId: 'turn-1' });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.onEvent({ type: 'turn_persisted', turnId: 'turn-1' });
    await expect(resultPromise).resolves.toMatchObject({
      clientTurnId: 'client-turn-1',
      turnId: 'turn-1',
    });
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(mockRecordContinuityBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'outbox',
        message: 'turn-persisted',
      }),
    );
  });

  it('forwards meetingSessionId and recordingActive in the socket request', async () => {
    const resultPromise = submitTurnViaSocket('session-1', 'hello', {
      clientTurnId: 'client-turn-opts',
      meetingSessionId: asCloudMeetingSessionId('meeting-cloud-1'),
      recordingActive: true,
    });
    const socket = getSocket(0);

    expect(socket.request).toEqual({
      sessionId: 'session-1',
      prompt: 'hello',
      clientTurnId: 'client-turn-opts',
      meetingSessionId: 'meeting-cloud-1',
      recordingActive: true,
    });

    socket.onEvent({ type: 'turn_started', turnId: 'turn-opts' });
    socket.onEvent({ type: 'turn_persisted', turnId: 'turn-opts' });
    await expect(resultPromise).resolves.toMatchObject({
      clientTurnId: 'client-turn-opts',
      turnId: 'turn-opts',
    });
  });

  it('includes live companion cloud meeting metadata for convo-A turn submission', async () => {
    const resultPromise = submitTurnViaSocket('convo-A', 'Can you summarize that?', {
      clientTurnId: 'client-turn-convo-a',
      meetingSessionId: asCloudMeetingSessionId('cloud-meet-123'),
      recordingActive: true,
    });
    const socket = getSocket(0);

    expect(socket.request).toEqual({
      sessionId: 'convo-A',
      prompt: 'Can you summarize that?',
      clientTurnId: 'client-turn-convo-a',
      meetingSessionId: 'cloud-meet-123',
      recordingActive: true,
    });

    socket.onEvent({ type: 'turn_started', turnId: 'turn-convo-a' });
    socket.onEvent({ type: 'turn_persisted', turnId: 'turn-convo-a' });
    await expect(resultPromise).resolves.toMatchObject({
      clientTurnId: 'client-turn-convo-a',
      turnId: 'turn-convo-a',
    });
  });

  it('reuses the same clientTurnId across retry attempts', async () => {
    const firstAttempt = submitTurnViaSocket('session-2', 'retry me', { clientTurnId: 'stable-client-turn' });
    const firstSocket = getSocket(0);
    expect(firstSocket.request.clientTurnId).toBe('stable-client-turn');

    firstSocket.onError(new Error('network drop'));
    await expect(firstAttempt).rejects.toThrow('network drop');

    const secondAttempt = submitTurnViaSocket('session-2', 'retry me', { clientTurnId: 'stable-client-turn' });
    const secondSocket = getSocket(1);
    expect(secondSocket.request.clientTurnId).toBe('stable-client-turn');

    secondSocket.onEvent({ type: 'turn_started', turnId: 'turn-2' });
    secondSocket.onEvent({ type: 'turn_persisted', turnId: 'turn-2' });
    await expect(secondAttempt).resolves.toMatchObject({
      clientTurnId: 'stable-client-turn',
      turnId: 'turn-2',
    });
  });

  it('rejects with PersistedAckMissingError when supportsPersistedAck=true and ack is missing for 60s', async () => {
    const resultPromise = submitTurnViaSocket('session-3', 'legacy server', { clientTurnId: 'client-turn-3' });
    const socket = getSocket(0);

    socket.onEvent({ type: 'turn_started', turnId: 'turn-3', supportsPersistedAck: true });

    let settled = false;
    void resultPromise.catch(() => { settled = true; });

    jest.advanceTimersByTime(59_999);
    await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    await expect(resultPromise).rejects.toBeInstanceOf(PersistedAckMissingError);
    expect(mockRecordContinuityBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'outbox',
        message: 'persisted-ack-missing',
        level: 'error',
      }),
    );
  });

  it('resolves degraded:true when supportsPersistedAck is absent and ack is missing for 60s', async () => {
    const resultPromise = submitTurnViaSocket('session-4', 'legacy server', { clientTurnId: 'client-turn-4' });
    const socket = getSocket(0);

    socket.onEvent({ type: 'turn_started', turnId: 'turn-4' });

    jest.advanceTimersByTime(60_000);
    await expect(resultPromise).resolves.toMatchObject({
      clientTurnId: 'client-turn-4',
      turnId: 'turn-4',
      degraded: true,
    });
  });

  it('rejects with TurnFailedError when the turn is persisted with outcome:"error" (terminal route)', async () => {
    const resultPromise = submitTurnViaSocket('session-mindstone', 'Hello, world.', {
      clientTurnId: 'client-turn-err',
    });
    const socket = getSocket(0);

    let settled = false;
    void resultPromise.catch(() => { settled = true; });

    socket.onEvent({ type: 'turn_started', turnId: 'turn-err', supportsPersistedAck: true });
    // Executor streams the terminal route-decision error before persistence.
    socket.onEvent({
      type: 'error',
      error: "Your Mindstone subscription isn't ready yet. Open subscription settings, then try again.",
      errorKind: 'connection-not-configured',
      provider: 'Mindstone',
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Cloud persists the turn as an error — must NOT resolve success.
    socket.onEvent({ type: 'turn_persisted', turnId: 'turn-err', outcome: 'error' });

    await expect(resultPromise).rejects.toBeInstanceOf(TurnFailedError);
    await resultPromise.catch((err: TurnFailedError) => {
      // Mobile-appropriate copy: NOT the misleading "subscription isn't ready".
      expect(err.details.userMessage).toContain('runs on your computer for now');
      expect(err.details.userMessage).not.toContain("isn't ready yet");
      expect(err.details.provider).toBe('Mindstone');
      expect(err.details.errorKind).toBe('connection-not-configured');
    });
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(mockRecordContinuityBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'outbox',
        message: 'turn-persisted-error',
        level: 'warning',
      }),
    );
  });

  it('still resolves success when the turn is persisted with outcome:"result"', async () => {
    const resultPromise = submitTurnViaSocket('session-ok', 'hi', { clientTurnId: 'client-turn-ok' });
    const socket = getSocket(0);

    socket.onEvent({ type: 'turn_started', turnId: 'turn-ok', supportsPersistedAck: true });
    socket.onEvent({ type: 'turn_persisted', turnId: 'turn-ok', outcome: 'result' });

    await expect(resultPromise).resolves.toMatchObject({
      clientTurnId: 'client-turn-ok',
      turnId: 'turn-ok',
    });
  });

  it('rejects with TurnFailedError on an idempotent-replay persisted error (no preceding error event)', async () => {
    const resultPromise = submitTurnViaSocket('session-replay', 'retry', { clientTurnId: 'client-turn-replay' });
    const socket = getSocket(0);

    // Idempotent replay: server sends turn_persisted (outcome:error) without turn_started.
    socket.onEvent({ type: 'turn_persisted', turnId: 'turn-replay', outcome: 'error' });

    await expect(resultPromise).rejects.toBeInstanceOf(TurnFailedError);
    await resultPromise.catch((err: TurnFailedError) => {
      // No provider context available on replay → falls back to generic recoverable copy.
      expect(err.details.userMessage.length).toBeGreaterThan(0);
    });
  });

  it('rejects with TurnInFlightError when server reports turn_in_flight', async () => {
    const resultPromise = submitTurnViaSocket('session-4', 'conflict', { clientTurnId: 'client-turn-4' });
    const socket = getSocket(0);

    socket.onEvent({ type: 'turn_in_flight', turnId: 'turn-4' });

    await expect(resultPromise).rejects.toBeInstanceOf(TurnInFlightError);
    expect(mockRecordContinuityBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'outbox',
        message: 'in-flight-conflict',
      }),
    );
  });
});
