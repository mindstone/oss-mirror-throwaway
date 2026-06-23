import { describe, it, expect } from 'vitest';
import { AgentSessionSchema } from '../agent';
import { AgentSessionSummarySchema } from '../sessions';

/**
 * Tests that supported non-manual origins are accepted by both session schemas,
 * and that unsupported origin values are rejected.
 */

/** Minimal valid AgentSession payload for schema validation. */
const baseSession = {
  id: 'test-session-1',
  title: 'Test Session',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: null,
};

/** Minimal valid AgentSessionSummary payload for schema validation. */
const baseSummary = {
  id: 'test-session-1',
  title: 'Test Session',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  resolvedAt: null,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'manual' as const,
  isCorrupted: false,
  preview: '',
  messageCount: 0,
  hasDraft: false,
  draftPreview: null,
  draftUpdatedAt: null,
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
  activeTurnId: null,
  isBusy: false,
  lastError: null,
};

describe('AgentSessionSchema origin validation', () => {
  it('accepts origin: "plugin"', () => {
    const result = AgentSessionSchema.safeParse({ ...baseSession, origin: 'plugin' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "manual"', () => {
    const result = AgentSessionSchema.safeParse({ ...baseSession, origin: 'manual' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "automation"', () => {
    const result = AgentSessionSchema.safeParse({ ...baseSession, origin: 'automation' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "role"', () => {
    const result = AgentSessionSchema.safeParse({ ...baseSession, origin: 'role' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "focus"', () => {
    const result = AgentSessionSchema.safeParse({ ...baseSession, origin: 'focus' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "browser-extension"', () => {
    const result = AgentSessionSchema.safeParse({ ...baseSession, origin: 'browser-extension' });
    expect(result.success).toBe(true);
  });

  it('rejects unsupported origin value "unknown"', () => {
    const result = AgentSessionSchema.safeParse({ ...baseSession, origin: 'unknown' });
    expect(result.success).toBe(false);
  });
});

describe('AgentSessionSummarySchema origin validation', () => {
  it('accepts origin: "plugin"', () => {
    const result = AgentSessionSummarySchema.safeParse({ ...baseSummary, origin: 'plugin' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "manual"', () => {
    const result = AgentSessionSummarySchema.safeParse({ ...baseSummary, origin: 'manual' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "role"', () => {
    const result = AgentSessionSummarySchema.safeParse({ ...baseSummary, origin: 'role' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "focus"', () => {
    const result = AgentSessionSummarySchema.safeParse({ ...baseSummary, origin: 'focus' });
    expect(result.success).toBe(true);
  });

  it('accepts origin: "browser-extension"', () => {
    const result = AgentSessionSummarySchema.safeParse({ ...baseSummary, origin: 'browser-extension' });
    expect(result.success).toBe(true);
  });

  it('rejects unsupported origin value "unknown"', () => {
    const result = AgentSessionSummarySchema.safeParse({ ...baseSummary, origin: 'unknown' });
    expect(result.success).toBe(false);
  });
});
