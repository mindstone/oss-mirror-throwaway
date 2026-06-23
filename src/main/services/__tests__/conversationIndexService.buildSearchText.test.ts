/**
 * Tests for buildSearchText helper in conversationIndexService.
 *
 * Verifies the pure text assembly logic that builds FTS-searchable content
 * from a session's messages: all non-hidden user messages + first non-hidden
 * assistant response (capped at 2K chars), within a 12K total budget.
 */

import { describe, expect, it } from 'vitest';
import { buildSearchText } from '../conversationIndexService';
import type { AgentEvent, AgentSession } from '@shared/types';

function makePrimaryEmailDraftEvent(
  overrides: Partial<Extract<AgentEvent, { type: 'tool' }>['mcpAppUiMeta']> = {},
): Extract<AgentEvent, { type: 'tool' }> {
  return {
    type: 'tool',
    toolName: 'compose_workspace_email',
    toolUseId: 'tool-1',
    detail: 'draft created',
    stage: 'end',
    timestamp: Date.now(),
    mcpAppUiMeta: {
      resourceUri: 'ui://google-workspace/compose-email',
      presentation: 'primary',
      viewSummary: 'Email draft to alice@example.com about Q2.',
      viewRoleLabel: 'Editable email draft',
      structuredFallback: {
        kind: 'email-draft',
        payload: {
          to: ['alice@example.com'],
          cc: ['charlie@example.com'],
          subject: 'Project update — Q2 plan',
          body: "Hi team — here's the draft for review.",
        },
      },
      ...overrides,
    },
  };
}

