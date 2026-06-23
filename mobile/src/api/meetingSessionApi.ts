const createSessionIdempotencyRetries = new Map<string, number>();

export interface CreateCloudMeetingSessionArgs {
  cloudUrl: string;
  token: string;
  localMeetingSessionId: string;
  meetingTitle?: string;
  meetingStartTime: number;
  companionSessionId?: string | null;
}

export type CreateCloudMeetingSessionResult =
  | { ok: true; sessionId: string; idempotencyKey: string; status: number }
  | { ok: false; kind: 'auth_expired' | 'idempotency_conflict' | 'server_error' | 'invalid_response' | 'network_error'; status?: number; idempotencyKey: string };

export function getCreateMeetingSessionIdempotencyKey(localMeetingSessionId: string): string {
  const retryCount = createSessionIdempotencyRetries.get(localMeetingSessionId) ?? 0;
  if (retryCount <= 0) {
    return `meeting-${localMeetingSessionId}`;
  }
  return `meeting-${localMeetingSessionId}-retry-${retryCount}`;
}

export function rotateCreateMeetingSessionIdempotencyKey(localMeetingSessionId: string): string {
  const nextRetryCount = (createSessionIdempotencyRetries.get(localMeetingSessionId) ?? 0) + 1;
  createSessionIdempotencyRetries.set(localMeetingSessionId, nextRetryCount);
  return getCreateMeetingSessionIdempotencyKey(localMeetingSessionId);
}

export async function createCloudMeetingSession(args: CreateCloudMeetingSessionArgs): Promise<CreateCloudMeetingSessionResult> {
  const idempotencyKey = getCreateMeetingSessionIdempotencyKey(args.localMeetingSessionId);

  const body = JSON.stringify({
    companionSessionId: args.companionSessionId ?? null,
  });

  let response: Response;
  try {
    response = await fetch(`${args.cloudUrl}/api/meeting/session/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.token}`,
        'Content-Type': 'application/json',
        'X-Meeting-Title': encodeURIComponent(args.meetingTitle || ''),
        'X-Meeting-Start-Time': String(args.meetingStartTime),
        'X-Idempotency-Key': idempotencyKey,
      },
      body,
    });
  } catch {
    return {
      ok: false,
      kind: 'network_error',
      idempotencyKey,
    };
  }

  if (response.status === 401) {
    return { ok: false, kind: 'auth_expired', status: response.status, idempotencyKey };
  }
  if (response.status === 409) {
    return { ok: false, kind: 'idempotency_conflict', status: response.status, idempotencyKey };
  }
  if (response.status >= 500) {
    return { ok: false, kind: 'server_error', status: response.status, idempotencyKey };
  }
  if (!response.ok) {
    return { ok: false, kind: 'invalid_response', status: response.status, idempotencyKey };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, kind: 'invalid_response', status: response.status, idempotencyKey };
  }

  const sessionId = typeof (parsed as { sessionId?: unknown })?.sessionId === 'string'
    ? (parsed as { sessionId: string }).sessionId
    : null;
  if (!sessionId) {
    return { ok: false, kind: 'invalid_response', status: response.status, idempotencyKey };
  }

  return {
    ok: true,
    sessionId,
    idempotencyKey,
    status: response.status,
  };
}

export function resetMeetingSessionIdempotencyKeyStateForTesting(): void {
  createSessionIdempotencyRetries.clear();
}
