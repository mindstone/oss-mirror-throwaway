// Pre-install globals that Expo's winter runtime lazily initializes via require(),
// which can fail in Jest's module sandbox. By defining them as non-configurable,
// Expo's installGlobal() will skip overwriting them (it checks configurable).
//
// This must run BEFORE jest-expo's setup file which triggers the winter runtime.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function realpathBestEffort(input) {
  const expanded = input === '~'
    ? os.homedir()
    : input.replace(/^~[/\\]/, `${os.homedir()}${path.sep}`);
  const resolved = path.resolve(expanded);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const parts = resolved.split(path.sep).filter(Boolean);
    const root = path.parse(resolved).root;
    for (let index = parts.length; index >= 0; index -= 1) {
      const ancestor = path.join(root, ...parts.slice(0, index));
      try {
        return path.join(fs.realpathSync.native(ancestor), ...parts.slice(index));
      } catch {
        // Keep walking up.
      }
    }
    return resolved;
  }
}

function isSameOrInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return candidate === root || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertMobileTestDataRootSafe() {
  if (!process.env.REBEL_USER_DATA) {
    process.env.REBEL_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-mobile-jest-user-data-'));
  }

  const dataRoot = realpathBestEffort(process.env.REBEL_USER_DATA);
  const home = realpathBestEffort(os.homedir());
  const unsafeDesktopRoots = [
    path.join(home, 'Library', 'Application Support', 'mindstone-rebel'),
    path.join(home, '.config', 'mindstone-rebel'),
    path.join(home, 'AppData', 'Roaming', 'mindstone-rebel'),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'mindstone-rebel')] : []),
  ].map(realpathBestEffort);
  const allowedRoots = [
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
    path.resolve(__dirname, '..', 'tmp'),
  ].map(realpathBestEffort);

  const unsafe =
    dataRoot === realpathBestEffort('/data') ||
    dataRoot === home ||
    path.dirname(dataRoot) === home ||
    unsafeDesktopRoots.includes(dataRoot) ||
    !allowedRoots.some((root) => isSameOrInside(dataRoot, root));

  if (unsafe) {
    throw new Error(
      `mobile Jest REBEL_USER_DATA is unsafe for test isolation: ${process.env.REBEL_USER_DATA}. ` +
      'Set REBEL_USER_DATA to a temporary directory.',
    );
  }
}

assertMobileTestDataRootSafe();

function lockGlobal(name, value) {
  // Pre-install globals used by Expo's winter runtime.
  // Expo defines these as lazy getters that `require()` files during access.
  // In Jest, those lazy requires can trigger "import outside of scope" errors.
  // By defining a non-configurable value first, Expo's installGlobal() will log
  // (best-effort) and continue, but it won't overwrite with the lazy getter.
  const existing = Object.getOwnPropertyDescriptor(globalThis, name);
  if (existing && existing.configurable === false) return;

  try {
    // Delete existing property first (if configurable), then redefine as non-configurable
    // so Expo can't replace it with a lazy getter.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete globalThis[name];
  } catch {
    // Property might not be configurable — that's fine
  }

  Object.defineProperty(globalThis, name, {
    value,
    configurable: false,
    enumerable: true,
    writable: false,
  });
}

lockGlobal('__ExpoImportMetaRegistry', { url: null });

// structuredClone — use Node.js native if available, otherwise polyfill
const sc = typeof structuredClone === 'function'
  ? structuredClone
  : require('@ungap/structured-clone').default;
lockGlobal('structuredClone', sc);

// AsyncStorage native module is not available in Jest.
// Use the official mock so modules that import it don't crash.
jest.mock(
  '@react-native-async-storage/async-storage',
  () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Navigation hooks throw outside a NavigationContainer. Mock them globally
// so component-level tests can render without a full navigation stack.
// When adding new @react-navigation/* hooks to tested components, add mocks here.
jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));

jest.mock('@react-navigation/elements', () => ({
  useHeaderHeight: () => 0,
}));

// NetInfo native module is not available in Jest.
// Mock globally so components using useNetworkState don't crash.
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn().mockResolvedValue({ isConnected: true, isInternetReachable: true }),
}));

// RudderStack RN SDK ships as native ESM backed by a TurboModule bridge that is
// not available in Jest. The analytics singleton (`src/analytics/analytics.ts`)
// is now imported transitively by screens (PairScreen, inbox, conversation) and
// _layout via the typed taxonomy, so any component-mount / module-load test
// would otherwise crash on the SDK's ESM `import`. Mock it globally as inert
// no-ops. Tests that assert SDK interaction (analytics.test.ts) provide their
// own `jest.mock(...)`, which overrides this default.
jest.mock('@rudderstack/rudder-sdk-react-native', () => ({
  __esModule: true,
  default: {
    setup: jest.fn().mockResolvedValue(undefined),
    track: jest.fn().mockResolvedValue(undefined),
    identify: jest.fn().mockResolvedValue(undefined),
    screen: jest.fn().mockResolvedValue(undefined),
    flush: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
    putAnonymousId: jest.fn().mockResolvedValue(undefined),
    setAnonymousId: jest.fn().mockResolvedValue(undefined),
  },
}));
