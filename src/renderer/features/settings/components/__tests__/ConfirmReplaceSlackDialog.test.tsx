// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmReplaceSlackDialog } from '../ConfirmReplaceSlackDialog';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(ui: React.ReactElement): { root: Root; container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function buttonByName(name: string): HTMLButtonElement {
  const match = Array.from(document.body.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(name));
  if (!match) throw new Error(`Button not found: ${name}`);
  return match as HTMLButtonElement;
}

describe('ConfirmReplaceSlackDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the binding title and body copy', () => {
    const mounted = mount(
      <ConfirmReplaceSlackDialog open slackName="Acme Slack" onOpenChange={() => undefined} onConfirm={() => undefined} />,
    );

    expect(document.body.textContent).toContain('Disconnect current Slack?');
    expect(document.body.textContent).toContain('Rebel is connected to Acme Slack. To connect a different Slack, disconnect this one first.');
    mounted.unmount();
  });

  it('fires cancel and confirm callbacks', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const mounted = mount(
      <ConfirmReplaceSlackDialog open slackName="Acme Slack" onOpenChange={onOpenChange} onConfirm={onConfirm} />,
    );

    act(() => buttonByName('Keep current').click());
    expect(onOpenChange).toHaveBeenCalledWith(false);

    act(() => buttonByName('Disconnect and continue').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('uses destructive styling for the confirm action', () => {
    const mounted = mount(
      <ConfirmReplaceSlackDialog open slackName="Acme Slack" onOpenChange={() => undefined} onConfirm={() => undefined} />,
    );

    expect(buttonByName('Disconnect and continue').className).toContain('btn-destructive');
    mounted.unmount();
  });

  it('uses ghost styling for cancel and labels the single dialog role', () => {
    const mounted = mount(
      <ConfirmReplaceSlackDialog open slackName="Acme Slack" onOpenChange={() => undefined} onConfirm={() => undefined} />,
    );

    expect(buttonByName('Keep current').className).toContain('btn-ghost');
    const dialogs = document.body.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(1);
    const titleId = dialogs[0].getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBe('Disconnect current Slack?');
    mounted.unmount();
  });
});
