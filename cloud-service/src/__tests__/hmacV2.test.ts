import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHmacV2Signature,
  resetHmacV2NonceCacheForTesting,
  verifyIncomingHmacV2,
} from '../utils/hmacV2';

describe('hmacV2 verification', () => {
  const secret = 'test-shared-secret';
  const rawBody = JSON.stringify({ hello: 'world' });
  const timestampSeconds = 1_700_000_000;
  const nowMs = timestampSeconds * 1000;
  const timestamp = String(timestampSeconds);

  function buildHeaders(args: {
    nonce: string;
    timestamp?: string;
    signingSecret?: string;
  }): Record<string, string> {
    const headerTimestamp = args.timestamp ?? timestamp;
    const signature = createHmacV2Signature({
      secret: args.signingSecret ?? secret,
      timestamp: headerTimestamp,
      nonce: args.nonce,
      rawBody,
    });
    return {
      'x-mindstone-timestamp': headerTimestamp,
      'x-mindstone-nonce': args.nonce,
      'x-mindstone-signature': signature,
    };
  }

  beforeEach(() => {
    resetHmacV2NonceCacheForTesting();
  });

  it('accepts a valid signature', () => {
    const nonce = 'nonce-1';

    const result = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs,
      headers: buildHeaders({ nonce }),
    });

    expect(result).toEqual({
      valid: true,
      timestampSeconds,
      nonce,
    });
  });

  it('rejects missing headers', () => {
    const result = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs,
      headers: {},
    });
    expect(result).toEqual({
      valid: false,
      reason: 'missing_headers',
    });
  });

  it.each([
    { caseName: 'timestamp', omit: 'x-mindstone-timestamp' },
    { caseName: 'nonce', omit: 'x-mindstone-nonce' },
    { caseName: 'signature', omit: 'x-mindstone-signature' },
  ])('rejects when the $caseName header is missing', ({ omit }) => {
    const headers = buildHeaders({ nonce: 'nonce-missing-header' });
    delete headers[omit as keyof typeof headers];

    const result = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs,
      headers,
    });

    expect(result).toEqual({
      valid: false,
      reason: 'missing_headers',
    });
  });

  it('rejects malformed nonnumeric timestamp values', () => {
    const malformedTimestamp = '1700000000abc';
    const nonce = 'nonce-malformed-ts';
    const headers = buildHeaders({
      nonce,
      timestamp: malformedTimestamp,
    });

    const result = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs,
      headers,
    });

    expect(result).toEqual({
      valid: false,
      reason: 'invalid_timestamp_format',
    });
  });

  it('rejects expired timestamps', () => {
    const nonce = 'nonce-expired';

    const result = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs: nowMs + (5 * 60 * 1000) + 1,
      headers: buildHeaders({ nonce }),
    });
    expect(result).toEqual({
      valid: false,
      reason: 'expired_timestamp',
    });
  });

  it('rejects replayed nonces', () => {
    const nonce = 'nonce-replayed';
    const headers = buildHeaders({ nonce });

    const first = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs,
      headers,
    });
    expect(first.valid).toBe(true);

    const replayed = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs: nowMs + 1_000,
      headers,
    });
    expect(replayed).toEqual({
      valid: false,
      reason: 'nonce_replay',
    });
  });

  it('evicts nonce entries after TTL and accepts the same nonce again after 10 minutes + 1ms', () => {
    const nonce = 'nonce-ttl-eviction';
    const headers = buildHeaders({ nonce });

    const first = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs,
      maxClockSkewMs: 15 * 60 * 1000,
      headers,
    });
    expect(first.valid).toBe(true);

    const second = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs: nowMs + (10 * 60 * 1000) + 1,
      maxClockSkewMs: 15 * 60 * 1000,
      headers,
    });
    expect(second).toEqual({
      valid: true,
      timestampSeconds,
      nonce,
    });
  });

  it('rejects mangled signatures', () => {
    const nonce = 'nonce-bad-sig';
    const headers = buildHeaders({ nonce });
    const mangledSignature = `${headers['x-mindstone-signature'].slice(0, -1)}0`;

    const result = verifyIncomingHmacV2({
      rawBody,
      secret,
      nowMs,
      headers: {
        'x-mindstone-timestamp': headers['x-mindstone-timestamp'],
        'x-mindstone-nonce': headers['x-mindstone-nonce'],
        'x-mindstone-signature': mangledSignature,
      },
    });
    expect(result).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });
});
