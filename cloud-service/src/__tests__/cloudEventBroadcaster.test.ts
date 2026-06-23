import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
// ws CJS/ESM interop is inconsistent across vitest configs (root vs cloud-service)
// and CI vs local. Using createRequire guarantees stable CJS resolution everywhere.
const require = createRequire(import.meta.url);
const ws = require('ws');
const WebSocket = ws as typeof import('ws').default;
const WebSocketServer = ws.Server as typeof import('ws').WebSocketServer;
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';

describe('CloudEventBroadcaster', () => {
  let wss: InstanceType<typeof WebSocketServer>;
  let port: number;

  beforeEach(() => {
    return new Promise<void>((resolve) => {
      wss = new WebSocketServer({ port: 0 });
      wss.on('listening', () => {
        port = (wss.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(() => {
    cloudEventBroadcaster.closeAll();
    return new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  describe('virtualWindow', () => {
    it('implements BrowserWindow-like interface', () => {
      const vw = cloudEventBroadcaster.virtualWindow;
      expect(vw.isDestroyed()).toBe(false);
      expect(vw.webContents.isDestroyed()).toBe(false);
      expect(typeof vw.webContents.send).toBe('function');
    });
  });

  describe('broadcast', () => {
    it('sends events to connected clients', async () => {
      const received: string[] = [];

      const client = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        wss.on('connection', (serverWs) => {
          cloudEventBroadcaster.addClient(serverWs);
          resolve();
        });
      });

      client.on('message', (data) => {
        received.push(data.toString());
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      cloudEventBroadcaster.broadcast('tool-safety:approval-request', { toolUseID: 'test-123' });

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(1);
      const parsed = JSON.parse(received[0]);
      expect(parsed.channel).toBe('tool-safety:approval-request');
      expect(parsed.args).toEqual([{ toolUseID: 'test-123' }]);

      client.close();
    });

    it('broadcasts to multiple clients', async () => {
      const counts = [0, 0];

      const clients = [new WebSocket(`ws://localhost:${port}`), new WebSocket(`ws://localhost:${port}`)];
      let connCount = 0;

      await new Promise<void>((resolve) => {
        wss.on('connection', (serverWs) => {
          cloudEventBroadcaster.addClient(serverWs);
          connCount++;
          if (connCount === 2) resolve();
        });
      });

      clients[0].on('message', () => counts[0]++);
      clients[1].on('message', () => counts[1]++);

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      cloudEventBroadcaster.broadcast('test:event', { value: 1 });

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(counts[0]).toBe(1);
      expect(counts[1]).toBe(1);

      clients.forEach((c) => c.close());
    });

    it('does not throw when no clients are connected', () => {
      expect(() => cloudEventBroadcaster.broadcast('test:event', {})).not.toThrow();
    });

    it('notifies channel listeners even when no clients are connected', () => {
      const listener = vi.fn();
      const unsubscribe = cloudEventBroadcaster.onChannel('test:event', listener);

      cloudEventBroadcaster.broadcast('test:event', { value: 1 });

      expect(listener).toHaveBeenCalledWith('test:event', { value: 1 });

      unsubscribe();
    });

    it('stops notifying channel listeners after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = cloudEventBroadcaster.onChannel('test:event', listener);

      cloudEventBroadcaster.broadcast('test:event', { value: 'first' });
      unsubscribe();
      cloudEventBroadcaster.broadcast('test:event', { value: 'second' });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('test:event', { value: 'first' });
    });

    it('removes disconnected clients', async () => {
      const client = new WebSocket(`ws://localhost:${port}`);

      await Promise.all([
        new Promise<void>((resolve) => {
          wss.once('connection', (serverWs) => {
            cloudEventBroadcaster.addClient(serverWs);
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          client.once('open', () => resolve());
          client.once('error', reject);
        }),
      ]);

      // Wait for the client-side socket to be fully open before closing
      await new Promise<void>((resolve) => {
        if (client.readyState === WebSocket.OPEN) return resolve();
        client.on('open', () => resolve());
      });

      expect(cloudEventBroadcaster.clientCount).toBe(1);

      await new Promise<void>((resolve) => {
        client.once('close', () => resolve());
        client.close();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(cloudEventBroadcaster.clientCount).toBe(0);
    });
  });

  describe('hasOpenClient', () => {
    it('returns false when no clients are connected', () => {
      expect(cloudEventBroadcaster.hasOpenClient()).toBe(false);
    });

    it('returns true once a client reaches OPEN state', async () => {
      const client = new WebSocket(`ws://localhost:${port}`);

      await Promise.all([
        new Promise<void>((resolve) => {
          wss.once('connection', (serverWs) => {
            cloudEventBroadcaster.addClient(serverWs);
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          client.once('open', () => resolve());
          client.once('error', reject);
        }),
      ]);

      expect(cloudEventBroadcaster.hasOpenClient()).toBe(true);
      client.close();
    });

    it('returns true if at least one client is OPEN among multiples', async () => {
      const clients = [new WebSocket(`ws://localhost:${port}`), new WebSocket(`ws://localhost:${port}`)];
      let connCount = 0;
      await new Promise<void>((resolve) => {
        wss.on('connection', (serverWs) => {
          cloudEventBroadcaster.addClient(serverWs);
          connCount += 1;
          if (connCount === 2) resolve();
        });
      });
      await Promise.all(
        clients.map(
          (c) =>
            new Promise<void>((resolve, reject) => {
              if (c.readyState === WebSocket.OPEN) return resolve();
              c.once('open', () => resolve());
              c.once('error', reject);
            }),
        ),
      );

      expect(cloudEventBroadcaster.hasOpenClient()).toBe(true);
      clients.forEach((c) => c.close());
    });

    it('returns false after the only client disconnects', async () => {
      const client = new WebSocket(`ws://localhost:${port}`);
      await Promise.all([
        new Promise<void>((resolve) => {
          wss.once('connection', (serverWs) => {
            cloudEventBroadcaster.addClient(serverWs);
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          client.once('open', () => resolve());
          client.once('error', reject);
        }),
      ]);

      expect(cloudEventBroadcaster.hasOpenClient()).toBe(true);

      await new Promise<void>((resolve) => {
        client.once('close', () => resolve());
        client.close();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(cloudEventBroadcaster.hasOpenClient()).toBe(false);
    });
  });

  describe('onClientConnected', () => {
    it('fires the listener once per addClient', async () => {
      const listener = vi.fn();
      const unsubscribe = cloudEventBroadcaster.onClientConnected(listener);

      const client = new WebSocket(`ws://localhost:${port}`);
      await Promise.all([
        new Promise<void>((resolve) => {
          wss.once('connection', (serverWs) => {
            cloudEventBroadcaster.addClient(serverWs);
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          client.once('open', () => resolve());
          client.once('error', reject);
        }),
      ]);

      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
      client.close();
    });

    it('fires for each subsequent client connection', async () => {
      const listener = vi.fn();
      cloudEventBroadcaster.onClientConnected(listener);

      const clients = [new WebSocket(`ws://localhost:${port}`), new WebSocket(`ws://localhost:${port}`)];
      let connCount = 0;
      await new Promise<void>((resolve) => {
        wss.on('connection', (serverWs) => {
          cloudEventBroadcaster.addClient(serverWs);
          connCount += 1;
          if (connCount === 2) resolve();
        });
      });
      await Promise.all(
        clients.map(
          (c) =>
            new Promise<void>((resolve, reject) => {
              if (c.readyState === WebSocket.OPEN) return resolve();
              c.once('open', () => resolve());
              c.once('error', reject);
            }),
        ),
      );

      expect(listener).toHaveBeenCalledTimes(2);
      clients.forEach((c) => c.close());
    });

    it('stops firing after unsubscribe', async () => {
      const listener = vi.fn();
      const unsubscribe = cloudEventBroadcaster.onClientConnected(listener);

      const client1 = new WebSocket(`ws://localhost:${port}`);
      await Promise.all([
        new Promise<void>((resolve) => {
          wss.once('connection', (serverWs) => {
            cloudEventBroadcaster.addClient(serverWs);
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          client1.once('open', () => resolve());
          client1.once('error', reject);
        }),
      ]);

      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();

      const client2 = new WebSocket(`ws://localhost:${port}`);
      await Promise.all([
        new Promise<void>((resolve) => {
          wss.once('connection', (serverWs) => {
            cloudEventBroadcaster.addClient(serverWs);
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          client2.once('open', () => resolve());
          client2.once('error', reject);
        }),
      ]);

      expect(listener).toHaveBeenCalledTimes(1);
      client1.close();
      client2.close();
    });

    it('isolates listener throws so other listeners and addClient still complete', async () => {
      const ok = vi.fn();
      const badListener = vi.fn(() => {
        throw new Error('listener boom');
      });
      cloudEventBroadcaster.onClientConnected(badListener);
      cloudEventBroadcaster.onClientConnected(ok);

      const client = new WebSocket(`ws://localhost:${port}`);
      await Promise.all([
        new Promise<void>((resolve) => {
          wss.once('connection', (serverWs) => {
            cloudEventBroadcaster.addClient(serverWs);
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          client.once('open', () => resolve());
          client.once('error', reject);
        }),
      ]);

      expect(badListener).toHaveBeenCalledTimes(1);
      expect(ok).toHaveBeenCalledTimes(1);
      expect(cloudEventBroadcaster.clientCount).toBe(1);
      client.close();
    });
  });

  describe('virtualWindow.webContents.send', () => {
    it('routes through broadcast to connected clients', async () => {
      const received: string[] = [];

      const client = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        wss.on('connection', (serverWs) => {
          cloudEventBroadcaster.addClient(serverWs);
          resolve();
        });
      });

      client.on('message', (data) => received.push(data.toString()));

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      cloudEventBroadcaster.virtualWindow.webContents.send('memory:write-approval-request', {
        toolUseId: 'mem-456',
        destination: { spaceName: 'Chief-of-Staff' },
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(1);
      const parsed = JSON.parse(received[0]);
      expect(parsed.channel).toBe('memory:write-approval-request');
      expect(parsed.args[0].toolUseId).toBe('mem-456');

      client.close();
    });
  });
});
