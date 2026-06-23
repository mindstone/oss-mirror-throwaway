/**
 * Recall Transport
 *
 * Seam between the desktop local-recording flow and the Recall upload backend.
 *
 * The desktop SDK records audio locally and then uploads it for transcription.
 * The three round-trips this needs — create an upload session, poll its status,
 * and fetch the finished transcript — currently go to the Cloudflare Worker,
 * which injects the shared Recall API key and proxies to Recall.
 *
 * This module extracts those three round-trips behind a `RecallTransport`
 * interface so the routing decision (Worker today; a BYOK direct-to-Recall
 * path in a later stage) lives in one place.
 *
 * Stage 1 ships ONLY `WorkerRecallTransport`, which reproduces today's
 * `backendFetch` behaviour byte-for-byte (same routes, same HMAC auth header,
 * same `X-Client-Secret` header, same request/response shapes). The
 * `getRecallTransport(settings)` factory always returns it this stage.
 *
 * NOTE: this is a plain per-use factory, NOT a bootstrap-once singleton/registry.
 * Transport selection is a per-recording runtime decision (it will key off the
 * presence of a user-supplied Recall API key in a later stage), so it must be
 * resolved at each operation boundary rather than registered once at startup.
 */

import { createScopedLogger } from '@core/logger';
import {
  MeetingBotBackendConfigError,
  meetingBotBackendConfigMissingLogContext,
  resolveMeetingBotBackendConfig,
} from '@core/services/meetingBotBackendConfig';
import type { AppSettings } from '@shared/types/settings';
import { generateBackendAuthHeader } from './backendAuth';
import { formatRecallSegments, type RecallTranscriptSegment } from './recallTranscriptFormatter';

const log = createScopedLogger({ service: 'recall-transport' });

/**
 * Recall REST base for the BYOK direct path.
 *
 * `RECALL_API_URL` (the region host) is the same constant the SDK is initialised
 * with in `desktopSdkService.ts:30` — kept in sync here. The worker uses the same
 * host + `/api/v1` REST prefix (`meeting-bot-worker/src/index.ts:30`
 * `RECALL_BASE_URL = 'https://us-west-2.recall.ai/api/v1'`), so the Direct
 * transport must reproduce that exact base.
 */
const RECALL_API_URL = 'https://us-west-2.recall.ai';
const RECALL_REST_BASE = `${RECALL_API_URL}/api/v1`;

// ---------------------------------------------------------------------------
// Result types
//
// Each method returns the parsed result plus the HTTP-level `ok`/`status` and,
// on failure, the raw response body text — so callers can preserve their exact
// branching (`!ok`, `status === 403 | 404`, error-text logging) that they had
// when they held the `Response` object directly.
// ---------------------------------------------------------------------------

/**
 * Body the desktop sends when creating an upload session.
 *
 * `clientSecret` is a Worker-KV concept used for secure multi-device transcript
 * retrieval. The Direct (BYOK) path authenticates with the user's own Recall key
 * and has no such indirection, so it ignores this field — hence it is optional.
 */
export interface CreateUploadSessionRequest {
  meetingTitle: string;
  clientSecret?: string;
}

/** Parsed JSON shape the create round-trip returns on success. */
export interface CreateUploadSessionResponse {
  uploadId: string;
  upload_token?: string;
  /** Legacy field name — Worker should return `upload_token`. */
  uploadUrl?: string;
  /**
   * Recall's native upload id. The Worker hides this behind its own `uploadId`
   * (mapped server-side), so it is unset on the Worker path. The Direct path
   * addresses Recall directly, so it returns the real id here for the caller to
   * persist as `recallUploadId`. On Direct, `uploadId === recallUploadId`.
   */
  recallUploadId?: string;
}

export type CreateUploadSessionResult =
  | { ok: true; status: number; data: CreateUploadSessionResponse }
  | { ok: false; status: number; errorText: string };

/** Parsed JSON shape the status round-trip returns. */
export interface UploadStatusResponse {
  success: boolean;
  status: string;
  transcriptReady?: boolean;
  transcriptFailed?: boolean;
  asyncError?: string | null;
  recordingId?: string;
  transcriptId?: string;
}

export type GetUploadStatusResult =
  | { ok: true; status: number; data: UploadStatusResponse }
  | { ok: false; status: number };

/** Parsed JSON shape the transcript round-trip returns. */
export interface UploadTranscriptResponse {
  success: boolean;
  transcript: string;
  participants: string[];
  duration: number;
  meetingTitle: string;
  startTime: string;
  error?: string;
}

export type GetUploadTranscriptResult =
  | { ok: true; status: number; data: UploadTranscriptResponse }
  | { ok: false; status: number; errorText: string };

