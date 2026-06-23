import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppBridge, type AppBridgeHandle } from '@core/appBridge/server/bridge';
import { PairEventBus } from '@core/appBridge/server/pairEventBus';
import { PairingStore } from '@core/appBridge/server/pairingStore';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
// Unknown-but-well-formed chrome-extension ID (a–p, 32 chars) used to
// exercise the preview-mode claim path that intentionally bypasses the
// sync allowlist reject. See
// docs-private/investigations/260423_tofu_vs_claim_timeout_bug.md.
const UNKNOWN_EXT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const handles: AppBridgeHandle[] = [];
const dirs: string[] = [];

let portBase = 55000;
function nextPortRange(count = 3): number[] {
  const start = portBase;
  portBase += count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

async function makeStateDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-routes-test-'));
  dirs.push(d);
  return d;
}

async function startBridge(options: {
  pairEventBus?: PairEventBus;
  pairingStore?: PairingStore;
  pairCodeExpirySweepMs?: number;
  previewMode?: boolean;
  allowedChromeExtensionIds?: readonly string[];
  allowedMozExtensionIds?: readonly string[];
  onClaimPersistTrust?: (args: {
    pairSessionId: string;
    extensionId: string;
  }) => void;
  onUnknownExtensionOrigin?: (extensionId: string) => Promise<boolean>;
} = {}): Promise<AppBridgeHandle> {
  const stateDirectory = await makeStateDir();
  const handle = await createAppBridge({
    stateDirectory,
    portCandidates: nextPortRange(),
    allowedChromeExtensionIds: options.allowedChromeExtensionIds ?? [EXT_ID],
    ...(options.allowedMozExtensionIds
      ? { allowedMozExtensionIds: options.allowedMozExtensionIds }
      : {}),
    ...(options.pairEventBus ? { pairEventBus: options.pairEventBus } : {}),
    ...(options.pairingStore ? { pairingStore: options.pairingStore } : {}),
    ...(options.pairCodeExpirySweepMs
      ? { pairCodeExpirySweepMs: options.pairCodeExpirySweepMs }
      : {}),
    ...(options.previewMode !== undefined
      ? { previewMode: options.previewMode }
      : {}),
    ...(options.onClaimPersistTrust
      ? { onClaimPersistTrust: options.onClaimPersistTrust }
      : {}),
    ...(options.onUnknownExtensionOrigin
      ? { onUnknownExtensionOrigin: options.onUnknownExtensionOrigin }
      : {}),
  });
  handles.push(handle);
  return handle;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

beforeEach(() => {
  delete process.env['REBEL_APP_BRIDGE_DEV'];
});

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.stop().catch(() => undefined);
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true });
  }
  delete process.env['REBEL_APP_BRIDGE_DEV'];
});

