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

// Mock plugin permissions — by default grant automations:create
const mockCheckPermission = vi.fn<(pluginId: string, permission: string) => boolean>(() => true);
const mockCreatePermissionGuard = vi.fn<(pluginId: string, permission: string) => void>();
vi.mock('../pluginPermissions', () => ({
  checkPermission: (pluginId: string, permission: string) => mockCheckPermission(pluginId, permission),
  createPermissionGuard: (pluginId: string, permission: string) => mockCreatePermissionGuard(pluginId, permission),
}));

const mockCreateAutomation = vi.fn();
const mockListAutomations = vi.fn();

type MockPluginsApi = {
  createAutomation?: typeof mockCreateAutomation;
  listAutomations?: typeof mockListAutomations;
};

type MockWindow = Window & typeof globalThis & {
  pluginsApi?: MockPluginsApi;
};

const mockWindow: MockWindow = {
  ...(globalThis.window ?? {}),
  pluginsApi: {
    ...(globalThis.window?.pluginsApi ?? {}),
    createAutomation: mockCreateAutomation,
    listAutomations: mockListAutomations,
  },
} as unknown as MockWindow;

Object.defineProperty(globalThis, 'window', {
  value: mockWindow,
  configurable: true,
  writable: true,
});

import { _createAutomationsApi } from '../pluginApiFactory';

describe('Plugin Automation Actions API', () => {
  beforeEach(() => {
    mockCreateAutomation.mockReset();
    mockListAutomations.mockReset();
    mockCheckPermission.mockReturnValue(true);
    mockCreatePermissionGuard.mockReset();
  });

  describe('create', () => {
    it('calls IPC with correct payload and returns result', async () => {
      mockCreateAutomation.mockResolvedValue({ automationId: 'auto-123', ok: true });

      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.create({
        name: '  Morning Check  ',
        description: '  Run every morning  ',
        skillContent: '# Morning Check\nDo the thing.',
        schedule: { type: 'interval', value: '1h' },
        enabled: false,
      });

      expect(mockCreateAutomation).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        name: 'Morning Check',
        description: 'Run every morning',
        skillContent: '# Morning Check\nDo the thing.',
        schedule: { type: 'interval', value: '1h' },
        enabled: false,
      });
      expect(result).toEqual({ automationId: 'auto-123', ok: true });
    });

    it('returns error when name is empty', async () => {
      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.create({
        name: '   ',
        skillContent: 'content',
        schedule: { type: 'interval', value: '1h' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('name is required');
      expect(mockCreateAutomation).not.toHaveBeenCalled();
    });

    it('returns error when skillContent is empty', async () => {
      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.create({
        name: 'Test',
        skillContent: '',
        schedule: { type: 'interval', value: '1h' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('skillContent is required');
      expect(mockCreateAutomation).not.toHaveBeenCalled();
    });

    it('returns error when schedule type is invalid', async () => {
      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.create({
        name: 'Test',
        skillContent: '# Test',
        schedule: { type: 'daily' as 'interval', value: '09:00' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('schedule.type must be');
      expect(mockCreateAutomation).not.toHaveBeenCalled();
    });

    it('returns error when schedule value is empty', async () => {
      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.create({
        name: 'Test',
        skillContent: '# Test',
        schedule: { type: 'interval', value: '' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('schedule.value is required');
      expect(mockCreateAutomation).not.toHaveBeenCalled();
    });

    it('defaults enabled to false when omitted', async () => {
      mockCreateAutomation.mockResolvedValue({ automationId: 'auto-456', ok: true });

      const automations = _createAutomationsApi('test-plugin');
      await automations.create({
        name: 'Test',
        skillContent: '# Test',
        schedule: { type: 'interval', value: '30m' },
      });

      expect(mockCreateAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });

    it('checks automations:create permission', async () => {
      mockCreateAutomation.mockResolvedValue({ automationId: 'auto-789', ok: true });

      const automations = _createAutomationsApi('my-plugin');
      await automations.create({
        name: 'Test',
        skillContent: '# Test',
        schedule: { type: 'interval', value: '1h' },
      });

      expect(mockCreatePermissionGuard).toHaveBeenCalledWith('my-plugin', 'automations:create');
    });

    it('propagates permission guard error', async () => {
      mockCreatePermissionGuard.mockImplementation(() => {
        throw new Error('Plugin "my-plugin" is not authorized for "automations:create".');
      });

      const automations = _createAutomationsApi('my-plugin');
      const result = await automations.create({
        name: 'Test',
        skillContent: '# Test',
        schedule: { type: 'interval', value: '1h' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('not authorized');
      expect(mockCreateAutomation).not.toHaveBeenCalled();
    });

    it('handles IPC errors gracefully', async () => {
      mockCreateAutomation.mockRejectedValue(new Error('IPC channel failed'));

      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.create({
        name: 'Test',
        skillContent: '# Test',
        schedule: { type: 'interval', value: '1h' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('IPC channel failed');
    });

    it('returns error from IPC when ok is false', async () => {
      mockCreateAutomation.mockResolvedValue({
        automationId: '',
        ok: false,
        error: 'Rate limit exceeded',
      });

      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.create({
        name: 'Test',
        skillContent: '# Test',
        schedule: { type: 'interval', value: '1h' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Rate limit exceeded');
    });
  });

  describe('list', () => {
    it('returns automation summaries from IPC', async () => {
      const mockAutomations = [
        {
          id: 'auto-1',
          name: 'Morning Check',
          schedule: { type: 'daily', value: '09:00' },
          enabled: true,
          lastRunAt: 123456,
          nextRunAt: 789012,
        },
      ];
      mockListAutomations.mockResolvedValue({ automations: mockAutomations });

      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.list();

      expect(mockListAutomations).toHaveBeenCalledWith({});
      expect(result).toEqual(mockAutomations);
    });

    it('returns empty array when IPC fails', async () => {
      mockListAutomations.mockRejectedValue(new Error('IPC fail'));

      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.list();

      expect(result).toEqual([]);
    });

    it('returns empty array when API not available', async () => {
      const pluginsApi = (globalThis.window as unknown as MockWindow).pluginsApi;
      const savedApi = pluginsApi?.listAutomations;
      if (pluginsApi) {
        (pluginsApi as MockPluginsApi).listAutomations = undefined;
      }

      const automations = _createAutomationsApi('test-plugin');
      const result = await automations.list();

      expect(result).toEqual([]);

      // Restore
      if (pluginsApi) {
        (pluginsApi as MockPluginsApi).listAutomations = savedApi;
      }
    });
  });
});
