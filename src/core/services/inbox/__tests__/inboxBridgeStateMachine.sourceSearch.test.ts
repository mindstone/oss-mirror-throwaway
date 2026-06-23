import http from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const searchSourcesMock = vi.hoisted(() => vi.fn());
const semanticSearchWithStatusMock = vi.hoisted(() => vi.fn());

vi.mock('@main/services/fileIndexService', () => ({
  semanticSearch: vi.fn(),
  semanticSearchWithStatus: semanticSearchWithStatusMock,
  getIndexStatus: vi.fn(() => ({ workspacePath: '/tmp/workspace' })),
}));

vi.mock('@main/services/sourceMetadataStore', () => ({
  searchSources: searchSourcesMock,
}));

import {
  handleBundledInboxBridgeRequest,
  setBundledInboxBridgeToken,
} from '../inboxBridgeStateMachine';

const BRIDGE_TOKEN = 'test-bridge-token';

let server: http.Server;
let baseUrl = '';

async function startBridgeServer(): Promise<void> {
  server = http.createServer((req, res) => {
    void handleBundledInboxBridgeRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve bridge server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopBridgeServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function postSourceSearch(payload: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}/sources/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('inboxBridgeStateMachine POST /sources/search status signalling', () => {
  beforeAll(async () => {
    await startBridgeServer();
  });

  beforeEach(() => {
    setBundledInboxBridgeToken(BRIDGE_TOKEN);
    searchSourcesMock.mockReset();
    semanticSearchWithStatusMock.mockReset();
  });

  afterEach(() => {
    setBundledInboxBridgeToken(null);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    setBundledInboxBridgeToken(null);
    await stopBridgeServer();
  });

  it.each([
    ['index_not_ready', 'Search is still warming up - sources are being prepared.'],
    ['embedding_unavailable', 'Search is still warming up - sources are being prepared.'],
    ['error', 'Search is temporarily unavailable.'],
  ] as const)('returns success:false for non-ok %s status with empty sources', async (status, expectedError) => {
    searchSourcesMock.mockResolvedValue({ sources: [], totalCount: 0, status });

    const response = await postSourceSearch({ query: 'conceptual query' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: false,
      error: expectedError,
    });
  });

  it('returns success:true with graceful results when semantic is down but text matched', async () => {
    // Hybrid honesty: results present + non-ok status → show results silently.
    const sources = [{ relativePath: 'memory/sources/meeting.md', title: 'Diana sync' }];
    searchSourcesMock.mockResolvedValue({ sources, totalCount: 1, status: 'error' });

    const response = await postSourceSearch({ query: 'diana' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      sources,
      totalCount: 1,
    });
  });

  it('returns success:true with empty sources for a genuine no-match (ok status)', async () => {
    // Confirms the genuine "No sources found" path stays reachable (success:true).
    searchSourcesMock.mockResolvedValue({ sources: [], totalCount: 0, status: 'ok' });

    const response = await postSourceSearch({ query: 'nothing matches this' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      sources: [],
      totalCount: 0,
    });
  });
});