function makeSession(
  messages: Array<{ role: string; text?: string; isHidden?: boolean; turnId?: string }>,
  eventsByTurn: Record<string, AgentEvent[]> = {},
): AgentSession {
  return {
    id: 'test-session',
    title: 'Test Session',
    messages: messages.map((m, i) => ({
      id: `msg-${i}`,
      turnId: m.turnId ?? `turn-${i}`,
      role: m.role as 'user' | 'assistant' | 'result',
      text: m.text ?? '',
      isHidden: m.isHidden,
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    origin: 'manual' as const,
    eventsByTurn,
  } as unknown as AgentSession;
}

describe('buildSearchText', () => {
  it('includes all user messages in chronological order', () => {
    const session = makeSession([
      { role: 'user', text: 'First question' },
      { role: 'assistant', text: 'First answer' },
      { role: 'user', text: 'Second question' },
      { role: 'assistant', text: 'Second answer' },
    ]);

    const result = buildSearchText(session);
    expect(result).toContain('First question');
    expect(result).toContain('Second question');
    expect(result.indexOf('First question')).toBeLessThan(result.indexOf('Second question'));
  });

  it('includes first assistant response capped at 2K chars', () => {
    const longAssistant = 'A'.repeat(5000);
    const session = makeSession([
      { role: 'user', text: 'Question' },
      { role: 'assistant', text: longAssistant },
    ]);

    const result = buildSearchText(session);
    expect(result).toContain('Question');
    // Assistant text should be capped at 2000 chars
    const assistantPart = result.split('\n\n').find(p => p.startsWith('A'));
    expect(assistantPart!.length).toBeLessThanOrEqual(2000);
  });

  it('respects 12K total budget', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      text: `Message ${i}: ${'X'.repeat(1000)}`,
    }));
    const session = makeSession(messages);

    const result = buildSearchText(session);
    expect(result.length).toBeLessThanOrEqual(12_000);
  });

  it('returns empty string for session with no messages', () => {
    const session = makeSession([]);
    expect(buildSearchText(session)).toBe('');
  });

  it('excludes hidden user messages', () => {
    const session = makeSession([
      { role: 'user', text: 'Visible question' },
      { role: 'user', text: 'Hidden system prompt', isHidden: true },
      { role: 'user', text: 'Another visible question' },
    ]);

    const result = buildSearchText(session);
    expect(result).toContain('Visible question');
    expect(result).toContain('Another visible question');
    expect(result).not.toContain('Hidden system prompt');
  });

  it('excludes hidden assistant messages', () => {
    const session = makeSession([
      { role: 'user', text: 'Question' },
      { role: 'assistant', text: 'Hidden assistant', isHidden: true },
      { role: 'assistant', text: 'Visible assistant' },
    ]);

    const result = buildSearchText(session);
    expect(result).toContain('Visible assistant');
    expect(result).not.toContain('Hidden assistant');
  });

  it('excludes result role messages', () => {
    const session = makeSession([
      { role: 'user', text: 'Question' },
      { role: 'result', text: 'Tool result content' },
      { role: 'assistant', text: 'Answer' },
    ]);

    const result = buildSearchText(session);
    expect(result).toContain('Question');
    expect(result).toContain('Answer');
    expect(result).not.toContain('Tool result content');
  });

  it('only includes first assistant response, not subsequent ones', () => {
    const session = makeSession([
      { role: 'user', text: 'Question' },
      { role: 'assistant', text: 'First answer' },
      { role: 'user', text: 'Follow-up' },
      { role: 'assistant', text: 'Second answer' },
    ]);

    const result = buildSearchText(session);
    expect(result).toContain('First answer');
    expect(result).not.toContain('Second answer');
  });

  it('handles session with only assistant messages', () => {
    const session = makeSession([
      { role: 'assistant', text: 'Solo assistant' },
    ]);

    const result = buildSearchText(session);
    expect(result).toBe('Solo assistant');
  });

  it('skips messages with empty text', () => {
    const session = makeSession([
      { role: 'user', text: '' },
      { role: 'user', text: 'Real question' },
    ]);

    const result = buildSearchText(session);
    expect(result).toBe('Real question');
  });

  it('joins snippets with double newlines', () => {
    const session = makeSession([
      { role: 'user', text: 'First' },
      { role: 'user', text: 'Second' },
    ]);

    const result = buildSearchText(session);
    expect(result).toBe('First\n\nSecond');
  });

  it('truncates long user messages to fit budget', () => {
    const longText = 'X'.repeat(15_000);
    const session = makeSession([
      { role: 'user', text: longText },
      { role: 'user', text: 'Should not appear' },
    ]);

    const result = buildSearchText(session);
    expect(result.length).toBeLessThanOrEqual(12_000);
    // Second message should be excluded since budget is exhausted
    expect(result).not.toContain('Should not appear');
  });

  it('caps assistant text within remaining budget', () => {
    // Fill most of the budget with user messages
    const userText = 'U'.repeat(11_500);
    const assistantText = 'A'.repeat(3000);
    const session = makeSession([
      { role: 'user', text: userText },
      { role: 'assistant', text: assistantText },
    ]);

    const result = buildSearchText(session);
    // Total should be within 12K budget
    expect(result.length).toBeLessThanOrEqual(12_000);
    // Assistant text should be present but truncated to remaining budget
    const parts = result.split('\n\n');
    expect(parts.length).toBe(2);
    expect(parts[1].length).toBeLessThan(2000);
  });

  it('indexes viewSummary and email-draft structured fallback for primary MCP Apps', () => {
    const session = makeSession(
      [
        { role: 'user', text: 'Draft an email', turnId: 'turn-user' },
        { role: 'assistant', text: 'I drafted it for you.', turnId: 'turn-assistant' },
      ],
      { 'turn-assistant': [makePrimaryEmailDraftEvent()] },
    );

    const result = buildSearchText(session);

    expect(result).toContain('I drafted it for you.');
    expect(result).toContain('Email draft to alice@example.com about Q2.');
    expect(result).toContain('To: alice@example.com');
    expect(result).toContain('Cc: charlie@example.com');
    expect(result).toContain('Subject: Project update — Q2 plan');
    expect(result).toContain("Hi team — here's the draft for review.");
  });

  it('does not index viewSummary for inline MCP Apps', () => {
    const session = makeSession(
      [
        { role: 'user', text: 'Draft an email', turnId: 'turn-user' },
        { role: 'assistant', text: 'Inline prose covers the result.', turnId: 'turn-assistant' },
      ],
      {
        'turn-assistant': [
          makePrimaryEmailDraftEvent({
            presentation: 'inline',
            viewSummary: 'Inline summary should not be indexed.',
          }),
        ],
      },
    );

    const result = buildSearchText(session);

    expect(result).toContain('Inline prose covers the result.');
    expect(result).not.toContain('Inline summary should not be indexed.');
    expect(result).not.toContain('To: alice@example.com');
  });

  it('indexes viewSummary only for primary MCP Apps without structuredFallback', () => {
    const session = makeSession(
      [
        { role: 'assistant', text: 'Draft created.', turnId: 'turn-assistant' },
      ],
      {
        'turn-assistant': [
          makePrimaryEmailDraftEvent({
            viewSummary: 'Primary view summary only.',
            structuredFallback: undefined,
          }),
        ],
      },
    );

    const result = buildSearchText(session);

    expect(result).toContain('Primary view summary only.');
    expect(result).not.toContain('To: alice@example.com');
    expect(result).not.toContain('Subject: Project update — Q2 plan');
  });
});
