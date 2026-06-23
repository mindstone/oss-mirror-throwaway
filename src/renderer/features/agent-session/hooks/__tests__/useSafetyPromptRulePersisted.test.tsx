// @vitest-environment happy-dom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSafetyPromptRulePersisted } from '../useSafetyPromptRulePersisted';

const showToast = vi.hoisted(() => vi.fn());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/components/ui', () => ({
  useToast: () => ({ showToast }),
}));

type RulePersistedPayload = Parameters<
  NonNullable<typeof window.safetyPromptSubscriptions.onSafetyPromptRulePersisted>
>[0] extends (payload: infer Payload) => void ? Payload : never;

function Harness(): null {
  useSafetyPromptRulePersisted();
  return null;
}

describe('useSafetyPromptRulePersisted', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let listener: ((payload: RulePersistedPayload) => void) | undefined;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let originalSubscriptions: typeof window.safetyPromptSubscriptions;

  beforeEach(() => {
    showToast.mockReset();
    unsubscribe = vi.fn();
    originalSubscriptions = window.safetyPromptSubscriptions;
    listener = undefined;
    Object.defineProperty(window, 'safetyPromptSubscriptions', {
      configurable: true,
      value: {
        ...originalSubscriptions,
        onSafetyPromptRulePersisted: vi.fn((callback: (payload: RulePersistedPayload) => void) => {
          listener = callback;
          return unsubscribe;
        }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    Object.defineProperty(window, 'safetyPromptSubscriptions', {
      configurable: true,
      value: originalSubscriptions,
    });
  });

  it('shows a toast when a safety rule is persisted', () => {
    act(() => {
      root?.render(<Harness />);
    });

    act(() => {
      listener?.({
        version: 7,
        lastUpdatedAt: 12345,
        source: 'chat-intent',
        summary: 'Rule added',
        proposedPrinciple: '- You may send weekly status updates.',
      });
    });

    expect(showToast).toHaveBeenCalledWith({
      title: "Rule saved (v7). Similar actions won't ask again.",
      variant: 'success',
      duration: 6000,
    });
  });

  it('unsubscribes on unmount', () => {
    act(() => {
      root?.render(<Harness />);
    });

    act(() => {
      root?.unmount();
    });
    root = null;

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
