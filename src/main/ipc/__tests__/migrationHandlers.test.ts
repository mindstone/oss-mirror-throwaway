import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@shared/types';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

const electronMocks = vi.hoisted(() => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  app: {
    getPath: vi.fn((name: string) => `/tmp/rebel-${name}`),
    getVersion: vi.fn(() => '1.2.3-test'),
    relaunch: vi.fn(),
    quit: vi.fn(),
  },
}));

const platformMocks = vi.hoisted(() => ({
  getPlatformConfig: vi.fn(() => ({
    userDataPath: '/tmp/rebel-userdata',
    version: '1.2.3-test',
  })),
}));

const migrationImportMocks = vi.hoisted(() => {
  class MigrationImportError extends Error {
    code: string;
    retryable: boolean;
    details?: Record<string, unknown>;

    constructor(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
      super(message);
      this.name = 'MigrationImportError';
      this.code = code;
      this.retryable = options.retryable ?? false;
      this.details = options.details;
    }
  }

  return {
    MigrationImportError,
    DEFAULT_MAX_ENTRY_COUNT: 3,
    DEFAULT_MAX_ENTRY_BYTES: 64,
    DEFAULT_MAX_TOTAL_BYTES: 32,
    consumeMigrationImportNoticeSync: vi.fn(),
    describeMigrationImportTargetFreshnessSync: vi.fn(),
    validateMigrationBundle: vi.fn(),
    prepareMigrationImport: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: electronMocks.app,
  dialog: electronMocks.dialog,
}));

vi.mock('@core/platform', () => platformMocks);

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler);
  },
}));

vi.mock('@core/services/migration/migrationExportService', () => ({
  MigrationExportError: class MigrationExportError extends Error {
    code: string;
    retryable: boolean;

    constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
      super(message);
      this.name = 'MigrationExportError';
      this.code = code;
      this.retryable = options.retryable ?? false;
    }
  },
  exportMigrationBundle: vi.fn(),
}));

vi.mock('@core/services/migration/migrationImportService', () => migrationImportMocks);

import { registerMigrationHandlers } from '../migrationHandlers';

let tempRoot: string;

function register(): void {
  handlers.clear();
  registerMigrationHandlers({
    getSettings: () => ({ coreDirectory: '/workspace' }) as AppSettings,
    getWindowForEvent: () => null,
  });
}

async function writeTransferZip(entries: ReadonlyArray<readonly [string, Buffer]>): Promise<string> {
  const zip = new AdmZip();
  for (const [entryName, content] of entries) {
    zip.addFile(entryName, content);
  }
  const transferFilePath = path.join(tempRoot, 'transfer.rebeltransfer');
  zip.writeZip(transferFilePath);
  return transferFilePath;
}

describe('registerMigrationHandlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-migration-handler-'));
    electronMocks.app.getPath.mockImplementation((name: string) =>
      name === 'temp' ? tempRoot : path.join(tempRoot, name)
    );
    migrationImportMocks.describeMigrationImportTargetFreshnessSync.mockReturnValue({ fresh: true, reason: 'fresh' });
    register();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('returns not-fresh from validate-import before unpacking when the target profile is already set up', async () => {
    migrationImportMocks.describeMigrationImportTargetFreshnessSync.mockReturnValue({ fresh: false, reason: 'sessions-have-user-data' });
    electronMocks.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/old.rebeltransfer'],
    });

    const response = await handlers.get('migration:validate-import')?.({ sender: {} });

    expect(response).toMatchObject({
      status: 'not-fresh',
      error: {
        kind: 'not-fresh',
        code: 'target-not-fresh',
        message: 'This computer already has Rebel set up.',
      },
    });
    expect(migrationImportMocks.validateMigrationBundle).not.toHaveBeenCalled();
  });

  it('maps backend incompatible errors from prepare-import to the UI discriminant', async () => {
    migrationImportMocks.prepareMigrationImport.mockRejectedValue(
      new migrationImportMocks.MigrationImportError('bundle-incompatible', 'newer schema'),
    );

    const response = await handlers.get('migration:prepare-import')?.(
      { sender: {} },
      { extractedBundleDir: '/tmp/extracted-transfer' },
    );

    expect(response).toMatchObject({
      status: 'incompatible',
      error: {
        kind: 'incompatible',
        code: 'bundle-incompatible',
        message: 'This transfer file was made with a newer Rebel.',
      },
    });
  });

  it('refuses to discard extracted directories outside the app temp directory', async () => {
    const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
    electronMocks.app.getPath.mockReturnValue('/tmp/rebel-temp');

    const response = await handlers.get('migration:discard-extracted')?.(
      { sender: {} },
      { extractedBundleDir: '/tmp/not-rebel-temp/rebel-transfer-import-123' },
    );

    expect(response).toEqual({ discarded: false });
    expect(rmSpy).not.toHaveBeenCalled();
    rmSpy.mockRestore();
  });

  it('rejects transfer archives with unexpected top-level entries before validation', async () => {
    const transferFilePath = await writeTransferZip([
      ['manifest.json', Buffer.from('{}')],
      ['surprise.json', Buffer.from('{}')],
    ]);
    electronMocks.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [transferFilePath],
    });

    const response = await handlers.get('migration:validate-import')?.({ sender: {} });

    expect(response).toMatchObject({
      status: 'corrupt',
      error: {
        kind: 'corrupt',
        code: 'entry-path-invalid',
      },
    });
    expect(migrationImportMocks.validateMigrationBundle).not.toHaveBeenCalled();
  });

  it('rejects transfer archives over the uncompressed size cap before validation', async () => {
    const transferFilePath = await writeTransferZip([
      ['manifest.json', Buffer.alloc(12)],
      ['data/app-settings.json', Buffer.alloc(12)],
      ['logs/migration-export.log', Buffer.alloc(12)],
    ]);
    electronMocks.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [transferFilePath],
    });

    const response = await handlers.get('migration:validate-import')?.({ sender: {} });

    expect(response).toMatchObject({
      status: 'corrupt',
      error: {
        kind: 'corrupt',
        code: 'bundle-size-exceeded',
      },
    });
    expect(migrationImportMocks.validateMigrationBundle).not.toHaveBeenCalled();
  });

  it('rejects transfer archives over the entry-count cap before validation', async () => {
    const transferFilePath = await writeTransferZip([
      ['manifest.json', Buffer.from('{}')],
      ['data/app-settings.json', Buffer.from('{}')],
      ['data/inbox.json', Buffer.from('{}')],
      ['logs/migration-export.log', Buffer.from('log')],
    ]);
    electronMocks.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [transferFilePath],
    });

    const response = await handlers.get('migration:validate-import')?.({ sender: {} });

    expect(response).toMatchObject({
      status: 'corrupt',
      error: {
        kind: 'corrupt',
        code: 'entry-count-exceeded',
      },
    });
    expect(migrationImportMocks.validateMigrationBundle).not.toHaveBeenCalled();
  });
});
