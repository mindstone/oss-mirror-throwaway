import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import { PairEventBus } from '@core/appBridge/server/pairEventBus';

const handles: AppBridgeHandle[] = [];
const dirs: string[] = [];

let portBase = 55600;
function nextPortRange(count = 3): number[] {
  const start = portBase;
  portBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-routes-test-'));
  dirs.push(dir);
  return dir;
}

async function startBridge(options?: {
  pairEventBus?: PairEventBus;
  mintHandler?: (args: {
    appId: string;
    clientId: string;
    extensionId?: string;
    originExtensionId?: string;
    installSessionId?: string;
    fingerprint?: string;
  }) =>
    | { ok: true; token: string }
    | {
        ok: false;
        reason: string;
        status?: number;
        retryAfterMs?: number;
        direction?: 'forward' | 'reverse';
      };
}): Promise<AppBridgeHandle> {
  const handle = await createAppBridge({
    stateDirectory: await makeStateDir(),
    portCandidates: nextPortRange(),
    ...(options?.pairEventBus ? { pairEventBus: options.pairEventBus } : {}),
    hostHandlers: {
      prepareInstall: async () => ({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          attemptId: 'install-attempt-1',
          setupStatus: 'awaiting_user_handoff',
          selectedBrowser: {
            id: 'chrome',
            displayName: 'Google Chrome',
            extensionsPageUrl: 'chrome://extensions',
          },
          pairSessionId: 'install-session-1',
          nextStep: 'Load the revealed extension folder.',
          steps: [
            { name: 'detect_browsers', ok: true, status: 'completed' },
            { name: 'extract_extension', ok: true, status: 'completed' },
          ],
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
      mintAppTokenForTrustedHost:
        options?.mintHandler ??
        (({ appId, clientId }) => {
          if (appId !== 'office-addin') {
            return {
              ok: false,
              reason: 'appId-not-on-trusted-host-allowlist',
              status: 403,
            };
          }
          return {
            ok: true,
            token: `test-token-for-${appId}-${clientId}`,
          };
        }),
    },
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) await handle.stop().catch(() => undefined);
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('appBridge/server/hostRoutes', () => {
  it('/host/prepare-install returns the deterministic setup envelope', async () => {
    const handle = await startBridge();

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/prepare-install`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ browserId: 'chrome' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: {
        attemptId: 'install-attempt-1',
        setupStatus: 'awaiting_user_handoff',
        selectedBrowser: { id: 'chrome' },
        pairSessionId: 'install-session-1',
      },
    });
  });

  it('/host/prepare-install rejects browser-extension origins even with the router token', async () => {
    const handle = await startBridge();

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/prepare-install`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ browserId: 'chrome' }),
    });

    expect(res.status).toBe(403);
  });

  it('/host/list-pending-approvals rejects missing pairSessionId', async () => {
    const handle = await startBridge();

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/list-pending-approvals`, {
      method: 'GET',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'pair-session-id-required',
    });
  });

  it('/host/reset-install returns the handler result envelope', async () => {
    const handle = await startBridge();

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/reset-install`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pairSessionId: 'pair-session-1' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: { revoked: 0, idsRemoved: 0 },
    });
  });

  it('/host/mint-app-token issues a paired app token for trusted-host appIds', async () => {
    const handle = await startBridge();

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appId: 'office-addin', clientId: 'office-client-1' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      token: 'test-token-for-office-addin-office-client-1',
      appId: 'office-addin',
      clientId: 'office-client-1',
    });
  });

  it('/host/mint-app-token accepts the widened browser-extension body', async () => {
    const handle = await startBridge({
      mintHandler: ({ appId, clientId, extensionId, installSessionId, fingerprint }) => ({
        ok: true,
        token: [
          appId,
          clientId,
          extensionId,
          installSessionId,
          fingerprint,
        ].join(':'),
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: 'browser-0123456789abcdef',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        installSessionId: 'inst_123456',
        fingerprint: 'fingerprint-1',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      token:
        'browser-extension:browser-0123456789abcdef:abcdefghijklmnopabcdefghijklmnop:inst_123456:fingerprint-1',
      appId: 'browser-extension',
      clientId: 'browser-0123456789abcdef',
    });
  });

  it('/host/mint-app-token allows matching browser-extension origins to exchange the boot token', async () => {
    const handle = await startBridge({
      mintHandler: ({ appId, clientId, extensionId, originExtensionId, installSessionId }) => ({
        ok: true,
        token: `token:${appId}:${clientId}:${extensionId}:${originExtensionId}:${installSessionId}`,
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: 'browser-client-1',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        installSessionId: 'install-session-1',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      token: 'token:browser-extension:browser-client-1:abcdefghijklmnopabcdefghijklmnop:abcdefghijklmnopabcdefghijklmnop:install-session-1',
    });
  });

  it('/host/mint-app-token rejects browser-extension origin/body mismatches', async () => {
    const handle = await startBridge({
      mintHandler: () => ({
        ok: true,
        token: 'should-not-run',
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: 'browser-client-1',
        extensionId: 'ponmlkjihgfedcbaponmlkjihgfedcba',
        installSessionId: 'install-session-1',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'extension-origin-mismatch',
      code: 'FORBIDDEN',
    });
  });

  it('/host/mint-app-token rejects browser-extension origins requesting non-browser appIds', async () => {
    const handle = await startBridge({
      mintHandler: () => ({
        ok: true,
        token: 'should-not-run',
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'office-addin',
        clientId: 'office-client-1',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'browser-extension-origin-appid-mismatch',
      code: 'FORBIDDEN',
    });
  });

  it('/host/mint-app-token rejects widened fields for office-addin with 400', async () => {
    const handle = await startBridge();

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'office-addin',
        clientId: 'office-client-1',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'browser-extension-fields-not-allowed',
      code: 'BAD_REQUEST',
    });
  });

  it('/host/mint-app-token maps invalid extension id failures to 400', async () => {
    const handle = await startBridge({
      mintHandler: () => ({
        ok: false,
        reason: 'invalid-extension-id-format',
        status: 400,
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: 'browser-0123456789abcdef',
        extensionId: 'invalid',
        installSessionId: 'inst_123456',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'invalid-extension-id-format',
      code: 'BAD_REQUEST',
    });
  });

  it('/host/mint-app-token maps denylist failures to 403', async () => {
    const handle = await startBridge({
      mintHandler: () => ({
        ok: false,
        reason: 'install-session-revoked',
        status: 403,
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: 'browser-0123456789abcdef',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        installSessionId: 'inst_123456',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'install-session-revoked',
      code: 'FORBIDDEN',
    });
  });

  it('/host/mint-app-token maps forward binding conflicts to 403 with direction', async () => {
    const handle = await startBridge({
      mintHandler: () => ({
        ok: false,
        reason: 'clientId-extensionId-binding-conflict',
        status: 403,
        direction: 'forward',
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: 'browser-0123456789abcdef',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        installSessionId: 'inst_123456',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'clientId-extensionId-binding-conflict',
      code: 'FORBIDDEN',
      direction: 'forward',
    });
  });

  it('/host/mint-app-token maps reverse binding conflicts to 403 with direction', async () => {
    const handle = await startBridge({
      mintHandler: () => ({
        ok: false,
        reason: 'clientId-extensionId-binding-conflict',
        status: 403,
        direction: 'reverse',
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: 'browser-0123456789abcdef',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        installSessionId: 'inst_123456',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'clientId-extensionId-binding-conflict',
      code: 'FORBIDDEN',
      direction: 'reverse',
    });
  });

  it('/host/mint-app-token maps rate limits to 429 with Retry-After', async () => {
    const handle = await startBridge({
      mintHandler: () => ({
        ok: false,
        reason: 'rate-limited',
        status: 429,
        retryAfterMs: 2_500,
      }),
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'browser-extension',
        clientId: 'browser-0123456789abcdef',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        installSessionId: 'inst_123456',
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3');
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: 'rate-limited',
      code: 'RATE_LIMITED',
    });
  });

  it('/host/mint-app-token rejects appIds not on the trusted-host allowlist', async () => {
    const handle = await startBridge();

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appId: 'something-random', clientId: 'c1' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: unknown; reason: unknown };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('appId-not-on-trusted-host-allowlist');
  });

  it('/host/mint-app-token rejects pair tokens (router-internal only)', async () => {
    const handle = await startBridge();
    const pairToken = handle.tokenStore.issueAppToken('browser-extension', 'test-client');

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${pairToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appId: 'office-addin', clientId: 'c1' }),
    });

    // Pair tokens on /host/* routes are rejected with 403 per
    // the existing token-class enforcement in createHostRoutes.
    expect(res.status).toBe(403);
  });

  it('/host/mint-app-token rejects missing Authorization', async () => {
    const handle = await startBridge();

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/mint-app-token`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appId: 'office-addin', clientId: 'c1' }),
    });

    expect(res.status).toBe(401);
  });

  it('/host/mint-app-token issues a token usable on /intent/* routes', async () => {
    const handle = await startBridge();
    // Mint directly on the live tokenStore rather than via the fake
    // test handler — we want to verify the token shape is a real paired
    // token recognized by verifyAppToken.
    const token = handle.tokenStore.issueAppToken('office-addin', 'office-e2e');
    const claims = handle.tokenStore.verifyAppToken(token, {
      appId: 'office-addin',
      clientId: 'office-e2e',
    });
    expect(claims).not.toBeNull();
    expect(claims?.appId).toBe('office-addin');
    expect(claims?.clientId).toBe('office-e2e');
  });

  // Redirect of the prior "/host/reset-install emits session-ended" coverage.
  //
  // Stage 2 M1 moved the `session-ended`/`cause: user-reset` emit out of the
  // route and into `AppBridgeManager.resetInstall()` so it fires BEFORE the
  // translator subscription is torn down. The route itself no longer emits.
  // The full emit-ordering contract is exercised at the manager level in
  // `src/main/services/__tests__/appBridgeManager.test.ts` — search for the
  // "M1 regression" test. This test pins the route side of that contract:
  // with a fake handler that does nothing but return success, no bus event
  // is emitted by the route on its own.
  //
  // See docs/plans/260422_renderer_driven_connector_status.md — Stage 2 M1.
  it('/host/reset-install does not emit session-ended — manager owns the emit', async () => {
    const pairEventBus = new PairEventBus();
    const handle = await startBridge({ pairEventBus });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/reset-install`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pairSessionId: 'pair-session-1' }),
    });

    expect(res.status).toBe(200);
    // With the emit moved into the manager (which isn't wired into this
    // test's fake handler), the bus replay for the pair session must be
    // empty. If a future refactor reintroduces an emit at the route level,
    // this assertion fails loudly — and the translator-subscribe ordering
    // bug the planning doc calls out regresses.
    expect(pairEventBus.getReplay('pair-session-1')).toEqual([]);
  });

  it('/host/end-pair-session emits session-ended with cause step7-cleanup', async () => {
    const pairEventBus = new PairEventBus();
    const handle = await startBridge({ pairEventBus });

    const res = await fetch(`http://127.0.0.1:${handle.port}/host/end-pair-session`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.routerInternalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pairSessionId: 'pair-session-1' }),
    });

    expect(res.status).toBe(200);
    const replay = pairEventBus.getReplay('pair-session-1');
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      type: 'session-ended',
      cause: 'step7-cleanup',
      pairSessionId: 'pair-session-1',
    });
  });
});
