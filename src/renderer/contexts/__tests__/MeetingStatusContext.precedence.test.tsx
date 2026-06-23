// @vitest-environment happy-dom

/**
 * Provider precedence regression test (FOX-3438).
 *
 * The local-recording service broadcasts the active recording with the high-precedence
 * `local_recording` source, but the upload/processing/done transitions with the
 * low-precedence `desktop_sdk` source. shouldOverrideStatus rejects a lower-precedence
 * incoming status while an active higher-precedence status is showing — so a stuck
 * `recording_local` can only be released by a SAME-SOURCE passive event
 * (`no_meetings`/`local_recording`). This test pins that contract:
 *
 *   recording_local/local_recording  (stuck — desktop_sdk upload is rejected)
 *   → no_meetings/local_recording      (same-source passive clear: ACCEPTED)
 *   → uploading_local/desktop_sdk      (now accepted: current state is passive)
 */

import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingStatusProvider, useMeetingStatusContext, type MeetingStatus } from '../MeetingStatusContext';

describe('MeetingStatusProvider precedence — local recording stop transition (FOX-3438)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: MeetingStatus | null = null;
  let emit: ((status: MeetingStatus) => void) | null = null;

  function Probe() {
    const status = useMeetingStatusContext();
    useEffect(() => {
      observed = status;
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    observed = null;
    emit = null;
    (window as unknown as { api: unknown }).api = {
      onMeetingBotStatus: (cb: (status: MeetingStatus) => void) => {
        emit = cb;
        return () => undefined;
      },
      onMeetingBotHealthWarning: () => () => undefined,
    };
    (window as unknown as { meetingBotApi: unknown }).meetingBotApi = {
      // Resolve to nothing so the initial fetch / recovery poll don't interfere.
      getCurrentStatus: vi.fn(async () => undefined),
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  function send(status: MeetingStatus) {
    act(() => {
      emit?.(status);
    });
  }

  it('a same-source passive clear releases recording_local so the desktop_sdk upload can take over', async () => {
    await act(async () => {
      root.render(
        <MeetingStatusProvider>
          <Probe />
        </MeetingStatusProvider>,
      );
    });

    // 1) Active recording from the high-precedence source.
    send({ state: 'recording_local', source: 'local_recording' });
    expect(observed?.state).toBe('recording_local');

    // 2) A low-precedence desktop_sdk upload arriving FIRST must be rejected
    //    (this is the bug: without the clear, the UI stays stuck on recording_local).
    send({ state: 'uploading_local', source: 'desktop_sdk' });
    expect(observed?.state).toBe('recording_local');
    expect(observed?.source).toBe('local_recording');

    // 3) The same-source passive clear is ACCEPTED and releases the active state.
    send({ state: 'no_meetings', source: 'local_recording' });
    expect(observed?.state).toBe('no_meetings');

    // 4) Now the low-precedence upload status is accepted (current state is passive).
    send({ state: 'uploading_local', source: 'desktop_sdk' });
    expect(observed?.state).toBe('uploading_local');
    expect(observed?.source).toBe('desktop_sdk');
  });
});
