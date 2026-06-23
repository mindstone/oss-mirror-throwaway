import { describe, expect, it } from 'vitest';
import {
  computeMatchPattern,
  displayOriginForUser,
} from '../../src/permissions/originMatch';

describe('computeMatchPattern', () => {
  describe('happy path — supported schemes', () => {
    it('returns https origin + match pattern with default port omitted', () => {
      expect(computeMatchPattern('https://portal.pitchbook.com/some/path?q=1')).toEqual({
        ok: true,
        origin: 'https://portal.pitchbook.com',
        matchPattern: 'https://portal.pitchbook.com/*',
      });
    });

    it('returns http origin + match pattern', () => {
      expect(computeMatchPattern('http://example.test/other')).toEqual({
        ok: true,
        origin: 'http://example.test',
        matchPattern: 'http://example.test/*',
      });
    });

    it('omits default https port 443', () => {
      expect(computeMatchPattern('https://example.com:443/a')).toEqual({
        ok: true,
        origin: 'https://example.com',
        matchPattern: 'https://example.com/*',
      });
    });

    it('omits default http port 80', () => {
      expect(computeMatchPattern('http://example.com:80/a')).toEqual({
        ok: true,
        origin: 'http://example.com',
        matchPattern: 'http://example.com/*',
      });
    });

    it('keeps non-default http port explicitly', () => {
      expect(computeMatchPattern('http://localhost:3000/app')).toEqual({
        ok: true,
        origin: 'http://localhost:3000',
        matchPattern: 'http://localhost:3000/*',
      });
    });

    it('keeps non-default https port explicitly', () => {
      expect(computeMatchPattern('https://example.com:8443/a')).toEqual({
        ok: true,
        origin: 'https://example.com:8443',
        matchPattern: 'https://example.com:8443/*',
      });
    });

    it('lower-cases the host', () => {
      expect(computeMatchPattern('https://EXAMPLE.COM/A')).toEqual({
        ok: true,
        origin: 'https://example.com',
        matchPattern: 'https://example.com/*',
      });
    });

    it('brackets IPv6 hosts in the match pattern', () => {
      expect(computeMatchPattern('https://[2001:db8::1]/a')).toEqual({
        ok: true,
        origin: 'https://[2001:db8::1]',
        matchPattern: 'https://[2001:db8::1]/*',
      });
    });

    it('brackets IPv6 hosts with explicit ports', () => {
      expect(computeMatchPattern('https://[2001:db8::1]:8443/a')).toEqual({
        ok: true,
        origin: 'https://[2001:db8::1]:8443',
        matchPattern: 'https://[2001:db8::1]:8443/*',
      });
    });
  });

  describe('refused — unsupported schemes', () => {
    it.each([
      'chrome://settings',
      'edge://extensions',
      'chrome-extension://abc123/popup.html',
      'moz-extension://abc123/popup.html',
      'file:///Users/me/foo.html',
      'view-source:https://example.com',
    ])('refuses %s with unsupported-scheme', (url) => {
      expect(computeMatchPattern(url)).toEqual({
        ok: false,
        reason: 'unsupported-scheme',
      });
    });
  });

  describe('refused — pending navigation surfaces', () => {
    it('refuses about:blank with pending', () => {
      expect(computeMatchPattern('about:blank')).toEqual({
        ok: false,
        reason: 'pending',
      });
    });

    it('refuses about:srcdoc with pending', () => {
      expect(computeMatchPattern('about:srcdoc')).toEqual({
        ok: false,
        reason: 'pending',
      });
    });

    it('refuses other about: surfaces as unsupported-scheme', () => {
      expect(computeMatchPattern('about:version')).toEqual({
        ok: false,
        reason: 'unsupported-scheme',
      });
    });
  });

  describe('refused — opaque origins', () => {
    it.each([
      'data:text/html,<h1>hi</h1>',
      'blob:https://example.com/abc',
      'javascript:void(0)',
    ])('refuses %s with opaque', (url) => {
      expect(computeMatchPattern(url)).toEqual({
        ok: false,
        reason: 'opaque',
      });
    });
  });

  describe('refused — invalid inputs', () => {
    it.each([
      [undefined],
      [''],
      ['not a url'],
      ['://missing-scheme'],
    ])('refuses %s with invalid', (url) => {
      expect(computeMatchPattern(url as string | undefined)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });
  });
});

describe('displayOriginForUser', () => {
  it('strips https:// for standard HTTPS', () => {
    expect(displayOriginForUser('https://portal.pitchbook.com')).toBe(
      'portal.pitchbook.com',
    );
  });

  it('keeps http:// suffix style: host (http)', () => {
    expect(displayOriginForUser('http://localhost:3000')).toBe(
      'localhost:3000 (http)',
    );
  });

  it('strips trailing /* match-pattern suffix', () => {
    expect(displayOriginForUser('https://portal.pitchbook.com/*')).toBe(
      'portal.pitchbook.com',
    );
    expect(displayOriginForUser('http://localhost:3000/*')).toBe(
      'localhost:3000 (http)',
    );
  });

  it('brackets IPv6 hosts and keeps ports', () => {
    expect(displayOriginForUser('https://[2001:db8::1]:8443')).toBe(
      '[2001:db8::1]:8443',
    );
  });

  it('returns as-is for unparseable inputs', () => {
    expect(displayOriginForUser('not a url')).toBe('not a url');
  });

  it('handles empty strings defensively', () => {
    expect(displayOriginForUser('')).toBe('');
  });
});
