/**
 * Shared test helpers for cloud-client tests.
 */

import type { SessionSummary, SessionMessage, FullSession } from '../types';

export function mockSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  const now = Date.now();
  return {
    id: `session-${now}`,
    title: 'Test Session',
    createdAt: now - 10_000,
    updatedAt: now,
    resolvedAt: null,
    preview: 'Hello world',
    messageCount: 2,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    usage: { costUsd: 0, inputTokens: 100, outputTokens: 200, turnCount: 1 },
    ...overrides,
  };
}

export function mockMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    turnId: 'turn-1',
    role: 'user',
    text: 'Hello',
    createdAt: Date.now(),
    ...overrides,
  };
}

export function mockFullSession(overrides: Partial<FullSession> = {}): FullSession {
  return {
    id: 'session-1',
    title: 'Test Conversation',
    messages: [
      mockMessage({ id: 'msg-1', role: 'user', text: 'Hello' }),
      mockMessage({ id: 'msg-2', role: 'assistant', text: 'Hi there!' }),
    ],
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    ...overrides,
  };
}

/**
 * Mock WebSocket that allows tests to simulate server messages and lifecycle events.
 */
export class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  private _closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Auto-open on next tick
    setTimeout(() => {
      if (!this._closed) {
        this.readyState = 1; // OPEN
        this.onopen?.({});
      }
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('WebSocket not open');
    // Tests can spy on this
  }

  close(code?: number, reason?: string): void {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason });
  }

  // Test helpers
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError(): void {
    this.onerror?.({});
  }

  simulateClose(code = 1000, reason = ''): void {
    this._closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static get last(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function advanceTimersAndFlush(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  return flushPromises();
}
