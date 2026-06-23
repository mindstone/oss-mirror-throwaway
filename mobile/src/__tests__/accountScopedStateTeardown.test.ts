import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  asCompanionConversationId,
  asLocalRecordingId,
  buildCacheKeyPrefix,
  flushPending,
  initPersistence,
  useSessionStore,
} from '@rebel/cloud-client';
import { persistStore, buildCacheKey } from '../../../cloud-client/src/persistence/persistenceHelpers';
import { asyncStoragePersistence } from '../storage/asyncStoragePersistence';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import {
  createMeetingManifest,
  getMeetingChunkPath,
  listMeetingManifests,
  saveMeetingChunkToDisk,
  updateMeetingManifest,
} from '../utils/meetingManifest';
import { recoverMissingMeetingChunksFromManifests } from '../hooks/useMeetingChunkConsumer';
import { wipeAllAccountScopedState } from '../services/accountScopedStateTeardown';
import {
  appendMobileDiagnosticEvent,
  flushMobileDiagnosticEvents,
  readRecentMobileDiagnosticEvents,
} from '../storage/diagnosticEventBufferStorage';
import { fileLogWriter, flushLogs, readRecentLogs } from '../utils/fileLogSink';

const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();
const mockClearWidgetData = jest.fn();
const mockUnregisterWidgetBackgroundRefresh = jest.fn().mockResolvedValue(undefined);

function mockNormalizeDir(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

function mockParentDir(filePath: string): string {
  const normalized = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath;
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex >= 0 ? `${normalized.slice(0, lastSlashIndex + 1)}` : '/';
}

function mockEnsureDir(dir: string): void {
  const normalized = mockNormalizeDir(dir);
  mockDirectories.add(normalized);
  if (normalized === '/' || normalized.length <= 1) return;
  const parent = mockParentDir(normalized);
  if (parent !== normalized) mockEnsureDir(parent);
}

function mockSetFile(filePath: string, content: string): void {
  mockEnsureDir(mockParentDir(filePath));
  mockFiles.set(filePath, content);
}

function mockDeletePath(targetPath: string): void {
  const normalizedDir = mockNormalizeDir(targetPath);
  mockFiles.delete(targetPath);
  mockDirectories.delete(normalizedDir);
  for (const filePath of [...mockFiles.keys()]) {
    if (filePath.startsWith(normalizedDir)) mockFiles.delete(filePath);
  }
  for (const dirPath of [...mockDirectories]) {
    if (dirPath.startsWith(normalizedDir)) mockDirectories.delete(dirPath);
  }
}

function mockListImmediateChildren(dir: string): string[] {
  const normalized = mockNormalizeDir(dir);
  const names = new Set<string>();
  for (const filePath of mockFiles.keys()) {
    if (!filePath.startsWith(normalized)) continue;
    const remainder = filePath.slice(normalized.length);
    if (remainder) names.add(remainder.split('/')[0]);
  }
  for (const dirPath of mockDirectories) {
    if (dirPath === normalized || !dirPath.startsWith(normalized)) continue;
    const remainder = dirPath.slice(normalized.length).replace(/\/$/, '');
    if (remainder) names.add(remainder.split('/')[0]);
  }
  return [...names];
}

function mockResetFileSystem(): void {
  mockFiles.clear();
  mockDirectories.clear();
  mockEnsureDir('/mock/documents/');
  mockEnsureDir('/tmp/');
}

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/mock/documents/',
  EncodingType: { UTF8: 'utf8' },
  getInfoAsync: jest.fn(async (targetPath: string) => ({
    exists: mockFiles.has(targetPath) || mockDirectories.has(mockNormalizeDir(targetPath)),
    uri: targetPath,
    size: mockFiles.get(targetPath)?.length ?? 0,
  })),
  makeDirectoryAsync: jest.fn(async (dir: string) => {
    mockEnsureDir(dir);
  }),
  writeAsStringAsync: jest.fn(async (targetPath: string, contents: string) => {
    mockSetFile(targetPath, contents);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const content = mockFiles.get(from);
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    mockSetFile(to, content);
    if (from !== to) mockDeletePath(from);
  }),
  readAsStringAsync: jest.fn(async (targetPath: string) => {
    const content = mockFiles.get(targetPath);
    if (content === undefined) throw new Error(`ENOENT: ${targetPath}`);
    return content;
  }),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const content = mockFiles.get(from);
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    mockSetFile(to, content);
  }),
  deleteAsync: jest.fn(async (targetPath: string) => {
    mockDeletePath(targetPath);
  }),
  readDirectoryAsync: jest.fn(async (dir: string) => mockListImmediateChildren(dir)),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
}));

