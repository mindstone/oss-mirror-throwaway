import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allChannels } from '@shared/ipc/contracts';
import { operatorsChannels } from '@shared/ipc/channels/operators';
import * as operatorRegistry from '@core/services/operatorRegistry';
import { setWorkspaceFileSystemFactory, type WorkspaceFileSystem } from '@core/workspaceFileSystem';
import { registerOperatorsHandlers } from '../operatorsHandlers';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
}));

const { personalisationMocks } = vi.hoisted(() => ({
  personalisationMocks: {
    startOperatorPersonalisation: vi.fn(),
  },
}));

const { diaryMocks } = vi.hoisted(() => ({
  diaryMocks: {
    readDiary: vi.fn(),
    appendDiary: vi.fn(),
  },
}));

const { loggerMocks } = vi.hoisted(() => ({
  loggerMocks: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => loggerMocks),
}));

vi.mock('../../services/operatorPersonalisationService', () => personalisationMocks);
vi.mock('@core/services/operatorDiaryStore', () => diaryMocks);

class MemoryWorkspaceFileSystem implements WorkspaceFileSystem {
  files = new Map<string, string>();
  directories = new Set<string>();
  missingRoots = new Set<string>();
  unwritableRoots = new Set<string>();

  private normalizeRoot(root: string): string {
    return root.replace(/[\\/]+$/u, '') || '/';
  }

  private key(root: string, target: string): string {
    const normalizedRoot = this.normalizeRoot(root);
    const normalizedTarget = target.replace(/\\/gu, '/').replace(/^[\\/]+/u, '');
    if (!normalizedTarget || normalizedTarget === '.') {
      return normalizedRoot;
    }
    return `${normalizedRoot}/${normalizedTarget}`;
  }

  private parentPath(absolutePath: string): string {
    const idx = absolutePath.lastIndexOf('/');
    if (idx <= 0) return '/';
    return absolutePath.slice(0, idx);
  }

  private addDirectoryTree(absoluteDirectoryPath: string): void {
    let current = absoluteDirectoryPath;
    while (current && !this.directories.has(current)) {
      this.directories.add(current);
      if (current === '/') break;
      const parent = this.parentPath(current);
      if (parent === current) break;
      current = parent;
    }
  }

  private hasDescendants(absoluteDirectoryPath: string): boolean {
    const prefix = absoluteDirectoryPath === '/' ? '/' : `${absoluteDirectoryPath}/`;
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) return true;
    }
    for (const directoryPath of this.directories.values()) {
      if (directoryPath !== absoluteDirectoryPath && directoryPath.startsWith(prefix)) return true;
    }
    return false;
  }

  async listDirectory(root: string, target: string): Promise<Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>> {
    const rootPath = this.normalizeRoot(root);
    if (this.missingRoots.has(rootPath)) {
      throw new Error('missing root');
    }
    const directoryPath = this.key(root, target);
    if (!this.directories.has(directoryPath)) {
      throw new Error('missing directory');
    }

    const seen = new Map<string, { name: string; isDirectory: boolean; isSymbolicLink: boolean }>();
    for (const childDirectoryPath of this.directories.values()) {
      if (childDirectoryPath === directoryPath) continue;
      if (this.parentPath(childDirectoryPath) !== directoryPath) continue;
      const name = childDirectoryPath.slice(directoryPath.length + 1);
      seen.set(name, { name, isDirectory: true, isSymbolicLink: false });
    }
    for (const childFilePath of this.files.keys()) {
      if (this.parentPath(childFilePath) !== directoryPath) continue;
      const name = childFilePath.slice(directoryPath.length + 1);
      seen.set(name, { name, isDirectory: false, isSymbolicLink: false });
    }
    return [...seen.values()];
  }

  async realPath(root: string, target: string): Promise<string> {
    return this.key(root, target);
  }

  async stat(root: string, target: string): Promise<{ isDirectory: boolean; mtimeMs: number; sizeBytes?: number }> {
    const rootPath = this.normalizeRoot(root);
    if (this.missingRoots.has(rootPath)) {
      throw new Error('missing root');
    }
    const absolutePath = this.key(root, target);
    if (this.directories.has(absolutePath)) {
      return { isDirectory: true, mtimeMs: 0, sizeBytes: 0 };
    }
    const fileContent = this.files.get(absolutePath);
    if (fileContent !== undefined) {
      return { isDirectory: false, mtimeMs: 0, sizeBytes: fileContent.length };
    }
    throw new Error('missing path');
  }

  async readFile(root: string, target: string): Promise<string> {
    const value = this.files.get(this.key(root, target));
    if (value === undefined) throw new Error('missing file');
    return value;
  }

  async writeFile(root: string, target: string, content: string | Uint8Array): Promise<void> {
    const rootPath = this.normalizeRoot(root);
    if (this.unwritableRoots.has(rootPath)) {
      throw new Error('write denied');
    }
    const absolutePath = this.key(root, target);
    this.addDirectoryTree(this.parentPath(absolutePath));
    this.files.set(absolutePath, typeof content === 'string' ? content : new TextDecoder().decode(content));
  }

  async deleteFile(root: string, target: string): Promise<void> {
    const absolutePath = this.key(root, target);
    if (this.files.has(absolutePath)) {
      this.files.delete(absolutePath);
      return;
    }
    if (!this.directories.has(absolutePath)) {
      return;
    }
    if (this.hasDescendants(absolutePath)) {
      throw new Error('directory not empty');
    }
    this.directories.delete(absolutePath);
  }

  async exists(root: string, target: string): Promise<boolean> {
    const absolutePath = this.key(root, target);
    return this.files.has(absolutePath) || this.directories.has(absolutePath);
  }
}

