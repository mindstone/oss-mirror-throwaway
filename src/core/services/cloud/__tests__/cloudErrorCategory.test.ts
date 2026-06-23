import { describe, it, expect } from 'vitest';
import { categorize } from '../cloudErrorCategory';

function errorWithCode(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe('categorize', () => {
  it('categorizes Node undici "TypeError: fetch failed" as network/fetch_failed', () => {
    expect(categorize(new TypeError('fetch failed'))).toEqual({ kind: 'network', subkind: 'fetch_failed' });
  });

  it('categorizes browser "TypeError: Failed to fetch" as network/fetch_failed', () => {
    expect(categorize(new TypeError('Failed to fetch'))).toEqual({ kind: 'network', subkind: 'fetch_failed' });
  });

  it('categorizes ENOTFOUND as network/dns', () => {
    expect(categorize(errorWithCode('ENOTFOUND', 'getaddrinfo ENOTFOUND api.example.com'))).toEqual({
      kind: 'network',
      subkind: 'dns',
    });
  });

  it('categorizes ECONNREFUSED as network/tcp', () => {
    expect(categorize(errorWithCode('ECONNREFUSED'))).toEqual({ kind: 'network', subkind: 'tcp' });
  });

  it('categorizes ECONNRESET as network/tcp', () => {
    expect(categorize(errorWithCode('ECONNRESET'))).toEqual({ kind: 'network', subkind: 'tcp' });
  });

  it('categorizes EHOSTUNREACH as network/tcp', () => {
    expect(categorize(errorWithCode('EHOSTUNREACH'))).toEqual({ kind: 'network', subkind: 'tcp' });
  });

  it('categorizes AbortError as network/abort', () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';

    expect(categorize(error)).toEqual({ kind: 'network', subkind: 'abort' });
  });

  it('categorizes ETIMEDOUT as network/timeout', () => {
    expect(categorize(errorWithCode('ETIMEDOUT'))).toEqual({ kind: 'network', subkind: 'timeout' });
  });

  it('categorizes "Request timed out" as network/timeout', () => {
    expect(categorize(new Error('Request timed out'))).toEqual({ kind: 'network', subkind: 'timeout' });
  });

  it('categorizes HTTP 401 as auth/unauthorized', () => {
    expect(categorize(new Error('HTTP 401 Unauthorized'))).toEqual({ kind: 'auth', subkind: 'unauthorized' });
  });

  it('categorizes HTTP 403 as auth/forbidden', () => {
    expect(categorize({ status: 403 })).toEqual({ kind: 'auth', subkind: 'forbidden' });
  });

  it('categorizes "token expired" message as auth/token_expired', () => {
    expect(categorize(new Error('Access token expired'))).toEqual({ kind: 'auth', subkind: 'token_expired' });
  });

  it('categorizes HTTP 502 as cloud_down/http_5xx', () => {
    expect(categorize({ status: 502 })).toEqual({ kind: 'cloud_down', subkind: 'http_5xx' });
  });

  it('categorizes HTTP 503 as cloud_down/http_5xx', () => {
    expect(categorize(new Error('HTTP 503 Service Unavailable'))).toEqual({
      kind: 'cloud_down',
      subkind: 'http_5xx',
    });
  });

  it('categorizes "Managed cloud is being removed" as cloud_down/deprovisioning', () => {
    expect(categorize(new Error('Managed cloud is being removed.'))).toEqual({
      kind: 'cloud_down',
      subkind: 'deprovisioning',
    });
  });

  it('falls back to unknown with rawMessage for unrecognized errors', () => {
    expect(categorize(new Error('Something unusual happened'))).toEqual({
      kind: 'unknown',
      rawMessage: 'Something unusual happened',
    });
  });

  it('handles non-Error values (strings, undefined) without throwing', () => {
    expect(categorize('plain string')).toEqual({ kind: 'unknown', rawMessage: 'plain string' });
    expect(categorize(undefined)).toEqual({ kind: 'unknown', rawMessage: 'undefined' });
  });
});
