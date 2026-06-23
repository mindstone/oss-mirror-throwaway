import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorReporter } from '@core/errorReporter';
import {
  DEV_EXTENSION_IDS_FILE,
  assertAllowedHost,
  assertAllowedOrigin,
  assertAllowedOriginAsync,
  persistTrustedExtensionId,
} from '@core/appBridge/server/originGuard';
import { ErrorCode, type AppBridgeError } from '@core/appBridge/shared/errors';

const GOOD_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'; // 32 a–p chars
const OTHER_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

function mockRequest(headers: Record<string, string | undefined> = {}): IncomingMessage {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }
  return {
    headers: normalized,
  } as unknown as IncomingMessage;
}

function mockErrorReporter(): ErrorReporter & {
  _calls: Array<{ category: string; message: string; data?: Record<string, unknown> }>;
} {
  const calls: Array<{ category: string; message: string; data?: Record<string, unknown> }> = [];
  return {
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: (bc) => {
      calls.push({ category: bc.category, message: bc.message, data: bc.data });
    },
    _calls: calls,
  };
}

function isBridgeError(err: unknown): err is AppBridgeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as AppBridgeError).code === 'string'
  );
}

const tempDirs: string[] = [];

async function makeStateDirWithDevIds(ids: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-guard-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, DEV_EXTENSION_IDS_FILE);
  await fs.writeFile(file, JSON.stringify(ids), 'utf8');
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env['REBEL_APP_BRIDGE_DEV'];
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true });
  }
});

beforeEach(() => {
  delete process.env['REBEL_APP_BRIDGE_DEV'];
});

describe('appBridge/server/originGuard — assertAllowedOrigin', () => {
  it('allows chrome-extension://<known-id> when in allowlist', () => {
    const req = mockRequest({ origin: `chrome-extension://${GOOD_EXTENSION_ID}` });
    expect(() =>
      assertAllowedOrigin(req, { chromeExtensionIds: [GOOD_EXTENSION_ID] }),
    ).not.toThrow();
  });

  it('rejects unknown extension ID', () => {
    const req = mockRequest({ origin: `chrome-extension://${OTHER_EXTENSION_ID}` });
    let thrown: unknown;
    try {
      assertAllowedOrigin(req, { chromeExtensionIds: [GOOD_EXTENSION_ID] });
    } catch (err) {
      thrown = err;
    }
    expect(isBridgeError(thrown)).toBe(true);
    expect((thrown as AppBridgeError).code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('rejects https://evil.com', () => {
    const req = mockRequest({ origin: 'https://evil.com' });
    expect(() =>
      assertAllowedOrigin(req, { chromeExtensionIds: [GOOD_EXTENSION_ID] }),
    ).toThrow();
  });

  it('rejects missing Origin header', () => {
    const req = mockRequest({});
    let thrown: unknown;
    try {
      assertAllowedOrigin(req, { chromeExtensionIds: [GOOD_EXTENSION_ID] });
    } catch (err) {
      thrown = err;
    }
    expect(isBridgeError(thrown)).toBe(true);
    expect((thrown as AppBridgeError).code).toBe(ErrorCode.UNAUTHORIZED);
    expect((thrown as AppBridgeError).message).toMatch(/missing origin/i);
  });

  it('permits missing Origin header when allowMissingOrigin=true', () => {
    // Scoped to /intent/* routes so Chromium-extension GET fetches that
    // drop the Origin header (host_permissions-privileged simple fetches)
    // still flow through to the token gate.
    const req = mockRequest({});
    expect(() =>
      assertAllowedOrigin(req, {
        chromeExtensionIds: [GOOD_EXTENSION_ID],
        allowMissingOrigin: true,
      }),
    ).not.toThrow();
  });

  it('rejects literal null origin unless explicitly allowed', () => {
    const req = mockRequest({ origin: 'null' });
    expect(() =>
      assertAllowedOrigin(req, { chromeExtensionIds: [GOOD_EXTENSION_ID] }),
    ).toThrow();

    // With allowNullOrigin=true it's permitted (reserved for Office later).
    expect(() =>
      assertAllowedOrigin(req, {
        chromeExtensionIds: [GOOD_EXTENSION_ID],
        allowNullOrigin: true,
      }),
    ).not.toThrow();
  });

  it('dev mode reads extension IDs from file when REBEL_APP_BRIDGE_DEV=1', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const devId = 'debngmgodajmacjkiioiiocajkbbigni'; // 32 chars, all a-p
    const stateDir = await makeStateDirWithDevIds([devId]);

    const req = mockRequest({ origin: `chrome-extension://${devId}` });
    expect(() =>
      assertAllowedOrigin(req, {
        chromeExtensionIds: [],
        devMode: true,
        stateDirectory: stateDir,
      }),
    ).not.toThrow();
  });

  it('dev mode IDs are IGNORED when REBEL_APP_BRIDGE_DEV is unset', async () => {
    delete process.env['REBEL_APP_BRIDGE_DEV'];
    const devId = 'debngmgodajmacjkiioiiocajkbbigni';
    const stateDir = await makeStateDirWithDevIds([devId]);

    const req = mockRequest({ origin: `chrome-extension://${devId}` });
    expect(() =>
      assertAllowedOrigin(req, {
        chromeExtensionIds: [],
        devMode: true,
        stateDirectory: stateDir,
      }),
    ).toThrow();
  });

  it('sentry breadcrumb emitted on rejection', () => {
    const reporter = mockErrorReporter();
    const req = mockRequest({ origin: 'https://evil.com' });
    try {
      assertAllowedOrigin(req, {
        chromeExtensionIds: [GOOD_EXTENSION_ID],
        errorReporter: reporter,
      });
    } catch {
      /* expected */
    }
    expect(reporter._calls.length).toBeGreaterThan(0);
    expect(reporter._calls[0].category).toBe('app-bridge.origin-guard');
  });

  it('rejects invalid chrome extension ID format (shape check)', () => {
    const req = mockRequest({ origin: 'chrome-extension://not-a-valid-id' });
    expect(() =>
      assertAllowedOrigin(req, { chromeExtensionIds: ['not-a-valid-id'] }),
    ).toThrow();
  });

  it('moz-extension allowlist works in parallel with chrome-extension', () => {
    const mozId = 'moplkjihgfedcbaoponmlkjihgfedcba';
    const req = mockRequest({ origin: `moz-extension://${mozId}` });
    expect(() =>
      assertAllowedOrigin(req, { mozExtensionIds: [mozId] }),
    ).not.toThrow();
  });

  it('caps persisted trusted extension ids to the 50 most recent entries', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-guard-cap-'));
    tempDirs.push(stateDir);

    const seedIds = Array.from({ length: 50 }, (_, index) =>
      index
        .toString(16)
        .padStart(32, 'a')
        .replace(/[0-9a-f]/g, (char) => String.fromCharCode(97 + parseInt(char, 16))),
    );
    for (const id of seedIds) {
      persistTrustedExtensionId(stateDir, id, undefined);
    }

    const newestId = 'ponmlkjihgfedcbaponmlkjihgfedcba';
    persistTrustedExtensionId(stateDir, newestId, undefined);

    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, DEV_EXTENSION_IDS_FILE), 'utf8'),
    ) as string[];
    expect(persisted).toHaveLength(50);
    expect(persisted).not.toContain(seedIds[0]);
    expect(persisted).toContain(newestId);
  });
});

