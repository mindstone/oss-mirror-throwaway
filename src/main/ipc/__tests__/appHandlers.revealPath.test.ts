/**
 * Unit tests for the `app:reveal-path` IPC handler (FOX-3422).
 *
 * The handler must NEVER reject (fire-and-forget callers would otherwise
 * produce unhandled rejections — REBEL-2E). Instead it returns a structured
 * result so the renderer can surface a toast, classifying failures into
 * missing / permission / system.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RevealPathResult } from '@shared/ipc/channels/app';

const {
  registeredHandlers,
  mockShowItemInFolder,
  mockOpenPath,
  mockStat,
  mockLogger,
} = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  mockShowItemInFolder: vi.fn(),
  mockOpenPath: vi.fn(),
  mockStat: vi.fn(),
  mockLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0') },
  shell: {
    showItemInFolder: (...args: unknown[]) => mockShowItemInFolder(...args),
    openPath: (...args: unknown[]) => mockOpenPath(...args),
    openExternal: vi.fn(),
  },
  clipboard: {},
  nativeImage: {},
  dialog: {},
}));

vi.mock('node:fs/promises', () => ({
  default: { stat: (...args: unknown[]) => mockStat(...args) },
  stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock('@core/logger', () => ({
  logger: mockLogger,
  createScopedLogger: vi.fn(() => mockLogger),
}));

vi.mock('../../utils/isAllowedExternalUrl', () => ({ isAllowedExternalUrl: vi.fn(() => true) }));
vi.mock('../../services/gracefulShutdown', () => ({ wasCleanExit: vi.fn(() => true) }));
vi.mock('../../services/safeModeContext', () => ({
  getSafeModeContext: vi.fn(),
  saveContextBeforeRelaunch: vi.fn(),
}));
vi.mock('../../services/tutorialPlayerServer', () => ({ getTutorialPlayerUrl: vi.fn() }));
vi.mock('../../services/spaceService', () => ({ resolveViaSpaceName: vi.fn(async () => null) }));

import { registerAppHandlers } from '../appHandlers';

function getRevealHandler(): (event: unknown, target: string) => Promise<RevealPathResult> {
  const handler = registeredHandlers.get('app:reveal-path');
  expect(handler).toBeDefined();
  return handler as (event: unknown, target: string) => Promise<RevealPathResult>;
}

describe('app:reveal-path handler (FOX-3422)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    registerAppHandlers({
      getSettings: () => ({ coreDirectory: '/workspace' }) as never,
      isSafeMode: () => false,
      setSafeModeEnabled: vi.fn(),
    });
  });

  it('returns { ok: true } and reveals a real file', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
    const reveal = getRevealHandler();
    const result = await reveal({}, '/abs/file.txt');
    expect(result).toEqual({ ok: true });
    expect(mockShowItemInFolder).toHaveBeenCalledWith('/abs/file.txt');
  });

  it('returns { ok: false, reason: "missing" } and logs when the path does not exist', async () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    mockStat.mockRejectedValue(err);
    const reveal = getRevealHandler();
    const result = await reveal({}, '/abs/gone.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing');
    expect(mockShowItemInFolder).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('returns { ok: false, reason: "permission" } on EACCES (Full Disk Access)', async () => {
    const err = Object.assign(new Error('denied'), { code: 'EACCES' });
    mockStat.mockRejectedValue(err);
    const reveal = getRevealHandler();
    const result = await reveal({}, '/abs/blocked.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('permission');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('returns { ok: false, reason: "system" } and does NOT throw when shell.openPath fails', async () => {
    // Directory path: stat says directory, openPath returns a non-empty error string.
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true });
    mockOpenPath.mockResolvedValue('Failed to open');
    const reveal = getRevealHandler();
    const result = await reveal({}, '/abs/folder');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('system');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('does not reject for invalid input', async () => {
    const reveal = getRevealHandler();
    const result = await reveal({}, '' as string);
    expect(result.ok).toBe(false);
  });
});
