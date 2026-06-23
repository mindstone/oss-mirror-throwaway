const { z } = require('zod');
const fs = require('node:fs/promises');
const path = require('node:path');

// Note: This logic is duplicated from src/core/appBridge/installer/browserDetect.ts
// because the MCP subprocess is plain Node and cannot import TypeScript files from core.
// Any changes to detection paths must be synchronized between both files.
// TODO(install-resilience): generate this mirrored catalogue from the core source of truth.

const BROWSER_DEFS = Object.freeze([
  {
    id: 'chrome',
    displayName: 'Google Chrome',
    family: 'chromium',
    supportedOnPlatforms: ['darwin', 'win32', 'linux'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'chrome://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Google Chrome.app'],
        binaryName: 'Google Chrome',
        bundleId: 'com.google.Chrome',
        userDataPath: '~/Library/Application Support/Google/Chrome',
      },
      win32: {
        installPaths: [],
        binaryName: 'chrome.exe',
        userDataPath: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
      },
      linux: {
        installPaths: ['/opt/google/chrome', '/usr/bin/google-chrome'],
        binaryName: 'google-chrome',
        userDataPath: '~/.config/google-chrome',
      },
    },
  },
  {
    id: 'edge',
    displayName: 'Microsoft Edge',
    family: 'chromium',
    supportedOnPlatforms: ['darwin', 'win32', 'linux'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'edge://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Microsoft Edge.app'],
        binaryName: 'Microsoft Edge',
        bundleId: 'com.microsoft.edgemac',
        userDataPath: '~/Library/Application Support/Microsoft Edge',
      },
      win32: {
        installPaths: [],
        binaryName: 'msedge.exe',
        userDataPath: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
      },
      linux: {
        installPaths: ['/opt/microsoft/msedge', '/usr/bin/microsoft-edge'],
        binaryName: 'microsoft-edge',
        userDataPath: '~/.config/microsoft-edge',
      },
    },
  },
  {
    id: 'brave',
    displayName: 'Brave',
    family: 'chromium',
    supportedOnPlatforms: ['darwin', 'win32', 'linux'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'brave://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Brave Browser.app'],
        binaryName: 'Brave Browser',
        bundleId: 'com.brave.Browser',
        userDataPath: '~/Library/Application Support/BraveSoftware/Brave-Browser',
      },
      win32: {
        installPaths: [],
        binaryName: 'brave.exe',
        userDataPath: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data',
      },
      linux: {
        installPaths: ['/opt/brave.com/brave', '/usr/bin/brave-browser', '/snap/bin/brave'],
        binaryName: 'brave-browser',
        userDataPath: '~/.config/BraveSoftware/Brave-Browser',
      },
    },
  },
  {
    id: 'arc',
    displayName: 'Arc',
    family: 'chromium',
    supportedOnPlatforms: ['darwin', 'win32'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'chrome://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Arc.app'],
        binaryName: 'Arc',
        bundleId: 'company.thebrowser.Browser',
        userDataPath: '~/Library/Application Support/Arc/User Data',
      },
      win32: {
        installPaths: [],
        binaryName: 'Arc.exe',
        userDataPath: '%LOCALAPPDATA%\\Arc\\User Data',
      },
    },
  },
  {
    id: 'vivaldi',
    displayName: 'Vivaldi',
    family: 'chromium',
    supportedOnPlatforms: ['darwin', 'win32', 'linux'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'vivaldi://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Vivaldi.app'],
        binaryName: 'Vivaldi',
        bundleId: 'com.vivaldi.Vivaldi',
        userDataPath: '~/Library/Application Support/Vivaldi',
      },
      win32: {
        installPaths: [],
        binaryName: 'vivaldi.exe',
        userDataPath: '%LOCALAPPDATA%\\Vivaldi\\User Data',
      },
      linux: {
        installPaths: ['/opt/vivaldi', '/usr/bin/vivaldi'],
        binaryName: 'vivaldi',
        userDataPath: '~/.config/vivaldi',
      },
    },
  },
  {
    id: 'opera',
    displayName: 'Opera',
    family: 'chromium',
    supportedOnPlatforms: ['darwin', 'win32', 'linux'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'opera://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Opera.app'],
        binaryName: 'Opera',
        bundleId: 'com.operasoftware.Opera',
        userDataPath: '~/Library/Application Support/com.operasoftware.Opera',
      },
      win32: {
        installPaths: [],
        binaryName: 'opera.exe',
        userDataPath: '%LOCALAPPDATA%\\Opera Software\\Opera Stable',
      },
      linux: {
        installPaths: ['/usr/lib/x86_64-linux-gnu/opera', '/usr/bin/opera', '/snap/bin/opera'],
        binaryName: 'opera',
        userDataPath: '~/.config/opera',
      },
    },
  },
  {
    id: 'comet',
    displayName: 'Comet',
    family: 'chromium',
    supportedOnPlatforms: ['darwin'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'chrome://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Comet.app'],
        binaryName: 'Comet',
        bundleId: 'ai.perplexity.comet',
        userDataPath: '~/Library/Application Support/ai.perplexity.comet',
      },
      // TODO(install-resilience): confirm Comet Windows/Linux install + profile paths from a live build.
    },
  },
  {
    id: 'dia',
    displayName: 'Dia',
    family: 'chromium',
    supportedOnPlatforms: ['darwin'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'chrome://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Dia.app'],
        binaryName: 'Dia',
        bundleId: 'company.thebrowser.dia',
      },
      // TODO(install-resilience): confirm Dia profile path and any non-macOS builds from a live install.
    },
  },
  {
    id: 'thorium',
    displayName: 'Thorium',
    family: 'chromium',
    supportedOnPlatforms: ['darwin', 'win32', 'linux'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'chrome://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Thorium.app'],
        binaryName: 'Thorium',
      },
      win32: {
        installPaths: [],
        binaryName: 'thorium.exe',
      },
      linux: {
        installPaths: ['/opt/chromium.org/thorium/thorium-browser', '/usr/bin/thorium-browser'],
        binaryName: 'thorium-browser',
      },
      // TODO(install-resilience): confirm Thorium bundle id + profile roots from a live install on each desktop OS.
    },
  },
  {
    id: 'yandex',
    displayName: 'Yandex Browser',
    family: 'chromium',
    supportedOnPlatforms: ['darwin', 'win32', 'linux'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'browser://extensions/',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Yandex.app'],
        binaryName: 'Yandex',
        bundleId: 'ru.yandex.desktop.yandex-browser',
        userDataPath: '~/Library/Application Support/Yandex/YandexBrowser',
      },
      win32: {
        installPaths: [],
        binaryName: 'browser.exe',
        userDataPath: '%LOCALAPPDATA%\\Yandex\\YandexBrowser\\User Data',
      },
      linux: {
        installPaths: ['/usr/bin/yandex-browser-stable', '/usr/bin/yandex-browser'],
        binaryName: 'yandex-browser',
        userDataPath: '~/.config/yandex-browser',
      },
    },
  },
  {
    id: 'opera-gx',
    displayName: 'Opera GX',
    family: 'chromium',
    supportedOnPlatforms: ['darwin'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'opera://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Opera GX.app'],
        binaryName: 'Opera GX',
        bundleId: 'com.operasoftware.OperaGX',
        userDataPath: '~/Library/Application Support/com.operasoftware.OperaGX',
      },
      // TODO(install-resilience): confirm Opera GX Windows/Linux install + profile paths from a live install.
    },
  },
  {
    id: 'sidekick',
    displayName: 'Sidekick',
    family: 'chromium',
    supportedOnPlatforms: ['darwin'],
    extensionsSubpath: 'Extensions',
    extensionsPageUrl: 'chrome://extensions',
    platforms: {
      darwin: {
        installPaths: ['/Applications/Sidekick.app'],
        binaryName: 'Sidekick',
        bundleId: 'com.pushplaylabs.sidekick',
      },
      // TODO(install-resilience): confirm Sidekick profile path and any Windows/Linux install locations from a live install.
    },
  },
]);

