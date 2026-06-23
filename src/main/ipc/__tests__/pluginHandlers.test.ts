import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();

const mockPersistPluginEntries = vi.fn();
const mockLoadPersistedPluginEntries = vi.fn();
const mockClearPersistedPluginEntries = vi.fn();
const mockGetActivatedPluginIds = vi.fn();
const mockAddActivatedPluginId = vi.fn();
const mockRemoveActivatedPluginId = vi.fn();
const mockGetSettings = vi.fn();
const mockRequestPluginCompileAndRegister = vi.fn();
const mockShowSaveDialog = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockWriteFile = vi.fn();
const mockReadFile = vi.fn();
const mockIndexPluginReadme = vi.fn();
const mockDeindexPluginReadme = vi.fn();
const mockSearchSources = vi.fn();
const mockSearchEntities = vi.fn();
const mockGetSource = vi.fn();
const mockCallBehindTheScenesWithAuth = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockRecordCall = vi.fn();
const mockCheckMessageRateLimit = vi.fn();
const mockRecordMessageCall = vi.fn();
const mockGetSession = vi.fn();
const mockSendToAllWindows = vi.fn();
const mockGetCachedMeetings = vi.fn();
const mockGetTodaysMeetings = vi.fn();
const mockIsCacheStale = vi.fn();
const mockWriteManagedSkillFile = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockAddInboxItem = vi.fn();
const mockGetInboxState = vi.fn();
const mockCapturePluginAiException = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('../../services/pluginFilePersistence', () => ({
  persistPluginEntries: (...args: unknown[]) => mockPersistPluginEntries(...args),
  loadPersistedPluginEntries: (...args: unknown[]) => mockLoadPersistedPluginEntries(...args),
  clearPersistedPluginEntries: (...args: unknown[]) => mockClearPersistedPluginEntries(...args),
}));

vi.mock('@core/services/pluginStorageStore', () => ({
  getPluginStorageValue: vi.fn(),
  setPluginStorageValue: vi.fn(),
  deletePluginStorageValue: vi.fn(),
  clearPluginStorage: vi.fn(),
}));

vi.mock('@core/services/pluginActivationStore', () => ({
  getActivatedPluginIds: (...args: unknown[]) => mockGetActivatedPluginIds(...args),
  addActivatedPluginId: (...args: unknown[]) => mockAddActivatedPluginId(...args),
  removeActivatedPluginId: (...args: unknown[]) => mockRemoveActivatedPluginId(...args),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
}));

const mockSemanticSearch = vi.fn();
const mockSemanticSearchWithStatus = vi.fn();
const mockIsFileIndexReady = vi.fn();
const mockGetScanCompletedAt = vi.fn();
const mockIsEmbeddingServiceReady = vi.fn();

vi.mock('../../services/pluginCompileBridge', () => ({
  requestPluginCompileAndRegister: (...args: unknown[]) => mockRequestPluginCompileAndRegister(...args),
}));

vi.mock('../../services/fileIndexService', () => ({
  semanticSearch: (...args: unknown[]) => mockSemanticSearch(...args),
  semanticSearchWithStatus: (...args: unknown[]) => mockSemanticSearchWithStatus(...args),
  isFileIndexReady: () => mockIsFileIndexReady(),
  getScanCompletedAt: () => mockGetScanCompletedAt(),
}));

vi.mock('../../services/embeddingService', () => ({
  isEmbeddingServiceReady: () => mockIsEmbeddingServiceReady(),
}));

const mockScanSpacePlugins = vi.fn();
const mockExportPluginToSpace = vi.fn();
const mockResolvePluginConflict = vi.fn();

vi.mock('../../services/pluginSpaceService', () => ({
  scanSpacePlugins: (...args: unknown[]) => mockScanSpacePlugins(...args),
  exportPluginToSpace: (...args: unknown[]) => mockExportPluginToSpace(...args),
}));

vi.mock('../../services/pluginConflictService', () => ({
  resolvePluginConflict: (...args: unknown[]) => mockResolvePluginConflict(...args),
}));

vi.mock('../../services/pluginIndexService', () => ({
  indexPluginReadme: (...args: unknown[]) => mockIndexPluginReadme(...args),
  deindexPluginReadme: (...args: unknown[]) => mockDeindexPluginReadme(...args),
}));

vi.mock('@core/services/sourceMetadataStore', () => ({
  searchSources: (...args: unknown[]) => mockSearchSources(...args),
  getSource: (...args: unknown[]) => mockGetSource(...args),
}));

vi.mock('../../services/entityMetadataStore', () => ({
  searchEntities: (...args: unknown[]) => mockSearchEntities(...args),
}));

vi.mock('@core/services/meetingCacheStore', () => ({
  getCachedMeetings: (...args: unknown[]) => mockGetCachedMeetings(...args),
  getTodaysMeetings: (...args: unknown[]) => mockGetTodaysMeetings(...args),
  isCacheStale: (...args: unknown[]) => mockIsCacheStale(...args),
}));

vi.mock('../../services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenesWithAuth(...args),
}));

vi.mock('@core/services/pluginAiRateLimiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  recordCall: (...args: unknown[]) => mockRecordCall(...args),
  _resetForTesting: vi.fn(),
}));

vi.mock('@core/services/pluginMessageRateLimiter', () => ({
  checkMessageRateLimit: (...args: unknown[]) => mockCheckMessageRateLimit(...args),
  recordMessageCall: (...args: unknown[]) => mockRecordMessageCall(...args),
  _resetForTesting: vi.fn(),
}));

vi.mock('../../services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: (...args: unknown[]) => mockGetSession(...args),
  }),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({
    sendToAllWindows: (...args: unknown[]) => mockSendToAllWindows(...args),
  });
});

vi.mock('../../services/sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    writeManagedSkillFile: (...args: unknown[]) => mockWriteManagedSkillFile(...args),
  },
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: (...args: unknown[]) => mockCapturePluginAiException(...args),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

vi.mock('../../services/inboxStore', () => ({
  addInboxItem: (...args: unknown[]) => mockAddInboxItem(...args),
  getInboxState: (...args: unknown[]) => mockGetInboxState(...args),
}));

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: (...args: unknown[]) => mockShowSaveDialog(...args),
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args),
  },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}));

import { ModelError } from '@core/rebelCore/modelErrors';
import { registerPluginHandlers, _resetPluginInboxAddRateLimiterForTesting, _invalidatePermissionCacheForTesting } from '../pluginHandlers';

