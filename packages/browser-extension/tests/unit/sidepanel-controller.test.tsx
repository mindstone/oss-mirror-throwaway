// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContextChipViewModel,
  buildConversationEntries,
  buildConversationNotice,
  resolveHeaderStatus,
} from '@rebel/shared/chatUI';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const useSidePanelChatController = vi.fn();
vi.mock('../../src/hooks/useSidePanelChatController', () => ({
  useSidePanelChatController,
}));

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

async function loadSidePanel() {
  const mod = await import('../../src/sidepanel/SidePanel');
  return mod.SidePanel;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

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

function installChromeMock(): void {
  const listeners = new Set<(changes: Record<string, unknown>, areaName: string) => void>();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'fake-id',
      sendMessage: vi.fn(async () => ({ status: { kind: 'connected' } })),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      getURL: vi.fn((value: string) => `chrome-extension://fake-id/${value}`),
    },
    tabs: {
      query: vi.fn(async () => []),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
      },
      session: {
        get: vi.fn(async () => ({})),
        remove: vi.fn(async () => undefined),
      },
      onChanged: {
        addListener: vi.fn((listener: (changes: Record<string, unknown>, areaName: string) => void) => {
          listeners.add(listener);
        }),
        removeListener: vi.fn((listener: (changes: Record<string, unknown>, areaName: string) => void) => {
          listeners.delete(listener);
        }),
      },
    },
  });
}

const EMPTY_SNAPSHOT = {
  phase: 'hydrating' as const,
  conversationId: null,
  conversationContext: {},
  messages: [],
  turnStatus: 'idle' as const,
  error: null,
  retryableSend: null,
  creatingConversation: false,
  reconnectAttempt: 0,
};

function setHookState(overrides: Record<string, unknown> = {}): {
  send: ReturnType<typeof vi.fn>;
  startFresh: ReturnType<typeof vi.fn>;
  retrySend: ReturnType<typeof vi.fn>;
  openInRebel: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => undefined);
  const startFresh = vi.fn(async () => undefined);
  const retrySend = vi.fn(async () => undefined);
  const openInRebel = vi.fn(async () => undefined);
  useSidePanelChatController.mockReturnValue({
    pairingLoaded: true,
    installStatus: { kind: 'connected' },
    paired: true,
    snapshot: EMPTY_SNAPSHOT,
    streamingText: '',
    composerMountKey: 0,
    send,
    startFresh,
    retrySend,
    openInRebel,
    ...overrides,
  });
  return { send, startFresh, retrySend, openInRebel };
}