const BROWSER_DEF_MAP = new Map(BROWSER_DEFS.map((browser) => [browser.id, browser]));
const BrowserIdSchema = z.enum([
  'chrome',
  'edge',
  'brave',
  'arc',
  'vivaldi',
  'opera',
  'comet',
  'dia',
  'thorium',
  'yandex',
  'opera-gx',
  'sidekick',
  'none-of-the-above',
]);
const HOST_BROWSER_IDS = Object.freeze([...BrowserIdSchema.options]);
const NONE_OF_THE_ABOVE_BROWSER = Object.freeze({
  id: 'none-of-the-above',
  displayName: 'Something else...',
  family: 'chromium',
  installed: true,
  supportedOnPlatforms: ['darwin', 'win32', 'linux'],
  extensionsPageUrl: 'chrome://extensions',
});

const HOST_TOOL_REASON_VALUES = Object.freeze([
  'ok',
  'cooldown-active',
  'pair-session-not-found',
  'reset-partial-failure',
  'invalid-browser-id',
  'unknown-browser-id',
  'browser-not-installed',
  'browser-running',
  'browser-not-running',
  'extract-failed',
  'reveal-failed',
  'launch-failed',
  'unsupported-browser',
  'no-default-browser',
  'open-failed',
  'approval-not-found',
  'approval-already-resolved',
  'fingerprint-mismatch',
  'session-mismatch',
  'session-unbound',
  'permission-denied',
  'bridge-unreachable',
  'timeout',
  'internal-error',
]);