describe('pluginHandlers', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    mockPersistPluginEntries.mockReset();
    mockLoadPersistedPluginEntries.mockReset();
    mockClearPersistedPluginEntries.mockReset();
    mockGetActivatedPluginIds.mockReset();
    mockAddActivatedPluginId.mockReset();
    mockRemoveActivatedPluginId.mockReset();
    mockGetSettings.mockReset();
    mockRequestPluginCompileAndRegister.mockReset();
    mockSemanticSearch.mockReset();
    mockSemanticSearchWithStatus.mockReset();
    mockShowSaveDialog.mockReset();
    mockShowOpenDialog.mockReset();
    mockWriteFile.mockReset();
    mockReadFile.mockReset();
    mockScanSpacePlugins.mockReset();
    mockExportPluginToSpace.mockReset();
    mockResolvePluginConflict.mockReset();
    mockIndexPluginReadme.mockReset();
    mockDeindexPluginReadme.mockReset();
    mockIsFileIndexReady.mockReset();
    mockGetScanCompletedAt.mockReset();
    mockIsEmbeddingServiceReady.mockReset();
    mockSearchSources.mockReset();
    mockSearchEntities.mockReset();
    mockGetSource.mockReset();
    mockCallBehindTheScenesWithAuth.mockReset();
    mockCheckRateLimit.mockReset();
    mockRecordCall.mockReset();
    mockGetCachedMeetings.mockReset();
    mockGetTodaysMeetings.mockReset();
    mockIsCacheStale.mockReset();
    mockWriteManagedSkillFile.mockReset();
    mockGetCurrentUser.mockReset();
    mockAddInboxItem.mockReset();
    mockGetInboxState.mockReset();
    mockCapturePluginAiException.mockReset();
    _resetPluginInboxAddRateLimiterForTesting();
    _invalidatePermissionCacheForTesting();
    mockGetSettings.mockReturnValue({ coreDirectory: '/workspace' });
    // Default: rate limiter allows calls (happy path)
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    // Default: services ready (happy path)
    mockIsFileIndexReady.mockReturnValue(true);
    mockIsEmbeddingServiceReady.mockReturnValue(true);
    mockGetScanCompletedAt.mockReturnValue(Date.now());
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', name: 'Test User', email: 'test@example.com', image: null });
    mockGetInboxState.mockReturnValue({ version: 1, items: [], history: [] });
    // Default: test plugin has standard read permissions (happy path for read handler tests)
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'test-plugin',
          name: 'Test Plugin',
          entryPoint: 'index.tsx',
          permissions: ['memory:read', 'entities:read', 'skills:read'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);
    registerPluginHandlers();
  });

  it('registers all plugin channels', () => {
    expect(registeredHandlers.has('plugins:compile-and-register')).toBe(true);
    expect(registeredHandlers.has('plugins:persist-all')).toBe(true);
    expect(registeredHandlers.has('plugins:load-persisted')).toBe(true);
    expect(registeredHandlers.has('plugins:clear-persisted')).toBe(true);
    expect(registeredHandlers.has('plugins:export-plugin')).toBe(true);
    expect(registeredHandlers.has('plugins:import-plugin')).toBe(true);
    expect(registeredHandlers.has('plugins:memory-search')).toBe(true);
    expect(registeredHandlers.has('plugins:scan-spaces')).toBe(true);
    expect(registeredHandlers.has('plugins:export-to-space')).toBe(true);
    expect(registeredHandlers.has('plugins:migrate-to-space')).toBe(true);
    expect(registeredHandlers.has('plugins:seed-bundled')).toBe(true);
    expect(registeredHandlers.has('plugins:resolve-conflict')).toBe(true);
    expect(registeredHandlers.has('plugins:get-activated')).toBe(true);
    expect(registeredHandlers.has('plugins:add-activated')).toBe(true);
    expect(registeredHandlers.has('plugins:remove-activated')).toBe(true);
    expect(registeredHandlers.has('plugins:index-readme')).toBe(true);
    expect(registeredHandlers.has('plugins:deindex-readme')).toBe(true);
    expect(registeredHandlers.has('plugins:delete-from-space')).toBe(true);
    expect(registeredHandlers.has('plugins:search-sources')).toBe(true);
    expect(registeredHandlers.has('plugins:get-source-document')).toBe(true);
    expect(registeredHandlers.has('plugins:get-entities')).toBe(true);
    expect(registeredHandlers.has('plugins:read-skill')).toBe(true);
    expect(registeredHandlers.has('plugins:write-skill')).toBe(true);
    expect(registeredHandlers.has('plugins:ai-summarize')).toBe(true);
    expect(registeredHandlers.has('plugins:ai-extract')).toBe(true);
    expect(registeredHandlers.has('plugins:ai-generate')).toBe(true);
    expect(registeredHandlers.has('plugins:get-meetings')).toBe(true);
    expect(registeredHandlers.has('plugins:inbox-add')).toBe(true);
    expect(registeredHandlers.has('plugins:inbox-list')).toBe(true);
    expect(registeredHandlers.has('plugins:get-transcript')).toBe(true);
  });

  it('forwards compile-and-register to the renderer bridge service', async () => {
    mockRequestPluginCompileAndRegister.mockResolvedValue({ ok: true });

    const handler = registeredHandlers.get('plugins:compile-and-register');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, {
      manifest: {
        id: 'meeting-prep',
        name: 'Meeting Prep',
        entryPoint: 'index.tsx',
      },
      source: 'export default function Plugin() { return null; }',
    });

    expect(mockRequestPluginCompileAndRegister).toHaveBeenCalledTimes(1);
    expect(mockRequestPluginCompileAndRegister).toHaveBeenCalledWith({
      manifest: {
        id: 'meeting-prep',
        name: 'Meeting Prep',
        entryPoint: 'index.tsx',
        version: '0.1.0',
        maturity: 'labs',
        role: 'utility',
        storageScope: 'local',
      },
      source: 'export default function Plugin() { return null; }',
    });
    expect(response).toEqual({ ok: true });
  });

  it('persists only user plugins (filters __ prefixed IDs)', async () => {
    const handler = registeredHandlers.get('plugins:persist-all');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, {
      plugins: [
        {
          manifest: {
            id: '__demo',
            name: 'Demo',
            entryPoint: 'inline',
          },
          source: 'demo source',
        },
        {
          manifest: {
            id: 'meeting-prep',
            name: 'Meeting Prep',
            entryPoint: 'inline',
          },
          source: 'user source',
        },
      ],
    });

    expect(mockPersistPluginEntries).toHaveBeenCalledTimes(1);
    expect(mockPersistPluginEntries).toHaveBeenCalledWith([
      {
        manifest: {
          id: 'meeting-prep',
          name: 'Meeting Prep',
          entryPoint: 'inline',
          version: '0.1.0',
          maturity: 'labs',
          role: 'utility',
          storageScope: 'local',
        },
        source: 'user source',
      },
    ]);
    expect(response).toEqual({ success: true });
  });

  it('loads persisted plugins from store', async () => {
    mockLoadPersistedPluginEntries.mockReturnValue([
      {
        manifest: {
          id: 'meeting-prep',
          name: 'Meeting Prep',
          entryPoint: 'inline',
          version: '0.1.0',
          maturity: 'labs',
        },
        source: 'source',
      },
    ]);

    const handler = registeredHandlers.get('plugins:load-persisted');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, undefined);

    expect(mockLoadPersistedPluginEntries).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      plugins: [
        {
          manifest: {
            id: 'meeting-prep',
            name: 'Meeting Prep',
            entryPoint: 'inline',
            version: '0.1.0',
            maturity: 'labs',
          },
          source: 'source',
        },
      ],
    });
  });

  it('clears persisted plugins', async () => {
    const handler = registeredHandlers.get('plugins:clear-persisted');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, undefined);

    expect(mockClearPersistedPluginEntries).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ success: true });
  });

  // ── Export/Import tests ───────────────────────────────────────────────

  it('exports a plugin as JSON file', async () => {
    mockLoadPersistedPluginEntries.mockReturnValue([
      {
        manifest: {
          id: 'my-plugin',
          name: 'My Plugin',
          description: 'A test plugin',
          version: '0.1.0',
          entryPoint: 'inline',
          maturity: 'labs',
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/my-plugin.rebel-plugin.json' });
    mockWriteFile.mockResolvedValue(undefined);

    const handler = registeredHandlers.get('plugins:export-plugin');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'my-plugin' });

    expect(mockShowSaveDialog).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(writtenContent.version).toBe(1);
    expect(writtenContent.plugin.manifest.id).toBe('my-plugin');
    expect(writtenContent.plugin.source).toBe('export default function Plugin() { return null; }');
    expect(response).toEqual({ ok: true, filePath: '/tmp/my-plugin.rebel-plugin.json' });
  });

  it('returns error when exporting a plugin that is not persisted', async () => {
    mockLoadPersistedPluginEntries.mockReturnValue([]);

    const handler = registeredHandlers.get('plugins:export-plugin');
    const response: any = await handler?.({}, { pluginId: 'nonexistent' });

    expect(response).toEqual({ ok: false, error: 'Plugin "nonexistent" not found in persisted storage.' });
    expect(mockShowSaveDialog).not.toHaveBeenCalled();
  });

  it('returns cancellation error when save dialog is cancelled', async () => {
    mockLoadPersistedPluginEntries.mockReturnValue([
      {
        manifest: { id: 'my-plugin', name: 'My Plugin', entryPoint: 'inline' },
        source: 'source',
      },
    ]);
    mockShowSaveDialog.mockResolvedValue({ canceled: true });

    const handler = registeredHandlers.get('plugins:export-plugin');
    const response: any = await handler?.({}, { pluginId: 'my-plugin' });

    expect(response).toEqual({ ok: false, error: 'Export cancelled.' });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('imports a valid plugin file', async () => {
    const pluginFile = JSON.stringify({
      version: 1,
      plugin: {
        manifest: { id: 'imported-plugin', name: 'Imported Plugin', description: 'A plugin', version: '1.0.0' },
        source: 'export default function Plugin() { return null; }',
      },
    });

    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/imported.json'] });
    mockReadFile.mockResolvedValue(pluginFile);

    const handler = registeredHandlers.get('plugins:import-plugin');
    const response: any = await handler?.({}, undefined);

    expect(mockShowOpenDialog).toHaveBeenCalledTimes(1);
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/imported.json', 'utf-8');
    expect(response).toEqual({
      ok: true,
      manifest: { id: 'imported-plugin', name: 'Imported Plugin', description: 'A plugin', version: '1.0.0' },
      source: 'export default function Plugin() { return null; }',
    });
  });

  it('returns error for invalid JSON during import', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/bad.json'] });
    mockReadFile.mockResolvedValue('not valid json{{{');

    const handler = registeredHandlers.get('plugins:import-plugin');
    const response: any = await handler?.({}, undefined);

    expect(response).toEqual({ ok: false, error: 'Invalid JSON: the file does not contain valid JSON.' });
  });

  it('returns error for missing plugin fields during import', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/bad.json'] });
    mockReadFile.mockResolvedValue(JSON.stringify({ version: 1 }));

    const handler = registeredHandlers.get('plugins:import-plugin');
    const response: any = await handler?.({}, undefined);

    expect(response).toEqual({ ok: false, error: 'Invalid plugin file: missing "version" or "plugin" fields.' });
  });

  it('returns error for missing manifest fields during import', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/bad.json'] });
    mockReadFile.mockResolvedValue(JSON.stringify({
      version: 1,
      plugin: { manifest: { id: '' }, source: 'source' },
    }));

    const handler = registeredHandlers.get('plugins:import-plugin');
    const response: any = await handler?.({}, undefined);

    expect(response).toEqual({ ok: false, error: 'Invalid plugin manifest: "id" and "name" are required.' });
  });

  it('returns cancellation error when open dialog is cancelled', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    const handler = registeredHandlers.get('plugins:import-plugin');
    const response: any = await handler?.({}, undefined);

    expect(response).toEqual({ ok: false, error: 'Import cancelled.' });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  // ── Memory Search tests ───────────────────────────────────────────────

  it('searches workspace files via semanticSearchWithStatus with status ok', async () => {
    mockSemanticSearchWithStatus.mockResolvedValue({
      status: 'ok',
      results: [
        { path: '/Users/you/docs/review.md', relativePath: 'docs/review.md', snippet: 'Quarterly review notes...', score: 0.85, extension: '.md', chunkIndex: 0 },
        { path: '/Users/you/docs/goals.md', relativePath: 'docs/goals.md', snippet: 'Q1 goals and targets...', score: 0.72, extension: '.md', chunkIndex: 0 },
      ],
    });

    const handler = registeredHandlers.get('plugins:memory-search');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'quarterly review', limit: 10 });

    // Explicit plugin-initiated search opts into the F9 lexical exemption.
    expect(mockSemanticSearchWithStatus).toHaveBeenCalledWith('quarterly review', { limit: 10, lexicalExemption: true });
    expect(response).toEqual({
      status: 'ok',
      results: [
        { filePath: '/Users/you/docs/review.md', title: 'docs/review.md', snippet: 'Quarterly review notes...', score: 0.85 },
        { filePath: '/Users/you/docs/goals.md', title: 'docs/goals.md', snippet: 'Q1 goals and targets...', score: 0.72 },
      ],
    });
  });

  it('returns status ok with empty results for empty query', async () => {
    const handler = registeredHandlers.get('plugins:memory-search');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: '   ' });

    expect(mockSemanticSearch).not.toHaveBeenCalled();
    expect(response).toEqual({ status: 'ok', results: [] });
  });

  it('returns status error with message when semanticSearchWithStatus throws', async () => {
    mockSemanticSearchWithStatus.mockRejectedValue(new Error('Search engine failure'));

    const handler = registeredHandlers.get('plugins:memory-search');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'test query' });

    expect(response).toEqual({ status: 'error', results: [], message: 'Search engine failure' });
  });

  it('returns status index_not_ready when file index is not ready and scan not completed', async () => {
    mockIsFileIndexReady.mockReturnValue(false);
    mockGetScanCompletedAt.mockReturnValue(null);

    const handler = registeredHandlers.get('plugins:memory-search');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'test query' });

    expect(mockSemanticSearch).not.toHaveBeenCalled();
    expect(response).toEqual({ status: 'index_not_ready', results: [] });
  });

  it('returns status ok with empty results for empty workspace (scan done, no table)', async () => {
    mockIsFileIndexReady.mockReturnValue(false);
    mockGetScanCompletedAt.mockReturnValue(1711111111000);

    const handler = registeredHandlers.get('plugins:memory-search');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'test query' });

    expect(mockSemanticSearch).not.toHaveBeenCalled();
    expect(response).toEqual({ status: 'ok', results: [] });
  });

  it('returns status embedding_not_ready when embedding service is not ready', async () => {
    mockIsFileIndexReady.mockReturnValue(true);
    mockIsEmbeddingServiceReady.mockReturnValue(false);

    const handler = registeredHandlers.get('plugins:memory-search');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'test query' });

    expect(mockSemanticSearch).not.toHaveBeenCalled();
    expect(response).toEqual({ status: 'embedding_not_ready', results: [] });
  });

  it('returns status error with fallback message for non-Error throws', async () => {
    mockSemanticSearchWithStatus.mockRejectedValue('string error');

    const handler = registeredHandlers.get('plugins:memory-search');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'test query' });

    expect(response).toEqual({ status: 'error', results: [], message: 'Search failed' });
  });

  it('returns plugins and conflicts when scanning shared Spaces', async () => {
    mockScanSpacePlugins.mockResolvedValue({
      plugins: [
        {
          pluginId: 'meeting-prep',
          manifest: {
            id: 'meeting-prep',
            name: 'Meeting Prep',
            entryPoint: 'index.tsx',
            version: '0.1.0',
            maturity: 'labs',
          },
          source: 'export default function Plugin() { return null; }',
          spaceName: 'MySpace',
          spacePath: '/workspace/MySpace',
        },
      ],
      conflicts: [
        {
          pluginId: 'meeting-prep',
          conflictFiles: ['manifest (1).json'],
          spacePath: '/workspace/MySpace',
        },
      ],
    });

    const handler = registeredHandlers.get('plugins:scan-spaces');
    const response: any = await handler?.({}, undefined);

    expect(mockScanSpacePlugins).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      plugins: [
        {
          pluginId: 'meeting-prep',
          manifest: {
            id: 'meeting-prep',
            name: 'Meeting Prep',
            entryPoint: 'index.tsx',
            version: '0.1.0',
            maturity: 'labs',
          },
          source: 'export default function Plugin() { return null; }',
          spaceName: 'MySpace',
          spacePath: '/workspace/MySpace',
        },
      ],
      conflicts: [
        {
          pluginId: 'meeting-prep',
          conflictFiles: ['manifest (1).json'],
          spacePath: '/workspace/MySpace',
        },
      ],
    });
  });

  it('resolves plugin conflict with keep-mine/keep-theirs strategy', async () => {
    mockResolvePluginConflict.mockResolvedValue({ success: true });

    const handler = registeredHandlers.get('plugins:resolve-conflict');
    const response: any = await handler?.({}, {
      pluginId: 'meeting-prep',
      spacePath: '/workspace/MySpace',
      resolution: 'keep-theirs',
    });

    expect(mockResolvePluginConflict).toHaveBeenCalledWith(
      'meeting-prep',
      '/workspace/MySpace',
      'keep-theirs',
    );
    expect(response).toEqual({ success: true });
  });

  // ── Activation list tests ────────────────────────────────────────────

  it('loads activated plugin IDs', async () => {
    mockGetActivatedPluginIds.mockReturnValue(['meeting-prep', 'inbox-triage']);

    const handler = registeredHandlers.get('plugins:get-activated');
    const response: any = await handler?.({}, undefined);

    expect(mockGetActivatedPluginIds).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ pluginIds: ['meeting-prep', 'inbox-triage'] });
  });

  it('adds an activated plugin ID', async () => {
    const handler = registeredHandlers.get('plugins:add-activated');
    const response: any = await handler?.({}, { pluginId: 'meeting-prep' });

    expect(mockAddActivatedPluginId).toHaveBeenCalledWith('meeting-prep');
    expect(response).toEqual({ success: true });
  });

  it('removes an activated plugin ID', async () => {
    const handler = registeredHandlers.get('plugins:remove-activated');
    const response: any = await handler?.({}, { pluginId: 'meeting-prep' });

    expect(mockRemoveActivatedPluginId).toHaveBeenCalledWith('meeting-prep');
    expect(response).toEqual({ success: true });
  });

  it('indexes README for an activated Space plugin', async () => {
    mockIndexPluginReadme.mockResolvedValue(undefined);

    const handler = registeredHandlers.get('plugins:index-readme');
    const response: any = await handler?.({}, { pluginId: 'meeting-prep', spacePath: '/workspace/MySpace' });

    expect(mockIndexPluginReadme).toHaveBeenCalledWith(
      '/workspace/MySpace/plugins/meeting-prep',
      '/workspace',
    );
    expect(response).toEqual({ success: true });
  });

  it('deindexes README for a deactivated Space plugin', async () => {
    mockDeindexPluginReadme.mockResolvedValue(undefined);

    const handler = registeredHandlers.get('plugins:deindex-readme');
    const response: any = await handler?.({}, { pluginId: 'meeting-prep', spacePath: '/workspace/MySpace' });

    expect(mockDeindexPluginReadme).toHaveBeenCalledWith('/workspace/MySpace/plugins/meeting-prep');
    expect(response).toEqual({ success: true });
  });

  // ── Source Search tests ───────────────────────────────────────────────

  it('searches sources and returns mapped entries', async () => {
    mockSearchSources.mockResolvedValue({
      sources: [
        {
          relativePath: 'memory/sources/meetings/2026-03-25_standup.md',
          title: 'Daily Standup',
          sourceType: 'meeting',
          sourceSystem: 'recall',
          occurredAt: '2026-03-25T09:00:00Z',
          participants: ['Alice', 'Bob'],
          summary: 'Discussed sprint goals',
          keyTakeaways: ['Ship by Friday'],
          durationMinutes: 15,
          description: 'Morning standup',
          sourceUrl: 'https://recall.ai/123',
          relevanceScore: 0.92,
        },
      ],
      totalCount: 1,
    });

    const handler = registeredHandlers.get('plugins:search-sources');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'standup', limit: 10 });

    expect(mockSearchSources).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      sources: [
        {
          relativePath: 'memory/sources/meetings/2026-03-25_standup.md',
          title: 'Daily Standup',
          sourceType: 'meeting',
          sourceSystem: 'recall',
          occurredAt: '2026-03-25T09:00:00Z',
          participants: ['Alice', 'Bob'],
          summary: 'Discussed sprint goals',
          keyTakeaways: ['Ship by Friday'],
          durationMinutes: 15,
          description: 'Morning standup',
          sourceUrl: 'https://recall.ai/123',
          relevanceScore: 0.92,
        },
      ],
      totalCount: 1,
    });
  });

  it('returns empty sources when no matches found', async () => {
    mockSearchSources.mockResolvedValue({ sources: [], totalCount: 0 });

    const handler = registeredHandlers.get('plugins:search-sources');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'nonexistent topic' });

    expect(mockSearchSources).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ sources: [], totalCount: 0 });
  });

  it('propagates error when source search fails', async () => {
    mockSearchSources.mockRejectedValue(new Error('Store unavailable'));

    const handler = registeredHandlers.get('plugins:search-sources');
    await expect(handler?.({}, { pluginId: 'test-plugin', query: 'test' })).rejects.toThrow('Source search failed: Store unavailable');
  });

  it('back-compat: strips the core status field, returning exactly { sources, totalCount }', async () => {
    // Core now returns a `status` field; the plugin IPC response must NOT leak
    // it (plugin-path honesty is a tracked follow-up). Back-compat with the
    // existing { sources, totalCount } contract.
    mockSearchSources.mockResolvedValue({ sources: [], totalCount: 0, status: 'error' });

    const handler = registeredHandlers.get('plugins:search-sources');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: 'anything' });

    expect(mockSearchSources).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ sources: [], totalCount: 0 });
    expect(response).not.toHaveProperty('status');
  });

  // ── Entity Search tests ──────────────────────────────────────────────

  it('searches entities and returns plugin-safe metadata', async () => {
    mockSearchEntities.mockReturnValue({
      entities: [
        {
          filePath: '/workspace/Chief-of-Staff/memory/topics/people/sarah-chen.md',
          relativePath: 'Chief-of-Staff/memory/topics/people/sarah-chen.md',
          spacePath: 'Chief-of-Staff',
          indexedAt: 1711111111000,
          mtime: 1711111111000,
          canonicalName: 'Sarah Chen',
          entityType: 'person',
          emails: ['[external-email]'],
          company: 'Acme',
          role: 'Head of Sales',
          aliases: ['Sarah C'],
        },
      ],
      totalCount: 1,
    });

    const handler = registeredHandlers.get('plugins:get-entities');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      entityType: 'person',
      query: '  sarah ',
      company: ' Acme ',
      limit: 25,
    });

    expect(mockSearchEntities).toHaveBeenCalledWith({
      entityType: 'person',
      name: 'sarah',
      company: 'Acme',
      limit: 25,
    });
    expect(response).toEqual({
      entities: [
        {
          canonicalName: 'Sarah Chen',
          entityType: 'person',
          emails: ['[external-email]'],
          company: 'Acme',
          role: 'Head of Sales',
          domain: undefined,
          aliases: ['Sarah C'],
        },
      ],
    });
  });

  it('uses defaults and omits blank query/company filters', async () => {
    mockSearchEntities.mockReturnValue({ entities: [], totalCount: 0 });

    const handler = registeredHandlers.get('plugins:get-entities');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', query: '   ', company: '  ' });

    expect(mockSearchEntities).toHaveBeenCalledWith({
      entityType: undefined,
      name: undefined,
      company: undefined,
      limit: 20,
    });
    expect(response).toEqual({ entities: [] });
  });

  it('propagates error when entity search fails', async () => {
    mockSearchEntities.mockImplementation(() => {
      throw new Error('Entity store unavailable');
    });

    const handler = registeredHandlers.get('plugins:get-entities');
    await expect(handler?.({}, { pluginId: 'test-plugin', query: 'sarah' })).rejects.toThrow('Entity search failed: Entity store unavailable');
  });

  // ── Source Document tests ─────────────────────────────────────────────

  it('returns full document with frontmatter stripped', async () => {
    mockGetSource.mockReturnValue({
      relativePath: 'memory/sources/meetings/standup.md',
      title: 'Standup',
      sourceType: 'meeting',
      sourceSystem: 'recall',
      occurredAt: '2026-03-25T09:00:00Z',
      storedAt: '2026-03-25T10:00:00Z',
      participants: ['Alice'],
      summary: 'Summary text',
      keyTakeaways: ['Key 1'],
      durationMinutes: 15,
      truncated: false,
      description: 'Morning standup',
      sourceUrl: '',
    });
    mockReadFile.mockResolvedValue('---\ntitle: Standup\n---\n# Meeting Notes\nSome content here.');

    const handler = registeredHandlers.get('plugins:get-source-document');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'test-plugin', relativePath: 'memory/sources/meetings/standup.md' });

    expect(mockGetSource).toHaveBeenCalledTimes(1);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      document: {
        relativePath: 'memory/sources/meetings/standup.md',
        title: 'Standup',
        sourceType: 'meeting',
        sourceSystem: 'recall',
        occurredAt: '2026-03-25T09:00:00Z',
        storedAt: '2026-03-25T10:00:00Z',
        participants: ['Alice'],
        summary: 'Summary text',
        keyTakeaways: ['Key 1'],
        durationMinutes: 15,
        truncated: false,
        description: 'Morning standup',
        sourceUrl: undefined,
        content: '# Meeting Notes\nSome content here.',
      },
    });
  });

  it('rejects source document reads outside memory/sources/', async () => {
    const handler = registeredHandlers.get('plugins:get-source-document');

    const response: any = await handler?.({}, { pluginId: 'test-plugin', relativePath: 'docs/secret.md' });

    expect(response).toEqual({ document: null });
    expect(mockGetSource).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('rejects source document reads with path traversal', async () => {
    const handler = registeredHandlers.get('plugins:get-source-document');

    const response: any = await handler?.({}, { pluginId: 'test-plugin', relativePath: 'memory/sources/../../etc/passwd' });

    expect(response).toEqual({ document: null });
    expect(mockGetSource).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('returns null document when source not found in metadata store', async () => {
    mockGetSource.mockReturnValue(undefined);

    const handler = registeredHandlers.get('plugins:get-source-document');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', relativePath: 'memory/sources/meetings/missing.md' });

    expect(mockGetSource).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ document: null });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('propagates error when source document file read fails', async () => {
    mockGetSource.mockReturnValue({
      relativePath: 'memory/sources/meetings/corrupt.md',
      title: 'Corrupt',
      sourceType: 'meeting',
      sourceSystem: 'recall',
      occurredAt: '2026-03-25T09:00:00Z',
    });
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const handler = registeredHandlers.get('plugins:get-source-document');
    await expect(
      handler?.({}, { pluginId: 'test-plugin', relativePath: 'memory/sources/meetings/corrupt.md' }),
    ).rejects.toThrow('Source document read failed: ENOENT: no such file');
  });

  // ── Skill File Read tests ─────────────────────────────────────────────

  it('reads a skill file and returns body + frontmatter', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'Chief-of-Staff' }],
    });
    mockReadFile.mockResolvedValue('---\nname: Daily Prep\nowner: Ops\nsteps: 3\n---\n# Workflow\n\nDo the thing.');

    const handler = registeredHandlers.get('plugins:read-skill');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'test-plugin', relativePath: 'Chief-of-Staff/skills/daily-prep.md' });

    expect(mockReadFile).toHaveBeenCalledWith('/workspace/Chief-of-Staff/skills/daily-prep.md', 'utf-8');
    expect(response).toEqual({
      content: '# Workflow\n\nDo the thing.',
      frontmatter: {
        name: 'Daily Prep',
        owner: 'Ops',
        steps: 3,
      },
    });
  });

  it('supports skills/ shorthand path by resolving across configured spaces', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'Chief-of-Staff' }],
    });
    mockReadFile.mockResolvedValue('# Workflow\n\nNo frontmatter.');

    const handler = registeredHandlers.get('plugins:read-skill');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', relativePath: 'skills/daily-prep.md' });

    expect(mockReadFile).toHaveBeenCalledWith('/workspace/Chief-of-Staff/skills/daily-prep.md', 'utf-8');
    expect(response).toEqual({
      content: '# Workflow\n\nNo frontmatter.',
      frontmatter: {},
    });
  });

  it('rejects skill reads outside skills/ and blocks traversal', async () => {
    const handler = registeredHandlers.get('plugins:read-skill');

    const outsideResponse = await handler?.({}, { pluginId: 'test-plugin', relativePath: 'Chief-of-Staff/memory/topics/notes.md' });
    const traversalResponse = await handler?.({}, { pluginId: 'test-plugin', relativePath: '../Chief-of-Staff/skills/secret.md' });

    expect(outsideResponse).toEqual({ content: null, frontmatter: null });
    expect(traversalResponse).toEqual({ content: null, frontmatter: null });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  // ── Skill File Write tests ────────────────────────────────────────────

  it('writes a skill file through sharedSkillMutationService', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'Chief-of-Staff' }],
    });
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'skill-plugin',
          name: 'Skill Plugin',
          entryPoint: 'index.tsx',
          permissions: ['skills:write'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);
    mockWriteManagedSkillFile.mockResolvedValue({
      conflict: false,
      currentHash: 'a'.repeat(64),
      path: '/workspace/Chief-of-Staff/skills/daily-prep.md',
      updatedAt: Date.now(),
      content: '# Updated',
      target: {
        relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      },
    });

    const handler = registeredHandlers.get('plugins:write-skill');
    const response: any = await handler?.({}, {
      pluginId: 'skill-plugin',
      relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      content: '# Updated',
      baseContentHash: 'b'.repeat(64),
    });

    expect(mockWriteManagedSkillFile).toHaveBeenCalledWith(
      '/workspace/Chief-of-Staff/skills/daily-prep.md',
      '# Updated',
      '/workspace',
      {
        kind: 'agent',
        user: { id: 'user-1', name: 'Test User', email: 'test@example.com', image: null },
      },
      expect.objectContaining({
        baseContentHash: 'b'.repeat(64),
        pluginId: 'skill-plugin',
      }),
    );
    expect(response).toEqual({
      ok: true,
      currentHash: 'a'.repeat(64),
    });
  });

  it('rejects skill writes without skills:write permission', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'Chief-of-Staff' }],
    });
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'skill-plugin',
          name: 'Skill Plugin',
          entryPoint: 'index.tsx',
          permissions: ['skills:read'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);

    const handler = registeredHandlers.get('plugins:write-skill');
    const response: any = await handler?.({}, {
      pluginId: 'skill-plugin',
      relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      content: '# Updated',
    });

    expect(response).toEqual({
      ok: false,
      error: 'Plugin "skill-plugin" is not authorized for "skills:write".',
    });
    expect(mockWriteManagedSkillFile).not.toHaveBeenCalled();
  });

  it('rejects skill writes outside skills/ paths', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'Chief-of-Staff' }],
    });
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'skill-plugin',
          name: 'Skill Plugin',
          entryPoint: 'index.tsx',
          permissions: ['skills:write'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);

    const handler = registeredHandlers.get('plugins:write-skill');
    const response: any = await handler?.({}, {
      pluginId: 'skill-plugin',
      relativePath: 'Chief-of-Staff/memory/topics/notes.md',
      content: '# Updated',
    });

    expect(response).toEqual({
      ok: false,
      error: 'Invalid skill path. Writes are restricted to configured skills directories.',
    });
    expect(mockWriteManagedSkillFile).not.toHaveBeenCalled();
  });

  it('returns conflict details when managed write reports conflict', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'Chief-of-Staff' }],
    });
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'skill-plugin',
          name: 'Skill Plugin',
          entryPoint: 'index.tsx',
          permissions: ['skills:write'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);
    mockWriteManagedSkillFile.mockResolvedValue({
      conflict: true,
      currentHash: 'c'.repeat(64),
      path: '/workspace/Chief-of-Staff/skills/daily-prep.md',
    });

    const handler = registeredHandlers.get('plugins:write-skill');
    const response: any = await handler?.({}, {
      pluginId: 'skill-plugin',
      relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      content: '# Updated',
      baseContentHash: 'b'.repeat(64),
    });

    expect(response).toEqual({
      ok: false,
      conflict: true,
      currentHash: 'c'.repeat(64),
    });
  });

  it('returns error payload when managed write throws', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'Chief-of-Staff' }],
    });
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'skill-plugin',
          name: 'Skill Plugin',
          entryPoint: 'index.tsx',
          permissions: ['skills:write'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);
    mockWriteManagedSkillFile.mockRejectedValue(new Error('Disk write failed'));

    const handler = registeredHandlers.get('plugins:write-skill');
    const response: any = await handler?.({}, {
      pluginId: 'skill-plugin',
      relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      content: '# Updated',
    });

    expect(response).toEqual({
      ok: false,
      error: 'Disk write failed',
    });
  });

  // ── AI Summarize tests ────────────────────────────────────────────────

  it('summarizes text via BTS client', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: 'This is a concise summary.' }],
    });

    const handler = registeredHandlers.get('plugins:ai-summarize');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'my-plugin', text: 'Long text to summarize...' });

    expect(mockCheckRateLimit).toHaveBeenCalledWith('my-plugin');
    expect(mockRecordCall).toHaveBeenCalledWith('my-plugin');
    expect(mockCallBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ summary: 'This is a concise summary.' });
  });

  it('throws when AI summarize rate limit is exceeded', async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 45000 });

    const handler = registeredHandlers.get('plugins:ai-summarize');
    await expect(
      handler?.({}, { pluginId: 'my-plugin', text: 'Some text' }),
    ).rejects.toThrow('Rate limit exceeded for plugin "my-plugin". Try again in 45s.');

    expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
    expect(mockRecordCall).not.toHaveBeenCalled();
  });

  it.each([
    [
      'plugins:ai-summarize',
      { pluginId: 'my-plugin', text: 'Some text' },
      'summarize',
    ],
    [
      'plugins:ai-extract',
      {
        pluginId: 'my-plugin',
        text: 'Some text',
        schema: { name: 'Test', description: 'Test schema', properties: {} },
      },
      'extract',
    ],
    [
      'plugins:ai-generate',
      { pluginId: 'my-plugin', prompt: 'Some text' },
      'generate',
    ],
  ] as const)('humanizes billing errors for %s and reports raw payload to Sentry', async (channel, request, operation) => {
    const rawMessage = '402 {"error":{"message":"This request requires more credits, or fewer max_tokens."}}';
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new ModelError(
        'billing',
        'This request requires more credits, or fewer max_tokens.',
        402,
        'OpenRouter',
        { rawMessage },
      ),
    );

    const handler = registeredHandlers.get(channel);
    // Stage 6b: classification-first humanization now produces subtype+provider-aware copy.
    // See docs/plans/260421_classification_driven_error_humanizer.md.
    await expect(
      handler?.({}, request),
    ).rejects.toThrow(
      'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
    );

    expect(mockCapturePluginAiException).toHaveBeenCalledWith(
      expect.any(ModelError),
      expect.objectContaining({
        tags: expect.objectContaining({
          plugin_id: 'my-plugin',
          operation,
          error_kind: 'billing',
          surface: 'plugin_ai',
        }),
        extra: expect.objectContaining({
          rawError: rawMessage,
        }),
      }),
    );
  });

  // ── AI Extract tests ──────────────────────────────────────────────────

  it('extracts structured data via BTS structured_output', async () => {
    const extractedData = { name: 'John', role: 'Engineer' };
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      structured_output: extractedData,
      content: [{ type: 'text', text: '{"name":"John","role":"Engineer"}' }],
    });

    const handler = registeredHandlers.get('plugins:ai-extract');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, {
      pluginId: 'my-plugin',
      text: 'John is an engineer at Acme Corp.',
      schema: { name: 'PersonInfo', description: 'Extract person info', properties: { name: { type: 'string' }, role: { type: 'string' } } },
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith('my-plugin');
    expect(mockRecordCall).toHaveBeenCalledWith('my-plugin');
    expect(response).toEqual({ result: extractedData });
  });

  it('falls back to parsing text content when structured_output is null', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      structured_output: null,
      content: [{ type: 'text', text: '{"name":"Jane","role":"Designer"}' }],
    });

    const handler = registeredHandlers.get('plugins:ai-extract');
    const response: any = await handler?.({}, {
      pluginId: 'my-plugin',
      text: 'Jane is a designer.',
      schema: { name: 'PersonInfo', description: 'Extract person info', properties: { name: { type: 'string' } } },
    });

    expect(response).toEqual({ result: { name: 'Jane', role: 'Designer' } });
  });

  it('throws when JSON parse fails on text fallback in AI extract', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      structured_output: null,
      content: [{ type: 'text', text: 'not valid json' }],
    });

    const handler = registeredHandlers.get('plugins:ai-extract');
    await expect(
      handler?.({}, {
        pluginId: 'my-plugin',
        text: 'Some text',
        schema: { name: 'Test', description: 'Test schema', properties: {} },
      }),
    ).rejects.toThrow('Failed to parse structured output from LLM response');
  });

  // ── AI Generate tests ─────────────────────────────────────────────────

  it('generates text via BTS client', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: 'Generated response text here.' }],
    });

    const handler = registeredHandlers.get('plugins:ai-generate');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'my-plugin', prompt: 'Write a haiku about code.' });

    expect(mockCheckRateLimit).toHaveBeenCalledWith('my-plugin');
    expect(mockRecordCall).toHaveBeenCalledWith('my-plugin');
    expect(mockCallBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ text: 'Generated response text here.' });
  });

  it('throws when AI generate rate limit is exceeded', async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });

    const handler = registeredHandlers.get('plugins:ai-generate');
    await expect(
      handler?.({}, { pluginId: 'my-plugin', prompt: 'Write something' }),
    ).rejects.toThrow('Rate limit exceeded for plugin "my-plugin". Try again in 30s.');

    expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
  });

  it('propagates BTS error in AI generate', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(new Error('Authentication failed'));

    const handler = registeredHandlers.get('plugins:ai-generate');
    await expect(
      handler?.({}, { pluginId: 'my-plugin', prompt: 'Write something' }),
    ).rejects.toThrow('Authentication failed');
  });

  // ── Meeting Cache tests ──────────────────────────────────────────────

  it('returns all cached meetings mapped to plugin-safe shape', async () => {
    mockGetCachedMeetings.mockReturnValue({
      meetings: [
        {
          id: 'google:event123',
          calendarEventId: 'event123',
          calendarSource: 'user@example.com',
          title: 'Weekly Standup',
          startTime: '2026-03-26T09:00:00Z',
          endTime: '2026-03-26T09:30:00Z',
          meetingUrl: 'https://meet.google.com/abc',
          participants: ['Alice', 'Bob'],
          participantEmails: ['alice@example.com', 'bob@example.com'],
          prepPath: '/Users/test/.mindstone/prep123.md',
        },
      ],
      populatedAt: Date.now(),
    });
    mockIsCacheStale.mockReturnValue(false);

    const handler = registeredHandlers.get('plugins:get-meetings');
    expect(handler).toBeDefined();

    const response: any = await handler?.({}, { pluginId: 'test-plugin' });

    expect(response.meetings).toHaveLength(1);
    expect(response.meetings[0]).toEqual({
      id: 'google:event123',
      title: 'Weekly Standup',
      startTime: '2026-03-26T09:00:00Z',
      endTime: '2026-03-26T09:30:00Z',
      participants: ['Alice', 'Bob'],
      meetingUrl: 'https://meet.google.com/abc',
    });
    // Sensitive fields must NOT be present
    expect(response.meetings[0].calendarEventId).toBeUndefined();
    expect(response.meetings[0].calendarSource).toBeUndefined();
    expect(response.meetings[0].participantEmails).toBeUndefined();
    expect(response.meetings[0].prepPath).toBeUndefined();
    expect(response.isStale).toBe(false);
  });

  it('returns today-only meetings when todayOnly is true', async () => {
    const todayMeetings = [
      {
        id: 'google:today1',
        calendarEventId: 'today1',
        calendarSource: 'user@example.com',
        title: 'Morning Standup',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        participants: ['Alice'],
      },
    ];
    mockGetTodaysMeetings.mockReturnValue(todayMeetings);
    mockIsCacheStale.mockReturnValue(false);

    const handler = registeredHandlers.get('plugins:get-meetings');
    const response: any = await handler?.({}, { pluginId: 'test-plugin', todayOnly: true });

    expect(mockGetTodaysMeetings).toHaveBeenCalledTimes(1);
    expect(mockGetCachedMeetings).not.toHaveBeenCalled();
    expect(response.meetings).toHaveLength(1);
    expect(response.meetings[0].title).toBe('Morning Standup');
  });

  it('returns empty meetings and isStale=true when cache is null', async () => {
    mockGetCachedMeetings.mockReturnValue(null);
    mockIsCacheStale.mockReturnValue(true);

    const handler = registeredHandlers.get('plugins:get-meetings');
    const response: any = await handler?.({}, { pluginId: 'test-plugin' });

    expect(response.meetings).toEqual([]);
    expect(response.isStale).toBe(true);
  });

  it('returns isStale=true when cache is stale', async () => {
    mockGetCachedMeetings.mockReturnValue({
      meetings: [{
        id: 'm1', calendarEventId: 'e1', calendarSource: 'test', title: 'Old Meeting',
        startTime: '2026-03-25T09:00:00Z', endTime: '2026-03-25T10:00:00Z', participants: [],
      }],
      populatedAt: Date.now() - 5 * 60 * 60 * 1000, // 5 hours ago
    });
    mockIsCacheStale.mockReturnValue(true);

    const handler = registeredHandlers.get('plugins:get-meetings');
    const response: any = await handler?.({}, { pluginId: 'test-plugin' });

    expect(response.meetings).toHaveLength(1);
    expect(response.isStale).toBe(true);
  });

  // ── Permission Denial tests ─────────────────────────────────────────

  it('denies memory-search when plugin lacks memory:read permission', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'no-read-plugin',
          name: 'No Read Plugin',
          entryPoint: 'index.tsx',
          permissions: ['skills:write'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);

    const handler = registeredHandlers.get('plugins:memory-search');
    const response: any = await handler?.({}, { pluginId: 'no-read-plugin', query: 'test query' });

    expect(response).toEqual({ status: 'ok', results: [] });
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('denies get-entities when plugin lacks entities:read permission', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'no-entity-plugin',
          name: 'No Entity Plugin',
          entryPoint: 'index.tsx',
          permissions: ['memory:read'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);

    const handler = registeredHandlers.get('plugins:get-entities');
    const response: any = await handler?.({}, { pluginId: 'no-entity-plugin', query: 'sarah' });

    expect(response).toEqual({ entities: [] });
    expect(mockSearchEntities).not.toHaveBeenCalled();
  });

  it('denies read-skill when plugin lacks skills:read permission', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'no-skill-plugin',
          name: 'No Skill Plugin',
          entryPoint: 'index.tsx',
          permissions: ['memory:read'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);
    mockGetSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'Chief-of-Staff' }],
    });

    const handler = registeredHandlers.get('plugins:read-skill');
    const response: any = await handler?.({}, { pluginId: 'no-skill-plugin', relativePath: 'Chief-of-Staff/skills/daily-prep.md' });

    expect(response).toEqual({ content: null, frontmatter: null });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('denies get-meetings when plugin lacks memory:read permission', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'no-meeting-plugin',
          name: 'No Meeting Plugin',
          entryPoint: 'index.tsx',
          permissions: ['skills:write'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);
    mockGetCachedMeetings.mockReturnValue({
      meetings: [{
        id: 'm1', calendarEventId: 'e1', calendarSource: 'test', title: 'Meeting',
        startTime: '2026-03-26T09:00:00Z', endTime: '2026-03-26T10:00:00Z', participants: [],
      }],
      populatedAt: Date.now(),
    });

    const handler = registeredHandlers.get('plugins:get-meetings');
    const response: any = await handler?.({}, { pluginId: 'no-meeting-plugin' });

    expect(response).toEqual({ meetings: [], isStale: true });
    expect(mockGetCachedMeetings).not.toHaveBeenCalled();
  });

  it('denies search-sources when plugin lacks memory:read permission', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'no-source-plugin',
          name: 'No Source Plugin',
          entryPoint: 'index.tsx',
          permissions: ['entities:read'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);

    const handler = registeredHandlers.get('plugins:search-sources');
    const response: any = await handler?.({}, { pluginId: 'no-source-plugin', query: 'standup' });

    expect(response).toEqual({ sources: [], totalCount: 0 });
    expect(mockSearchSources).not.toHaveBeenCalled();
  });

  it('denies get-source-document when plugin lacks memory:read permission', async () => {
    mockLoadPersistedPluginEntries.mockResolvedValue([
      {
        manifest: {
          id: 'no-doc-plugin',
          name: 'No Doc Plugin',
          entryPoint: 'index.tsx',
          permissions: ['skills:read'],
        },
        source: 'export default function Plugin() { return null; }',
      },
    ]);

    const handler = registeredHandlers.get('plugins:get-source-document');
    const response: any = await handler?.({}, { pluginId: 'no-doc-plugin', relativePath: 'memory/sources/meetings/standup.md' });

    expect(response).toEqual({ document: null });
    expect(mockGetSource).not.toHaveBeenCalled();
  });
});

