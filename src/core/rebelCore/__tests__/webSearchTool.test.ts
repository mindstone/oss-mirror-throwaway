import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { scrapeDdgResults } from '../tools/webSearchScraper';
import {
  executeWebSearch,
  WEB_SEARCH_TOOL_DEFINITION,
  __resetWebSearchCaptchaCooldownForTests,
  __setWebSearchClockForTests,
} from '../tools/webSearchTool';
import type { BuiltinToolContext } from '../types';
import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';

// ── DDG HTML Fixtures ───────────────────────────────────────────────────

/** Realistic DDG HTML with search results. */
const DDG_HTML_WITH_RESULTS = `
<!DOCTYPE html>
<html>
<head><title>DuckDuckGo</title></head>
<body>
  <div id="links" class="results">
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a class="result__a" href="https://example.com/page1">Example Page One</a>
        </h2>
        <a class="result__snippet">This is the first search result snippet with useful information.</a>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a class="result__a" href="https://example.org/page2">Another Result Page</a>
        </h2>
        <a class="result__snippet">Second result snippet containing relevant details about the query.</a>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a class="result__a" href="https://test.com/page3">Third Result Title</a>
        </h2>
        <a class="result__snippet">Third result with even more information for the searcher.</a>
      </div>
    </div>
  </div>
</body>
</html>
`;

/** DDG HTML with redirect-wrapped URLs (uddg parameter). */
const DDG_HTML_WITH_REDIRECT_URLS = `
<!DOCTYPE html>
<html>
<body>
  <div class="results">
    <div class="result results_links">
      <h2 class="result__title">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal-site.com%2Farticle&rut=abc123">Redirected Result</a>
      </h2>
      <a class="result__snippet">A result with a redirect URL.</a>
    </div>
  </div>
</body>
</html>
`;

/** DDG CAPTCHA page — form with hidden inputs, no search results. */
const DDG_CAPTCHA_HTML = `
<!DOCTYPE html>
<html>
<head><title>DuckDuckGo</title></head>
<body>
  <div class="content">
    <form method="POST" action="/challenge">
      <input type="hidden" name="csrf_token" value="abc123">
      <input type="hidden" name="challenge_id" value="xyz789">
      <input type="hidden" name="nonce" value="def456">
      <div class="challenge-container">
        <img src="/captcha-image.png" />
        <input type="text" name="response" />
        <button type="submit">Submit</button>
      </div>
    </form>
  </div>
</body>
</html>
`;

/** DDG anomaly-modal image-puzzle CAPTCHA (introduced ~2026). */
const DDG_ANOMALY_CAPTCHA_HTML = `
<!DOCTYPE html>
<html lang="en">
<head><title>DuckDuckGo</title></head>
<body>
  <center id="lite_wrapper">
    <iframe name="ifr" width="0" height="0" class="hidden"></iframe>
    <form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&cc=botnet" method="POST">
      <div class="anomaly-modal__mask">
        <div class="anomaly-modal__modal is-ie" data-testid="anomaly-modal">
          <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
          <div class="anomaly-modal__description">Please complete the following challenge.</div>
          <div class="anomaly-modal__puzzle">
            <div class="anomaly-modal__box" data-index="0">
              <label for="image-check_abc123" data-testid="anomaly-modal-tile-0">
                <input type="checkbox" class="anomaly-modal__check" name="image-check_abc123">
                <img class="anomaly-modal__image" src="../assets/anomaly/images/challenge/abc123.jpg">
              </label>
            </div>
            <div class="anomaly-modal__box" data-index="1">
              <label for="image-check_def456" data-testid="anomaly-modal-tile-1">
                <input type="checkbox" class="anomaly-modal__check" name="image-check_def456">
                <img class="anomaly-modal__image" src="../assets/anomaly/images/challenge/def456.jpg">
              </label>
            </div>
          </div>
          <button type="submit">Submit</button>
        </div>
      </div>
    </form>
  </center>
</body>
</html>
`;

/** Non-empty HTML that has no DDG results and no CAPTCHA (parser drift). */
const DDG_PARSER_DRIFT_HTML = `
<!DOCTYPE html>
<html>
<head><title>DuckDuckGo</title></head>
<body>
  <div class="new-layout-wrapper">
    <div class="redesigned-results-container">
      <div class="new-result-card">
        <h3 class="new-result-title"><a href="https://example.com">Example</a></h3>
        <p class="new-result-desc">A result in a new format we don't know about.</p>
      </div>
    </div>
  </div>
  ${'<!-- padding to exceed 1KB threshold -->'.repeat(30)}
</body>
</html>
`;

/** Valid DDG page with zero results (legitimate empty search). */
const DDG_EMPTY_RESULTS_HTML = `
<!DOCTYPE html>
<html>
<head><title>DuckDuckGo</title></head>
<body>
  <div class="results">
    <div class="no-results">No results</div>
  </div>
</body>
</html>
`;

/** Minimal DDG page — too small for parser drift. */
const DDG_MINIMAL_HTML = '<html><body></body></html>';

// ── Test helpers ────────────────────────────────────────────────────────

/** Create a minimal BuiltinToolContext for testing. */
function makeContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    cwd: '/tmp/test',
    rateLimitState: new Map(),
    ...overrides,
  };
}

/** Mock global fetch to return specific HTML (fresh Response per call). */
function mockFetchHtml(html: string, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(html, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  );
}

