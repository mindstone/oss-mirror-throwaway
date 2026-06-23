import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, safeUrlScheme } from '../isAllowedExternalUrl';

describe('isAllowedExternalUrl', () => {
  describe('allows http(s) URLs', () => {
    it('allows https URLs', () => {
      expect(isAllowedExternalUrl('https://example.com')).toBe(true);
    });

    it('allows http URLs with path and query', () => {
      expect(isAllowedExternalUrl('http://example.com/path?q=1')).toBe(true);
    });

    it('allows upper-case scheme variants (normalised by URL parser)', () => {
      expect(isAllowedExternalUrl('HTTPS://example.com')).toBe(true);
      expect(isAllowedExternalUrl('Https://Example.com')).toBe(true);
    });

    it('allows URLs with leading/trailing whitespace', () => {
      expect(isAllowedExternalUrl('  https://example.com  ')).toBe(true);
    });
  });

  describe('denies non-http(s) schemes', () => {
    it('denies ui:// (MCP Apps resource URI)', () => {
      expect(isAllowedExternalUrl('ui://RebelCanvas/html?id=abc')).toBe(false);
    });

    it('denies javascript: URLs', () => {
      expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    });

    it('denies file:// URLs', () => {
      expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    });

    it('denies data: URLs', () => {
      expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    });

    it('denies mailto: URLs', () => {
      expect(isAllowedExternalUrl('mailto:a@b.c')).toBe(false);
    });

    it('denies rebel:// deep-link URLs', () => {
      expect(isAllowedExternalUrl('rebel://conversation/x')).toBe(false);
    });

    it('denies vbscript: URLs', () => {
      expect(isAllowedExternalUrl('vbscript:msgbox(1)')).toBe(false);
    });
  });

  describe('denies malformed / empty / non-string input', () => {
    it('denies empty string', () => {
      expect(isAllowedExternalUrl('')).toBe(false);
    });

    it('denies whitespace-only string', () => {
      expect(isAllowedExternalUrl('   ')).toBe(false);
    });

    it('denies plain text that is not a URL', () => {
      expect(isAllowedExternalUrl('not a url')).toBe(false);
    });

    it('denies null input', () => {
      expect(isAllowedExternalUrl(null)).toBe(false);
    });

    it('denies undefined input', () => {
      expect(isAllowedExternalUrl(undefined)).toBe(false);
    });

    it('denies non-string input (number)', () => {
      expect(isAllowedExternalUrl(42)).toBe(false);
    });

    it('denies non-string input (object)', () => {
      expect(isAllowedExternalUrl({ url: 'https://example.com' })).toBe(false);
    });
  });
});

describe('safeUrlScheme', () => {
  it('returns http: for http URLs', () => {
    expect(safeUrlScheme('http://example.com')).toBe('http:');
  });

  it('returns https: for https URLs', () => {
    expect(safeUrlScheme('https://example.com/path')).toBe('https:');
  });

  it('returns ui: for MCP Apps URIs', () => {
    expect(safeUrlScheme('ui://RebelCanvas/html?id=abc')).toBe('ui:');
  });

  it('returns javascript: for javascript URLs', () => {
    expect(safeUrlScheme('javascript:alert(1)')).toBe('javascript:');
  });

  it('returns unparseable for malformed input', () => {
    expect(safeUrlScheme('not a url')).toBe('unparseable');
  });

  it('returns unparseable for empty string', () => {
    expect(safeUrlScheme('')).toBe('unparseable');
  });

  it('returns non-string for non-string input', () => {
    expect(safeUrlScheme(null)).toBe('non-string');
    expect(safeUrlScheme(undefined)).toBe('non-string');
    expect(safeUrlScheme(42)).toBe('non-string');
  });

  it('does not throw for any input', () => {
    expect(() => safeUrlScheme('anything')).not.toThrow();
    expect(() => safeUrlScheme(null)).not.toThrow();
  });
});
