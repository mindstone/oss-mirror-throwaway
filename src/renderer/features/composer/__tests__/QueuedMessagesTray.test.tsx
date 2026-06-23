// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { QueuedMessagesTrayProps } from '../QueuedMessagesTray';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

vi.mock('@renderer/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>(
    '@renderer/components/ui',
  );
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactElement }) => children,
  };
});

import { QueuedMessagesTray } from '../QueuedMessagesTray';

function buildProps(overrides: Partial<QueuedMessagesTrayProps> = {}): QueuedMessagesTrayProps {
  return {
    messageQueue: [
      {
        id: 'message-1',
        text: 'Draft the weekly update for product metrics',
        source: 'text',
      },
    ],
    currentSessionId: 'session-1',
    onRemove: vi.fn(),
    onSendNow: vi.fn(),
    ...overrides,
  };
}

function renderTray(props: QueuedMessagesTrayProps): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(React.createElement(QueuedMessagesTray, props));
  });

  return {
    container,
    unmount: () => {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function click(element: Element | null): void {
  if (!element) {
    throw new Error('Expected element to exist');
  }
  reactAct(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function keyDown(element: Element | null, key: string): void {
  if (!element) {
    throw new Error('Expected element to exist');
  }
  reactAct(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function getByTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe('QueuedMessagesTray', () => {
  it('first click on interrupt icon does NOT call onSendNow', () => {
    const onSendNow = vi.fn();
    const { container, unmount } = renderTray(buildProps({ onSendNow }));

    click(getByTestId(container, 'queued-message-send-now-message-1'));

    expect(onSendNow).not.toHaveBeenCalled();
    expect(getByTestId(container, 'queued-message-confirm-send-message-1')).not.toBeNull();

    unmount();
  });

  it('click on Interrupt & send button calls onSendNow with message id', () => {
    const onSendNow = vi.fn();
    const { container, unmount } = renderTray(buildProps({ onSendNow }));

    click(getByTestId(container, 'queued-message-send-now-message-1'));
    click(getByTestId(container, 'queued-message-confirm-send-message-1'));

    expect(onSendNow).toHaveBeenCalledTimes(1);
    expect(onSendNow).toHaveBeenCalledWith('message-1');

    unmount();
  });

  it('click on Keep queued exits confirmation without calling onSendNow', () => {
    const onSendNow = vi.fn();
    const { container, unmount } = renderTray(buildProps({ onSendNow }));

    click(getByTestId(container, 'queued-message-send-now-message-1'));
    click(getByTestId(container, 'queued-message-keep-queued-message-1'));

    expect(onSendNow).not.toHaveBeenCalled();
    expect(getByTestId(container, 'queued-message-confirm-send-message-1')).toBeNull();
    expect(getByTestId(container, 'queued-message-send-now-message-1')).not.toBeNull();

    unmount();
  });

  it('pressing Escape in confirmation exits without calling onSendNow', () => {
    const onSendNow = vi.fn();
    const { container, unmount } = renderTray(buildProps({ onSendNow }));

    click(getByTestId(container, 'queued-message-send-now-message-1'));
    keyDown(getByTestId(container, 'queued-message-confirm-send-message-1'), 'Escape');

    expect(onSendNow).not.toHaveBeenCalled();
    expect(getByTestId(container, 'queued-message-confirm-send-message-1')).toBeNull();
    expect(getByTestId(container, 'queued-message-send-now-message-1')).not.toBeNull();

    unmount();
  });

  it('clicking interrupt on another row moves confirmation to that row', () => {
    const { container, unmount } = renderTray(
      buildProps({
        messageQueue: [
          { id: 'message-1', text: 'First queued item', source: 'text' },
          { id: 'message-2', text: 'Second queued item', source: 'text' },
        ],
      }),
    );

    click(getByTestId(container, 'queued-message-send-now-message-1'));
    expect(getByTestId(container, 'queued-message-confirm-send-message-1')).not.toBeNull();

    click(getByTestId(container, 'queued-message-send-now-message-2'));

    expect(getByTestId(container, 'queued-message-confirm-send-message-1')).toBeNull();
    expect(getByTestId(container, 'queued-message-confirm-send-message-2')).not.toBeNull();

    unmount();
  });

  it('aria-label on interrupt icon mentions interrupt', () => {
    const { container, unmount } = renderTray(buildProps());
    const interruptButton = getByTestId(
      container,
      'queued-message-send-now-message-1',
    ) as HTMLButtonElement | null;

    expect(interruptButton).not.toBeNull();
    expect(interruptButton?.getAttribute('aria-label')).toContain(
      'Interrupt current task and send queued message:',
    );

    unmount();
  });
});
