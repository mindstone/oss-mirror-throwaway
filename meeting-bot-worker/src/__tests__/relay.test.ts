/**
 * Unit tests for BotRelay Durable Object multi-desktop support.
 *
 * Tests the core multi-desktop behaviors:
 * - Multiple desktops can connect without evicting each other
 * - Same-user reconnect replaces only their own socket
 * - Avatar messages are broadcast to all desktops
 * - Desktop→avatar commands are owner-only (viewer commands silently dropped)
 * - Avatar impersonation via viewer JWT is rejected
 * - connectedPeers backward compat preserves legacy semantics
 * - Disconnect handling: avatar notified only when ALL desktops leave
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock infrastructure — fake WebSocket, DurableObjectState, Env
// ---------------------------------------------------------------------------

/** Minimal fake WebSocket for testing relay logic */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  sentMessages: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private attachment: unknown = null;

  send(message: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(message);
  }

  close(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
  }

  serializeAttachment(att: unknown): void {
    this.attachment = structuredClone(att);
  }

  deserializeAttachment(): unknown {
    return this.attachment ? structuredClone(this.attachment) : null;
  }

  lastJson(): Record<string, unknown> | null {
    const last = this.sentMessages[this.sentMessages.length - 1];
    return last ? JSON.parse(last) : null;
  }
}

// Stub globals that relay.ts references
(globalThis as unknown as Record<string, unknown>).WebSocket = FakeWebSocket;

/** Fake DurableObjectState */
function createFakeState(hibernatedSockets: FakeWebSocket[] = []) {
  const storage = new Map<string, unknown>();
  return {
    getWebSockets: () => hibernatedSockets,
    acceptWebSocket: vi.fn(),
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async (keyOrObj: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrObj === 'string') {
          storage.set(keyOrObj, value);
        } else {
          for (const [k, v] of Object.entries(keyOrObj)) {
            storage.set(k, v);
          }
        }
      },
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
}

const fakeEnv = {
  MEETING_BOTS: {},
  BOT_RELAY: {},
  JWT_SECRET: 'test-secret',
  MINDSTONE_AUTH_SECRET: 'test-auth-secret',
  RECALL_API_KEY: 'test-recall-key',
  RECALL_BASE_URL: 'https://example.com',
  KV_TTL_SECONDS: '604800',
};

// Mock verifySessionToken so we don't need real JWTs
vi.mock('../utils', () => ({
  verifySessionToken: async (_token: string, _env: unknown) => {
    // Token format: "valid:<botId>:<userId>:<role>" for test convenience
    // Empty role (e.g. "valid:bot:user:") → undefined to test fallback
    const parts = _token.split(':');
    if (parts[0] !== 'valid') return null;
    const role = parts[3] || undefined;
    return { botId: parts[1], userId: parts[2], role: role === 'owner' ? 'owner' : role === 'viewer' ? 'viewer' : undefined };
  },
}));

// Import after mocks
const { BotRelay } = await import('../relay');

// ---------------------------------------------------------------------------
// Helper: create a relay, set its botId via fetch, and auth a desktop/avatar
// ---------------------------------------------------------------------------

async function createRelay(hibernatedSockets: FakeWebSocket[] = []) {
  const state = createFakeState(hibernatedSockets);
  const relay = new BotRelay(state as unknown as DurableObjectState, fakeEnv as unknown as never);
  // Set botId by calling fetch (the relay extracts botId from the URL path)
  await relay.fetch(new Request('https://example.com/relay/test-bot/status'));
  return relay;
}

