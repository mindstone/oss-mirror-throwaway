import { describe, expect, it } from 'vitest';
import {
  ALL_CHAT_ERROR_CODES,
  mapErrorResponse,
  mapFetchException,
  type ChatErrorCode,
} from '../errors';

const asChatErrorCode = (code: ChatErrorCode): ChatErrorCode => code;

describe('mapErrorResponse', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [410, 'GONE'],
    [501, 'UNSUPPORTED'],
    [503, 'BRIDGE_UNAVAILABLE'],
    [500, 'BRIDGE_ERROR'],
    [502, 'BRIDGE_ERROR'],
    [504, 'BRIDGE_ERROR'],
  ] as const)('maps status %s to %s', (status, expectedCode) => {
    const mapped = mapErrorResponse(status, null);
    expect(mapped.code).toBe(expectedCode);
  });

  it('extracts body message from JSON {"error":"foo"}', () => {
    const mapped = mapErrorResponse(400, '{"error":"foo"}');
    expect(mapped.code).toBe('BAD_REQUEST');
    expect(mapped.message).toBe('foo');
  });

  it('extracts body message from JSON {"error":{"message":"bar"}}', () => {
    const mapped = mapErrorResponse(400, '{"error":{"message":"bar"}}');
    expect(mapped.code).toBe('BAD_REQUEST');
    expect(mapped.message).toBe('bar');
  });

  it('falls back to status default for non-JSON body', () => {
    const defaultMapped = mapErrorResponse(400, null);
    const nonJsonMapped = mapErrorResponse(400, 'not-json');
    expect(nonJsonMapped.code).toBe('BAD_REQUEST');
    expect(nonJsonMapped.message).toBe(defaultMapped.message);
  });
});

describe('mapFetchException', () => {
  it('captures thrown TypeError shape before collapsing to NETWORK_ERROR (F22)', () => {
    const mapped = mapFetchException(
      new TypeError('Failed to fetch'),
      'sendMessage',
    );

    expect(mapped.code).toBe('NETWORK_ERROR');
    expect(mapped.shape).toMatchObject({
      errName: 'TypeError',
      errMsg: 'Failed to fetch',
      errConstructor: 'TypeError',
      isTypeError: true,
      isDOMException: false,
      isAbortError: false,
    });
  });

  it('maps DOMException AbortError to ABORTED', () => {
    const err = new DOMException('Request aborted', 'AbortError');
    const mapped = mapFetchException(err, 'connectStream');

    expect(mapped.code).toBe('ABORTED');
    expect(mapped.shape.isAbortError).toBe(true);
  });

  it('maps DOMException TimeoutError to TIMEOUT', () => {
    const err = new DOMException('TimeoutError', 'TimeoutError');
    const mapped = mapFetchException(err, 'getHistory');

    expect(mapped.code).toBe('TIMEOUT');
    expect(mapped.shape.isDOMException).toBe(true);
  });
});

describe('ChatErrorCode compatibility (F28)', () => {
  it('includes every legacy browser-extension SendIntentErrorCode value', () => {
    const extensionLegacyCodes = [
      'NOT_IMPLEMENTED',
      'NOT_FOUND',
      'APP_NOT_CONNECTED',
      'PORT_UNREACHABLE',
      'NETWORK_ERROR',
      'TIMEOUT',
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'INTERNAL_ERROR',
      'UNKNOWN',
    ] as const;

    for (const code of extensionLegacyCodes) {
      expect(ALL_CHAT_ERROR_CODES).toContain(asChatErrorCode(code));
    }
  });

  it('includes every legacy Office ChatErrorCode value', () => {
    const officeLegacyCodes = [
      'NOT_IMPLEMENTED',
      'NOT_FOUND',
      'APP_NOT_CONNECTED',
      'PORT_UNREACHABLE',
      'NETWORK_ERROR',
      'TIMEOUT',
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'INTERNAL_ERROR',
      'UNKNOWN',
    ] as const;

    for (const code of officeLegacyCodes) {
      expect(ALL_CHAT_ERROR_CODES).toContain(asChatErrorCode(code));
    }
  });
});