function buildDefaultWindowsInstallPaths(home, vendorSegments, appSegments = ['Application']) {
  const joiner = path.win32.join;
  const localAppData = process.env.LOCALAPPDATA || joiner(home, 'AppData', 'Local');
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const baseSegments = [...vendorSegments, ...appSegments];
  return [
    joiner(programFiles, ...baseSegments),
    joiner(programFilesX86, ...baseSegments),
    joiner(localAppData, ...baseSegments),
  ];
}

function getPlatformDef(platform, id) {
  const browser = BROWSER_DEF_MAP.get(id);
  if (!browser || !browser.supportedOnPlatforms.includes(platform)) {
    return undefined;
  }

  const platformDef = browser.platforms[platform];
  if (!platformDef) {
    return undefined;
  }

  if (platform !== 'win32' || platformDef.installPaths.length > 0) {
    return platformDef;
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  switch (id) {
    case 'chrome':
      return { ...platformDef, installPaths: buildDefaultWindowsInstallPaths(home, ['Google', 'Chrome']) };
    case 'edge':
      return { ...platformDef, installPaths: buildDefaultWindowsInstallPaths(home, ['Microsoft', 'Edge']) };
    case 'brave':
      return { ...platformDef, installPaths: buildDefaultWindowsInstallPaths(home, ['BraveSoftware', 'Brave-Browser']) };
    case 'arc':
      return {
        ...platformDef,
        installPaths: [path.win32.join(process.env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Programs', 'Arc')],
      };
    case 'vivaldi':
      return { ...platformDef, installPaths: buildDefaultWindowsInstallPaths(home, ['Vivaldi']) };
    case 'opera':
      return {
        ...platformDef,
        installPaths: [
          path.win32.join(process.env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Programs', 'Opera'),
          path.win32.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Opera'),
        ],
      };
    case 'thorium':
      return { ...platformDef, installPaths: buildDefaultWindowsInstallPaths(home, ['Thorium']) };
    case 'yandex':
      return { ...platformDef, installPaths: buildDefaultWindowsInstallPaths(home, ['Yandex', 'YandexBrowser']) };
    default:
      return platformDef;
  }
}

function getCandidatePaths(platform, id) {
  const platformDef = getPlatformDef(platform, id);
  return platformDef ? [...platformDef.installPaths] : [];
}

const HOST_TOOLS = [
  {
    name: 'rebel_bridge_list_browsers',
    capability: 'list_browsers',
    title: 'List browsers that can host Rebel Browser',
    description: 'Detects installed Chromium-based browsers on the local system that are compatible with the Rebel Browser extension. Returns a list of browser IDs and their human-readable names. Call this to find out what browsers the user has installed.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: 'rebel_bridge_prepare_install',
    capability: 'prepare_install',
    title: 'Prepare Rebel Browser installation',
    description: 'Deterministically prepares the Rebel Browser extension for a Chromium browser, reveals the extension folder, opens the extensions page when possible, and returns the exact user handoff steps. Prefer this over lower-level install tools.',
    inputSchema: z.object({
      browser_id: z.string().min(1).optional().describe('Canonical browser id from rebel_bridge_list_browsers, e.g. chrome or edge.'),
      browserId: z.string().min(1).optional().describe('Legacy alias for browser_id. Use browser_id when possible.'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: 'rebel_bridge_extract_extension',
    capability: 'extract_extension',
    title: 'Extract the Rebel Browser extension folder',
    description: 'Prepare the Rebel Browser extension folder for a specific browser install by extracting it into the local app data directory.',
    inputSchema: z.object({ browserId: z.string().min(1) }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: 'rebel_bridge_reveal_extension_folder',
    capability: 'reveal_extension_folder',
    title: 'Reveal the Rebel Browser extension folder',
    description: 'Open the OS file manager to show the Rebel Browser extension folder for the chosen browser.',
    inputSchema: z.object({ browserId: z.string().min(1) }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: 'rebel_bridge_open_extensions_page',
    capability: 'open_extensions_page',
    title: 'Open the browser extensions page',
    description: 'Open the target browser’s extensions page so the user can drag in the Rebel Browser folder.',
    inputSchema: z.object({ browserId: z.string().min(1) }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: 'rebel_bridge_diagnose',
    capability: 'diagnose',
    title: 'Diagnose a stuck Rebel Browser install',
    description: 'Collect aggregate-only install diagnostics without exposing raw paths, PIDs, or process details.',
    inputSchema: z.object({
      browserId: z.string().min(1),
      pairSessionId: z.string().min(1).optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
];

function getBinaryPath(platform, id, installPath) {
  const platformDef = getPlatformDef(platform, id);
  if (!platformDef) return undefined;
  if (platform === 'linux') return installPath;
  if (platform === 'darwin') {
    return platformDef.binaryName
      ? path.posix.join(installPath, 'Contents', 'MacOS', platformDef.binaryName)
      : undefined;
  }
  if (platform === 'win32') {
    return platformDef.binaryName
      ? path.win32.join(installPath, platformDef.binaryName)
      : undefined;
  }
  return undefined;
}

async function detectBrowsers() {
  const platform = process.platform;
  const results = [];
  const browserIds = BROWSER_DEFS
    .filter((browser) => browser.supportedOnPlatforms.includes(platform))
    .map((browser) => browser.id);

  const checkBrowser = async (id) => {
    const paths = getCandidatePaths(platform, id);
    
    if (process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS) {
      const extraPaths = process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS.split(',');
      for (const extra of extraPaths) {
        const idx = extra.indexOf(':');
        if (idx === -1) continue;
        const extraId = extra.substring(0, idx);
        const extraPath = extra.substring(idx + 1);
        if (extraId === id && extraPath) {
          paths.push(extraPath);
        }
      }
    }

    for (const candidate of paths) {
      try {
        await fs.access(candidate);
        const browser = BROWSER_DEF_MAP.get(id);
        results.push({
          id,
          displayName: browser?.displayName ?? id,
          installPath: candidate,
          binaryPath: getBinaryPath(platform, id, candidate),
          extensionsPageUrl: browser?.extensionsPageUrl ?? 'chrome://extensions',
        });
        return; // Found one valid path for this browser, stop checking others
      } catch {
        // Not found, try next candidate
      }
    }
  };

  const checks = Promise.all(browserIds.map(checkBrowser));
  
  let timerId;
  await Promise.race([
    checks,
    new Promise((resolve) => {
      timerId = setTimeout(resolve, 500);
    })
  ]);
  if (timerId) clearTimeout(timerId);

  return results;
}

function discoverBridgeState() {
  const { discoverBridge } = require('../bridge-discovery');
  const STATE_FILE_PATH = process.env.REBEL_APP_BRIDGE_STATE || null;
  const discovery = discoverBridge(STATE_FILE_PATH);
  if (!discovery.ok) {
    throw new Error(`BRIDGE_NOT_RUNNING: ${discovery.reason}`);
  }
  return discovery.state;
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort(createAbortError());
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timerId),
  };
}

async function callHostRoute(pathAndQuery, { method = 'POST', body, timeoutMs = 20000 } = {}) {
  const { port, routerToken } = discoverBridgeState();
  const url = `http://127.0.0.1:${port}${pathAndQuery}`;
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${routerToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: timeout.signal,
    });
    if (!res.ok) {
      throw new Error(`HOST_ROUTE_${res.status}`);
    }
    return await res.json();
  } finally {
    timeout.clear();
  }
}

function createAbortError() {
  try {
    return new DOMException('Timed out waiting for pair event.', 'AbortError');
  } catch {
    const error = new Error('Timed out waiting for pair event.');
    error.name = 'AbortError';
    return error;
  }
}

function isAbortLikeError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function parseSseEventBlock(block) {
  const dataLines = block
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());

  if (dataLines.length === 0) {
    return null;
  }

  return JSON.parse(dataLines.join('\n'));
}

function waitForAbort(signal) {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? createAbortError());
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? createAbortError()),
      { once: true },
    );
  });
}

function successResult(data = {}) {
  return {
    ok: true,
    reason: 'ok',
    retryable: false,
    data,
  };
}

function failureResult(reason, { userMessage, instructions, retryable, data } = {}) {
  const result = {
    ok: false,
    reason,
    retryable,
  };
  if (userMessage) {
    result.userMessage = userMessage;
  }
  if (instructions) {
    result.instructions = instructions;
  }
  if (data !== undefined) {
    result.data = data;
  }
  return result;
}

function waitPairEventTimeoutResult() {
  return failureResult('timeout', {
    userMessage: 'Still waiting for the browser extension to connect.',
    instructions:
      'If it has been more than a few minutes, the user might need to open the extension popup manually.',
    retryable: true,
  });
}

function redactPrepareInstallData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }
  const { pairSessionId, ...safeData } = data;
  if (typeof pairSessionId === 'string' && pairSessionId.length > 0) {
    safeData.installSessionAlias = pairSessionId;
  }
  return safeData;
}

function mapPrepareInstallResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    if (!result.data || typeof result.data.setupStatus !== 'string') {
      const { data: _data, ...safeResult } = result;
      return safeResult;
    }
    return {
      ...result,
      data: redactPrepareInstallData(result.data),
    };
  }
  return successResult(redactPrepareInstallData(result.data ?? {}));
}

