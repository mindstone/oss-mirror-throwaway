// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { ConnectedAppPermissions } from '../ConnectedAppPermissions';
import type { ListedPermission } from '../../hooks/useConnectedAppPermissions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_COPY = 'Nothing allowed yet. Apps will ask here first.';
const CONFIRMATION_COPY = 'Remove access? The app will need to ask again next time.';
const SUCCESS_ANNOUNCEMENT = 'Removed. The app will need to ask again next time.';

type PermissionChangedPayload = { kind: 'granted' | 'revoked'; scope: 'method' | 'tool' | 'conversation' | 'package' };
type PermissionChangedHandler = (payload: PermissionChangedPayload) => void;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

let mounted: Mounted[] = [];
let permissionChangedHandler: PermissionChangedHandler | null = null;
let unsubscribePermissionChanged: ReturnType<typeof vi.fn>;
let listPermissions: ReturnType<typeof vi.fn>;
let revokePermission: ReturnType<typeof vi.fn>;

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(text: string, root: ParentNode = document.body): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(text));
  if (!match) {
    throw new Error(`Button not found: ${text}`);
  }
  return match as HTMLButtonElement;
}

function rowRemoveButton(container: ParentNode): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button'))
    .find((button) => button.getAttribute('aria-label')?.startsWith('Remove access for'));
  if (!match) {
    throw new Error('Row remove button not found');
  }
  return match as HTMLButtonElement;
}

function dialog(): HTMLElement {
  const match = document.body.querySelector('[role="dialog"]');
  if (!match) {
    throw new Error('Dialog not found');
  }
  return match as HTMLElement;
}

function makePermission(overrides: Partial<ListedPermission> = {}): ListedPermission {
  return {
    sourcePackageId: 'GoogleWorkspace-joshua-example-com',
    conversationId: 'conversation-1',
    granted: true,
    grantedAt: '2026-05-08T12:00:00.000Z',
    methods: ['ui/updateModelContext', 'ui/sendMessage'],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: 'conversation-1',
    title: 'Quarterly Planning',
    createdAt: Date.parse('2026-05-07T12:00:00.000Z'),
    updatedAt: Date.parse('2026-05-09T12:00:00.000Z'),
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    preview: '',
    messageCount: 1,
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turnCount: 1,
    },
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    ...overrides,
  };
}

function installWindowMocks(initialPermissions: ListedPermission[] = []): void {
  permissionChangedHandler = null;
  unsubscribePermissionChanged = vi.fn();
  listPermissions = vi.fn().mockResolvedValue({ permissions: initialPermissions });
  revokePermission = vi.fn().mockResolvedValue({ success: true });

  Object.assign(window, {
    mcpAppsApi: {
      listPermissions,
      revokePermission,
    },
    api: {
      onMcpPermissionChanged: vi.fn((handler: PermissionChangedHandler) => {
        permissionChangedHandler = handler;
        return unsubscribePermissionChanged;
      }),
    },
  });
}

