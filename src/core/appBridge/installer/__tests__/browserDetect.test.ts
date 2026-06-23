import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BROWSER_DEFS, detectBrowsers, FsLike } from '../browserDetect';

describe('browserDetect', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('detects all present browsers on macOS and populates binaryPath', async () => {
    const fs: FsLike = {
      access: async (p) => {
        if (p === '/Applications/Google Chrome.app' || p === '/Applications/Arc.app') {
          return;
        }
        throw new Error('ENOENT');
      }
    };
    const res = await detectBrowsers({ platform: 'darwin', fs });
    expect(res).toHaveLength(2);
    expect(res.map(b => b.id)).toEqual(expect.arrayContaining(['chrome', 'arc']));
    
    const chrome = res.find(b => b.id === 'chrome');
    expect(chrome?.binaryPath).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(chrome?.extensionsPageUrl).toBe('chrome://extensions');
    
    const arc = res.find(b => b.id === 'arc');
    expect(arc?.binaryPath).toBe('/Applications/Arc.app/Contents/MacOS/Arc');
  });

  it('detects Windows Edge in Program Files and populates binaryPath', async () => {
    const fs: FsLike = {
      access: async (p) => {
        if (p.includes('Microsoft\\Edge\\Application')) {
          return;
        }
        throw new Error('ENOENT');
      }
    };
    const res = await detectBrowsers({ platform: 'win32', fs });
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('edge');
    expect(res[0].installPath).toContain('Microsoft\\Edge\\Application');
    expect(res[0].binaryPath).toContain('msedge.exe');
    expect(res[0].extensionsPageUrl).toBe('edge://extensions');
  });

  it('detects Linux browsers and populates binaryPath', async () => {
    const fs: FsLike = {
      access: async (p) => {
        if (p === '/usr/bin/google-chrome' || p === '/snap/bin/brave') {
          return;
        }
        throw new Error('ENOENT');
      }
    };
    const res = await detectBrowsers({ platform: 'linux', fs });
    expect(res).toHaveLength(2);
    expect(res.map(b => b.id)).toEqual(expect.arrayContaining(['chrome', 'brave']));
    
    const chrome = res.find(b => b.id === 'chrome');
    expect(chrome?.binaryPath).toBe('/usr/bin/google-chrome');
    
    const brave = res.find(b => b.id === 'brave');
    expect(brave?.binaryPath).toBe('/snap/bin/brave');
    expect(brave?.extensionsPageUrl).toBe('brave://extensions');
  });

  it.each([
    ['comet', 'darwin', '/Applications/Comet.app', '/Applications/Comet.app/Contents/MacOS/Comet'],
    ['dia', 'darwin', '/Applications/Dia.app', '/Applications/Dia.app/Contents/MacOS/Dia'],
    ['thorium', 'linux', '/usr/bin/thorium-browser', '/usr/bin/thorium-browser'],
    ['yandex', 'darwin', '/Applications/Yandex.app', '/Applications/Yandex.app/Contents/MacOS/Yandex'],
    ['opera-gx', 'darwin', '/Applications/Opera GX.app', '/Applications/Opera GX.app/Contents/MacOS/Opera GX'],
    ['sidekick', 'darwin', '/Applications/Sidekick.app', '/Applications/Sidekick.app/Contents/MacOS/Sidekick'],
  ] as const)(
    'detects %s on %s and keeps its catalogue metadata populated',
    async (browserId, platform, fixturePath, expectedBinaryPath) => {
      const fs: FsLike = {
        access: async (p) => {
          if (p === fixturePath) {
            return;
          }
          throw new Error('ENOENT');
        },
      };

      const res = await detectBrowsers({ platform, fs });
      expect(res).toHaveLength(1);
      expect(res[0]).toMatchObject({
        id: browserId,
        installPath: fixturePath,
        binaryPath: expectedBinaryPath,
      });

      const browserDef = BROWSER_DEFS.find((browser) => browser.id === browserId);
      expect(browserDef?.displayName).toBe(res[0].displayName);
      expect(browserDef?.supportedOnPlatforms.length).toBeGreaterThan(0);
    },
  );

  it('parses Windows extra paths with split-on-first colon', async () => {
    process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS = 'chrome:C:\\My Chrome\\chrome.exe';
    
    const fs: FsLike = {
      access: async (p) => {
        if (p === 'C:\\My Chrome\\chrome.exe') {
          return;
        }
        throw new Error('ENOENT');
      }
    };
    const res = await detectBrowsers({ platform: 'win32', fs });
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('chrome');
    expect(res[0].installPath).toBe('C:\\My Chrome\\chrome.exe');
    expect(res[0].binaryPath).toBe('C:\\My Chrome\\chrome.exe\\chrome.exe'); // Extra path gets .exe appended
  });

  it('detects nothing if no browsers present', async () => {
    const fs: FsLike = {
      access: async () => { throw new Error('ENOENT'); }
    };
    const res = await detectBrowsers({ platform: 'win32', fs });
    expect(res).toHaveLength(0);
  });

  it('returns empty array for unknown platform', async () => {
    const fs: FsLike = {
      access: async () => {} // everything exists
    };
    const res = await detectBrowsers({ platform: 'freebsd' as any, fs });
    expect(res).toHaveLength(0);
  });

  it('returns partially completed if slow disk / AbortSignal fires', async () => {
    const ac = new AbortController();
    const fs: FsLike = {
      access: async (p) => {
        if (p.includes('Google')) {
          return; // chrome finishes fast
        }
        // others hang
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
      }
    };
    
    setTimeout(() => ac.abort(), 50);
    const res = await detectBrowsers({ platform: 'win32', fs, signal: ac.signal });
    expect(res.map(b => b.id)).toEqual(['chrome']);
  });

  it('never returns the none-of-the-above sentinel', async () => {
    const fs: FsLike = {
      access: async () => {
        return;
      },
    };

    const res = await detectBrowsers({ platform: 'darwin', fs });
    expect(res.some((browser) => browser.id === 'none-of-the-above')).toBe(false);
  });
});
