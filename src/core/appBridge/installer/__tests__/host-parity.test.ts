import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BROWSER_DEFS as CORE_BROWSER_DEFS, detectBrowsers } from '../browserDetect';
import {
  HOST_TOOL_REASON_MANAGER_ONLY_VALUES as CORE_HOST_TOOL_REASON_MANAGER_ONLY_VALUES,
  HOST_TOOL_REASON_VALUES as CORE_HOST_TOOL_REASON_VALUES,
} from '../hostToolContracts';
import { HOST_CAPABILITY_KEYS } from '@core/appBridge/shared/protocol';
import { BrowserIdSchema } from '@shared/ipc/channels/appBridge';

// Resolve host.js relative to repo root so the test doesn't drift if paths move.
// host.js is a plain-JS port of browserDetect.ts used by the MCP subprocess.
const hostJsPath = path.resolve(
  __dirname,
  '../../../../../resources/mcp/rebel-app-bridge/tools/host.js'
);
const hostJs = require(hostJsPath);
const NONE_OF_THE_ABOVE_ID = 'none-of-the-above';

type BrowserDefLike = {
  id: string;
  displayName: string;
  family: string;
  supportedOnPlatforms: string[];
  extensionsSubpath: string;
  extensionsPageUrl: string;
  platforms: Record<string, { bundleId?: string; userDataPath?: string }>;
};

function canonicalizeBrowserDefs(browserDefs: readonly BrowserDefLike[]) {
  return [...browserDefs]
    .map((browser) => ({
      id: browser.id,
      displayName: browser.displayName,
      family: browser.family,
      supportedOnPlatforms: [...browser.supportedOnPlatforms].sort(),
      extensionsSubpath: browser.extensionsSubpath,
      extensionsPageUrl: browser.extensionsPageUrl,
      platforms: Object.fromEntries(
        Object.entries(browser.platforms)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([platform, platformDef]) => [
            platform,
            {
              bundleId: platformDef.bundleId ?? null,
              userDataPath: platformDef.userDataPath ?? null,
            },
          ]),
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function collectHostReasonLiterals(hostSource: string): Set<string> {
  const emittedReasonRegexes = [
    /reason:\s*['"]([^'"]+)['"]/g,
    /failureResult\(\s*['"]([^'"]+)['"]/g,
  ];
  const reasons = new Set<string>();

  for (const regex of emittedReasonRegexes) {
    for (const match of hostSource.matchAll(regex)) {
      const reason = match[1];
      if (reason) {
        reasons.add(reason);
      }
    }
  }

  return reasons;
}

describe('Browser Detection Parity (host.js vs browserDetect.ts)', () => {
  const platforms = ['darwin', 'win32', 'linux'] as const;

  for (const platform of platforms) {
    it(`should return identical results for ${platform}`, async () => {
      // Let's create a deterministic fake filesystem that claims all paths exist
      const mockFs = {
        access: async () => { return; }
      };

      // Since we want to test host.js, we need to monkey-patch process.platform and require's fs
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      
      // Setup mock
      Object.defineProperty(process, 'platform', { value: platform });
      const originalFsAccess = require('node:fs/promises').access;
      require('node:fs/promises').access = async () => { return; };

      try {
        // Run host.js
        const hostResult = await hostJs.handleHostTool('rebel_bridge_list_browsers', {});
        const hostBrowsers = JSON.parse(hostResult.content[0].text).data.browsers;
        expect(hostBrowsers.at(-1)).toMatchObject({
          id: NONE_OF_THE_ABOVE_ID,
          displayName: 'Something else...',
        });
        const hostDetectedBrowsers = hostBrowsers.filter(
          (browser: { id: string }) => browser.id !== NONE_OF_THE_ABOVE_ID,
        );

        // Run core browserDetect.ts
        const coreBrowsers = await detectBrowsers({ platform, fs: mockFs });
        expect(coreBrowsers.some((browser) => browser.id === NONE_OF_THE_ABOVE_ID)).toBe(false);

        // They should be identical
        expect(hostDetectedBrowsers).toEqual(coreBrowsers);
      } finally {
        // Restore
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform);
        }
        require('node:fs/promises').access = originalFsAccess;
      }
    });
  }
});

describe('Host tool contract parity', () => {
  it('collects host.js reason literals from both single and double quoted strings', () => {
    const sampleSource = `
      return { ok: false, reason: "open-failed" };
      return { ok: false, reason: 'timeout' };
      return failureResult("bridge-unreachable", {});
      return failureResult('invalid-browser-id', {});
    `;

    expect(collectHostReasonLiterals(sampleSource)).toEqual(
      new Set(['open-failed', 'timeout', 'bridge-unreachable', 'invalid-browser-id']),
    );
  });

  it('keeps the raw browser catalogue metadata aligned between core and host.js', () => {
    // TODO(install-resilience): generate the MCP catalogue from the core source of truth.
    expect(canonicalizeBrowserDefs(hostJs.BROWSER_DEFS)).toEqual(
      canonicalizeBrowserDefs(CORE_BROWSER_DEFS),
    );
  });

  it('keeps host.js browser ids aligned with BrowserIdSchema', () => {
    expect(hostJs.HOST_BROWSER_IDS).toEqual(BrowserIdSchema.options);
  });

  it('keeps host tool capabilities aligned with HOST_CAPABILITY_KEYS', () => {
    const hostCapabilities = hostJs.HOST_TOOLS.map((tool: { capability: string }) => tool.capability);
    expect(hostCapabilities.sort()).toEqual([...HOST_CAPABILITY_KEYS].sort());
  });

  it('keeps host.js reason strings inside the HostToolReason union', () => {
    const hostReasons = new Set(hostJs.HOST_TOOL_REASON_VALUES);
    const coreReasons = new Set<string>(CORE_HOST_TOOL_REASON_VALUES);

    for (const reason of hostReasons as Set<string>) {
      expect(coreReasons.has(reason)).toBe(true);
    }
  });

  it('keeps host.js failureResult literals inside the HostToolReason union', () => {
    const coreReasons = new Set<string>(CORE_HOST_TOOL_REASON_VALUES);
    const hostJsSource = fs.readFileSync(hostJsPath, 'utf8');
    const reasonRegex = /failureResult\(\s*['"]([^'"]+)['"]/g;
    const capturedReasons = Array.from(
      hostJsSource.matchAll(reasonRegex),
      (match: RegExpMatchArray) => match[1] ?? '',
    );

    for (const reason of capturedReasons) {
      expect(coreReasons.has(reason)).toBe(true);
    }
  });

  it('keeps emitted host.js reason literals aligned with HostToolReason coverage', () => {
    const coreReasons = new Set<string>(CORE_HOST_TOOL_REASON_VALUES);
    const managerOnlyReasons = new Set<string>(CORE_HOST_TOOL_REASON_MANAGER_ONLY_VALUES);
    const hostReasonLiterals = collectHostReasonLiterals(fs.readFileSync(hostJsPath, 'utf8'));

    for (const reason of hostReasonLiterals) {
      expect(coreReasons.has(reason)).toBe(true);
    }

    for (const reason of coreReasons) {
      if (managerOnlyReasons.has(reason)) {
        continue;
      }
      expect(hostReasonLiterals.has(reason)).toBe(true);
    }
  });
});