/**
 * Identifiers a status/transcript poll needs.
 *
 * - `uploadId`: the id the caller persisted. On the Worker path this is the
 *   worker's own tracking id; the worker maps it to Recall server-side.
 * - `recallUploadId`: Recall's native upload id. REQUIRED by the Direct path
 *   (it addresses Recall directly); ignored by the Worker path.
 * - `clientSecret`: Worker-KV secret for secure transcript retrieval. REQUIRED
 *   by the Worker path; ignored by the Direct path.
 */
export interface UploadPollParams {
  uploadId: string;
  recallUploadId?: string;
  clientSecret?: string;
}

/**
 * Transport for the desktop local-recording upload round-trips.
 *
 * Implementations preserve the exact request/response semantics the
 * `localRecordingService` callers depend on. `clientSecret` is a Worker-KV
 * concept carried for the Worker transport; the Direct (BYOK) transport ignores
 * it and uses `recallUploadId` against Recall's REST API instead.
 */
export interface RecallTransport {
  /** Create an upload session and return the `upload_token` the SDK records with. */
  createUploadSession(request: CreateUploadSessionRequest): Promise<CreateUploadSessionResult>;
  /** Poll the status of an in-flight upload / transcription. */
  getUploadStatus(params: UploadPollParams): Promise<GetUploadStatusResult>;
  /** Fetch the finished, formatted transcript for a completed upload. */
  getUploadTranscript(params: UploadPollParams): Promise<GetUploadTranscriptResult>;
}

/**
 * Make an authenticated request to the Worker backend.
 *
 * This is the exact behaviour of the former `backendFetch` helper in
 * `localRecordingService.ts`: HMAC `X-Mindstone-Auth` header over the user id,
 * `Content-Type: application/json`, against the resolved backend URL. Requires an
 * authenticated user — throws otherwise — identical to the original.
 */
async function backendFetch(
  userId: string | null,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!userId) {
    throw new Error('User not authenticated');
  }

  const config = resolveMeetingBotBackendConfig();
  if (!config.configured) {
    log.error(
      meetingBotBackendConfigMissingLogContext(config.missing),
      'Meeting bot backend config missing; refusing backend request',
    );
    throw new MeetingBotBackendConfigError(config.missing);
  }

  const authHeader = generateBackendAuthHeader(userId);
  if (!authHeader) {
    throw new MeetingBotBackendConfigError(['authKey']);
  }

  const headers = new Headers(options.headers);
  headers.set('X-Mindstone-Auth', authHeader);
  headers.set('Content-Type', 'application/json');

  return fetch(`${config.url}${path}`, {
    ...options,
    headers,
  });
}

/**
 * Worker-backed transport — today's production path.
 *
 * Reproduces the three `backendFetch` round-trips from `localRecordingService`
 * exactly: same routes, same auth, same `X-Client-Secret` header, same parsing.
 */
export class WorkerRecallTransport implements RecallTransport {
  /**
   * @param getUserId resolves the current authenticated user id (or null). The
   *   transport throws on a null user via `backendFetch`, matching the original.
   */
  constructor(private readonly getUserId: () => string | null) {}