function makeAuthMsg(botId: string, userId: string, role: 'desktop' | 'avatar', jwtRole: string = 'owner'): string {
  return JSON.stringify({
    v: 1,
    type: 'auth',
    token: `valid:${botId}:${userId}:${jwtRole}`,
    role,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BotRelay multi-desktop support', () => {
  describe('multiple desktop connections', () => {
    it('allows two different users to connect without eviction', async () => {
      const relay = await createRelay();
      const ws1 = new FakeWebSocket();
      const ws2 = new FakeWebSocket();

      await relay.webSocketMessage(ws1 as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(ws2 as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));

      // Neither socket was closed
      expect(ws1.readyState).toBe(FakeWebSocket.OPEN);
      expect(ws2.readyState).toBe(FakeWebSocket.OPEN);

      // Both received auth_ok
      const ok1 = ws1.lastJson();
      const ok2 = ws2.lastJson();
      expect(ok1?.type).toBe('auth_ok');
      expect(ok2?.type).toBe('auth_ok');

      // desktopCount reflects both
      expect(ok2?.desktopCount).toBe(2);
    });

    it('same-user reconnect replaces only their own socket', async () => {
      const relay = await createRelay();
      const wsOwner = new FakeWebSocket();
      const wsViewer = new FakeWebSocket();
      const wsOwnerReconnect = new FakeWebSocket();

      await relay.webSocketMessage(wsOwner as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsViewer as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));
      await relay.webSocketMessage(wsOwnerReconnect as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));

      // Old owner socket was closed with "Replaced" reason
      expect(wsOwner.closedWith?.reason).toBe('Replaced by new connection');
      // Viewer socket is untouched
      expect(wsViewer.readyState).toBe(FakeWebSocket.OPEN);
      // New owner socket is open
      expect(wsOwnerReconnect.readyState).toBe(FakeWebSocket.OPEN);
    });
  });

  describe('broadcast to all desktops', () => {
    it('broadcasts avatar→desktop messages to all connected desktops', async () => {
      const relay = await createRelay();
      const wsOwner = new FakeWebSocket();
      const wsViewer = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      await relay.webSocketMessage(wsOwner as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsViewer as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      // Clear auth messages
      wsOwner.sentMessages.length = 0;
      wsViewer.sentMessages.length = 0;

      // Avatar sends a transcript message
      const transcriptMsg = JSON.stringify({ v: 1, type: 'transcript', segments: [{ text: 'hello', speaker: 'Alice' }] });
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, transcriptMsg);

      // Both desktops received it
      expect(wsOwner.sentMessages).toHaveLength(1);
      expect(wsViewer.sentMessages).toHaveLength(1);
      expect(JSON.parse(wsOwner.sentMessages[0]).type).toBe('transcript');
      expect(JSON.parse(wsViewer.sentMessages[0]).type).toBe('transcript');
    });

    it('skips closed sockets during broadcast without breaking loop', async () => {
      const relay = await createRelay();
      const wsOwner = new FakeWebSocket();
      const wsViewer = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      await relay.webSocketMessage(wsOwner as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsViewer as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      wsOwner.sentMessages.length = 0;
      wsViewer.sentMessages.length = 0;

      // Simulate viewer socket dying
      wsViewer.readyState = FakeWebSocket.CLOSED as number;

      // Avatar sends message — should not throw, owner still receives
      const msg = JSON.stringify({ v: 1, type: 'chat_message', text: 'hi' });
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, msg);

      expect(wsOwner.sentMessages).toHaveLength(1);
      // Viewer didn't receive (stale, pruned)
      expect(wsViewer.sentMessages).toHaveLength(0);
    });
  });

  describe('owner-only gating for desktop→avatar commands', () => {
    it('forwards owner commands to avatar', async () => {
      const relay = await createRelay();
      const wsOwner = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      await relay.webSocketMessage(wsOwner as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      wsAvatar.sentMessages.length = 0;

      const stateMsg = JSON.stringify({ v: 1, type: 'state', state: 'speaking' });
      await relay.webSocketMessage(wsOwner as unknown as WebSocket, stateMsg);

      // Avatar received the state command
      expect(wsAvatar.sentMessages).toHaveLength(1);
      expect(JSON.parse(wsAvatar.sentMessages[0]).type).toBe('state');
    });

    it('drops viewer desktop commands silently', async () => {
      const relay = await createRelay();
      const wsViewer = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      // Auth owner first (to set up avatar), then viewer
      const wsOwner = new FakeWebSocket();
      await relay.webSocketMessage(wsOwner as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsViewer as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      wsAvatar.sentMessages.length = 0;

      // Viewer tries to send avatar commands — all should be silently dropped
      for (const type of ['state', 'play_audio', 'wave', 'celebrate', 'goodbye', 'knowledge_access']) {
        await relay.webSocketMessage(wsViewer as unknown as WebSocket, JSON.stringify({ v: 1, type }));
      }

      // Avatar received NONE of them
      expect(wsAvatar.sentMessages).toHaveLength(0);
    });

    it('drops unknown message types from viewer desktops', async () => {
      const relay = await createRelay();
      const wsOwner = new FakeWebSocket();
      const wsViewer = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      await relay.webSocketMessage(wsOwner as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsViewer as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      wsAvatar.sentMessages.length = 0;

      await relay.webSocketMessage(wsViewer as unknown as WebSocket, JSON.stringify({ v: 1, type: 'custom_unknown' }));
      expect(wsAvatar.sentMessages).toHaveLength(0);
    });
  });

  describe('avatar impersonation prevention', () => {
    it('rejects viewer JWT attempting to connect as avatar', async () => {
      const relay = await createRelay();
      const ws = new FakeWebSocket();

      await relay.webSocketMessage(ws as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'avatar', 'viewer'));

      const lastMsg = ws.lastJson();
      expect(lastMsg?.type).toBe('auth_error');
      expect(lastMsg?.error).toContain('Insufficient role');
    });

    it('allows owner JWT to connect as avatar', async () => {
      const relay = await createRelay();
      const ws = new FakeWebSocket();

      await relay.webSocketMessage(ws as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'avatar', 'owner'));

      const lastMsg = ws.lastJson();
      expect(lastMsg?.type).toBe('auth_ok');
    });
  });

  describe('connectedPeers backward compatibility', () => {
    it('returns connectedPeers=1 with two desktops and no avatar', async () => {
      const relay = await createRelay();
      const ws1 = new FakeWebSocket();
      const ws2 = new FakeWebSocket();

      await relay.webSocketMessage(ws1 as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(ws2 as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));

      const ok2 = ws2.lastJson();
      // Legacy clients: connectedPeers should be 1 (clamped to min(2,1) + 0 avatar)
      expect(ok2?.connectedPeers).toBe(1);
      // New field: avatarConnected should be false
      expect(ok2?.avatarConnected).toBe(false);
    });

    it('returns connectedPeers=2 with desktop and avatar (matches legacy)', async () => {
      const relay = await createRelay();
      const wsDesktop = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      await relay.webSocketMessage(wsDesktop as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      // Auth a second desktop to check the count from their perspective
      const wsViewer = new FakeWebSocket();
      await relay.webSocketMessage(wsViewer as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));

      const ok = wsViewer.lastJson();
      expect(ok?.connectedPeers).toBe(2); // min(2,1) + 1 avatar
      expect(ok?.avatarConnected).toBe(true);
    });
  });

  describe('disconnect handling', () => {
    it('sends desktop_disconnected to avatar only when last desktop leaves', async () => {
      const relay = await createRelay();
      const wsOwner = new FakeWebSocket();
      const wsViewer = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      await relay.webSocketMessage(wsOwner as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsViewer as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      wsAvatar.sentMessages.length = 0;

      // First desktop disconnects — avatar should NOT get desktop_disconnected
      await relay.webSocketClose(wsOwner as unknown as WebSocket, 1000, 'normal');

      const avatarMsgs = wsAvatar.sentMessages.map(m => JSON.parse(m));
      expect(avatarMsgs.find((m: { type: string }) => m.type === 'desktop_disconnected')).toBeUndefined();

      // Second desktop disconnects — now avatar SHOULD get desktop_disconnected
      await relay.webSocketClose(wsViewer as unknown as WebSocket, 1000, 'normal');

      const avatarMsgs2 = wsAvatar.sentMessages.map(m => JSON.parse(m));
      expect(avatarMsgs2.find((m: { type: string }) => m.type === 'desktop_disconnected')).toBeDefined();
    });

    it('broadcasts avatar_disconnected to all desktops when avatar disconnects', async () => {
      const relay = await createRelay();
      const wsOwner = new FakeWebSocket();
      const wsViewer = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      await relay.webSocketMessage(wsOwner as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsViewer as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      wsOwner.sentMessages.length = 0;
      wsViewer.sentMessages.length = 0;

      await relay.webSocketClose(wsAvatar as unknown as WebSocket, 1000, 'normal');

      // Both desktops should receive avatar_disconnected
      expect(wsOwner.sentMessages.some(m => JSON.parse(m).type === 'avatar_disconnected')).toBe(true);
      expect(wsViewer.sentMessages.some(m => JSON.parse(m).type === 'avatar_disconnected')).toBe(true);
    });

    it('sends desktop_disconnected on error path when last desktop errors out', async () => {
      const relay = await createRelay();
      const wsDesktop = new FakeWebSocket();
      const wsAvatar = new FakeWebSocket();

      await relay.webSocketMessage(wsDesktop as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(wsAvatar as unknown as WebSocket, makeAuthMsg('test-bot', 'avatar-user', 'avatar', 'owner'));

      wsAvatar.sentMessages.length = 0;

      await relay.webSocketError(wsDesktop as unknown as WebSocket, new Error('connection reset'));

      const avatarMsgs = wsAvatar.sentMessages.map(m => JSON.parse(m));
      expect(avatarMsgs.find((m: { type: string }) => m.type === 'desktop_disconnected')).toBeDefined();
    });
  });

  describe('buffer replay', () => {
    it('replays transcript buffer only to newly connecting desktop', async () => {
      const relay = await createRelay();

      // Inject transcript via HTTP POST to populate buffer
      await relay.fetch(new Request('https://example.com/relay/test-bot/transcript', {
        method: 'POST',
        body: JSON.stringify({ segments: [{ text: 'Meeting started', speaker: 'Alice', timestamp: 1 }] }),
      }));

      const wsFirst = new FakeWebSocket();
      await relay.webSocketMessage(wsFirst as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));

      // First desktop should get auth_ok + transcript_buffer
      const msgs1 = wsFirst.sentMessages.map(m => JSON.parse(m));
      expect(msgs1.find((m: { type: string }) => m.type === 'transcript_buffer')).toBeDefined();

      // Clear and connect second desktop
      const wsSecond = new FakeWebSocket();
      await relay.webSocketMessage(wsSecond as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));

      // Second desktop also gets the buffer replay
      const msgs2 = wsSecond.sentMessages.map(m => JSON.parse(m));
      expect(msgs2.find((m: { type: string }) => m.type === 'transcript_buffer')).toBeDefined();

      // First desktop should NOT have received a second buffer replay
      const replayCount = wsFirst.sentMessages.filter(m => JSON.parse(m).type === 'transcript_buffer').length;
      expect(replayCount).toBe(1);
    });
  });

  describe('auth_ok fields', () => {
    it('includes avatarConnected, jwtRole, and desktopCount in auth_ok', async () => {
      const relay = await createRelay();
      const ws = new FakeWebSocket();

      await relay.webSocketMessage(ws as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));

      const ok = ws.lastJson();
      expect(ok?.type).toBe('auth_ok');
      expect(ok).toHaveProperty('avatarConnected');
      expect(ok).toHaveProperty('jwtRole');
      expect(ok).toHaveProperty('desktopCount');
      expect(ok?.jwtRole).toBe('owner');
      expect(ok?.desktopCount).toBe(1);
      expect(ok?.avatarConnected).toBe(false);
    });

    it('defaults undefined JWT role to viewer', async () => {
      const relay = await createRelay();
      const ws = new FakeWebSocket();

      // Token with empty role field — mock returns undefined for role
      await relay.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
        v: 1,
        type: 'auth',
        token: 'valid:test-bot:user-X:',  // empty role → undefined
        role: 'desktop',
      }));

      const ok = ws.lastJson();
      expect(ok?.type).toBe('auth_ok');
      expect(ok?.jwtRole).toBe('viewer');
    });
  });

  describe('status endpoint', () => {
    it('returns desktopCount and desktopConnected correctly', async () => {
      const relay = await createRelay();

      // No desktops
      const res1 = await relay.fetch(new Request('https://example.com/relay/test-bot/status'));
      const data1 = await res1.json() as Record<string, unknown>;
      expect(data1.desktopConnected).toBe(false);
      expect(data1.desktopCount).toBe(0);

      // Add two desktops
      const ws1 = new FakeWebSocket();
      const ws2 = new FakeWebSocket();
      await relay.webSocketMessage(ws1 as unknown as WebSocket, makeAuthMsg('test-bot', 'user-A', 'desktop', 'owner'));
      await relay.webSocketMessage(ws2 as unknown as WebSocket, makeAuthMsg('test-bot', 'user-B', 'desktop', 'viewer'));

      const res2 = await relay.fetch(new Request('https://example.com/relay/test-bot/status'));
      const data2 = await res2.json() as Record<string, unknown>;
      expect(data2.desktopConnected).toBe(true);
      expect(data2.desktopCount).toBe(2);
    });
  });
});
