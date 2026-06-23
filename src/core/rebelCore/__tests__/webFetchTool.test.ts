import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { executeWebFetch, WEB_FETCH_TOOL_DEFINITION } from '../tools/webFetchTool';
import type { BuiltinToolContext } from '../types';

// ── Mock dependencies ───────────────────────────────────────────────────

vi.mock('node:dns/promises', () => {
  const resolve4 = vi.fn();
  const resolve6 = vi.fn();
  return {
    default: { resolve4, resolve6 },
    resolve4,
    resolve6,
  };
});

// ── Test helpers ────────────────────────────────────────────────────────

/** Set up DNS mock to resolve all hostnames to a public IP. */
async function mockDnsPublic() {
  const dns = await import('node:dns/promises');
  const dnsModule = dns.default ?? dns;
  vi.mocked(dnsModule.resolve4).mockResolvedValue(['93.184.216.34']);
  vi.mocked(dnsModule.resolve6).mockRejectedValue(new Error('no AAAA'));
}

/** Set up DNS mock that returns private IP for specific hostnames. */
async function mockDnsWithPrivate(privateHostnames: string[]) {
  const dns = await import('node:dns/promises');
  const dnsModule = dns.default ?? dns;
  vi.mocked(dnsModule.resolve4).mockImplementation(async (hostname: string) => {
    if (privateHostnames.includes(hostname)) {
      return ['192.168.1.1'];
    }
    return ['93.184.216.34'];
  });
  vi.mocked(dnsModule.resolve6).mockRejectedValue(new Error('no AAAA'));
}

/** Create a Response with a ReadableStream body for streaming tests. */
function createStreamResponse(
  content: string,
  init?: ResponseInit,
): Response {
  return new Response(content, init);
}

