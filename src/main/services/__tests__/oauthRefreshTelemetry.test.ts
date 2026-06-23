import crypto from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setErrorReporter, type ErrorReporter, type ErrorReporterEventScope } from '@core/errorReporter';
import {
  classifyGoogleEmailDomain,
  normalizeGoogleErrorCode,
  parseGoogleErrorCode,
  tenantHashFromDomain,
  recordGoogleOAuthRefreshFailure,
} from '../oauthRefreshTelemetry';

/**
 * Always restore a no-op reporter between tests — `setErrorReporter` mutates
 * a module-global, so cross-test contamination is real if we forget.
 */
function noopReporter(): ErrorReporter {
  return {
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    captureExceptionWithScope: vi.fn(),
  };
}

afterEach(() => {
  setErrorReporter(noopReporter());
});

describe('classifyGoogleEmailDomain', () => {
  it('classifies gmail.com as consumer', () => {
    expect(classifyGoogleEmailDomain('[external-email]')).toBe('consumer');
    expect(classifyGoogleEmailDomain('[external-email]')).toBe('consumer');
  });

  it('classifies googlemail.com as consumer', () => {
    expect(classifyGoogleEmailDomain('[external-email]')).toBe('consumer');
  });

  it('classifies any other domain as workspace', () => {
    expect(classifyGoogleEmailDomain('[Mindstone-email]')).toBe('workspace');
    expect(classifyGoogleEmailDomain('user@example.org')).toBe('workspace');
  });

  it('returns unknown for missing or malformed input', () => {
    expect(classifyGoogleEmailDomain(undefined)).toBe('unknown');
    expect(classifyGoogleEmailDomain(null)).toBe('unknown');
    expect(classifyGoogleEmailDomain('')).toBe('unknown');
    expect(classifyGoogleEmailDomain('no-at-sign')).toBe('unknown');
  });
});

describe('normalizeGoogleErrorCode', () => {
  it('passes through known codes', () => {
    expect(normalizeGoogleErrorCode('invalid_grant')).toBe('invalid_grant');
    expect(normalizeGoogleErrorCode('unauthorized_client')).toBe('unauthorized_client');
    expect(normalizeGoogleErrorCode('access_denied')).toBe('access_denied');
  });

  it('maps unknown strings to "unknown"', () => {
    expect(normalizeGoogleErrorCode('something_weird')).toBe('unknown');
    expect(normalizeGoogleErrorCode('')).toBe('unknown');
  });

  it('maps non-strings to "unknown"', () => {
    expect(normalizeGoogleErrorCode(undefined)).toBe('unknown');
    expect(normalizeGoogleErrorCode(null)).toBe('unknown');
    expect(normalizeGoogleErrorCode(42)).toBe('unknown');
    expect(normalizeGoogleErrorCode({ error: 'invalid_grant' })).toBe('unknown');
  });
});

describe('parseGoogleErrorCode', () => {
  it('parses known error codes from JSON response bodies', () => {
    expect(parseGoogleErrorCode(JSON.stringify({ error: 'invalid_grant' }))).toBe('invalid_grant');
    expect(parseGoogleErrorCode(JSON.stringify({ error: 'unauthorized_client' }))).toBe('unauthorized_client');
  });

  it('returns unknown for malformed or unlisted codes', () => {
    expect(parseGoogleErrorCode(JSON.stringify({ error: 'totally_new_code' }))).toBe('unknown');
    expect(parseGoogleErrorCode('not-json')).toBe('unknown');
    expect(parseGoogleErrorCode(JSON.stringify({ nope: 'missing-error-field' }))).toBe('unknown');
  });
});

describe('tenantHashFromDomain', () => {
  it('produces a 16-character hex hash', () => {
    const hash = tenantHashFromDomain('mindstone.com');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic across calls', () => {
    expect(tenantHashFromDomain('mindstone.com')).toBe(tenantHashFromDomain('mindstone.com'));
  });

  it('lowercases input so case variations cluster together', () => {
    expect(tenantHashFromDomain('MindStone.com')).toBe(tenantHashFromDomain('mindstone.com'));
  });

  it('matches the documented sha256 truncation', () => {
    const expected = crypto.createHash('sha256').update('mindstone.com').digest('hex').slice(0, 16);
    expect(tenantHashFromDomain('mindstone.com')).toBe(expected);
  });
});