// ── Plugin Inbox Actions ────────────────────────────────────────────────

describe('plugins:inbox-add', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    mockAddInboxItem.mockReset();
    mockGetInboxState.mockReset();
    mockGetSettings.mockReturnValue({ coreDirectory: '/workspace' });
    _resetPluginInboxAddRateLimiterForTesting();
    registerPluginHandlers();
  });

  it('adds inbox item with plugin attribution and mapped priority', async () => {
    mockAddInboxItem.mockReturnValue({
      accepted: true,
      itemId: '123e4567-e89b-12d3-a456-426614174000',
      state: { version: 1, items: [], history: [] },
    });

    const handler = registeredHandlers.get('plugins:inbox-add');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      item: {
        title: '  Follow up with finance team  ',
        description: '  Include updated variance numbers.  ',
        priority: 'high',
        actionPrompt: '  Draft a concise follow-up message to finance.  ',
      },
    });

    expect(mockAddInboxItem).toHaveBeenCalledWith({
      title: 'Follow up with finance team',
      text: 'Draft a concise follow-up message to finance.\n\nContext:\nInclude updated variance numbers.',
      draft: 'Draft a concise follow-up message to finance.',
      priority: 'p1',
      urgent: true,
      important: true,
      category: 'system',
      source: {
        kind: 'automation',
        automationId: 'plugin:test-plugin',
        automationName: 'test-plugin',
        label: 'Plugin: test-plugin',
      },
    });
    expect(response).toEqual({ ok: true, itemId: '123e4567-e89b-12d3-a456-426614174000' });
  });

  it('enforces 10 items per minute rate limit per plugin', async () => {
    mockAddInboxItem.mockReturnValue({
      accepted: true,
      itemId: '123e4567-e89b-12d3-a456-426614174000',
      state: { version: 1, items: [], history: [] },
    });

    const handler = registeredHandlers.get('plugins:inbox-add');
    expect(handler).toBeDefined();

    for (let i = 0; i < 10; i += 1) {
      const response: any = await handler?.({}, {
        pluginId: 'rate-plugin',
        item: { title: `Task ${i + 1}` },
      });
      expect(response).toEqual({ ok: true, itemId: '123e4567-e89b-12d3-a456-426614174000' });
    }

    const rateLimitedResponse: any = await handler?.({}, {
      pluginId: 'rate-plugin',
      item: { title: 'Task 11' },
    });
    expect(rateLimitedResponse.ok).toBe(false);
    expect(rateLimitedResponse.error).toContain('Rate limit exceeded for plugin "rate-plugin"');

    expect(mockAddInboxItem).toHaveBeenCalledTimes(10);
  });

  it('returns error envelope when inbox add is rejected by inbox store', async () => {
    mockAddInboxItem.mockReturnValue({
      accepted: false,
      rejectedReason: 'Duplicate of active item "Follow up with finance"',
      state: { version: 1, items: [], history: [] },
    });

    const handler = registeredHandlers.get('plugins:inbox-add');

    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      item: { title: 'Follow up with finance' },
    });
    expect(response).toEqual({
      ok: false,
      error: 'Duplicate of active item "Follow up with finance"',
    });
  });
});

