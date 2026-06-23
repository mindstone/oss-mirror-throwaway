import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fsPromises = require('node:fs/promises');
// eslint-disable-next-line @typescript-eslint/no-var-requires -- CJS module under test
const { handleHostTool } = require('../tools/host');

interface ParsedToolResult {
  ok: boolean;
  reason: string;
  retryable: boolean;
  data?: Record<string, unknown>;
  userMessage?: string;
  instructions?: string;
  fallbackUrl?: string;
}

describe('rebel-app-bridge host tools', () => {
  const originalStatePath = process.env.REBEL_APP_BRIDGE_STATE;
  const originalExtraBrowserPaths = process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS;
  const originalAccess = fsPromises.access;
  const fetchMock = vi.fn();
  let tmpRoot: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    if (originalStatePath === undefined) delete process.env.REBEL_APP_BRIDGE_STATE;
    else process.env.REBEL_APP_BRIDGE_STATE = originalStatePath;
    if (originalExtraBrowserPaths === undefined) delete process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS;
    else process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS = originalExtraBrowserPaths;
    fsPromises.access = originalAccess;
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  function writeBridgeState(): void {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-host-tools-'));
    const statePath = join(tmpRoot, 'state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        port: 52320,
        pid: process.pid,
        protocolVersion: '1.0',
        startedAt: new Date().toISOString(),
        routerToken: 'router-token-test',
      }),
      'utf8',
    );
    process.env.REBEL_APP_BRIDGE_STATE = statePath;
  }

  function parseToolResult(result: { content: Array<{ type: string; text: string }> }): ParsedToolResult {
    return JSON.parse(result.content[0].text) as ParsedToolResult;
  }

  it('rebel_bridge_list_browsers returns a HostToolResult envelope with the fallback sentinel', async () => {
    process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS = 'chrome:/tmp/rebel-browser-test';
    fsPromises.access = vi.fn(async () => undefined);

    const parsed = parseToolResult(await handleHostTool('rebel_bridge_list_browsers', {}));

    expect(parsed).toMatchObject({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: {
        browsers: expect.arrayContaining([
          expect.objectContaining({
            id: 'chrome',
            displayName: 'Google Chrome',
            extensionsPageUrl: 'chrome://extensions',
          }),
        ]),
      },
    });
    expect((parsed.data?.browsers as Array<Record<string, unknown>>).at(-1)).toEqual(
      expect.objectContaining({
        id: 'none-of-the-above',
        displayName: 'Something else...',
      }),
    );
  });

  it('still appends the none-of-the-above sentinel when detection finds zero browsers', async () => {
    fsPromises.access = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const parsed = parseToolResult(await handleHostTool('rebel_bridge_list_browsers', {}));

    expect(parsed).toEqual({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: {
        browsers: [
          {
            id: 'none-of-the-above',
            displayName: 'Something else...',
            family: 'chromium',
            installed: true,
            supportedOnPlatforms: ['darwin', 'win32', 'linux'],
            extensionsPageUrl: 'chrome://extensions',
          },
        ],
      },
    });
  });

  it.each([
    [
      'rebel_bridge_prepare_install',
      { browser_id: 'chrome' },
      'http://127.0.0.1:52320/host/prepare-install',
      'POST',
      JSON.stringify({ browserId: 'chrome' }),
      {
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
          steps: [{ name: 'extract_extension', ok: true, status: 'completed' }],
        },
      },
      {
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
          installSessionAlias: 'install-session-1',
          nextStep: 'Load the revealed extension folder.',
          steps: [{ name: 'extract_extension', ok: true, status: 'completed' }],
        },
      },
    ],
    [
      'rebel_bridge_extract_extension',
      { browserId: 'chrome' },
      'http://127.0.0.1:52320/host/extract-extension',
      'POST',
      JSON.stringify({ browserId: 'chrome' }),
      { ok: true, targetDir: '/tmp/chrome', action: 'written', pairSessionId: 'install-session-1' },
      {
        ok: true,
        reason: 'ok',
        retryable: false,
        data: { action: 'written' },
      },
    ],
    [
      'rebel_bridge_reveal_extension_folder',
      { browserId: 'chrome' },
      'http://127.0.0.1:52320/host/reveal-extension-folder',
      'POST',
      JSON.stringify({ browserId: 'chrome' }),
      { ok: true },
      { ok: true, reason: 'ok', retryable: false, data: {} },
    ],
    [
      'rebel_bridge_open_extensions_page',
      { browserId: 'chrome' },
      'http://127.0.0.1:52320/host/open-extensions-page',
      'POST',
      JSON.stringify({ browserId: 'chrome' }),
      { ok: true },
      { ok: true, reason: 'ok', retryable: false, data: {} },
    ],
    [
      'rebel_bridge_diagnose',
      { browserId: 'chrome', pairSessionId: 'install-session-1' },
      'http://127.0.0.1:52320/host/diagnose',
      'POST',
      JSON.stringify({ browserId: 'chrome', pairSessionId: 'install-session-1' }),
      {
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          browserRunning: true,
          extensionExtracted: true,
          recentInstallBreadcrumbCount: 2,
          recentInstallFailureCount: 1,
          lastFailureReason: 'open-failed',
          bridgeReachable: true,
          pairSessionActive: true,
        },
      },
      {
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          browserRunning: true,
          extensionExtracted: true,
          recentInstallBreadcrumbCount: 2,
          recentInstallFailureCount: 1,
          lastFailureReason: 'open-failed',
          bridgeReachable: true,
          pairSessionActive: true,
        },
      },
    ],
  ])(
    'calls the expected host route for %s and wraps the response in HostToolResult',
    async (toolName, input, url, method, body, routeResponse, expectedEnvelope) => {
      writeBridgeState();
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => routeResponse,
      });

      const result = await handleHostTool(toolName, input);

      expect(fetchMock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          method,
          headers: expect.objectContaining({
            Authorization: 'Bearer router-token-test',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          }),
          ...(body ? { body } : {}),
        }),
      );
      expect(parseToolResult(result)).toEqual(expectedEnvelope);
    },
  );

  it('passes through cooldown-active diagnose envelopes', async () => {
    writeBridgeState();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        reason: 'cooldown-active',
        userMessage: 'Diagnose was already run recently.',
        instructions: 'Wait ~10s before running diagnose again.',
        retryable: true,
      }),
    });

    const parsed = parseToolResult(
      await handleHostTool('rebel_bridge_diagnose', { browserId: 'chrome' }),
    );

    expect(parsed).toEqual({
      ok: false,
      reason: 'cooldown-active',
      userMessage: 'Diagnose was already run recently.',
      instructions: 'Wait a few seconds, then try diagnose again.',
      retryable: true,
    });
  });

  it('sanitizes thrown diagnose failures without leaking raw detail strings', async () => {
    writeBridgeState();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockRejectedValue(new Error('probe exploded: /Users/test/secret-path'));

    const parsed = parseToolResult(
      await handleHostTool('rebel_bridge_diagnose', { browserId: 'chrome' }),
    );

    expect(parsed).toEqual({
      ok: false,
      reason: 'internal-error',
      userMessage: "I couldn't gather install diagnostics.",
      instructions: 'Try diagnose again in a moment.',
      retryable: true,
    });
    expect(parsed).not.toHaveProperty('data');
    expect(JSON.stringify(parsed)).not.toContain('secret-path');
  });

  it.each([
    'rebel_bridge_prepare_install',
    'rebel_bridge_extract_extension',
    'rebel_bridge_reveal_extension_folder',
    'rebel_bridge_open_extensions_page',
  ])('rejects display names as invalid browser ids for %s', async (toolName) => {
    vi.stubGlobal('fetch', fetchMock);

    const parsed = parseToolResult(
      await handleHostTool(
        toolName,
        toolName === 'rebel_bridge_prepare_install'
          ? { browser_id: 'Google Chrome' }
          : { browserId: 'Google Chrome' },
      ),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      ok: false,
      reason: 'invalid-browser-id',
      retryable: false,
      data: {
        browserId: 'Google Chrome',
        knownIds: ['chrome', 'edge', 'brave', 'arc', 'vivaldi', 'opera', 'comet', 'dia', 'thorium', 'yandex', 'opera-gx', 'sidekick', 'none-of-the-above'],
      },
    });
  });

  it('uses browser_id over the legacy browserId alias for prepare_install', async () => {
    writeBridgeState();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          attemptId: 'install-attempt-1',
          setupStatus: 'awaiting_user_handoff',
          selectedBrowser: { id: 'edge', displayName: 'Microsoft Edge', extensionsPageUrl: 'edge://extensions' },
          nextStep: 'Load the revealed extension folder.',
          steps: [],
        },
      }),
    });

    await handleHostTool('rebel_bridge_prepare_install', {
      browser_id: 'edge',
      browserId: 'chrome',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:52320/host/prepare-install',
      expect.objectContaining({
        body: JSON.stringify({ browserId: 'edge' }),
      }),
    );
  });

  it('calls prepare_install without browserId so the host can choose or ask', async () => {
    writeBridgeState();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          attemptId: 'install-attempt-1',
          setupStatus: 'needs_browser_choice',
          browserChoices: [{ id: 'chrome', displayName: 'Google Chrome', extensionsPageUrl: 'chrome://extensions' }],
          nextStep: 'Ask the user.',
          steps: [],
        },
      }),
    });

    const parsed = parseToolResult(await handleHostTool('rebel_bridge_prepare_install', {}));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:52320/host/prepare-install',
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      data: { setupStatus: 'needs_browser_choice' },
    });
  });

  it.each([
    'comet',
    'dia',
    'thorium',
    'yandex',
    'opera-gx',
    'sidekick',
    'none-of-the-above',
  ])('accepts %s as a valid browser id for rebel_bridge_extract_extension', async (browserId) => {
    writeBridgeState();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, targetDir: `/tmp/${browserId}`, action: 'written', pairSessionId: 'install-session-1' }),
    });

    const parsed = parseToolResult(await handleHostTool('rebel_bridge_extract_extension', { browserId }));

    expect(parsed).toMatchObject({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: { action: 'written' },
    });
  });

  it.each([
    'comet',
    'dia',
    'thorium',
    'yandex',
    'opera-gx',
    'sidekick',
    'none-of-the-above',
  ])('accepts %s as a valid browser id for rebel_bridge_reveal_extension_folder', async (browserId) => {
    writeBridgeState();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const parsed = parseToolResult(await handleHostTool('rebel_bridge_reveal_extension_folder', { browserId }));

    expect(parsed).toMatchObject({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: {},
    });
  });

  it.each([
    'comet',
    'dia',
    'thorium',
    'yandex',
    'opera-gx',
    'sidekick',
  ])('accepts %s as a valid browser id for rebel_bridge_open_extensions_page', async (browserId) => {
    writeBridgeState();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const parsed = parseToolResult(await handleHostTool('rebel_bridge_open_extensions_page', { browserId }));

    expect(parsed).toMatchObject({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: {},
    });
  });

  it('returns the manual-instructions envelope for none-of-the-above open_extensions_page', async () => {
    writeBridgeState();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        reason: 'unknown-browser-id',
        userMessage: "I don't know your browser, so open chrome://extensions manually.",
        instructions: "Paste chrome://extensions into your browser's address bar, then drag the Rebel extension folder into the page.",
        fallbackUrl: 'chrome://extensions',
        retryable: false,
      }),
    });

    const parsed = parseToolResult(
      await handleHostTool('rebel_bridge_open_extensions_page', { browserId: 'none-of-the-above' }),
    );

    expect(parsed).toEqual({
      ok: false,
      reason: 'unknown-browser-id',
      userMessage: "I don't know your browser, so open chrome://extensions manually.",
      instructions: "Paste chrome://extensions into your browser's address bar, then drag the Rebel extension folder into the page.",
      fallbackUrl: 'chrome://extensions',
      retryable: false,
    });
  });

  it.each([
    [
      'unknown-browser-id',
      {
        ok: false,
        reason: 'unknown-browser-id',
        fallbackUrl: 'chrome://extensions',
      },
      {
        ok: false,
        reason: 'unknown-browser-id',
        retryable: false,
        userMessage: "I don't know your browser, so open chrome://extensions manually.",
        instructions: "Paste chrome://extensions into your browser's address bar, then drag the Rebel extension folder into the page.",
        data: { fallbackUrl: 'chrome://extensions' },
      },
    ],
    [
      'browser-not-running',
      {
        ok: false,
        reason: 'browser-not-running',
        fallbackUrl: 'chrome://extensions',
      },
      {
        ok: false,
        reason: 'browser-not-running',
        retryable: true,
        userMessage: 'That browser needs to be open first.',
        instructions: 'Open the browser, then call rebel_bridge_open_extensions_page again.',
        data: { fallbackUrl: 'chrome://extensions' },
      },
    ],
    [
      'launch-failed',
      {
        ok: false,
        reason: 'launch-failed',
        fallbackUrl: 'chrome://extensions',
      },
      {
        ok: false,
        reason: 'launch-failed',
        retryable: true,
        userMessage: "I couldn't launch that browser's extensions page automatically.",
        instructions: 'Open chrome://extensions manually in your browser, then continue in chat.',
        data: { fallbackUrl: 'chrome://extensions' },
      },
    ],
    [
      'unsupported-browser',
      {
        ok: false,
        reason: 'unsupported-browser',
        fallbackUrl: 'chrome://extensions',
      },
      {
        ok: false,
        reason: 'unsupported-browser',
        retryable: false,
        userMessage: "I don't know how to open that browser's extensions page automatically.",
        instructions: 'Open chrome://extensions manually, or pick one of the browsers from rebel_bridge_list_browsers.',
        data: { fallbackUrl: 'chrome://extensions' },
      },
    ],
    [
      'no-default-browser',
      {
        ok: false,
        reason: 'no-default-browser',
        fallbackUrl: 'chrome://extensions',
      },
      {
        ok: false,
        reason: 'no-default-browser',
        retryable: true,
        userMessage: "I couldn't figure out which browser should open that page.",
        instructions: 'Open chrome://extensions manually in your browser, then continue in chat.',
        data: { fallbackUrl: 'chrome://extensions' },
      },
    ],
    [
      'open-failed',
      {
        ok: false,
        reason: 'open-failed',
        fallbackUrl: 'chrome://extensions',
      },
      {
        ok: false,
        reason: 'open-failed',
        retryable: true,
        userMessage: "I couldn't open the browser's extensions page automatically.",
        instructions: 'Open chrome://extensions manually in your browser, then continue in chat.',
        data: { fallbackUrl: 'chrome://extensions' },
      },
    ],
  ])(
    'maps %s open-extensions-page failures into structured host tool envelopes',
    async (_caseName, routeResponse, expectedEnvelope) => {
      writeBridgeState();
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => routeResponse,
      });

      const parsed = parseToolResult(
        await handleHostTool('rebel_bridge_open_extensions_page', { browserId: 'chrome' }),
      );

      expect(parsed).toEqual(expectedEnvelope);
    },
  );

  it.each([
    ['rebel_bridge_prepare_install', { browser_id: 'chrome' }],
    ['rebel_bridge_extract_extension', { browserId: 'chrome' }],
    ['rebel_bridge_reveal_extension_folder', { browserId: 'chrome' }],
    ['rebel_bridge_open_extensions_page', { browserId: 'chrome' }],
    ['rebel_bridge_diagnose', { browserId: 'chrome' }],
  ])('returns a bridge-unreachable envelope for %s when Rebel is offline', async (toolName, input) => {
    const parsed = parseToolResult(await handleHostTool(toolName, input));

    expect(parsed).toMatchObject({
      ok: false,
      reason: 'bridge-unreachable',
      retryable: true,
    });
  });
});
