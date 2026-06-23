import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { StoreFactory } from '@core/storeFactory';
import { createSlackWorkspaceStore, SlackWorkspaceStorePermissionError, type SlackWorkspaceRecord } from '../slackWorkspaceStore';

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

describe('slackWorkspaceStore', () => {
  let tempDir: string;
  let storeFactory: StoreFactory;
  let workspacePath: string;
  const originalPlatform = process.platform;

  const record: SlackWorkspaceRecord = {
    teamId: 'T123',
    teamName: 'Acme',
    teamDomain: 'acme',
    botUserId: 'UBOT',
    botToken: 'xoxb-super-secret-token',
    authedUserId: 'UAUTH',
    installedAt: 1_700_000_000_000,
    status: 'connected',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ws-'));
    workspacePath = path.join(tempDir, 'slack', 'workspace.json');
    storeFactory = ((opts) => ({
      path: path.join(tempDir, `${opts.name}.json`),
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined,
      clear: () => undefined,
      store: {},
    })) as StoreFactory;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  function writeRecordFile(filePath: string, mode = 0o600): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode });
    fs.chmodSync(filePath, mode);
  }

  it('get returns null when empty', () => {
    expect(createSlackWorkspaceStore({ storeFactory }).get()).toBeNull();
  });

  it('set then get round-trips the workspace record', () => {
    const store = createSlackWorkspaceStore({ storeFactory });
    store.set(record);
    expect(store.get()).toEqual(record);
  });

  it('writes the workspace file with 0600 permissions on POSIX', () => {
    setPlatform('linux');
    const store = createSlackWorkspaceStore({ storeFactory });
    store.set(record);
    expect(fs.statSync(workspacePath).mode & 0o777).toBe(0o600);
  });

  it('creates the workspace directory with 0700 permissions on POSIX bootstrap', () => {
    setPlatform('linux');
    createSlackWorkspaceStore({ storeFactory });
    expect(fs.statSync(path.dirname(workspacePath)).mode & 0o777).toBe(0o700);
  });

  it('updateStatus preserves other fields', () => {
    const store = createSlackWorkspaceStore({ storeFactory });
    store.set(record);
    store.updateStatus('needs_reconnect', { code: 'token_expired', message: 'Reconnect', occurredAt: 2 });
    expect(store.get()).toEqual({
      ...record,
      status: 'needs_reconnect',
      lastError: { code: 'token_expired', message: 'Reconnect', occurredAt: 2 },
    });
  });

  it('treats an orphan tmp file as no record and removes it', () => {
    const store = createSlackWorkspaceStore({ storeFactory });
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    fs.writeFileSync(`${workspacePath}.tmp`, JSON.stringify(record), 'utf8');
    expect(store.get()).toBeNull();
    expect(fs.existsSync(`${workspacePath}.tmp`)).toBe(false);
  });

  it('uses the main record and removes a tmp file found alongside it', () => {
    const store = createSlackWorkspaceStore({ storeFactory });
    writeRecordFile(workspacePath);
    fs.writeFileSync(`${workspacePath}.tmp`, JSON.stringify({ ...record, teamName: 'Partial' }), 'utf8');
    expect(store.get()).toEqual(record);
    expect(fs.existsSync(`${workspacePath}.tmp`)).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: workspacePath, tmpPath: `${workspacePath}.tmp` }),
      'tmp file found alongside main store; using main, removing tmp',
    );
  });

  it('throws on permissive workspace file permissions on POSIX read', () => {
    setPlatform('linux');
    const store = createSlackWorkspaceStore({ storeFactory });
    writeRecordFile(workspacePath, 0o644);
    expect(() => store.get()).toThrow(SlackWorkspaceStorePermissionError);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: workspacePath, mode: '644', expectedMaxMode: '600', kind: 'file' }),
      'Slack workspace store permissions are too broad; refusing to read secrets',
    );
  });

  it('throws on permissive workspace directory permissions on POSIX bootstrap', () => {
    setPlatform('linux');
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true, mode: 0o777 });
    fs.chmodSync(path.dirname(workspacePath), 0o777);
    expect(() => createSlackWorkspaceStore({ storeFactory })).toThrow(SlackWorkspaceStorePermissionError);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: path.dirname(workspacePath), mode: '777', expectedMaxMode: '700', kind: 'directory' }),
      'Slack workspace store permissions are too broad; refusing to read secrets',
    );
  });

  it('skips workspace file and directory permission checks on Windows', () => {
    setPlatform('win32');
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true, mode: 0o777 });
    fs.chmodSync(path.dirname(workspacePath), 0o777);
    writeRecordFile(workspacePath, 0o666);
    const store = createSlackWorkspaceStore({ storeFactory });
    expect(store.get()).toEqual(record);
  });

  it('does not log bot tokens during operations', () => {
    const store = createSlackWorkspaceStore({ storeFactory });
    store.set(record);
    store.get();
    store.updateLastSeen();
    store.updateStatus('disconnecting');
    store.clear();
    const logCalls = [
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
      ...mockLogger.info.mock.calls,
      ...mockLogger.debug.mock.calls,
    ];
    expect(JSON.stringify(logCalls)).not.toContain(record.botToken);
  });

  it('corrupt JSON returns null and emits a structured error', () => {
    const store = createSlackWorkspaceStore({ storeFactory });
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    fs.writeFileSync(workspacePath, '{ nope', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(workspacePath, 0o600);
    expect(store.get()).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: workspacePath }),
      'Slack workspace store JSON is unreadable',
    );
  });
});
