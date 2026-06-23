/**
 * Discourse MCP Mock Tests
 *
 * Tests tool behavior with mocked HTTP responses — no real API keys needed.
 * Uses the shared mock API harness to intercept Discourse API calls.
 *
 * Two test suites:
 * 1. Read-only mode (no auth) — verifies 8+1 read tools (including select_site)
 * 2. Write mode (with profile auth) — verifies read + 4 write tools
 *
 * Run: npx vitest run resources/mcp/discourse/test-mcp.test.ts
 */

import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  createMockApiServer,
  createMcpTestClient,
  describeBundledMcp,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
  type MockRoute,
} from '../../../scripts/mcp-test-harness';

const DISCOURSE_SITE = 'https://rebels.mindstone.com';

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockSearchResults = {
  posts: [
    {
      id: 101,
      topic_id: 10,
      username: 'alice',
      blurb: 'Welcome to the community!',
      created_at: '2026-01-15T10:00:00.000Z',
    },
  ],
  topics: [
    {
      id: 10,
      title: 'Welcome to Rebels Community',
      slug: 'welcome-to-rebels-community',
      posts_count: 3,
      created_at: '2026-01-15T10:00:00.000Z',
    },
  ],
};

const mockTopic = {
  id: 10,
  title: 'Welcome to Rebels Community',
  slug: 'welcome-to-rebels-community',
  posts_count: 2,
  post_stream: {
    posts: [
      {
        id: 101,
        post_number: 1,
        username: 'alice',
        cooked: '<p>Welcome everyone!</p>',
        raw: 'Welcome everyone!',
        created_at: '2026-01-15T10:00:00.000Z',
      },
      {
        id: 102,
        post_number: 2,
        username: 'bob',
        cooked: '<p>Thanks for the welcome!</p>',
        raw: 'Thanks for the welcome!',
        created_at: '2026-01-15T11:00:00.000Z',
      },
    ],
  },
  category_id: 1,
  tags: ['general'],
};

const mockCategories = {
  category_list: {
    categories: [
      { id: 1, name: 'General', slug: 'general', topic_count: 5, description: 'General discussion' },
      { id: 2, name: 'Feedback', slug: 'feedback', topic_count: 3, description: 'Product feedback' },
    ],
  },
};

const mockTags = {
  tags: [
    { id: 'general', text: 'general', count: 5 },
    { id: 'bug', text: 'bug', count: 2 },
  ],
};

const mockCreatedTopic = {
  topic_id: 20,
  topic_slug: 'my-new-topic',
  post_number: 1,
  topic_title: 'My New Topic',
};

const mockCreatedPost = {
  id: 201,
  topic_id: 10,
  post_number: 3,
};

// ─── Common Routes ────────────────────────────────────────────────────────────

const readRoutes: MockRoute[] = [
  // Startup validation endpoint — the Discourse MCP fetches this when --site is provided
  { method: 'GET', path: '/about.json', handler: { body: { about: { title: 'Rebels Community' } } } },
  { method: 'GET', path: '/search.json', handler: { body: mockSearchResults } },
  { method: 'GET', path: '/t/10.json', handler: { body: mockTopic } },
  { method: 'GET', path: '/posts/101.json', handler: { body: mockTopic.post_stream.posts[0] } },
  { method: 'GET', path: '/categories.json', handler: { body: mockCategories } },
  { method: 'GET', path: '/tags.json', handler: { body: mockTags } },
  { method: 'GET', path: '/site.json', handler: { body: { default_locale: 'en', categories: mockCategories.category_list.categories } } },
  // User endpoint
  {
    method: 'GET',
    path: '/u/alice.json',
    handler: { body: { user: { id: 1, username: 'alice', name: 'Alice', created_at: '2026-01-01T00:00:00.000Z' } } },
  },
];

const writeRoutes: MockRoute[] = [
  { method: 'POST', path: '/posts.json', handler: { body: mockCreatedTopic } },
];

// ─── Wrapper Helpers ──────────────────────────────────────────────────────────

const serverScript = resolveServerScript('discourse');

function generateDiscourseWrapper(
  mockPort: number,
  interceptDomains: string[],
  extraArgv: string[],
): string {
  const wrapperPath = join(tmpdir(), `discourse-mock-wrapper-${process.pid}-${Date.now()}.mjs`);
  const serverFileUrl = pathToFileURL(serverScript).href;
  const domainsJson = JSON.stringify(interceptDomains);
  const argvJson = JSON.stringify(extraArgv);

  const wrapperCode = [
    `const MOCK_PORT = ${mockPort};`,
    `const DOMAINS = ${domainsJson};`,
    `const EXTRA_ARGV = ${argvJson};`,
    // Inject extra CLI args into process.argv so the Discourse MCP reads them
    `process.argv.push(...EXTRA_ARGV);`,
    // Patch fetch to redirect matching domains to mock server
    `const _fetch = globalThis.fetch;`,
    `globalThis.fetch = async (input, opts) => {`,
    `  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);`,
    `  if (DOMAINS.some(d => url.includes(d))) {`,
    `    const u = new URL(url);`,
    `    const newUrl = 'http://127.0.0.1:' + MOCK_PORT + u.pathname + u.search;`,
    `    if (typeof input === 'object' && !(input instanceof URL)) {`,
    `      return _fetch(new Request(newUrl, input), opts);`,
    `    }`,
    `    return _fetch(newUrl, opts);`,
    `  }`,
    `  return _fetch(input, opts);`,
    `};`,
    `await import('${serverFileUrl}');`,
  ].join('\n');

  writeFileSync(wrapperPath, wrapperCode, 'utf-8');
  return wrapperPath;
}

