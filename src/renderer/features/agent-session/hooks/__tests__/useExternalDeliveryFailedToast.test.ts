// @vitest-environment happy-dom

import { renderHook } from '@renderer/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildExternalDeliveryFailedToast,
  useExternalDeliveryFailedToast,
  type ExternalDeliveryFailedPayload,
} from '../useExternalDeliveryFailedToast';

type Subscriber = (payload: ExternalDeliveryFailedPayload) => void;

interface MockApi {
  onExternalDeliveryFailed: (cb: Subscriber) => () => void;
}

let _lastSubscriber: Subscriber | null = null;
let unsubscribeSpy: ReturnType<typeof vi.fn<() => void>>;

function installMockApi(): { fire: (payload: ExternalDeliveryFailedPayload) => void } {
  unsubscribeSpy = vi.fn<() => void>();
  const subscribers = new Set<Subscriber>();

  const api: MockApi = {
    onExternalDeliveryFailed: (cb) => {
      subscribers.add(cb);
      _lastSubscriber = cb;
      return () => {
        subscribers.delete(cb);
        unsubscribeSpy();
      };
    },
  };

  (window as unknown as { api: MockApi }).api = api;

  return {
    fire: (payload) => {
      for (const sub of subscribers) sub(payload);
    },
  };
}

describe('buildExternalDeliveryFailedToast', () => {
  it('produces an error variant for retries_exhausted with a View action', () => {
    const onView = vi.fn();
    const spec = buildExternalDeliveryFailedToast(
      {
        deliveryId: 'd1',
        conversationId: 'c1',
        teamId: 'T1',
        reason: 'retries_exhausted',
        permanent: true,
      },
      { onView },
    );
    expect(spec.variant).toBe('error');
    expect(spec.title).toMatch(/Slack didn't take the hint/);
    expect(spec.action?.label).toBe('View conversation');
    spec.action?.onClick();
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it('produces a warning variant for workspace_disconnected with a Reconnect action', () => {
    const onReconnect = vi.fn();
    const spec = buildExternalDeliveryFailedToast(
      {
        deliveryId: 'd2',
        conversationId: 'c2',
        teamId: 'T2',
        reason: 'workspace_disconnected',
        permanent: true,
      },
      { onReconnect },
    );
    expect(spec.variant).toBe('warning');
    expect(spec.title).toMatch(/Slack disconnected mid-conversation/);
    expect(spec.action?.label).toBe('Reconnect Slack');
    spec.action?.onClick();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('omits the action when no callback is supplied', () => {
    const spec = buildExternalDeliveryFailedToast(
      {
        deliveryId: 'd',
        conversationId: 'c',
        teamId: 'T',
        reason: 'workspace_disconnected',
      },
      {},
    );
    expect(spec.action).toBeUndefined();
  });

  it('falls back to a defensive error toast for unknown reasons', () => {
    const spec = buildExternalDeliveryFailedToast(
      {
        deliveryId: 'd',
        conversationId: 'c',
        teamId: 'T',
        reason: 'mystery_reason',
      },
      {},
    );
    expect(spec.variant).toBe('error');
    expect(spec.description).toContain('mystery_reason');
  });
});

describe('useExternalDeliveryFailedToast', () => {
  beforeEach(() => {
    _lastSubscriber = null;
  });

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api;
    vi.restoreAllMocks();
  });

  it('subscribes to onExternalDeliveryFailed and shows a toast on payload', () => {
    const { fire } = installMockApi();
    const showToast = vi.fn();
    const navigateToConversation = vi.fn();

    renderHook(() =>
      useExternalDeliveryFailedToast({ showToast, navigateToConversation }),
    );

    fire({
      deliveryId: 'd1',
      conversationId: 'c1',
      teamId: 'T1',
      reason: 'retries_exhausted',
      permanent: true,
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    const arg = showToast.mock.calls[0][0];
    expect(arg.variant).toBe('error');
    expect(arg.title).toMatch(/Slack didn't take the hint/);
  });

  it('uses payload.conversationId for navigation, not the ambient session', () => {
    const { fire } = installMockApi();
    const showToast = vi.fn();
    const navigateToConversation = vi.fn();

    renderHook(() =>
      useExternalDeliveryFailedToast({ showToast, navigateToConversation }),
    );

    fire({
      deliveryId: 'd1',
      conversationId: 'background-convo-99',
      teamId: 'T1',
      reason: 'retries_exhausted',
      permanent: true,
    });

    const arg = showToast.mock.calls[0][0];
    expect(typeof arg.action.onClick).toBe('function');
    arg.action.onClick();
    expect(navigateToConversation).toHaveBeenCalledWith('background-convo-99');
  });

  it('dedupes by deliveryId across repeated broadcasts', () => {
    const { fire } = installMockApi();
    const showToast = vi.fn();
    const navigateToConversation = vi.fn();

    renderHook(() =>
      useExternalDeliveryFailedToast({ showToast, navigateToConversation }),
    );

    fire({
      deliveryId: 'd1',
      conversationId: 'c1',
      teamId: 'T1',
      reason: 'retries_exhausted',
      permanent: true,
    });
    fire({
      deliveryId: 'd1',
      conversationId: 'c1',
      teamId: 'T1',
      reason: 'retries_exhausted',
      permanent: true,
    });

    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('fires for distinct deliveryIds', () => {
    const { fire } = installMockApi();
    const showToast = vi.fn();
    const navigateToConversation = vi.fn();

    renderHook(() =>
      useExternalDeliveryFailedToast({ showToast, navigateToConversation }),
    );

    fire({
      deliveryId: 'd1',
      conversationId: 'c1',
      teamId: 'T1',
      reason: 'retries_exhausted',
      permanent: true,
    });
    fire({
      deliveryId: 'd2',
      conversationId: 'c1',
      teamId: 'T1',
      reason: 'workspace_disconnected',
      permanent: true,
    });

    expect(showToast).toHaveBeenCalledTimes(2);
    expect(showToast.mock.calls[0][0].variant).toBe('error');
    expect(showToast.mock.calls[1][0].variant).toBe('warning');
  });

  it('unsubscribes on unmount', () => {
    installMockApi();
    const showToast = vi.fn();
    const navigateToConversation = vi.fn();

    const { unmount } = renderHook(() =>
      useExternalDeliveryFailedToast({ showToast, navigateToConversation }),
    );

    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('passes openSlackReconnect through to the workspace_disconnected action', () => {
    const { fire } = installMockApi();
    const showToast = vi.fn();
    const navigateToConversation = vi.fn();
    const openSlackReconnect = vi.fn();

    renderHook(() =>
      useExternalDeliveryFailedToast({
        showToast,
        navigateToConversation,
        openSlackReconnect,
      }),
    );

    fire({
      deliveryId: 'd1',
      conversationId: 'c1',
      teamId: 'T1',
      reason: 'workspace_disconnected',
      permanent: true,
    });

    const arg = showToast.mock.calls[0][0];
    arg.action.onClick();
    expect(openSlackReconnect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when window.api is missing', () => {
    delete (window as unknown as { api?: unknown }).api;
    const showToast = vi.fn();
    const navigateToConversation = vi.fn();

    expect(() =>
      renderHook(() =>
        useExternalDeliveryFailedToast({ showToast, navigateToConversation }),
      ),
    ).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });
});