describe('plugins:inbox-list', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    mockGetInboxState.mockReset();
    mockGetSettings.mockReturnValue({ coreDirectory: '/workspace' });
    _resetPluginInboxAddRateLimiterForTesting();
    registerPluginHandlers();
  });

  it('returns active items sorted by newest first with mapped plugin fields', async () => {
    mockGetInboxState.mockReturnValue({
      version: 1,
      items: [
        {
          id: 'plugin-item',
          title: 'Follow up with finance',
          text: 'Draft a concise follow-up message.\n\nContext:\nInclude Q1 variance notes.',
          draft: 'Draft a concise follow-up message.',
          priority: 'p1',
          urgent: true,
          important: true,
          source: {
            kind: 'automation',
            automationId: 'plugin:test-plugin',
            automationName: 'test-plugin',
          },
          references: [],
          addedAt: 2000,
          archived: false,
        },
        {
          id: 'manual-item',
          title: 'Review vendor invoice',
          text: 'Check line items and approve if correct.',
          urgent: false,
          important: false,
          references: [],
          addedAt: 1500,
          archived: false,
        },
        {
          id: 'archived-item',
          title: 'Old archived item',
          text: 'Archived',
          references: [],
          addedAt: 1000,
          archived: true,
        },
      ],
      history: [],
    });

    const handler = registeredHandlers.get('plugins:inbox-list');
    const response: any = await handler?.({}, { limit: 2 });

    expect(response).toEqual({
      items: [
        {
          itemId: 'plugin-item',
          title: 'Follow up with finance',
          description: 'Include Q1 variance notes.',
          priority: 'high',
          actionPrompt: 'Draft a concise follow-up message.',
          pluginId: 'test-plugin',
          createdAt: 2000,
          archived: false,
        },
        {
          itemId: 'manual-item',
          title: 'Review vendor invoice',
          description: 'Check line items and approve if correct.',
          priority: 'low',
          createdAt: 1500,
          archived: false,
        },
      ],
    });
  });
});

