// @vitest-environment happy-dom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { AgentErrorResolution, AgentErrorResolutionAction } from '@rebel/shared';
import { SessionErrorNotice } from '../components/SessionErrorNotice';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ErrorEvent = Extract<AgentEvent, { type: 'error' }>;
type ApplyResolutionResponse = {
  ok: boolean;
  appliedAction: AgentErrorResolutionAction['action'];
  reason?: 'turn_alive' | 'invalid_payload' | 'stale_turn' | 'in_flight';
};
type ApplyResolutionRequest = {
  turnId: string;
  action: AgentErrorResolutionAction['action'];
  payload?: AgentErrorResolutionAction['payload'];
};
type ErrorApiMock = {
  applyResolution: ReturnType<typeof vi.fn<(request: ApplyResolutionRequest) => Promise<ApplyResolutionResponse>>>;
};

function AppErrorRegionHarness({
  event,
  turnId = 'failed-turn-1',
}: {
  event: ErrorEvent;
  turnId?: string;
}) {
  const [pendingAction, setPendingAction] = useState<AgentErrorResolutionAction['action'] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const applyResolution = async (action: AgentErrorResolutionAction) => {
    if (pendingAction) return;

    setPendingAction(action.action);
    try {
      const result = await window.errorApi.applyResolution({
        turnId,
        action: action.action,
        payload: action.payload,
      });

      if (!result.ok) {
        if (result.reason === 'turn_alive' || result.reason === undefined) {
          setToast('Still working. Wait for the current attempt to finish, then try again.');
        } else if (result.reason === 'stale_turn') {
          setToast('Already moving. That error is from an older attempt.');
        } else {
          setToast("Couldn't apply. Try a different option.");
        }
      }
    } finally {
      setPendingAction(null);
    }
  };

  if (event.resolution?.category === 'transient' || event.resolution?.persistent === false) {
    return <div data-testid="transient-resolution-suppressed" />;
  }

  if (event.resolution) {
    return (
      <>
        <SessionErrorNotice
          resolution={event.resolution}
          dismissible={event.resolution.category !== 'system-broken'}
          pendingAction={pendingAction}
          onApply={(action) => {
            void applyResolution(action);
          }}
          onDismiss={() => {}}
        />
        {toast ? <div role="status">{toast}</div> : null}
      </>
    );
  }

  return (
    <div className="error-banner" data-testid="error-banner">
      <div className="error-banner-text">{event.error}</div>
      <div className="error-banner-actions">
        <button type="button">Open Settings</button>
        <button type="button">Try again</button>
      </div>
    </div>
  );
}

function render(ui: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

const codexUnsupportedWithAlternative: AgentErrorResolution = {
  category: 'unsupported-feature',
  kind: 'unsupported_model',
  title: "ChatGPT Pro doesn't run GPT-5.5 Pro.",
  body: 'Pick a model that works on your subscription, or switch providers.',
  alternatives: [
    { label: 'Use GPT-5.5', action: 'switch-model', payload: { model: 'gpt-5.5' }, variant: 'primary' },
    { label: 'Open settings', action: 'open-settings', payload: { settingsSection: 'providerKeys' }, variant: 'secondary' },
  ],
  defaultAction: { label: 'Use GPT-5.5', action: 'switch-model', payload: { model: 'gpt-5.5' } },
  persistent: true,
};

const codexUnsupportedWithoutAlternative: AgentErrorResolution = {
  category: 'unsupported-feature',
  kind: 'unsupported_model',
  title: "This model isn't available on your subscription.",
  body: 'Choose another to keep going.',
  alternatives: [
    { label: 'Choose another', action: 'open-settings', payload: { settingsSection: 'model' }, variant: 'primary' },
  ],
  defaultAction: { label: 'Choose another', action: 'open-settings', payload: { settingsSection: 'model' } },
  persistent: true,
};

const systemBroken: AgentErrorResolution = {
  category: 'system-broken',
  kind: 'routing',
  title: 'Rebel hit a snag in the plumbing.',
  body: 'Not your message — something on our end. Your work is saved.',
  alternatives: [
    { label: 'Try again', action: 'retry', variant: 'primary' },
    { label: 'Open Diagnose', action: 'open-settings', payload: { settingsSection: 'diagnose' }, variant: 'secondary' },
  ],
  defaultAction: { label: 'Try again', action: 'retry' },
  persistent: true,
};

const unknownFallback: AgentErrorResolution = {
  category: 'unknown',
  kind: 'unknown',
  title: 'Something went sideways.',
  body: 'Your message is safe. Try again, or check Settings → Diagnose.',
  alternatives: [
    { label: 'Try again', action: 'retry', variant: 'primary' },
    { label: 'Open Diagnose', action: 'open-settings', payload: { settingsSection: 'diagnose' }, variant: 'secondary' },
  ],
  defaultAction: { label: 'Try again', action: 'retry' },
  persistent: true,
};

const transient: AgentErrorResolution = {
  category: 'transient',
  kind: 'server_error',
  title: "Connection's been moody.",
  body: 'Saving your message — try again.',
  alternatives: [],
  persistent: false,
};

const baseErrorEvent: ErrorEvent = {
  type: 'error',
  error: 'Check Settings to update your credentials.',
  timestamp: 123,
  errorKind: 'auth',
};

function errorEvent(resolution: AgentErrorResolution): ErrorEvent {
  return {
    ...baseErrorEvent,
    error: resolution.title,
    errorKind: resolution.kind,
    resolution,
  };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  ) as HTMLButtonElement | undefined;
  expect(button).toBeDefined();
  return button!;
}

