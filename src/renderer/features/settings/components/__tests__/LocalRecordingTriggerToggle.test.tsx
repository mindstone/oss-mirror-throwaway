// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalRecordingTriggerToggle } from '../LocalRecordingTriggerToggle';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

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

describe('LocalRecordingTriggerToggle', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    while (mounted.length > 0) {
      mounted.pop()?.unmount();
    }
  });

  it('defaults to enabled when triggerPhrase is explicitly set', () => {
    const updateMeetingBot = vi.fn();
    const rendered = mount(
      <LocalRecordingTriggerToggle
        meetingBot={{ triggerPhrase: 'Spark' }}
        updateMeetingBot={updateMeetingBot}
      />,
    );
    mounted.push(rendered);

    const checkbox = rendered.container.querySelector<HTMLInputElement>('#local-recording-trigger-listening');
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
  });

  it('defaults to disabled when triggerPhrase is unset', () => {
    const updateMeetingBot = vi.fn();
    const rendered = mount(
      <LocalRecordingTriggerToggle
        meetingBot={{ triggerPhrase: null }}
        updateMeetingBot={updateMeetingBot}
      />,
    );
    mounted.push(rendered);

    const checkbox = rendered.container.querySelector<HTMLInputElement>('#local-recording-trigger-listening');
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
  });

  it('respects explicit localRecordingTriggerListening overrides', () => {
    const updateMeetingBot = vi.fn();
    const rendered = mount(
      <LocalRecordingTriggerToggle
        meetingBot={{ triggerPhrase: 'Spark', localRecordingTriggerListening: false }}
        updateMeetingBot={updateMeetingBot}
      />,
    );
    mounted.push(rendered);

    const checkbox = rendered.container.querySelector<HTMLInputElement>('#local-recording-trigger-listening');
    expect(checkbox?.checked).toBe(false);
  });

  it('updates settings when the checkbox changes', () => {
    const updateMeetingBot = vi.fn();
    const rendered = mount(
      <LocalRecordingTriggerToggle
        meetingBot={{ triggerPhrase: null, localRecordingTriggerListening: false }}
        updateMeetingBot={updateMeetingBot}
      />,
    );
    mounted.push(rendered);

    const checkbox = rendered.container.querySelector<HTMLInputElement>('#local-recording-trigger-listening');
    expect(checkbox).not.toBeNull();

    act(() => {
      checkbox!.click();
    });

    expect(updateMeetingBot).toHaveBeenCalledWith({ localRecordingTriggerListening: true });
  });
});
