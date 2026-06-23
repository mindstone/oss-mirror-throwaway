import { defaultUrlTransform } from 'react-markdown';

import {
  BLOCKED_URL_SCHEMES,
  classifyMarkdownUrl,
  findBlockedUrlScheme,
  redactUrlForLogging,
  createGuardedUrlTransform,
} from '../urlSchemePolicy';

const legacyFindBlockedUrlScheme = (
  url: string | null | undefined,
): 'javascript:' | 'blob:' | 'file:' | null => {
  if (!url) return null;

  const lower = url.trim().toLowerCase();
  for (const scheme of BLOCKED_URL_SCHEMES) {
    if (lower.startsWith(scheme)) return scheme;
  }

  return null;
};

const legacyCreateGuardedUrlTransform = (
  fallback: (url: string) => string,
): ((url: string) => string) => {
  return (url: string) => {
    if (legacyFindBlockedUrlScheme(url)) return url;
    return fallback(url);
  };
};

describe('classifyMarkdownUrl', () => {
  it('T-CLASSIFY.1 categorizes empty inputs', () => {
    expect(classifyMarkdownUrl(null)).toMatchObject({ category: 'empty', isSafe: true });
    expect(classifyMarkdownUrl(undefined)).toMatchObject({ category: 'empty', isSafe: true });
    expect(classifyMarkdownUrl('   ')).toMatchObject({ category: 'empty', isSafe: true });
  });

  it('T-CLASSIFY.2 categorizes relative, hash, protocol-relative, and Windows-drive inputs', () => {
    expect(classifyMarkdownUrl('relative/path.png')).toMatchObject({
      category: 'relative',
      isSafe: true,
    });
    expect(classifyMarkdownUrl('foo/bar:baz')).toMatchObject({
      category: 'relative',
      isSafe: true,
    });
    expect(classifyMarkdownUrl('?q:1')).toMatchObject({
      category: 'relative',
      isSafe: true,
    });
    expect(classifyMarkdownUrl('#section')).toMatchObject({ category: 'hash', isSafe: true });
    expect(classifyMarkdownUrl('//host.example/path')).toMatchObject({
      category: 'protocol-relative',
      isSafe: true,
    });
    expect(classifyMarkdownUrl('//host.example/path', { surface: 'message-main' })).toMatchObject({
      category: 'protocol-relative',
      isSafe: false,
    });
    expect(classifyMarkdownUrl('C:\\Users\\Greg\\file.md')).toMatchObject({
      category: 'windows-drive',
      isSafe: false,
    });
  });

  it('T-CLASSIFY.3 categorizes react-markdown default safe schemes', () => {
    expect(classifyMarkdownUrl('HTTP://example.com')).toMatchObject({
      category: 'http',
      isSafe: true,
      scheme: 'http:',
    });
    expect(classifyMarkdownUrl('https:example.com')).toMatchObject({
      category: 'https',
      isSafe: true,
      scheme: 'https:',
    });
    for (const scheme of ['mailto:', 'irc:', 'ircs:', 'xmpp:'] as const) {
      expect(classifyMarkdownUrl(`${scheme}target`)).toMatchObject({
        category: 'default-safe-scheme',
        isSafe: true,
        scheme,
      });
    }
  });

  it('T-CLASSIFY.4 categorizes app-internal schemes without absorbing renderer routing', () => {
    expect(classifyMarkdownUrl('library://docs/file.md')).toMatchObject({
      category: 'library',
      isSafe: false,
      scheme: 'library:',
    });
    expect(classifyMarkdownUrl('workspace://docs/file.md')).toMatchObject({
      category: 'workspace',
      isSafe: false,
      scheme: 'workspace:',
    });
    expect(classifyMarkdownUrl('rebel://conversation/abc')).toMatchObject({
      category: 'rebel',
      isSafe: false,
      scheme: 'rebel:',
    });
    expect(classifyMarkdownUrl('rebel://conversation/abc', { surface: 'message-main' })).toMatchObject({
      category: 'rebel',
      isSafe: true,
      scheme: 'rebel:',
    });
  });

  it('T-CLASSIFY.5 keeps file: context-dependent', () => {
    expect(classifyMarkdownUrl('file:///Users/you/a.md')).toMatchObject({
      category: 'file',
      isSafe: false,
      scheme: 'file:',
    });
    expect(classifyMarkdownUrl('file:///Users/you/a.md', { surface: 'message-main' })).toMatchObject({
      category: 'file',
      isSafe: true,
      scheme: 'file:',
    });
    expect(findBlockedUrlScheme('file:///Users/you/a.md')).toBe('file:');
  });

  it('T-CLASSIFY.6 categorizes data images with subtype but keeps them default-denied', () => {
    expect(classifyMarkdownUrl('data:image/png;base64,abc123')).toMatchObject({
      category: 'data-image',
      isSafe: false,
      scheme: 'data:',
      subtype: 'png',
    });
    expect(classifyMarkdownUrl('DATA:IMAGE/SVG+XML,<svg></svg>')).toMatchObject({
      category: 'data-image',
      isSafe: false,
      scheme: 'data:',
      subtype: 'svg+xml',
    });
  });

  it('T-CLASSIFY.7 categorizes blocked-dangerous and unknown schemes', () => {
    expect(classifyMarkdownUrl('  JaVaScRiPt:alert(1)  ')).toMatchObject({
      category: 'blocked-dangerous',
      isSafe: false,
      scheme: 'javascript:',
      normalizedUrl: 'javascript:alert(1)',
    });
    expect(classifyMarkdownUrl('blob:http://example.com/id')).toMatchObject({
      category: 'blocked-dangerous',
      isSafe: false,
      scheme: 'blob:',
    });
    expect(classifyMarkdownUrl('vbscript:msgbox')).toMatchObject({
      category: 'unknown-scheme',
      isSafe: false,
      scheme: 'vbscript:',
    });
    expect(classifyMarkdownUrl('data:text/html,<h1>x</h1>')).toMatchObject({
      category: 'unknown-scheme',
      isSafe: false,
      scheme: 'data:',
    });
  });
});