/** Install a spy-backed ErrorReporter and return its spies. */
function installSpyReporter() {
  const captureMessage = vi.fn();
  const captureException = vi.fn();
  const addBreadcrumb = vi.fn();
  const reporter: ErrorReporter = { captureMessage, captureException, addBreadcrumb };
  setErrorReporter(reporter);
  return { captureMessage, captureException, addBreadcrumb };
}

/** Reset ErrorReporter back to the silent no-op default. */
function resetReporter() {
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
}

// ── Scraper Tests ───────────────────────────────────────────────────────

describe('scrapeDdgResults', () => {
  it('parses results from DDG HTML with multiple results', () => {
    const result = scrapeDdgResults(DDG_HTML_WITH_RESULTS);

    expect(result.captchaDetected).toBe(false);
    expect(result.parserDrift).toBe(false);
    expect(result.results).toHaveLength(3);

    expect(result.results[0]).toEqual({
      title: 'Example Page One',
      url: 'https://example.com/page1',
      snippet: 'This is the first search result snippet with useful information.',
    });

    expect(result.results[1]).toEqual({
      title: 'Another Result Page',
      url: 'https://example.org/page2',
      snippet: 'Second result snippet containing relevant details about the query.',
    });

    expect(result.results[2]).toEqual({
      title: 'Third Result Title',
      url: 'https://test.com/page3',
      snippet: 'Third result with even more information for the searcher.',
    });
  });

  it('extracts real URL from DDG redirect-wrapped uddg parameter', () => {
    const result = scrapeDdgResults(DDG_HTML_WITH_REDIRECT_URLS);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://real-site.com/article');
    expect(result.results[0]!.title).toBe('Redirected Result');
  });

  it('detects CAPTCHA page (form with hidden inputs, no results)', () => {
    const result = scrapeDdgResults(DDG_CAPTCHA_HTML);

    expect(result.captchaDetected).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.parserDrift).toBe(false);
  });

  it('detects anomaly-modal image-puzzle CAPTCHA', () => {
    const result = scrapeDdgResults(DDG_ANOMALY_CAPTCHA_HTML);

    expect(result.captchaDetected).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.parserDrift).toBe(false);
  });

  it('detects CAPTCHA via anomaly.js form action even without anomaly-modal class', () => {
    const html = `
      <html><body>
        <form action="//duckduckgo.com/anomaly.js?sv=html&cc=botnet" method="POST">
          <div class="some-new-class">
            <input type="checkbox" name="check_1">
            <button type="submit">Verify</button>
          </div>
        </form>
        ${'<!-- padding -->'.repeat(80)}
      </body></html>
    `;
    const result = scrapeDdgResults(html);

    expect(result.captchaDetected).toBe(true);
    expect(result.parserDrift).toBe(false);
  });

  it('detects parser drift (non-empty response, zero results, no CAPTCHA)', () => {
    const result = scrapeDdgResults(DDG_PARSER_DRIFT_HTML);

    expect(result.parserDrift).toBe(true);
    expect(result.captchaDetected).toBe(false);
    expect(result.results).toHaveLength(0);
  });

  it('includes content-free driftSnippet when parser drift is detected', () => {
    const result = scrapeDdgResults(DDG_PARSER_DRIFT_HTML);

    expect(result.parserDrift).toBe(true);
    expect(result.driftSnippet).toBeDefined();
    expect(result.driftSnippet).toContain('bodyLen=');
    expect(result.driftSnippet).toContain('titleLen=');
    expect(result.driftSnippet).toContain('forms=');
    expect(result.driftSnippet).toContain('links=');
  });

  it('does not leak title text via driftSnippet (DDG echoes query in <title>)', () => {
    // DDG renders something like "<query> at DuckDuckGo" — must not reach Sentry.
    const htmlWithQueryInTitle = `
      <!DOCTYPE html>
      <html>
      <head><title>sensitive-leak-token at DuckDuckGo</title></head>
      <body>
        <div class="new-layout-container">no results parseable here</div>
        ${'<!-- padding -->'.repeat(80)}
      </body>
      </html>
    `;
    const result = scrapeDdgResults(htmlWithQueryInTitle);

    expect(result.parserDrift).toBe(true);
    expect(result.driftSnippet).toBeDefined();
    expect(result.driftSnippet).not.toContain('sensitive-leak-token');
    expect(result.driftSnippet).not.toContain('DuckDuckGo');
    expect(result.driftSnippet).toMatch(/titleLen=\d+/);
  });

  it('does not include driftSnippet when results are found', () => {
    const result = scrapeDdgResults(DDG_HTML_WITH_RESULTS);

    expect(result.parserDrift).toBe(false);
    expect(result.driftSnippet).toBeUndefined();
  });

  it('does not include driftSnippet when CAPTCHA is detected', () => {
    const result = scrapeDdgResults(DDG_ANOMALY_CAPTCHA_HTML);

    expect(result.captchaDetected).toBe(true);
    expect(result.driftSnippet).toBeUndefined();
  });

  it('handles valid empty search (small response, no results)', () => {
    const result = scrapeDdgResults(DDG_EMPTY_RESULTS_HTML);

    expect(result.results).toHaveLength(0);
    expect(result.captchaDetected).toBe(false);
    // Below 1KB threshold — NOT parser drift
    expect(result.parserDrift).toBe(false);
  });

  it('handles minimal HTML (too small for parser drift)', () => {
    const result = scrapeDdgResults(DDG_MINIMAL_HTML);

    expect(result.results).toHaveLength(0);
    expect(result.captchaDetected).toBe(false);
    expect(result.parserDrift).toBe(false);
  });

  it('does not trigger CAPTCHA for DDG search form (has search input)', () => {
    const htmlWithSearchForm = `
      <html><body>
        <form method="POST" action="/html/">
          <input type="hidden" name="csrf" value="token1">
          <input type="hidden" name="session" value="token2">
          <input name="q" type="text" value="test query">
          <button type="submit">Search</button>
        </form>
        <div class="result"><a class="result__a" href="https://example.com">A Result</a></div>
      </body></html>
    `;
    const result = scrapeDdgResults(htmlWithSearchForm);

    expect(result.captchaDetected).toBe(false);
    expect(result.results).toHaveLength(1);
  });

  it('handles results without snippets', () => {
    const html = `
      <html><body>
        <div class="result">
          <a class="result__a" href="https://example.com/nospin">No Snippet Page</a>
        </div>
      </body></html>
    `;
    const result = scrapeDdgResults(html);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe('No Snippet Page');
    expect(result.results[0]!.snippet).toBe('');
  });
});

