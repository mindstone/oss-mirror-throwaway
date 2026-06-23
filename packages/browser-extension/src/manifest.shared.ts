export const localhostBridgePermissions = [
  'http://127.0.0.1:52320/*',
  'http://127.0.0.1:52321/*',
  'http://127.0.0.1:52322/*',
  'http://127.0.0.1:52323/*',
  'http://127.0.0.1:52324/*',
  'http://127.0.0.1:52325/*',
] as const;

export const sharedManifest = {
  manifest_version: 3,
  name: 'Rebel',
  short_name: 'Rebel',
  version: '0.1.0',
  description:
    'Connects your browser to the Rebel desktop app so it can read the active tab, quote selections, and fill in-page fields.',
  minimum_chrome_version: '116',
  action: {
    default_title: 'Rebel',
    default_icon: {
      16: 'icons/rebel-16.png',
      48: 'icons/rebel-48.png',
      128: 'icons/rebel-128.png',
    },
  },
  background: {
    service_worker: 'src/background/serviceWorker.ts',
    type: 'module',
  },
  permissions: [
    'storage',
    'offscreen',
    'alarms',
    'scripting',
    'activeTab',
    'tabs',
    'sidePanel',
    'favicon',
  ],
  optional_host_permissions: ['<all_urls>'],
  side_panel: {
    default_path: 'src/sidepanel/sidepanel.html',
  },
  host_permissions: localhostBridgePermissions,
  icons: {
    16: 'icons/rebel-16.png',
    48: 'icons/rebel-48.png',
    128: 'icons/rebel-128.png',
  },
} as const;