  async createUploadSession(request: CreateUploadSessionRequest): Promise<CreateUploadSessionResult> {
    const response = await backendFetch(this.getUserId(), '/api/upload-session', {
      method: 'POST',
      body: JSON.stringify({
        meetingTitle: request.meetingTitle,
        clientSecret: request.clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, errorText };
    }

    const data = (await response.json()) as CreateUploadSessionResponse;
    return { ok: true, status: response.status, data };
  }

  async getUploadStatus(params: UploadPollParams): Promise<GetUploadStatusResult> {
    const response = await backendFetch(
      this.getUserId(),
      `/api/upload-session/status?uploadId=${params.uploadId}`,
      {
        headers: {
          'X-Client-Secret': params.clientSecret ?? '',
        },
      },
    );

    if (!response.ok) {
      return { ok: false, status: response.status };
    }

    const data = (await response.json()) as UploadStatusResponse;
    return { ok: true, status: response.status, data };
  }

  async getUploadTranscript(params: UploadPollParams): Promise<GetUploadTranscriptResult> {
    const response = await backendFetch(
      this.getUserId(),
      `/api/upload-session/transcript?uploadId=${params.uploadId}`,
      {
        headers: {
          'X-Client-Secret': params.clientSecret ?? '',
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, errorText };
    }

    const data = (await response.json()) as UploadTranscriptResponse;
    return { ok: true, status: response.status, data };
  }
}

// ---------------------------------------------------------------------------
// Direct (BYOK) transport — calls Recall's REST API directly with the user's key
//
// This reproduces, client-side, exactly what the worker does for the SDK
// upload path (worker `meeting-bot-worker/src/index.ts`):
//   create   → POST /sdk_upload/                    (index.ts:1948-1960)
//   status   → GET /sdk_upload/{id}/ then
//              GET /recording/{recording_id}/        (index.ts:2025-2068)
//   transcript → GET /sdk_upload/{id}/ → GET /recording/{id}/ →
//                download media_shortcuts.transcript artifact + format
//                                                    (index.ts:2106-2204)
// There is no `clientSecret` / KV indirection here — the user's own key is the
// authority. `recallUploadId` (falling back to `uploadId`, which equals it on
// the Direct path) addresses Recall.
// ---------------------------------------------------------------------------

/** Shape of Recall's `GET /sdk_upload/{id}/` response we read. */
interface RecallSdkUpload {
  id: string;
  status?: { code?: string; sub_code?: string };
  recording_id?: string;
  metadata?: { meeting_title?: string };
  created_at?: string;
}

/** Shape of Recall's `GET /recording/{id}/` response we read. */
interface RecallRecording {
  media_shortcuts?: {
    transcript?: {
      status?: { code?: string };
      data?: { download_url?: string };
    };
  };
}

export class DirectRecallTransport implements RecallTransport {
  /**
   * @param recallApiKey the user-supplied Recall API key (non-empty; the factory
   *   guarantees this). Sent as `Authorization: Token ${recallApiKey}`.
   */
  constructor(private readonly recallApiKey: string) {}

  private authHeaders(extra?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Token ${this.recallApiKey}`,
      ...extra,
    };
  }

  async createUploadSession(request: CreateUploadSessionRequest): Promise<CreateUploadSessionResult> {
    const meetingTitle = request.meetingTitle || 'Local Recording';

    // Mirrors worker handleCreateUploadSession (index.ts:1948-1960). No `user_id`
    // in metadata — there is no worker-side per-user bookkeeping on the direct path.
    const response = await fetch(`${RECALL_REST_BASE}/sdk_upload/`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        metadata: { meeting_title: meetingTitle },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error({ status: response.status }, 'Direct Recall create upload session failed');
      return { ok: false, status: response.status, errorText };
    }

    const recallData = (await response.json()) as {
      id: string;
      upload_token: string;
    };

    // On the Direct path Recall's native id IS the tracking id: `uploadId ===
    // recallUploadId`. The caller persists both (`recallUploadId` is what later
    // status/transcript polls address Recall with).
    return {
      ok: true,
      status: response.status,
      data: {
        uploadId: recallData.id,
        upload_token: recallData.upload_token,
        recallUploadId: recallData.id,
      },
    };
  }

  /** Resolve the Recall id this poll addresses (falls back to uploadId). */
  private recallId(params: UploadPollParams): string {
    return params.recallUploadId || params.uploadId;
  }

  async getUploadStatus(params: UploadPollParams): Promise<GetUploadStatusResult> {
    const recallId = this.recallId(params);

    // Hop 1 — sdk_upload status (index.ts:2025-2041).
    const uploadRes = await fetch(`${RECALL_REST_BASE}/sdk_upload/${recallId}/`, {
      headers: this.authHeaders(),
    });

    if (!uploadRes.ok) {
      log.warn({ status: uploadRes.status }, 'Direct Recall status: sdk_upload fetch failed');
      return { ok: false, status: uploadRes.status };
    }

    const uploadData = (await uploadRes.json()) as RecallSdkUpload;
    const statusCode = uploadData.status?.code;
    const uploadFailed = statusCode === 'failed';

    // Hop 2 — the upload being "complete" only means audio was received; the
    // transcript is generated asynchronously. Read the recording's
    // media_shortcuts.transcript to know whether the text is queryable
    // (index.ts:2043-2068).
    let transcriptReady = false;
    let transcriptFailed = uploadFailed;

    if (statusCode === 'complete' && uploadData.recording_id) {
      const recordingRes = await fetch(`${RECALL_REST_BASE}/recording/${uploadData.recording_id}/`, {
        headers: this.authHeaders(),
      });

      if (recordingRes.ok) {
        const recordingData = (await recordingRes.json()) as RecallRecording;
        const txStatus = recordingData.media_shortcuts?.transcript?.status?.code;
        const hasUrl = !!recordingData.media_shortcuts?.transcript?.data?.download_url;
        transcriptReady = txStatus === 'done' && hasUrl;
        transcriptFailed = txStatus === 'failed';
      }
    }

    return {
      ok: true,
      status: uploadRes.status,
      data: {
        success: true,
        status: statusCode ?? 'unknown',
        transcriptReady,
        transcriptFailed,
        asyncError: uploadData.status?.sub_code ?? null,
        recordingId: uploadData.recording_id,
      },
    };
  }

  async getUploadTranscript(params: UploadPollParams): Promise<GetUploadTranscriptResult> {
    const recallId = this.recallId(params);

    // Get the upload to check status + get recording_id (index.ts:2106-2129).
    const uploadRes = await fetch(`${RECALL_REST_BASE}/sdk_upload/${recallId}/`, {
      headers: this.authHeaders(),
    });

    if (!uploadRes.ok) {
      const errorText = await uploadRes.text();
      log.error({ status: uploadRes.status }, 'Direct Recall transcript: sdk_upload fetch failed');
      return { ok: false, status: uploadRes.status, errorText };
    }

    const uploadData = (await uploadRes.json()) as RecallSdkUpload;

    if (uploadData.status?.code !== 'complete') {
      // Not an HTTP failure — surface as a not-ready transcript result so the
      // caller's retry loop keeps polling (matches the worker returning
      // success:false with a status, index.ts:2123-2124).
      return {
        ok: true,
        status: uploadRes.status,
        data: emptyTranscript('Upload not complete'),
      };
    }

    if (!uploadData.recording_id) {
      return {
        ok: true,
        status: uploadRes.status,
        data: emptyTranscript('No recording ID available'),
      };
    }

    // Get the recording to find the transcript artifact (index.ts:2134-2157).
    const recordingRes = await fetch(`${RECALL_REST_BASE}/recording/${uploadData.recording_id}/`, {
      headers: this.authHeaders(),
    });

    if (!recordingRes.ok) {
      const errorText = await recordingRes.text();
      log.error({ status: recordingRes.status }, 'Direct Recall transcript: recording fetch failed');
      return { ok: false, status: recordingRes.status, errorText };
    }

    const recordingData = (await recordingRes.json()) as RecallRecording;
    const transcriptInfo = recordingData.media_shortcuts?.transcript;
    const downloadUrl = transcriptInfo?.data?.download_url;

    if (!downloadUrl) {
      // Transcript not generated yet — not-ready, keep polling.
      const transcriptStatus = transcriptInfo?.status?.code || 'pending';
      return {
        ok: true,
        status: recordingRes.status,
        data: emptyTranscript(`Transcript not available yet (${transcriptStatus})`),
      };
    }

    // Download the signed transcript artifact (index.ts:2159-2175).
    const transcriptRes = await fetch(downloadUrl);

    if (!transcriptRes.ok) {
      const errorText = await transcriptRes.text();
      log.error({ status: transcriptRes.status }, 'Direct Recall transcript: artifact download failed');
      return { ok: false, status: transcriptRes.status, errorText };
    }

    const segments = (await transcriptRes.json()) as RecallTranscriptSegment[];

    if (!Array.isArray(segments)) {
      log.error('Direct Recall transcript: artifact is not an array');
      return { ok: false, status: 500, errorText: 'Invalid transcript format' };
    }

    // Shared segment→"Speaker: text" formatter (worker index.ts:2178-2204).
    const formatted = formatRecallSegments(segments);

    return {
      ok: true,
      status: transcriptRes.status,
      data: {
        success: true,
        transcript: formatted.transcript,
        participants: formatted.participants,
        duration: formatted.duration,
        meetingTitle: uploadData.metadata?.meeting_title || 'Local Recording',
        startTime: uploadData.created_at || new Date().toISOString(),
      },
    };
  }
}

/** A not-ready transcript payload (success:false) for the retry loop to poll on. */
function emptyTranscript(error: string): UploadTranscriptResponse {
  return {
    success: false,
    transcript: '',
    participants: [],
    duration: 0,
    meetingTitle: '',
    startTime: '',
    error,
  };
}

/**
 * Resolve the transport to use for a recording operation.
 *
 * Plain per-use factory (NOT a bootstrap-once singleton) — transport selection
 * is a per-recording runtime decision, resolved at each operation boundary.
 *
 * Routing: a non-empty (trimmed) `meetingBot.recallApiKey` selects the BYOK
 * `DirectRecallTransport` (calls Recall directly). Otherwise — empty, whitespace,
 * or absent key, i.e. every enterprise/managed user — the `WorkerRecallTransport`
 * is returned, byte-for-byte today's behaviour.
 *
 * @param settings full app settings; `meetingBot.recallApiKey` drives routing.
 * @param getUserId resolves the current authenticated user id for the Worker path.
 */
export function getRecallTransport(
  settings: AppSettings,
  getUserId: () => string | null,
): RecallTransport {
  const recallApiKey = settings.meetingBot?.recallApiKey?.trim();
  if (recallApiKey) {
    log.debug('Resolving Recall transport (direct / BYOK)');
    return new DirectRecallTransport(recallApiKey);
  }
  log.debug('Resolving Recall transport (worker)');
  return new WorkerRecallTransport(getUserId);
}