async function flushAsyncUpdates() {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('SessionErrorNotice App-level branch integration', () => {
  let root: Root | null = null;
  let applyResolutionMock: ErrorApiMock['applyResolution'];

  beforeEach(() => {
    applyResolutionMock = vi.fn(async (request) => ({ ok: true, appliedAction: request.action }));
    (window as unknown as { errorApi: ErrorApiMock }).errorApi = {
      applyResolution: applyResolutionMock,
    };
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders the legacy CTA row when an App error event has no resolution', () => {
    const rendered = render(<AppErrorRegionHarness event={baseErrorEvent} />);
    root = rendered.root;

    expect(rendered.container.querySelector('[data-testid="session-error-notice"]')).toBeNull();
    expect(rendered.container.textContent).toContain('Open Settings');
    expect(rendered.container.textContent).toContain('Try again');
  });

  it('renders SessionErrorNotice when resolution metadata is present', () => {
    const rendered = render(<AppErrorRegionHarness event={errorEvent(codexUnsupportedWithAlternative)} />);
    root = rendered.root;

    expect(rendered.container.querySelector('[data-testid="session-error-notice"]')).not.toBeNull();
    expect(rendered.container.querySelector('.error-banner [data-testid="session-error-notice"]')).toBeNull();
    expect(rendered.container.textContent).toContain("ChatGPT Pro doesn't run GPT-5.5 Pro.");
  });

  it.each([
    ['Codex unsupported with alternative', codexUnsupportedWithAlternative],
    ['Codex unsupported without alternative', codexUnsupportedWithoutAlternative],
    ['system-broken', systemBroken],
    ['unknown fallback', unknownFallback],
  ])('renders the %s resolution variant', (_label, variant) => {
    const rendered = render(<AppErrorRegionHarness event={errorEvent(variant)} />);
    root = rendered.root;

    expect(rendered.container.querySelector('[data-testid="session-error-notice"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain(variant.title);
    expect(rendered.container.textContent).toContain(variant.body);
  });

  it('suppresses transient resolution notices during the retry path', () => {
    const rendered = render(<AppErrorRegionHarness event={errorEvent(transient)} />);
    root = rendered.root;

    expect(rendered.container.querySelector('[data-testid="session-error-notice"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="transient-resolution-suppressed"]')).not.toBeNull();
  });

  it('invokes error:apply-resolution with the selected action payload', async () => {
    const rendered = render(
      <AppErrorRegionHarness
        event={errorEvent(codexUnsupportedWithAlternative)}
        turnId="failed-turn-codex"
      />,
    );
    root = rendered.root;

    act(() => {
      getButton(rendered.container, 'Use GPT-5.5').click();
    });
    await flushAsyncUpdates();

    expect(applyResolutionMock).toHaveBeenCalledWith({
      turnId: 'failed-turn-codex',
      action: 'switch-model',
      payload: { model: 'gpt-5.5' },
    });

    act(() => {
      getButton(rendered.container, 'Open settings').click();
    });
    await flushAsyncUpdates();

    expect(applyResolutionMock).toHaveBeenLastCalledWith({
      turnId: 'failed-turn-codex',
      action: 'open-settings',
      payload: { settingsSection: 'providerKeys' },
    });
  });

  it('invokes each non-Codex action with its payload shape', async () => {
    const cases: Array<[AgentErrorResolution, string, ApplyResolutionRequest]> = [
      [
        codexUnsupportedWithoutAlternative,
        'Choose another',
        { turnId: 'failed-turn-1', action: 'open-settings', payload: { settingsSection: 'model' } },
      ],
      [
        systemBroken,
        'Try again',
        { turnId: 'failed-turn-1', action: 'retry', payload: undefined },
      ],
      [
        systemBroken,
        'Open Diagnose',
        { turnId: 'failed-turn-1', action: 'open-settings', payload: { settingsSection: 'diagnose' } },
      ],
    ];

    for (const [variant, label, expectedPayload] of cases) {
      const rendered = render(<AppErrorRegionHarness event={errorEvent(variant)} />);
      root = rendered.root;

      act(() => {
        getButton(rendered.container, label).click();
      });
      await flushAsyncUpdates();

      expect(applyResolutionMock).toHaveBeenLastCalledWith(expectedPayload);

      act(() => {
        root?.unmount();
      });
      root = null;
      rendered.container.remove();
    }
  });

  it('keeps system-broken non-dismissible and other persistent notices dismissible', () => {
    const systemRendered = render(<AppErrorRegionHarness event={errorEvent(systemBroken)} />);
    root = systemRendered.root;

    expect(systemRendered.container.querySelector('button[aria-label="Dismiss notice"]')).toBeNull();

    act(() => {
      root?.unmount();
    });
    root = null;
    systemRendered.container.remove();

    for (const variant of [
      codexUnsupportedWithAlternative,
      codexUnsupportedWithoutAlternative,
    ]) {
      const rendered = render(<AppErrorRegionHarness event={errorEvent(variant)} />);
      root = rendered.root;
      expect(rendered.container.querySelector('button[aria-label="Dismiss notice"]')).not.toBeNull();
      act(() => {
        root?.unmount();
      });
      root = null;
      rendered.container.remove();
    }
  });

  it('disables other actions while a resolution action is in flight', async () => {
    const pending = deferred<ApplyResolutionResponse>();
    applyResolutionMock.mockReturnValueOnce(pending.promise);
    const rendered = render(<AppErrorRegionHarness event={errorEvent(codexUnsupportedWithAlternative)} />);
    root = rendered.root;

    act(() => {
      getButton(rendered.container, 'Use GPT-5.5').click();
    });

    const buttons = Array.from(
      rendered.container.querySelectorAll('[data-testid^="session-error-action-"]'),
    ) as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);

    act(() => {
      getButton(rendered.container, 'Open settings').click();
    });
    expect(applyResolutionMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ ok: true, appliedAction: 'switch-model' });
      await pending.promise;
    });
  });

  it("surfaces useful UX when main refuses because the failed turn is still alive", async () => {
    applyResolutionMock.mockResolvedValueOnce({
      ok: false,
      appliedAction: 'retry',
      reason: 'turn_alive',
    });
    const rendered = render(<AppErrorRegionHarness event={errorEvent(systemBroken)} />);
    root = rendered.root;

    act(() => {
      getButton(rendered.container, 'Try again').click();
    });
    await flushAsyncUpdates();

    expect(applyResolutionMock).toHaveBeenCalledWith({
      turnId: 'failed-turn-1',
      action: 'retry',
      payload: undefined,
    });
    expect(rendered.container.textContent).toContain('Still working');
    expect(rendered.container.textContent).toContain('Wait for the current attempt to finish');
  });
});
