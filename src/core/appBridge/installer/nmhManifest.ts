import * as path from 'node:path';

export type ManifestTarget = 'chrome' | 'edge' | 'brave' | 'arc' | 'vivaldi' | 'opera';

export interface ManifestFile {
  browserId: string;
  nmhName: string;
  manifestPath: string;
  manifestContent: string;
  relayBinaryPath: string;
  allowedExtensionIds: string[];
}

const NMH_NAME = 'ai.rebel.browser_bridge';
const NMH_DESCRIPTION = 'Rebel Browser relay bridge (latent)';
const MANIFEST_FILE_NAME = `${NMH_NAME}.json`;

function getPathModule(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function getManifestDirectory(
  platform: NodeJS.Platform,
  homeDir: string,
  browserId: ManifestTarget,
): string {
  const pathMod = getPathModule(platform);

  if (platform === 'darwin') {
    const base = path.posix.join(homeDir, 'Library', 'Application Support');
    switch (browserId) {
      case 'chrome':
        return path.posix.join(base, 'Google', 'Chrome', 'NativeMessagingHosts');
      case 'edge':
        return path.posix.join(base, 'Microsoft Edge', 'NativeMessagingHosts');
      case 'brave':
        return path.posix.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts');
      case 'arc':
        return path.posix.join(base, 'Arc', 'User Data', 'NativeMessagingHosts');
      case 'vivaldi':
        return path.posix.join(base, 'Vivaldi', 'NativeMessagingHosts');
      case 'opera':
        return path.posix.join(base, 'com.operasoftware.Opera', 'NativeMessagingHosts');
    }
  }

  if (platform === 'linux') {
    const base = path.posix.join(homeDir, '.config');
    switch (browserId) {
      case 'chrome':
        return path.posix.join(base, 'google-chrome', 'NativeMessagingHosts');
      case 'edge':
        return path.posix.join(base, 'microsoft-edge', 'NativeMessagingHosts');
      case 'brave':
        return path.posix.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts');
      case 'arc':
        return path.posix.join(base, 'Arc', 'User Data', 'NativeMessagingHosts');
      case 'vivaldi':
        return path.posix.join(base, 'vivaldi', 'NativeMessagingHosts');
      case 'opera':
        return path.posix.join(base, 'opera', 'NativeMessagingHosts');
    }
  }

  const base = pathMod.join(homeDir, 'AppData', 'Local');
  switch (browserId) {
    case 'chrome':
      return path.win32.join(base, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');
    case 'edge':
      return path.win32.join(base, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts');
    case 'brave':
      return path.win32.join(base, 'BraveSoftware', 'Brave-Browser', 'User Data', 'NativeMessagingHosts');
    case 'arc':
      return path.win32.join(base, 'Arc', 'User Data', 'NativeMessagingHosts');
    case 'vivaldi':
      return path.win32.join(base, 'Vivaldi', 'User Data', 'NativeMessagingHosts');
    case 'opera':
      return path.win32.join(base, 'Opera Software', 'Opera Stable', 'NativeMessagingHosts');
  }
}

export function buildNmhManifests(params: {
  platform: NodeJS.Platform;
  homeDir: string;
  userDataDir: string;
  detectedBrowsers: Array<{ id: string; displayName: string; installPath: string }>;
  relayBinaryPath?: string;
  allowedExtensionIds: string[];
}): ManifestFile[] {
  const pathMod = getPathModule(params.platform);
  const relayBinaryPath =
    params.relayBinaryPath ?? pathMod.join(params.userDataDir, 'rebel-browser-relay', 'relay');
  const allowedExtensionIds = [...new Set(params.allowedExtensionIds)];
  const seenBrowserIds = new Set<string>();
  const manifests: ManifestFile[] = [];

  // TODO(Chunk C follow-up): Windows activation also needs HKCU registry entries
  // pointing at these JSON files. This latent chunk intentionally writes only
  // the manifest files so the relay binary + registry work can land later.
  for (const browser of params.detectedBrowsers) {
    if (seenBrowserIds.has(browser.id)) {
      continue;
    }
    seenBrowserIds.add(browser.id);

    if (!['chrome', 'edge', 'brave', 'arc', 'vivaldi', 'opera'].includes(browser.id)) {
      continue;
    }

    const browserId = browser.id as ManifestTarget;
    const manifestPath = pathMod.join(
      getManifestDirectory(params.platform, params.homeDir, browserId),
      MANIFEST_FILE_NAME,
    );
    const manifestContent = JSON.stringify(
      {
        name: NMH_NAME,
        description: NMH_DESCRIPTION,
        path: relayBinaryPath,
        type: 'stdio',
        allowed_origins: allowedExtensionIds.map((id) => `chrome-extension://${id}/`),
      },
      null,
      2,
    );

    manifests.push({
      browserId,
      nmhName: NMH_NAME,
      manifestPath,
      manifestContent,
      relayBinaryPath,
      allowedExtensionIds,
    });
  }

  return manifests;
}
