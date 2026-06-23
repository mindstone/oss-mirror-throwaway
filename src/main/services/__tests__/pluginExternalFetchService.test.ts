import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isDomainAllowed,
  isPrivateIp,
  checkFetchRateLimit,
  recordFetchCall,
  _resetFetchRateLimiterForTesting,
  _clearDnsCacheForTesting,
  executePluginFetch,
  type PluginFetchRequest,
} from '../pluginExternalFetchService';

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

// ── Domain Validation ──────────────────────────────────────────────────

describe('isDomainAllowed', () => {
  it('matches exact domain', () => {
    expect(isDomainAllowed('api.linear.app', null, ['api.linear.app'])).toBe(true);
  });

  it('rejects non-matching domain', () => {
    expect(isDomainAllowed('evil.com', null, ['api.linear.app'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isDomainAllowed('API.Linear.App', null, ['api.linear.app'])).toBe(true);
    expect(isDomainAllowed('api.linear.app', null, ['API.Linear.App'])).toBe(true);
  });

  it('matches wildcard subdomain', () => {
    expect(isDomainAllowed('api.github.com', null, ['*.github.com'])).toBe(true);
    expect(isDomainAllowed('raw.github.com', null, ['*.github.com'])).toBe(true);
  });

  it('wildcard does NOT match bare domain', () => {
    expect(isDomainAllowed('github.com', null, ['*.github.com'])).toBe(false);
  });

  it('wildcard only matches one subdomain level', () => {
    expect(isDomainAllowed('deep.sub.github.com', null, ['*.github.com'])).toBe(false);
  });

  it('matches with port when pattern includes port', () => {
    expect(isDomainAllowed('api.example.com', '8080', ['api.example.com:8080'])).toBe(true);
  });

  it('rejects port mismatch', () => {
    expect(isDomainAllowed('api.example.com', '9090', ['api.example.com:8080'])).toBe(false);
  });

  it('matches any port when pattern has no port', () => {
    expect(isDomainAllowed('api.example.com', '8080', ['api.example.com'])).toBe(true);
    expect(isDomainAllowed('api.example.com', null, ['api.example.com'])).toBe(true);
  });

  it('handles empty allowed list', () => {
    expect(isDomainAllowed('api.linear.app', null, [])).toBe(false);
  });

  it('handles multiple allowed domains', () => {
    const allowed = ['api.linear.app', '*.github.com', 'hooks.slack.com'];
    expect(isDomainAllowed('api.linear.app', null, allowed)).toBe(true);
    expect(isDomainAllowed('api.github.com', null, allowed)).toBe(true);
    expect(isDomainAllowed('hooks.slack.com', null, allowed)).toBe(true);
    expect(isDomainAllowed('evil.com', null, allowed)).toBe(false);
  });

  it('skips empty patterns', () => {
    expect(isDomainAllowed('api.linear.app', null, ['', '  ', 'api.linear.app'])).toBe(true);
  });
});

// ── Private IP Detection ───────────────────────────────────────────────

describe('isPrivateIp', () => {
  describe('IPv4 private ranges', () => {
    it('blocks 127.0.0.0/8 (loopback)', () => {
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('127.255.255.255')).toBe(true);
    });

    it('blocks 10.0.0.0/8', () => {
      expect(isPrivateIp('10.0.0.1')).toBe(true);
      expect(isPrivateIp('10.255.255.255')).toBe(true);
    });

    it('blocks 172.16.0.0/12', () => {
      expect(isPrivateIp('172.16.0.1')).toBe(true);
      expect(isPrivateIp('172.31.255.255')).toBe(true);
    });

    it('allows 172.32.0.0 (outside /12)', () => {
      expect(isPrivateIp('172.32.0.1')).toBe(false);
    });

    it('blocks 192.168.0.0/16', () => {
      expect(isPrivateIp('192.168.0.1')).toBe(true);
      expect(isPrivateIp('192.168.255.255')).toBe(true);
    });

    it('blocks 169.254.0.0/16 (link-local)', () => {
      expect(isPrivateIp('169.254.0.1')).toBe(true);
      expect(isPrivateIp('169.254.169.254')).toBe(true);
    });

    it('blocks 0.0.0.0/8', () => {
      expect(isPrivateIp('0.0.0.0')).toBe(true);
    });

    it('allows public IPs', () => {
      expect(isPrivateIp('8.8.8.8')).toBe(false);
      expect(isPrivateIp('1.1.1.1')).toBe(false);
      expect(isPrivateIp('93.184.216.34')).toBe(false);
    });
  });

  describe('IPv6 private ranges', () => {
    it('blocks ::1 (loopback)', () => {
      expect(isPrivateIp('::1')).toBe(true);
    });

    it('blocks fc00::/7 (unique local)', () => {
      expect(isPrivateIp('fc00::1')).toBe(true);
      expect(isPrivateIp('fd12::1')).toBe(true);
    });

    it('blocks fe80::/10 (link-local)', () => {
      expect(isPrivateIp('fe80::1')).toBe(true);
    });

    it('blocks :: (unspecified)', () => {
      expect(isPrivateIp('::')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 private', () => {
      expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    });

    it('allows IPv4-mapped IPv6 public', () => {
      expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
    });

    it('blocks IPv4-mapped IPv6 hex form (loopback)', () => {
      // ::ffff:7f00:1 = ::ffff:127.0.0.1
      expect(isPrivateIp('::ffff:7f00:1')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 hex form (private 10.x)', () => {
      // ::ffff:a00:1 = ::ffff:10.0.0.1
      expect(isPrivateIp('::ffff:a00:1')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 hex form (private 192.168.x)', () => {
      // ::ffff:c0a8:101 = ::ffff:192.168.1.1
      expect(isPrivateIp('::ffff:c0a8:101')).toBe(true);
    });

    it('allows IPv4-mapped IPv6 hex form (public)', () => {
      // ::ffff:808:808 = ::ffff:8.8.8.8
      expect(isPrivateIp('::ffff:808:808')).toBe(false);
    });
  });

  describe('hostname checks', () => {
    it('blocks localhost', () => {
      expect(isPrivateIp('localhost')).toBe(true);
    });

    it('blocks *.local', () => {
      expect(isPrivateIp('myhost.local')).toBe(true);
    });
  });
});

// ── Rate Limiting ──────────────────────────────────────────────────────

describe('fetchRateLimit', () => {
  beforeEach(() => {
    _resetFetchRateLimiterForTesting();
  });

  it('allows requests under the limit', () => {
    expect(checkFetchRateLimit('test-plugin').allowed).toBe(true);
  });

  it('blocks after 30 requests in a window', () => {
    for (let i = 0; i < 30; i++) {
      recordFetchCall('test-plugin');
    }
    const result = checkFetchRateLimit('test-plugin');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows requests from different plugins independently', () => {
    for (let i = 0; i < 30; i++) {
      recordFetchCall('plugin-a');
    }
    expect(checkFetchRateLimit('plugin-a').allowed).toBe(false);
    expect(checkFetchRateLimit('plugin-b').allowed).toBe(true);
  });

  it('returns retryAfterMs when rate limited', () => {
    for (let i = 0; i < 30; i++) {
      recordFetchCall('test-plugin');
    }
    const result = checkFetchRateLimit('test-plugin');
    expect(result.retryAfterMs).toBeDefined();
    expect(typeof result.retryAfterMs).toBe('number');
  });
});

// ── executePluginFetch ─────────────────────────────────────────────────

describe('executePluginFetch', () => {
  beforeEach(() => {
    _resetFetchRateLimiterForTesting();
    _clearDnsCacheForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseRequest: PluginFetchRequest = {
    url: 'https://api.linear.app/graphql',
    method: 'GET',
    pluginId: 'test-plugin',
    allowedDomains: ['api.linear.app'],
  };

  it('rejects non-GET methods', async () => {
    const _result = await executePluginFetch({
      ...baseRequest,
      method: 'GET', // Only GET is allowed; testing type safety
    });
    // The method field is typed as 'GET', so we test by casting
    const badRequest = { ...baseRequest, method: 'POST' as 'GET' };
    const badResult = await executePluginFetch(badRequest);
    expect(badResult.ok).toBe(false);
    expect(badResult.error).toContain('Only GET');
  });

  it('rejects invalid URLs', async () => {
    const result = await executePluginFetch({
      ...baseRequest,
      url: 'not-a-valid-url',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('rejects unsupported protocols', async () => {
    const result = await executePluginFetch({
      ...baseRequest,
      url: 'ftp://api.linear.app/file',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported protocol');
  });

  it('rejects domains not in the allowed list', async () => {
    const result = await executePluginFetch({
      ...baseRequest,
      url: 'https://evil.com/data',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not in the allowed domains');
  });

  it('rejects when rate limited', async () => {
    for (let i = 0; i < 30; i++) {
      recordFetchCall('test-plugin');
    }

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Rate limit exceeded');
  });

  it('rejects private IP hostnames (localhost)', async () => {
    const result = await executePluginFetch({
      ...baseRequest,
      url: 'http://localhost:3000/api',
      allowedDomains: ['localhost'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('local');
  });

  it('rejects private IP hostnames (127.0.0.1)', async () => {
    const result = await executePluginFetch({
      ...baseRequest,
      url: 'http://127.0.0.1:3000/api',
      allowedDomains: ['127.0.0.1'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('private/local network');
  });

  it('rejects when DNS resolves to private IP', async () => {
    const dns = await import('node:dns/promises');
    const dnsModule = dns.default ?? dns;
    vi.mocked(dnsModule.resolve4).mockResolvedValue(['192.168.1.1']);
    vi.mocked(dnsModule.resolve6).mockRejectedValue(new Error('no AAAA'));

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!).toMatch(/private|rebinding/i);
  });

  it('strips cookie headers', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: 'test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await executePluginFetch({
      ...baseRequest,
      headers: {
        'Authorization': 'Bearer token',
        'Cookie': 'session=abc',
        'cookie': 'session=abc',
      },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.not.objectContaining({
          'Cookie': 'session=abc',
          'cookie': 'session=abc',
        }),
      }),
    );
  });

  it('returns parsed JSON for JSON responses', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    const mockData = { issues: [{ id: 1, title: 'Bug' }] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual(mockData);
  });

  it('returns text for non-JSON responses', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Hello, World!', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(true);
    expect(result.data).toBe('Hello, World!');
  });

  it('handles redirect responses', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { 'Location': 'https://evil.com' },
      }),
    );

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(301);
    expect(result.error).toContain('Redirects are disabled');
  });

  it('uses redirect: manual in fetch options', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await executePluginFetch(baseRequest);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('handles fetch timeout (AbortError)', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    const abortError = new DOMException('The operation was aborted', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('handles fetch network error', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('handles DNS resolution failure', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockRejectedValue(new Error('ENOTFOUND'));
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('ENOTFOUND'));

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no addresses found');
  });

  it('handles response too large (via content-length header)', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'content-length': '2000000' },
      }),
    );

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('too large');
  });

  // ── Lifecycle: discard paths must cancel the unread body so the per-request
  //    pinned dispatcher (graceful-closed in finally) can release its socket. ──

  it('cancels the response body on a discarded 3xx redirect (no dispatcher leak)', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    const redirectResponse = new Response('redirect-body', {
      status: 301,
      headers: { 'Location': 'https://evil.com' },
    });
    const cancelSpy = redirectResponse.body
      ? vi.spyOn(redirectResponse.body, 'cancel').mockResolvedValue(undefined)
      : undefined;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(redirectResponse);

    const result = await executePluginFetch(baseRequest);
    expect(result.status).toBe(301);
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('cancels the response body when content-length exceeds the limit (no dispatcher leak)', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    const bigResponse = new Response('x', {
      status: 200,
      headers: { 'content-length': '2000000' },
    });
    const cancelSpy = bigResponse.body
      ? vi.spyOn(bigResponse.body, 'cancel').mockResolvedValue(undefined)
      : undefined;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(bigResponse);

    const result = await executePluginFetch(baseRequest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('too large');
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('passes Authorization header through', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await executePluginFetch({
      ...baseRequest,
      headers: { 'Authorization': 'Bearer my-token' },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer my-token',
        }),
      }),
    );
  });

  it('pins connect to the validated IP via a dispatcher, leaving the URL hostname intact (closes DNS-rebinding TOCTOU)', async () => {
    const dns = await import('node:dns/promises');
    vi.mocked((dns.default ?? dns).resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await executePluginFetch({
      ...baseRequest,
      url: 'http://api.linear.app/data',
    });

    // The URL hostname is UNCHANGED — undici derives the correct Host header
    // (and, for https, TLS SNI) from it, while the socket connects to the
    // validated IP via the dispatcher's pinned connect.lookup.
    const fetchedUrl = fetchSpy.mock.calls[0][0] as string;
    expect(fetchedUrl).toBe('http://api.linear.app/data');
    expect(fetchedUrl).not.toContain('93.184.216.34');

    // A per-request dispatcher (pinned to the validated IP) is supplied.
    const fetchedOptions = fetchSpy.mock.calls[0][1] as { dispatcher?: unknown; headers?: Record<string, string> };
    expect(fetchedOptions.dispatcher).toBeDefined();

    // We no longer hand-set a Host header — undici derives it from the hostname.
    const headers = fetchedOptions.headers ?? {};
    expect(headers['Host']).toBeUndefined();
  });

  it('reuses DNS cache for rapid sequential requests', async () => {
    const dns = await import('node:dns/promises');
    const resolve4Mock = vi.mocked((dns.default ?? dns).resolve4);
    resolve4Mock.mockResolvedValue(['93.184.216.34']);
    vi.mocked((dns.default ?? dns).resolve6).mockRejectedValue(new Error('no AAAA'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    // Record call count before our test calls
    const callsBefore = resolve4Mock.mock.calls.length;

    await executePluginFetch(baseRequest);
    await executePluginFetch(baseRequest);

    // DNS should only be resolved once for the two fetches (second uses cache)
    expect(resolve4Mock.mock.calls.length - callsBefore).toBe(1);
  });
});
