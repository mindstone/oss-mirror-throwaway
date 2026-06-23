import { describe, it, expect, beforeEach } from 'vitest';
import type { PlatformConfig, SurfaceCapabilities } from '@core/platform';
import { defaultCapabilities } from '@core/platform';

// Re-import the module fresh each test to reset the singleton
let setPlatformConfig: typeof import('@core/platform').setPlatformConfig;
let getPlatformConfig: typeof import('@core/platform').getPlatformConfig;

const makeMockConfig = (overrides: Partial<PlatformConfig> = {}): PlatformConfig => ({
  userDataPath: '/mock/userData',
  appPath: '/mock/app',
  tempPath: '/mock/temp',
  logsPath: '/mock/logs',
  homePath: '/mock/home',
  documentsPath: '/mock/documents',
  desktopPath: '/mock/desktop',
  appDataPath: '/mock/appData',
  version: '1.0.0',
  isPackaged: false,
  platform: 'darwin',
  totalMemoryBytes: 36 * 1024 * 1024 * 1024,
  arch: 'arm64',
  surface: 'desktop',
  isOss: false,
  capabilities: defaultCapabilities('desktop'),
  ...overrides,
});

describe('PlatformConfig', () => {
  beforeEach(async () => {
    // Re-import to reset the module-level singleton
    vi.resetModules();
    const mod = await import('@core/platform');
    setPlatformConfig = mod.setPlatformConfig;
    getPlatformConfig = mod.getPlatformConfig;
  });

  it('throws before initialization', () => {
    expect(() => getPlatformConfig()).toThrow(
      'PlatformConfig not initialized',
    );
  });

  it('returns the config after setPlatformConfig', () => {
    const config = makeMockConfig();
    setPlatformConfig(config);
    expect(getPlatformConfig()).toBe(config);
  });

  it('updates the config on a second set', () => {
    const first = makeMockConfig({ version: '1.0.0' });
    const second = makeMockConfig({ version: '2.0.0' });

    setPlatformConfig(first);
    expect(getPlatformConfig().version).toBe('1.0.0');

    setPlatformConfig(second);
    expect(getPlatformConfig().version).toBe('2.0.0');
    expect(getPlatformConfig()).toBe(second);
  });
});

describe('defaultCapabilities', () => {
  it('returns the exact 4-flag manifest for desktop', () => {
    expect(defaultCapabilities('desktop')).toEqual({
      appBridgeServer: true,
      officeSidecar: true,
      localFilesystemAccess: true,
      localSubprocessSpawn: true,
    } satisfies SurfaceCapabilities);
  });

  it('returns the exact 4-flag manifest for cloud', () => {
    expect(defaultCapabilities('cloud')).toEqual({
      appBridgeServer: false,
      officeSidecar: false,
      localFilesystemAccess: false,
      localSubprocessSpawn: true,
    } satisfies SurfaceCapabilities);
  });

  it('returns the exact 4-flag manifest for cli', () => {
    expect(defaultCapabilities('cli')).toEqual({
      appBridgeServer: false,
      officeSidecar: false,
      localFilesystemAccess: true,
      localSubprocessSpawn: true,
    } satisfies SurfaceCapabilities);
  });

  it('returns the exact 4-flag manifest for mobile', () => {
    expect(defaultCapabilities('mobile')).toEqual({
      appBridgeServer: false,
      officeSidecar: false,
      localFilesystemAccess: false,
      localSubprocessSpawn: false,
    } satisfies SurfaceCapabilities);
  });
});

