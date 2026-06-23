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

// Mock plugin permissions (inbox does not require manifest permission)
vi.mock('../pluginPermissions', () => ({
  checkPermission: vi.fn(() => true),
  createPermissionGuard: vi.fn(),
}));

const mockInboxAdd = vi.fn();
const mockInboxList = vi.fn();

type MockPluginsApi = {
  inboxAdd?: typeof mockInboxAdd;
  inboxList?: typeof mockInboxList;
};

type MockWindow = Window & typeof globalThis & {
  pluginsApi?: MockPluginsApi;
};

const mockWindow: MockWindow = {
  ...(globalThis.window ?? {}),
  pluginsApi: {
    ...(globalThis.window?.pluginsApi ?? {}),
    inboxAdd: mockInboxAdd,
    inboxList: mockInboxList,
  },
} as unknown as MockWindow;

Object.defineProperty(globalThis, 'window', {
  value: mockWindow,
  configurable: true,
  writable: true,
});

import { _createInboxApi } from '../pluginApiFactory';

describe('Plugin Inbox Actions API', () => {
  beforeEach(() => {
    mockInboxAdd.mockReset();
    mockInboxList.mockReset();
  });

  describe('addItem', () => {
    it('calls IPC with pluginId and trimmed inbox item payload', async () => {
      mockInboxAdd.mockResolvedValue({ ok: true, itemId: '123e4567-e89b-12d3-a456-426614174000' });

      const inbox = _createInboxApi('test-plugin');
      const result = await inbox.addItem({
        title: '  Follow up with finance  ',
        description: '  Include Q1 variance notes.  ',
        priority: 'high',
        actionPrompt: '  Draft a concise follow-up note.  ',
      });

      expect(mockInboxAdd).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        item: {
          title: 'Follow up with finance',
          description: 'Include Q1 variance notes.',
          priority: 'high',
          actionPrompt: 'Draft a concise follow-up note.',
        },
      });
      expect(result).toEqual({ ok: true, itemId: '123e4567-e89b-12d3-a456-426614174000' });
    });

    it('returns error envelope when title is empty', async () => {
      const inbox = _createInboxApi('test-plugin');

      const result = await inbox.addItem({
        title: '   ',
      });
      expect(result).toEqual({ ok: false, error: 'item.title is required and must be a non-empty string.' });

      expect(mockInboxAdd).not.toHaveBeenCalled();
    });
  });

  describe('getItems', () => {
    it('calls IPC with limit and returns inbox items', async () => {
      mockInboxList.mockResolvedValue({
        items: [
          {
            itemId: 'item-1',
            title: 'Follow up',
            description: 'Description',
            priority: 'medium',
            createdAt: 12345,
            archived: false,
          },
        ],
      });

      const inbox = _createInboxApi('test-plugin');
      const result = await inbox.getItems({ limit: 5 });

      expect(mockInboxList).toHaveBeenCalledWith({ limit: 5 });
      expect(result).toEqual([
        {
          itemId: 'item-1',
          title: 'Follow up',
          description: 'Description',
          priority: 'medium',
          createdAt: 12345,
          archived: false,
        },
      ]);
    });

    it('uses default IPC request shape when params are omitted', async () => {
      mockInboxList.mockResolvedValue({ items: [] });

      const inbox = _createInboxApi('test-plugin');
      await inbox.getItems();

      expect(mockInboxList).toHaveBeenCalledWith({});
    });

    it('throws when limit is not a positive integer <= 50', async () => {
      const inbox = _createInboxApi('test-plugin');

      await expect(inbox.getItems({ limit: 0 })).rejects.toThrow('limit must be greater than or equal to 1');
      await expect(inbox.getItems({ limit: 2.5 })).rejects.toThrow('limit must be an integer');
      await expect(inbox.getItems({ limit: 51 })).rejects.toThrow('limit cannot be greater than 50');

      expect(mockInboxList).not.toHaveBeenCalled();
    });
  });
});
