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

const semanticSearchWithStatusMock = vi.hoisted(() => vi.fn());
const getIndexStatusMock = vi.hoisted(() => vi.fn());

vi.mock('@main/services/fileIndexService', () => ({
  semanticSearch: vi.fn(),
  semanticSearchWithStatus: semanticSearchWithStatusMock,
  getIndexStatus: getIndexStatusMock,
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

async function postFileSearch(payload: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}/file-search`, {
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

describe('inboxBridgeStateMachine POST /file-search status signalling', () => {
  beforeAll(async () => {
    await startBridgeServer();
  });

  beforeEach(() => {
    setBundledInboxBridgeToken(BRIDGE_TOKEN);
    getIndexStatusMock.mockReset();
    getIndexStatusMock.mockReturnValue({ workspacePath: '/tmp/workspace' });
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
    ['index_not_ready', 'Search is still warming up - your files are being prepared.'],
    ['embedding_unavailable', 'Search is still warming up - your files are being prepared.'],
    ['error', 'Search is temporarily unavailable.'],
  ] as const)('returns success:false for non-ok %s status', async (status, expectedError) => {
    semanticSearchWithStatusMock.mockResolvedValue({
      status,
      results: [],
      message: 'internal redacted detail',
    });

    const response = await postFileSearch({ query: 'quarterly planning' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: false,
      error: expectedError,
    });
    // Explicit MCP file search (rebel_search_files) opts into the F9 lexical exemption.
    expect(semanticSearchWithStatusMock).toHaveBeenCalledWith('quarterly planning', {
      limit: 5,
      threshold: 0.25,
      fileTypes: undefined,
      pathPrefix: undefined,
      lexicalExemption: true,
    });
  });

  it('returns success:true with empty results for a genuine no-match (ok status)', async () => {
    // Confirms the success path stays distinct from unavailability: only a real
    // no-match keeps the MCP server's "No relevant files found" empty path reachable.
    semanticSearchWithStatusMock.mockResolvedValue({
      status: 'ok',
      results: [],
    });

    const response = await postFileSearch({ query: 'nothing matches this' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      results: [],
    });
  });
});