describe('ConnectedAppPermissions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
    installWindowMocks();
    act(() => {
      useSessionStore.setState({
        sessionSummaries: [],
        currentSessionId: 'current-session',
        currentSessionTitle: 'Current conversation',
        currentSessionCreatedAt: Date.parse('2026-05-10T11:00:00.000Z'),
      });
    });
  });

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders the exact empty state copy', async () => {
    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();

    expect(view.container.textContent).toContain('Connected app permissions');
    expect(view.container.textContent).toContain("Apps you've allowed to speak in conversations, share context, or use tools.");
    expect(view.container.textContent).toContain(EMPTY_COPY);
  });

  it('renders one package row with display name, conversation title, capability summary, and action', async () => {
    installWindowMocks([makePermission()]);
    act(() => {
      useSessionStore.setState({ sessionSummaries: [makeSummary()] });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();

    expect(view.container.textContent).toContain('Google Workspace');
    expect(view.container.textContent).toContain('Quarterly Planning');
    expect(view.container.textContent).toContain('Can share context and send messages');
    expect(rowRemoveButton(view.container).textContent).toContain('Remove access');
  });

  it('opens the confirmation dialog from Remove access', async () => {
    installWindowMocks([makePermission()]);
    act(() => {
      useSessionStore.setState({ sessionSummaries: [makeSummary()] });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();
    act(() => {
      rowRemoveButton(view.container).click();
    });

    expect(document.body.textContent).toContain(CONFIRMATION_COPY);
  });

  it('confirms conversation revoke with the v1 conversation-scoped IPC shape', async () => {
    installWindowMocks([makePermission()]);
    act(() => {
      useSessionStore.setState({ sessionSummaries: [makeSummary()] });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();
    act(() => {
      rowRemoveButton(view.container).click();
    });
    await act(async () => {
      buttonByText('Remove access', dialog()).click();
      await Promise.resolve();
    });

    expect(revokePermission).toHaveBeenCalledWith({
      scope: 'conversation',
      sourcePackageId: 'GoogleWorkspace-joshua-example-com',
      conversationId: 'conversation-1',
    });
  });

  it('disables the row while a conversation revoke is pending', async () => {
    let resolveRevoke: (value: { success: true }) => void = () => {};
    revokePermission = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveRevoke = resolve as (value: { success: true }) => void;
    }));
    listPermissions.mockResolvedValue({ permissions: [makePermission()] });
    Object.assign(window.mcpAppsApi, { revokePermission });
    act(() => {
      useSessionStore.setState({ sessionSummaries: [makeSummary()] });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();
    act(() => {
      rowRemoveButton(view.container).click();
    });
    await act(async () => {
      buttonByText('Remove access', dialog()).click();
      await Promise.resolve();
    });

    expect(rowRemoveButton(view.container).disabled).toBe(true);

    await act(async () => {
      resolveRevoke({ success: true });
      await Promise.resolve();
    });
  });

  it('removes the row after successful revoke and announces the result', async () => {
    listPermissions
      .mockResolvedValueOnce({ permissions: [makePermission()] })
      .mockResolvedValueOnce({ permissions: [] });
    revokePermission.mockResolvedValue({ success: true });
    act(() => {
      useSessionStore.setState({ sessionSummaries: [makeSummary()] });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();
    act(() => {
      rowRemoveButton(view.container).click();
    });
    await act(async () => {
      buttonByText('Remove access', dialog()).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.textContent).not.toContain('Quarterly Planning');
    expect(view.container.textContent).toContain(SUCCESS_ANNOUNCEMENT);
  });

  it('confirms Remove all access with package-scoped revoke', async () => {
    installWindowMocks([makePermission()]);
    act(() => {
      useSessionStore.setState({ sessionSummaries: [makeSummary()] });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();
    act(() => {
      buttonByText('Remove all access', view.container).click();
    });
    await act(async () => {
      buttonByText('Remove access', dialog()).click();
      await Promise.resolve();
    });

    expect(revokePermission).toHaveBeenCalledWith({
      scope: 'package',
      sourcePackageId: 'GoogleWorkspace-joshua-example-com',
    });
  });

  it('renders multiple package groups with conversation counts', async () => {
    installWindowMocks([
      makePermission({ sourcePackageId: 'AlphaApp-user-1', conversationId: 'conversation-1' }),
      makePermission({ sourcePackageId: 'BetaApp-user-1', conversationId: 'conversation-2' }),
    ]);
    act(() => {
      useSessionStore.setState({
        sessionSummaries: [
          makeSummary({ id: 'conversation-1', title: 'First conversation' }),
          makeSummary({ id: 'conversation-2', title: 'Second conversation' }),
        ],
      });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();

    expect(view.container.textContent).toContain('Alpha App');
    expect(view.container.textContent).toContain('Beta App');
    expect(view.container.textContent).toContain('1 conversation');
  });

  it('defaults groups to collapsed for four or more packages', async () => {
    installWindowMocks([
      makePermission({ sourcePackageId: 'AlphaApp-user-1', conversationId: 'conversation-1' }),
      makePermission({ sourcePackageId: 'BetaApp-user-1', conversationId: 'conversation-2' }),
      makePermission({ sourcePackageId: 'GammaApp-user-1', conversationId: 'conversation-3' }),
      makePermission({ sourcePackageId: 'DeltaApp-user-1', conversationId: 'conversation-4' }),
    ]);
    act(() => {
      useSessionStore.setState({
        sessionSummaries: [
          makeSummary({ id: 'conversation-1', title: 'First conversation' }),
          makeSummary({ id: 'conversation-2', title: 'Second conversation' }),
          makeSummary({ id: 'conversation-3', title: 'Third conversation' }),
          makeSummary({ id: 'conversation-4', title: 'Fourth conversation' }),
        ],
      });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();

    expect(view.container.textContent).toContain('Alpha App');
    expect(view.container.textContent).toContain('Delta App');
    expect(view.container.textContent).not.toContain('First conversation');
    expect(view.container.querySelector('[aria-expanded="true"]')).toBeNull();
  });

  it('refreshes when mcp:permission-changed is broadcast', async () => {
    listPermissions
      .mockResolvedValueOnce({ permissions: [] })
      .mockResolvedValueOnce({ permissions: [makePermission()] });
    act(() => {
      useSessionStore.setState({ sessionSummaries: [makeSummary()] });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();
    expect(view.container.textContent).toContain(EMPTY_COPY);

    await act(async () => {
      permissionChangedHandler?.({ kind: 'granted', scope: 'method' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listPermissions).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('Quarterly Planning');
  });

  it('shows an error Notice with retry when listPermissions fails', async () => {
    listPermissions
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ permissions: [makePermission()] });
    act(() => {
      useSessionStore.setState({ sessionSummaries: [makeSummary()] });
    });

    const view = mount(<ConnectedAppPermissions />);
    mounted.push(view);

    await flushAsync();

    expect(view.container.textContent).toContain('Connected app permissions did not load');
    expect(view.container.textContent).toContain("Couldn't load connected app permissions.");

    await act(async () => {
      buttonByText('Retry', view.container).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listPermissions).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('Quarterly Planning');
  });
});