/** Create a minimal BuiltinToolContext for testing. */
function makeContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    cwd: '/tmp/test',
    rateLimitState: new Map(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('WEB_FETCH_TOOL_DEFINITION', () => {
  it('has correct name and required fields', () => {
    expect(WEB_FETCH_TOOL_DEFINITION.name).toBe('WebFetch');
    expect(WEB_FETCH_TOOL_DEFINITION.input_schema.required).toEqual(['url']);
    expect(WEB_FETCH_TOOL_DEFINITION.input_schema.properties).toHaveProperty('url');
    expect(WEB_FETCH_TOOL_DEFINITION.input_schema.properties).toHaveProperty('timeout');
    expect(WEB_FETCH_TOOL_DEFINITION.input_schema.properties).toHaveProperty('raw');
  });
});

describe('executeWebFetch', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Clear the DNS cache between tests
    const { _clearDnsCacheForTesting } = await import('@core/utils/ssrfProtection');
    _clearDnsCacheForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Input validation ───────────────────────────────────────────────

  it('returns error for missing url', async () => {
    const result = await executeWebFetch({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('requires a valid URL');
  });

  it('returns error for empty url', async () => {
    const result = await executeWebFetch({ url: '  ' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('requires a valid URL');
  });

  it('returns error for invalid url', async () => {
    const result = await executeWebFetch({ url: 'not-a-url' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not valid');
  });

  // ── Happy path ────────────────────────────────────────────────────

  it('fetches and parses HTML into Markdown', async () => {
    await mockDnsPublic();

    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <article>
            <h1>Main Article</h1>
            <p>This is a test paragraph with <strong>bold text</strong>.</p>
            <p>Another paragraph here.</p>
          </article>
        </body>
      </html>
    `;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const result = await executeWebFetch({ url: 'https://example.com/article' }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.output).toContain('bold text');
    // Markdown output should contain content from the page
    expect(result.output.length).toBeGreaterThan(10);
  });

  // ── SSRF protection ───────────────────────────────────────────────

  it('blocks private IP URLs (SSRF protection)', async () => {
    await mockDnsWithPrivate(['evil-internal.example.com']);

    const result = await executeWebFetch(
      { url: 'https://evil-internal.example.com/secret' },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('private');
  });

  // ── Non-HTML content ──────────────────────────────────────────────

  it('returns descriptive message for PDF Content-Type', async () => {
    await mockDnsPublic();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse('binary content', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com/document.pdf' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('PDF');
    expect(result.output).toContain('can only read HTML');
  });

  it('returns descriptive message for image Content-Type', async () => {
    await mockDnsPublic();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse('binary', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com/image.png' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('image');
  });

  it('cancels the response body on a non-readable Content-Type (no dispatcher leak)', async () => {
    await mockDnsPublic();

    // The body is discarded (not read) on the non-readable-content path, so it
    // must be cancelled to let the per-request pinned dispatcher release its
    // socket (a graceful Agent.close() stays pending until the body is drained
    // or cancelled).
    const pdfResponse = createStreamResponse('binary content', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });
    const cancelSpy = pdfResponse.body
      ? vi.spyOn(pdfResponse.body, 'cancel').mockResolvedValue(undefined)
      : undefined;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(pdfResponse);

    const result = await executeWebFetch(
      { url: 'https://example.com/document.pdf' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(cancelSpy).toHaveBeenCalled();
  });

  // ── Timeout ───────────────────────────────────────────────────────

  it('returns timeout error when fetch times out', async () => {
    await mockDnsPublic();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('Request timed out after 15000ms'), { name: 'AbortError' }),
    );

    const result = await executeWebFetch(
      { url: 'https://slow-site.example.com/', timeout: 15000 },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('timed out');
  });

  // ── Readability failure (null result) ─────────────────────────────

  it('falls back to raw text when Readability returns null', async () => {
    await mockDnsPublic();

    // Minimal HTML that Readability can't extract an article from
    const html = '<html><body><div>Just some loose text without article structure</div></body></html>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com/minimal' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    // Should still return some content (from raw text fallback)
    expect(result.output).toContain('loose text');
  });

  // ── Large response ────────────────────────────────────────────────

  it('returns size error for responses exceeding 5MB', async () => {
    await mockDnsPublic();

    // Create a response larger than 5MB
    const largeContent = 'x'.repeat(6 * 1024 * 1024);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse(largeContent, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com/huge-page' },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('too large');
  });

  // ── Rate limit ────────────────────────────────────────────────────

  it('enforces per-turn rate limit (10 calls)', async () => {
    const rateLimitState = new Map<string, number>();
    rateLimitState.set('WebFetch', 10); // Already at limit
    const ctx = makeContext({ rateLimitState });

    const result = await executeWebFetch(
      { url: 'https://example.com' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('page-reading limit');
    expect(result.output).toContain('Settings > Connectors');
  });

  it('increments rate limit counter on each call', async () => {
    await mockDnsPublic();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse('<html><body><p>OK</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const rateLimitState = new Map<string, number>();
    const ctx = makeContext({ rateLimitState });

    await executeWebFetch({ url: 'https://example.com/1' }, ctx);
    expect(rateLimitState.get('WebFetch')).toBe(1);

    await executeWebFetch({ url: 'https://example.com/2' }, ctx);
    expect(rateLimitState.get('WebFetch')).toBe(2);
  });

  // ── Raw mode ──────────────────────────────────────────────────────

  it('returns stripped text in raw mode', async () => {
    await mockDnsPublic();

    const html = '<html><body><p>Hello <b>World</b></p><script>evil();</script></body></html>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com/page', raw: true },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Hello');
    expect(result.output).toContain('World');
    // Should strip script tags
    expect(result.output).not.toContain('evil');
    // Should not contain HTML tags
    expect(result.output).not.toContain('<b>');
    expect(result.output).not.toContain('<script>');
  });

  it('truncates raw text to 50KB', async () => {
    await mockDnsPublic();

    const longText = 'A'.repeat(60_000);
    const html = `<html><body><p>${longText}</p></body></html>`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com/long', raw: true },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('[Content truncated');
    // Should be roughly 50KB + truncation notice
    expect(result.output.length).toBeLessThan(55_000);
  });

  // ── Too many redirects ────────────────────────────────────────────

  it('returns error for too many redirects', async () => {
    await mockDnsPublic();

    // Mock fetch to always return redirects
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { Location: 'https://example.com/redirect-loop' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com/start' },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('redirects');
  });

  // ── Works without rateLimitState (backwards compatibility) ────────

  it('works when context has no rateLimitState', async () => {
    await mockDnsPublic();

    const html = '<html><body><article><p>Content</p></article></body></html>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com' },
      { cwd: '/tmp' },
    );

    expect(result.isError).toBe(false);
  });

  // ── text/plain content type ───────────────────────────────────────

  it('handles text/plain Content-Type', async () => {
    await mockDnsPublic();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse('Plain text content here.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result = await executeWebFetch(
      { url: 'https://example.com/file.txt' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Plain text content here');
  });

  // ── URL resolution (linkedom + Readability) ───────────────────────
  //
  // These tests verify that linkedom's documentURI/baseURI setup
  // correctly drives Readability's URL resolution. Covers the postmortem
  // gaps: hash links, relative URLs, <base href> handling, headless HTML.
  // See: docs-private/postmortems/260413_linkedom_migration_url_resolution_bugs_postmortem.md

  const FILLER = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.</p>';

  function articleHtml(head: string, links: string): string {
    return `<html><head>${head}<title>Test</title></head><body><article><h1>Title</h1>${FILLER}<p>${links}</p>${FILLER}${FILLER}</article></body></html>`;
  }

  async function fetchArticle(html: string, url: string): Promise<string> {
    await mockDnsPublic();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createStreamResponse(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const result = await executeWebFetch({ url }, makeContext());
    expect(result.isError).toBe(false);
    return result.output;
  }

  it('preserves hash-only links as fragments', async () => {
    const html = articleHtml('', '<a href="#section">jump</a>');
    const output = await fetchArticle(html, 'https://example.com/article');
    expect(output).toContain('#section');
    expect(output).not.toContain('https://example.com/article#section');
  });

  it('resolves relative URLs against the page URL', async () => {
    const html = articleHtml('', '<a href="/other/page">link</a>');
    const output = await fetchArticle(html, 'https://example.com/news/article');
    expect(output).toContain('https://example.com/other/page');
  });

  it('normalizes relative <base href> to absolute', async () => {
    const html = articleHtml('<base href="/subdir/">', '<a href="page.html">link</a>');
    const output = await fetchArticle(html, 'https://example.com/news/article');
    expect(output).toContain('https://example.com/subdir/page.html');
  });

  it('normalizes protocol-relative <base href>', async () => {
    const html = articleHtml('<base href="//cdn.example.com/">', '<a href="asset.html">link</a>');
    const output = await fetchArticle(html, 'https://example.com/page');
    expect(output).toContain('https://cdn.example.com/asset.html');
  });

  it('respects existing absolute <base href>', async () => {
    const html = articleHtml('<base href="https://original.com/">', '<a href="path">link</a>');
    const output = await fetchArticle(html, 'https://fetched.com/page');
    expect(output).toContain('https://original.com/path');
  });

  it('handles pages without <head> element', async () => {
    const noHeadHtml = `<html><body><article><h1>No Head</h1>${FILLER}<p><a href="/link">link</a> <a href="#hash">hash</a></p>${FILLER}${FILLER}</article></body></html>`;
    const output = await fetchArticle(noHeadHtml, 'https://example.com/page');
    expect(output).toContain('https://example.com/link');
    expect(output).toContain('#hash');
  });

  it('handles malformed HTML gracefully', async () => {
    // Real-world malformed: unclosed tags, nested errors, but still within <html>
    const malformed = `<html><body><article><h1>Bad HTML</h1>${FILLER}<p>Unclosed tags <a href="/test">link</a>${FILLER}${FILLER}</article></body></html>`;
    const output = await fetchArticle(malformed, 'https://example.com/messy');
    expect(output).toContain('https://example.com/test');
  });
});