// ── Plugin Conversation Actions ─────────────────────────────────────────

describe('plugins:send-message', () => {
  beforeEach(() => {
    _invalidatePermissionCacheForTesting();
    mockCheckMessageRateLimit.mockReset();
    mockRecordMessageCall.mockReset();
    mockGetSession.mockReset();
    mockSendToAllWindows.mockReset();
    mockLoadPersistedPluginEntries.mockResolvedValue([
      { manifest: { id: 'test-plugin', permissions: ['conversations:write'], externalDomains: [] } },
    ]);
  });

  it('sends message to existing conversation', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: true });
    mockGetSession.mockResolvedValue({ id: 'session-1', deletedAt: null, privateMode: false });

    const handler = registeredHandlers.get('plugins:send-message');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      sessionId: 'session-1',
      message: 'Hello from plugin',
    });

    expect(response).toEqual({ ok: true });
    expect(mockRecordMessageCall).toHaveBeenCalledWith('test-plugin');
    expect(mockSendToAllWindows).toHaveBeenCalledWith('conversations:send-requested', {
      sessionId: 'session-1',
      text: 'Hello from plugin',
      sendMessage: true,
      switchToConversation: false,
      pluginAttribution: 'test-plugin',
    });
  });

  it('returns error when rate limited', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });

    const handler = registeredHandlers.get('plugins:send-message');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      sessionId: 'session-1',
      message: 'Hello',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Rate limit exceeded');
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('explains how to fix missing conversations:write permission', async () => {
    _invalidatePermissionCacheForTesting();
    mockLoadPersistedPluginEntries.mockResolvedValue([
      { manifest: { id: 'test-plugin', permissions: ['conversations:read'], externalDomains: [] } },
    ]);

    const handler = registeredHandlers.get('plugins:send-message');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      sessionId: 'session-1',
      message: 'Hello',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain('not authorized for "conversations:write"');
    expect(response.error).toContain('update the plugin manifest');
    expect(response.error).toContain('Settings > Plugins');
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('returns error when session not found', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: true });
    mockGetSession.mockResolvedValue(null);

    const handler = registeredHandlers.get('plugins:send-message');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      sessionId: 'nonexistent',
      message: 'Hello',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toBe('Session not found.');
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('returns error when session is deleted', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: true });
    mockGetSession.mockResolvedValue({ id: 'session-1', deletedAt: Date.now(), privateMode: false });

    const handler = registeredHandlers.get('plugins:send-message');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      sessionId: 'session-1',
      message: 'Hello',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toBe('Session not found.');
  });

  it('returns error when session is private', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: true });
    mockGetSession.mockResolvedValue({ id: 'session-1', deletedAt: null, privateMode: true });

    const handler = registeredHandlers.get('plugins:send-message');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      sessionId: 'session-1',
      message: 'Hello',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toBe('Session not found.');
  });

  it('trims message whitespace', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: true });
    mockGetSession.mockResolvedValue({ id: 'session-1', deletedAt: null, privateMode: false });

    const handler = registeredHandlers.get('plugins:send-message');
    await handler?.({}, {
      pluginId: 'test-plugin',
      sessionId: 'session-1',
      message: '  Hello  ',
    });

    expect(mockSendToAllWindows).toHaveBeenCalledWith('conversations:send-requested', expect.objectContaining({
      text: 'Hello',
    }));
  });
});

