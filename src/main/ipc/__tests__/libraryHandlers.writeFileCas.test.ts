import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import { logger } from '@core/logger';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();

const mockWriteManagedSkillFile = vi.fn();
const mockAttachManagedWriteObserver = vi.fn();
const mockBroadcast = vi.fn();
const mockLibraryBroadcasterBroadcast = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockSkillCreated = vi.fn();
const mockWorkArtifactCreated = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('../../services/sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    writeManagedSkillFile: (...args: unknown[]) => mockWriteManagedSkillFile(...args),
    attachManagedWriteObserver: vi.fn(),
  },
}));

vi.mock('../../services/skillChangeNotificationService', () => ({
  skillChangeNotificationService: {
    attachManagedWriteObserver: (...args: unknown[]) => mockAttachManagedWriteObserver(...args),
    listNotifications: vi.fn().mockResolvedValue([]),
    dismissNotification: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../utils/broadcastHelpers', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args),
}));

vi.mock('../../services/libraryBroadcaster', () => ({
  libraryBroadcaster: {
    broadcast: (...args: unknown[]) => mockLibraryBroadcasterBroadcast(...args),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: () => mockGetCurrentUser(),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      refreshLicenseTier: vi.fn(),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('../../tracking', () => ({
  mainTracking: {
    skillCreated: (...args: unknown[]) => mockSkillCreated(...args),
    workArtifactCreated: (...args: unknown[]) => mockWorkArtifactCreated(...args),
  },
}));

const { registerLibraryHandlers } = await import('../libraryHandlers');

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

type WriteFileResult =
  | { result: 'ok'; path: string; updatedAt?: number; currentHash?: string }
  | { result: 'conflict'; path: string; currentHash: string }
  | { result: 'failed'; errorCode: string };

function getWriteHandler(): (event: unknown, request: unknown) => Promise<WriteFileResult> {
  const writeHandler = registeredHandlers.get('library:write-file');
  expect(writeHandler).toBeDefined();
  if (!writeHandler) {
    throw new Error('Expected library:write-file handler to be registered');
  }
  return writeHandler as (event: unknown, request: unknown) => Promise<WriteFileResult>;
}

function getCreateFileHandler(): (event: unknown, request: unknown) => Promise<{ path: string; name: string }> {
  const createFileHandler = registeredHandlers.get('library:create-file');
  expect(createFileHandler).toBeDefined();
  if (!createFileHandler) {
    throw new Error('Expected library:create-file handler to be registered');
  }
  return createFileHandler as (event: unknown, request: unknown) => Promise<{ path: string; name: string }>;
}

function expectFailureLogWithoutPath(): void {
  const errorCalls = vi.mocked(logger.error).mock.calls;
  const failedWriteLogCall = errorCalls.find(([, message]) => message === 'Failed to write workspace file');

  expect(failedWriteLogCall).toBeDefined();
  if (!failedWriteLogCall) {
    throw new Error('Expected failed write log call');
  }

  const [payload] = failedWriteLogCall;
  // Must not log path, err object (which Pino expands to err.path/err.message),
  // or the raw error message anywhere in the payload — see Stage 2 review
  // (Class A Batch 2) "privacy may still leak via err serialization" finding.
  expect(payload).not.toHaveProperty('path');
  expect(payload).not.toHaveProperty('err');
  expect(payload).not.toHaveProperty('error');
  expect(payload).not.toHaveProperty('message');
}

describe('libraryHandlers write-file CAS for unmanaged files', () => {
  let workspaceRoot = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'owner@example.com' });
    mockWriteManagedSkillFile.mockResolvedValue(null);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'library-write-cas-'));
    const settings = { coreDirectory: workspaceRoot } as unknown as AppSettings;

    registerLibraryHandlers({
      getSettings: () => settings,
      getSettingsStore: () => ({ store: settings }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('returns conflict with currentHash when baseContentHash is stale', async () => {
    const writeHandler = getWriteHandler();

    const relativePath = 'notes/conflict.md';
    const absolutePath = path.resolve(workspaceRoot, relativePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, 'initial content', 'utf8');

    const initialHash = sha256Hex('initial content');
    const firstWrite = await writeHandler({}, {
      path: relativePath,
      content: 'editor revision',
      baseContentHash: initialHash,
    });

    expect(firstWrite.result).toBe('ok');
    if (firstWrite.result !== 'ok' || !firstWrite.currentHash) {
      throw new Error('Expected initial write to succeed with a currentHash');
    }
    expect(firstWrite.currentHash).toBe(sha256Hex('editor revision'));

    await fs.writeFile(absolutePath, 'external revision', 'utf8');

    const conflictWrite = await writeHandler({}, {
      path: relativePath,
      content: 'stale editor revision',
      baseContentHash: firstWrite.currentHash,
    });

    expect(conflictWrite).toEqual({
      result: 'conflict',
      path: absolutePath,
      currentHash: sha256Hex('external revision'),
    });
    await expect(fs.readFile(absolutePath, 'utf8')).resolves.toBe('external revision');

    expect(mockLibraryBroadcasterBroadcast).toHaveBeenCalledTimes(1);
  });

  // CAS pre-read error specificity — fail-closed on non-ENOENT errors so a
  // failed read (EACCES / EBUSY / EIO / EPERM / EISDIR / ...) cannot silently
  // bypass CAS and clobber concurrent disk changes.
  // Sub-item from `docs/plans/260428_document_conflict_telemetry_stage5_followup.md`.
  it('returns failed on non-ENOENT pre-read failure rather than bypassing CAS', async () => {
    const writeHandler = getWriteHandler();

    const relativePath = 'notes/locked.md';
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, 'real disk content', 'utf8');

    const eaccesError = Object.assign(new Error('EACCES: simulated permission denied'), { code: 'EACCES' }) as NodeJS.ErrnoException;
    const readSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(eaccesError);

    try {
      await expect(writeHandler({}, {
        path: relativePath,
        content: 'editor revision that must NOT clobber disk',
        baseContentHash: 'any-baseline-hash-since-pre-read-fails',
      })).resolves.toEqual({
        result: 'failed',
        errorCode: 'EACCES',
      });
    } finally {
      readSpy.mockRestore();
    }

    // Disk content must be preserved — CAS bypass would have written the editor revision.
    await expect(fs.readFile(absolutePath, 'utf8')).resolves.toBe('real disk content');
    // No broadcast on failure.
    expect(mockLibraryBroadcasterBroadcast).not.toHaveBeenCalled();
    expectFailureLogWithoutPath();
  });

  it('treats ENOENT pre-read as new-file and proceeds to write', async () => {
    const writeHandler = getWriteHandler();

    const relativePath = 'notes/brand-new.md';
    const absolutePath = path.resolve(workspaceRoot, relativePath);

    // File doesn't exist; baseContentHash provided but real fs.readFile will return ENOENT.
    const result = await writeHandler({}, {
      path: relativePath,
      content: 'first content for new file',
      baseContentHash: 'irrelevant-baseline-since-file-is-new',
    });

    expect(result.result).toBe('ok');
    if (result.result !== 'ok') {
      throw new Error('Expected new-file write to succeed');
    }
    expect(result.currentHash).toBe(sha256Hex('first content for new file'));
    await expect(fs.readFile(absolutePath, 'utf8')).resolves.toBe('first content for new file');
    expect(mockLibraryBroadcasterBroadcast).toHaveBeenCalledTimes(1);
  });

  it('tracks private skill creation on first unmanaged skill write', async () => {
    const writeHandler = getWriteHandler();

    const relativePath = 'Chief-of-Staff/skills/follow-up/SKILL.md';
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const content = '---\ntitle: Follow Up Assistant\n---\n\nDraft follow-up emails.';

    const result = await writeHandler({}, {
      path: relativePath,
      content,
    });

    expect(result.result).toBe('ok');
    await expect(fs.readFile(absolutePath, 'utf8')).resolves.toBe(content);
    expect(mockSkillCreated).toHaveBeenCalledWith({
      skillPath: relativePath,
      skillScope: 'private',
      source: 'library_write_file',
      creatorId: 'user-1',
      creatorEmail: 'owner@example.com',
      creatorName: null,
      skillTitle: 'Follow Up Assistant',
    });
    expect(mockWorkArtifactCreated).not.toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: relativePath,
        source: 'library_write_file',
      }),
    );
  });

  it('tracks private skill creation when an empty skill file is created', async () => {
    const createFileHandler = getCreateFileHandler();

    await fs.mkdir(path.join(workspaceRoot, 'Chief-of-Staff', 'skills', 'triage'), { recursive: true });

    const result = await createFileHandler({}, {
      parentPath: 'Chief-of-Staff/skills/triage',
      fileName: 'SKILL.md',
    });

    expect(result.name).toBe('SKILL.md');
    expect(mockSkillCreated).toHaveBeenCalledWith({
      skillPath: 'Chief-of-Staff/skills/triage/SKILL.md',
      skillScope: 'private',
      source: 'library_create_file',
      creatorId: 'user-1',
      creatorEmail: 'owner@example.com',
      creatorName: null,
      skillTitle: null,
    });
  });

  it('does not track helper files inside a skill folder as new skills', async () => {
    const writeHandler = getWriteHandler();

    const relativePath = 'Chief-of-Staff/skills/triage/examples/example.md';

    const result = await writeHandler({}, {
      path: relativePath,
      content: 'Example input and output',
    });

    expect(result.result).toBe('ok');
    expect(mockSkillCreated).not.toHaveBeenCalled();
    expect(mockWorkArtifactCreated).toHaveBeenCalledWith({
      filePath: relativePath,
      source: 'library_write_file',
    });
  });

  it('returns failed with ENOSPC and omits path from failure logs when write fails', async () => {
    const writeHandler = getWriteHandler();
    const enospcError = Object.assign(new Error('ENOSPC: simulated disk full'), { code: 'ENOSPC' }) as NodeJS.ErrnoException;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(enospcError);

    try {
      await expect(writeHandler({}, {
        path: 'notes/disk-full.md',
        content: 'content that cannot be written',
      })).resolves.toEqual({
        result: 'failed',
        errorCode: 'ENOSPC',
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(mockLibraryBroadcasterBroadcast).not.toHaveBeenCalled();
    expectFailureLogWithoutPath();
  });

  it('returns failed with EACCES and omits path from failure logs when write fails', async () => {
    const writeHandler = getWriteHandler();
    const eaccesError = Object.assign(new Error('EACCES: simulated permission denied'), { code: 'EACCES' }) as NodeJS.ErrnoException;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(eaccesError);

    try {
      await expect(writeHandler({}, {
        path: 'notes/permission-denied.md',
        content: 'content that cannot be written',
      })).resolves.toEqual({
        result: 'failed',
        errorCode: 'EACCES',
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(mockLibraryBroadcasterBroadcast).not.toHaveBeenCalled();
    expectFailureLogWithoutPath();
  });

  it('returns failed with UNKNOWN and omits path from failure logs for unrecognized error codes', async () => {
    const writeHandler = getWriteHandler();
    const unrecognizedError = Object.assign(new Error('simulated unrecognized failure'), { code: 'E_NOT_A_POSIX_CODE' }) as NodeJS.ErrnoException;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(unrecognizedError);

    try {
      await expect(writeHandler({}, {
        path: 'notes/unrecognized.md',
        content: 'content that cannot be written',
      })).resolves.toEqual({
        result: 'failed',
        errorCode: 'UNKNOWN',
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(mockLibraryBroadcasterBroadcast).not.toHaveBeenCalled();
    expectFailureLogWithoutPath();
  });

  it('returns failed with UNKNOWN and omits path from failure logs for non-Error rejections', async () => {
    const writeHandler = getWriteHandler();
    const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce('simulated string rejection');

    try {
      await expect(writeHandler({}, {
        path: 'notes/string-rejection.md',
        content: 'content that cannot be written',
      })).resolves.toEqual({
        result: 'failed',
        errorCode: 'UNKNOWN',
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(mockLibraryBroadcasterBroadcast).not.toHaveBeenCalled();
    expectFailureLogWithoutPath();
  });

  it('does not leak absolute path through err.path or err.message even for path-bearing fs errors', async () => {
    // Stage 2 review (Class A Batch 2): Pino's `{ err }` serializer would
    // expand path-bearing fs errors (which include both `.path` and the
    // absolute path inside `.message` like "EACCES: permission denied,
    // open '/Users/foo/secrets/x.md'"). This test guards the privacy fix
    // that replaces `{ err: error }` with `{ errorCode, errorName }`.
    const writeHandler = getWriteHandler();
    const pathBearingMessage = "EACCES: permission denied, open '/Users/test/workspace/secret.md'";
    const pathBearingError = Object.assign(new Error(pathBearingMessage), {
      code: 'EACCES',
      path: '/Users/test/workspace/secret.md',
      syscall: 'open',
      errno: -13,
    }) as NodeJS.ErrnoException;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(pathBearingError);

    try {
      await expect(writeHandler({}, {
        path: 'notes/secret.md',
        content: 'content that cannot be written',
      })).resolves.toEqual({
        result: 'failed',
        errorCode: 'EACCES',
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(mockLibraryBroadcasterBroadcast).not.toHaveBeenCalled();
    expectFailureLogWithoutPath();

    // Belt-and-braces: scan the entire log payload structure for any
    // string containing the absolute path.
    const errorCalls = vi.mocked(logger.error).mock.calls;
    const failedCall = errorCalls.find(([, message]) => message === 'Failed to write workspace file');
    expect(failedCall).toBeDefined();
    const serialized = JSON.stringify(failedCall);
    expect(serialized).not.toContain('/Users/test/workspace');
    expect(serialized).not.toContain('secret.md');
    expect(serialized).not.toContain('permission denied');
  });
});