// ── Tool Definition Tests ───────────────────────────────────────────────

describe('WEB_SEARCH_TOOL_DEFINITION', () => {
  it('has correct name and required fields', () => {
    expect(WEB_SEARCH_TOOL_DEFINITION.name).toBe('WebSearch');
    expect(WEB_SEARCH_TOOL_DEFINITION.input_schema.required).toEqual(['query']);
    expect(WEB_SEARCH_TOOL_DEFINITION.input_schema.properties).toHaveProperty('query');
    expect(WEB_SEARCH_TOOL_DEFINITION.input_schema.properties).toHaveProperty('maxResults');
  });
});

// ── Tool Executor Tests ─────────────────────────────────────────────────

describe('executeWebSearch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetWebSearchCaptchaCooldownForTests();
    __setWebSearchClockForTests(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetWebSearchCaptchaCooldownForTests();
    __setWebSearchClockForTests(null);
  });

  // ── Input validation ───────────────────────────────────────────────

  it('returns error for null input', async () => {
    const result = await executeWebSearch(null, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('requires a valid input');
  });

  it('returns error for missing query', async () => {
    const result = await executeWebSearch({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('non-empty search query');
  });

  it('returns error for empty query', async () => {
    const result = await executeWebSearch({ query: '  ' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('non-empty search query');
  });

  // ── Happy path ────────────────────────────────────────────────────

  it('fetches and formats search results as markdown', async () => {
    mockFetchHtml(DDG_HTML_WITH_RESULTS);

    const result = await executeWebSearch({ query: 'test search' }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 3 results');
    expect(result.output).toContain('**Example Page One**');
    expect(result.output).toContain('https://example.com/page1');
    expect(result.output).toContain('first search result snippet');
    expect(result.output).toContain('**Another Result Page**');
    expect(result.output).toContain('**Third Result Title**');
  });

  it('respects maxResults parameter', async () => {
    mockFetchHtml(DDG_HTML_WITH_RESULTS);

    const result = await executeWebSearch({ query: 'test', maxResults: 2 }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 2 results');
    // Should have 2 results, not 3
    expect(result.output).not.toContain('Third Result Title');
  });

  // ── CAPTCHA handling ──────────────────────────────────────────────

  it('returns error with upgrade suggestion on CAPTCHA', async () => {
    mockFetchHtml(DDG_CAPTCHA_HTML);

    const result = await executeWebSearch({ query: 'test' }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('blocked by the upstream search provider');
    expect(result.output).toContain('Do not retry WebSearch');
    expect(result.output).toContain('Settings → Connectors');
    expect(result.output).toContain('Brave Search');
  });

  // ── Anomaly-modal CAPTCHA ───────────────────────────────────────

  it('returns error with upgrade suggestion on anomaly-modal CAPTCHA', async () => {
    mockFetchHtml(DDG_ANOMALY_CAPTCHA_HTML);

    const result = await executeWebSearch({ query: 'test' }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('blocked by the upstream search provider');
    expect(result.output).toContain('Do not retry WebSearch');
    expect(result.output).toContain('Settings → Connectors');
  });

  // ── Copy regression guards ──────────────────────────────────────
  // These assertions lock in the honest, agent-actionable messages so a future
  // edit doesn't re-introduce the misleading "temporarily unavailable due to
  // high usage" phrasing that caused the agent to retry a session-sticky block
  // (see docs-private/postmortems/260421_websearch_ddg_captcha_postmortem.md).

  it('CAPTCHA message does NOT claim "high usage" (misleading transience signal)', async () => {
    mockFetchHtml(DDG_CAPTCHA_HTML);
    const result = await executeWebSearch({ query: 'test' }, makeContext());
    expect(result.output.toLowerCase()).not.toContain('high usage');
    expect(result.output.toLowerCase()).not.toContain('temporarily unavailable');
  });

  it('CAPTCHA message tells the agent to surface the situation to the user', async () => {
    mockFetchHtml(DDG_CAPTCHA_HTML);
    const result = await executeWebSearch({ query: 'test' }, makeContext());
    // Agent-actionable guidance: tell the user (not just retry silently)
    expect(result.output.toLowerCase()).toContain('tell the user');
  });

  // Regression guard for conversation `d434dc09-...` where the agent
  // paraphrased the old "session-sticky block" copy as "Rebel caps at 5
  // queries per session" (a product cap that does not exist). The CAPTCHA
  // message MUST explicitly attribute the block to DuckDuckGo and negate
  // the "Rebel cap" framing so the agent cannot collapse upstream behaviour
  // into a Rebel product story when it re-narrates to the user.
  it('CAPTCHA message names DuckDuckGo explicitly (not just "upstream provider")', async () => {
    mockFetchHtml(DDG_CAPTCHA_HTML);
    const result = await executeWebSearch({ query: 'test' }, makeContext());
    expect(result.output).toContain('DuckDuckGo');
  });

  it('CAPTCHA message explicitly denies this is a Rebel-imposed cap', async () => {
    mockFetchHtml(DDG_CAPTCHA_HTML);
    const result = await executeWebSearch({ query: 'test' }, makeContext());
    // Must contain wording that rules out "Rebel caps searches per session"
    // paraphrasing. "Not a Rebel..." / "not a ... quota" are the load-bearing
    // phrases — keep at least one.
    const output = result.output;
    const rulesOutRebelCap =
      /not a Rebel-imposed (quota|cap|limit)/i.test(output) ||
      /not a Rebel.{0,40}(quota|cap|limit)/i.test(output);
    expect(rulesOutRebelCap).toBe(true);
  });

  it('CAPTCHA message does NOT describe the block as "session-sticky"', async () => {
    // The old phrase "session-sticky" was collapsible by the agent into a
    // Rebel per-session cap. The replacement copy uses "IP-level" / "upstream"
    // framing instead.
    mockFetchHtml(DDG_CAPTCHA_HTML);
    const result = await executeWebSearch({ query: 'test' }, makeContext());
    expect(result.output.toLowerCase()).not.toContain('session-sticky');
  });

  it('rate-limit message tells the agent not to retry WebSearch', async () => {
    const rateLimitState = new Map<string, number>();
    rateLimitState.set('WebSearch', 5);
    const result = await executeWebSearch(
      { query: 'test' },
      makeContext({ rateLimitState }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Do not retry WebSearch');
    expect(result.output.toLowerCase()).toContain('tell the user');
  });

  // Symmetric regression guard against the inverse of the CAPTCHA confusion:
  // the rate-limit message describes a REAL Rebel-side cap (5/task), so the
  // copy must attribute it to Rebel, not to DuckDuckGo, to avoid the agent
  // narrating "DuckDuckGo is rate-limiting you" when the request never left
  // this process.
  it('rate-limit message frames the cap as Rebel-side (not an upstream DDG limit)', async () => {
    const rateLimitState = new Map<string, number>();
    rateLimitState.set('WebSearch', 5);
    const result = await executeWebSearch(
      { query: 'test' },
      makeContext({ rateLimitState }),
    );
    const output = result.output;
    // Must attribute the cap to Rebel / built-in / self-imposed.
    expect(output).toMatch(/Rebel[- ]side|Rebel caps|self-imposed|built-in/i);
  });

  // ── Parser drift ─────────────────────────────────────────────────

  it('returns error on parser drift', async () => {
    mockFetchHtml(DDG_PARSER_DRIFT_HTML);

    const result = await executeWebSearch({ query: 'test' }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('could not be parsed');
    expect(result.output).toContain('Do not retry WebSearch');
  });

  // ── Empty results ─────────────────────────────────────────────────

  it('returns "No results found" (not isError) for empty results', async () => {
    mockFetchHtml(DDG_EMPTY_RESULTS_HTML);

    const result = await executeWebSearch({ query: 'xyzzy nonexistent search' }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.output).toContain('No results found');
    expect(result.output).toContain('xyzzy nonexistent search');
  });

  // ── Network error ─────────────────────────────────────────────────

  it('returns error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));

    const result = await executeWebSearch({ query: 'test' }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Search failed');
  });

  // ── Timeout ───────────────────────────────────────────────────────

  it('returns timeout error when fetch times out', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );

    const result = await executeWebSearch({ query: 'slow search' }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('timed out');
  });

  // ── Rate limit ────────────────────────────────────────────────────

  it('enforces per-turn rate limit (5 calls)', async () => {
    const rateLimitState = new Map<string, number>();
    rateLimitState.set('WebSearch', 5);

    const result = await executeWebSearch(
      { query: 'test' },
      makeContext({ rateLimitState }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('search limit');
    expect(result.output).toContain('5 searches per task');
    expect(result.output).toContain('Settings → Connectors');
  });

  it('does not call fetch when rate limited', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rateLimitState = new Map<string, number>();
    rateLimitState.set('WebSearch', 5);

    await executeWebSearch(
      { query: 'test' },
      makeContext({ rateLimitState }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('increments rate limit counter on successful search', async () => {
    mockFetchHtml(DDG_HTML_WITH_RESULTS);

    const rateLimitState = new Map<string, number>();
    const ctx = makeContext({ rateLimitState });

    await executeWebSearch({ query: 'first search' }, ctx);
    expect(rateLimitState.get('WebSearch')).toBe(1);

    await executeWebSearch({ query: 'second search' }, ctx);
    expect(rateLimitState.get('WebSearch')).toBe(2);
  });

  it('does not increment rate limit counter on CAPTCHA', async () => {
    mockFetchHtml(DDG_CAPTCHA_HTML);

    const rateLimitState = new Map<string, number>();
    const ctx = makeContext({ rateLimitState });

    await executeWebSearch({ query: 'test' }, ctx);

    // Should NOT increment — CAPTCHA is not a successful search
    expect(rateLimitState.get('WebSearch')).toBeUndefined();
  });

  it('does not increment rate limit counter on empty results', async () => {
    mockFetchHtml(DDG_EMPTY_RESULTS_HTML);

    const rateLimitState = new Map<string, number>();
    const ctx = makeContext({ rateLimitState });

    await executeWebSearch({ query: 'nothing here' }, ctx);

    // Empty results should NOT count against rate limit
    expect(rateLimitState.get('WebSearch')).toBeUndefined();
  });

  // ── Works without rateLimitState ──────────────────────────────────

  it('works when context has no rateLimitState', async () => {
    mockFetchHtml(DDG_HTML_WITH_RESULTS);

    const result = await executeWebSearch(
      { query: 'test' },
      { cwd: '/tmp' },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 3 results');
  });

  // ── maxResults edge cases ─────────────────────────────────────────

  it('caps maxResults at 20', async () => {
    mockFetchHtml(DDG_HTML_WITH_RESULTS);

    const result = await executeWebSearch({ query: 'test', maxResults: 100 }, makeContext());

    // Should not error — caps to 20, but there are only 3 results
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 3 results');
  });

  it('treats non-numeric maxResults as default', async () => {
    mockFetchHtml(DDG_HTML_WITH_RESULTS);

    const result = await executeWebSearch({ query: 'test', maxResults: 'invalid' }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 3 results');
  });

  // ── Concurrency cap ──────────────────────────────────────────────
  //
  // Regression guard for conversation `a49f7390-f831` where a skill fired 10
  // parallel WebSearches and ~4 hit DuckDuckGo's IP-level anti-bot tripwire.
  // The semaphore serialises in-flight fetches to MAX_CONCURRENT_SEARCHES (3)
  // so bursts complete sequentially under DDG's tolerance instead of half-
  // failing. The cap is process-wide (not per-task) because DDG's anti-bot
  // classifier keys on the app's IP.
  //
  // This test uses a fetch mock that tracks concurrent in-flight calls via a
  // shared counter so we can assert the cap held across the burst. No
  // rateLimitState is passed — otherwise only 5 of the 10 would ever reach
  // fetch and the concurrency observation would be diluted.

  it('limits concurrent DDG fetches to MAX_CONCURRENT_SEARCHES (3)', async () => {
    let activeFetches = 0;
    let maxObservedActive = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      activeFetches += 1;
      maxObservedActive = Math.max(maxObservedActive, activeFetches);
      // Real setTimeout — fake timers would cause fetches to resolve
      // synchronously and hide the concurrency we want to observe.
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeFetches -= 1;
      return new Response(DDG_HTML_WITH_RESULTS, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    // No rateLimitState → no per-task 5-call cap gets in the way; all 10
    // calls reach fetch, gated only by the semaphore.
    const promises = Array.from({ length: 10 }, (_, i) =>
      executeWebSearch({ query: `burst query ${i}` }, { cwd: '/tmp' }),
    );
    const results = await Promise.all(promises);

    // Primary assertion: the semaphore is saturated (exactly 3 concurrent,
    // not 1, not 2). Using `.toBe(3)` catches an accidental under-cap
    // (e.g., a refactor that drops the capacity to 2) that `.toBeLessThanOrEqual`
    // would silently pass. With 10 in-flight and a 15ms hold, we reliably
    // observe 3 concurrent fetches during the burst window.
    expect(maxObservedActive).toBe(3);

    // Sanity: all 10 calls completed successfully (serialised, not dropped).
    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.isError).toBe(false);
    }
  });

  // GPT SHOULD-FIX: the 5/task cap must be a HARD cap even under concurrency.
  // Before the reservation pattern was added, 3 concurrent callers in the
  // critical section could all observe counter=4 (pre-increment), all pass
  // the check, all fetch successfully, and overshoot to counter=7. This test
  // fires 10 parallel calls with counter=0, verifies exactly 5 succeed and
  // 5 are rejected with the rate-limit message.
  it('enforces a HARD 5/task cap even when 10 calls run in parallel', async () => {
    mockFetchHtml(DDG_HTML_WITH_RESULTS);
    const rateLimitState = new Map<string, number>();
    const ctx = makeContext({ rateLimitState });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        executeWebSearch({ query: `parallel ${i}` }, ctx),
      ),
    );

    const succeeded = results.filter((r) => !r.isError);
    const rateLimited = results.filter(
      (r) => r.isError && r.output.includes('5 searches per task'),
    );

    expect(succeeded).toHaveLength(5);
    expect(rateLimited).toHaveLength(5);
    expect(rateLimitState.get('WebSearch')).toBe(5);
  });

  // Opus SHOULD-FIX #1: explicitly test the rate-limit early-return release
  // path. Without this, a refactor that narrowed the try/finally to only the
  // fetch block would silently leak slots on every rate-limited call. This
  // test would hang (timeout) if the semaphore leaked on the early-return
  // path, because the follow-up successful call couldn't acquire a slot.
  it('releases the semaphore slot on rate-limit early-return (no slot leak)', async () => {
    const rateLimitState = new Map<string, number>();
    rateLimitState.set('WebSearch', 5);

    // Fire enough rate-limited calls in parallel to exhaust the semaphore
    // if every early-return leaked its slot. 10 leaked slots with capacity=3
    // would permanently block a follow-up call.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        executeWebSearch({ query: `limited ${i}` }, makeContext({ rateLimitState })),
      ),
    );

    // Follow-up: fresh context (no rate limit), must complete promptly.
    // If slots leaked, this would hang until Vitest's default timeout.
    mockFetchHtml(DDG_HTML_WITH_RESULTS);
    const follow = await executeWebSearch(
      { query: 'follow-up' },
      makeContext(),
    );
    expect(follow.isError).toBe(false);
  });

  it('releases semaphore slots on fetch failure so later searches do not hang', async () => {
    // If release() were missing from the catch path, a single fetch error
    // would leak a slot and a follow-up burst would effectively see cap=2,
    // cap=1, eventually cap=0 (permanent hang). We assert follow-up calls
    // after N failures still complete promptly.
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('boom'));
    await executeWebSearch({ query: 'fail once' }, makeContext());

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('boom'));
    await executeWebSearch({ query: 'fail twice' }, makeContext());

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('boom'));
    await executeWebSearch({ query: 'fail thrice' }, makeContext());

    // After 3 consecutive failures, the semaphore should still have all
    // slots free. If slots leaked, this final happy-path call would hang
    // indefinitely (Vitest's default timeout would fire) rather than return.
    mockFetchHtml(DDG_HTML_WITH_RESULTS);
    const result = await executeWebSearch({ query: 'recover' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 3 results');
  });
});

// ── Telemetry Tests ─────────────────────────────────────────────────────
//
// Each failure branch must report to Sentry via ErrorReporter.captureMessage
// so the rate of DDG CAPTCHAs / drift / rate-limit / network errors is
// observable centrally. Pino logs alone only emit breadcrumbs, which are
// not searchable Sentry events.

describe('executeWebSearch telemetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetWebSearchCaptchaCooldownForTests();
    __setWebSearchClockForTests(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetReporter();
    __resetWebSearchCaptchaCooldownForTests();
    __setWebSearchClockForTests(null);
  });

  it('reports CAPTCHA to Sentry with failureMode=captcha tag', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml(DDG_CAPTCHA_HTML);

    await executeWebSearch({ query: 'test' }, makeContext());

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = captureMessage.mock.calls[0]!;
    // De-fragmented (rebel-sentry/no-dynamic-capture-message): the Sentry MESSAGE
    // is now a stable string; the captcha detail lives in tags.failureMode/extra.
    expect(message).toBe('WebSearch failure');
    expect(context).toMatchObject({
      level: 'warning',
      tags: { area: 'tool', tool: 'WebSearch', failureMode: 'captcha' },
    });
    // Never include the query text — privacy
    expect(JSON.stringify(context)).not.toContain('test');
  });

  it('reports anomaly-modal CAPTCHA with the same tag', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml(DDG_ANOMALY_CAPTCHA_HTML);

    await executeWebSearch({ query: 'test' }, makeContext());

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const context = captureMessage.mock.calls[0]![1] as Record<string, unknown>;
    const tags = context.tags as Record<string, string>;
    expect(tags.failureMode).toBe('captcha');
  });

  it('reports parser drift with failureMode=parserDrift and driftSnippet extra', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml(DDG_PARSER_DRIFT_HTML);

    await executeWebSearch({ query: 'test' }, makeContext());

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = captureMessage.mock.calls[0]!;
    expect(message).toBe('WebSearch failure'); // de-fragmented; parserDrift detail is in tags/extra
    const tags = (context as Record<string, unknown>).tags as Record<string, string>;
    expect(tags.failureMode).toBe('parserDrift');
    const extra = (context as Record<string, unknown>).extra as Record<string, unknown>;
    expect(extra.driftSnippet).toBeDefined();
    expect(extra.queryLength).toBe(4);
  });

  it('reports rate-limit with failureMode=rateLimit and does not include query text', async () => {
    const { captureMessage } = installSpyReporter();
    const rateLimitState = new Map<string, number>();
    rateLimitState.set('WebSearch', 5);

    await executeWebSearch(
      { query: 'sensitive-query-text' },
      makeContext({ rateLimitState }),
    );

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [, context] = captureMessage.mock.calls[0]!;
    const tags = (context as Record<string, unknown>).tags as Record<string, string>;
    expect(tags.failureMode).toBe('rateLimit');
    const extra = (context as Record<string, unknown>).extra as Record<string, unknown>;
    expect(extra.queryLength).toBe('sensitive-query-text'.length);
    expect(JSON.stringify(context)).not.toContain('sensitive-query-text');
  });

  it('reports timeout with failureMode=timeout', async () => {
    const { captureMessage } = installSpyReporter();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );

    await executeWebSearch({ query: 'slow' }, makeContext());

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const context = captureMessage.mock.calls[0]![1] as Record<string, unknown>;
    const tags = context.tags as Record<string, string>;
    expect(tags.failureMode).toBe('timeout');
  });

  it('reports non-timeout network failure with failureMode=networkError', async () => {
    const { captureMessage } = installSpyReporter();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    await executeWebSearch({ query: 'test' }, makeContext());

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const context = captureMessage.mock.calls[0]![1] as Record<string, unknown>;
    const tags = context.tags as Record<string, string>;
    expect(tags.failureMode).toBe('networkError');
    const extra = context.extra as Record<string, unknown>;
    expect(extra.errorMessage).toBe('ECONNRESET');
  });

  it('does not report telemetry on successful search', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml(DDG_HTML_WITH_RESULTS);

    await executeWebSearch({ query: 'test' }, makeContext());

    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('does not report telemetry on legitimate empty results', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml(DDG_EMPTY_RESULTS_HTML);

    await executeWebSearch({ query: 'test' }, makeContext());

    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('swallows telemetry errors so the tool still returns a user-facing error', async () => {
    // Reporter that throws — simulating Sentry SDK failure
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {
        throw new Error('Sentry is down');
      },
      addBreadcrumb: () => {},
    });
    mockFetchHtml(DDG_CAPTCHA_HTML);

    const result = await executeWebSearch({ query: 'test' }, makeContext());

    // Tool behaviour must be unaffected by telemetry failures
    expect(result.isError).toBe(true);
    expect(result.output).toContain('blocked by the upstream search provider');
  });

  // ── HTTP status handling ─────────────────────────────────────────────

  it('reports HTTP 5xx as failureMode=httpError and returns user-facing error (not silent success)', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml('upstream unavailable', 503);

    const result = await executeWebSearch({ query: 'test' }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('HTTP 503');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = captureMessage.mock.calls[0]!;
    expect(message).toBe('WebSearch failure'); // de-fragmented; HTTP status is in tags/extra.httpStatus
    const tags = (context as Record<string, unknown>).tags as Record<string, string>;
    expect(tags.failureMode).toBe('httpError');
    const extra = (context as Record<string, unknown>).extra as Record<string, unknown>;
    expect(extra.httpStatus).toBe(503);
  });

  it('reports HTTP 429 (rate-limited by DDG) as httpError', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml('too many requests', 429);

    const result = await executeWebSearch({ query: 'test' }, makeContext());

    expect(result.isError).toBe(true);
    const tags = (captureMessage.mock.calls[0]![1] as Record<string, unknown>).tags as Record<string, string>;
    expect(tags.failureMode).toBe('httpError');
  });

  // ── Privacy: driftSnippet must not leak DDG title text ──────────────

  it('does not leak query text via driftSnippet even when DDG echoes it in <title>', async () => {
    const { captureMessage } = installSpyReporter();
    const htmlWithQueryInTitle = `
      <!DOCTYPE html>
      <html>
      <head><title>secret-prospect-name at DuckDuckGo</title></head>
      <body>
        <div class="new-layout-container">totally new format</div>
        ${'<!-- padding -->'.repeat(80)}
      </body>
      </html>
    `;
    mockFetchHtml(htmlWithQueryInTitle);

    await executeWebSearch({ query: 'secret-prospect-name' }, makeContext());

    expect(captureMessage).toHaveBeenCalledTimes(1);
    // Neither the query text nor any other title text should reach Sentry
    const serialized = JSON.stringify(captureMessage.mock.calls);
    expect(serialized).not.toContain('secret-prospect-name');
    expect(serialized).not.toContain('DuckDuckGo');
  });

  // ── Per-task dedupe ──────────────────────────────────────────────────

  it('dedupes the same failureMode within a task (CAPTCHA x3 = 1 event)', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml(DDG_CAPTCHA_HTML);

    // Shared rateLimitState Map = same task
    const sharedCtx = makeContext();

    await executeWebSearch({ query: 'a' }, sharedCtx);
    await executeWebSearch({ query: 'b' }, sharedCtx);
    await executeWebSearch({ query: 'c' }, sharedCtx);

    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('dedupes rateLimit so retry loops cannot amplify events', async () => {
    const { captureMessage } = installSpyReporter();
    const rateLimitState = new Map<string, number>();
    rateLimitState.set('WebSearch', 5);
    const ctx = makeContext({ rateLimitState });

    // Agent stuck in a retry loop — 10 attempts after hitting limit
    for (let i = 0; i < 10; i += 1) {
      await executeWebSearch({ query: `attempt ${i}` }, ctx);
    }

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const tags = (captureMessage.mock.calls[0]![1] as Record<string, unknown>).tags as Record<string, string>;
    expect(tags.failureMode).toBe('rateLimit');
  });

  it('reports different failureModes separately within one task', async () => {
    const { captureMessage } = installSpyReporter();
    const ctx = makeContext();

    // First: CAPTCHA
    mockFetchHtml(DDG_CAPTCHA_HTML);
    await executeWebSearch({ query: 'q1' }, ctx);

    // The CAPTCHA above arms the process-wide cooldown, which would
    // short-circuit the next fetch and defeat THIS test's intent (per-task
    // Sentry dedupe by failureMode). Reset so we can exercise a fresh
    // parser-drift fetch. Cooldown-specific behaviour is covered by the
    // dedicated "CAPTCHA cooldown (process-wide)" describe block below.
    __resetWebSearchCaptchaCooldownForTests();

    // Next call: parser drift (different mode — should fire)
    mockFetchHtml(DDG_PARSER_DRIFT_HTML);
    await executeWebSearch({ query: 'q2' }, ctx);

    // Reset again so the follow-up CAPTCHA reaches the fetch path and
    // can be dedupe-suppressed by the per-task WeakMap (not the cooldown).
    __resetWebSearchCaptchaCooldownForTests();

    // Next call: CAPTCHA again (already reported — should NOT fire)
    mockFetchHtml(DDG_CAPTCHA_HTML);
    await executeWebSearch({ query: 'q3' }, ctx);

    expect(captureMessage).toHaveBeenCalledTimes(2);
    const modes = captureMessage.mock.calls.map(
      (call) => ((call[1] as Record<string, unknown>).tags as Record<string, string>).failureMode,
    );
    expect(modes).toEqual(['captcha', 'parserDrift']);
  });

  it('does not dedupe across separate tasks (different rateLimitState Maps)', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml(DDG_CAPTCHA_HTML);

    // Two separate tasks — distinct rateLimitState Maps. The process-wide
    // cooldown would otherwise short-circuit the second call, which is
    // orthogonal to the per-task dedupe behaviour under test here. Reset
    // between the two to exercise the per-task dedupe path specifically.
    await executeWebSearch({ query: 'task-a' }, makeContext());
    __resetWebSearchCaptchaCooldownForTests();
    await executeWebSearch({ query: 'task-b' }, makeContext());

    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('still reports telemetry when context has no rateLimitState (no dedupe path)', async () => {
    const { captureMessage } = installSpyReporter();
    mockFetchHtml(DDG_CAPTCHA_HTML);

    await executeWebSearch({ query: 'test' }, { cwd: '/tmp' });

    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});

// ── Process-wide CAPTCHA cooldown ──────────────────────────────────────
//
// Regression guard for Sentry issue REBEL-1GG (9 users / 23 events / 8h window
// on 0.4.32). DuckDuckGo anti-bot blocks are IP-sticky ~30min. Without a
// process-wide cooldown, every new turn during the block:
//   (a) spends ~1.3s on a futile DDG fetch,
//   (b) emits a fresh "WebSearch: CAPTCHA detected" Sentry warning because
//       the dedupe WeakMap is keyed on the per-turn rateLimitState Map, and
//   (c) burns a concurrency slot.
//
// The fix short-circuits WebSearch calls during a cooldown window once any
// turn has observed a CAPTCHA. See
// docs-private/investigations/260422_websearch_captcha_sentry_noise.md.

describe('executeWebSearch CAPTCHA cooldown (process-wide)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetWebSearchCaptchaCooldownForTests();
    __setWebSearchClockForTests(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetReporter();
    __resetWebSearchCaptchaCooldownForTests();
    __setWebSearchClockForTests(null);
  });

  it('short-circuits subsequent searches after CAPTCHA without re-fetching DDG', async () => {
    // Install a stable clock so the cooldown window is deterministic.
    let now = 1_000_000_000_000;
    __setWebSearchClockForTests(() => now);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(DDG_CAPTCHA_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    // Turn 1: real fetch, hits CAPTCHA, arms the cooldown.
    const first = await executeWebSearch({ query: 'q1' }, makeContext());
    expect(first.isError).toBe(true);
    expect(first.output).toContain('blocked by the upstream search provider');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Turn 2: different task, within the cooldown window. MUST NOT fetch.
    now += 60_000;
    const second = await executeWebSearch({ query: 'q2' }, makeContext());
    expect(second.isError).toBe(true);
    expect(second.output).toContain('blocked by the upstream search provider');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Turn 3: also within the cooldown window. Still no fetch.
    now += 5 * 60_000;
    const third = await executeWebSearch({ query: 'q3' }, makeContext());
    expect(third.isError).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not emit new Sentry events for cooldown short-circuits (collapses REBEL-1GG fan-out)', async () => {
    let now = 1_000_000_000_000;
    __setWebSearchClockForTests(() => now);
    const { captureMessage } = installSpyReporter();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(DDG_CAPTCHA_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    // First task hits CAPTCHA — 1 Sentry warning (existing behaviour).
    await executeWebSearch({ query: 'q1' }, makeContext());
    expect(captureMessage).toHaveBeenCalledTimes(1);

    // Subsequent tasks during the cooldown window MUST NOT re-emit.
    // Each uses a fresh rateLimitState Map, so per-turn dedupe does not
    // cover this — only the process-wide cooldown does.
    for (let i = 0; i < 5; i += 1) {
      now += 30_000;
      await executeWebSearch({ query: `q${i + 2}` }, makeContext());
    }

    // Still 1 — the cooldown collapsed 5 additional would-be events.
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('allows fetch to retry after the cooldown window elapses', async () => {
    let now = 1_000_000_000_000;
    __setWebSearchClockForTests(() => now);

    let respondWithCaptcha = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(respondWithCaptcha ? DDG_CAPTCHA_HTML : DDG_HTML_WITH_RESULTS, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    // Hit CAPTCHA.
    await executeWebSearch({ query: 'q1' }, makeContext());
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance past the cooldown window (cooldown is 10 minutes; jump 11).
    now += 11 * 60 * 1000;
    respondWithCaptcha = false;

    // Now the next call MUST fetch again (cooldown expired) and succeed.
    const after = await executeWebSearch({ query: 'q2' }, makeContext());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(after.isError).toBe(false);
    expect(after.output).toContain('Found 3 results');
  });

  it('short-circuited cooldown response does not consume a concurrency slot', async () => {
    let now = 1_000_000_000_000;
    __setWebSearchClockForTests(() => now);

    // First: one real fetch returns CAPTCHA.
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      new Response(DDG_CAPTCHA_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    await executeWebSearch({ query: 'trigger' }, makeContext());

    // Fire many parallel calls during cooldown. If the short-circuit
    // acquired/released the semaphore, a bug that forgot the release would
    // hang these. We assert they all resolve promptly.
    now += 60_000;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        executeWebSearch({ query: `burst ${i}` }, makeContext()),
      ),
    );
    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(r.output).toContain('blocked by the upstream search provider');
    }
  });

  it('cooldown short-circuit does not consume per-task rate limit budget', async () => {
    let now = 1_000_000_000_000;
    __setWebSearchClockForTests(() => now);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(DDG_CAPTCHA_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    // Arm cooldown in task A.
    await executeWebSearch({ query: 'arm' }, makeContext());

    // In task B, fire 7 short-circuited calls. Failed searches never consumed
    // the 5/task budget before this fix; that contract must be preserved.
    const taskBState = new Map<string, number>();
    for (let i = 0; i < 7; i += 1) {
      now += 5_000;
      await executeWebSearch({ query: `b${i}` }, makeContext({ rateLimitState: taskBState }));
    }

    expect(taskBState.get('WebSearch')).toBeUndefined();
  });
});
