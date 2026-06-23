import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import { PairEventBus, type PairEvent } from '@core/appBridge/server/pairEventBus';

const handles: AppBridgeHandle[] = [];
const dirs: string[] = [];

let portBase = 55700;
function nextPortRange(count = 3): number[] {
  const start = portBase;
  portBase += count + 1;
  return Array.from({ length: count }, (_, index) => start + index);
}

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-routes-sse-test-'));
  dirs.push(dir);
  return dir;
}

async function startBridge(options: {
  pairEventBus?: PairEventBus;
  pairEventKeepaliveMs?: number;
  pairEventIdleTimeoutMs?: number;
} = {}): Promise<AppBridgeHandle> {
  const handle = await createAppBridge({
    stateDirectory: await makeStateDir(),
    portCandidates: nextPortRange(),
    ...(options.pairEventBus ? { pairEventBus: options.pairEventBus } : {}),
    ...(options.pairEventKeepaliveMs
      ? { pairEventKeepaliveMs: options.pairEventKeepaliveMs }
      : {}),
    ...(options.pairEventIdleTimeoutMs
      ? { pairEventIdleTimeoutMs: options.pairEventIdleTimeoutMs }
      : {}),
    hostHandlers: {
      prepareInstall: async () => ({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          attemptId: 'install-attempt-1',
          setupStatus: 'awaiting_user_handoff',
          nextStep: 'Load the revealed extension folder.',
          steps: [],
        },
      }),
      extractExtension: async () => ({ ok: true }),
      revealExtensionFolder: async () => ({ ok: true }),
      openBrowserExtensionsPage: async () => ({ ok: true }),
      startPairing: () => ({
        code: '123456',
        expiresAt: Date.now() + 60_000,
        expiresInSeconds: 60,
        pairSessionId: 'pair-session-1',
        appId: 'browser-extension',
      }),
      checkPairStatus: () => ({
        paired: [],
        hasPending: false,
        pairSessionExpired: false,
      }),
      diagnose: async () => ({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          browserRunning: true,
          extensionExtracted: true,
          recentInstallBreadcrumbCount: 0,
          recentInstallFailureCount: 0,
          lastFailureReason: null,
          bridgeReachable: true,
          pairSessionActive: false,
        },
      }),
      resetInstall: async () => ({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: { revoked: 0, idsRemoved: 0 },
      }),
      listPendingApprovals: () => [],
      approvePending: () => ({ ok: true }),
      listPaired: () => [],
      endPairSession: () => undefined,
      mintAppTokenForTrustedHost: () => ({
        ok: false,
        reason: 'test-handler-disabled',
      }),
    },
  });
  handles.push(handle);
  return handle;
}

async function connectPairEvents(
  handle: AppBridgeHandle,
  pairSessionId?: string,
): Promise<Response> {
  const query = pairSessionId
    ? `?pairSessionId=${encodeURIComponent(pairSessionId)}`
    : '';
  return fetch(`http://127.0.0.1:${handle.port}/host/pair-events${query}`, {
    method: 'GET',
    headers: {
      Host: `127.0.0.1:${handle.port}`,
      Authorization: `Bearer ${handle.routerInternalToken}`,
    },
  });
}

async function readNextSseBlock(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 250,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for SSE block.')), timeoutMs),
      ),
    ]);

    if (result.done) {
      throw new Error('SSE stream ended before the next block arrived.');
    }

    buffer += decoder.decode(result.value, { stream: true });
    const normalized = buffer.replace(/\r\n/g, '\n');
    const boundary = normalized.indexOf('\n\n');
    if (boundary === -1) {
      buffer = normalized;
      continue;
    }

    return normalized.slice(0, boundary);
  }
}

function parseEventBlock(block: string): PairEvent | null {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());

  if (dataLines.length === 0) {
    return null;
  }

  return JSON.parse(dataLines.join('\n')) as PairEvent;
}

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) {
      await handle.stop().catch(() => undefined);
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('appBridge/server/hostRoutes SSE', () => {
  it('streams new pair events to connected clients', async () => {
    const pairEventBus = new PairEventBus();
    const handle = await startBridge({ pairEventBus });
    const response = await connectPairEvents(handle, 'pair-session-1');
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Missing SSE body reader.');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    const event: PairEvent = {
      type: 'paired',
      pairSessionId: 'pair-session-1',
      tokenFingerprint: 'fingerprint-1',
      emittedAt: Date.now(),
    };
    pairEventBus.emit(event);

    const block = await readNextSseBlock(reader);
    expect(parseEventBlock(block)).toEqual(event);
    await reader.cancel();
  });

  it('replays recent events when a client reconnects', async () => {
    const pairEventBus = new PairEventBus();
    const replayEvent: PairEvent = {
      type: 'paired',
      pairSessionId: 'pair-session-1',
      emittedAt: Date.now(),
    };
    pairEventBus.emit(replayEvent);

    const handle = await startBridge({ pairEventBus });
    const response = await connectPairEvents(handle, 'pair-session-1');
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Missing SSE body reader.');
    }

    const block = await readNextSseBlock(reader);
    expect(parseEventBlock(block)).toEqual(replayEvent);
    await reader.cancel();
  });

  it('unsubscribes when the client disconnects', async () => {
    const pairEventBus = new PairEventBus();
    const originalSubscribe = pairEventBus.subscribe.bind(pairEventBus);
    const unsubscribeSpy = vi.fn();
    vi.spyOn(pairEventBus, 'subscribe').mockImplementation((pairSessionId, handler) => {
      const unsubscribe = originalSubscribe(pairSessionId, handler);
      return () => {
        unsubscribeSpy();
        unsubscribe();
      };
    });

    const handle = await startBridge({ pairEventBus });
    const response = await connectPairEvents(handle, 'pair-session-1');
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Missing SSE body reader.');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('sends keepalive comments without emitting false events', async () => {
    const pairEventBus = new PairEventBus();
    const handle = await startBridge({
      pairEventBus,
      pairEventKeepaliveMs: 10,
      pairEventIdleTimeoutMs: 100,
    });
    const response = await connectPairEvents(handle, 'pair-session-1');
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Missing SSE body reader.');
    }

    const keepaliveBlock = await readNextSseBlock(reader);
    expect(keepaliveBlock).toBe(':');
    expect(parseEventBlock(keepaliveBlock)).toBeNull();

    const event: PairEvent = {
      type: 'session-ended',
      pairSessionId: 'pair-session-1',
      emittedAt: Date.now(),
    };
    pairEventBus.emit(event);

    const eventBlock = await readNextSseBlock(reader);
    expect(parseEventBlock(eventBlock)).toEqual(event);
    await reader.cancel();
  });

  it('returns 400 when pairSessionId is missing', async () => {
    const handle = await startBridge({ pairEventBus: new PairEventBus() });
    const response = await connectPairEvents(handle);

    expect(response.status).toBe(400);
  });
});