jest.mock('expo-file-system', () => {
  function joinUri(...parts: unknown[]): string {
    const strings = parts.map((part) => {
      if (part && typeof part === 'object' && 'uri' in part) return (part as { uri: string }).uri;
      return String(part);
    });
    let result = strings[0] ?? '';
    for (let i = 1; i < strings.length; i++) {
      const segment = strings[i];
      result = result.endsWith('/') ? `${result}${segment}` : `${result}/${segment}`;
    }
    return result;
  }

  class MockFile {
    readonly uri: string;
    readonly name: string;

    constructor(...uris: unknown[]) {
      this.uri = joinUri(...uris);
      const lastSlash = this.uri.lastIndexOf('/');
      this.name = lastSlash >= 0 ? this.uri.slice(lastSlash + 1) : this.uri;
    }

    get exists(): boolean {
      return mockFiles.has(this.uri);
    }

    create(): void {
      mockSetFile(this.uri, '');
    }

    write(payload: string): void {
      mockSetFile(this.uri, payload);
    }

    async text(): Promise<string> {
      const content = mockFiles.get(this.uri);
      if (content === undefined) throw new Error(`ENOENT: ${this.uri}`);
      return content;
    }

    delete(): void {
      mockDeletePath(this.uri);
    }

    rename(newName: string): void {
      const content = mockFiles.get(this.uri);
      if (content === undefined) throw new Error(`ENOENT: ${this.uri}`);
      const parent = mockParentDir(this.uri);
      const targetUri = `${parent}${newName}`;
      mockSetFile(targetUri, content);
      if (targetUri !== this.uri) mockDeletePath(this.uri);
    }
  }

  class MockDirectory {
    readonly uri: string;

    constructor(...uris: unknown[]) {
      this.uri = joinUri(...uris);
    }

    get exists(): boolean {
      return mockDirectories.has(mockNormalizeDir(this.uri));
    }

    create(): void {
      mockEnsureDir(this.uri);
    }

    delete(): void {
      mockDeletePath(this.uri);
    }

    list(): unknown[] {
      return [];
    }
  }

  return {
    Paths: {
      document: { uri: '/mock/documents' },
    },
    Directory: MockDirectory,
    File: MockFile,
  };
});

jest.mock('../services/widgetDataSync', () => ({
  clearWidgetData: () => mockClearWidgetData(),
}));

jest.mock('../services/widgetBackgroundRefresh', () => ({
  unregisterWidgetBackgroundRefresh: () => mockUnregisterWidgetBackgroundRefresh(),
}));

describe('wipeAllAccountScopedState', () => {
  beforeEach(async () => {
    mockResetFileSystem();
    jest.clearAllMocks();
    await AsyncStorage.clear();
    initPersistence(asyncStoragePersistence);
    useSessionStore.getState().resetStore();
    useActiveRecordingStore.getState().clearRecording();
  });

  it('removes old-account cache, native store state, and meeting artifacts before a different account hydrates', async () => {
    const oldCloudUrl = 'https://old-cloud.example';
    const newCloudUrl = 'https://new-cloud.example';
    const oldSession = {
      id: 'old-session',
      title: 'Old account session',
      createdAt: 1,
      updatedAt: 2,
      resolvedAt: null,
      preview: 'must not hydrate',
      messageCount: 1,
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      doneAt: null,
      starredAt: null,
      deletedAt: null,
      origin: 'manual',
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
    };

    persistStore(buildCacheKey(oldCloudUrl, 'sessions'), [oldSession]);
    await flushPending();
    await useSessionStore.getState().hydrate(oldCloudUrl);
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toContain('old-session');

    mockSetFile('/tmp/chunk-0.m4a', 'chunk-audio');
    await createMeetingManifest('meeting-old', 'Old meeting', 1_000);
    await updateMeetingManifest('meeting-old', (current) => ({
      ...current,
      nextChunkIndex: 1,
      lastAckedChunkIndex: -1,
    }));
    await saveMeetingChunkToDisk('meeting-old', 0, '/tmp/chunk-0.m4a');
    expect(mockFiles.has(getMeetingChunkPath('meeting-old', 0))).toBe(true);

    fileLogWriter('info', 'accountScopedStateTeardown.test', 'old account log line', {
      account: 'old',
    });
    await flushLogs();
    expect(await readRecentLogs()).toContain('old account log line');

    appendMobileDiagnosticEvent({
      ts: 1_100,
      surface: 'mobile',
      source: 'accountScopedStateTeardown.test',
      message: 'old account diagnostic event',
    });
    await flushMobileDiagnosticEvents();
    await expect(readRecentMobileDiagnosticEvents()).resolves.toHaveLength(1);

    useActiveRecordingStore
      .getState()
      .setRecording(
        asLocalRecordingId('meeting-old'),
        1_000,
        'Old meeting',
        asCompanionConversationId('companion-old'),
      );

    await wipeAllAccountScopedState(oldCloudUrl, {
      reason: 'explicitDisconnect',
      clearOfflineQueue: true,
      unpair: jest.fn().mockResolvedValue(undefined),
    });

    await useSessionStore.getState().hydrate(newCloudUrl);
    expect(useSessionStore.getState().sessions.map((session) => session.id)).not.toContain('old-session');
    await expect(AsyncStorage.getItem(`rebel-cache:${buildCacheKeyPrefix(oldCloudUrl)}sessions`)).resolves.toBeNull();
    await expect(listMeetingManifests()).resolves.toEqual([]);
    expect(mockFiles.has(getMeetingChunkPath('meeting-old', 0))).toBe(false);
    expect(
      [...mockFiles.keys()].filter((filePath) => filePath.startsWith('/mock/documents/logs/rebel-')),
    ).toEqual([]);
    await expect(readRecentLogs()).resolves.toBe('');
    await expect(readRecentMobileDiagnosticEvents()).resolves.toEqual([]);
    await expect(recoverMissingMeetingChunksFromManifests()).resolves.toBe(0);
    expect(useActiveRecordingStore.getState().meetingSessionId).toBeNull();
    expect(mockClearWidgetData).toHaveBeenCalledTimes(1);
    expect(mockUnregisterWidgetBackgroundRefresh).toHaveBeenCalledTimes(1);
  });
});