describe('findBlockedUrlScheme', () => {
  it('T-B1 returns null for null input', () => {
    expect(findBlockedUrlScheme(null)).toBeNull();
  });

  it('T-B2 returns null for undefined input', () => {
    expect(findBlockedUrlScheme(undefined)).toBeNull();
  });

  it('T-B3 returns null for empty-string input', () => {
    expect(findBlockedUrlScheme('')).toBeNull();
  });

  it('T-B4 allows http URLs', () => {
    expect(findBlockedUrlScheme('http://example.com/x.png')).toBeNull();
  });

  it('T-B5 allows https URLs', () => {
    expect(findBlockedUrlScheme('https://example.com/x.png')).toBeNull();
  });

  it('T-B6 allows data URLs', () => {
    expect(findBlockedUrlScheme('data:image/png;base64,abc123')).toBeNull();
  });

  it('T-B7 allows rebel library URLs', () => {
    expect(findBlockedUrlScheme('rebel://library/foo.png')).toBeNull();
  });

  it('T-B8 allows relative URLs', () => {
    expect(findBlockedUrlScheme('relative/path.png')).toBeNull();
  });

  it('T-B9 allows protocol-relative URLs', () => {
    expect(findBlockedUrlScheme('//host.example.com/x.png')).toBeNull();
  });

  it('T-B10 blocks javascript URLs', () => {
    expect(findBlockedUrlScheme('javascript:alert(1)')).toBe('javascript:');
  });

  it('T-B11 blocks javascript URLs case-insensitively', () => {
    expect(findBlockedUrlScheme('JAVASCRIPT:alert(1)')).toBe('javascript:');
  });

  it('T-B12 blocks blob URLs', () => {
    expect(findBlockedUrlScheme('blob:http://example.com/abc')).toBe('blob:');
  });

  it('T-B13 blocks file URLs', () => {
    expect(findBlockedUrlScheme('file:///etc/passwd')).toBe('file:');
  });

  it('T-B14 blocks dangerous schemes with leading spaces', () => {
    expect(findBlockedUrlScheme('   javascript:alert(1)')).toBe('javascript:');
  });

  it('T-B15 blocks dangerous schemes with tab/newline prefix', () => {
    expect(findBlockedUrlScheme('\t\njavascript:alert(1)')).toBe('javascript:');
  });

  it('T-B15.1 stays bit-for-bit equivalent to the legacy denylist over normalization cases', () => {
    const urls = [
      null,
      undefined,
      '',
      '   ',
      'javascript:alert(1)',
      '  javascript:alert(1)  ',
      '\t\nJAVASCRIPT:alert(1)',
      'blob:http://example.com/id',
      '  BLOB:http://example.com/id',
      'file:///etc/passwd',
      '  FILE:///etc/passwd',
      'vbscript:msgbox',
      'data:text/html,<h1>x</h1>',
      'data:image/png;base64,abc123',
      'https://example.com',
      '//host.example/path',
      'C:\\Users\\Greg\\file.md',
    ];

    for (const url of urls) {
      expect(findBlockedUrlScheme(url)).toBe(legacyFindBlockedUrlScheme(url));
    }
  });
});

