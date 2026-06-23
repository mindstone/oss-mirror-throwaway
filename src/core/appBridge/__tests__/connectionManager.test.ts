import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ConnectionManager } from '@core/appBridge/server/connectionManager';

/**
 * Minimal mock — the shared ConnectionManager keeps a reference to the socket.
 * Stage 3 calls `.close()` when a same-appId socket supersedes an existing
 * one and consults `.readyState` on `getConnection()`, so the mock surfaces
 * both — errors from `close()` are swallowed anyway.
 */
function mockSocket(readyState: number = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    close: () => {},
    terminate: () => {},
    send: () => {},
  } as unknown as WebSocket;
}

describe('appBridge/server/connectionManager', () => {
  it('register(app, version, socket) adds an entry retrievable via getConnection', () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();

    cm.register('browser-extension', '0.1.0', socket);

    const conn = cm.getConnection('browser-extension');
    expect(conn).not.toBeNull();
    expect(conn?.app).toBe('browser-extension');
    expect(conn?.version).toBe('0.1.0');
    expect(conn?.socket).toBe(socket);
    expect(conn?.missedPongs).toBe(0);
  });

  it('getConnection returns null for an unknown app', () => {
    const cm = new ConnectionManager();
    expect(cm.getConnection('browser-extension')).toBeNull();
  });

  it('unregister(socket) removes the matching connection and emits disconnect', () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    const disconnectHandler = vi.fn();
    cm.on('disconnect', disconnectHandler);

    cm.register('browser-extension', '0.1.0', socket);
    cm.unregister(socket);

    expect(cm.getConnection('browser-extension')).toBeNull();
    expect(disconnectHandler).toHaveBeenCalledWith('browser-extension');
  });

  it('unregister is a no-op for a socket that was never registered', () => {
    const cm = new ConnectionManager();
    const disconnectHandler = vi.fn();
    cm.on('disconnect', disconnectHandler);

    cm.unregister(mockSocket());

    expect(disconnectHandler).not.toHaveBeenCalled();
  });

  it('register replaces an existing connection for the same app and emits disconnect', () => {
    const cm = new ConnectionManager();
    const first = mockSocket();
    const second = mockSocket();
    const disconnectHandler = vi.fn();
    cm.on('disconnect', disconnectHandler);

    cm.register('browser-extension', '0.1.0', first);
    cm.register('browser-extension', '0.1.1', second);

    expect(disconnectHandler).toHaveBeenCalledWith('browser-extension');
    expect(cm.getConnection('browser-extension')?.socket).toBe(second);
    expect(cm.getConnection('browser-extension')?.version).toBe('0.1.1');
  });

  it('disconnect(appId, "supersede") closes and unregisters immediately', () => {
    const cm = new ConnectionManager();
    const close = vi.fn();
    const socket = {
      ...mockSocket(),
      close,
    } as unknown as WebSocket;

    cm.register('browser-extension', '0.1.0', socket);

    expect(cm.disconnect('browser-extension', 'supersede')).toBe(true);
    expect(close).toHaveBeenCalledWith(4003, 'superseded');
    expect(cm.getConnection('browser-extension')).toBeNull();
  });

  it('getConnectedAppIds returns registered app ids', () => {
    const cm = new ConnectionManager<'browser-extension' | 'custom-app'>();
    cm.register('browser-extension', '0.1.0', mockSocket());
    cm.register('custom-app', '1.0.0', mockSocket());

    const ids = cm.getConnectedAppIds();
    expect(ids).toEqual(expect.arrayContaining(['browser-extension', 'custom-app']));
    expect(ids.length).toBe(2);
  });

  it('markPong resets missedPongs on the current connection', () => {
    const cm = new ConnectionManager();
    const socket = mockSocket();
    cm.register('browser-extension', '0.1.0', socket);

    const conn = cm.getConnection('browser-extension');
    if (!conn) throw new Error('connection missing');
    conn.missedPongs = 2;

    cm.markPong(socket);
    expect(cm.getConnection('browser-extension')?.missedPongs).toBe(0);
  });

  it('startHeartbeat/stopHeartbeat run without throwing', () => {
    const cm = new ConnectionManager({ heartbeatIntervalMs: 100 });
    expect(() => cm.startHeartbeat()).not.toThrow();
    expect(() => cm.stopHeartbeat()).not.toThrow();
    // Configured values are preserved for Stage 3 wiring.
    expect(cm.getHeartbeatIntervalMs()).toBe(100);
    // Stage 3 default: 2 missed pongs × 15 s tick = 30 s idle window.
    expect(cm.getMaxMissedPongs()).toBe(2);
  });

  it('respects custom maxMissedPongs', () => {
    const cm = new ConnectionManager({ maxMissedPongs: 5 });
    expect(cm.getMaxMissedPongs()).toBe(5);
  });

  // --- B1 — findByClientId ------------------------------------------------

  it('findByClientId returns every open connection sharing the clientId (B1)', () => {
    const cm = new ConnectionManager<'browser-extension' | 'word'>();
    const socketA = mockSocket();
    const socketB = mockSocket();
    cm.register({
      socket: socketA,
      appId: 'browser-extension',
      clientId: 'client-abc',
      protocolVersion: '1.0',
      capabilities: [],
    });
    cm.register({
      socket: socketB,
      appId: 'word',
      clientId: 'client-abc',
      protocolVersion: '1.0',
      capabilities: [],
    });
    const hits = cm.findByClientId('client-abc');
    expect(hits).toHaveLength(2);
    expect(hits.map((c) => c.appId).sort()).toEqual(['browser-extension', 'word']);
  });

  it('findByClientId skips sockets whose readyState is not OPEN (B1)', () => {
    const cm = new ConnectionManager();
    const closed = mockSocket(WebSocket.CLOSING);
    cm.register({
      socket: closed,
      appId: 'browser-extension',
      clientId: 'client-abc',
      protocolVersion: '1.0',
      capabilities: [],
    });
    expect(cm.findByClientId('client-abc')).toHaveLength(0);
  });

  it('findByClientId returns [] for unknown clientId or empty string', () => {
    const cm = new ConnectionManager();
    cm.register({
      socket: mockSocket(),
      appId: 'browser-extension',
      clientId: 'client-abc',
      protocolVersion: '1.0',
      capabilities: [],
    });
    expect(cm.findByClientId('')).toEqual([]);
    expect(cm.findByClientId('unknown')).toEqual([]);
  });
});