function createTempProfileDir(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `discourse-test-profile-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ─── Tests: Read-Only Mode ────────────────────────────────────────────────────

describeBundledMcp('discourse', 'Discourse MCP - read-only mode (no auth)', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;
  let wrapperPath: string;

  beforeAll(async () => {
    mockApi = await createMockApiServer(readRoutes);
    wrapperPath = generateDiscourseWrapper(
      mockApi.port,
      ['rebels.mindstone.com'],
      ['--site', DISCOURSE_SITE],
    );

    client = await createMcpTestClient({
      name: 'discourse-readonly',
      command: 'node',
      args: [wrapperPath],
      connectTimeout: 15_000,
    });
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    try { rmSync(wrapperPath, { force: true }); } catch { /* ignore */ }
  });

  it('lists only read tools (no write tools)', async () => {
    const tools = await client.listTools();
    const toolNames = tools.map(t => t.name);

    // Read tools should be present
    expect(toolNames).toContain('discourse_search');
    expect(toolNames).toContain('discourse_read_topic');
    expect(toolNames).toContain('discourse_read_post');
    expect(toolNames).toContain('discourse_list_categories');
    expect(toolNames).toContain('discourse_list_tags');
    expect(toolNames).toContain('discourse_get_user');
    expect(toolNames).toContain('discourse_filter_topics');
    expect(toolNames).toContain('discourse_list_user_posts');

    // Write tools should NOT be present (no auth = read-only)
    expect(toolNames).not.toContain('discourse_create_topic');
    expect(toolNames).not.toContain('discourse_create_post');
    expect(toolNames).not.toContain('discourse_create_category');
    expect(toolNames).not.toContain('discourse_create_user');
  });

  it('discourse_search returns results', async () => {
    const result = await client.callToolText('discourse_search', { query: 'welcome' });
    expect(result).toContain('Welcome to Rebels Community');
  });

  it('discourse_read_topic returns topic content', async () => {
    const result = await client.callToolText('discourse_read_topic', { topic_id: 10 });
    expect(result).toContain('Welcome everyone');
  });

  it('discourse_list_categories returns categories', async () => {
    const result = await client.callToolText('discourse_list_categories', {});
    expect(result).toContain('General');
    expect(result).toContain('Feedback');
  });
});

// ─── Tests: Write Mode ────────────────────────────────────────────────────────

describeBundledMcp('discourse', 'Discourse MCP - write mode (with profile auth)', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;
  let wrapperPath: string;
  let profileCleanup: () => void;
  let profilePath: string;

  beforeAll(async () => {
    // Create temp profile file with auth credentials
    const { dir, cleanup } = createTempProfileDir();
    profileCleanup = cleanup;
    profilePath = join(dir, 'profile.json');
    writeFileSync(profilePath, JSON.stringify({
      auth_pairs: [{
        site: DISCOURSE_SITE,
        api_key: 'mock-test-api-key',
        api_username: 'testuser',
      }],
      allow_writes: true,
      read_only: false,
      site: DISCOURSE_SITE,
    }, null, 2));

    mockApi = await createMockApiServer([...readRoutes, ...writeRoutes]);
    wrapperPath = generateDiscourseWrapper(
      mockApi.port,
      ['rebels.mindstone.com'],
      ['--profile', profilePath],
    );

    client = await createMcpTestClient({
      name: 'discourse-write',
      command: 'node',
      args: [wrapperPath],
      connectTimeout: 15_000,
    });
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
    try { rmSync(wrapperPath, { force: true }); } catch { /* ignore */ }
    profileCleanup?.();
  });

  it('lists both read and write tools', async () => {
    const tools = await client.listTools();
    const toolNames = tools.map(t => t.name);

    // Read tools
    expect(toolNames).toContain('discourse_search');
    expect(toolNames).toContain('discourse_read_topic');

    // Write tools should now be present
    expect(toolNames).toContain('discourse_create_topic');
    expect(toolNames).toContain('discourse_create_post');
    expect(toolNames).toContain('discourse_create_category');
    expect(toolNames).toContain('discourse_create_user');
  });

  it('discourse_create_topic creates a new topic', async () => {
    const result = await client.callToolText('discourse_create_topic', {
      title: 'My New Topic',
      raw: 'This is the body of my new topic.',
    });
    expect(result).toContain('Created topic');
    expect(result).toContain('My New Topic');
  });

  it('discourse_create_post replies to an existing topic', async () => {
    const result = await client.callToolText('discourse_create_post', {
      topic_id: 10,
      raw: 'This is a reply to the topic.',
    });
    expect(result).toContain('Created post');
  });

  it('discourse_search still works with auth', async () => {
    const result = await client.callToolText('discourse_search', { query: 'welcome' });
    expect(result).toContain('Welcome to Rebels Community');
  });
});