describe('appBridge/server/pairRoutes', () => {
  it('/pair/start in dev mode returns a 6-digit code + expiresAt', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();
    const res = await post(
      `http://127.0.0.1:${handle.port}/pair/start`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { appId: 'browser-extension' },
    );
    expect(res.status).toBe(200);
    const body = res.body as { code: string; expiresAt: number };
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('/pair/claim with the right code returns a token', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();

    const start = await post(
      `http://127.0.0.1:${handle.port}/pair/start`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { appId: 'browser-extension' },
    );
    const { code } = start.body as { code: string };

    const claim = await post(
      `http://127.0.0.1:${handle.port}/pair/claim`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { code, clientId: 'client-a' },
    );
    expect(claim.status).toBe(200);
    const claimBody = claim.body as { token: string };
    expect(typeof claimBody.token).toBe('string');
    expect(claimBody.token.length).toBeGreaterThan(0);
  });

  it('/pair/claim with wrong code 10 times burns the code; subsequent right claim fails', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();

    const start = await post(
      `http://127.0.0.1:${handle.port}/pair/start`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { appId: 'browser-extension' },
    );
    const { code } = start.body as { code: string };

    for (let i = 0; i < 10; i += 1) {
      const r = await post(
        `http://127.0.0.1:${handle.port}/pair/claim`,
        {
          Origin: `chrome-extension://${EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
        { code: '000000', clientId: 'attacker' },
      );
      expect(r.status).toBe(410);
    }

    const right = await post(
      `http://127.0.0.1:${handle.port}/pair/claim`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { code, clientId: 'client-a' },
    );
    expect(right.status).toBe(410);
    expect(right.body).toMatchObject({ code: 'PAIRING_EXPIRED' });
  });

  it('/pair/revoke with a valid token returns 204 and invalidates the token', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const handle = await startBridge();

    const start = await post(
      `http://127.0.0.1:${handle.port}/pair/start`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { appId: 'browser-extension' },
    );
    const { code } = start.body as { code: string };

    const claim = await post(
      `http://127.0.0.1:${handle.port}/pair/claim`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { code, clientId: 'client-a' },
    );
    const { token } = claim.body as { token: string };

    const revoke = await fetch(
      `http://127.0.0.1:${handle.port}/pair/revoke`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: `chrome-extension://${EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
          Authorization: `Bearer ${token}`,
        },
      },
    );
    expect(revoke.status).toBe(204);

    // Second revoke with the same token is unauthorized (token already gone).
    const revokeAgain = await fetch(
      `http://127.0.0.1:${handle.port}/pair/revoke`,
      {
        method: 'POST',
        headers: {
          Origin: `chrome-extension://${EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
          Authorization: `Bearer ${token}`,
        },
      },
    );
    expect(revokeAgain.status).toBe(401);
  });

  it('/pair/start without dev env + without router-internal token returns 401', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();

    const res = await post(
      `http://127.0.0.1:${handle.port}/pair/start`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { appId: 'browser-extension' },
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('/pair/claim is public (Origin-gated only) — wrong code returns 410 PAIRING_EXPIRED without dev mode', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const handle = await startBridge();

    const res = await post(
      `http://127.0.0.1:${handle.port}/pair/claim`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { code: '000000', clientId: 'c' },
    );
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'PAIRING_EXPIRED' });
  });

  it('/pair/claim with invalid body returns 400 BAD_REQUEST', async () => {
    const handle = await startBridge();

    const res = await post(
      `http://127.0.0.1:${handle.port}/pair/claim`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { code: '' },
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('/pair/revoke without Authorization header returns 401', async () => {
    const handle = await startBridge();
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/pair/revoke`,
      {
        method: 'POST',
        headers: {
          Origin: `chrome-extension://${EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
      },
    );
    expect(res.status).toBe(401);
  });

  it('/pair/claim emits a paired event for the claimed pair session', async () => {
    const pairEventBus = new PairEventBus();
    const handle = await startBridge({ pairEventBus });
    const session = handle.pairingStore.createPendingSession('browser-extension', {
      pairSessionId: 'pair-session-1',
    });

    const claim = await post(
      `http://127.0.0.1:${handle.port}/pair/claim`,
      {
        Origin: `chrome-extension://${EXT_ID}`,
        Host: `127.0.0.1:${handle.port}`,
      },
      { code: session.code, clientId: 'client-a', fingerprint: 'abcd-1234' },
    );

    expect(claim.status).toBe(200);
    expect(pairEventBus.getReplay('pair-session-1')).toEqual([
      {
        type: 'paired',
        cause: 'paired',
        pairSessionId: 'pair-session-1',
        tokenFingerprint: 'abcd-1234',
        emittedAt: expect.any(Number),
      },
    ]);
  });

  it('emits code-expired once when an unclaimed pair code ages out', async () => {
    const pairEventBus = new PairEventBus();
    const pairingStore = new PairingStore({ ttlMs: 25 });
    const handle = await startBridge({
      pairEventBus,
      pairingStore,
      pairCodeExpirySweepMs: 5,
    });

    handle.pairingStore.createPendingSession('browser-extension', {
      pairSessionId: 'pair-session-expired',
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const replay = pairEventBus.getReplay('pair-session-expired');
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      type: 'code-expired',
      cause: 'ttl-expired',
      pairSessionId: 'pair-session-expired',
    });
  });

  it(
    'preview mode: /pair/claim from unknown but well-formed chrome-extension ' +
      'origin succeeds without firing the TOFU callback, and invokes onClaimPersistTrust',
    async () => {
      const onUnknownExtensionOrigin = vi.fn(async () => true);
      const onClaimPersistTrust = vi.fn();
      const pairEventBus = new PairEventBus();
      const handle = await startBridge({
        pairEventBus,
        previewMode: true,
        onUnknownExtensionOrigin,
        onClaimPersistTrust,
      });
      const session = handle.pairingStore.createPendingSession(
        'browser-extension',
        { pairSessionId: 'pair-session-preview-unknown' },
      );

      const claim = await post(
        `http://127.0.0.1:${handle.port}/pair/claim`,
        {
          // Unknown extension ID NOT in the allowlist — previously this
          // would have fired the TOFU approval gate and hung for 120s.
          Origin: `chrome-extension://${UNKNOWN_EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
        {
          code: session.code,
          clientId: 'client-unknown',
          fingerprint: 'fp-0001',
        },
      );

      expect(claim.status).toBe(200);
      const claimBody = claim.body as { token: string };
      expect(typeof claimBody.token).toBe('string');
      expect(claimBody.token.length).toBeGreaterThan(0);

      // Regression guard for the TOFU-vs-claim-timeout bug: the unknown
      // origin must NOT create a pending approval — the pair code alone
      // is now the consent gate at claim time.
      expect(onUnknownExtensionOrigin).not.toHaveBeenCalled();

      // Trust persistence is delegated to the host via
      // `onClaimPersistTrust`; verify it was invoked with the right args
      // so the manager can persist + bind the ID to the pair session.
      expect(onClaimPersistTrust).toHaveBeenCalledTimes(1);
      expect(onClaimPersistTrust).toHaveBeenCalledWith({
        pairSessionId: 'pair-session-preview-unknown',
        extensionId: UNKNOWN_EXT_ID,
      });
    },
  );

  it(
    'production mode (previewMode unset): /pair/claim from unknown origin ' +
      'returns 401 (regression guard — sync allowlist unchanged)',
    async () => {
      const onUnknownExtensionOrigin = vi.fn(async () => true);
      const onClaimPersistTrust = vi.fn();
      const handle = await startBridge({
        previewMode: false,
        onUnknownExtensionOrigin,
        onClaimPersistTrust,
      });

      const res = await post(
        `http://127.0.0.1:${handle.port}/pair/claim`,
        {
          Origin: `chrome-extension://${UNKNOWN_EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
        { code: '000000', clientId: 'c' },
      );

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(onUnknownExtensionOrigin).not.toHaveBeenCalled();
      expect(onClaimPersistTrust).not.toHaveBeenCalled();
    },
  );

  it(
    'preview mode: /pair/claim from moz-extension (non-chrome) origin still ' +
      '401s — TOFU-at-claim only covers well-formed chrome-extension IDs',
    async () => {
      const onClaimPersistTrust = vi.fn();
      const handle = await startBridge({
        previewMode: true,
        onClaimPersistTrust,
      });

      const res = await post(
        `http://127.0.0.1:${handle.port}/pair/claim`,
        {
          Origin: `moz-extension://${UNKNOWN_EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
        { code: '000000', clientId: 'c' },
      );

      expect(res.status).toBe(401);
      expect(onClaimPersistTrust).not.toHaveBeenCalled();
    },
  );

  it(
    'preview mode: /pair/claim from an ALREADY-ALLOWLISTED chrome-extension ' +
      'origin succeeds WITHOUT invoking onClaimPersistTrust (M2 bypass-only guard)',
    async () => {
      // Regression guard for the reviewer-flagged M2 issue: previously
      // `onClaimPersistTrust` fired whenever `result.ok && pairSessionId
      // && extensionId`, regardless of whether the claim cleared the
      // fast-path allowlist or the preview-bypass branch. Allowlisted
      // origins already have persisted trust entries — re-persisting is
      // redundant and would cause future code (correctly) assuming
      // "callback === new trust was just granted" to drift.
      const onClaimPersistTrust = vi.fn();
      const pairEventBus = new PairEventBus();
      const handle = await startBridge({
        pairEventBus,
        previewMode: true,
        onClaimPersistTrust,
      });
      const session = handle.pairingStore.createPendingSession(
        'browser-extension',
        { pairSessionId: 'pair-session-preview-allowlisted' },
      );

      const claim = await post(
        `http://127.0.0.1:${handle.port}/pair/claim`,
        {
          // Use the compiled allowlist ID — this clears the strict sync
          // guard via the fast path, NOT the preview-bypass branch.
          Origin: `chrome-extension://${EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
        {
          code: session.code,
          clientId: 'client-allowlisted',
          fingerprint: 'fp-0002',
        },
      );

      expect(claim.status).toBe(200);
      const claimBody = claim.body as { token: string };
      expect(typeof claimBody.token).toBe('string');
      expect(claimBody.token.length).toBeGreaterThan(0);

      // The callback MUST NOT fire for the allowlist fast-path — only
      // the preview-bypass branch should trigger trust persistence.
      expect(onClaimPersistTrust).not.toHaveBeenCalled();
    },
  );

  it(
    'preview mode: /pair/claim from a moz-extension with the ID explicitly ' +
      'allowlisted succeeds WITHOUT invoking onClaimPersistTrust (M3 ' +
      'chrome-only trust-file guard)',
    async () => {
      // Regression guard for the reviewer-flagged M3 issue:
      // `extractOriginExtensionId` accepts `moz-extension://...` too, so
      // if a moz ID were ever allowlisted and the callback fired, it
      // would persist into `dev-extension-ids.json` — a Chrome-only
      // trust file. Defence-in-depth: the scheme check inside
      // `handleClaim` must reject moz origins explicitly, even when the
      // claim itself clears the sync allowlist.
      const onClaimPersistTrust = vi.fn();
      const pairEventBus = new PairEventBus();
      const handle = await startBridge({
        pairEventBus,
        previewMode: true,
        // Keep the chrome allowlist empty so the moz ID is the only way
        // this claim can possibly succeed.
        allowedChromeExtensionIds: [],
        allowedMozExtensionIds: [UNKNOWN_EXT_ID],
        onClaimPersistTrust,
      });
      const session = handle.pairingStore.createPendingSession(
        'browser-extension',
        { pairSessionId: 'pair-session-preview-moz-allowlisted' },
      );

      const claim = await post(
        `http://127.0.0.1:${handle.port}/pair/claim`,
        {
          Origin: `moz-extension://${UNKNOWN_EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
        {
          code: session.code,
          clientId: 'client-moz',
          fingerprint: 'fp-0003',
        },
      );

      // The sync guard accepts this (moz ID is allowlisted) so the
      // claim itself succeeds — but the scheme guard must prevent the
      // chrome-only trust-file write from firing.
      expect(claim.status).toBe(200);
      const claimBody = claim.body as { token: string };
      expect(typeof claimBody.token).toBe('string');
      expect(claimBody.token.length).toBeGreaterThan(0);
      expect(onClaimPersistTrust).not.toHaveBeenCalled();
    },
  );

  it('emits the paired event exactly once when two claims race for the same code', async () => {
    const pairEventBus = new PairEventBus();
    const handle = await startBridge({ pairEventBus });
    const session = handle.pairingStore.createPendingSession('browser-extension', {
      pairSessionId: 'pair-session-race',
    });

    const [first, second] = await Promise.all([
      post(
        `http://127.0.0.1:${handle.port}/pair/claim`,
        {
          Origin: `chrome-extension://${EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
        { code: session.code, clientId: 'client-a' },
      ),
      post(
        `http://127.0.0.1:${handle.port}/pair/claim`,
        {
          Origin: `chrome-extension://${EXT_ID}`,
          Host: `127.0.0.1:${handle.port}`,
        },
        { code: session.code, clientId: 'client-b' },
      ),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 410]);
    expect(pairEventBus.getReplay('pair-session-race')).toHaveLength(1);
    expect(pairEventBus.getReplay('pair-session-race')[0]).toMatchObject({
      type: 'paired',
      pairSessionId: 'pair-session-race',
    });
  });
});
