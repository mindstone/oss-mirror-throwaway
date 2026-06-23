/**
 * Tests for the `/app/open` cross-surface launcher route.
 *
 * Verifies URL validation (prevents open-redirect via unknown hosts or
 * non-rebel schemes), happy-path HTML rendering, and the fallback redirect.
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage F.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleAppOpen } from '../routes/open';

function makeReq(url: string): IncomingMessage {
  return { url, headers: {} } as unknown as IncomingMessage;
}

function makeRes(): {
  res: ServerResponse;
  status: () => number | undefined;
  headers: () => Record<string, string | number | string[] | undefined>;
  body: () => string;
} {
  let statusCode: number | undefined;
  let responseHeaders: Record<string, string | number | string[] | undefined> = {};
  let responseBody = '';

  const res = {
    writeHead: vi.fn((code: number, headers?: Record<string, string | number | string[]>) => {
      statusCode = code;
      if (headers) responseHeaders = { ...responseHeaders, ...headers };
    }),
    setHeader: vi.fn((name: string, value: string | number | string[]) => {
      responseHeaders[name] = value;
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk) responseBody += chunk;
    }),
  } as unknown as ServerResponse;

  return {
    res,
    status: () => statusCode,
    headers: () => responseHeaders,
    body: () => responseBody,
  };
}

describe('handleAppOpen — happy path', () => {
  it('returns 200 HTML for a valid rebel://conversation URL', async () => {
    const { res, status, headers, body } = makeRes();
    await handleAppOpen(makeReq('/app/open?u=rebel%3A%2F%2Fconversation%2Fabc123'), res);
    expect(status()).toBe(200);
    expect(headers()['Content-Type']).toMatch(/text\/html/);
    expect(body()).toContain('Opening Rebel');
    expect(body()).toContain('rebel://conversation/abc123');
  });

  it('returns 200 HTML for a valid rebel://space URL', async () => {
    const { res, status, body } = makeRes();
    await handleAppOpen(
      makeReq(`/app/open?u=${encodeURIComponent('rebel://space/Exec/memory%2FQ1.md')}`),
      res,
    );
    expect(status()).toBe(200);
    expect(body()).toContain('rebel://space/Exec/memory%2FQ1.md');
  });

  it('returns 200 HTML for a legacy rebel:///start-voice action URL', async () => {
    const { res, status, body } = makeRes();
    await handleAppOpen(
      makeReq(`/app/open?u=${encodeURIComponent('rebel:///start-voice')}`),
      res,
    );
    expect(status()).toBe(200);
    expect(body()).toContain('rebel:///start-voice');
  });

  it('HTML-escapes potentially dangerous characters in the URL', async () => {
    // Construct a URL whose path contains a quote/angle bracket — shouldn't
    // happen for well-formed rebel URLs but we belt-and-braces escape anyway.
    const evilUrl = 'rebel://library/a"><script>alert(1)</script>';
    const { res, body } = makeRes();
    await handleAppOpen(
      makeReq(`/app/open?u=${encodeURIComponent(evilUrl)}`),
      res,
    );
    // The URL must be validated before rendering — in this case the parser
    // should reject the raw "<script" substring because it contains characters
    // outside the URL spec, but the handler must still HTML-escape whatever
    // passes through.
    // If the parser accepts it we'd want the script tag to be escaped:
    expect(body()).not.toContain('<script>alert(1)</script>');
  });
});

describe('handleAppOpen — validation and fallback', () => {
  it('302 redirects to fallback when u is missing', async () => {
    const { res, status, headers } = makeRes();
    await handleAppOpen(makeReq('/app/open'), res);
    expect(status()).toBe(302);
    expect(headers().Location).toBe('https://getrebel.mindstone.com');
  });

  it('302 redirects to fallback when u is empty', async () => {
    const { res, status, headers } = makeRes();
    await handleAppOpen(makeReq('/app/open?u='), res);
    expect(status()).toBe(302);
    expect(headers().Location).toBe('https://getrebel.mindstone.com');
  });

  it('302 redirects when u has the wrong scheme', async () => {
    const { res, status } = makeRes();
    await handleAppOpen(
      makeReq(`/app/open?u=${encodeURIComponent('https://evil.com')}`),
      res,
    );
    expect(status()).toBe(302);
  });

  it('302 redirects when u has an unknown rebel:// host (prevents open-redirect)', async () => {
    const { res, status } = makeRes();
    await handleAppOpen(
      makeReq(`/app/open?u=${encodeURIComponent('rebel://evil-surface/payload')}`),
      res,
    );
    expect(status()).toBe(302);
  });

  it('302 redirects when u is malformed (not parseable as URL)', async () => {
    const { res, status } = makeRes();
    await handleAppOpen(
      makeReq(`/app/open?u=${encodeURIComponent('not-a-url')}`),
      res,
    );
    expect(status()).toBe(302);
  });
});
