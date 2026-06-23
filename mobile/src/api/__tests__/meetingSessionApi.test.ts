import {
  createCloudMeetingSession,
  getCreateMeetingSessionIdempotencyKey,
  resetMeetingSessionIdempotencyKeyStateForTesting,
  rotateCreateMeetingSessionIdempotencyKey,
} from '../meetingSessionApi';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
  resetMeetingSessionIdempotencyKeyStateForTesting();
});

describe('meetingSessionApi', () => {
  it('sends companionSessionId + X-Idempotency-Key on create', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'cloud-session-1' }),
    });

    const result = await createCloudMeetingSession({
      cloudUrl: 'https://mock-cloud.test',
      token: 'token-1',
      localMeetingSessionId: 'meeting-local-1',
      meetingTitle: 'Roadmap',
      meetingStartTime: 123,
      companionSessionId: 'companion-1',
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 'cloud-session-1',
      idempotencyKey: 'meeting-meeting-local-1',
      status: 201,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://mock-cloud.test/api/meeting/session/create',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Idempotency-Key': 'meeting-meeting-local-1',
        }),
        body: JSON.stringify({ companionSessionId: 'companion-1' }),
      }),
    );
  });

  it('returns idempotency_conflict for 409 responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'MEETING_SESSION_IDEMPOTENCY_CONFLICT' } }),
    });

    const result = await createCloudMeetingSession({
      cloudUrl: 'https://mock-cloud.test',
      token: 'token-1',
      localMeetingSessionId: 'meeting-local-1',
      meetingStartTime: 123,
    });

    expect(result).toEqual({
      ok: false,
      kind: 'idempotency_conflict',
      status: 409,
      idempotencyKey: 'meeting-meeting-local-1',
    });
  });

  it('rotates idempotency key after conflicts', () => {
    expect(getCreateMeetingSessionIdempotencyKey('meeting-local-1')).toBe('meeting-meeting-local-1');
    rotateCreateMeetingSessionIdempotencyKey('meeting-local-1');
    expect(getCreateMeetingSessionIdempotencyKey('meeting-local-1')).toBe('meeting-meeting-local-1-retry-1');
  });
});
