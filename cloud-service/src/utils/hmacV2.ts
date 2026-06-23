import { createHmac, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { log, readRawBody, RouteError, sendJson, sendRouteError } from '../httpUtils';
import { transcriptSegmentPayloadSchema } from '../schemas/transcriptSegment';
import type { CloudRollingTranscript } from '../services/cloudRollingTranscript';

const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_NONCE_ENTRIES = 10_000;

const seenNonceExpirations = new Map<string, number>();

export type HmacV2VerificationFailureReason =
  | 'missing_secret'
  | 'missing_headers'
  | 'invalid_timestamp_format'
  | 'expired_timestamp'
  | 'malformed_signature'
  | 'signature_mismatch'
  | 'nonce_replay';

export type HmacV2VerificationResult =
  | { valid: true; timestampSeconds: number; nonce: string }
  | { valid: false; reason: HmacV2VerificationFailureReason };

interface VerifyIncomingHmacV2Args {
  rawBody: string;
  headers: http.IncomingHttpHeaders;
  secret: string | undefined;
  nowMs?: number;
  maxClockSkewMs?: number;
  nonceTtlMs?: number;
  maxNonceEntries?: number;
}

interface HandleMeetingTranscriptSegmentReceiveArgs {
  rollingTranscript: CloudRollingTranscript;
  receiveEnabled: boolean;
  hmacSecret: string | undefined;
  nowMs?: () => number;
}

function getHeaderValue(headers: http.IncomingHttpHeaders, headerName: string): string | null {
  const raw = headers[headerName.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === 'string' ? raw : null;
}

function pruneNonceCache(nowMs: number, maxNonceEntries: number): void {
  for (const [nonce, expiresAtMs] of seenNonceExpirations.entries()) {
    if (expiresAtMs > nowMs) continue;
    seenNonceExpirations.delete(nonce);
  }

  while (seenNonceExpirations.size > maxNonceEntries) {
    const oldestNonce = seenNonceExpirations.keys().next().value;
    if (!oldestNonce) break;
    seenNonceExpirations.delete(oldestNonce);
  }
}

function stableEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function createHmacV2Signature(args: {
  secret: string;
  timestamp: string | number;
  nonce: string;
  rawBody: string;
}): string {
  return createHmac('sha256', args.secret)
    .update(`${args.timestamp}.${args.nonce}.${args.rawBody}`)
    .digest('hex');
}

export function verifyIncomingHmacV2(args: VerifyIncomingHmacV2Args): HmacV2VerificationResult {
  const nowMs = args.nowMs ?? Date.now();
  const maxClockSkewMs = args.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const nonceTtlMs = args.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
  const maxNonceEntries = args.maxNonceEntries ?? DEFAULT_MAX_NONCE_ENTRIES;

  if (!args.secret) {
    return { valid: false, reason: 'missing_secret' };
  }

  const timestampRaw = getHeaderValue(args.headers, 'x-mindstone-timestamp');
  const nonce = getHeaderValue(args.headers, 'x-mindstone-nonce');
  const signature = getHeaderValue(args.headers, 'x-mindstone-signature');
  if (!timestampRaw || !nonce || !signature) {
    return { valid: false, reason: 'missing_headers' };
  }

  if (!/^-?\d+$/.test(timestampRaw)) {
    return { valid: false, reason: 'invalid_timestamp_format' };
  }

  const timestampSeconds = Number(timestampRaw);
  if (!Number.isFinite(timestampSeconds) || !Number.isInteger(timestampSeconds) || timestampSeconds <= 0) {
    return { valid: false, reason: 'invalid_timestamp_format' };
  }

  const timestampMs = timestampSeconds * 1000;
  if (Math.abs(nowMs - timestampMs) > maxClockSkewMs) {
    return { valid: false, reason: 'expired_timestamp' };
  }

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return { valid: false, reason: 'malformed_signature' };
  }

  pruneNonceCache(nowMs, maxNonceEntries);
  const existingNonceExpiry = seenNonceExpirations.get(nonce);
  if (existingNonceExpiry && existingNonceExpiry > nowMs) {
    return { valid: false, reason: 'nonce_replay' };
  }

  const expectedSignature = createHmacV2Signature({
    secret: args.secret,
    timestamp: timestampRaw,
    nonce,
    rawBody: args.rawBody,
  });

  if (!stableEqual(signature.toLowerCase(), expectedSignature)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  seenNonceExpirations.set(nonce, nowMs + nonceTtlMs);
  pruneNonceCache(nowMs, maxNonceEntries);
  return { valid: true, timestampSeconds, nonce };
}

export async function handleMeetingTranscriptSegmentReceive(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  args: HandleMeetingTranscriptSegmentReceiveArgs,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', {
      status: 405,
      message: 'Only POST is allowed',
    }));
  }

  if (!args.receiveEnabled) {
    return sendJson(res, 503, { error: 'feature_disabled' });
  }

  const nowMs = args.nowMs?.() ?? Date.now();
  let rawBody: string;
  let parsedBody: unknown;
  try {
    const bodyResult = await readRawBody(req);
    rawBody = bodyResult.raw.toString('utf-8');
    parsedBody = bodyResult.parsed;
  } catch (error) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', {
      status: 400,
      message: error instanceof Error ? error.message : 'Invalid transcript payload',
    }));
  }

  const verification = verifyIncomingHmacV2({
    rawBody,
    headers: req.headers,
    secret: args.hmacSecret,
    nowMs,
  });
  if (!verification.valid) {
    args.rollingTranscript.recordAuthOutcome(false, nowMs);
    log({ level: 'warn', msg: 'meetingTranscriptAuthRejected', reason: verification.reason });
    if (verification.reason === 'nonce_replay') {
      log({ level: 'warn', msg: 'meetingTranscriptNonceReplay' });
    }
    return sendRouteError(res, undefined, new RouteError('UNAUTHORIZED', {
      status: 401,
      message: 'Invalid transcript signature',
      details: { reason: verification.reason },
    }));
  }

  args.rollingTranscript.recordAuthOutcome(true, nowMs);
  const parseResult = transcriptSegmentPayloadSchema.safeParse(parsedBody);
  if (!parseResult.success) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', {
      status: 400,
      message: parseResult.error.issues[0]?.message ?? 'Invalid transcript payload',
    }));
  }
  args.rollingTranscript.appendSegments(
    parseResult.data.recallBotId,
    parseResult.data.segments,
    parseResult.data.meetingTitle,
  );
  log({
    level: 'info',
    msg: 'meetingTranscriptIngestAccepted',
    recallBotId: parseResult.data.recallBotId,
    segmentCount: parseResult.data.segments.length,
    firstSegmentId: parseResult.data.segments[0]?.segmentId ?? null,
  });
  return sendJson(res, 200, { accepted: true });
}

export function resetHmacV2NonceCacheForTesting(): void {
  seenNonceExpirations.clear();
}
