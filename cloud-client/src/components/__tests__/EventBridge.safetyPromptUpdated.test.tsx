/**
 * F-R3-8 — EventBridge safety-prompt:updated forwarding tests.
 *
 * Renders the actual `<EventBridge>` component, captures the event handler
 * it passes to `useEventChannel`, and asserts that valid payloads are forwarded
 * to `safetyPromptEventEmitter` while malformed payloads are rejected.
 *
 * Replaces the previous test (F-R2-6 / F-R2-11) that duplicated the handler
 * logic inline instead of exercising the real EventBridge component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { safetyPromptEventEmitter } from '../../utils/safetyPromptEventEmitter';

// ---------------------------------------------------------------------------
// Capture the handleEvent callback from EventBridge
// ---------------------------------------------------------------------------
type EventHandler = (channel: string, args: unknown[]) => void;
let capturedHandler: EventHandler | null = null;

vi.mock('../../hooks/useEventChannel', () => ({
  useEventChannel: (onEvent: EventHandler) => {
    capturedHandler = onEvent;
    return { forceReconnect: vi.fn() };
  },
}));

vi.mock('../../auth/createAuthStore', () => ({
  useAuthStore: Object.assign(
    // Selector usage: useAuthStore(selector) — returns isPaired = true
    (selector: (s: { isPaired: boolean }) => unknown) => selector({ isPaired: true }),
    { getState: () => ({ isPaired: true }) },
  ),
}));

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({
      handleSessionChanged: vi.fn(),
      setConnectionState: vi.fn(),
      setForceEventReconnect: vi.fn(),
    }),
    {
      getState: () => ({
        handleSessionChanged: vi.fn(),
        setConnectionState: vi.fn(),
        setForceEventReconnect: vi.fn(),
      }),
    },
  ),
}));

vi.mock('../../stores/approvalStore', () => ({
  useApprovalStore: Object.assign(vi.fn(), {
    getState: () => ({
      handleApprovalEvent: vi.fn(),
      handleMemoryEvent: vi.fn(),
    }),
  }),
}));

vi.mock('../../stores/inboxStore', () => ({
  useInboxStore: Object.assign(vi.fn(), {
    getState: () => ({ handleInboxEvent: vi.fn() }),
  }),
}));

vi.mock('../../stores/stagedFilesStore', () => ({
  useStagedFilesStore: Object.assign(vi.fn(), {
    getState: () => ({ handleStagedFilesChanged: vi.fn() }),
  }),
}));

// Import EventBridge after mocks are hoisted
import { EventBridge } from '../EventBridge';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventBridge — safety-prompt:updated forwarding (F-R3-8)', () => {
  beforeEach(() => {
    capturedHandler = null;
    safetyPromptEventEmitter.reset();
    render(React.createElement(EventBridge));
    // After render, useEventChannel should have been called and capturedHandler set
    expect(capturedHandler).not.toBeNull();
  });

  afterEach(() => {
    cleanup();
    safetyPromptEventEmitter.reset();
  });

  it('forwards a valid payload to the emitter', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    const valid = { version: 3, lastUpdatedAt: 1713200000000, lastUpdatedBy: 'user' };
    capturedHandler!('safety-prompt:updated', [valid]);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(valid);
  });

  it('forwards payload with lastUpdatedBy=system', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', [
      { version: 4, lastUpdatedAt: 1713200000000, lastUpdatedBy: 'system' },
    ]);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('forwards payload with lastUpdatedBy=migration', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', [
      { version: 5, lastUpdatedAt: 1713200000000, lastUpdatedBy: 'migration' },
    ]);

    expect(handler).toHaveBeenCalledOnce();
  });

  // --- Malformed payloads ---

  it('rejects payload with missing version', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', [{ lastUpdatedAt: 123, lastUpdatedBy: 'user' }]);

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects payload with non-number version', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', [{ version: '3', lastUpdatedAt: 123, lastUpdatedBy: 'user' }]);

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects payload with missing lastUpdatedAt', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', [{ version: 6, lastUpdatedBy: 'user' }]);

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects payload with missing lastUpdatedBy', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', [{ version: 7, lastUpdatedAt: 123 }]);

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects payload with invalid lastUpdatedBy value', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', [{ version: 8, lastUpdatedAt: 123, lastUpdatedBy: 'hacker' }]);

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects empty args', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', []);

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects null payload', () => {
    const handler = vi.fn();
    safetyPromptEventEmitter.on('safety-prompt:updated', handler);

    capturedHandler!('safety-prompt:updated', [null]);

    expect(handler).not.toHaveBeenCalled();
  });
});