describe('operators IPC contracts', () => {
  let workspaceFileSystem: MemoryWorkspaceFileSystem;

  beforeEach(() => {
    workspaceFileSystem = new MemoryWorkspaceFileSystem();
    workspaceFileSystem.directories.add('/workspace/rebel-system');
    workspaceFileSystem.directories.add('/workspace/Chief-of-Staff');
    workspaceFileSystem.directories.add('/workspace');
    setWorkspaceFileSystemFactory(() => workspaceFileSystem);
    registeredHandlers.clear();
    vi.clearAllMocks();
    diaryMocks.readDiary.mockResolvedValue('');
    diaryMocks.appendDiary.mockResolvedValue(undefined);
    personalisationMocks.startOperatorPersonalisation.mockResolvedValue({
      success: true,
      sessionId: 'session-1',
    });
  });

  it('registers every Operators channel in the global contract', () => {
    for (const channelName of Object.keys(operatorsChannels)) {
      expect(allChannels).toHaveProperty(channelName);
    }
  });

  it('exposes the expected set of Operators channels (no calibration or grounding channels)', () => {
    expect(Object.keys(operatorsChannels).sort()).toEqual([
      'operators:activate',
      'operators:duplicate',
      'operators:get-diary',
      'operators:list',
      'operators:remove',
      'operators:setDisplayName',
      'operators:setLiveMeetingEnabled',
      'operators:startPersonalisation',
      'operators:test-consult',
      'operators:toggle-enabled',
    ]);
  });

  it('round-trips operators:list request and response schemas', () => {
    const channel = operatorsChannels['operators:list'];
    expect(channel.request.parse({ spacePaths: ['/workspace/Chief-of-Staff'] })).toEqual({
      spacePaths: ['/workspace/Chief-of-Staff'],
    });
    expect(channel.request.parse({
      spacePaths: ['/workspace/Chief-of-Staff'],
      roleFilter: 'live_meeting',
    })).toEqual({
      spacePaths: ['/workspace/Chief-of-Staff'],
      roleFilter: 'live_meeting',
    });
    expect(channel.request.parse({})).toEqual({ spacePaths: [] });
    expect(() => channel.request.parse({ spacePaths: [42] })).toThrow();
    expect(() => channel.request.parse({ spacePaths: [], roleFilter: 'invalid_role' })).toThrow();
  });

  it('operators:list handler forwards roleFilter and returns metadata', async () => {
    const listAvailableWithDiagnosticsSpy = vi.spyOn(operatorRegistry, 'listAvailableWithDiagnostics')
      .mockResolvedValueOnce({
        operators: [{
          id: '/workspace/Chief-of-Staff::sales-coach',
          operatorSlug: 'sales-coach',
          spacePath: '/workspace/Chief-of-Staff',
          sourceSpacePath: '/workspace/rebel-system',
          category: 'bundled',
          operatorDirAbsolutePath: '/workspace/Chief-of-Staff/operators/sales-coach',
          operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/sales-coach/OPERATOR.md',
          groundingPath: '/workspace/Chief-of-Staff/operators/sales-coach/grounding.md',
          diaryPath: '/workspace/Chief-of-Staff/operators/sales-coach/diary.md',
          frontmatter: {
            name: 'Sales Coach',
            description: 'Real-time sales coaching',
            consult_when: '',
            kind: 'operator',
            roles: ['live_meeting'],
            live_prompt: 'Live prompt',
          },
          name: 'Sales Coach',
          description: 'Real-time sales coaching',
          consult_when: '',
          kind: 'operator',
          roles: ['live_meeting'],
          livePrompt: 'Live prompt',
          body: 'Body',
        }],
        failures: [],
      });
    registerOperatorsHandlers();

    const response = await registeredHandlers.get('operators:list')?.(null, {
      spacePaths: ['/workspace/Chief-of-Staff'],
      roleFilter: 'live_meeting',
    });

    expect(listAvailableWithDiagnosticsSpy).toHaveBeenCalledWith(
      ['/workspace/Chief-of-Staff'],
      { roleFilter: 'live_meeting' },
    );
    expect(response).toMatchObject({
      operators: [
        expect.objectContaining({
          id: '/workspace/Chief-of-Staff::sales-coach',
          operatorSlug: 'sales-coach',
          category: 'bundled',
        }),
      ],
      failures: [],
    });
  });

  it('round-trips diary request/response schemas', () => {
    const diary = operatorsChannels['operators:get-diary'];
    expect(diary.request.parse({ operatorId: 'op-1' })).toEqual({ operatorId: 'op-1' });
    expect(diary.response.parse({ operatorId: 'op-1', diary: '' })).toEqual({
      operatorId: 'op-1',
      diary: '',
    });
    expect(() => diary.request.parse({ operatorId: '' })).toThrow();
    expect(() => diary.response.parse({ operatorId: 'op-1', diary: null })).toThrow();
  });

  it('diary handler delegates to operatorDiaryStore using the resolved Space path', async () => {
    diaryMocks.readDiary.mockResolvedValueOnce('# Diary');
    vi.spyOn(operatorRegistry, 'getById').mockReturnValueOnce(undefined);
    registerOperatorsHandlers();

    await expect(registeredHandlers.get('operators:get-diary')?.(null, {
      operatorId: '/workspace/Chief-of-Staff::brand-critic',
    })).resolves.toEqual({
      operatorId: '/workspace/Chief-of-Staff::brand-critic',
      diary: '# Diary',
    });
    expect(diaryMocks.readDiary).toHaveBeenCalledWith(
      '/workspace/Chief-of-Staff::brand-critic',
      '/workspace/Chief-of-Staff',
    );
  });

  it('round-trips activate request/response schemas (no calibration fields)', () => {
    const channel = operatorsChannels['operators:activate'];
    expect(channel.request.parse({
      operatorSlug: 'brand-critic',
      sourceSpacePath: '/workspace/rebel-system',
      targetSpacePath: '/workspace/Chief-of-Staff',
    })).toEqual({
      operatorSlug: 'brand-critic',
      sourceSpacePath: '/workspace/rebel-system',
      targetSpacePath: '/workspace/Chief-of-Staff',
    });
    expect(channel.response.parse({
      success: true,
      activatedPath: '/workspace/Chief-of-Staff/operators/brand-critic',
    })).toEqual({
      success: true,
      activatedPath: '/workspace/Chief-of-Staff/operators/brand-critic',
    });
    expect(channel.response.parse({
      success: false,
      errorCode: 'already_activated',
      existingOperatorPath: '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
    })).toEqual({
      success: false,
      errorCode: 'already_activated',
      existingOperatorPath: '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
    });
    expect(() => channel.response.parse({ success: false, errorCode: 'calibration_failed' })).toThrow();
  });

  it('round-trips remove request/response schemas (no confirmation field, no grounding code)', () => {
    const channel = operatorsChannels['operators:remove'];
    expect(channel.request.parse({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
    })).toEqual({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
    });
    expect(channel.response.parse({ success: true })).toEqual({ success: true });
    expect(channel.response.parse({
      success: false,
      errorCode: 'space_not_found',
    })).toEqual({
      success: false,
      errorCode: 'space_not_found',
    });
    expect(() => channel.response.parse({ success: false, errorCode: 'grounding_nonempty_needs_confirmation' })).toThrow();
  });

  it('round-trips setDisplayName request/response schemas', () => {
    const channel = operatorsChannels['operators:setDisplayName'];
    expect(channel.request.parse({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
      displayName: 'Brand Critic — Enterprise',
    })).toEqual({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
      displayName: 'Brand Critic — Enterprise',
    });
    expect(channel.response.parse({ success: true })).toEqual({ success: true });
    expect(channel.response.parse({
      success: false,
      errorCode: 'display_name_too_long',
    })).toEqual({
      success: false,
      errorCode: 'display_name_too_long',
    });
  });

  it('round-trips toggle-enabled request/response schemas', () => {
    const channel = operatorsChannels['operators:toggle-enabled'];
    expect(channel.request.parse({ operatorId: 'op-1', enabled: true })).toEqual({
      operatorId: 'op-1',
      enabled: true,
    });
    expect(channel.response.parse({ success: false, errorCode: 'not_implemented' })).toEqual({
      success: false,
      errorCode: 'not_implemented',
    });
  });

  it('round-trips setLiveMeetingEnabled request/response schemas', () => {
    const channel = operatorsChannels['operators:setLiveMeetingEnabled'];
    expect(channel.request.parse({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
      enabled: true,
    })).toEqual({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
      enabled: true,
    });
    expect(channel.response.parse({ success: true })).toEqual({ success: true });
    expect(channel.response.parse({
      success: false,
      errorCode: 'live_prompt_missing',
    })).toEqual({
      success: false,
      errorCode: 'live_prompt_missing',
    });
    expect(channel.response.parse({
      success: false,
      errorCode: 'roles_would_be_empty',
    })).toEqual({
      success: false,
      errorCode: 'roles_would_be_empty',
    });
    expect(() => channel.request.parse({
      operatorSlug: '',
      targetSpacePath: '/workspace/Chief-of-Staff',
      enabled: true,
    })).toThrow();
    expect(() => channel.response.parse({
      success: false,
      errorCode: 'unknown_error',
    })).toThrow();
  });

  it('setLiveMeetingEnabled handler delegates to the role toggle service', async () => {
    workspaceFileSystem.directories.add('/workspace/Chief-of-Staff/operators/brand-critic');
    workspaceFileSystem.files.set(
      '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: Coach the speaker on clarity.',
        '---',
        'Body',
        '',
      ].join('\n'),
    );
    registerOperatorsHandlers();

    const response = await registeredHandlers.get('operators:setLiveMeetingEnabled')?.(null, {
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
      enabled: true,
    });

    expect(response).toEqual({ success: true });
    const updated = workspaceFileSystem.files.get(
      '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
    ) ?? '';
    expect(updated).toContain('roles:');
    expect(updated).toContain('live_meeting');
  });

  it('setLiveMeetingEnabled handler surfaces live_prompt_missing without throwing', async () => {
    workspaceFileSystem.directories.add('/workspace/Chief-of-Staff/operators/brand-critic');
    workspaceFileSystem.files.set(
      '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        '---',
        'Body',
        '',
      ].join('\n'),
    );
    registerOperatorsHandlers();

    await expect(registeredHandlers.get('operators:setLiveMeetingEnabled')?.(null, {
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
      enabled: true,
    })).resolves.toEqual({ success: false, errorCode: 'live_prompt_missing' });
  });

  it('round-trips startPersonalisation request/response schemas', () => {
    const channel = operatorsChannels['operators:startPersonalisation'];
    expect(channel.request.parse({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
    })).toEqual({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
    });
    expect(channel.response.parse({ success: true, sessionId: 'session-1' })).toEqual({
      success: true,
      sessionId: 'session-1',
    });
    expect(channel.response.parse({ success: false, errorCode: 'broadcast_failed' })).toEqual({
      success: false,
      errorCode: 'broadcast_failed',
    });
    expect(() => channel.response.parse({ success: false, errorCode: 'unknown_error' })).toThrow();
  });

  it('startPersonalisation handler delegates to the personalisation service', async () => {
    registerOperatorsHandlers();

    await expect(registeredHandlers.get('operators:startPersonalisation')?.(null, {
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
    })).resolves.toEqual({ success: true, sessionId: 'session-1' });

    expect(personalisationMocks.startOperatorPersonalisation).toHaveBeenCalledWith({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
    });
  });

  it('startPersonalisation handler surfaces broadcast_failed without throwing', async () => {
    personalisationMocks.startOperatorPersonalisation.mockResolvedValueOnce({
      success: false,
      errorCode: 'broadcast_failed',
    });
    registerOperatorsHandlers();

    await expect(registeredHandlers.get('operators:startPersonalisation')?.(null, {
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
    })).resolves.toEqual({ success: false, errorCode: 'broadcast_failed' });
  });

  it('reuses the consult tool input shape for operators:test-consult', () => {
    const channel = operatorsChannels['operators:test-consult'];
    expect(channel.request.parse({ operatorId: 'op-1', focus: 'Stress-test the launch plan' })).toEqual({
      operatorId: 'op-1',
      focus: 'Stress-test the launch plan',
    });
    expect(() => channel.request.parse({ operatorId: 'op-1', focus: '' })).toThrow();

    expect(channel.response.parse({
      isError: false,
      calibrated: true,
      errorCode: null,
      operatorId: 'op-1',
      operatorName: 'Skeptical Engineer',
      perspective: 'This needs a rollback plan.',
      evidenceCited: ['Launch risk memo'],
      confidence: 0.8,
      diaryAppendFailed: false,
    })).toMatchObject({ isError: false, calibrated: true });

    expect(channel.response.parse({
      isError: true,
      errorCode: 'operator_not_found',
      message: 'Missing',
      operatorId: 'op-1',
      availableIds: [],
    }).isError).toBe(true);

    // Error results preserve operatorName so the surface can name the view on
    // failure ("Couldn't ask Investor View") instead of a generic "Operator".
    const erroredConsult = channel.response.parse({
      isError: true,
      errorCode: 'consult_failed',
      message: 'Consult with Investor View failed before it could return a perspective.',
      reason: 'unknown',
      operatorId: 'op-1',
      operatorName: 'Investor View',
    });
    expect(erroredConsult).toMatchObject({ isError: true, operatorName: 'Investor View' });

    // 'invalid_request' is an accepted reason so deterministic provider 400s
    // (e.g. "Unsupported parameter: temperature") are diagnosable, not collapsed to 'unknown'.
    const invalidRequestConsult = channel.response.parse({
      isError: true,
      errorCode: 'consult_failed',
      message: 'Consult with Investor View failed before it could return a perspective.',
      reason: 'invalid_request',
      operatorId: 'op-1',
      operatorName: 'Investor View',
    });
    expect(invalidRequestConsult).toMatchObject({ isError: true, reason: 'invalid_request' });
  });
});