describe('appBridge/server/originGuard — assertAllowedOriginAsync', () => {
  it('returns tofu approval without persisting when persistOnApproval=false', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-guard-async-'));
    tempDirs.push(stateDir);
    const req = mockRequest({ origin: `chrome-extension://${OTHER_EXTENSION_ID}` });

    const result = await assertAllowedOriginAsync(req, {
      chromeExtensionIds: [GOOD_EXTENSION_ID],
      previewMode: true,
      stateDirectory: stateDir,
      persistOnApproval: false,
      onUnknownExtensionOrigin: async () => true,
    });

    expect(result).toEqual({ source: 'tofu', degraded: false });
    await expect(fs.readFile(path.join(stateDir, DEV_EXTENSION_IDS_FILE), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('persists approved origins by default', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-guard-async-'));
    tempDirs.push(stateDir);
    const req = mockRequest({ origin: `chrome-extension://${OTHER_EXTENSION_ID}` });

    const result = await assertAllowedOriginAsync(req, {
      chromeExtensionIds: [GOOD_EXTENSION_ID],
      previewMode: true,
      stateDirectory: stateDir,
      onUnknownExtensionOrigin: async () => true,
    });

    expect(result).toEqual({ source: 'tofu', degraded: false });
    await expect(
      fs.readFile(path.join(stateDir, DEV_EXTENSION_IDS_FILE), 'utf8'),
    ).resolves.toContain(OTHER_EXTENSION_ID);
  });

  it('marks the approval as degraded when the trust file cannot be persisted', async () => {
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-guard-async-file-'));
    tempDirs.push(parentDir);
    const blockedStatePath = path.join(parentDir, 'blocked-state-dir');
    await fs.writeFile(blockedStatePath, 'not-a-directory', 'utf8');
    const onTrustPersistenceFailure = vi.fn();
    const req = mockRequest({ origin: `chrome-extension://${OTHER_EXTENSION_ID}` });

    const result = await assertAllowedOriginAsync(req, {
      chromeExtensionIds: [GOOD_EXTENSION_ID],
      previewMode: true,
      stateDirectory: blockedStatePath,
      onUnknownExtensionOrigin: async () => true,
      onTrustPersistenceFailure,
    });

    expect(result).toEqual({ source: 'tofu', degraded: true });
    expect(onTrustPersistenceFailure).toHaveBeenCalledWith({
      extensionId: OTHER_EXTENSION_ID,
      stateDirectory: blockedStatePath,
    });
  });

  it('emits install.trust-persist-failed when trust persistence hits a disk-write error', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-guard-async-'));
    tempDirs.push(stateDir);
    const reporter = mockErrorReporter();
    const req = mockRequest({ origin: `chrome-extension://${OTHER_EXTENSION_ID}` });
    await fs.mkdir(path.join(stateDir, DEV_EXTENSION_IDS_FILE));

    const result = await assertAllowedOriginAsync(req, {
      chromeExtensionIds: [GOOD_EXTENSION_ID],
      previewMode: true,
      stateDirectory: stateDir,
      errorReporter: reporter,
      onUnknownExtensionOrigin: async () => true,
    });

    expect(result).toEqual({ source: 'tofu', degraded: true });
    expect(reporter._calls).toContainEqual(
      expect.objectContaining({
        category: 'app-bridge.install',
        message: 'install.trust-persist-failed',
      }),
    );
  });
});

describe('appBridge/server/originGuard — assertAllowedHost', () => {
  it('Host header must match bound port (127.0.0.1)', () => {
    const req = mockRequest({ host: '127.0.0.1:52320' });
    expect(() => assertAllowedHost(req, 52320)).not.toThrow();
  });

  it('Host header with localhost:<port> is also allowed', () => {
    const req = mockRequest({ host: 'localhost:52320' });
    expect(() => assertAllowedHost(req, 52320)).not.toThrow();
  });

  it('Host header with wrong port is rejected', () => {
    const req = mockRequest({ host: '127.0.0.1:99999' });
    let thrown: unknown;
    try {
      assertAllowedHost(req, 52320);
    } catch (err) {
      thrown = err;
    }
    expect(isBridgeError(thrown)).toBe(true);
    expect((thrown as AppBridgeError).code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('Host header from a remote DNS name is rejected (DNS rebind guard)', () => {
    const req = mockRequest({ host: 'evil.example:52320' });
    expect(() => assertAllowedHost(req, 52320)).toThrow();
  });

  it('missing Host header is rejected', () => {
    const req = mockRequest({});
    expect(() => assertAllowedHost(req, 52320)).toThrow();
  });

  it('emits sentry breadcrumb on host rejection', () => {
    const reporter = mockErrorReporter();
    const req = mockRequest({ host: 'evil.example:52320' });
    try {
      assertAllowedHost(req, 52320, { errorReporter: reporter });
    } catch {
      /* expected */
    }
    expect(reporter._calls.length).toBeGreaterThan(0);
    expect(reporter._calls[0].data?.['reason']).toBe('host-mismatch');
  });
});

describe('appBridge/server/originGuard — silent-handling of invalid state files', () => {
  it('tolerates missing or malformed dev-extension-ids.json', async () => {
    process.env['REBEL_APP_BRIDGE_DEV'] = '1';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-guard-missing-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, DEV_EXTENSION_IDS_FILE), 'not-json', 'utf8');

    // A known-good prod ID should still pass.
    const req = mockRequest({ origin: `chrome-extension://${GOOD_EXTENSION_ID}` });
    expect(() =>
      assertAllowedOrigin(req, {
        chromeExtensionIds: [GOOD_EXTENSION_ID],
        devMode: true,
        stateDirectory: dir,
      }),
    ).not.toThrow();

    // But an unknown ID still gets rejected (parse failure doesn't open the gate).
    const req2 = mockRequest({ origin: `chrome-extension://${OTHER_EXTENSION_ID}` });
    expect(() =>
      assertAllowedOrigin(req2, {
        chromeExtensionIds: [GOOD_EXTENSION_ID],
        devMode: true,
        stateDirectory: dir,
      }),
    ).toThrow();
  });
});

// vi is imported to keep the vitest setup file happy (parity with other tests).
void vi;
