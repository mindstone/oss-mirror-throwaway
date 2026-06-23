import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------- mutable state for electron mock ----------
let mockIsPackaged = true;
const mockShowErrorBox = vi.fn();
const mockExit = vi.fn();
const mockGetPath = vi.fn().mockReturnValue('/mock/appData');
const mockHasSwitch = vi.fn().mockReturnValue(false);

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return mockIsPackaged; },
    exit: (...args: unknown[]) => mockExit(...args),
    getPath: (...args: unknown[]) => mockGetPath(...args),
    commandLine: {
      hasSwitch: (...args: unknown[]) => mockHasSwitch(...args),
    },
  },
  dialog: {
    showErrorBox: (...args: unknown[]) => mockShowErrorBox(...args),
  },
}));

// ---------- @core/utils/nativeArch mock ----------
const mockGetNativeArch = vi.fn();
vi.mock('@core/utils/nativeArch', () => ({
  getNativeArch: (...args: unknown[]) => mockGetNativeArch(...args),
}));

// Save originals for restore
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalArgv = [...process.argv];

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function setArch(arch: string): void {
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

describe('ensureArchitectureMatch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Defaults: macOS, packaged, x64, native arm64 → mismatch scenario
    setPlatform('darwin');
    setArch('x64');
    mockIsPackaged = true;
    mockGetNativeArch.mockReturnValue('arm64');
    mockHasSwitch.mockReturnValue(false);
    delete process.env.REBEL_HEADLESS_CLI;
    delete process.env.REBEL_E2E_TEST_MODE;
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    setArch(originalArch);
    process.argv = [...originalArgv];
    delete process.env.REBEL_HEADLESS_CLI;
    delete process.env.REBEL_E2E_TEST_MODE;
  });

  it('shows dialog and exits when x64 on arm64 macOS (packaged)', async () => {
    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).toHaveBeenCalledOnce();
    expect(mockShowErrorBox).toHaveBeenCalledWith(
      'Wrong version for your Mac',
      expect.stringContaining('Intel version of Rebel'),
    );
    expect(mockShowErrorBox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('rebel.mindstone.com'),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('does NOT trigger when arm64 on arm64 macOS (native match)', async () => {
    setArch('arm64');
    mockGetNativeArch.mockReturnValue('arm64');

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('does NOT trigger when x64 on x64 macOS (native match)', async () => {
    setArch('x64');
    mockGetNativeArch.mockReturnValue('x64');

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('does NOT trigger on non-macOS (Windows)', async () => {
    setPlatform('win32');

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('does NOT trigger on non-macOS (Linux)', async () => {
    setPlatform('linux');

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('does NOT trigger when !app.isPackaged (dev mode)', async () => {
    mockIsPackaged = false;

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('does NOT trigger when REBEL_HEADLESS_CLI=1', async () => {
    process.env.REBEL_HEADLESS_CLI = '1';

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('does NOT trigger when REBEL_E2E_TEST_MODE=1', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('does NOT trigger when --headless-cli in argv', async () => {
    process.argv.push('--headless-cli');

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('STILL triggers when only app.commandLine.hasSwitch is true (the headless-cli switch belt was retired)', async () => {
    // Option B consolidation: ensureArchitectureMatch now uses the shared
    // isHeadlessCli() (env+argv) and no longer consults
    // app.commandLine.hasSwitch('headless-cli'). That belt only differed from
    // env/argv for a `--headless-cli=value` form that never enters CLI mode, so a
    // switch-only signal (no env, no argv) is no longer treated as headless — the
    // arch-mismatch check proceeds. This pins the single intended behavioural delta.
    mockHasSwitch.mockReturnValue(true);

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalled();
  });

  it('does NOT trigger when getNativeArch falls back to process.arch', async () => {
    // When os.machine() is unavailable, getNativeArch() falls back to process.arch,
    // so getNativeArch() returns 'x64' matching process.arch — no mismatch.
    setArch('x64');
    mockGetNativeArch.mockReturnValue('x64');

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('still exits even if dialog.showErrorBox throws', async () => {
    mockShowErrorBox.mockImplementation(() => {
      throw new Error('dialog unavailable');
    });

    const { ensureArchitectureMatch } = await import('../ensureArchitectureMatch');
    ensureArchitectureMatch();

    expect(mockShowErrorBox).toHaveBeenCalledOnce();
    // app.exit(1) should still be called via the finally block
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
