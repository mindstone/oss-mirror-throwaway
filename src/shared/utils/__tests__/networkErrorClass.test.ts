import { describe, it, expect } from 'vitest';
import {
  isNetworkClassError,
  matchesNetworkCodeOrMessage,
  NETWORK_ERROR_CODES,
} from '../networkErrorClass';

// 260618_arthur-offline-resilience Stage 1: shared single-source network-class
// classifier extracted from `classifySyncErrorCause` (calendar.ts) and reused
// by the auth-heartbeat log-storm hygiene (authService.ts).

describe('isNetworkClassError', () => {
  it('returns true for every documented network errno', () => {
    for (const code of NETWORK_ERROR_CODES) {
      expect(isNetworkClassError(Object.assign(new Error('boom'), { code }))).toBe(true);
    }
  });

  it('covers the canonical offline DNS/connection codes explicitly', () => {
    for (const code of [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ECONNRESET',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ]) {
      expect(NETWORK_ERROR_CODES.has(code)).toBe(true);
      expect(isNetworkClassError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('detects undici "fetch failed" with a nested network cause (cause-chain walk)', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' }),
    });
    expect(isNetworkClassError(err)).toBe(true);
  });

  it('detects a network-shaped message even without a code', () => {
    expect(isNetworkClassError(new Error('socket hang up'))).toBe(true);
    expect(isNetworkClassError(new TypeError('fetch failed'))).toBe(true);
  });

  it('treats an AbortError (timed-out / cancelled request) as network-class', () => {
    expect(isNetworkClassError(new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
    expect(isNetworkClassError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
  });

  it('returns false for genuine auth/permission errors and non-network text', () => {
    expect(isNetworkClassError(new Error('403 insufficient permissions'))).toBe(false);
    expect(isNetworkClassError(Object.assign(new Error('Failed to fetch JWT: 403'), { status: 403 }))).toBe(false);
    expect(isNetworkClassError('some string error')).toBe(false);
    expect(isNetworkClassError(undefined)).toBe(false);
    expect(isNetworkClassError(null)).toBe(false);
  });

  it('does not loop on a self-referential cause chain', () => {
    const err = new Error('weird') as Error & { cause?: unknown };
    err.cause = err;
    expect(isNetworkClassError(err)).toBe(false);
  });
});

describe('matchesNetworkCodeOrMessage (calendar parity, no AbortError special-case)', () => {
  it('matches network codes and messages identically to the legacy classifier', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET']) {
      expect(matchesNetworkCodeOrMessage(Object.assign(new Error('boom'), { code }))).toBe(true);
    }
    expect(matchesNetworkCodeOrMessage(new Error('socket hang up'))).toBe(true);
    expect(matchesNetworkCodeOrMessage(new Error('403 insufficient permissions for calendar'))).toBe(false);
    expect(matchesNetworkCodeOrMessage(undefined)).toBe(false);
  });

  it('does NOT treat a bare AbortError as network (preserves classifySyncErrorCause behavior)', () => {
    // The legacy calendar classifier returned `account` for a bare AbortError
    // (its message "...aborted" matched no network token). The shared
    // code+message predicate must keep that behavior; only isNetworkClassError
    // adds the AbortError branch.
    expect(matchesNetworkCodeOrMessage(new DOMException('This operation was aborted', 'AbortError'))).toBe(false);
  });
});
