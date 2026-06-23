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

export async function startSlackDisableRefreshSmokeFake(): Promise<DisableRefreshSmokeFake> {
  let refreshCalls = 0;
  let apiCalls = 0;
  const unexpectedRequests: string[] = [];

  const server = http.createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (method === 'POST' && url.pathname === '/api/oauth.v2.access') {
      refreshCalls += 1;
      return sendJson(res, 200, {
        ok: true,
        access_token: 'xoxb-smoke-rotated-token',
        refresh_token: 'xoxe-smoke-rotated-token',
        expires_in: 43200,
        token_type: 'bot',
      });
    }

    if (method === 'POST' && url.pathname === '/api/auth.test') {
      return sendJson(res, 200, {
        ok: true,
        team: 'Smoke Workspace',
        user: 'smoke-user',
        team_id: 'T123',
        user_id: 'U123',
      });
    }

    if (method === 'POST' && url.pathname === '/api/users.info') {
      apiCalls += 1;
      return sendJson(res, 200, {
        ok: true,
        user: {
          id: 'U123',
          name: 'smoke-user',
          real_name: 'Smoke User',
          profile: {
            display_name: 'Smoke User',
            email: 'smoke@example.com',
          },
        },
      });
    }

    unexpectedRequests.push(`${method} ${url.pathname}`);
    return sendJson(res, 404, { error: 'unexpected_route', method, path: url.pathname });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Slack fake could not resolve listening port'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    provider: 'slack',
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