describe('setPlatformConfig capabilities handling', () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/platform');
    setPlatformConfig = mod.setPlatformConfig;
    getPlatformConfig = mod.getPlatformConfig;
  });

  it('preserves input identity when capabilities is supplied explicitly', () => {
    const config = makeMockConfig();
    setPlatformConfig(config);
    expect(getPlatformConfig()).toBe(config);
  });

  it('stores explicit capabilities verbatim', () => {
    const customCaps: SurfaceCapabilities = {
      appBridgeServer: false,
      officeSidecar: false,
      localFilesystemAccess: true,
      localSubprocessSpawn: false,
    };
    const config = makeMockConfig({ capabilities: customCaps });
    setPlatformConfig(config);
    expect(getPlatformConfig().capabilities).toBe(customCaps);
  });

  it('auto-derives capabilities from surface when omitted (cloud)', () => {
    // Build a PlatformConfigInput-shaped object without `capabilities`.
    const base = makeMockConfig({ surface: 'cloud' });
    const { capabilities: _omit, ...inputWithoutCaps } = base;
    setPlatformConfig(inputWithoutCaps);
    expect(getPlatformConfig().capabilities).toEqual(defaultCapabilities('cloud'));
  });

  it('auto-derives capabilities from surface when omitted (mobile)', () => {
    const base = makeMockConfig({ surface: 'mobile' });
    const { capabilities: _omit, ...inputWithoutCaps } = base;
    setPlatformConfig(inputWithoutCaps);
    expect(getPlatformConfig().capabilities).toEqual(defaultCapabilities('mobile'));
  });

  it('auto-derives capabilities from surface when omitted (cli)', () => {
    const base = makeMockConfig({ surface: 'cli' });
    const { capabilities: _omit, ...inputWithoutCaps } = base;
    setPlatformConfig(inputWithoutCaps);
    expect(getPlatformConfig().capabilities).toEqual(defaultCapabilities('cli'));
  });

  it('auto-derives capabilities from surface when omitted (desktop)', () => {
    const base = makeMockConfig({ surface: 'desktop' });
    const { capabilities: _omit, ...inputWithoutCaps } = base;
    setPlatformConfig(inputWithoutCaps);
    expect(getPlatformConfig().capabilities).toEqual(defaultCapabilities('desktop'));
  });
});

describe('PlatformConfig.isOss (Stage 1 cross-surface seam)', () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/platform');
    setPlatformConfig = mod.setPlatformConfig;
    getPlatformConfig = mod.getPlatformConfig;
  });

  it('is required and round-trips verbatim (false)', () => {
    setPlatformConfig(makeMockConfig({ isOss: false }));
    expect(getPlatformConfig().isOss).toBe(false);
  });

  it('is required and round-trips verbatim (true)', () => {
    setPlatformConfig(makeMockConfig({ isOss: true }));
    expect(getPlatformConfig().isOss).toBe(true);
  });

  it('is NOT auto-derived from surface (unlike capabilities) — caller intent wins', () => {
    // A cloud surface that (hypothetically) declared isOss:true keeps it; the
    // seam never infers isOss from `surface`. This guards the invariant that
    // each bootstrap supplies isOss explicitly.
    setPlatformConfig(makeMockConfig({ surface: 'cloud', isOss: true }));
    expect(getPlatformConfig().isOss).toBe(true);
  });

  it('adding isOss does not perturb capability auto-derivation', () => {
    const base = makeMockConfig({ surface: 'cloud', isOss: true });
    const { capabilities: _omit, ...inputWithoutCaps } = base;
    setPlatformConfig(inputWithoutCaps);
    // capabilities still surface-derived; isOss still honoured.
    expect(getPlatformConfig().capabilities).toEqual(defaultCapabilities('cloud'));
    expect(getPlatformConfig().isOss).toBe(true);
  });
});

describe('desktop isOss derivation contract (keystone)', () => {
  // The desktop bootstrap (src/main/bootstrap.ts) maps the build-mode signal:
  //   isOss: PRIVATE_MINDSTONE_BOOTSTRAP_MODE === 'stub'
  // This asserts the mapping logic and the round-trip for both modes. The
  // mapping is verified against the REAL @private/mindstone/mode module in the
  // main-boundary test (src/main/oss/private-mindstone-stub/__tests__/
  // modePurity.test.ts) — core may not import the main-only @private alias
  // (eslint no-restricted-syntax boundary), so the source-signal leg lives
  // there.
  it.each([
    ['stub', true],
    ['real', false],
  ] as const)('mode %s maps to isOss=%s and round-trips', (mode, expected) => {
    const isOss = mode === 'stub';
    expect(isOss).toBe(expected);
    setPlatformConfig(makeMockConfig({ surface: 'desktop', isOss }));
    expect(getPlatformConfig().isOss).toBe(expected);
  });

  it('cloud bootstrap pins isOss to false (enterprise infra)', () => {
    setPlatformConfig(makeMockConfig({ surface: 'cloud', isOss: false }));
    expect(getPlatformConfig().isOss).toBe(false);
  });
});
