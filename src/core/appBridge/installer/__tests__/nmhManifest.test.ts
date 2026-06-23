import { describe, expect, it } from 'vitest';

import { buildNmhManifests, type ManifestTarget } from '../nmhManifest';

const ALL_BROWSERS: ManifestTarget[] = ['chrome', 'edge', 'brave', 'arc', 'vivaldi', 'opera'];
const EXTENSION_IDS = ['abcdefghijklmnopabcdefghijklmnop', 'ponmlkjihgfedcbaponmlkjihgfedcba'];

function makeDetectedBrowsers(ids: readonly ManifestTarget[]) {
  return ids.map((id) => ({
    id,
    displayName: id.toUpperCase(),
    installPath: `/Applications/${id}`,
  }));
}

describe('buildNmhManifests', () => {
  it.each([
    [
      'darwin',
      '/Users/test',
      {
        chrome:
          '/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        edge:
          '/Users/test/Library/Application Support/Microsoft Edge/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        brave:
          '/Users/test/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        arc:
          '/Users/test/Library/Application Support/Arc/User Data/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        vivaldi:
          '/Users/test/Library/Application Support/Vivaldi/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        opera:
          '/Users/test/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts/ai.rebel.browser_bridge.json',
      },
    ],
    [
      'linux',
      '/home/test',
      {
        chrome:
          '/home/test/.config/google-chrome/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        edge:
          '/home/test/.config/microsoft-edge/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        brave:
          '/home/test/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        arc:
          '/home/test/.config/Arc/User Data/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        vivaldi:
          '/home/test/.config/vivaldi/NativeMessagingHosts/ai.rebel.browser_bridge.json',
        opera:
          '/home/test/.config/opera/NativeMessagingHosts/ai.rebel.browser_bridge.json',
      },
    ],
    [
      'win32',
      'C:\\Users\\Test',
      {
        chrome:
          'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\User Data\\NativeMessagingHosts\\ai.rebel.browser_bridge.json',
        edge:
          'C:\\Users\\Test\\AppData\\Local\\Microsoft\\Edge\\User Data\\NativeMessagingHosts\\ai.rebel.browser_bridge.json',
        brave:
          'C:\\Users\\Test\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\NativeMessagingHosts\\ai.rebel.browser_bridge.json',
        arc:
          'C:\\Users\\Test\\AppData\\Local\\Arc\\User Data\\NativeMessagingHosts\\ai.rebel.browser_bridge.json',
        vivaldi:
          'C:\\Users\\Test\\AppData\\Local\\Vivaldi\\User Data\\NativeMessagingHosts\\ai.rebel.browser_bridge.json',
        opera:
          'C:\\Users\\Test\\AppData\\Local\\Opera Software\\Opera Stable\\NativeMessagingHosts\\ai.rebel.browser_bridge.json',
      },
    ],
  ] as const)('builds %s manifest paths for every supported browser', (platform, homeDir, expectedPaths) => {
    const manifests = buildNmhManifests({
      platform,
      homeDir,
      userDataDir: platform === 'win32'
        ? 'C:\\Users\\Test\\AppData\\Roaming\\Mindstone Rebel'
        : `${homeDir}/Library/Application Support/Mindstone Rebel`,
      detectedBrowsers: makeDetectedBrowsers(ALL_BROWSERS),
      relayBinaryPath: platform === 'win32'
        ? 'C:\\relay\\relay.exe'
        : '/opt/rebel/relay',
      allowedExtensionIds: EXTENSION_IDS,
    });

    expect(manifests).toHaveLength(ALL_BROWSERS.length);
    expect(Object.fromEntries(manifests.map((manifest) => [manifest.browserId, manifest.manifestPath]))).toEqual(
      expectedPaths,
    );
  });

  it('formats allowed_origins from extension ids', () => {
    const [manifest] = buildNmhManifests({
      platform: 'darwin',
      homeDir: '/Users/test',
      userDataDir: '/Users/test/Library/Application Support/Mindstone Rebel',
      detectedBrowsers: makeDetectedBrowsers(['chrome']),
      relayBinaryPath: '/opt/rebel/relay',
      allowedExtensionIds: EXTENSION_IDS,
    });

    expect(JSON.parse(manifest.manifestContent)).toEqual({
      name: 'ai.rebel.browser_bridge',
      description: 'Rebel Browser relay bridge (latent)',
      path: '/opt/rebel/relay',
      type: 'stdio',
      allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
    });
    expect(manifest.allowedExtensionIds).toEqual(EXTENSION_IDS);
  });

  it('uses the default placeholder relay path when none is provided', () => {
    const [manifest] = buildNmhManifests({
      platform: 'darwin',
      homeDir: '/Users/test',
      userDataDir: '/Users/test/Library/Application Support/Mindstone Rebel',
      detectedBrowsers: makeDetectedBrowsers(['chrome']),
      allowedExtensionIds: EXTENSION_IDS,
    });

    expect(manifest.relayBinaryPath).toBe(
      '/Users/test/Library/Application Support/Mindstone Rebel/rebel-browser-relay/relay',
    );
    expect(JSON.parse(manifest.manifestContent).path).toBe(manifest.relayBinaryPath);
  });

  it('returns no manifests for browsers that were not detected', () => {
    const manifests = buildNmhManifests({
      platform: 'darwin',
      homeDir: '/Users/test',
      userDataDir: '/Users/test/Library/Application Support/Mindstone Rebel',
      detectedBrowsers: makeDetectedBrowsers(['chrome', 'brave']),
      allowedExtensionIds: EXTENSION_IDS,
    });

    expect(manifests.map((manifest) => manifest.browserId)).toEqual(['chrome', 'brave']);
  });

  it('is deterministic for duplicate browser detections', () => {
    const manifests = buildNmhManifests({
      platform: 'darwin',
      homeDir: '/Users/test',
      userDataDir: '/Users/test/Library/Application Support/Mindstone Rebel',
      detectedBrowsers: [
        ...makeDetectedBrowsers(['chrome']),
        ...makeDetectedBrowsers(['chrome']),
      ],
      allowedExtensionIds: [EXTENSION_IDS[0], EXTENSION_IDS[0]],
    });

    expect(manifests).toHaveLength(1);
    expect(manifests[0].allowedExtensionIds).toEqual([EXTENSION_IDS[0]]);
    expect(JSON.parse(manifests[0].manifestContent).allowed_origins).toEqual([
      `chrome-extension://${EXTENSION_IDS[0]}/`,
    ]);
  });
});
