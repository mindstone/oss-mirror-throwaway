// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MeetingTurnSpeakerAttribution } from '../MeetingTurnSpeakerAttribution';

describe('MeetingTurnSpeakerAttribution', () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
  });

  it('renders nothing for assistant messages', async () => {
    await act(async () => {
      root?.render(
        <MeetingTurnSpeakerAttribution
          message={{ role: 'assistant' }}
        />
      );
    });
    expect(container?.firstChild).toBeNull();
  });

  it('renders nothing for user messages without triggerSource', async () => {
    await act(async () => {
      root?.render(
        <MeetingTurnSpeakerAttribution
          message={{ role: 'user' }}
        />
      );
    });
    expect(container?.firstChild).toBeNull();
  });

  it('renders "Asked by [Name]" when speaker is known', async () => {
    await act(async () => {
      root?.render(
        <MeetingTurnSpeakerAttribution
          message={{
            role: 'user',
            triggerSource: 'voice-trigger',
            triggerSourceSpeaker: 'Jane Doe',
          }}
        />
      );
    });
    expect(container?.textContent).toBe('Asked by Jane Doe');
  });

  it('renders "Asked by you while recording" for voice-trigger by user', async () => {
    await act(async () => {
      root?.render(
        <MeetingTurnSpeakerAttribution
          message={{
            role: 'user',
            triggerSource: 'voice-trigger',
            triggerSourceSpeaker: 'user',
          }}
        />
      );
    });
    expect(container?.textContent).toBe('Asked by you while recording');
  });

  it('renders "Asked by someone in the meeting" for voice-trigger unknown', async () => {
    await act(async () => {
      root?.render(
        <MeetingTurnSpeakerAttribution
          message={{
            role: 'user',
            triggerSource: 'voice-trigger',
            triggerSourceSpeaker: 'unknown',
          }}
        />
      );
    });
    expect(container?.textContent).toBe('Asked by someone in the meeting');
  });

  it('renders "Asked while recording" for quick-ask button', async () => {
    await act(async () => {
      root?.render(
        <MeetingTurnSpeakerAttribution
          message={{
            role: 'user',
            triggerSource: 'quick-ask-button',
            triggerSourceSpeaker: 'user',
          }}
        />
      );
    });
    expect(container?.textContent).toBe('Asked while recording');
  });
});
