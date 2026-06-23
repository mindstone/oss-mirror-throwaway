import type { OAuthToolResolver } from '@core/setOAuthToolResolver';
import {
  NULL_TOKEN_SYNC_COORDINATOR,
  type TokenSyncCoordinator,
} from '@core/setTokenSyncCoordinator';
import { describe, expect, it, vi } from 'vitest';
import { createTokenSyncPreflightHook } from '../createTokenSyncPreflightHook';

function makeResolver(resolution: ReturnType<OAuthToolResolver['resolve']>): OAuthToolResolver {
  return {
    resolve: vi.fn(() => resolution),
  };
}

function makeCoordinator(): TokenSyncCoordinator {
  return {
    ensureFreshish: vi.fn(async () => ({ ok: true, source: 'local' } as const)),
    onLocalWrite: vi.fn(async () => undefined),
    onPeerSignal: vi.fn(async () => undefined),
    onPeerTombstone: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({})),
  };
}

describe('createTokenSyncPreflightHook', () => {
  it('passes through when coordinator is NULL sentinel', async () => {
    const resolver = makeResolver({ provider: 'google', accountKey: 'GoogleWorkspace-alpha' });
    const hook = createTokenSyncPreflightHook({
      coordinator: NULL_TOKEN_SYNC_COORDINATOR,
      resolver,
      clock: () => 1_000,
    });

    const output = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__GoogleWorkspace-alpha__gmail_send' },
      'tool-1',
      { signal: new AbortController().signal },
    );

    expect(output).toEqual({});
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('passes through when resolver cannot classify the tool', async () => {
    const coordinator = makeCoordinator();
    const resolver = makeResolver(null);
    const hook = createTokenSyncPreflightHook({
      coordinator,
      resolver,
      clock: () => 1_000,
    });

    const output = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__notion__search_pages' },
      'tool-2',
      { signal: new AbortController().signal },
    );

    expect(output).toEqual({});
    expect(coordinator.ensureFreshish).not.toHaveBeenCalled();
  });

  it('calls ensureFreshish with resolver classification', async () => {
    const coordinator = makeCoordinator();
    const resolver = makeResolver({ provider: 'google', accountKey: 'GoogleWorkspace-bravo' });
    const hook = createTokenSyncPreflightHook({
      coordinator,
      resolver,
      clock: () => 50_000,
      deadlineMs: 1_500,
    });

    const output = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__GoogleWorkspace-bravo__gmail_read' },
      'tool-3',
      { signal: new AbortController().signal },
    );

    expect(output).toEqual({});
    expect(coordinator.ensureFreshish).toHaveBeenCalledWith({
      provider: 'google',
      accountKey: 'GoogleWorkspace-bravo',
      deadlineMs: 51_500,
    });
  });

  it('uses the default 3s deadline budget', async () => {
    const coordinator = makeCoordinator();
    const resolver = makeResolver({ provider: 'google', accountKey: 'GoogleWorkspace-charlie' });
    const hook = createTokenSyncPreflightHook({
      coordinator,
      resolver,
      clock: () => 9_000,
    });

    await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__GoogleWorkspace-charlie__gmail_send' },
      'tool-4',
      { signal: new AbortController().signal },
    );

    expect(coordinator.ensureFreshish).toHaveBeenCalledWith({
      provider: 'google',
      accountKey: 'GoogleWorkspace-charlie',
      deadlineMs: 12_000,
    });
  });
});
