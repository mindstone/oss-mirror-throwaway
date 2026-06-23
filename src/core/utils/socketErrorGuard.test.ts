import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Logger } from '@core/logger';
import { isBenignSocketError, attachBenignSocketErrorGuard } from './socketErrorGuard';

// A plain EventEmitter stands in for http.Server: the guard only uses the
// server's `'connection'` event, and a real http.Server's internal connection
// handler would try to drive our fake socket (calling socket.destroy()).
const fakeServer = () => new EventEmitter() as unknown as Server;

const errWithCode = (code: string) => Object.assign(new Error(`write ${code}`), { code });

describe('isBenignSocketError', () => {
  it('treats peer-disconnect codes as benign', () => {
    expect(isBenignSocketError(errWithCode('EPIPE'))).toBe(true);
    expect(isBenignSocketError(errWithCode('ECONNRESET'))).toBe(true);
    expect(isBenignSocketError(errWithCode('ECONNABORTED'))).toBe(true);
  });
  it('does not treat other / missing codes as benign', () => {
    expect(isBenignSocketError(errWithCode('ELOOP'))).toBe(false);
    expect(isBenignSocketError(new Error('no code'))).toBe(false);
    expect(isBenignSocketError(undefined)).toBe(false);
  });
});

describe('attachBenignSocketErrorGuard (REBEL-5J5)', () => {
  // Baseline: an EventEmitter with no 'error' listener THROWS when 'error' is
  // emitted — this is the same mechanism by which an unguarded socket EPIPE
  // escalates to process 'uncaughtException'. Proves the guard is load-bearing.
  it('baseline: an unguarded socket error escalates (throws)', () => {
    const socket = new EventEmitter();
    expect(() => socket.emit('error', errWithCode('EPIPE'))).toThrow();
  });

  it('swallows a benign EPIPE on a guarded server connection', () => {
    const server = fakeServer();
    attachBenignSocketErrorGuard(server);
    const socket = new EventEmitter();
    server.emit('connection', socket);
    expect(() => socket.emit('error', errWithCode('EPIPE'))).not.toThrow();
  });

  it('logs but still swallows a non-benign socket error (never crashes the process)', () => {
    const warn = vi.fn();
    const server = fakeServer();
    attachBenignSocketErrorGuard(server, { warn } as unknown as Logger);
    const socket = new EventEmitter();
    server.emit('connection', socket);
    expect(() => socket.emit('error', errWithCode('ELOOP'))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Integration: prove the guard registers on a REAL http.Server's connection
  // event and the server still serves a normal request (the unit tests above
  // cover the swallow semantics; this covers the Node integration point — GPT F3).
  it('registers on a real http.Server and a normal request still round-trips', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    const before = server.listenerCount('connection');
    attachBenignSocketErrorGuard(server);
    // The guard added exactly one 'connection' listener to the real server
    // (a real http.Server already carries its own internal connection handler).
    expect(server.listenerCount('connection')).toBe(before + 1);
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    const body: string = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    expect(body).toBe('ok');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
