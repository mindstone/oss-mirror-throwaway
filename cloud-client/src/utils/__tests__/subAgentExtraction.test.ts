import { describe, expect, it } from 'vitest';
import type { SessionToolEvent } from '../../types';
import { extractSubAgentItems, formatSubAgentName } from '../subAgentExtraction';

const createToolEvent = (overrides: Partial<SessionToolEvent>): SessionToolEvent => ({
  type: 'tool',
  toolName: 'Read',
  detail: '{}',
  stage: 'start',
  timestamp: 1,
  ...overrides,
});

describe('formatSubAgentName', () => {
  it('converts snake_case to Title Case', () => {
    expect(formatSubAgentName('reviewer_gpt5_high')).toBe('Reviewer Gpt5 High');
  });

  it('strips mcp__ prefix', () => {
    expect(formatSubAgentName('mcp__implementer_base')).toBe('Implementer Base');
  });

  it('handles dashes', () => {
    expect(formatSubAgentName('planner-gpt5.5-high')).toBe('Planner Gpt5.5 High');
  });

  it('returns "Sub-agent" for empty input', () => {
    expect(formatSubAgentName('')).toBe('Sub-agent');
  });
});

describe('extractSubAgentItems', () => {
  it('returns empty array when no Task/Agent tools exist', () => {
    const events = [
      createToolEvent({ toolName: 'Read', stage: 'start', timestamp: 1 }),
      createToolEvent({ toolName: 'Write', stage: 'end', timestamp: 2 }),
    ];
    expect(extractSubAgentItems(events)).toEqual([]);
  });

  it('correctly pairs start/end events by toolUseId', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'Task',
        stage: 'start',
        toolUseId: 'tu-1',
        timestamp: 100,
        detail: JSON.stringify({ subagent_type: 'reviewer-gpt5', description: 'Review the code' }),
      }),
      createToolEvent({
        toolName: 'Task',
        stage: 'end',
        toolUseId: 'tu-1',
        timestamp: 500,
        detail: 'Review complete.',
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'tu-1',
      toolUseId: 'tu-1',
      label: 'Reviewer Gpt5',
      subagentType: 'reviewer-gpt5',
      summary: 'Review the code',
      status: 'completed',
      isBackground: false,
      startedAt: 100,
      completedAt: 500,
      durationMs: 400,
      result: 'Review complete.',
    });
  });

  it('extracts label and subagentType from JSON detail', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'Task',
        stage: 'start',
        toolUseId: 'tu-2',
        timestamp: 10,
        detail: JSON.stringify({ subagent_type: 'mcp__implementer_base', description: 'Implement stage' }),
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Implementer Base');
    expect(items[0].subagentType).toBe('mcp__implementer_base');
    expect(items[0].status).toBe('running');
  });

  it('falls back to regex extraction from truncated detail', () => {
    // Simulate a 500-char truncation that breaks JSON parsing
    const longPrompt = 'A'.repeat(600);
    const fullJson = JSON.stringify({
      subagent_type: 'planner-high',
      description: 'Plan the migration',
      prompt: longPrompt,
    });
    const truncatedDetail = fullJson.slice(0, 500);

    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'Task',
        stage: 'start',
        toolUseId: 'tu-3',
        timestamp: 50,
        detail: truncatedDetail,
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Planner High');
    expect(items[0].subagentType).toBe('planner-high');
    expect(items[0].summary).toBe('Plan the migration');
  });

  it('falls back to Agent format when subagent_type is absent', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'Agent',
        stage: 'start',
        toolUseId: 'tu-a1',
        timestamp: 20,
        detail: JSON.stringify({ agent: 'background-researcher', prompt: 'Research the topic deeply' }),
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Background Researcher');
    expect(items[0].subagentType).toBe('background-researcher');
    expect(items[0].summary).toBe('Research the topic deeply');
  });

  it('detects background agents from end event detail', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'Agent',
        stage: 'start',
        toolUseId: 'tu-bg',
        timestamp: 10,
        detail: JSON.stringify({ agent: 'async-worker', prompt: 'Do background work' }),
      }),
      createToolEvent({
        toolName: 'Agent',
        stage: 'end',
        toolUseId: 'tu-bg',
        timestamp: 15,
        detail: 'Async agent launched successfully, agentId: ag-123',
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('running');
    expect(items[0].isBackground).toBe(true);
    expect(items[0].completedAt).toBeUndefined();
    expect(items[0].durationMs).toBeUndefined();
  });

  it('also detects background agents via "working in the background" text', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'Task',
        stage: 'start',
        toolUseId: 'tu-bg2',
        timestamp: 10,
        detail: JSON.stringify({ subagent_type: 'bg-agent' }),
      }),
      createToolEvent({
        toolName: 'Task',
        stage: 'end',
        toolUseId: 'tu-bg2',
        timestamp: 12,
        detail: 'Agent is now working in the background',
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items[0].isBackground).toBe(true);
    expect(items[0].status).toBe('running');
  });

  it('handles missing/empty detail gracefully', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'Task',
        stage: 'start',
        toolUseId: 'tu-empty',
        timestamp: 5,
        detail: '',
      }),
      createToolEvent({
        toolName: 'Task',
        stage: 'end',
        toolUseId: 'tu-empty',
        timestamp: 10,
        detail: '',
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Sub-agent');
    expect(items[0].status).toBe('completed');
    expect(items[0].durationMs).toBe(5);
  });

  it('handles MCP-namespaced tool names (e.g. mcp-server/Task)', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'factory/Task',
        stage: 'start',
        toolUseId: 'tu-ns',
        timestamp: 30,
        detail: JSON.stringify({ subagent_type: 'reviewer-lite' }),
      }),
      createToolEvent({
        toolName: 'factory/Task',
        stage: 'end',
        toolUseId: 'tu-ns',
        timestamp: 60,
        detail: 'Done',
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('completed');
    expect(items[0].label).toBe('Reviewer Lite');
  });

  it('sorts items by startedAt', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({ toolName: 'Task', stage: 'start', toolUseId: 'tu-b', timestamp: 200, detail: '{}' }),
      createToolEvent({ toolName: 'Task', stage: 'start', toolUseId: 'tu-a', timestamp: 100, detail: '{}' }),
    ];

    const items = extractSubAgentItems(events);
    expect(items[0].startedAt).toBe(100);
    expect(items[1].startedAt).toBe(200);
  });

  it('uses prompt truncated to ~96 chars as summary when no description', () => {
    const longPrompt = 'Investigate the performance regression in the authentication module that was reported by the QA team during sprint review and causes slow login times exceeding 5s.';
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'Task',
        stage: 'start',
        toolUseId: 'tu-trunc',
        timestamp: 1,
        detail: JSON.stringify({ subagent_type: 'debugger', prompt: longPrompt }),
      }),
    ];

    const items = extractSubAgentItems(events);
    expect(items[0].summary).toBe(longPrompt.slice(0, 96) + '...');
  });
});