describe('SidePanel controller-backed rendering', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
    installChromeMock();
    useSidePanelChatController.mockReset();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the disconnected install copy when the side panel is not paired', async () => {
    const SidePanel = await loadSidePanel();
    setHookState({
      installStatus: { kind: 'idle' },
      paired: false,
    });

    mounted = mount(<SidePanel />);
    await flush();

    const notPaired = mounted.container.querySelector('[data-testid="not-paired"]');
    expect(notPaired?.textContent).toContain('Install Rebel Browser to start chatting');
    expect(notPaired?.textContent).toContain('Open Rebel and start the browser install');
    expect(
      mounted.container.querySelector('[data-testid="chat-header-status-dot"]')?.getAttribute('data-status'),
    ).toBe(
      resolveHeaderStatus({
        surfaceReady: false,
        connectionHealth: 'healthy',
      }),
    );
    expect(
      mounted.container.querySelector('[data-testid="chat-header-open-in-rebel"]')?.getAttribute('disabled'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="chat-header-start-fresh"]')?.getAttribute('disabled'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]')?.disabled,
    ).toBe(true);
  });

  it('renders a conversation snapshot and routes chat actions back through the controller hook', async () => {
    const SidePanel = await loadSidePanel();
    const now = Date.now();
    const messages = [
      {
        id: 'm1',
        role: 'user' as const,
        text: 'Summarise this page.',
        createdAt: now - 5 * 60_000,
      },
      {
        id: 'm2',
        role: 'assistant' as const,
        text: 'Here is the short version.',
        createdAt: now - 60_000,
      },
    ];
    const spies = setHookState({
      snapshot: {
        phase: 'idle',
        conversationId: 'conv-1',
        conversationContext: {
          pageTitle: 'Example article',
          pageUrl: 'https://example.com/article',
        },
        messages,
        turnStatus: 'idle',
        error: null,
        retryableSend: null,
        creatingConversation: false,
        reconnectAttempt: 0,
      },
    });

    mounted = mount(<SidePanel />);
    await flush();

    const expectedContext = buildContextChipViewModel({
      pageTitle: 'Example article',
      pageUrl: 'https://example.com/article',
    });
    const expectedEntries = buildConversationEntries({
      messages,
      streamingText: '',
      turnStatus: 'idle',
      now,
      formatTimestampTitle: (date) => date.toLocaleString(),
    }).filter((entry) => entry.kind === 'message');

    expect(expectedContext).not.toBeNull();
    const contextChip = mounted.container.querySelector('[data-testid="context-chip"]');
    expect(contextChip?.textContent).toContain(expectedContext?.primaryText ?? '');
    expect(contextChip?.getAttribute('title')).toBe(expectedContext?.tooltip ?? '');
    expect(
      mounted.container.querySelector('[data-testid="chat-header-status-dot"]')?.getAttribute('data-status'),
    ).toBe(
      resolveHeaderStatus({
        surfaceReady: true,
        connectionHealth: 'healthy',
      }),
    );
    expect(
      mounted.container.querySelectorAll('[data-testid="user-message"]').length,
    ).toBe(1);
    expect(
      mounted.container.querySelectorAll('[data-testid="assistant-message"]').length,
    ).toBe(1);
    const timestamps = Array.from(
      mounted.container.querySelectorAll<HTMLElement>('[data-testid="message-timestamp"]'),
    );
    expect(timestamps.map((node) => node.textContent)).toEqual(
      expectedEntries.map((entry) => entry.timestamp.relativeLabel),
    );
    expect(timestamps.map((node) => node.getAttribute('title'))).toEqual(
      expectedEntries.map((entry) => entry.timestamp.title),
    );

    act(() => {
      (mounted?.container.querySelector('[data-testid="chat-header-open-in-rebel"]') as HTMLButtonElement).click();
      (mounted?.container.querySelector('[data-testid="chat-header-start-fresh"]') as HTMLButtonElement).click();
    });

    expect(spies.openInRebel).toHaveBeenCalledTimes(1);
    expect(spies.startFresh).toHaveBeenCalledTimes(1);
  });

  it('renders reconnecting state with the shared status mapping and streamed assistant draft', async () => {
    const SidePanel = await loadSidePanel();
    const now = Date.now();
    const messages = [
      {
        id: 'm1',
        role: 'user' as const,
        text: 'Keep going.',
        createdAt: now - 90_000,
      },
    ];
    const expectedEntries = buildConversationEntries({
      messages,
      streamingText: 'Working on the next bit…',
      turnStatus: 'running',
      now,
      formatTimestampTitle: (date) => date.toLocaleString(),
    });
    const expectedStreamingEntry = expectedEntries.find((entry) => entry.kind === 'streaming');
    const reconnectingNotice = buildConversationNotice({
      phase: 'reconnecting',
    });

    setHookState({
      snapshot: {
        phase: 'reconnecting',
        conversationId: 'conv-1',
        conversationContext: {
          pageTitle: 'Example article',
          pageUrl: 'https://example.com/article',
        },
        messages,
        turnStatus: 'running',
        error: null,
        retryableSend: null,
        creatingConversation: false,
        reconnectAttempt: 1,
      },
      streamingText: 'Working on the next bit…',
    });

    mounted = mount(<SidePanel />);
    await flush();

    expect(reconnectingNotice?.kind).toBe('reconnecting');
    expect(
      mounted.container.querySelector('[data-testid="chat-header-status-dot"]')?.getAttribute('data-status'),
    ).toBe(
      resolveHeaderStatus({
        surfaceReady: true,
        connectionHealth: 'reconnecting',
      }),
    );
    expect(
      mounted.container.querySelector('[data-testid="offline-banner"]')?.getAttribute('data-kind'),
    ).toBe('reconnecting');
    expect(
      mounted.container.querySelector('[data-testid="offline-banner"]')?.textContent,
    ).toContain('Reconnecting to Rebel now.');
    expect(
      mounted.container.querySelector('[data-testid="streaming-text"]')?.textContent,
    ).toContain(expectedStreamingEntry?.kind === 'streaming' ? expectedStreamingEntry.text : '');
  });

  it('shows offline + retry UI from the controller snapshot and wires the retry button', async () => {
    const SidePanel = await loadSidePanel();
    const offlineNotice = buildConversationNotice({
      phase: 'offline',
      errorMessage: 'Reader exploded.',
    });
    const spies = setHookState({
      snapshot: {
        phase: 'offline',
        conversationId: 'conv-2',
        conversationContext: {},
        messages: [],
        turnStatus: 'idle',
        error: {
          code: 'NETWORK_ERROR',
          message: 'Reader exploded.',
        },
        retryableSend: 'Try that again',
        creatingConversation: false,
        reconnectAttempt: 2,
      },
    });

    mounted = mount(<SidePanel />);
    await flush();

    expect(offlineNotice?.kind).toBe('offline');
    expect(mounted.container.querySelector('[data-testid="offline-banner"]')?.textContent).toContain(
      "Rebel isn't running right now",
    );
    expect(
      mounted.container.querySelector('[data-testid="offline-banner"]')?.getAttribute('data-kind'),
    ).toBe('offline');
    expect(
      mounted.container.querySelector('[data-testid="error-banner"]')?.getAttribute('data-kind'),
    ).toBe('offline');
    expect(mounted.container.querySelector('[data-testid="error-banner"]')?.textContent).toContain(
      offlineNotice?.message ?? '',
    );
    const retry = mounted.container.querySelector<HTMLButtonElement>('[data-testid="error-banner-retry"]');
    expect(retry?.textContent).toContain('Retry');
    expect(retry?.disabled).toBe(true);

    act(() => {
      retry?.click();
    });

    expect(spies.retrySend).toHaveBeenCalledTimes(0);
  });

  it('shows the shared revoked notice without a retry affordance', async () => {
    const SidePanel = await loadSidePanel();
    const revokedNotice = buildConversationNotice({
      phase: 'revoked',
      errorMessage: 'Your connection to Rebel was reset. Open Rebel and run the browser install again.',
    });

    setHookState({
      snapshot: {
        phase: 'revoked',
        conversationId: 'conv-3',
        conversationContext: {},
        messages: [],
        turnStatus: 'idle',
        error: {
          code: 'UNAUTHORIZED',
          message: 'Your connection to Rebel was reset. Open Rebel and run the browser install again.',
        },
        retryableSend: null,
        creatingConversation: false,
        reconnectAttempt: 0,
      },
    });

    mounted = mount(<SidePanel />);
    await flush();

    expect(revokedNotice?.kind).toBe('revoked');
    expect(
      mounted.container.querySelector('[data-testid="error-banner"]')?.getAttribute('data-kind'),
    ).toBe('revoked');
    expect(mounted.container.querySelector('[data-testid="error-banner"]')?.textContent).toContain(
      revokedNotice?.message ?? '',
    );
    expect(
      mounted.container.querySelector('[data-testid="error-banner-retry"]'),
    ).toBeNull();
    expect(
      mounted.container.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]')
        ?.disabled,
    ).toBe(true);
  });
});