describe('redactUrlForLogging', () => {
  it('T-B16 strips query strings', () => {
    expect(redactUrlForLogging('https://a.com/x.png?token=secret')).toBe(
      'https://a.com/x.png',
    );
  });

  it('T-B17 returns empty string for null input', () => {
    expect(redactUrlForLogging(null)).toBe('');
  });

  it('T-B18 truncates output to 256 characters', () => {
    const longPath = `https://example.com/${'a'.repeat(400)}.png?token=secret`;
    const redacted = redactUrlForLogging(longPath);

    expect(redacted.length).toBe(256);
    expect(redacted).toBe(`https://example.com/${'a'.repeat(400)}.png`.slice(0, 256));
    expect(redacted).not.toContain('?');
  });
});

describe('createGuardedUrlTransform', () => {
  // Stub fallback that blanks everything except https — mimics react-markdown's
  // default urlTransform for test purposes (the real one has a larger allow-list
  // but the key blanking-behaviour is the same).
  const stubFallback = (url: string) => (url.startsWith('https://') ? url : '');

  it('T-B19 preserves javascript: for guard observability', () => {
    const transform = createGuardedUrlTransform(stubFallback);
    expect(transform('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('T-B20 preserves blob: for guard observability', () => {
    const transform = createGuardedUrlTransform(stubFallback);
    expect(transform('blob:http://x.com/y')).toBe('blob:http://x.com/y');
  });

  it('T-B21 preserves file: for guard observability', () => {
    const transform = createGuardedUrlTransform(stubFallback);
    expect(transform('file:///etc/passwd')).toBe('file:///etc/passwd');
  });

  it('T-B22 delegates https to fallback (passes through)', () => {
    const transform = createGuardedUrlTransform(stubFallback);
    expect(transform('https://example.com/x.png')).toBe('https://example.com/x.png');
  });

  it('T-B23 delegates unknown dangerous schemes to fallback (gets blanked)', () => {
    const transform = createGuardedUrlTransform(stubFallback);
    // vbscript: is not in our block-list but the fallback still blanks it,
    // so the safety net still holds.
    expect(transform('vbscript:msgbox')).toBe('');
  });

  it('T-B24 preserves blocked schemes case-insensitively', () => {
    const transform = createGuardedUrlTransform(stubFallback);
    expect(transform('JAVASCRIPT:alert(1)')).toBe('JAVASCRIPT:alert(1)');
  });

  // -----------------------------------------------------------------------
  // preserveSchemes extension (I10 follow-up F4 minimal-surgical amendment)
  // -----------------------------------------------------------------------

  it('T-GUARD.NEW.1 preserves caller-listed rebel:// for anchor handler routing', () => {
    const transform = createGuardedUrlTransform(stubFallback, ['rebel://']);
    expect(transform('rebel://conversation/abc')).toBe('rebel://conversation/abc');
  });

  it('T-GUARD.NEW.2 dangerous-scheme passthrough wins over preserveSchemes misconfiguration', () => {
    // Even if a caller mistakenly adds 'javascript:' to preserveSchemes,
    // the dangerous-scheme passthrough fires first so the img guard still
    // sees the original scheme and can log + hide.
    const transform = createGuardedUrlTransform(stubFallback, ['javascript:']);
    expect(transform('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('T-GUARD.NEW.3 non-matching scheme delegates to fallback', () => {
    const transform = createGuardedUrlTransform(stubFallback, ['rebel://']);
    expect(transform('https://example.com')).toBe('https://example.com');
  });

  it('T-GUARD.NEW.4 preserveSchemes matches case-insensitively', () => {
    const transform = createGuardedUrlTransform(stubFallback, ['rebel://']);
    expect(transform('REBEL://conversation/abc')).toBe('REBEL://conversation/abc');
  });

  it('T-GUARD.NEW.5 omitted preserveSchemes behaves identically to pre-extension API', () => {
    // Backward-compat anchor: existing consumers (SafeMarkdown, SafeWebMarkdown
    // before Stage 2 wiring) pass only the fallback. The omitted-param path
    // MUST be bitwise-identical.
    const transform = createGuardedUrlTransform(stubFallback);
    expect(transform('rebel://foo')).toBe('');
    expect(transform('https://example.com')).toBe('https://example.com');
    expect(transform('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('T-GUARD.NEW.6 empty preserveSchemes array behaves like omitted', () => {
    const transform = createGuardedUrlTransform(stubFallback, []);
    expect(transform('rebel://foo')).toBe('');
  });

  it('T-GUARD.NEW.7 multi-scheme preserveSchemes preserves each independently', () => {
    const transform = createGuardedUrlTransform(stubFallback, ['rebel://', 'workspace://']);
    expect(transform('rebel://conversation/abc')).toBe('rebel://conversation/abc');
    expect(transform('workspace://docs/foo.md')).toBe('workspace://docs/foo.md');
    expect(transform('library://docs/foo.md')).toBe(''); // not in list, falls to fallback
  });

  it('T-GUARD.NEW.8 preserve branch trims leading whitespace so downstream startsWith checks match', () => {
    // handleLinkClick in ConversationScreen does href.toLowerCase().startsWith('rebel://').
    // If we preserved '  rebel://...' untrimmed, the click handler would miss it.
    const transform = createGuardedUrlTransform(stubFallback, ['rebel://']);
    expect(transform('  rebel://conversation/abc')).toBe('rebel://conversation/abc');
    expect(transform('\trebel://conversation/abc')).toBe('rebel://conversation/abc');
  });

  it('T-GUARD.NEW.9 matches the legacy no-preserve transform with react-markdown defaultUrlTransform', () => {
    const legacyTransform = legacyCreateGuardedUrlTransform(defaultUrlTransform);
    const transform = createGuardedUrlTransform(defaultUrlTransform);
    const urls = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      '\tjavascript:alert(1)',
      'blob:http://example.com/id',
      'file:///etc/passwd',
      'vbscript:msgbox',
      'data:text/html,<h1>x</h1>',
      'data:image/svg+xml,<svg></svg>',
      'data:image/png;base64,abc123',
      'mailto:person@example.com',
      'irc://irc.example/channel',
      'ircs://irc.example/channel',
      'xmpp:room@example.com',
      'weird:thing',
      'WEIRD:thing',
      'https://example.com/path',
      'HTTPS://example.com/path',
      'http://example.com/path',
      '//host.example/path',
      'relative/path.png',
      'foo/bar:baz',
      '?q:1',
      '#heading',
      'C:\\Users\\Greg\\file.md',
      'https://user:pass@example.com/path',
      'java\nscript:alert(1)',
      '%6aavascript:alert(1)',
    ];

    for (const url of urls) {
      expect(transform(url)).toBe(legacyTransform(url));
    }
  });
});
