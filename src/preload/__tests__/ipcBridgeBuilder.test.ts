import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { channelToMethodName } from '../ipcBridgeBuilder';

// Mock electron before importing makeDomainApi
const mockInvoke = vi.fn();
const mockSendSync = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    sendSync: (...args: unknown[]) => mockSendSync(...args),
  },
}));

import { makeDomainApi } from '../ipcBridgeBuilder';

// ---------------------------------------------------------------------------
// channelToMethodName
// ---------------------------------------------------------------------------

describe('channelToMethodName', () => {
  it('strips domain prefix and converts kebab-case to camelCase', () => {
    expect(channelToMethodName('settings:get')).toBe('get');
    expect(channelToMethodName('settings:get-default-workspace')).toBe('getDefaultWorkspace');
    expect(channelToMethodName('sessions:save-sync')).toBe('saveSync');
    expect(channelToMethodName('library:read-file-base64')).toBe('readFileBase64');
  });

  it('handles channels without a colon prefix', () => {
    expect(channelToMethodName('check-for-updates')).toBe('checkForUpdates');
  });

  it('handles mixed-prefix domains (misc channels)', () => {
    expect(channelToMethodName('analytics:status')).toBe('status');
    expect(channelToMethodName('runtime-config:get')).toBe('get');
    expect(channelToMethodName('sentry:capture-exception')).toBe('captureException');
    expect(channelToMethodName('conversation:generate-title')).toBe('generateTitle');
    expect(channelToMethodName('user:set-email')).toBe('setEmail');
  });

  it('handles channels with mixed kebab/camelCase segments', () => {
    expect(channelToMethodName('inbox:set-dueBy')).toBe('setDueBy');
    expect(channelToMethodName('useCaseLibrary:get-all')).toBe('getAll');
  });

  it('handles multi-segment kebab names', () => {
    expect(channelToMethodName('meeting-bot:start-local-recording')).toBe('startLocalRecording');
    expect(channelToMethodName('cloud-continuity:get-state')).toBe('getState');
    expect(channelToMethodName('system-improvement:get-pending')).toBe('getPending');
  });

  it('handles single-word method names (no transformation needed)', () => {
    expect(channelToMethodName('sessions:load')).toBe('load');
    expect(channelToMethodName('demo:enter')).toBe('enter');
    expect(channelToMethodName('auth:login')).toBe('login');
  });
});

// ---------------------------------------------------------------------------
// makeDomainApi — core dispatch
// ---------------------------------------------------------------------------

describe('makeDomainApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a method that calls ipcRenderer.invoke for invoke channels', async () => {
    const channels = {
      'test:do-something': {
        type: 'invoke' as const,
        channel: 'test:do-something',
        request: z.object({ id: z.string() }),
        response: z.object({ ok: z.boolean() }),
      },
    };

    mockInvoke.mockResolvedValue({ ok: true });
    const api = makeDomainApi(channels);
    const result = await api.doSomething({ id: '123' });

    expect(mockInvoke).toHaveBeenCalledWith('test:do-something', { id: '123' });
    expect(result).toEqual({ ok: true });
  });

  it('creates a method that calls ipcRenderer.sendSync for sync channels', () => {
    const channels = {
      'test:save-sync': {
        type: 'sync' as const,
        channel: 'test:save-sync',
        request: z.string(),
        response: z.object({ success: z.boolean() }),
      },
    };

    mockSendSync.mockReturnValue({ success: true });
    const api = makeDomainApi(channels);
    const result = api.saveSync('data');

    expect(mockSendSync).toHaveBeenCalledWith('test:save-sync', 'data');
    expect(result).toEqual({ success: true });
  });

  it('creates methods for all channels in the definition', () => {
    const channels = {
      'domain:get-items': {
        type: 'invoke' as const,
        channel: 'domain:get-items',
        request: z.void(),
        response: z.array(z.string()),
      },
      'domain:save-item': {
        type: 'invoke' as const,
        channel: 'domain:save-item',
        request: z.object({ name: z.string() }),
        response: z.object({ id: z.string() }),
      },
    };

    const api = makeDomainApi(channels);
    expect(typeof api.getItems).toBe('function');
    expect(typeof api.saveItem).toBe('function');
  });

  it('forwards void/undefined arguments correctly', async () => {
    const channels = {
      'test:no-args': {
        type: 'invoke' as const,
        channel: 'test:no-args',
        request: z.void(),
        response: z.string(),
      },
    };

    mockInvoke.mockResolvedValue('result');
    const api = makeDomainApi(channels);
    await api.noArgs();

    expect(mockInvoke).toHaveBeenCalledWith('test:no-args', undefined);
  });

  it('handles a domain with both invoke and sync channels', async () => {
    const channels = {
      'sessions:load': {
        type: 'invoke' as const,
        channel: 'sessions:load',
        request: z.void(),
        response: z.array(z.string()),
      },
      'sessions:save-sync': {
        type: 'sync' as const,
        channel: 'sessions:save-sync',
        request: z.array(z.string()),
        response: z.object({ success: z.boolean() }),
      },
    };

    mockInvoke.mockResolvedValue(['session1']);
    mockSendSync.mockReturnValue({ success: true });
    const api = makeDomainApi(channels);

    const sessions = await api.load();
    expect(mockInvoke).toHaveBeenCalledWith('sessions:load', undefined);
    expect(sessions).toEqual(['session1']);

    const result = api.saveSync(['session1']);
    expect(mockSendSync).toHaveBeenCalledWith('sessions:save-sync', ['session1']);
    expect(result).toEqual({ success: true });
  });

  it('throws on duplicate method names in non-production mode', () => {
    const channels = {
      'domain-a:get-status': {
        type: 'invoke' as const,
        channel: 'domain-a:get-status',
        request: z.void(),
        response: z.string(),
      },
      'domain-b:get-status': {
        type: 'invoke' as const,
        channel: 'domain-b:get-status',
        request: z.void(),
        response: z.string(),
      },
    };

    expect(() => makeDomainApi(channels)).toThrow(
      /Duplicate IPC method name 'getStatus'/,
    );
  });
});
