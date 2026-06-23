import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import { cleanupEmptyCompanionSession, extractCompanionQAHistory, extractCompanionQAPairs } from '../companionQaExtractor';

function session(messages: Array<{ role: 'user' | 'assistant' | 'result'; text: string }>): AgentSession {
  return {
    id: 'companion',
    title: 'Companion',
    createdAt: 1,
    updatedAt: 1,
    messages: messages.map((message, index) => ({ id: `m${index}`, turnId: `t${index}`, createdAt: index, ...message })),
    eventsByTurn: {},
  } as AgentSession;
}

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe('companion QA extractor', () => {
  it('returns undefined for missing session', () => {
    expect(extractCompanionQAPairs(null)).toBeUndefined();
  });

  it('pairs each user message with the next assistant message', () => {
    expect(extractCompanionQAPairs(session([
      { role: 'user', text: ' Q1 ' },
      { role: 'assistant', text: ' A1 ' },
    ]))).toEqual([{ question: 'Q1', answer: 'A1' }]);
  });

  it('pins duplicate pairing for consecutive user messages', () => {
    expect(extractCompanionQAPairs(session([
      { role: 'user', text: 'Q1' },
      { role: 'user', text: 'Q2' },
      { role: 'assistant', text: 'A' },
    ]))).toEqual([{ question: 'Q1', answer: 'A' }, { question: 'Q2', answer: 'A' }]);
  });

  it('skips blank user messages and users without an answer', () => {
    expect(extractCompanionQAPairs(session([
      { role: 'user', text: '   ' },
      { role: 'user', text: 'Q' },
    ]))).toBeUndefined();
  });

  it('swallows getSession failures', async () => {
    await expect(extractCompanionQAHistory('c', { getSession: vi.fn(async () => { throw new Error('boom'); }), upsertSession: vi.fn() }, logger)).resolves.toBeUndefined();
  });

  it('soft-deletes empty companion sessions', async () => {
    const upsertSession = vi.fn();
    await cleanupEmptyCompanionSession('c', { getSession: vi.fn(async () => session([{ role: 'user', text: 'Q' }])), upsertSession }, logger);
    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: expect.any(Number), updatedAt: expect.any(Number) }));
  });

  it('does not delete sessions with assistant messages', async () => {
    const upsertSession = vi.fn();
    await cleanupEmptyCompanionSession('c', { getSession: vi.fn(async () => session([{ role: 'assistant', text: 'A' }])), upsertSession }, logger);
    expect(upsertSession).not.toHaveBeenCalled();
  });
});
