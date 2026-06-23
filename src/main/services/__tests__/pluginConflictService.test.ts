import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configurePromptFileService, _resetForTesting } from '@core/services/promptFileService';

const mockGetSettings = vi.fn();
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
}));

const mockCallWithModelAuthAware = vi.fn();
vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: (...args: unknown[]) => mockCallWithModelAuthAware(...args),
}));

const mockHasValidAuth = vi.fn();
vi.mock('@core/utils/authEnvUtils', () => ({
  hasValidAuth: (...args: unknown[]) => mockHasValidAuth(...args),
}));

const mockWritePluginToSpace = vi.fn();
vi.mock('../pluginSpaceService', () => ({
  writePluginToSpace: (...args: unknown[]) => mockWritePluginToSpace(...args),
}));

const {
  detectPluginConflicts,
  resolvePluginConflict,
  parseMergeResponse,
  proposeMerge,
  acceptMerge,
} = await import('../pluginConflictService');

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('pluginConflictService', () => {
  let tempDir: string;
  let spacePath: string;
  let pluginsDir: string;

  beforeEach(async () => {
    _resetForTesting();
    const promptsDir = path.resolve(__dirname, '../../../..', 'rebel-system', 'prompts');
    configurePromptFileService(promptsDir);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-plugin-conflicts-'));
    spacePath = path.join(tempDir, 'SpaceA');
    pluginsDir = path.join(spacePath, 'plugins');
    await fs.mkdir(pluginsDir, { recursive: true });

    mockGetSettings.mockReset();
    mockGetSettings.mockReturnValue({
      claude: { apiKey: 'test-api-key', oauthToken: '', authMethod: 'api-key' },
      modelRoles: { auxiliary: 'claude-sonnet-4-5' },
    });
    mockCallWithModelAuthAware.mockReset();
    mockHasValidAuth.mockReset();
    mockHasValidAuth.mockReturnValue(true);
    mockWritePluginToSpace.mockReset();
  });

  afterEach(async () => {
    _resetForTesting();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('detects common cloud conflict filename patterns', async () => {
    const pluginDir = path.join(pluginsDir, 'meeting-prep');
    await fs.mkdir(pluginDir, { recursive: true });

    await Promise.all([
      fs.writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"meeting-prep"}', 'utf-8'),
      fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function Plugin() { return null; }', 'utf-8'),
      fs.writeFile(path.join(pluginDir, 'manifest (1).json'), '{"id":"meeting-prep","name":"v1"}', 'utf-8'),
      fs.writeFile(path.join(pluginDir, 'manifest (conflicted copy).json'), '{"id":"meeting-prep","name":"v2"}', 'utf-8'),
      fs.writeFile(path.join(pluginDir, 'manifest (Conflict).json'), '{"id":"meeting-prep","name":"v3"}', 'utf-8'),
      fs.writeFile(path.join(pluginDir, 'index (2).tsx'), 'export const v = 2;', 'utf-8'),
      fs.writeFile(path.join(pluginDir, 'index (conflicted copy).tsx'), 'export const v = 3;', 'utf-8'),
      fs.writeFile(path.join(pluginDir, 'index (Conflict).tsx'), 'export const v = 4;', 'utf-8'),
      // Non-conflict files that should be ignored:
      fs.writeFile(path.join(pluginDir, 'manifest (draft).json'), '{}', 'utf-8'),
      fs.writeFile(path.join(pluginDir, 'index (backup).tsx'), 'export {}', 'utf-8'),
    ]);

    const conflicts = await detectPluginConflicts(pluginsDir);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].pluginId).toBe('meeting-prep');
    expect(conflicts[0].spacePath).toBe(spacePath);
    expect(conflicts[0].conflictFiles).toHaveLength(6);
    expect(conflicts[0].conflictFiles).toEqual(expect.arrayContaining([
      'manifest (1).json',
      'manifest (conflicted copy).json',
      'manifest (Conflict).json',
      'index (2).tsx',
      'index (conflicted copy).tsx',
      'index (Conflict).tsx',
    ]));
  });

  it('keep-mine deletes conflict files and keeps original manifest/source', async () => {
    const pluginId = 'inbox-triage';
    const pluginDir = path.join(pluginsDir, pluginId);
    await fs.mkdir(pluginDir, { recursive: true });

    const manifestPath = path.join(pluginDir, 'manifest.json');
    const sourcePath = path.join(pluginDir, 'index.tsx');
    const manifestConflictPath = path.join(pluginDir, 'manifest (1).json');
    const sourceConflictPath = path.join(pluginDir, 'index (conflicted copy).tsx');

    await Promise.all([
      fs.writeFile(manifestPath, '{"id":"inbox-triage","name":"Mine"}', 'utf-8'),
      fs.writeFile(sourcePath, 'export const version = "mine";', 'utf-8'),
      fs.writeFile(manifestConflictPath, '{"id":"inbox-triage","name":"Theirs"}', 'utf-8'),
      fs.writeFile(sourceConflictPath, 'export const version = "theirs";', 'utf-8'),
    ]);

    const resolution = await resolvePluginConflict(pluginId, spacePath, 'keep-mine');

    expect(resolution).toEqual({ success: true });
    expect(await fs.readFile(manifestPath, 'utf-8')).toBe('{"id":"inbox-triage","name":"Mine"}');
    expect(await fs.readFile(sourcePath, 'utf-8')).toBe('export const version = "mine";');
    expect(await pathExists(manifestConflictPath)).toBe(false);
    expect(await pathExists(sourceConflictPath)).toBe(false);
  });

  it('keep-theirs promotes conflict files into manifest/source and removes all conflict copies', async () => {
    const pluginId = 'research-hub';
    const pluginDir = path.join(pluginsDir, pluginId);
    await fs.mkdir(pluginDir, { recursive: true });

    const manifestPath = path.join(pluginDir, 'manifest.json');
    const sourcePath = path.join(pluginDir, 'index.tsx');
    const olderManifestConflict = path.join(pluginDir, 'manifest (1).json');
    const newerManifestConflict = path.join(pluginDir, 'manifest (2).json');
    const sourceConflictPath = path.join(pluginDir, 'index (Conflict).tsx');

    await Promise.all([
      fs.writeFile(manifestPath, '{"id":"research-hub","name":"Mine"}', 'utf-8'),
      fs.writeFile(sourcePath, 'export const version = "mine";', 'utf-8'),
      fs.writeFile(olderManifestConflict, '{"id":"research-hub","name":"Old Theirs"}', 'utf-8'),
      fs.writeFile(newerManifestConflict, '{"id":"research-hub","name":"Latest Theirs"}', 'utf-8'),
      fs.writeFile(sourceConflictPath, 'export const version = "theirs";', 'utf-8'),
    ]);

    const olderDate = new Date(Date.now() - 60_000);
    const newerDate = new Date(Date.now());
    await fs.utimes(olderManifestConflict, olderDate, olderDate);
    await fs.utimes(newerManifestConflict, newerDate, newerDate);

    const resolution = await resolvePluginConflict(pluginId, spacePath, 'keep-theirs');

    expect(resolution).toEqual({ success: true });
    expect(await fs.readFile(manifestPath, 'utf-8')).toBe('{"id":"research-hub","name":"Latest Theirs"}');
    expect(await fs.readFile(sourcePath, 'utf-8')).toBe('export const version = "theirs";');
    expect(await pathExists(olderManifestConflict)).toBe(false);
    expect(await pathExists(newerManifestConflict)).toBe(false);
    expect(await pathExists(sourceConflictPath)).toBe(false);
  });

  describe('parseMergeResponse', () => {
    it('parses manifest and source fenced blocks', () => {
      const parsed = parseMergeResponse([
        'Here is the merge:',
        '```json',
        '{"id":"meeting-prep","name":"Merged Plugin","version":"1.2.0"}',
        '```',
        '```tsx',
        'export default function Plugin() { return null; }',
        '```',
      ].join('\n'));

      expect(parsed.mergedManifest).toEqual({
        id: 'meeting-prep',
        name: 'Merged Plugin',
        version: '1.2.0',
      });
      expect(parsed.mergedSource).toBe('export default function Plugin() { return null; }');
    });

    it('throws when required blocks are missing', () => {
      expect(() => parseMergeResponse('```json\n{"id":"a"}\n```')).toThrow('```tsx');
      expect(() => parseMergeResponse('```tsx\nexport {}\n```')).toThrow('```json');
    });

    it('throws when merged manifest JSON is malformed', () => {
      expect(() =>
        parseMergeResponse('```json\n{ not json }\n```\n```tsx\nexport {}\n```'),
      ).toThrow('invalid JSON');
    });
  });

  describe('proposeMerge', () => {
    it('builds prompt from current/conflict files and returns parsed merge proposal', async () => {
      const pluginId = 'meeting-prep';
      const pluginDir = path.join(pluginsDir, pluginId);
      await fs.mkdir(pluginDir, { recursive: true });

      await Promise.all([
        fs.writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"meeting-prep","name":"Mine"}', 'utf-8'),
        fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export const version = "mine";', 'utf-8'),
        fs.writeFile(path.join(pluginDir, 'manifest (1).json'), '{"id":"meeting-prep","name":"Theirs"}', 'utf-8'),
        fs.writeFile(path.join(pluginDir, 'index (1).tsx'), 'export const version = "theirs";', 'utf-8'),
      ]);

      mockCallWithModelAuthAware.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: [
              '```json',
              '{"id":"meeting-prep","name":"Merged"}',
              '```',
              '```tsx',
              'export const version = "merged";',
              '```',
            ].join('\n'),
          },
        ],
        model: 'claude-sonnet-4-5',
      });

      const result = await proposeMerge(pluginId, spacePath);

      expect(result).toEqual({
        success: true,
        mergedManifest: { id: 'meeting-prep', name: 'Merged' },
        mergedSource: 'export const version = "merged";',
      });

      expect(mockCallWithModelAuthAware).toHaveBeenCalledTimes(1);
      const [settings, model, options, tracking] = mockCallWithModelAuthAware.mock.calls[0];

      expect(settings).toEqual(mockGetSettings.mock.results[0]?.value);
      expect(model).toBe('claude-sonnet-4-5');
      expect(options.system).toContain('You are merging two versions of a Rebel plugin');
      expect(options.maxTokens).toBe(4096);
      expect(options.messages[0].content).toContain('Current version (mine)');
      expect(options.messages[0].content).toContain('"name": "Mine"');
      expect(options.messages[0].content).toContain('Conflicted version (theirs)');
      expect(options.messages[0].content).toContain('"name": "Theirs"');
      expect(tracking).toEqual({ category: 'system' });
    });
  });

  describe('acceptMerge', () => {
    it('writes merged files via writePluginToSpace and removes conflict files', async () => {
      const pluginId = 'research-hub';
      const pluginDir = path.join(pluginsDir, pluginId);
      await fs.mkdir(pluginDir, { recursive: true });

      const manifestConflictPath = path.join(pluginDir, 'manifest (1).json');
      const sourceConflictPath = path.join(pluginDir, 'index (conflicted copy).tsx');
      await Promise.all([
        fs.writeFile(manifestConflictPath, '{"id":"research-hub","name":"Theirs"}', 'utf-8'),
        fs.writeFile(sourceConflictPath, 'export const version = "theirs";', 'utf-8'),
      ]);

      mockWritePluginToSpace.mockResolvedValue({
        ok: true,
        exportedPath: pluginDir,
      });

      const result = await acceptMerge(
        pluginId,
        spacePath,
        { id: pluginId, name: 'Merged Plugin', version: '2.0.0' },
        'export const version = "merged";',
      );

      expect(result).toEqual({ success: true });
      expect(mockWritePluginToSpace).toHaveBeenCalledWith(
        { id: pluginId, name: 'Merged Plugin', version: '2.0.0' },
        'export const version = "merged";',
        spacePath,
      );
      expect(await pathExists(manifestConflictPath)).toBe(false);
      expect(await pathExists(sourceConflictPath)).toBe(false);
    });
  });
});
