import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBridgeInstallerService, AppBridgeInstallerServiceDeps } from '../appBridgeInstallerService';
import { installFunnelStats } from '../installFunnelStats';

vi.mock('../../core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

const DEFAULT_BRIDGE_STATE_JSON = JSON.stringify({
  routerToken: 'router-token-123',
  port: 52320,
  startedAt: '2026-04-23T12:34:56.000Z',
});

/**
 * Minimal readFile mock factory. Lets tests express "source manifest
 * returns X, target manifest returns Y, target state returns Z"
 * without hand-rolling switch statements in every case.
 *
 * The map keys match `includes()` substrings inside the requested path,
 * so `'packages/browser-extension/dist/manifest.json'` keys match the
 * dev-mode source path and `'appBridge/extensions/chrome/manifest.json'`
 * matches a target path. Any buffer content is returned byte-for-byte
 * when the consumer requests a Buffer (no encoding), and `utf-8` when
 * requested as `utf-8`.
 */
function installReadFileMocks(
  readFile: ReturnType<typeof vi.fn>,
  files: Record<string, string | Buffer>,
) {
  readFile.mockImplementation(async (p: unknown, encoding?: unknown) => {
    const key = String(p);
    if (key.endsWith('/mcp/rebel-app-bridge/state.json')) {
      return encoding === 'utf-8' || encoding === 'utf8'
        ? DEFAULT_BRIDGE_STATE_JSON
        : Buffer.from(DEFAULT_BRIDGE_STATE_JSON);
    }
    for (const [pattern, content] of Object.entries(files)) {
      if (key.endsWith(pattern) || key.includes(pattern)) {
        if (encoding === 'utf-8' || encoding === 'utf8') {
          return typeof content === 'string' ? content : content.toString('utf-8');
        }
        return typeof content === 'string' ? Buffer.from(content) : content;
      }
    }
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

function isBridgeStatePath(p: unknown): boolean {
  return String(p).endsWith('/mcp/rebel-app-bridge/state.json');
}

const WINDOWS_UNSUPPORTED_BROWSER_IDS = ['comet', 'dia', 'opera-gx', 'sidekick'] as const;

function expectedUnsupportedBrowserResult(
  browserName: string,
  platformName: 'Windows' | 'macOS' | 'Linux',
) {
  return {
    ok: false,
    reason: 'unsupported-browser',
    userMessage: `Rebel doesn't support ${browserName} on ${platformName} yet.`,
    instructions: 'Try installing Rebel in a different browser.',
    retryable: false,
  };
}

function getBrowserDisplayName(browserId: (typeof WINDOWS_UNSUPPORTED_BROWSER_IDS)[number]) {
  switch (browserId) {
    case 'comet':
      return 'Comet';
    case 'dia':
      return 'Dia';
    case 'opera-gx':
      return 'Opera GX';
    case 'sidekick':
      return 'Sidekick';
  }
}

function directoryEntry(name: string) {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
  };
}

describe('AppBridgeInstallerService', () => {
  let deps: AppBridgeInstallerServiceDeps;
  let service: AppBridgeInstallerService;

  beforeEach(() => {
    // Default readdir used by computeExtensionSourceHash — returns a
    // deterministic single-file source tree. Tests that care about the
    // tree shape override this per-case.
    const defaultReaddir = vi.fn().mockImplementation(async (p: string) => {
      if (String(p).includes('packages/browser-extension/dist')) {
        return [{
          name: 'manifest.json',
          isDirectory: () => false,
          isFile: () => true,
        }];
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    deps = {
      app: { getPath: vi.fn().mockReturnValue('/mock/userData'), isPackaged: false },
      shell: { showItemInFolder: vi.fn(), openExternal: vi.fn().mockResolvedValue(undefined) },
      fs: {
        readFile: vi.fn(),
        readdir: defaultReaddir,
        writeFile: vi.fn().mockResolvedValue(undefined),
        chmod: vi.fn().mockResolvedValue(undefined),
        stat: vi.fn().mockResolvedValue({}),
        rm: vi.fn().mockResolvedValue(undefined),
        cp: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined)
      } as any,
      processPlatform: 'darwin',
      processCwd: () => '/mock/cwd',
      processResourcesDir: '/mock/resources',
      isPackaged: false,
      browserProbe: vi.fn().mockResolvedValue(true),
    };
    service = new AppBridgeInstallerService(deps);
  });

  afterEach(() => {
    vi.useRealTimers();
    installFunnelStats.resetForTesting();
  });

  describe('prepareInstall', () => {
    it('returns deterministic browser choices without side effects when several browsers are installed', async () => {
      (deps.fs as any).access = vi.fn().mockResolvedValue(undefined);

      const res = await service.prepareInstall();

      expect(res).toMatchObject({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          setupStatus: 'needs_browser_choice',
          browserChoices: expect.arrayContaining([
            expect.objectContaining({ id: 'chrome', displayName: 'Google Chrome' }),
            expect.objectContaining({ id: 'edge', displayName: 'Microsoft Edge' }),
          ]),
        },
      });
      expect(deps.fs.cp).not.toHaveBeenCalled();
      expect(deps.shell.showItemInFolder).not.toHaveBeenCalled();
      expect(deps.shell.openExternal).not.toHaveBeenCalled();
    });

    it('returns a failed setup envelope when no supported browsers are detected', async () => {
      (deps.fs as any).access = vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      const res = await service.prepareInstall();

      expect(res).toMatchObject({
        ok: false,
        reason: 'browser-not-installed',
        retryable: false,
        data: {
          setupStatus: 'failed',
          browserChoices: [],
          steps: [{ name: 'detect_browsers', ok: true, status: 'completed' }],
        },
      });
    });

    it('prepares a chosen browser and returns only redacted setup data', async () => {
      (deps.fs as any).access = vi.fn().mockResolvedValue(undefined);
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': '{"version":"1.0.0"}',
      });

      const res = await service.prepareInstall('chrome');

      expect(res).toMatchObject({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          setupStatus: 'awaiting_user_handoff',
          selectedBrowser: {
            id: 'chrome',
            displayName: 'Google Chrome',
            extensionsPageUrl: 'chrome://extensions',
          },
          pairSessionId: expect.stringMatching(/^inst_/),
          nextStep: expect.stringContaining('Developer Mode'),
          steps: expect.arrayContaining([
            { name: 'detect_browsers', ok: true, status: 'completed' },
            { name: 'extract_extension', ok: true, status: 'completed' },
            { name: 'reveal_extension_folder', ok: true, status: 'completed' },
            { name: 'open_extensions_page', ok: true, status: 'completed' },
          ]),
        },
      });
      expect(JSON.stringify(res)).not.toContain('/mock/userData');
      expect(JSON.stringify(res)).not.toContain('router-token-123');
      expect(deps.shell.showItemInFolder).toHaveBeenCalled();
      expect(deps.shell.openExternal).toHaveBeenCalledWith('chrome://extensions');
    });

    it('preserves the existing install session when prepare reuses an extracted folder', async () => {
      (deps.fs as any).access = vi.fn().mockResolvedValue(undefined);
      const { createHash } = await import('node:crypto');
      const sourceManifestJson = '{"version":"1.0.0"}';
      const h = createHash('sha256');
      h.update('manifest.json');
      h.update('\0');
      const len = Buffer.alloc(8);
      len.writeBigUInt64LE(BigInt(Buffer.from(sourceManifestJson).length));
      h.update(len);
      h.update(Buffer.from(sourceManifestJson));
      h.update('\0');
      const sourceHash = h.digest('hex');
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': sourceManifestJson,
        'appBridge/extensions/chrome/manifest.json': sourceManifestJson,
        'appBridge/extensions/chrome/.rebel-extraction-state.json': JSON.stringify({
          schemaVersion: 1,
          sourceHash,
          sourceManifestVersion: '1.0.0',
          extractedAt: 1,
        }),
        'appBridge/extensions/chrome/rebel-boot-token.json': JSON.stringify({
          schemaVersion: 1,
          routerToken: 'old-router-token',
          bridgeOrigin: 'http://127.0.0.1:52320',
          port: 52320,
          startedAt: '2026-04-23T12:34:56.000Z',
          installSessionId: 'inst_existing',
        }),
      });

      const res = await service.prepareInstall('chrome');

      expect(res).toMatchObject({
        ok: true,
        data: {
          setupStatus: 'awaiting_user_handoff',
          pairSessionId: 'inst_existing',
        },
      });
      expect(deps.fs.rename).not.toHaveBeenCalled();
    });
  });

    it('returns an actionable timeout envelope when extraction hangs', async () => {
      vi.useFakeTimers();
      (deps.fs as any).access = vi.fn().mockResolvedValue(undefined);
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': '{"version":"1.0.0"}',
      });
      vi.mocked(deps.fs.cp).mockImplementation(
        () => new Promise<never>(() => undefined),
      );

      const pending = service.prepareInstall('chrome');
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: 'timeout',
        retryable: true,
        data: {
          setupStatus: 'failed',
          steps: expect.arrayContaining([
            {
              name: 'extract_extension',
              ok: false,
              status: 'failed',
              reason: 'timeout',
              retryable: true,
            },
          ]),
        },
      });
      expect(deps.shell.showItemInFolder).not.toHaveBeenCalled();
      expect(deps.shell.openExternal).not.toHaveBeenCalled();
    });

    it('keeps the prepare ledger degraded when opening the extensions page times out', async () => {
      vi.useFakeTimers();
      (deps.fs as any).access = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(service, 'extractExtensionFolder').mockResolvedValue({
        ok: true,
        targetDir: '/mock/userData/appBridge/extensions/chrome',
        action: 'written',
        pairSessionId: 'inst_timeout',
      });
      vi.spyOn(service, 'revealExtensionFolder').mockResolvedValue({ ok: true });
      vi.spyOn(service, 'openBrowserExtensionsPage').mockImplementation(
        () => new Promise<never>(() => undefined),
      );

      const pending = service.prepareInstall('chrome');
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toMatchObject({
        ok: true,
        reason: 'ok',
        data: {
          setupStatus: 'degraded',
          pairSessionId: 'inst_timeout',
          steps: expect.arrayContaining([
            {
              name: 'open_extensions_page',
              ok: false,
              status: 'failed',
              reason: 'timeout',
              retryable: true,
            },
          ]),
        },
      });
    });

  describe('extractExtensionFolder', () => {
    it('writes extraction-state and boot-token files into the staging dir before rename', async () => {
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': '{"version":"1.0.0"}',
      });

      const res = await service.extractExtensionFolder('chrome');

      expect(res).toEqual(expect.objectContaining({
        ok: true,
        targetDir: '/mock/userData/appBridge/extensions/chrome',
        action: 'written',
        pairSessionId: expect.any(String),
      }));
      const writeFileCalls = vi.mocked(deps.fs.writeFile).mock.calls;
      const markerIndex = writeFileCalls.findIndex(([filePath]) =>
        String(filePath).includes('.rebel-extraction-state.json'),
      );
      const bootTokenIndex = writeFileCalls.findIndex(([filePath]) =>
        String(filePath).includes('rebel-boot-token.json'),
      );
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      expect(bootTokenIndex).toBeGreaterThanOrEqual(0);
      expect(String(writeFileCalls[markerIndex]![0])).toMatch(
        /\.chrome\.incoming\..+\/\.rebel-extraction-state\.json$/,
      );
      expect(String(writeFileCalls[bootTokenIndex]![0])).toMatch(
        /\.chrome\.incoming\..+\/rebel-boot-token\.json$/,
      );
      expect(vi.mocked(deps.fs.writeFile).mock.invocationCallOrder[markerIndex]!).toBeLessThan(
        vi.mocked(deps.fs.rename).mock.invocationCallOrder[0]!,
      );
      expect(
        vi.mocked(deps.fs.writeFile).mock.invocationCallOrder[bootTokenIndex]!,
      ).toBeLessThan(vi.mocked(deps.fs.rename).mock.invocationCallOrder[0]!);
    });

    it('writes boot-token contents from the live bridge state snapshot', async () => {
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': '{"version":"1.0.0"}',
      });

      await service.extractExtensionFolder('chrome');

      const bootTokenWrite = vi
        .mocked(deps.fs.writeFile)
        .mock.calls.find(([filePath]) => String(filePath).includes('rebel-boot-token.json'));
      expect(bootTokenWrite).toBeDefined();
      expect(JSON.parse(String(bootTokenWrite![1]))).toMatchObject({
        schemaVersion: 1,
        routerToken: 'router-token-123',
        bridgeOrigin: 'http://127.0.0.1:52320',
        port: 52320,
        startedAt: '2026-04-23T12:34:56.000Z',
      });
      expect(
        (JSON.parse(String(bootTokenWrite![1])) as { installSessionId: string }).installSessionId,
      ).toMatch(/^inst_/);
    });

    it('skips extraction when content hash AND manifest version both match (idempotent)', async () => {
      // Target already has a marker whose sourceHash == hash(source tree).
      // Need to know that hash up-front so we can install it in the
      // marker. We compute it by running the same algorithm against the
      // same mocked tree (one file: manifest.json).
      const { createHash } = await import('node:crypto');
      const sourceManifestJson = '{"version":"1.0.0"}';
      const h = createHash('sha256');
      h.update('manifest.json');
      h.update('\0');
      const len = Buffer.alloc(8);
      len.writeBigUInt64LE(BigInt(Buffer.from(sourceManifestJson).length));
      h.update(len);
      h.update(Buffer.from(sourceManifestJson));
      h.update('\0');
      const expectedHash = h.digest('hex');

      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': sourceManifestJson,
        'appBridge/extensions/chrome/manifest.json': sourceManifestJson,
        'appBridge/extensions/chrome/.rebel-extraction-state.json': JSON.stringify({
          schemaVersion: 1,
          sourceHash: expectedHash,
          sourceManifestVersion: '1.0.0',
          extractedAt: 1_700_000_000_000,
        }),
      });

      const res = await service.extractExtensionFolder('chrome');
      expect(res).toEqual(expect.objectContaining({ ok: true, targetDir: '/mock/userData/appBridge/extensions/chrome', action: 'skipped', pairSessionId: expect.any(String) }));
      expect(deps.fs.cp).not.toHaveBeenCalled();
    });

    it('re-extracts when manifest version matches but content hash differs (stale bundle bug fix)', async () => {
      // Target manifest.version matches source, BUT the state marker's
      // sourceHash refers to a now-stale source tree. This is the path
      // the commit is here to unblock — a rebuild that forgot to bump
      // the version must still ship.
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': '{"version":"1.0.0"}',
        'appBridge/extensions/chrome/manifest.json': '{"version":"1.0.0"}',
        'appBridge/extensions/chrome/.rebel-extraction-state.json': JSON.stringify({
          schemaVersion: 1,
          sourceHash: 'deadbeef'.repeat(8), // clearly not a match for any real content
          sourceManifestVersion: '1.0.0',
          extractedAt: 1_700_000_000_000,
        }),
      });

      const res = await service.extractExtensionFolder('chrome');
      expect(res).toEqual(expect.objectContaining({ ok: true, targetDir: '/mock/userData/appBridge/extensions/chrome', action: 'written', pairSessionId: expect.any(String) }));
      expect(deps.fs.cp).toHaveBeenCalled();
      // Marker gets written to the staging dir (not targetDir directly).
      const writeFileCalls = vi.mocked(deps.fs.writeFile).mock.calls;
      const markerWrite = writeFileCalls.find(([p]) =>
        String(p).includes('.rebel-extraction-state.json'),
      );
      expect(markerWrite).toBeDefined();
      expect(String(markerWrite![0])).toMatch(/\.chrome\.incoming\..+\/\.rebel-extraction-state\.json$/);
      const markerContent = JSON.parse(String(markerWrite![1]));
      expect(markerContent.schemaVersion).toBe(1);
      expect(markerContent.sourceManifestVersion).toBe('1.0.0');
      expect(markerContent.sourceHash).toHaveLength(64);
      expect(markerContent.sourceHash).not.toBe('deadbeef'.repeat(8));
    });

    it('re-extracts when the state marker is missing entirely (pre-v1 install migration)', async () => {
      // Target manifest exists and version matches, but no marker —
      // represents users upgrading from a build that predates the
      // extraction-state scheme. Fail-safe to re-extract.
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': '{"version":"1.0.0"}',
        'appBridge/extensions/chrome/manifest.json': '{"version":"1.0.0"}',
        // .rebel-extraction-state.json intentionally absent → ENOENT.
      });

      const res = await service.extractExtensionFolder('chrome');
      expect(res).toEqual(expect.objectContaining({ ok: true, targetDir: '/mock/userData/appBridge/extensions/chrome', action: 'written', pairSessionId: expect.any(String) }));
      expect(deps.fs.cp).toHaveBeenCalled();
    });

    it('re-extracts when the state marker is corrupt JSON (treated as no state)', async () => {
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': '{"version":"1.0.0"}',
        'appBridge/extensions/chrome/manifest.json': '{"version":"1.0.0"}',
        'appBridge/extensions/chrome/.rebel-extraction-state.json': '{this is not valid json',
      });

      const res = await service.extractExtensionFolder('chrome');
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.action).toBe('written');
    });

    it('writes if target is missing', async () => {
      vi.mocked(deps.fs.readFile).mockImplementation(async (p) => {
        if (isBridgeStatePath(p)) return DEFAULT_BRIDGE_STATE_JSON;
        if (p.toString().includes('packages/browser-extension/dist')) return '{"version":"1.0.0"}';
        const err = new Error('ENOENT') as any; err.code = 'ENOENT'; throw err;
      });

      const res = await service.extractExtensionFolder('chrome');
      expect(res).toEqual(expect.objectContaining({ ok: true, targetDir: '/mock/userData/appBridge/extensions/chrome', action: 'written', pairSessionId: expect.any(String) }));
      expect(deps.fs.rm).toHaveBeenCalled();
      expect(deps.fs.cp).toHaveBeenCalled();
    });

    it('returns structured error on disk full', async () => {
      vi.mocked(deps.fs.readFile).mockImplementation(async (p) => {
        if (isBridgeStatePath(p)) return DEFAULT_BRIDGE_STATE_JSON;
        if (p.toString().includes('packages/browser-extension/dist')) return '{"version":"1.0.0"}';
        const err = new Error('ENOENT') as any; err.code = 'ENOENT'; throw err;
      });
      vi.mocked(deps.fs.cp).mockRejectedValue({ code: 'ENOSPC', message: 'No space left on device' });

      const res = await service.extractExtensionFolder('chrome');
      expect(res).toEqual({ ok: false, reason: 'disk-full' });
    });

    it.each([
      'comet',
      'dia',
      'thorium',
      'yandex',
      'opera-gx',
      'sidekick',
    ] as const)('writes the extension folder for %s', async (browserId) => {
      vi.mocked(deps.fs.readFile).mockImplementation(async (p) => {
        if (isBridgeStatePath(p)) return DEFAULT_BRIDGE_STATE_JSON;
        if (p.toString().includes('packages/browser-extension/dist')) return '{"version":"1.0.0"}';
        const err = new Error('ENOENT') as any; err.code = 'ENOENT'; throw err;
      });

      const res = await service.extractExtensionFolder(browserId);
      expect(res).toEqual(expect.objectContaining({
        ok: true,
        targetDir: `/mock/userData/appBridge/extensions/${browserId}`,
        action: 'written',
        pairSessionId: expect.any(String),
      }));
    });

    it('writes the generic extension folder under generic/<version> for none-of-the-above', async () => {
      vi.mocked(deps.fs.readFile).mockImplementation(async (p) => {
        if (isBridgeStatePath(p)) return DEFAULT_BRIDGE_STATE_JSON;
        if (p.toString().includes('packages/browser-extension/dist')) return '{"version":"1.0.0"}';
        const err = new Error('ENOENT') as any; err.code = 'ENOENT'; throw err;
      });

      const res = await service.extractExtensionFolder('none-of-the-above');
      expect(res).toEqual(expect.objectContaining({
        ok: true,
        targetDir: '/mock/userData/appBridge/extensions/generic/1.0.0',
        action: 'written',
        pairSessionId: expect.any(String),
      }));
    });

    it('uses a unique staging directory for concurrent none-of-the-above extracts', async () => {
      vi.mocked(deps.fs.readFile).mockImplementation(async (p) => {
        if (isBridgeStatePath(p)) return DEFAULT_BRIDGE_STATE_JSON;
        if (p.toString().includes('packages/browser-extension/dist')) return '{"version":"1.0.0"}';
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      await Promise.all([
        service.extractExtensionFolder('none-of-the-above'),
        service.extractExtensionFolder('none-of-the-above'),
      ]);

      const stagingDirs = vi.mocked(deps.fs.cp).mock.calls.map(([, targetDir]) => String(targetDir));
      expect(stagingDirs).toHaveLength(2);
      expect(new Set(stagingDirs).size).toBe(2);
      expect(stagingDirs[0]).toMatch(
        /^\/mock\/userData\/appBridge\/extensions\/generic\/\.none-of-the-above\.incoming\.\d+\.\d+\.[0-9a-f]{8}$/,
      );
      expect(stagingDirs[1]).toMatch(
        /^\/mock\/userData\/appBridge\/extensions\/generic\/\.none-of-the-above\.incoming\.\d+\.\d+\.[0-9a-f]{8}$/,
      );
    });

    it('returns a structured failure and skips boot-token writes when bridge runtime state is unavailable', async () => {
      vi.mocked(deps.fs.readFile).mockImplementation(async (p) => {
        if (p.toString().includes('packages/browser-extension/dist')) return '{"version":"1.0.0"}';
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      const res = await service.extractExtensionFolder('chrome');

      expect(res).toEqual({ ok: false, reason: 'bridge-runtime-state-unavailable' });
      expect(
        vi
          .mocked(deps.fs.writeFile)
          .mock.calls.some(([filePath]) => String(filePath).includes('rebel-boot-token.json')),
      ).toBe(false);
    });

    it.each(WINDOWS_UNSUPPORTED_BROWSER_IDS)(
      'returns a structured unsupported-browser envelope for %s on Windows',
      async (browserId) => {
        deps.processPlatform = 'win32';
        service = new AppBridgeInstallerService(deps);

        const res = await service.extractExtensionFolder(browserId);

        expect(res).toEqual(
          expectedUnsupportedBrowserResult(getBrowserDisplayName(browserId), 'Windows'),
        );
        expect(deps.fs.readFile).not.toHaveBeenCalled();
      },
    );
  });

  describe('regenerateBootTokenFiles', () => {
    it('rewrites multiple extracted folders when scoped to all browsers', async () => {
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'appBridge/extensions/chrome/manifest.json': '{"version":"1.0.0"}',
        'appBridge/extensions/edge/manifest.json': '{"version":"1.0.0"}',
        'appBridge/extensions/generic/1.0.0/manifest.json': '{"version":"1.0.0"}',
      });
      vi.mocked(deps.fs.readdir).mockImplementation(async (p) => {
        const pathValue = String(p);
        if (pathValue === '/mock/userData/appBridge/extensions') {
          return [
            directoryEntry('chrome'),
            directoryEntry('edge'),
            directoryEntry('generic'),
          ] as never;
        }
        if (pathValue === '/mock/userData/appBridge/extensions/generic') {
          return [directoryEntry('1.0.0')] as never;
        }
        return [] as never;
      });

      const result = await service.regenerateBootTokenFiles('all');

      expect(result).toEqual({ ok: true, rewritten: 3, skipped: 0, preserved: 0 });
      const bootTokenPaths = vi
        .mocked(deps.fs.writeFile)
        .mock.calls.map(([filePath]) => String(filePath))
        .filter((filePath) => filePath.includes('rebel-boot-token.json'));
      expect(bootTokenPaths).toEqual([
        '/mock/userData/appBridge/extensions/chrome/rebel-boot-token.json',
        '/mock/userData/appBridge/extensions/edge/rebel-boot-token.json',
        '/mock/userData/appBridge/extensions/generic/1.0.0/rebel-boot-token.json',
      ]);
    });

    it('scopes regeneration to the requested browser id', async () => {
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'appBridge/extensions/chrome/manifest.json': '{"version":"1.0.0"}',
      });

      const result = await service.regenerateBootTokenFiles(['chrome']);

      expect(result).toEqual({ ok: true, rewritten: 1, skipped: 0, preserved: 0 });
      expect(vi.mocked(deps.fs.writeFile)).toHaveBeenCalledWith(
        '/mock/userData/appBridge/extensions/chrome/rebel-boot-token.json',
        expect.stringContaining('"routerToken": "router-token-123"'),
        expect.objectContaining({ mode: 0o600 }),
      );
    });

    it('preserves existing non-denylisted installSessionId', async () => {
      // Pre-seeded boot-token file carries `inst_A`; denylist is empty.
      // Regeneration must write a fresh routerToken but keep `inst_A`,
      // otherwise the extension's service worker reloads on every app
      // launch (see investigation doc for the user-visible fallout).
      const existingBootToken = JSON.stringify({
        schemaVersion: 1,
        routerToken: 'stale-router-token',
        bridgeOrigin: 'http://127.0.0.1:52321',
        port: 52321,
        startedAt: '2026-04-22T10:00:00.000Z',
        installSessionId: 'inst_A',
      });
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'appBridge/extensions/chrome/manifest.json': '{"version":"1.0.0"}',
        'appBridge/extensions/chrome/rebel-boot-token.json': existingBootToken,
      });

      const result = await service.regenerateBootTokenFiles(['chrome']);

      expect(result).toEqual({ ok: true, rewritten: 1, skipped: 0, preserved: 1 });
      const bootTokenWrite = vi
        .mocked(deps.fs.writeFile)
        .mock.calls.find(([filePath]) => String(filePath).includes('rebel-boot-token.json'));
      expect(bootTokenWrite).toBeDefined();
      const written = JSON.parse(String(bootTokenWrite![1]));
      expect(written.installSessionId).toBe('inst_A');
      expect(written.routerToken).toBe('router-token-123');
    });

    it('replaces existing installSessionId when denylisted', async () => {
      // Revoke flows add the old id to the denylist before calling
      // regenerate, so we must mint a fresh id rather than reuse the
      // denylisted one — otherwise the extension continues to present a
      // revoked credential.
      const existingBootToken = JSON.stringify({
        schemaVersion: 1,
        routerToken: 'stale-router-token',
        bridgeOrigin: 'http://127.0.0.1:52321',
        port: 52321,
        startedAt: '2026-04-22T10:00:00.000Z',
        installSessionId: 'inst_A',
      });
      const stateJson = JSON.stringify({
        routerToken: 'router-token-123',
        port: 52320,
        startedAt: '2026-04-23T12:34:56.000Z',
        installSessionDenylist: [
          { installSessionId: 'inst_A', revokedAt: 123 },
        ],
      });
      vi.mocked(deps.fs.readFile).mockImplementation(async (p: unknown, encoding?: unknown) => {
        const key = String(p);
        if (key.endsWith('/mcp/rebel-app-bridge/state.json')) {
          return encoding === 'utf-8' || encoding === 'utf8' ? stateJson : Buffer.from(stateJson);
        }
        if (key.includes('appBridge/extensions/chrome/manifest.json')) {
          const content = '{"version":"1.0.0"}';
          return encoding === 'utf-8' || encoding === 'utf8' ? content : Buffer.from(content);
        }
        if (key.includes('appBridge/extensions/chrome/rebel-boot-token.json')) {
          return encoding === 'utf-8' || encoding === 'utf8'
            ? existingBootToken
            : Buffer.from(existingBootToken);
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      const result = await service.regenerateBootTokenFiles(['chrome']);

      expect(result).toEqual({ ok: true, rewritten: 1, skipped: 0, preserved: 0 });
      const bootTokenWrite = vi
        .mocked(deps.fs.writeFile)
        .mock.calls.find(([filePath]) => String(filePath).includes('rebel-boot-token.json'));
      expect(bootTokenWrite).toBeDefined();
      const written = JSON.parse(String(bootTokenWrite![1]));
      expect(written.installSessionId).not.toBe('inst_A');
      expect(written.installSessionId).toMatch(/^inst_/);
      expect(written.routerToken).toBe('router-token-123');
    });

    it('mints fresh installSessionId when boot-token file is missing', async () => {
      // First-extract and post-revoke-delete paths both hit this branch:
      // manifest is present, boot-token file is not, we must still emit
      // a regenerated file with a fresh id.
      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'appBridge/extensions/chrome/manifest.json': '{"version":"1.0.0"}',
        // rebel-boot-token.json intentionally absent → ENOENT.
      });

      const result = await service.regenerateBootTokenFiles(['chrome']);

      expect(result).toEqual({ ok: true, rewritten: 1, skipped: 0, preserved: 0 });
      const bootTokenWrite = vi
        .mocked(deps.fs.writeFile)
        .mock.calls.find(([filePath]) => String(filePath).includes('rebel-boot-token.json'));
      expect(bootTokenWrite).toBeDefined();
      const written = JSON.parse(String(bootTokenWrite![1]));
      expect(written.installSessionId).toMatch(/^inst_/);
      expect(written.routerToken).toBe('router-token-123');
    });
  });

  describe('revealExtensionFolder', () => {
    it('returns reveal-failed for a missing browser-specific folder', async () => {
      vi.mocked(deps.fs.stat).mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const res = await service.revealExtensionFolder('chrome');

      expect(res).toEqual({
        ok: false,
        reason: 'reveal-failed',
        userMessage: "There's nothing to reveal yet. Extract the extension first.",
        instructions: 'Run rebel_bridge_extract_extension before rebel_bridge_reveal_extension_folder.',
        retryable: false,
      });
      expect(deps.shell.showItemInFolder).not.toHaveBeenCalled();
    });

    it('calls shell.showItemInFolder with a path derived from browserId', async () => {
      const res = await service.revealExtensionFolder('chrome');
      expect(res).toEqual({ ok: true });
      expect(deps.shell.showItemInFolder).toHaveBeenCalledTimes(1);
      const actualPath = vi.mocked(deps.shell.showItemInFolder).mock.calls[0][0];
      expect(actualPath.endsWith('/chrome') || actualPath.endsWith('\\chrome')).toBe(true);
    });

    it.each([
      'comet',
      'dia',
      'thorium',
      'yandex',
      'opera-gx',
      'sidekick',
    ] as const)('reveals the browser-specific folder for %s', async (browserId) => {
      const res = await service.revealExtensionFolder(browserId);
      expect(res).toEqual({ ok: true });
      expect(vi.mocked(deps.shell.showItemInFolder).mock.calls.at(-1)?.[0]).toMatch(
        new RegExp(`${browserId.replace('-', '\\-')}$`),
      );
    });

    it('reveals the generic extension folder for none-of-the-above', async () => {
      vi.mocked(deps.fs.readFile).mockResolvedValue('{"version":"1.0.0"}');

      const res = await service.revealExtensionFolder('none-of-the-above');

      expect(res).toEqual({ ok: true });
      expect(deps.shell.showItemInFolder).toHaveBeenCalledWith(
        '/mock/userData/appBridge/extensions/generic/1.0.0',
      );
    });

    it('returns reveal-failed for none-of-the-above before extraction', async () => {
      vi.mocked(deps.fs.readFile).mockResolvedValue('{"version":"1.0.0"}');
      vi.mocked(deps.fs.stat).mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const res = await service.revealExtensionFolder('none-of-the-above');

      expect(res).toEqual({
        ok: false,
        reason: 'reveal-failed',
        userMessage: "There's nothing to reveal yet. Extract the extension first.",
        instructions: 'Run rebel_bridge_extract_extension before rebel_bridge_reveal_extension_folder.',
        retryable: false,
      });
      expect(deps.shell.showItemInFolder).not.toHaveBeenCalled();
    });

    it.each(WINDOWS_UNSUPPORTED_BROWSER_IDS)(
      'returns a structured unsupported-browser envelope for %s on Windows',
      async (browserId) => {
        deps.processPlatform = 'win32';
        service = new AppBridgeInstallerService(deps);

        const res = await service.revealExtensionFolder(browserId);

        expect(res).toEqual(
          expectedUnsupportedBrowserResult(getBrowserDisplayName(browserId), 'Windows'),
        );
        expect(deps.shell.showItemInFolder).not.toHaveBeenCalled();
      },
    );
  });

  describe('revertExtractionArtifacts', () => {
    it('returns removed false when browser metadata is missing', async () => {
      await expect(
        service.revertExtractionArtifacts({ sessionStartedAt: Date.now() }),
      ).resolves.toEqual({ removed: false });
      expect(deps.fs.rm).not.toHaveBeenCalled();
    });

    it('removes extracted folders created during the session', async () => {
      vi.mocked(deps.fs.stat).mockResolvedValueOnce({ mtimeMs: 2_000 } as never);

      await expect(
        service.revertExtractionArtifacts({
          browserId: 'chrome',
          sessionStartedAt: 1_000,
        }),
      ).resolves.toEqual({ removed: true });
      expect(deps.fs.rm).toHaveBeenCalledWith(
        '/mock/userData/appBridge/extensions/chrome',
        { recursive: true, force: true },
      );
    });

    it('leaves older extracted folders untouched', async () => {
      vi.mocked(deps.fs.stat).mockResolvedValueOnce({ mtimeMs: 999 } as never);

      await expect(
        service.revertExtractionArtifacts({
          browserId: 'chrome',
          sessionStartedAt: 1_000,
        }),
      ).resolves.toEqual({ removed: false });
      expect(deps.fs.rm).not.toHaveBeenCalled();
    });
  });

  describe('diagnose', () => {
    it('returns aggregate install diagnostics on the happy path', async () => {
      service.setDiagnoseContext({
        isBridgeReachable: () => true,
        hasActiveInstallSession: (installSessionId) => installSessionId === 'pair-1',
        hasAnyActiveInstallSessionForBrowser: (browserId) => browserId === 'chrome',
        getActiveInstallSessionForBrowser: (browserId) =>
          browserId === 'chrome' ? 'pair-1' : undefined,
        getActiveInstallSessions: () => [{ installSessionId: 'pair-1', browserId: 'chrome' }],
      });
      // Compute the expected hash for a source tree that is {manifest.json: '{"version":"1.0.0"}'}
      // so we can pre-seed a matching state marker and diagnose reports extensionExtracted: true.
      const { createHash } = await import('node:crypto');
      const manifestContent = '{"version":"1.0.0"}';
      const h = createHash('sha256');
      h.update('manifest.json');
      h.update('\0');
      const lenBuf = Buffer.alloc(8);
      lenBuf.writeBigUInt64LE(BigInt(Buffer.from(manifestContent).length));
      h.update(lenBuf);
      h.update(Buffer.from(manifestContent));
      h.update('\0');
      const expectedHash = h.digest('hex');

      installReadFileMocks(vi.mocked(deps.fs.readFile), {
        'packages/browser-extension/dist/manifest.json': manifestContent,
        '/mock/userData/appBridge/extensions/chrome/manifest.json': manifestContent,
        '/mock/userData/appBridge/extensions/chrome/.rebel-extraction-state.json': JSON.stringify({
          schemaVersion: 1,
          sourceHash: expectedHash,
          sourceManifestVersion: '1.0.0',
          extractedAt: 1_700_000_000_000,
        }),
      });
      installFunnelStats.end(
        'open-extensions-page',
        { browserId: 'chrome', pairSessionId: 'pair-1' },
        { reason: 'open-failed' },
      );

      const result = await service.diagnose({ browserId: 'chrome', pairSessionId: 'pair-1' });

      expect(result).toEqual({
        browserRunning: true,
        extensionExtracted: true,
        recentInstallBreadcrumbCount: 1,
        recentInstallFailureCount: 1,
        lastFailureReason: 'open-failed',
        bridgeReachable: true,
        pairSessionActive: true,
      });
    });

    it('records install breadcrumbs against the resolved active pair session', async () => {
      service.setDiagnoseContext({
        isBridgeReachable: () => true,
        hasActiveInstallSession: (installSessionId) => installSessionId === 'pair-live',
        hasAnyActiveInstallSessionForBrowser: (browserId) => browserId === 'chrome',
        getActiveInstallSessionForBrowser: (browserId) =>
          browserId === 'chrome' ? 'pair-live' : undefined,
        getActiveInstallSessions: () => [
          { installSessionId: 'pair-live', browserId: 'chrome' },
        ],
      });

      const result = await service.openBrowserExtensionsPage('chrome');

      expect(result).toEqual({ ok: true });
      expect(
        installFunnelStats.getRecentBreadcrumbs({
          browserId: 'chrome',
          pairSessionId: 'pair-live',
          sinceMs: 5 * 60 * 1000,
        }),
      ).toEqual({
        count: 2,
        failureCount: 0,
        lastFailureReason: null,
      });
    });

    it('returns pairSessionActive false for a stale pairSessionId', async () => {
      service.setDiagnoseContext({
        isBridgeReachable: () => true,
        hasActiveInstallSession: (installSessionId) => installSessionId === 'pair-live',
        hasAnyActiveInstallSessionForBrowser: (browserId) => browserId === 'chrome',
        getActiveInstallSessionForBrowser: (browserId) =>
          browserId === 'chrome' ? 'pair-live' : undefined,
        getActiveInstallSessions: () => [
          { installSessionId: 'pair-live', browserId: 'chrome' },
        ],
      });
      vi.mocked(deps.fs.readFile).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await service.diagnose({ browserId: 'chrome', pairSessionId: 'pair-stale' });

      expect(result.pairSessionActive).toBe(false);
      expect(result.recentInstallBreadcrumbCount).toBe(0);
    });

    it('returns browserRunning false when the probe reports the browser is closed', async () => {
      vi.mocked(deps.browserProbe!).mockResolvedValue(false);
      vi.mocked(deps.fs.readFile).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await service.diagnose({ browserId: 'chrome' });

      expect(result.browserRunning).toBe(false);
      expect(result.extensionExtracted).toBe(false);
      expect(result.bridgeReachable).toBe(false);
      expect(result.pairSessionActive).toBe(false);
    });

    it('treats browser-only diagnose requests as active when any session matches the browser', async () => {
      service.setDiagnoseContext({
        isBridgeReachable: () => true,
        hasActiveInstallSession: () => false,
        hasAnyActiveInstallSessionForBrowser: (browserId) => browserId === 'chrome',
        getActiveInstallSessionForBrowser: (browserId) =>
          browserId === 'chrome' ? 'pair-live' : undefined,
        getActiveInstallSessions: () => [
          { installSessionId: 'pair-live', browserId: 'chrome' },
        ],
      });
      vi.mocked(deps.fs.readFile).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
      installFunnelStats.end(
        'extract-extension',
        { browserId: 'chrome', pairSessionId: 'pair-live' },
        { reason: 'extract-failed' },
      );

      const result = await service.diagnose({ browserId: 'chrome' });

      expect(result.pairSessionActive).toBe(true);
      expect(result.recentInstallBreadcrumbCount).toBe(1);
      expect(result.recentInstallFailureCount).toBe(1);
      expect(result.lastFailureReason).toBe('extract-failed');
    });

    it('returns the latest failure reason from recent breadcrumbs', async () => {
      vi.mocked(deps.fs.readFile).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
      installFunnelStats.end('extract-extension', { browserId: 'chrome' }, { reason: 'extract-failed' });
      installFunnelStats.end('reveal-extension', { browserId: 'chrome' }, { reason: 'reveal-failed' });

      const result = await service.diagnose({ browserId: 'chrome' });

      expect(result.recentInstallBreadcrumbCount).toBe(2);
      expect(result.recentInstallFailureCount).toBe(2);
      expect(result.lastFailureReason).toBe('reveal-failed');
    });
  });

  describe('openBrowserExtensionsPage', () => {
    it('resolves properly on success', async () => {
      const res = await service.openBrowserExtensionsPage('chrome');
      expect(res).toEqual({ ok: true });
      expect(deps.shell.openExternal).toHaveBeenCalledWith('chrome://extensions');
    });

    it.each([
      [
        'browser-not-running',
        new Error('Browser not running'),
        { ok: false, reason: 'browser-not-running', fallbackUrl: 'edge://extensions' },
      ],
      [
        'launch-failed',
        Object.assign(new Error('Not found'), { code: 'ENOENT' }),
        { ok: false, reason: 'launch-failed', fallbackUrl: 'edge://extensions' },
      ],
      [
        'no-default-browser',
        new Error('No default browser configured'),
        { ok: false, reason: 'no-default-browser', fallbackUrl: 'edge://extensions' },
      ],
      [
        'open-failed',
        new Error('Failed to open'),
        { ok: false, reason: 'open-failed', fallbackUrl: 'edge://extensions' },
      ],
    ])('returns %s when openExternal fails', async (_caseName, error, expected) => {
      vi.mocked(deps.shell.openExternal).mockRejectedValue(error);

      const res = await service.openBrowserExtensionsPage('edge');

      expect(res).toEqual(expected);
    });

    it('returns a structured unsupported-browser envelope for unknown browser ids', async () => {
      const res = await service.openBrowserExtensionsPage('unknown-browser' as any);
      expect(res).toEqual(expectedUnsupportedBrowserResult('that browser', 'macOS'));
      expect(deps.shell.openExternal).not.toHaveBeenCalled();
    });

    it.each([
      ['comet', 'chrome://extensions'],
      ['dia', 'chrome://extensions'],
      ['thorium', 'chrome://extensions'],
      ['yandex', 'browser://extensions/'],
      ['opera-gx', 'opera://extensions'],
      ['sidekick', 'chrome://extensions'],
    ] as const)('opens the correct extensions URL for %s', async (browserId, expectedUrl) => {
      const res = await service.openBrowserExtensionsPage(browserId);
      expect(res).toEqual({ ok: true });
      expect(deps.shell.openExternal).toHaveBeenCalledWith(expectedUrl);
    });

    it('returns manual instructions for none-of-the-above without calling shell.openExternal', async () => {
      const res = await service.openBrowserExtensionsPage('none-of-the-above');

      expect(res).toEqual({
        ok: false,
        reason: 'unknown-browser-id',
        userMessage: "I don't know your browser, so open chrome://extensions manually.",
        instructions: "Paste chrome://extensions into your browser's address bar, then drag the Rebel extension folder into the page.",
        fallbackUrl: 'chrome://extensions',
        retryable: false,
      });
      expect(deps.shell.openExternal).not.toHaveBeenCalled();
    });

    it.each(WINDOWS_UNSUPPORTED_BROWSER_IDS)(
      'returns a structured unsupported-browser envelope for %s on Windows',
      async (browserId) => {
        deps.processPlatform = 'win32';
        service = new AppBridgeInstallerService(deps);

        const res = await service.openBrowserExtensionsPage(browserId);

        expect(res).toEqual(
          expectedUnsupportedBrowserResult(getBrowserDisplayName(browserId), 'Windows'),
        );
        expect(deps.shell.openExternal).not.toHaveBeenCalled();
      },
    );
  });
});