function renderTextResult(result) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function validateBrowserId(browserId) {
  const parsed = BrowserIdSchema.safeParse(browserId);
  if (parsed.success) {
    return { ok: true, browserId: parsed.data };
  }
  return {
    ok: false,
    result: failureResult('invalid-browser-id', {
      userMessage: `"${String(browserId)}" isn't a Rebel browser id.`,
      instructions: 'Call rebel_bridge_list_browsers and pass one of its `id` values, not the display name.',
      retryable: false,
      data: {
        browserId,
        knownIds: HOST_BROWSER_IDS,
      },
    }),
  };
}

function resolvePrepareBrowserId(input) {
  const record = input && typeof input === 'object' ? input : {};
  const browserId = typeof record.browser_id === 'string'
    ? record.browser_id
    : typeof record.browserId === 'string'
      ? record.browserId
      : undefined;
  if (browserId === undefined) {
    return { ok: true, browserId: undefined };
  }
  return validateBrowserId(browserId);
}

function classifyHostError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('BRIDGE_NOT_RUNNING:')) {
    return failureResult('bridge-unreachable', {
      userMessage: "I couldn't reach Rebel's local bridge right now.",
      instructions: 'Make sure Rebel is open, then try again.',
      retryable: true,
    });
  }
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'TimeoutError')
  ) {
    return failureResult('timeout', {
      userMessage: 'That took too long.',
      instructions: 'Give Rebel a moment, then try again.',
      retryable: true,
    });
  }
  return failureResult('internal-error', {
    userMessage: 'That host step failed unexpectedly.',
    instructions: 'Try again. If it keeps failing, restart Rebel and retry.',
    retryable: true,
  });
}

