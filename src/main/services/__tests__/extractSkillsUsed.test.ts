import { describe, it, expect } from 'vitest';
import { extractSkillsUsed } from '../skillUsageRecorder';
import type { AgentSession } from '@shared/types';

const makeSession = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 'test-session',
  title: 'Test',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: Date.now(),
  ...overrides,
});

describe('extractSkillsUsed', () => {
  it('returns empty array for session with no skill references', () => {
    const session = makeSession({
      messages: [{ id: 'm1', createdAt: 0, role: 'user', text: 'Hello world', turnId: 't1' }],
    });
    expect(extractSkillsUsed(session)).toEqual([]);
  });

  it('extracts skill name from @`path` mention with SKILL.md', () => {
    const session = makeSession({
      messages: [
        { id: 'm1', createdAt: 0, role: 'user', text: '@`skills/communication/meeting-prep/SKILL.md` help me', turnId: 't1' },
      ],
    });
    expect(extractSkillsUsed(session)).toEqual(['meeting-prep']);
  });

  it('extracts skill name from @`path` mention with custom .md filename', () => {
    const session = makeSession({
      messages: [
        { id: 'm1', createdAt: 0, role: 'user', text: '@`skills/writing/email-draft/notes.md` draft this', turnId: 't1' },
      ],
    });
    expect(extractSkillsUsed(session)).toEqual(['notes']);
  });

  it('ignores non-skill @`path` mentions', () => {
    const session = makeSession({
      messages: [
        { id: 'm1', createdAt: 0, role: 'user', text: '@`docs/README.md` read this', turnId: 't1' },
      ],
    });
    expect(extractSkillsUsed(session)).toEqual([]);
  });

  it('ignores assistant messages', () => {
    const session = makeSession({
      messages: [
        { id: 'm2', createdAt: 0, role: 'assistant', text: '@`skills/coding/debug/SKILL.md` I read this', turnId: 't1' },
      ],
    });
    expect(extractSkillsUsed(session)).toEqual([]);
  });

  it('deduplicates skill names across messages', () => {
    const session = makeSession({
      messages: [
        { id: 'm1', createdAt: 0, role: 'user', text: '@`skills/meetings/prep/SKILL.md` first', turnId: 't1' },
        { id: 'm1', createdAt: 0, role: 'user', text: '@`skills/meetings/prep/SKILL.md` again', turnId: 't2' },
      ],
    });
    expect(extractSkillsUsed(session)).toEqual(['prep']);
  });

  it('extracts skills from tool read events via detail JSON', () => {
    const session = makeSession({
      eventsByTurn: {
        t1: [
          {
            type: 'tool',
            toolName: 'Read',
            stage: 'start',
            detail: '{"file_path":"/home/user/skills/research/deep-dive/SKILL.md"}',
          } as any,
        ],
      },
    });
    expect(extractSkillsUsed(session)).toEqual(['deep-dive']);
  });

  it('extracts skills from tool read events via input fallback', () => {
    const session = makeSession({
      eventsByTurn: {
        t1: [
          {
            type: 'tool',
            toolName: 'Read',
            stage: 'start',
            input: { path: '/home/user/skills/research/deep-dive/SKILL.md' },
          } as any,
        ],
      },
    });
    expect(extractSkillsUsed(session)).toEqual(['deep-dive']);
  });

  it('ignores non-read tool events', () => {
    const session = makeSession({
      eventsByTurn: {
        t1: [
          {
            type: 'tool',
            toolName: 'Write',
            stage: 'start',
            detail: '{"file_path":"/home/user/skills/coding/test/SKILL.md"}',
          } as any,
        ],
      },
    });
    expect(extractSkillsUsed(session)).toEqual([]);
  });

  it('ignores end-stage tool events to avoid double counting', () => {
    const session = makeSession({
      eventsByTurn: {
        t1: [
          {
            type: 'tool',
            toolName: 'Read',
            stage: 'end',
            detail: '{"file_path":"/home/user/skills/research/deep-dive/SKILL.md"}',
          } as any,
        ],
      },
    });
    expect(extractSkillsUsed(session)).toEqual([]);
  });

  it('combines skills from both messages and tool events', () => {
    const session = makeSession({
      messages: [
        { id: 'm1', createdAt: 0, role: 'user', text: '@`skills/meetings/standup/SKILL.md` use this', turnId: 't1' },
      ],
      eventsByTurn: {
        t1: [
          {
            type: 'tool',
            toolName: 'Read',
            stage: 'start',
            detail: '{"file_path":"/workspace/skills/writing/blog-post/SKILL.md"}',
          } as any,
        ],
      },
    });
    const result = extractSkillsUsed(session);
    expect(result).toEqual(['standup', 'blog-post']);
  });

  it('handles session with no eventsByTurn', () => {
    const session = makeSession({ eventsByTurn: undefined as any });
    expect(extractSkillsUsed(session)).toEqual([]);
  });

  it('handles case-insensitive skill.md', () => {
    const session = makeSession({
      messages: [
        { id: 'm1', createdAt: 0, role: 'user', text: '@`skills/system/cleanup/skill.md` run', turnId: 't1' },
      ],
    });
    expect(extractSkillsUsed(session)).toEqual(['cleanup']);
  });
});