describe('recordGoogleOAuthRefreshFailure', () => {
  it('emits a breadcrumb and captures an exception with low-cardinality tags', () => {
    const collectedTags: Record<string, string> = {};
    const collectedContexts: Record<string, Record<string, unknown>> = {};
    const fakeScope: ErrorReporterEventScope = {
      setTag: (k, v) => { collectedTags[k] = v; },
      setContext: (k, v) => { collectedContexts[k] = v; },
    };

    const addBreadcrumb = vi.fn();
    const captureExceptionWithScope = vi.fn((_err: unknown, mutator: (s: ErrorReporterEventScope) => void) => {
      mutator(fakeScope);
    });

    setErrorReporter({
      addBreadcrumb,
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      captureExceptionWithScope,
    });

    recordGoogleOAuthRefreshFailure({
      httpStatus: 400,
      responseBodyText: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked.' }),
      emailDomain: 'mindstone.com',
      domainClass: 'workspace',
    });

    // Breadcrumb has only safe data
    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb.mock.calls[0][0]).toEqual({
      category: 'oauth.refresh',
      message: 'google refresh failed',
      level: 'warning',
      data: {
        provider: 'google',
        error_code: 'invalid_grant',
        http_status: 400,
        domain_class: 'workspace',
      },
    });

    // Captured error message is sanitized — no response body, no tokens
    expect(captureExceptionWithScope).toHaveBeenCalledTimes(1);
    const capturedError = captureExceptionWithScope.mock.calls[0][0] as Error;
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError.message).toBe('Google OAuth token refresh failed');
    expect(capturedError.message).not.toContain('Token has been revoked');
    expect(capturedError.message).not.toContain('mindstone');

    // Tags are low-cardinality and PII-free
    const expectedTenantHash = crypto.createHash('sha256').update('mindstone.com').digest('hex').slice(0, 16);
    expect(collectedTags).toEqual({
      'oauth.provider': 'google',
      'oauth.error_code': 'invalid_grant',
      'oauth.http_status': '400',
      'oauth.domain_class': 'workspace',
      'oauth.tenant_hash': expectedTenantHash,
    });

    // No raw email or slug on tags or context
    for (const value of Object.values(collectedTags)) {
      expect(value).not.toContain('@');
      expect(value).not.toContain('mindstone.com');
      expect(value).not.toMatch(/GoogleWorkspace-/);
    }
    expect(collectedContexts).toEqual({});
  });

  it('falls back to captureException when captureExceptionWithScope is not implemented', () => {
    const captureException = vi.fn();
    setErrorReporter({
      addBreadcrumb: vi.fn(),
      captureException,
      captureMessage: vi.fn(),
      // Deliberately no captureExceptionWithScope (interface allows it)
    });

    recordGoogleOAuthRefreshFailure({
      httpStatus: 401,
      responseBodyText: JSON.stringify({ error: 'unauthorized_client' }),
      emailDomain: 'gmail.com',
      domainClass: 'consumer',
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0];
    expect((err as Error).message).toBe('Google OAuth token refresh failed');
    expect(ctx).toEqual({
      oauth_provider: 'google',
      oauth_error_code: 'unauthorized_client',
      oauth_http_status: 401,
      oauth_domain_class: 'consumer',
      oauth_tenant_hash: tenantHashFromDomain('gmail.com'),
    });
  });

  it('normalizes unknown error codes from the response body', () => {
    const captureExceptionWithScope = vi.fn((_err, mutator) => {
      const tags: Record<string, string> = {};
      mutator({ setTag: (k: string, v: string) => { tags[k] = v; }, setContext: () => {} });
      expect(tags['oauth.error_code']).toBe('unknown');
    });
    setErrorReporter({
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      captureExceptionWithScope,
    });

    recordGoogleOAuthRefreshFailure({
      httpStatus: 500,
      responseBodyText: JSON.stringify({ error: 'something_weird' }),
      emailDomain: 'example.com',
      domainClass: 'workspace',
    });

    expect(captureExceptionWithScope).toHaveBeenCalledTimes(1);
  });

  it('handles non-JSON response bodies without throwing', () => {
    const captureExceptionWithScope = vi.fn((_err, mutator) => {
      const tags: Record<string, string> = {};
      mutator({ setTag: (k: string, v: string) => { tags[k] = v; }, setContext: () => {} });
      expect(tags['oauth.error_code']).toBe('unknown');
    });
    setErrorReporter({
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      captureExceptionWithScope,
    });

    expect(() =>
      recordGoogleOAuthRefreshFailure({
        httpStatus: 502,
        responseBodyText: '<html>upstream error</html>',
        emailDomain: 'example.com',
        domainClass: 'workspace',
      }),
    ).not.toThrow();

    expect(captureExceptionWithScope).toHaveBeenCalledTimes(1);
  });

  it('swallows reporter exceptions so it never masks the original OAuth error', () => {
    setErrorReporter({
      addBreadcrumb: () => { throw new Error('breadcrumb explosion'); },
      captureException: () => { throw new Error('capture explosion'); },
      captureMessage: vi.fn(),
      captureExceptionWithScope: () => { throw new Error('scope explosion'); },
    });

    expect(() =>
      recordGoogleOAuthRefreshFailure({
        httpStatus: 400,
        responseBodyText: JSON.stringify({ error: 'invalid_grant' }),
        emailDomain: 'mindstone.com',
        domainClass: 'workspace',
      }),
    ).not.toThrow();
  });

  it('handles unknown domain class without leaking PII', () => {
    const collectedTags: Record<string, string> = {};
    const captureExceptionWithScope = vi.fn((_err, mutator) => {
      mutator({ setTag: (k: string, v: string) => { collectedTags[k] = v; }, setContext: () => {} });
    });
    setErrorReporter({
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      captureExceptionWithScope,
    });

    recordGoogleOAuthRefreshFailure({
      httpStatus: 400,
      responseBodyText: JSON.stringify({ error: 'invalid_grant' }),
      emailDomain: '',
      domainClass: 'unknown',
    });

    expect(collectedTags['oauth.domain_class']).toBe('unknown');
    // Even an empty domain still produces a deterministic 16-char hash;
    // no email or slug should appear anywhere.
    expect(collectedTags['oauth.tenant_hash']).toMatch(/^[0-9a-f]{16}$/);
  });
});