describe('plugins:start-conversation', () => {
  beforeEach(() => {
    _invalidatePermissionCacheForTesting();
    mockCheckMessageRateLimit.mockReset();
    mockRecordMessageCall.mockReset();
    mockSendToAllWindows.mockReset();
    mockLoadPersistedPluginEntries.mockResolvedValue([
      { manifest: { id: 'test-plugin', permissions: ['conversations:write'], externalDomains: [] } },
    ]);
  });

  it('starts a new conversation', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: true });

    const handler = registeredHandlers.get('plugins:start-conversation');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      message: 'Start a new research task',
    });

    expect(response.ok).toBe(true);
    expect(response.sessionId).toBeDefined();
    expect(typeof response.sessionId).toBe('string');
    expect(response.sessionId.length).toBeGreaterThan(0);
    expect(mockRecordMessageCall).toHaveBeenCalledWith('test-plugin');
    expect(mockSendToAllWindows).toHaveBeenCalledWith('conversations:start-requested', {
      sessionId: response.sessionId,
      text: 'Start a new research task',
      sendMessage: true,
      switchToConversation: false,
      pluginAttribution: 'test-plugin',
    });
  });

  it('returns error when rate limited', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 45000 });

    const handler = registeredHandlers.get('plugins:start-conversation');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      message: 'Hello',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Rate limit exceeded');
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('explains how to fix missing conversations:write permission', async () => {
    _invalidatePermissionCacheForTesting();
    mockLoadPersistedPluginEntries.mockResolvedValue([
      { manifest: { id: 'test-plugin', permissions: ['conversations:read'], externalDomains: [] } },
    ]);

    const handler = registeredHandlers.get('plugins:start-conversation');
    const response: any = await handler?.({}, {
      pluginId: 'test-plugin',
      message: 'Hello',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain('not authorized for "conversations:write"');
    expect(response.error).toContain('update the plugin manifest');
    expect(response.error).toContain('Settings > Plugins');
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('trims message whitespace', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: true });

    const handler = registeredHandlers.get('plugins:start-conversation');
    await handler?.({}, {
      pluginId: 'test-plugin',
      message: '  Start task  ',
    });

    expect(mockSendToAllWindows).toHaveBeenCalledWith('conversations:start-requested', expect.objectContaining({
      text: 'Start task',
    }));
  });

  it('includes pluginAttribution in broadcast payload', async () => {
    mockCheckMessageRateLimit.mockReturnValue({ allowed: true });
    mockLoadPersistedPluginEntries.mockResolvedValue([
      { manifest: { id: 'my-special-plugin', permissions: ['conversations:write'], externalDomains: [] } },
    ]);

    const handler = registeredHandlers.get('plugins:start-conversation');
    await handler?.({}, {
      pluginId: 'my-special-plugin',
      message: 'Hello',
    });

    expect(mockSendToAllWindows).toHaveBeenCalledWith('conversations:start-requested', expect.objectContaining({
      pluginAttribution: 'my-special-plugin',
    }));
  });
});
