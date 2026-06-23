import http from 'node:http';
import type { DisableRefreshSmokeFake } from './types';

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function startHubSpotDisableRefreshSmokeFake(): Promise<DisableRefreshSmokeFake> {
  let refreshCalls = 0;
  let apiCalls = 0;
  const unexpectedRequests: string[] = [];

  const server = http.createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (method === 'POST' && url.pathname === '/oauth/v1/token') {
      refreshCalls += 1;
      return sendJson(res, 200, {
        access_token: 'hubspot-rotated-access-token',
        refresh_token: 'hubspot-rotated-refresh-token',
        expires_in: 21600,
        token_type: 'bearer',
      });
    }

    if (method === 'GET' && url.pathname.startsWith('/oauth/v1/access-tokens/')) {
      return sendJson(res, 200, {
        user: 'test@example.com',
        hub_id: 12345678,
      });
    }

    if (method === 'POST' && url.pathname === '/crm/v3/objects/contacts/search') {
      apiCalls += 1;
      return sendJson(res, 200, {
        results: [
          {
            id: '101',
            properties: {
              email: '[external-email]',
              firstname: 'Alice',
              lastname: 'Johnson',
            },
          },
        ],
        paging: {},
      });
    }

    unexpectedRequests.push(`${method} ${url.pathname}`);
    return sendJson(res, 404, { error: 'unexpected_route', method, path: url.pathname });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('HubSpot fake could not resolve listening port'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    provider: 'hubspot',
    baseUrl: `http://127.0.0.1:${port}`,
    getRefreshCallCount: () => refreshCalls,
    getApiCallCount: () => apiCalls,
    getUnexpectedRequests: () => [...unexpectedRequests],
    resetCounters: () => {
      refreshCalls = 0;
      apiCalls = 0;
      unexpectedRequests.length = 0;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}
