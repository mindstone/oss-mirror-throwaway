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

// Mock createId
vi.mock('@shared/utils/id', () => ({
  createId: () => 'new-session-42',
}));

// Mock session store
const mockTogglePinSession = vi.fn();
const mockToggleStarSession = vi.fn();
const mockRenameSession = vi.fn();
const mockSetDraftForSession = vi.fn();
const mockCreateBackgroundSession = vi.fn();

vi.mock('@renderer/features/agent-session/store/sessionStore', () => ({
  getSessionStoreState: () => ({
    sessionSummaries: [],
    currentSessionId: 'test-session-1',
    togglePinSession: mockTogglePinSession,
    toggleStarSession: mockToggleStarSession,
    renameSession: mockRenameSession,
    setDraftForSession: mockSetDraftForSession,
    createBackgroundSession: mockCreateBackgroundSession,
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
const mockSendMessage = vi.fn();
const mockStartConversation = vi.fn();

 
(globalThis as any).window = {
   
  ...(globalThis as any).window,
  pluginsApi: {
    sendMessage: mockSendMessage,
    startConversation: mockStartConversation,
  },
};

import { _createConversationApi } from '../pluginApiFactory';

type OpenSessionFn = ReturnType<typeof vi.fn<(sessionId: string) => void>>;
type NavigateFn = ReturnType<typeof vi.fn<(target: string) => void>>;

describe('Plugin Conversation Actions', () => {
  let openSessionFn: OpenSessionFn;

  beforeEach(() => {
    openSessionFn = vi.fn<(sessionId: string) => void>();
    mockCheckPermission.mockReset();
    mockTogglePinSession.mockReset();
    mockToggleStarSession.mockReset();
    mockRenameSession.mockReset();
    mockSendMessage.mockReset();
    mockStartConversation.mockReset();
    mockSetDraftForSession.mockReset();
    mockCreateBackgroundSession.mockReset();
  });

  describe('toggleDone', () => {
    it('delegates normal conversation lifecycle toggles to the session store', () => {
      mockCheckPermission.mockReturnValue(true);

      const api = _createConversationApi('test-plugin', openSessionFn);
      api.toggleDone('conversation-plugin-normal');

      expect(mockTogglePinSession).toHaveBeenCalledWith('conversation-plugin-normal');
    });

    it('warns and does not mutate lifecycle for background conversations', () => {
      mockCheckPermission.mockReturnValue(true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const api = _createConversationApi('test-plugin', openSessionFn);
      api.toggleDone('automation-source-capture--plugin-background');

      expect(mockTogglePinSession).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('conversations.toggleDone is not supported for background/automation conversations'),
        {
          pluginId: 'test-plugin',
          sessionId: 'automation-source-capture--plugin-background',
        },
      );

      warnSpy.mockRestore();
    });
  });

  describe('sendMessage', () => {
    it('calls IPC with pluginId, sessionId, and message', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockSendMessage.mockResolvedValue({ ok: true });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.sendMessage('session-1', 'Hello from plugin');

      expect(mockSendMessage).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        sessionId: 'session-1',
        message: 'Hello from plugin',
      });
      expect(result).toEqual({ ok: true });
    });

    it('trims whitespace from message', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockSendMessage.mockResolvedValue({ ok: true });

      const api = _createConversationApi('test-plugin', openSessionFn);
      await api.sendMessage('session-1', '  Hello  ');

      expect(mockSendMessage).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        sessionId: 'session-1',
        message: 'Hello',
      });
    });

    it('throws when conversations:write permission is missing', async () => {
      mockCheckPermission.mockReturnValue(false);

      const api = _createConversationApi('no-write-plugin', openSessionFn);
      await expect(api.sendMessage('session-1', 'Hello'))
        .rejects.toThrow('not authorized for "conversations:write"');
    });

    it('returns error envelope when IPC returns error', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockSendMessage.mockResolvedValue({ ok: false, error: 'Session not found.' });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.sendMessage('session-1', 'Hello');
      expect(result).toEqual({ ok: false, error: 'Session not found.' });
    });

    it('returns error envelope when sessionId is empty', async () => {
      mockCheckPermission.mockReturnValue(true);

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.sendMessage('', 'Hello');
      expect(result).toEqual({ ok: false, error: 'sessionId is required and must be a non-empty string.' });
    });

    it('returns error envelope when message is empty', async () => {
      mockCheckPermission.mockReturnValue(true);

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.sendMessage('session-1', '');
      expect(result).toEqual({ ok: false, error: 'message is required and must be a non-empty string.' });
    });

    it('returns error envelope when message is only whitespace', async () => {
      mockCheckPermission.mockReturnValue(true);

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.sendMessage('session-1', '   ');
      expect(result).toEqual({ ok: false, error: 'message is required and must be a non-empty string.' });
    });
  });

  describe('startConversation', () => {
    it('calls IPC with pluginId and message', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockStartConversation.mockResolvedValue({ ok: true, sessionId: 'new-session-1' });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.startConversation('Start a research task');

      expect(mockStartConversation).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        message: 'Start a research task',
      });
      expect(result).toEqual({ ok: true, sessionId: 'new-session-1' });
    });

    it('trims whitespace from message', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockStartConversation.mockResolvedValue({ ok: true, sessionId: 'new-session-2' });

      const api = _createConversationApi('test-plugin', openSessionFn);
      await api.startConversation('  Hello  ');

      expect(mockStartConversation).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        message: 'Hello',
      });
    });

    it('throws when conversations:write permission is missing', async () => {
      mockCheckPermission.mockReturnValue(false);

      const api = _createConversationApi('no-write-plugin', openSessionFn);
      await expect(api.startConversation('Hello'))
        .rejects.toThrow('not authorized for "conversations:write"');
    });

    it('returns error envelope when IPC returns error', async () => {
      mockCheckPermission.mockReturnValue(true);
      mockStartConversation.mockResolvedValue({ ok: false, error: 'Rate limit exceeded.' });

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.startConversation('Hello');
      expect(result).toEqual({ ok: false, error: 'Rate limit exceeded.' });
    });

    it('returns error envelope when message is empty', async () => {
      mockCheckPermission.mockReturnValue(true);

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.startConversation('');
      expect(result).toEqual({ ok: false, error: 'message is required and must be a non-empty string.' });
    });

    it('returns error envelope when message is only whitespace', async () => {
      mockCheckPermission.mockReturnValue(true);

      const api = _createConversationApi('test-plugin', openSessionFn);
      const result = await api.startConversation('   ');
      expect(result).toEqual({ ok: false, error: 'message is required and must be a non-empty string.' });
    });
  });

  describe('create', () => {
    it('creates a new session with plugin origin and navigates to it by default', () => {
      const navigateFn: NavigateFn = vi.fn<(target: string) => void>();

      const api = _createConversationApi('test-plugin', openSessionFn, undefined, navigateFn);
      const id = api.create();

      expect(id).toBe('new-session-42');
      expect(mockCreateBackgroundSession).toHaveBeenCalledWith('new-session-42', 'plugin');
      // Canonical URL form is rebel://conversation/{id}; rebel://sessions/{id} is the
      // internal target type name. See formatNavigationUrl in @shared/navigation/urlParser.
      expect(navigateFn).toHaveBeenCalledWith('rebel://conversation/new-session-42');
    });

    it('sets draft on the NEW session (not current) when draftText provided', () => {
      const navigateFn: NavigateFn = vi.fn<(target: string) => void>();

      const api = _createConversationApi('test-plugin', openSessionFn, undefined, navigateFn);
      const id = api.create({ draftText: 'Hello world' });

      expect(id).toBe('new-session-42');
      expect(mockCreateBackgroundSession).toHaveBeenCalledWith('new-session-42', 'plugin');
      expect(mockSetDraftForSession).toHaveBeenCalledWith('new-session-42', 'Hello world');
      expect(navigateFn).toHaveBeenCalledWith('rebel://conversation/new-session-42');
    });

    it('creates in background when navigate is false', () => {
      const navigateFn: NavigateFn = vi.fn<(target: string) => void>();

      const api = _createConversationApi('test-plugin', openSessionFn, undefined, navigateFn);
      const id = api.create({ draftText: 'Research this', navigate: false });

      expect(id).toBe('new-session-42');
      expect(mockCreateBackgroundSession).toHaveBeenCalledWith('new-session-42', 'plugin');
      expect(mockSetDraftForSession).toHaveBeenCalledWith('new-session-42', 'Research this');
      expect(navigateFn).not.toHaveBeenCalled();
    });

    it('does not set draft when draftText is empty', () => {
      const navigateFn: NavigateFn = vi.fn<(target: string) => void>();

      const api = _createConversationApi('test-plugin', openSessionFn, undefined, navigateFn);
      api.create({ draftText: '  ' });

      expect(mockCreateBackgroundSession).toHaveBeenCalledWith('new-session-42', 'plugin');
      expect(mockSetDraftForSession).not.toHaveBeenCalled();
      expect(navigateFn).toHaveBeenCalled();
    });

    it('calls createBackgroundSession before setDraftForSession', () => {
      const navigateFn: NavigateFn = vi.fn<(target: string) => void>();

      const api = _createConversationApi('test-plugin', openSessionFn, undefined, navigateFn);
      api.create({ draftText: 'Hello world' });

      // Verify ordering: createBackgroundSession must be called before setDraftForSession
      const createOrder = mockCreateBackgroundSession.mock.invocationCallOrder[0];
      const draftOrder = mockSetDraftForSession.mock.invocationCallOrder[0];
      expect(createOrder).toBeDefined();
      expect(draftOrder).toBeDefined();
      expect(createOrder).toBeLessThan(draftOrder);
    });

    it('trims draftText before storing', () => {
      const navigateFn: NavigateFn = vi.fn<(target: string) => void>();

      const api = _createConversationApi('test-plugin', openSessionFn, undefined, navigateFn);
      api.create({ draftText: '  Hello  ' });

      expect(mockSetDraftForSession).toHaveBeenCalledWith('new-session-42', 'Hello');
    });
  });
});