async function executeHostRoute(pathAndQuery, options) {
  try {
    return await callHostRoute(pathAndQuery, options);
  } catch (error) {
    return classifyHostError(error);
  }
}

async function waitForPairEvent(input) {
  const pairSessionId = String(input.pairSessionId);
  // Internal ceiling matches inputSchema (600000 = 10min). Default fallback
  // kept at 30s so short-wait callers stay snappy; long waits must opt in.
  const timeoutMs = Math.min(
    600000,
    Math.max(
      1,
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
        ? Math.trunc(input.timeoutMs)
        : 30000,
    ),
  );
  const sinceEventAt =
    typeof input.sinceEventAt === 'number' && Number.isFinite(input.sinceEventAt)
      ? Math.trunc(input.sinceEventAt)
      : undefined;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(createAbortError());
  }, timeoutMs);
  const abortPromise = waitForAbort(controller.signal);

  let reader;
  try {
    const { port, routerToken } = discoverBridgeState();
    const response = await fetch(
      `http://127.0.0.1:${port}/host/pair-events?pairSessionId=${encodeURIComponent(pairSessionId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${routerToken}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      },
    );

    if (!response.ok || !response.body) {
      return failureResult('bridge-unreachable', {
        userMessage: "I couldn't reach Rebel's local bridge right now.",
        instructions: 'Make sure Rebel is open, then try again.',
        retryable: true,
        data: { detail: `HOST_ROUTE_${response.status}` },
      });
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await Promise.race([reader.read(), abortPromise]);
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let normalized = buffer.replace(/\r\n/g, '\n');
      let boundary = normalized.indexOf('\n\n');

      while (boundary !== -1) {
        const block = normalized.slice(0, boundary);
        normalized = normalized.slice(boundary + 2);
        const event = parseSseEventBlock(block);
        if (event && (sinceEventAt == null || event.emittedAt > sinceEventAt)) {
          return successResult({
            event,
            emittedAt: event.emittedAt,
          });
        }
        boundary = normalized.indexOf('\n\n');
      }

      buffer = normalized;
    }

    return failureResult('bridge-unreachable', {
      userMessage: "I couldn't keep listening for the browser extension.",
      instructions: 'Make sure Rebel is open, then try again.',
      retryable: true,
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      return waitPairEventTimeoutResult();
    }
    return failureResult('bridge-unreachable', {
      userMessage: "I couldn't reach Rebel's local bridge right now.",
      instructions: 'Make sure Rebel is open, then try again.',
      retryable: true,
      data: {
        detail: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    clearTimeout(timeoutId);
    if (reader) {
      await reader.cancel().catch(() => undefined);
    }
  }
}

function mapExtractExtensionResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  if (result.ok) {
    return successResult({
      action: result.action,
    });
  }
  if (result.reason === 'permission-denied') {
    return failureResult('permission-denied', {
      userMessage: "Rebel couldn't unpack the browser add-on there.",
      instructions: 'Check folder permissions, then try again.',
      retryable: true,
      data: { routeReason: result.reason },
    });
  }
  return failureResult('extract-failed', {
    userMessage: "I couldn't unpack the browser add-on just now.",
    instructions: 'Try again. If it still refuses, restart Rebel and retry.',
    retryable: true,
    data: { routeReason: result.reason },
  });
}

function mapRevealExtensionResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  if (result.ok) {
    return successResult({});
  }
  return failureResult('reveal-failed', {
    userMessage: "I couldn't reveal the extension folder automatically.",
    instructions: 'Open your file manager and go to Rebel’s browser extension folder, then continue in chat.',
    retryable: true,
    data: { routeReason: result.reason },
  });
}

function mapOpenExtensionsPageResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  if (result.ok) {
    return successResult({});
  }
  if (result.reason === 'unknown-browser-id') {
    return failureResult('unknown-browser-id', {
      userMessage: "I don't know your browser, so open chrome://extensions manually.",
      instructions: "Paste chrome://extensions into your browser's address bar, then drag the Rebel extension folder into the page.",
      retryable: false,
      data: result.fallbackUrl ? { fallbackUrl: result.fallbackUrl } : undefined,
    });
  }
  if (result.reason === 'browser-not-running') {
    return failureResult('browser-not-running', {
      userMessage: 'That browser needs to be open first.',
      instructions: 'Open the browser, then call rebel_bridge_open_extensions_page again.',
      retryable: true,
      data: result.fallbackUrl ? { fallbackUrl: result.fallbackUrl } : undefined,
    });
  }
  if (result.reason === 'launch-failed') {
    return failureResult('launch-failed', {
      userMessage: "I couldn't launch that browser's extensions page automatically.",
      instructions: result.fallbackUrl
        ? `Open ${result.fallbackUrl} manually in your browser, then continue in chat.`
        : 'Open your browser’s extensions page manually, then continue in chat.',
      retryable: true,
      data: result.fallbackUrl ? { fallbackUrl: result.fallbackUrl } : undefined,
    });
  }
  if (result.reason === 'unsupported-browser') {
    return failureResult('unsupported-browser', {
      userMessage: "I don't know how to open that browser's extensions page automatically.",
      instructions: result.fallbackUrl
        ? `Open ${result.fallbackUrl} manually, or pick one of the browsers from rebel_bridge_list_browsers.`
        : 'Pick one of the browsers from rebel_bridge_list_browsers, or open the extensions page manually.',
      retryable: false,
      data: result.fallbackUrl ? { fallbackUrl: result.fallbackUrl } : undefined,
    });
  }
  if (result.reason === 'no-default-browser') {
    return failureResult('no-default-browser', {
      userMessage: "I couldn't figure out which browser should open that page.",
      instructions: result.fallbackUrl
        ? `Open ${result.fallbackUrl} manually in your browser, then continue in chat.`
        : 'Open your browser’s extensions page manually, then continue in chat.',
      retryable: true,
      data: result.fallbackUrl ? { fallbackUrl: result.fallbackUrl } : undefined,
    });
  }
  return failureResult('open-failed', {
    userMessage: "I couldn't open the browser's extensions page automatically.",
    instructions: result.fallbackUrl
      ? `Open ${result.fallbackUrl} manually in your browser, then continue in chat.`
      : 'Open your browser’s extensions page manually, then continue in chat.',
    retryable: true,
    data: result.fallbackUrl ? { fallbackUrl: result.fallbackUrl } : undefined,
  });
}

function mapStartPairingResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  return successResult({
    code: result.code,
    expiresAt: result.expiresAt,
    expiresInSeconds: result.expiresInSeconds,
    pairSessionId: result.pairSessionId,
    appId: result.appId,
  });
}

function mapCheckPairStatusResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  if (result.ok) {
    // Distinct loud-failure path: the bridge reports this pairSessionId
    // was never issued (not just expired). This typically means the
    // agent fabricated or mistyped the ID, since the real one was only
    // visible inside an earlier tool_result which isn't preserved in
    // conversation_history. Surface `pair-session-not-found` so the
    // agent stops looping and restarts the install from STEP 0.
    if (result.pairSessionNotFound === true) {
      return failureResult('pair-session-not-found', {
        userMessage: "I don't recognise that pairing session.",
        instructions:
          'The pairSessionId from the earlier rebel_bridge_start_pairing call is required. If you lost it, start over with rebel_bridge_start_pairing — do not retry with a reconstructed ID.',
        retryable: false,
        data: {
          paired: result.paired,
          hasPending: result.hasPending,
          pairSessionExpired: result.pairSessionExpired,
          pairSessionNotFound: true,
        },
      });
    }
    return successResult({
      paired: result.paired,
      hasPending: result.hasPending,
      pairSessionExpired: result.pairSessionExpired,
    });
  }
  return failureResult('internal-error', {
    userMessage: "I couldn't read the pairing status.",
    instructions: 'Try checking the pairing status again.',
    retryable: true,
    data: { routeReason: result.reason },
  });
}

function mapDiagnoseResult(result) {
  if (result.ok) {
    return successResult(result.data ?? {});
  }

  switch (result.reason) {
    case 'cooldown-active':
      return failureResult('cooldown-active', {
        userMessage: 'Diagnose was already run recently.',
        instructions: 'Wait a few seconds, then try diagnose again.',
        retryable: true,
      });
    case 'bridge-unreachable':
      return failureResult('bridge-unreachable', {
        userMessage: "I couldn't reach Rebel's local bridge right now.",
        instructions: 'Make sure Rebel is open, then try diagnose again.',
        retryable: true,
      });
    case 'timeout':
      return failureResult('timeout', {
        userMessage: 'Install diagnostics took too long.',
        instructions: 'Give Rebel a moment, then try diagnose again.',
        retryable: true,
      });
    default:
      return failureResult('internal-error', {
        userMessage: "I couldn't gather install diagnostics.",
        instructions: 'Try diagnose again in a moment.',
        retryable: true,
      });
  }
}

function mapResetInstallResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  if (result.ok) {
    return successResult(result.data ?? {});
  }
  if (result.reason === 'pair-session-not-found') {
    return failureResult('pair-session-not-found', {
      userMessage: "That install session isn't active anymore.",
      instructions: 'Start pairing again before trying another reset.',
      retryable: false,
      data: { routeReason: result.reason },
    });
  }
  return failureResult('internal-error', {
    userMessage: "I couldn't reset that install session.",
    instructions: 'Try starting a fresh pairing session instead.',
    retryable: true,
    data: { routeReason: result.reason },
  });
}

function mapListPendingApprovalsResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  if (result.ok) {
    return successResult({ pending: result.pending });
  }
  return failureResult('internal-error', {
    userMessage: "I couldn't read the pending approvals.",
    instructions: 'Refresh the pending approvals and try again.',
    retryable: true,
    data: { routeReason: result.reason },
  });
}

function mapApprovePendingResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  if (result.ok) {
    return successResult({});
  }
  if (result.reason === 'not-found') {
    return failureResult('approval-not-found', {
      userMessage: "That approval isn't active anymore.",
      instructions: 'Start over with rebel_bridge_start_pairing.',
      retryable: false,
      data: { routeReason: result.reason },
    });
  }
  if (result.reason === 'already-resolved') {
    return failureResult('approval-already-resolved', {
      userMessage: 'That approval was already handled.',
      instructions: 'Check rebel_bridge_check_pair_status.',
      retryable: false,
      data: { routeReason: result.reason },
    });
  }
  if (result.reason === 'expired' || result.reason === 'session-expired') {
    return failureResult('timeout', {
      userMessage: 'That approval expired before it could finish.',
      instructions: 'Start pairing again, then retry the approval.',
      retryable: false,
      data: { routeReason: result.reason },
    });
  }
  if (result.reason === 'fingerprint-mismatch') {
    return failureResult('fingerprint-mismatch', {
      userMessage: "That doesn't match the code we're expecting.",
      instructions: 'Double-check the code in the browser extension popup, then try rebel_bridge_approve_pending again.',
      retryable: true,
      data: { routeReason: result.reason },
    });
  }
  if (result.reason === 'session-mismatch') {
    return failureResult('session-mismatch', {
      userMessage: 'That approval belongs to a different pairing session.',
      instructions: 'Start over with rebel_bridge_start_pairing.',
      retryable: false,
      data: { routeReason: result.reason },
    });
  }
  if (result.reason === 'session-unbound') {
    return failureResult('session-unbound', {
      userMessage: "There's no active pairing session to approve against.",
      instructions: 'Start with rebel_bridge_start_pairing first.',
      retryable: false,
      data: { routeReason: result.reason },
    });
  }
  return failureResult('internal-error', {
    userMessage: "That approval couldn't be completed.",
    instructions: 'Refresh the pending approvals and try again.',
    retryable: true,
    data: { routeReason: result.reason },
  });
}

function mapListPairedResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  return successResult({ paired: result.paired });
}

function mapEndPairSessionResult(result) {
  if (result.ok === false && typeof result.reason === 'string' && typeof result.retryable === 'boolean') {
    return result;
  }
  return successResult(result.data ?? {});
}

async function handleHostTool(toolName, input) {
  if (toolName === 'rebel_bridge_list_browsers') {
    try {
      const browsers = await detectBrowsers();
      const browsersWithFallback = [
        ...browsers.filter((browser) => browser.id !== NONE_OF_THE_ABOVE_BROWSER.id),
        NONE_OF_THE_ABOVE_BROWSER,
      ];
      return renderTextResult(
        successResult({ browsers: browsersWithFallback }),
      );
    } catch (error) {
      return renderTextResult(classifyHostError(error));
    }
  }
  if (toolName === 'rebel_bridge_prepare_install') {
    const validation = resolvePrepareBrowserId(input);
    if (!validation.ok) {
      return renderTextResult(validation.result);
    }
    return renderTextResult(
      mapPrepareInstallResult(await executeHostRoute('/host/prepare-install', {
        method: 'POST',
        timeoutMs: 45_000,
        body: {
          ...(validation.browserId ? { browserId: validation.browserId } : {}),
        },
      })),
    );
  }
  if (toolName === 'rebel_bridge_extract_extension') {
    const validation = validateBrowserId(input.browserId);
    if (!validation.ok) {
      return renderTextResult(validation.result);
    }
    return renderTextResult(
      mapExtractExtensionResult(await executeHostRoute('/host/extract-extension', {
        method: 'POST',
        body: { browserId: validation.browserId },
      })),
    );
  }
  if (toolName === 'rebel_bridge_reveal_extension_folder') {
    const validation = validateBrowserId(input.browserId);
    if (!validation.ok) {
      return renderTextResult(validation.result);
    }
    return renderTextResult(
      mapRevealExtensionResult(await executeHostRoute('/host/reveal-extension-folder', {
        method: 'POST',
        body: { browserId: validation.browserId },
      })),
    );
  }
  if (toolName === 'rebel_bridge_open_extensions_page') {
    const validation = validateBrowserId(input.browserId);
    if (!validation.ok) {
      return renderTextResult(validation.result);
    }
    return renderTextResult(
      mapOpenExtensionsPageResult(await executeHostRoute('/host/open-extensions-page', {
        method: 'POST',
        body: { browserId: validation.browserId },
      })),
    );
  }
  if (toolName === 'rebel_bridge_diagnose') {
    const validation = validateBrowserId(input.browserId);
    if (!validation.ok) {
      return renderTextResult(validation.result);
    }
    return renderTextResult(
      mapDiagnoseResult(await executeHostRoute('/host/diagnose', {
        method: 'POST',
        body: {
          browserId: validation.browserId,
          ...(typeof input.pairSessionId === 'string' ? { pairSessionId: input.pairSessionId } : {}),
        },
      })),
    );
  }
  throw new Error(`Unknown host tool: ${toolName}`);
}

module.exports = {
  BROWSER_DEFS,
  HOST_BROWSER_IDS,
  HOST_TOOL_REASON_VALUES,
  HOST_TOOLS,
  handleHostTool,
};
