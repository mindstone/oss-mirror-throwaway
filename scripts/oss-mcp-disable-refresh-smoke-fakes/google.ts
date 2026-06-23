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

export async function startGoogleDisableRefreshSmokeFake(): Promise<DisableRefreshSmokeFake> {
  let refreshCalls = 0;
  let apiCalls = 0;
  const unexpectedRequests: string[] = [];

  const server = http.createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (method === 'POST' && url.pathname === '/token') {
      refreshCalls += 1;
      return sendJson(res, 200, {
        access_token: 'google-rotated-access-token',
        refresh_token: 'google-rotated-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }

    if (method === 'GET' && url.pathname === '/calendar/v3/calendars/primary/events') {
      apiCalls += 1;
      return sendJson(res, 200, {
        items: [
          {
            id: 'event-1',
            summary: 'Smoke Calendar Event',
            start: { dateTime: '2026-05-26T12:00:00Z' },
            end: { dateTime: '2026-05-26T12:30:00Z' },
          },
        ],
      });
    }

    unexpectedRequests.push(`${method} ${url.pathname}`);
    return sendJson(res, 404, { error: 'unexpected_route', method, path: url.pathname });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Google fake could not resolve listening port'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    provider: 'google',
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
