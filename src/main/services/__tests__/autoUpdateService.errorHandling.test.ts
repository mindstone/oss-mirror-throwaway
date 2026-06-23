import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appGetVersion: vi.fn(() => '0.4.45'),
  captureMessage: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.appGetVersion(),
    getPath: () => '/tmp/test-userdata',
    getName: () => 'Test',
    getBundleId: () => 'com.mindstone.rebel.test',
    isPackaged: false,
    once: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    releaseSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    exit: vi.fn(),
    commandLine: { hasSwitch: () => false },
  },
  autoUpdater: {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() })),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn().mockRejectedValue(new Error('no readFile in tests')),
    readdir: vi.fn().mockResolvedValue([]),
    rm: vi.fn(),
    stat: vi.fn().mockRejectedValue(new Error('no stat in tests')),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    constants: { R_OK: 4, W_OK: 2 },
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: mocks.captureMessage,
  }),
}));

vi.mock('@core/logger', () => {
  const noop = {
    debug: vi.fn(),
    error: vi.fn(),
    flush: (cb?: () => void) => cb?.(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { createScopedLogger: () => noop, logger: noop };
});

vi.mock('../../analytics', () => ({
  getOrGenerateAnonymousId: vi.fn(() => 'anon-id'),
  trackMainEvent: vi.fn(),
}));

vi.mock('../updateNotificationState', () => ({
  acknowledgeDownloadedUpdate: vi.fn(),
  clearPendingDownloadedUpdate: vi.fn(),
  getPendingDownloadedUpdate: vi.fn(() => null),
  getPendingDownloadedUpdateForRenderer: vi.fn(() => null),
  getUpdatePrimaryWindow: () => null,
  setPendingDownloadedUpdate: vi.fn(),
  setUpdateMainWindowGetter: vi.fn(),
}));

vi.mock('../updateInstallMarker', () => ({
  clearUpdateInstallMarker: vi.fn(),
  getUpdateInstallMarker: vi.fn(),
  markUpdateInstallRequested: vi.fn(),
}));

vi.mock('../autoUpdateStateStore', () => ({
  getAutoUpdateState: () => ({ recoveryAttempts: {} }),
  updateAutoUpdateState: vi.fn(),
  updateAutoUpdateStateChecked: vi.fn(() => ({ ok: true })),
}));

vi.mock('../gracefulShutdown', () => ({
  clearQuittingForUpdate: vi.fn(),
  closeNativeWatchersForUpdate: vi.fn(async () => ({ completed: true, restore: vi.fn() })),
  gracefulShutdownForUpdate: vi.fn(),
  gracefulShutdownServicesOnly: vi.fn(),
  isShuttingDown: () => false,
  markCleanExit: vi.fn(),
  rearmCleanExitFlagAfterFailedUpdate: vi.fn(),
  removeBeforeQuitHandlerForUpdate: vi.fn(),
  setQuittingForUpdate: vi.fn(),
}));

vi.mock('@main/utils/buildChannel', () => ({ getBuildChannel: () => 'stable' }));
vi.mock('@main/utils/nativeArch', () => ({ getNativeArch: () => 'arm64' }));
vi.mock('../visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../../utils/testIsolation', () => ({ isRebelTestMode: () => false }));

import {
  _captureAutoUpdateFailureForSentryForTesting,
  _resetUpdateFailureSentryRateLimitForTesting,
  categorizeError,
  shouldCaptureUpdateFailureForSentry,
  shouldNotifyRendererForUpdateError,
  shouldSurfaceUpdateFailureToUser,
  type UpdateError,
  type UpdateErrorCategory,
} from '../autoUpdateService';

const makeUpdateError = (category: UpdateErrorCategory, retryable = false): UpdateError => ({
  category,
  message: `${category} failure`,
  retryable,
});

describe('autoUpdateService error categorization', () => {
  it.each([
    ['OSStatus -60006', 'ShipIt failed with OSStatus -60006'],
    ['OSStatus -60008', 'Error Domain=SQRLInstallerErrorDomain Code=4 (OSStatus -60008)'],
    ['errAuthorization', 'Install failed: errAuthorizationDenied'],
    ['Authorization with OSStatus', 'Authorization failed while installing update (OSStatus -60006)'],
    ['disabled command', 'The command is disabled and cannot be executed'],
  ])('categorizes Apple Authorization install failure: %s', (_name, message) => {
    expect(categorizeError(new Error(message))).toMatchObject({
      category: 'permission',
      retryable: false,
    });
  });

  it('does not treat plain authorization text as a permission update failure', () => {
    expect(categorizeError(new Error('Request included an Authorization header')).category).toBe('unknown');
  });

  it('keeps network classification when authorization appears inside a failing network URL', () => {
    const categorized = categorizeError(new Error('getaddrinfo ENOTFOUND https://updates.example/authorization'));
    expect(categorized.category).toBe('network');
    expect(categorized.retryable).toBe(true);
  });

  // REBEL-681: three known benign/environmental conditions that previously fell
  // through to `unknown`, making the bucket meaningless and the auto-update
  // issue read as a real defect.
  it('categorizes an offline error as retryable network (REBEL-681)', () => {
    const categorized = categorizeError(new Error('The Internet connection appears to be offline.'));
    expect(categorized.category).toBe('network');
    expect(categorized.retryable).toBe(true);
  });

  it('categorizes a read-only volume error as non-retryable permission (REBEL-681)', () => {
    const categorized = categorizeError(
      new Error(
        'Cannot update while running on a read-only volume. The application is on a read-only volume. ' +
          'Please move the application out of the Downloads directory and try again.',
      ),
    );
    expect(categorized.category).toBe('permission');
    expect(categorized.retryable).toBe(false);
  });

  it('categorizes a no-update-available race as the benign non-retryable no-update category (REBEL-681)', () => {
    const categorized = categorizeError(new Error("No update available, can't quit and install"));
    expect(categorized.category).toBe('no-update');
    expect(categorized.retryable).toBe(false);
  });
});

describe('autoUpdateService update failure surfacing decisions', () => {
  it('notifies the renderer only for actionable permission errors', () => {
    expect(shouldNotifyRendererForUpdateError('permission')).toBe(true);
    expect(shouldNotifyRendererForUpdateError('network')).toBe(false);
    expect(shouldNotifyRendererForUpdateError('unknown')).toBe(false);
  });

  it.each<UpdateErrorCategory>(['ssl', 'signature', 'permission', 'disk', 'parse', 'unknown'])(
    'captures %s failures to Sentry',
    (category) => {
      expect(shouldCaptureUpdateFailureForSentry(category)).toBe(true);
    },
  );

  it.each<UpdateErrorCategory>(['network', 'lock'])(
    'does not capture retryable %s failures to Sentry',
    (category) => {
      expect(shouldCaptureUpdateFailureForSentry(category)).toBe(false);
    },
  );

  it('does not capture the benign no-update race to Sentry despite it being non-retryable (REBEL-681)', () => {
    // 'no-update' is non-retryable but benign — categorising it (vs 'unknown')
    // exists precisely to stop it minting misleading update-failure issues.
    expect(shouldCaptureUpdateFailureForSentry('no-update')).toBe(false);
    expect(shouldNotifyRendererForUpdateError('no-update')).toBe(false);
  });

  describe('shouldSurfaceUpdateFailureToUser (one-time fail-loud)', () => {
    it('surfaces a non-retryable permission failure not yet notified this version', () => {
      expect(shouldSurfaceUpdateFailureToUser('permission', false, false)).toBe(true);
    });

    it('does not surface twice for the same version', () => {
      expect(shouldSurfaceUpdateFailureToUser('permission', false, true)).toBe(false);
    });

    it('does not surface retryable failures', () => {
      expect(shouldSurfaceUpdateFailureToUser('permission', true, false)).toBe(false);
    });

    it.each<UpdateErrorCategory>(['network', 'ssl', 'disk', 'signature', 'parse', 'unknown', 'no-update'])(
      'does not surface non-permission category %s (avoids over-messaging)',
      (category) => {
        expect(shouldSurfaceUpdateFailureToUser(category, false, false)).toBe(false);
      },
    );
  });

  it('captures a static Sentry message once per category per app run', () => {
    _resetUpdateFailureSentryRateLimitForTesting();

    _captureAutoUpdateFailureForSentryForTesting(makeUpdateError('permission'), 'darwin', '0.4.45');
    _captureAutoUpdateFailureForSentryForTesting(makeUpdateError('permission'), 'darwin', '0.4.45');
    _captureAutoUpdateFailureForSentryForTesting(makeUpdateError('unknown', true), 'darwin', '0.4.45');
    _captureAutoUpdateFailureForSentryForTesting(makeUpdateError('network', true), 'darwin', '0.4.45');

    expect(mocks.captureMessage).toHaveBeenCalledTimes(2);
    expect(mocks.captureMessage).toHaveBeenNthCalledWith(
      1,
      'auto-update failure',
      expect.objectContaining({
        fingerprint: ['auto-update-failure', 'darwin', 'permission'],
        tags: {
          'update.appVersion': '0.4.45',
          'update.errorCategory': 'permission',
          'update.platform': 'darwin',
        },
      }),
    );
    expect(mocks.captureMessage).toHaveBeenNthCalledWith(
      2,
      'auto-update failure',
      expect.objectContaining({
        fingerprint: ['auto-update-failure', 'darwin', 'unknown'],
      }),
    );
  });
});

beforeEach(() => {
  mocks.captureMessage.mockClear();
  _resetUpdateFailureSentryRateLimitForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});
