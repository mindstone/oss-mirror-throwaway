import * as path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import type { BrowserId } from '@shared/ipc/channels/appBridge';
import { assertNever } from '@shared/utils/assertNever';

export type { BrowserId } from '@shared/ipc/channels/appBridge';

export interface DetectedBrowser {
  id: BrowserId;
  displayName: string;
  installPath: string;
  binaryPath?: string;
  extensionsPageUrl: string;
}

export interface FsLike {
  access: (path: string) => Promise<void>;
}

export interface DetectOptions {
  platform: NodeJS.Platform;
  fs?: FsLike;
  signal?: AbortSignal;
}

type SupportedPlatform = Extract<NodeJS.Platform, 'darwin' | 'win32' | 'linux'>;

interface BrowserPlatformDef {
  installPaths: string[];
  binaryName?: string;
  bundleId?: string;
  userDataPath?: string;
}

interface BrowserDef {
  id: BrowserId;
  displayName: string;
  family: 'chromium';
  supportedOnPlatforms: SupportedPlatform[];
  extensionsSubpath: 'Extensions';
  extensionsPageUrl: string;
  platforms: Partial<Record<SupportedPlatform, BrowserPlatformDef>>;
}

export const BROWSER_DEFS: readonly BrowserDef[] = [
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
] as const;

const BROWSER_DEF_MAP = new Map<BrowserId, BrowserDef>(BROWSER_DEFS.map((browser) => [browser.id, browser]));

function buildDefaultWindowsInstallPaths(
  home: string,
  vendorSegments: string[],
  appSegments: string[] = ['Application'],
): string[] {
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

function getPlatformDef(platform: NodeJS.Platform, id: BrowserId): BrowserPlatformDef | undefined {
  const browser = BROWSER_DEF_MAP.get(id);
  if (!browser) {
    return undefined;
  }

  const typedPlatform = platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? platform
    : null;
  if (!typedPlatform || !browser.supportedOnPlatforms.includes(typedPlatform)) {
    return undefined;
  }

  const platformDef = browser.platforms[typedPlatform];
  if (!platformDef) {
    return undefined;
  }

  if (typedPlatform !== 'win32' || platformDef.installPaths.length > 0) {
    return platformDef;
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  switch (id) {
    case 'chrome':
      return {
        ...platformDef,
        installPaths: buildDefaultWindowsInstallPaths(home, ['Google', 'Chrome']),
      };
    case 'edge':
      return {
        ...platformDef,
        installPaths: buildDefaultWindowsInstallPaths(home, ['Microsoft', 'Edge']),
      };
    case 'brave':
      return {
        ...platformDef,
        installPaths: buildDefaultWindowsInstallPaths(home, ['BraveSoftware', 'Brave-Browser']),
      };
    case 'arc':
      return {
        ...platformDef,
        installPaths: [path.win32.join(process.env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Programs', 'Arc')],
      };
    case 'vivaldi':
      return {
        ...platformDef,
        installPaths: buildDefaultWindowsInstallPaths(home, ['Vivaldi']),
      };
    case 'opera':
      return {
        ...platformDef,
        installPaths: [
          path.win32.join(process.env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Programs', 'Opera'),
          path.win32.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Opera'),
        ],
      };
    case 'thorium':
      return {
        ...platformDef,
        installPaths: buildDefaultWindowsInstallPaths(home, ['Thorium']),
      };
    case 'yandex':
      return {
        ...platformDef,
        installPaths: buildDefaultWindowsInstallPaths(home, ['Yandex', 'YandexBrowser']),
      };
    case 'comet':
    case 'dia':
    case 'opera-gx':
    case 'sidekick':
    case 'none-of-the-above':
      return platformDef;
    default:
      return assertNever(id, 'BrowserId');
  }
}

function getCandidatePaths(platform: NodeJS.Platform, id: BrowserId): string[] {
  return [...(getPlatformDef(platform, id)?.installPaths ?? [])];
}

function getBinaryPath(platform: NodeJS.Platform, id: BrowserId, installPath: string): string | undefined {
  const platformDef = getPlatformDef(platform, id);
  if (!platformDef) {
    return undefined;
  }
  if (platform === 'linux') {
    return installPath;
  }
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

export async function detectBrowsers(opts: DetectOptions): Promise<DetectedBrowser[]> {
  const fs = opts.fs || nodeFs;
  const platform = opts.platform;
  const signal = opts.signal;
  
  const results: DetectedBrowser[] = [];
  const browserIds = BROWSER_DEFS
    .filter((browser) => browser.supportedOnPlatforms.includes(platform as SupportedPlatform))
    .map((browser) => browser.id);

  const checkBrowser = async (id: BrowserId): Promise<void> => {
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
      if (signal?.aborted) return;
      try {
        await fs.access(candidate);
        if (signal?.aborted) return;
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
  
  if (signal) {
    await Promise.race([
      checks,
      new Promise<void>(resolve => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }
      })
    ]);
  } else {
    await checks;
  }

  return results;
}
