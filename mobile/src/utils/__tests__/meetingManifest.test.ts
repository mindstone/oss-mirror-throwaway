 

const files = new Map<string, string>();
const directories = new Set<string>();
const enqueueSpy = jest.fn();
const enqueueOrThrowSpy = jest.fn();
const queueStateRef: { current: any } = {
    current: {
      isInitialized: true,
      items: [],
      enqueue: enqueueSpy,
      enqueueOrThrow: enqueueOrThrowSpy,
    },
  };

  const normalizeDir = (dir: string): string => (dir.endsWith('/') ? dir : `${dir}/`);

  const parentDir = (path: string): string => {
    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    const lastSlashIndex = normalized.lastIndexOf('/');
    return lastSlashIndex >= 0 ? `${normalized.slice(0, lastSlashIndex + 1)}` : '/';
  };

  const ensureDir = (dir: string): void => {
    const normalized = normalizeDir(dir);
    directories.add(normalized);

    if (normalized === '/' || normalized.length <= 1) {
      return;
    }

    const parent = parentDir(normalized);
    if (parent !== normalized) {
      ensureDir(parent);
    }
  };

  const ensureParentDirs = (filePath: string): void => {
    ensureDir(parentDir(filePath));
  };

  const listImmediateChildren = (dir: string): string[] => {
    const normalized = normalizeDir(dir);
    const names = new Set<string>();

    for (const filePath of files.keys()) {
      if (!filePath.startsWith(normalized)) continue;
      const remainder = filePath.slice(normalized.length);
      if (!remainder) continue;
      names.add(remainder.split('/')[0]);
    }

    for (const directoryPath of directories) {
      if (directoryPath === normalized || !directoryPath.startsWith(normalized)) continue;
      const remainder = directoryPath.slice(normalized.length).replace(/\/$/, '');
      if (!remainder) continue;
      names.add(remainder.split('/')[0]);
    }

    return [...names];
  };

  const resetMockFileSystem = (): void => {
    files.clear();
    directories.clear();
    ensureDir('/mock/documents/');
    ensureDir('/tmp/');
    enqueueSpy.mockReset();
    enqueueOrThrowSpy.mockReset();
    queueStateRef.current = {
      isInitialized: true,
      items: [],
      enqueue: enqueueSpy,
      enqueueOrThrow: enqueueOrThrowSpy,
    };
  };

  const setMockFile = (path: string, content: string): void => {
    ensureParentDirs(path);
    files.set(path, content);
  };

  const getMockFile = (path: string): string | undefined => files.get(path);
  const pathExists = (path: string): boolean => files.has(path) || directories.has(normalizeDir(path));
  const listMockDirectory = (dir: string): string[] => listImmediateChildren(dir);
  const ensureMockDir = (dir: string): void => {
    ensureDir(dir);
  };
  const deleteMockPath = (path: string): void => {
    files.delete(path);
    directories.delete(normalizeDir(path));
  };

resetMockFileSystem();

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/mock/documents/',
  EncodingType: { UTF8: 'utf8' },
  getInfoAsync: jest.fn(async (path: string) => {
    if (pathExists(path)) {
      const isDirectory = path.endsWith('/') || listMockDirectory(path).length > 0;
      return { exists: true, isDirectory, uri: path, size: 0, modificationTime: 0 };
    }

    return { exists: false, isDirectory: false, uri: path, size: 0, modificationTime: 0 };
  }),
  makeDirectoryAsync: jest.fn(async (dir: string) => {
    ensureMockDir(dir);
  }),
  writeAsStringAsync: jest.fn(async (path: string, contents: string) => {
    setMockFile(path, contents);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const content = getMockFile(from);
    if (content === undefined) {
      throw new Error(`ENOENT: ${from}`);
    }
    setMockFile(to, content);
    if (from !== to) {
      deleteMockPath(from);
    }
  }),
  readAsStringAsync: jest.fn(async (path: string) => {
    const content = getMockFile(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const content = getMockFile(from);
    if (content === undefined) {
      throw new Error(`ENOENT: ${from}`);
    }
    setMockFile(to, content);
  }),
  deleteAsync: jest.fn(async (path: string) => {
    deleteMockPath(path);
  }),
  readDirectoryAsync: jest.fn(async (dir: string) => listMockDirectory(dir)),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  uploadAsync: jest.fn(),
}));

class MockQueueFullError extends Error {
  maxSize: number;
  constructor(maxSize: number) {
    super(`Queue is full (max ${maxSize})`);
    this.name = 'QueueFullError';
    this.maxSize = maxSize;
  }
}

