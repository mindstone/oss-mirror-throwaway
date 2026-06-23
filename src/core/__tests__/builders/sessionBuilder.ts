/**
 * Test data builder for AgentSession.
 *
 * Provides a minimal valid AgentSession object with sensible defaults.
 *
 * Usage:
 *   const session = buildSession();
 *   const custom = buildSession({ title: 'My test session', isBusy: true });
 */
import type { AgentSession } from '@shared/types';

let sessionCounter = 0;

/**
 * Minimal valid AgentSession defaults for tests.
 * All required fields are populated; optional fields are omitted.
 */
function createDefaultSession(): AgentSession {
  sessionCounter++;
  const now = Date.now();
  return {
    id: `test-session-${sessionCounter}`,
    title: 'Test Session',
    createdAt: now,
    updatedAt: now,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  };
}

/**
 * Build a valid AgentSession object with optional overrides.
 * Uses shallow merge — nested objects (messages, eventsByTurn, etc.) are replaced
 * entirely if provided in overrides.
 *
 * Each call generates a unique session ID via an auto-incrementing counter.
 */
export function buildSession(overrides?: Partial<AgentSession>): AgentSession {
  return { ...createDefaultSession(), ...overrides };
}

/**
 * Reset the session counter (useful in beforeEach blocks for deterministic IDs).
 */
export function resetSessionCounter(): void {
  sessionCounter = 0;
}
