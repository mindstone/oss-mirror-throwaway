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

export async function startMicrosoftDisableRefreshSmokeFake(): Promise<DisableRefreshSmokeFake> {
  let refreshCalls = 0;
  let apiCalls = 0;
  const unexpectedRequests: string[] = [];

  const server = http.createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (method === 'POST' && pathname === '/common/oauth2/v2.0/token') {
      refreshCalls += 1;
      return sendJson(res, 200, {
        access_token: 'microsoft-rotated-access-token',
        refresh_token: 'microsoft-rotated-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }

    if (method === 'GET' && /^\/v1\.0\/me\/mailFolders\/[^/]+\/messages$/.test(pathname)) {
      apiCalls += 1;
      return sendJson(res, 200, {
        value: [
          {
            id: 'msg-1',
            subject: 'Smoke email',
            from: { emailAddress: { address: 'alice@example.com', name: 'Alice' } },
            bodyPreview: 'Smoke inbox preview',
            receivedDateTime: '2026-05-26T10:00:00Z',
          },
        ],
      });
    }

    if (method === 'GET' && pathname === '/v1.0/me/mailboxSettings') {
      return sendJson(res, 200, {
        timeZone: 'Pacific Standard Time',
      });
    }

    if (method === 'GET' && pathname === '/v1.0/me/calendarView') {
      apiCalls += 1;
      return sendJson(res, 200, {
        value: [
          {
            id: 'event-1',
            subject: 'Smoke calendar event',
            start: { dateTime: '2026-05-26T11:00:00', timeZone: 'Pacific Standard Time' },
            end: { dateTime: '2026-05-26T11:30:00', timeZone: 'Pacific Standard Time' },
          },
        ],
      });
    }

    if (method === 'GET' && pathname === '/v1.0/me/drive/root/children') {
      apiCalls += 1;
      return sendJson(res, 200, {
        value: [
          {
            id: 'file-1',
            name: 'smoke-file.txt',
            size: 42,
            webUrl: 'https://example.test/smoke-file.txt',
            file: { mimeType: 'text/plain' },
          },
        ],
      });
    }

    if (method === 'GET' && pathname === '/v1.0/me/chats') {
      apiCalls += 1;
      return sendJson(res, 200, {
        value: [
          {
            id: 'chat-1',
            topic: 'Smoke Chat',
            chatType: 'group',
          },
        ],
      });
    }

    if (method === 'GET' && (pathname === '/v1.0/sites' || pathname === '/v1.0/sites/delta()')) {
      apiCalls += 1;
      return sendJson(res, 200, {
        value: [
          {
            id: 'site-1',
            displayName: 'Smoke Site',
            name: 'SmokeSite',
            webUrl: 'https://contoso.sharepoint.com/sites/SmokeSite',
            siteCollection: { hostname: 'contoso.sharepoint.com' },
          },
        ],
      });
    }

    unexpectedRequests.push(`${method} ${pathname}`);
    return sendJson(res, 404, { error: 'unexpected_route', method, path: pathname });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Microsoft fake could not resolve listening port'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    provider: 'microsoft',
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
