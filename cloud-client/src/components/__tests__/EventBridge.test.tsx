import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

type EventHandler = (channel: string, args: unknown[]) => void;
let capturedHandler: EventHandler | null = null;

const {
  mockMeetingEventEmit,
  mockSetConnectionState,
  mockSetForceEventReconnect,
  mockHandleSessionChanged,
  mockApplyCatchUpEvents,
  mockRecordContinuityEvent,
  mockFetchSessions,
  mockHandleSessionTombstoned,
  mockHandleApprovalEvent,
  mockHandleMemoryEvent,
  mockHandleInboxEvent,
  mockHandleStagedFilesChanged,
  mockMarkSessionConflict,
  mockClearSessionConflict,
} = vi.hoisted(() => ({
  mockMeetingEventEmit: vi.fn(),
  mockSetConnectionState: vi.fn(),
  mockSetForceEventReconnect: vi.fn(),
  mockHandleSessionChanged: vi.fn(),
  mockApplyCatchUpEvents: vi.fn(),
  mockRecordContinuityEvent: vi.fn(),
  mockFetchSessions: vi.fn(),
  mockHandleSessionTombstoned: vi.fn(),
  mockHandleApprovalEvent: vi.fn(),
  mockHandleMemoryEvent: vi.fn(),
  mockHandleInboxEvent: vi.fn(),
  mockHandleStagedFilesChanged: vi.fn(),
  mockMarkSessionConflict: vi.fn(),
  mockClearSessionConflict: vi.fn(),
}));

vi.mock('../../hooks/useEventChannel', () => ({
  useEventChannel: (onEvent: EventHandler) => {
    capturedHandler = onEvent;
    return { forceReconnect: vi.fn() };
  },
}));

vi.mock('../../auth/createAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { isPaired: boolean }) => unknown) => selector({ isPaired: true }),
    {
      getState: () => ({ isPaired: true }),
    },
  ),
}));

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      appliedSeq: {},
      currentSession: null,
      handleSessionChanged: mockHandleSessionChanged,
      handleSessionTombstoned: mockHandleSessionTombstoned,
      setConnectionState: mockSetConnectionState,
      setForceEventReconnect: mockSetForceEventReconnect,
      applyCatchUpEvents: mockApplyCatchUpEvents,
      recordContinuityEvent: mockRecordContinuityEvent,
      fetchSessions: mockFetchSessions,
    }),
  },
}));

vi.mock('../../stores/approvalStore', () => ({
  useApprovalStore: {
    getState: () => ({
      handleApprovalEvent: mockHandleApprovalEvent,
      handleMemoryEvent: mockHandleMemoryEvent,
    }),
  },
}));

vi.mock('../../stores/inboxStore', () => ({
  useInboxStore: {
    getState: () => ({
      handleInboxEvent: mockHandleInboxEvent,
    }),
  },
}));

vi.mock('../../stores/stagedFilesStore', () => ({
  useStagedFilesStore: {
    getState: () => ({
      handleStagedFilesChanged: mockHandleStagedFilesChanged,
    }),
  },
}));

vi.mock('../../stores/sessionConflictStore', () => ({
  useSessionConflictStore: {
    getState: () => ({
      markSessionConflict: mockMarkSessionConflict,
      clearSessionConflict: mockClearSessionConflict,
    }),
  },
}));

vi.mock('../../utils/meetingEventEmitter', () => ({
  meetingEventEmitter: {
    emit: mockMeetingEventEmit,
  },
}));

import { EventBridge } from '../EventBridge';

describe('EventBridge meeting event forwarding', () => {
  beforeEach(() => {
    capturedHandler = null;
    mockMeetingEventEmit.mockClear();
    renderToString(React.createElement(EventBridge));
    expect(capturedHandler).not.toBeNull();
  });

  afterEach(() => {
    capturedHandler = null;
  });

  it('forwards meeting:trigger-heard to meetingEventEmitter', () => {
    const payload = {
      sessionId: 'meeting-1',
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: 'unknown',
      triggeredAt: 12345,
      triggerExtracted: 'summarise so far',
    } as const;

    capturedHandler!('meeting:trigger-heard', [payload]);

    expect(mockMeetingEventEmit).toHaveBeenCalledWith('trigger-heard', payload);
  });

  it('forwards meeting:companion-turn-started to meetingEventEmitter', () => {
    const payload = {
      sessionId: 'meeting-1',
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: 'unknown',
      triggeredAt: 12345,
      triggerExtracted: 'summarise so far',
      turnId: 'turn-1',
      companionSessionId: 'companion-1',
    } as const;

    capturedHandler!('meeting:companion-turn-started', [payload]);

    expect(mockMeetingEventEmit).toHaveBeenCalledWith('companion-turn-started', payload);
  });

  it('forwards meeting:trigger-rate-limit-exceeded to meetingEventEmitter', () => {
    const payload = {
      sessionId: 'meeting-1',
      resetsAt: 12345,
    } as const;

    capturedHandler!('meeting:trigger-rate-limit-exceeded', [payload]);

    expect(mockMeetingEventEmit).toHaveBeenCalledWith('trigger-rate-limit-exceeded', payload);
  });

  it('forwards meeting:trigger-dropped to meetingEventEmitter', () => {
    const payload = {
      sessionId: 'meeting-1',
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: 'unknown',
      triggeredAt: 12345,
      triggerExtracted: 'summarise so far',
      reason: 'action-timeout',
    } as const;

    capturedHandler!('meeting:trigger-dropped', [payload]);

    expect(mockMeetingEventEmit).toHaveBeenCalledWith('trigger-dropped', payload);
  });
});
