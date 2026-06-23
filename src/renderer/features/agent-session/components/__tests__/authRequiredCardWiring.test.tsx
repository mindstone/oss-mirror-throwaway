// @vitest-environment happy-dom
import { act, flushAsync, renderHook } from '@renderer/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { AUTH_REQUIRED_ACTION } from '@shared/utils/authRequiredSignal';
import { useAuthRequiredSignals } from '../../hooks/useAuthRequiredSignals';

function makeAssistantMessage(
  id: string,
  turnId: string,
  text = 'Assistant reply',
): AgentTurnMessage {
  return {
    id,
    turnId,
    role: 'assistant',
    text,
    createdAt: Date.now(),
  };
}

function makeAuthRequiredToolEvent(
  packageId: string,
  reason: 'token_expired' | 'not_connected',
  timestamp: number,
): AgentEvent {
  return {
    type: 'tool',
    toolName: 'use_tool',
    stage: 'end',
    detail: JSON.stringify({
      package_id: packageId,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: AUTH_REQUIRED_ACTION,
              package_id: packageId,
              auth_tool: 'authenticate_slack_workspace',
              reason,
            }),
          },
        ],
      },
    }),
    timestamp,
  } as AgentEvent;
}

const resolveTurnId = (message: AgentTurnMessage) => message.turnId;

type SlackWorkspaceStatus =
  | 'connected'
  | 'needs_reconnect'
  | 'disconnecting'
  | 'disconnected';

interface SlackWorkspaceChangedPayload {
  teamId: string;
  teamName: string;
  status: SlackWorkspaceStatus;
  occurredAt: number;
}

type WindowHarness = {
  slackApi: {
    startAuth: () => Promise<{ success: boolean; teamName?: string; error?: string }>;
    cancelAuth: () => Promise<void>;
  };
  appBridgeSubscriptions?: {
    onSlackWorkspaceChanged: (
      callback: (payload: SlackWorkspaceChangedPayload) => void,
    ) => () => void;
  };
};

let slackWorkspaceChangedListener:
  | ((payload: SlackWorkspaceChangedPayload) => void)
  | null = null;
const mockStartAuth = vi.fn<
  () => Promise<{ success: boolean; teamName?: string; error?: string }>
>();
const mockCancelAuth = vi.fn<() => Promise<void>>();