jest.mock('@rebel/cloud-client', () => ({
  // Pure live-meeting id casts (zero-import module) so a future pure cast added
  // there needs no mock edit. See meetingRecordingContext.test.tsx for rationale.
  ...(jest.requireActual('../../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../../cloud-client/src/types/liveMeetingIds')),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
  QueueFullError: MockQueueFullError,
  useOfflineQueueStore: {
    getState: () => queueStateRef.current,
  },
}));

import {
  createMeetingManifest,
  getMeetingChunkPath,
  listMeetingChunkIndices,
  listMeetingManifests,
  readMeetingManifest,
  saveMeetingChunkToDisk,
  updateMeetingManifest,
} from '../meetingManifest';
import { recoverMissingMeetingChunksFromManifests } from '../../hooks/useMeetingChunkConsumer';

describe('meetingManifest', () => {
  beforeEach(() => {
    resetMockFileSystem();
  });

  it('persists manifest updates and chunk inventory for later reads', async () => {
    setMockFile('/tmp/source-0.m4a', 'chunk-0-audio');
    setMockFile('/tmp/source-1.m4a', 'chunk-1-audio');

    await createMeetingManifest('meeting-1', 'Quarterly Review', 1_000);
    await updateMeetingManifest('meeting-1', (current) => ({
      ...current,
      cloudSessionId: 'cloud-session-1',
      nextChunkIndex: 2,
      lastAckedChunkIndex: 1,
      totalChunks: 2,
      isStopped: true,
    }));
    await saveMeetingChunkToDisk('meeting-1', 0, '/tmp/source-0.m4a');
    await saveMeetingChunkToDisk('meeting-1', 1, '/tmp/source-1.m4a');

    const manifest = await readMeetingManifest('meeting-1');
    expect(manifest).toMatchObject({
      localId: 'meeting-1',
      cloudSessionId: 'cloud-session-1',
      nextChunkIndex: 2,
      lastAckedChunkIndex: 1,
      totalChunks: 2,
      isStopped: true,
    });

    expect(await listMeetingManifests()).toEqual([
      expect.objectContaining({
        localId: 'meeting-1',
        startTime: 1_000,
      }),
    ]);
    expect(await listMeetingChunkIndices('meeting-1')).toEqual([0, 1]);
    expect(getMockFile(getMeetingChunkPath('meeting-1', 1))).toBe('chunk-1-audio');
  });

  it('recovers missing chunk queue items from manifest-backed chunk files after a crash', async () => {
    setMockFile('/tmp/recovery-0.m4a', 'recovery-0');
    setMockFile('/tmp/recovery-1.m4a', 'recovery-1');
    setMockFile('/tmp/recovery-2.m4a', 'recovery-2');

    await createMeetingManifest('meeting-2', 'Board Review', 2_000);
    await updateMeetingManifest('meeting-2', (current) => ({
      ...current,
      nextChunkIndex: 3,
      lastAckedChunkIndex: 0,
      totalChunks: 3,
      isStopped: true,
    }));
    await saveMeetingChunkToDisk('meeting-2', 0, '/tmp/recovery-0.m4a');
    await saveMeetingChunkToDisk('meeting-2', 1, '/tmp/recovery-1.m4a');
    await saveMeetingChunkToDisk('meeting-2', 2, '/tmp/recovery-2.m4a');

    enqueueOrThrowSpy.mockResolvedValue({ id: 'recovered-item' });
    queueStateRef.current = {
      isInitialized: true,
      items: [
        {
          type: 'meeting-chunk',
          metadata: {
            meetingSessionId: 'meeting-2',
            chunkIndex: 1,
            meetingStartTime: 2_000,
            mimeType: 'audio/mp4',
          },
        },
      ],
      enqueue: enqueueSpy,
      enqueueOrThrow: enqueueOrThrowSpy,
    };

    const recoveredCount = await recoverMissingMeetingChunksFromManifests();

    expect(recoveredCount).toBe(1);
    expect(enqueueOrThrowSpy).toHaveBeenCalledWith(
      'meeting-chunk',
      getMeetingChunkPath('meeting-2', 2),
      'm4a',
      expect.objectContaining({
        meetingSessionId: 'meeting-2',
        chunkIndex: 2,
        meetingTitle: 'Board Review',
        meetingStartTime: 2_000,
        mimeType: 'audio/mp4',
        isFinalChunk: true,
        totalChunks: 3,
      }),
    );
  });
});
