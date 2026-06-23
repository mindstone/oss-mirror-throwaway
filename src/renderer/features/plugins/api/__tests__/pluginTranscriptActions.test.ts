import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock sonner (required by pluginApiFactory)
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

// Mock session store
vi.mock('@renderer/features/agent-session/store/sessionStore', () => ({
  getSessionStoreState: () => ({
    sessionSummaries: [],
    togglePinSession: vi.fn(),
    toggleStarSession: vi.fn(),
    renameSession: vi.fn(),
  }),
  subscribeToSessionStore: vi.fn(),
}));

// Mock pluginPermissions
const mockCheckPermission = vi.fn();
vi.mock('../pluginPermissions', () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
  createPermissionGuard: (pluginId: string, permission: string) => {
    if (!mockCheckPermission(pluginId, permission)) {
      throw new Error(`Plugin "${pluginId}" is not authorized for "${permission}".`);
    }
  },
}));

// Mock window.pluginsApi
const mockGetTranscript = vi.fn();

 
(globalThis as any).window = {
   
  ...(globalThis as any).window,
  pluginsApi: {
     
    ...(globalThis as any).window?.pluginsApi,
    getTranscript: mockGetTranscript,
  },
};

import { _createConversationApi } from '../pluginApiFactory';

type OpenSessionFn = ReturnType<typeof vi.fn<(sessionId: string) => void>>;

describe('Plugin Transcript Actions', () => {
  let openSessionFn: OpenSessionFn;

  beforeEach(() => {
    openSessionFn = vi.fn<(sessionId: string) => void>();
    mockCheckPermission.mockReset();
    mockGetTranscript.mockReset();
  });

  describe('getTranscript', () => {
    it('calls IPC with pluginId, sessionId, and default options', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockGetTranscript.mockResolvedValue({
        ok: true,
        state: 'ok',
        messages: [
          { role: 'user', text: 'Hello', timestamp: '2026-03-28T10:00:00.000Z' },
          { role: 'assistant', text: 'Hi there!', timestamp: '2026-03-28T10:00:01.000Z', toolsUsed: ['web_search'] },
        ],
      });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.getTranscript('session-1');

      expect(mockGetTranscript).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        sessionId: 'session-1',
      });
      expect(result).toEqual({
        ok: true,
        state: 'ok',
        messages: [
          { role: 'user', text: 'Hello', timestamp: '2026-03-28T10:00:00.000Z' },
          { role: 'assistant', text: 'Hi there!', timestamp: '2026-03-28T10:00:01.000Z', toolsUsed: ['web_search'] },
        ],
      });
    });

    it('passes limit option when provided', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockGetTranscript.mockResolvedValue({ ok: true, messages: [] });

      const api = _createConversationApi('test-plugin', openSessionFn);
      await api.getTranscript('session-1', { limit: 50 });

      expect(mockGetTranscript).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        sessionId: 'session-1',
        limit: 50,
      });
    });

    it('throws when conversations:transcript permission is missing', async () => {
      mockCheckPermission.mockReturnValue(false);

      const api = _createConversationApi('no-transcript-plugin', openSessionFn);
      await expect(api.getTranscript('session-1'))
        .rejects.toThrow('not authorized for "conversations:transcript"');
    });

    it('returns error envelope when sessionId is empty', async () => {
      mockCheckPermission.mockReturnValue(true);

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.getTranscript('');
      expect(result).toEqual({ ok: false, error: 'sessionId is required and must be a non-empty string.' });
    });

    it('returns error envelope when IPC returns error', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockGetTranscript.mockResolvedValue({ ok: false, error: 'Rate limit exceeded.' });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.getTranscript('session-1');
      expect(result).toEqual({ ok: false, error: 'Rate limit exceeded.' });
    });

    it('returns redacted state for private sessions', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockGetTranscript.mockResolvedValue({ ok: true, state: 'redacted', messages: [] });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.getTranscript('private-session');
      expect(result).toEqual({ ok: true, state: 'redacted', messages: [] });
    });

    it('returns not_found state for non-existent sessions', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockGetTranscript.mockResolvedValue({ ok: true, state: 'not_found', messages: [] });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.getTranscript('nonexistent-session');
      expect(result).toEqual({ ok: true, state: 'not_found', messages: [] });
    });

    it('passes through state field from IPC response', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockGetTranscript.mockResolvedValue({
        ok: true,
        state: 'ok',
        messages: [{ role: 'user', text: 'test', timestamp: '2026-03-28T10:00:00.000Z' }],
      });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.getTranscript('session-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state).toBe('ok');
        expect(result.messages).toHaveLength(1);
      }
    });
  });
});