describe('auth required card wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    slackWorkspaceChangedListener = null;
    mockStartAuth.mockResolvedValue({ success: true, teamName: 'mindstone' });
    mockCancelAuth.mockResolvedValue();

    const harnessWindow = window as unknown as WindowHarness;
    harnessWindow.slackApi = {
      startAuth: mockStartAuth,
      cancelAuth: mockCancelAuth,
    };
    harnessWindow.appBridgeSubscriptions = {
      onSlackWorkspaceChanged: (callback) => {
        slackWorkspaceChangedListener = callback;
        return () => {
          if (slackWorkspaceChangedListener === callback) {
            slackWorkspaceChangedListener = null;
          }
        };
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('signal present renders card metadata at the matching message index', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [makeAuthRequiredToolEvent('Slack-mindstone', 'token_expired', 100)],
    };
    const messages: AgentTurnMessage[] = [
      { id: 'm1', turnId: 'turn-0', role: 'user', text: 'hello', createdAt: Date.now() },
      makeAssistantMessage('m2', 'turn-1', 'Slack failed'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    expect(result.current.cardByMessageIndex.size).toBe(1);
    const cards = result.current.cardByMessageIndex.get(1);
    expect(cards).toBeDefined();
    expect(cards).toHaveLength(1);
    const card = cards?.[0];
    expect(card?.signal.packageId).toBe('Slack-mindstone');
    expect(card?.state).toBe('idle');
  });

  it('signal absent does not render any auth required cards', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        {
          type: 'tool',
          toolName: 'use_tool',
          stage: 'end',
          detail: JSON.stringify({
            ok: false,
            error: 'some failure',
          }),
          timestamp: 100,
        } as AgentEvent,
      ],
    };
    const messages: AgentTurnMessage[] = [
      makeAssistantMessage('m1', 'turn-1'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    expect(result.current.cardByMessageIndex.size).toBe(0);
    expect(result.current.pendingFooterCard).toBeNull();
  });

  it('multiple workspaces produce one card per package id', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [makeAuthRequiredToolEvent('Slack-mindstone', 'token_expired', 100)],
      'turn-2': [makeAuthRequiredToolEvent('Slack-acme', 'not_connected', 200)],
    };
    const messages: AgentTurnMessage[] = [
      makeAssistantMessage('m1', 'turn-1'),
      makeAssistantMessage('m2', 'turn-2'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    expect(result.current.cardByMessageIndex.size).toBe(2);
    const packageIds = [...result.current.cardByMessageIndex.values()].flat().map(
      (card) => card.signal.packageId,
    );
    expect(packageIds).toContain('Slack-mindstone');
    expect(packageIds).toContain('Slack-acme');
    expect(result.current.pendingFooterCard?.signal.packageId).toBe('Slack-acme');
  });

  it('keeps both cards when two package auth signals anchor to the same message', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        makeAuthRequiredToolEvent('Slack-mindstone', 'token_expired', 100),
        makeAuthRequiredToolEvent('Slack-acme', 'not_connected', 101),
      ],
    };
    const messages: AgentTurnMessage[] = [
      { id: 'm1', turnId: 'turn-1', role: 'user', text: 'hello', createdAt: Date.now() },
      makeAssistantMessage('m2', 'turn-1', 'Slack failed'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    expect(result.current.cardByMessageIndex.size).toBe(1);
    const cards = result.current.cardByMessageIndex.get(1);
    expect(cards).toBeDefined();
    expect(cards).toHaveLength(2);
    const packageIds = cards?.map((card) => card.signal.packageId);
    expect(packageIds).toContain('Slack-mindstone');
    expect(packageIds).toContain('Slack-acme');
  });

  it('startReconnect invokes window.slackApi.startAuth and sets the card to reconnecting', async () => {
    mockStartAuth.mockReturnValue(new Promise(() => {}));
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [makeAuthRequiredToolEvent('Slack-mindstone', 'token_expired', 100)],
    };
    const messages: AgentTurnMessage[] = [
      makeAssistantMessage('m1', 'turn-1'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    await act(async () => {
      await result.current.startReconnect('Slack-mindstone');
    });

    expect(mockStartAuth).toHaveBeenCalledTimes(1);
    const card = result.current.cardByMessageIndex.get(0)?.[0];
    expect(card?.state).toBe('reconnecting');
  });

  it('suppresses a card after matching slack:workspace-changed connected broadcast', () => {
    vi.useFakeTimers();
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [makeAuthRequiredToolEvent('Slack-mindstone', 'token_expired', 100)],
    };
    const messages: AgentTurnMessage[] = [
      makeAssistantMessage('m1', 'turn-1'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    expect(result.current.cardByMessageIndex.size).toBe(1);
    expect(slackWorkspaceChangedListener).toBeTypeOf('function');

    act(() => {
      slackWorkspaceChangedListener?.({
        teamId: 'T123',
        teamName: 'mindstone',
        status: 'connected',
        occurredAt: 200,
      });
    });

    const successCard = result.current.cardByMessageIndex.get(0)?.[0];
    expect(successCard?.state).toBe('success');

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(result.current.cardByMessageIndex.size).toBe(0);
  });

  it('sets card to error when startAuth resolves with success=false', async () => {
    mockStartAuth.mockResolvedValue({
      success: false,
      error: 'Slack OAuth credentials not configured',
    });
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [makeAuthRequiredToolEvent('Slack-mindstone', 'token_expired', 100)],
    };
    const messages: AgentTurnMessage[] = [
      makeAssistantMessage('m1', 'turn-1'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    await act(async () => {
      await result.current.startReconnect('Slack-mindstone');
    });
    await flushAsync();

    const card = result.current.cardByMessageIndex.get(0)?.[0];
    expect(card?.state).toBe('error');
    expect(card?.errorMessage).toBe('Slack OAuth credentials not configured');
  });

  it('resets clicked workspace to idle when OAuth resolves to a different workspace', async () => {
    vi.useFakeTimers();
    mockStartAuth.mockResolvedValue({ success: true, teamName: 'Other' });
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [makeAuthRequiredToolEvent('Slack-acme', 'token_expired', 100)],
      'turn-2': [makeAuthRequiredToolEvent('Slack-other', 'token_expired', 101)],
    };
    const messages: AgentTurnMessage[] = [
      makeAssistantMessage('m1', 'turn-1'),
      makeAssistantMessage('m2', 'turn-2'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    await act(async () => {
      await result.current.startReconnect('Slack-acme');
    });
    await flushAsync();

    const cardsAfterReconnect = [
      ...result.current.cardByMessageIndex.values(),
    ].flat();
    const acmeCard = cardsAfterReconnect.find(
      (card) => card.signal.packageId === 'Slack-acme',
    );
    const otherCard = cardsAfterReconnect.find(
      (card) => card.signal.packageId === 'Slack-other',
    );

    expect(acmeCard?.state).toBe('idle');
    expect(otherCard?.state).toBe('success');

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    const cardsAfterSuccessReset = [
      ...result.current.cardByMessageIndex.values(),
    ].flat();
    expect(
      cardsAfterSuccessReset.find(
        (card) => card.signal.packageId === 'Slack-other',
      ),
    ).toBeUndefined();
    expect(
      cardsAfterSuccessReset.find(
        (card) => card.signal.packageId === 'Slack-acme',
      )?.state,
    ).toBe('idle');
  });

  it('keeps card idle when cancel invalidates a stale Authorization cancelled result', async () => {
    let resolveStartAuth:
      | ((value: { success: boolean; teamName?: string; error?: string }) => void)
      | null = null;
    mockStartAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStartAuth = resolve;
        }),
    );
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [makeAuthRequiredToolEvent('Slack-mindstone', 'token_expired', 100)],
    };
    const messages: AgentTurnMessage[] = [
      makeAssistantMessage('m1', 'turn-1'),
    ];

    const { result } = renderHook(() =>
      useAuthRequiredSignals(eventsByTurn, messages, resolveTurnId),
    );

    await act(async () => {
      await result.current.startReconnect('Slack-mindstone');
    });
    expect(result.current.cardByMessageIndex.get(0)?.[0]?.state).toBe(
      'reconnecting',
    );

    await act(async () => {
      await result.current.cancelReconnect('Slack-mindstone');
    });
    expect(mockCancelAuth).toHaveBeenCalledTimes(1);
    expect(result.current.cardByMessageIndex.get(0)?.[0]?.state).toBe('idle');

    await act(async () => {
      resolveStartAuth?.({ success: false, error: 'Authorization cancelled' });
    });
    await flushAsync();

    const card = result.current.cardByMessageIndex.get(0)?.[0];
    expect(card?.state).toBe('idle');
    expect(card?.errorMessage).toBeUndefined();
  });
});
