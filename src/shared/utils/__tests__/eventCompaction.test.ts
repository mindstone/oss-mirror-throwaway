import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { COMPACTION_POLICY_FROM_MANIFEST } from '@shared/contracts/agentEventManifest';
import { deriveTurnLiveness } from '@core/services/conversationState/turnLiveness';
import { compactTurnEvents, compactCompletedTurns } from '../eventCompaction';

const toolStart = (toolName: string, detail = '{"file_path":"/some/long/path/to/file.ts"}'): AgentEvent => ({
  type: 'tool',
  toolName,
  toolUseId: `toolu_${toolName}_1`,
  parentToolUseId: null,
  detail,
  stage: 'start',
  timestamp: Date.now(),
});

const toolEnd = (toolName: string, detail = 'File contents here, could be very long...'): AgentEvent => ({
  type: 'tool',
  toolName,
  toolUseId: `toolu_${toolName}_1`,
  parentToolUseId: null,
  detail,
  stage: 'end',
  timestamp: Date.now(),
});

const toolWithImage = (toolName: string): AgentEvent => ({
  type: 'tool',
  toolName,
  toolUseId: `toolu_${toolName}_img`,
  detail: 'image result',
  stage: 'end',
  timestamp: Date.now(),
  imageContent: [{ type: 'image', data: 'very-large-base64-data', mimeType: 'image/png' }],
});

const toolWithImageRef = (toolName: string): AgentEvent => ({
  type: 'tool',
  toolName,
  toolUseId: `toolu_${toolName}_ref`,
  detail: 'image result',
  stage: 'end',
  timestamp: Date.now(),
  imageContent: [{ type: 'image', data: 'very-large-base64-data', mimeType: 'image/png' }],
  imageRef: [{ assetId: 'turn-1-1-0', mimeType: 'image/png', byteSize: 123 }],
  toolResult: {
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'very-large-base64-data',
        },
      },
    ],
  },
});

const makeImageRef = (assetId: string, byteSize = 123) => ({
  assetId,
  mimeType: 'image/png',
  byteSize,
});

const toolWithMcpMeta = (
  toolName: string,
  structuredFallback: NonNullable<NonNullable<Extract<AgentEvent, { type: 'tool' }>['mcpAppUiMeta']>['structuredFallback']> = {
    kind: 'email-draft',
    payload: {
      to: ['person@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'Draft body.',
    },
  },
  viewSummary = 'Email draft to person@example.com — subject "Hello".',
): AgentEvent => ({
  type: 'tool',
  toolName,
  toolUseId: `toolu_${toolName}_mcp`,
  detail: 'mcp app result',
  stage: 'end',
  timestamp: Date.now(),
  mcpAppUiMeta: {
    resourceUri: 'ui://google-workspace/compose-email',
    presentation: 'primary',
    viewSummary,
    viewRoleLabel: 'Editable email draft',
    structuredFallback,
  },
});

const status = (message = 'Working...'): AgentEvent => ({
  type: 'status',
  message,
  timestamp: Date.now(),
});

const assistant = (text = 'Let me help you with that.'): AgentEvent => ({
  type: 'assistant',
  text,
  timestamp: Date.now(),
});

const result = (text = 'Done!', usage?: any): AgentEvent => ({
  type: 'result',
  text,
  timestamp: Date.now(),
  ...(usage ? { usage } : {}),
});

const error = (msg = 'Something went wrong'): AgentEvent => ({
  type: 'error',
  error: msg,
  timestamp: Date.now(),
});

const userMessage = (text = 'User input'): AgentEvent => ({
  type: 'user_message',
  text,
  timestamp: Date.now(),
});

const userQuestion = (): AgentEvent => ({
  type: 'user_question',
  batchId: 'batch-1',
  toolUseId: 'toolu_ask_1',
  questions: [
    {
      id: 'q1',
      question: 'Which approach?',
      header: 'Approach',
      options: [{ id: 'opt-a', label: 'Option A', description: 'First approach' }],
      multiSelect: false,
    },
  ],
  timestamp: Date.now(),
});

const userQuestionAnswered = (): AgentEvent => ({
  type: 'user_question_answered',
  batchId: 'batch-1',
  answers: [{ questionId: 'q1', selectedOptionIds: ['opt-a'] }],
  timestamp: Date.now(),
});

const contextOverflow = (): AgentEvent => ({
  type: 'context_overflow',
  originalPrompt: 'very long prompt...',
  timestamp: Date.now(),
});

const turnSuperseded = (): AgentEvent => ({
  type: 'turn_superseded',
  newTurnId: 'turn-new',
  timestamp: Date.now(),
});

describe('compactTurnEvents', () => {
  it('keeps result events with all fields', () => {
    const usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.01 };
    const events: AgentEvent[] = [result('Final answer', usage)];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toEqual(events[0]);
  });

  it('keeps error events with all fields', () => {
    const events: AgentEvent[] = [error('API timeout')];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toEqual(events[0]);
  });

  it('keeps user_message events with all fields', () => {
    const events: AgentEvent[] = [userMessage('Proactive check')];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toEqual(events[0]);
  });

  it('keeps user_question events with all fields', () => {
    const event = userQuestion();
    const compacted = compactTurnEvents([event]);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toEqual(event);
  });

  it('keeps user_question_answered events with all fields', () => {
    const event = userQuestionAnswered();
    const compacted = compactTurnEvents([event]);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toEqual(event);
  });

  it('preserves user_question in a realistic turn with mixed events', () => {
    const events: AgentEvent[] = [
      toolStart('AskUserQuestion', '{}'),
      userQuestion(),
      toolEnd('AskUserQuestion', 'waiting for user'),
      userQuestionAnswered(),
      assistant('Based on your answer...'),
      result('All done'),
    ];
    const compacted = compactTurnEvents(events);
    const types = compacted.map(e => e.type);
    expect(types).toEqual(['tool', 'user_question', 'tool', 'user_question_answered', 'assistant', 'result']);
  });

  it('compacts tool events: preserves file path from start, strips bulk end detail', () => {
    const events: AgentEvent[] = [
      toolStart('Read', '{"file_path":"/path/to/large/file.ts"}'),
      toolEnd('Read', 'x'.repeat(10_000)),
    ];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(2);

    const [start, end] = compacted;
    expect(start.type).toBe('tool');
    if (start.type === 'tool') {
      expect(start.toolName).toBe('Read');
      expect(start.detail).toBe('{"file_path":"/path/to/large/file.ts"}');
      expect(start.stage).toBe('start');
      expect(start.toolUseId).toBe('toolu_Read_1');
    }
    if (end.type === 'tool') {
      expect(end.detail).toBe('');
      expect(end.stage).toBe('end');
    }
  });

  it('strips detail for tools whose detail has no file path', () => {
    const events: AgentEvent[] = [
      toolStart('WebSearch', '{"query":"how to test"}'),
      toolEnd('WebSearch', 'Search results...'),
    ];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') expect(compacted[0].detail).toBe('');
    if (compacted[1].type === 'tool') expect(compacted[1].detail).toBe('');
  });

  it('preserves path field from Write tool start detail', () => {
    const events: AgentEvent[] = [
      toolStart('Write', '{"path":"/workspace/notes.md","content":"very long content..."}'),
    ];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].detail).toBe('{"path":"/workspace/notes.md"}');
    }
  });

  it('recovers path from truncated JSON (sanitization artifact)', () => {
    const truncatedDetail = '{"path":"/Users/test/Documents/UX Audits/report.md","content":"# Report\\n\\nLong content... [truncated, 40000 chars omitted]';
    const events: AgentEvent[] = [toolStart('Write', truncatedDetail)];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].detail).toBe('{"path":"/Users/test/Documents/UX Audits/report.md"}');
    }
  });

  it('recovers file_path from truncated JSON', () => {
    const truncatedDetail = '{"file_path":"/workspace/notes.md","content":"Very long file... [truncated, 50000 chars omitted]';
    const events: AgentEvent[] = [toolStart('Read', truncatedDetail)];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].detail).toBe('{"file_path":"/workspace/notes.md"}');
    }
  });

  it('recovers multiple path keys from truncated JSON', () => {
    const truncatedDetail = '{"source":"/old/path.ts","destination":"/new/path.ts","extra":"data... [truncated, 10000 chars omitted]';
    const events: AgentEvent[] = [toolStart('move_file', truncatedDetail)];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].detail).toBe('{"source":"/old/path.ts","destination":"/new/path.ts"}');
    }
  });

  it('returns empty for truncated JSON with no path keys', () => {
    const truncatedDetail = '{"query":"how to test","context":"some very long context... [truncated, 20000 chars omitted]';
    const events: AgentEvent[] = [toolStart('WebSearch', truncatedDetail)];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].detail).toBe('');
    }
  });

  it('preserves paths array from multi-file tools', () => {
    const events: AgentEvent[] = [
      toolStart('read_multiple_files', '{"paths":["/a.ts","/b.ts"]}'),
    ];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].detail).toBe('{"paths":["/a.ts","/b.ts"]}');
    }
  });

  it('preserves both source and destination for move/rename tools', () => {
    const events: AgentEvent[] = [
      toolStart('move_file', '{"source":"/old/path.ts","destination":"/new/path.ts"}'),
    ];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].detail).toBe('{"source":"/old/path.ts","destination":"/new/path.ts"}');
    }
  });

  it('preserves imageContent on tool events', () => {
    const events: AgentEvent[] = [toolWithImage('Screenshot')];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].imageContent).toBeDefined();
      expect(compacted[0].imageContent).toHaveLength(1);
    }
  });

  it('preserves imageRef and strips compacted inline image bytes covered by refs', () => {
    const events: AgentEvent[] = [toolWithImageRef('Screenshot')];
    const compacted = compactTurnEvents(events);

    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].imageRef).toEqual([
        { assetId: 'turn-1-1-0', mimeType: 'image/png', byteSize: 123 },
      ]);
      expect(compacted[0].imageContent).toEqual([
        { type: 'image', data: '', mimeType: 'image/png' },
      ]);
      expect(compacted[0].toolResult?.content?.[0]).toEqual({
        type: 'image',
        imageRef: { assetId: 'turn-1-1-0', mimeType: 'image/png', byteSize: 123 },
      });
    }
  });

  it('preserves middle-image fallback content when compacting positional partial image refs', () => {
    const ref0 = { assetId: 'turn-1-1-0', mimeType: 'image/png', byteSize: 123 };
    const ref2 = { assetId: 'turn-1-1-2', mimeType: 'image/png', byteSize: 456 };
    const ref3 = { assetId: 'turn-1-1-3', mimeType: 'image/png', byteSize: 789 };
    const events: AgentEvent[] = [{
      type: 'tool',
      toolName: 'Screenshot',
      toolUseId: 'toolu_Screenshot_ref',
      detail: 'image result',
      stage: 'end',
      timestamp: Date.now(),
      imageContent: [
        { type: 'image', data: 'covered-0', mimeType: 'image/png' },
        { type: 'image', data: 'fallback-1', mimeType: 'image/png' },
        { type: 'image', data: 'covered-2', mimeType: 'image/png' },
        { type: 'image', data: 'covered-3', mimeType: 'image/png' },
      ],
      imageRef: [ref0, null, ref2, ref3],
      toolResult: {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'covered-0' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fallback-1' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'covered-2' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'covered-3' } },
        ],
      },
    }];

    const compacted = compactTurnEvents(events);

    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].imageRef).toEqual([ref0, null, ref2, ref3]);
      expect(compacted[0].imageContent).toEqual([
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'image', data: 'fallback-1', mimeType: 'image/png' },
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'image', data: '', mimeType: 'image/png' },
      ]);
      expect(compacted[0].toolResult?.content?.[0]).toEqual({ type: 'image', imageRef: ref0 });
      expect(compacted[0].toolResult?.content?.[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'fallback-1' },
      });
      expect(compacted[0].toolResult?.content?.[2]).toEqual({ type: 'image', imageRef: ref2 });
      expect(compacted[0].toolResult?.content?.[3]).toEqual({ type: 'image', imageRef: ref3 });
    }
  });

  it.each([
    {
      label: 'first-null',
      refs: [null, makeImageRef('turn-first-1'), makeImageRef('turn-first-2')],
    },
    {
      label: 'last-null',
      refs: [makeImageRef('turn-last-0'), makeImageRef('turn-last-1'), null],
    },
    {
      label: 'multiple-null',
      refs: [null, makeImageRef('turn-multiple-1'), null, makeImageRef('turn-multiple-3')],
    },
  ])('preserves positional image fallbacks and surviving refs for $label compaction', ({ refs }) => {
    const events: AgentEvent[] = [{
      type: 'tool',
      toolName: 'Screenshot',
      toolUseId: 'toolu_Screenshot_positional_ref',
      detail: 'image result',
      stage: 'end',
      timestamp: Date.now(),
      imageContent: refs.map((_, index) => ({
        type: 'image',
        data: `inline-${index}`,
        mimeType: 'image/png',
      })),
      imageRef: refs,
      toolResult: {
        content: refs.map((_, index) => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: `inline-${index}` },
        })),
      },
    }];

    const compacted = compactTurnEvents(events);

    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].imageRef).toEqual(refs);
      expect(compacted[0].imageContent).toEqual(refs.map((ref, index) => ({
        type: 'image',
        data: ref ? '' : `inline-${index}`,
        mimeType: 'image/png',
      })));
      expect(compacted[0].toolResult?.content).toEqual(refs.map((ref, index) => (
        ref
          ? { type: 'image', imageRef: ref }
          : {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: `inline-${index}` },
            }
      )));
    }
  });

  it('preserves mcpAppUiMeta on tool events', () => {
    const events: AgentEvent[] = [toolWithMcpMeta('HubSpot')];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].mcpAppUiMeta).toBeDefined();
    }
  });

  it('preserves A3a mcpAppUiMeta fields through compaction', () => {
    const event = toolWithMcpMeta('compose_workspace_email');
    const compacted = compactTurnEvents([event]);

    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'tool' && event.type === 'tool') {
      expect(compacted[0].mcpAppUiMeta).toEqual(event.mcpAppUiMeta);
      expect(compacted[0].mcpAppUiMeta?.presentation).toBe('primary');
      expect(compacted[0].mcpAppUiMeta?.viewSummary).toBe('Email draft to person@example.com — subject "Hello".');
      expect(compacted[0].mcpAppUiMeta?.viewRoleLabel).toBe('Editable email draft');
      expect(compacted[0].mcpAppUiMeta?.structuredFallback).toEqual({
        kind: 'email-draft',
        payload: {
          to: ['person@example.com'],
          cc: [],
          bcc: [],
          subject: 'Hello',
          body: 'Draft body.',
        },
      });
    }
  });

  it('preserves viewSummary at the exact 280-character boundary through compaction', () => {
    const summary = 'x'.repeat(280);
    const compacted = compactTurnEvents([toolWithMcpMeta('compose_workspace_email', undefined, summary)]);

    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].mcpAppUiMeta?.viewSummary).toHaveLength(280);
      expect(compacted[0].mcpAppUiMeta?.viewSummary).toBe(summary);
    }
  });

  it.each([
    [
      'calendar-pick',
      {
        kind: 'calendar-pick' as const,
        payload: {
          title: 'Choose a time',
          options: [{ id: 'slot-1', label: 'Tuesday 10:00', start: '2026-05-12T10:00:00Z' }],
        },
      },
    ],
    [
      'document-outline',
      {
        kind: 'document-outline' as const,
        payload: {
          title: 'Launch memo',
          sections: [{ heading: 'Summary', bullets: ['Audience', 'Timing'] }],
        },
      },
    ],
    [
      'plain',
      {
        kind: 'plain' as const,
        payload: { markdown: 'Plain fallback content.' },
      },
    ],
  ])('preserves %s structured fallback through compaction', (_kind, structuredFallback) => {
    const event = toolWithMcpMeta('compose_workspace_email', structuredFallback);
    const compacted = compactTurnEvents([event]);

    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'tool' && event.type === 'tool') {
      expect(compacted[0].mcpAppUiMeta?.structuredFallback).toEqual(event.mcpAppUiMeta?.structuredFallback);
    }
  });

  it('preserves parentToolUseId on tool events', () => {
    const event: AgentEvent = {
      type: 'tool',
      toolName: 'SubTask',
      toolUseId: 'toolu_sub_1',
      parentToolUseId: 'toolu_parent_1',
      detail: 'task output',
      stage: 'end',
      timestamp: Date.now(),
    };
    const compacted = compactTurnEvents([event]);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].parentToolUseId).toBe('toolu_parent_1');
    }
  });

  it('compacts assistant events: sets text to empty string, keeps timestamp', () => {
    const ts = Date.now();
    const events: AgentEvent[] = [{ type: 'assistant', text: 'Long analysis...', timestamp: ts }];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(1);
    if (compacted[0].type === 'assistant') {
      expect(compacted[0].text).toBe('');
      expect(compacted[0].timestamp).toBe(ts);
    }
  });

  it('drops status events entirely', () => {
    const events: AgentEvent[] = [status('Starting...'), status('Processing...')];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(0);
  });

  it('drops context_overflow events', () => {
    const events: AgentEvent[] = [contextOverflow()];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(0);
  });

  it('drops turn_superseded events', () => {
    const events: AgentEvent[] = [turnSuperseded()];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(0);
  });

  it('drops turn_started events', () => {
    const events: AgentEvent[] = [{ type: 'turn_started', timestamp: Date.now() }];
    const compacted = compactTurnEvents(events);
    expect(compacted).toHaveLength(0);
  });

  it('handles empty events array', () => {
    expect(compactTurnEvents([])).toEqual([]);
  });

  it('compacts a realistic turn with mixed events', () => {
    const events: AgentEvent[] = [
      status('Starting agent turn...'),
      assistant('Let me search for that.'),
      toolStart('WebSearch', '{"query":"how to test"}'),
      toolEnd('WebSearch', 'Search results: ' + 'x'.repeat(5000)),
      assistant('I found some results. Let me analyze them.'),
      toolStart('Read'),
      toolEnd('Read', 'File contents: ' + 'x'.repeat(8000)),
      status('Compiling results...'),
      assistant('Here is my analysis.'),
      result('Final answer with detailed analysis.', { inputTokens: 500, outputTokens: 200 }),
    ];

    const compacted = compactTurnEvents(events);

    // status events dropped (2), rest kept
    expect(compacted).toHaveLength(8);

    // Verify types preserved in order
    const types = compacted.map(e => e.type);
    expect(types).toEqual(['assistant', 'tool', 'tool', 'assistant', 'tool', 'tool', 'assistant', 'result']);

    const toolEvents = compacted.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool');
    // WebSearch start has no file path → ''
    expect(toolEvents[0].detail).toBe('');
    // WebSearch end → ''
    expect(toolEvents[1].detail).toBe('');
    // Read start has file_path → preserved
    expect(toolEvents[2].detail).toBe('{"file_path":"/some/long/path/to/file.ts"}');
    // Read end → ''
    expect(toolEvents[3].detail).toBe('');

    // Verify assistant text stripped
    compacted.filter(e => e.type === 'assistant').forEach(e => {
      if (e.type === 'assistant') expect(e.text).toBe('');
    });

    // Verify result kept in full
    const resultEvent = compacted.find(e => e.type === 'result');
    if (resultEvent?.type === 'result') {
      expect(resultEvent.text).toBe('Final answer with detailed analysis.');
      expect(resultEvent.usage).toEqual({ inputTokens: 500, outputTokens: 200 });
    }
  });
});

describe('compactCompletedTurns', () => {
  it('compacts completed turns (last event is result)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [toolStart('Read'), toolEnd('Read', 'long output'), result('Done')],
      'turn-2': [toolStart('Write'), toolEnd('Write', 'written')],
    };

    const compacted = compactCompletedTurns(eventsByTurn);

    // turn-1 is completed (last=result) — compacted; start preserves file path
    expect(compacted['turn-1']).toHaveLength(3);
    const startEvent = compacted['turn-1'][0];
    if (startEvent.type === 'tool') expect(startEvent.detail).toBe('{"file_path":"/some/long/path/to/file.ts"}');
    const endEvent = compacted['turn-1'][1];
    if (endEvent.type === 'tool') expect(endEvent.detail).toBe('');

    // turn-2 is NOT completed (last=tool) — unchanged
    expect(compacted['turn-2']).toBe(eventsByTurn['turn-2']);
  });

  it('compacts completed turns (last event is error)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [toolStart('Read'), error('timeout')],
    };

    const compacted = compactCompletedTurns(eventsByTurn);
    expect(compacted['turn-1']).toHaveLength(2);
    const toolEvent = compacted['turn-1'][0];
    if (toolEvent.type === 'tool') expect(toolEvent.detail).toBe('{"file_path":"/some/long/path/to/file.ts"}');
  });

  it('skips the excludeTurnId', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [result('Done 1')],
      'turn-2': [result('Done 2')],
    };

    const compacted = compactCompletedTurns(eventsByTurn, 'turn-2');

    // turn-1 compacted
    expect(compacted['turn-1']).not.toBe(eventsByTurn['turn-1']);
    // turn-2 skipped — same reference
    expect(compacted['turn-2']).toBe(eventsByTurn['turn-2']);
  });

  it('returns same reference when nothing to compact', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [toolStart('Read')],
    };

    const compacted = compactCompletedTurns(eventsByTurn);
    expect(compacted).toBe(eventsByTurn);
  });

  it('returns same reference when all completed turns are excluded', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [result('Done')],
    };

    const compacted = compactCompletedTurns(eventsByTurn, 'turn-1');
    expect(compacted).toBe(eventsByTurn);
  });

  it('handles empty eventsByTurn', () => {
    expect(compactCompletedTurns({})).toEqual({});
  });

  it('handles empty events array for a turn', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [],
    };
    const compacted = compactCompletedTurns(eventsByTurn);
    expect(compacted).toBe(eventsByTurn);
  });

  it('preserves user_question and user_question_answered in completed turns', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        toolStart('AskUserQuestion', '{}'),
        userQuestion(),
        toolEnd('AskUserQuestion', 'waiting'),
        userQuestionAnswered(),
        assistant('Based on your answer...'),
        result('Done'),
      ],
    };
    const compacted = compactCompletedTurns(eventsByTurn);
    const types = compacted['turn-1'].map(e => e.type);
    expect(types).toContain('user_question');
    expect(types).toContain('user_question_answered');
    expect(types).toEqual(['tool', 'user_question', 'tool', 'user_question_answered', 'assistant', 'result']);
  });

  it('handles multiple completed turns', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [status('Working'), toolStart('Read'), toolEnd('Read', 'output'), result('Done 1')],
      'turn-2': [assistant('Planning...'), toolStart('Write'), toolEnd('Write', 'written'), result('Done 2')],
      'turn-3': [toolStart('Search')], // active — not completed
    };

    const compacted = compactCompletedTurns(eventsByTurn);

    // turn-1: status dropped, tool compacted, result kept
    expect(compacted['turn-1']).toHaveLength(3); // tool start, tool end, result (status dropped)
    // turn-2: assistant compacted, tool compacted, result kept
    expect(compacted['turn-2']).toHaveLength(4); // assistant, tool start, tool end, result
    // turn-3: unchanged
    expect(compacted['turn-3']).toBe(eventsByTurn['turn-3']);
  });
});

describe('invariant #14: compaction liveness contract', () => {
  it('never drops terminal types and preserves active+terminal liveness after compaction', () => {
    expect(COMPACTION_POLICY_FROM_MANIFEST.result).not.toBe('drop');
    expect(COMPACTION_POLICY_FROM_MANIFEST.error).not.toBe('drop');

    const activeTurnId = 'turn-active';
    const completedTurnId = 'turn-completed';
    const now = 10_000;
    const eventsByTurn: Record<string, AgentEvent[]> = {
      [activeTurnId]: [
        {
          type: 'tool',
          toolName: 'Read',
          toolUseId: 'tool-active-1',
          parentToolUseId: null,
          detail: '{"file_path":"/tmp/active.md"}',
          stage: 'start',
          timestamp: 9_000,
        },
      ],
      [completedTurnId]: [
        {
          type: 'assistant',
          text: 'Detailed response that can be compacted.',
          timestamp: 8_000,
        },
        {
          type: 'result',
          text: 'Done',
          timestamp: 8_100,
        },
      ],
    };

    const beforeCompaction = deriveTurnLiveness(eventsByTurn, now, {
      declaredActiveTurnId: activeTurnId,
    });
    expect(beforeCompaction.status).toBe('running');
    expect(beforeCompaction.activeTurnId).toBe(activeTurnId);

    const compacted = compactCompletedTurns(eventsByTurn, activeTurnId);
    expect(compacted[activeTurnId]).toBe(eventsByTurn[activeTurnId]);
    expect(compacted[completedTurnId]).not.toBe(eventsByTurn[completedTurnId]);

    const completedTerminalEvents = compacted[completedTurnId].filter(
      (event) => event.type === 'result' || event.type === 'error',
    );
    expect(completedTerminalEvents).toHaveLength(1);
    expect(completedTerminalEvents[0]?.type).toBe('result');

    const afterCompaction = deriveTurnLiveness(compacted, now, {
      declaredActiveTurnId: activeTurnId,
    });
    expect(afterCompaction.status).toBe('running');
    expect(afterCompaction.activeTurnId).toBe(activeTurnId);

    const completedOnlyLiveness = deriveTurnLiveness(
      { [completedTurnId]: compacted[completedTurnId] },
      now,
      { declaredActiveTurnId: completedTurnId },
    );
    expect(completedOnlyLiveness.status).toBe('terminal');
    expect(completedOnlyLiveness.activeTurnId).toBeNull();
  });
});

describe('subagent identity preservation', () => {
  it('preserves subagent_type for Task tool start events', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: 'Task',
        detail: JSON.stringify({ subagent_type: 'researcher', description: 'Investigate', prompt: 'Do research' }),
        stage: 'start',
        timestamp: 1000,
      },
      { type: 'result', text: 'done', timestamp: 2000 },
    ];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      const parsed = JSON.parse(compacted[0].detail);
      expect(parsed.subagent_type).toBe('researcher');
      expect(parsed.description).toBe('Investigate');
    }
  });

  it('preserves agent field for Agent tool start events', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: 'Agent',
        detail: JSON.stringify({ agent: 'knowledge-worker', prompt: 'Get emails' }),
        stage: 'start',
        timestamp: 1000,
      },
      { type: 'result', text: 'done', timestamp: 2000 },
    ];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      const parsed = JSON.parse(compacted[0].detail);
      expect(parsed.agent).toBe('knowledge-worker');
    }
  });

  it('does not preserve subagent identity for Agent tool end events', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: 'Agent',
        detail: 'Here are the results of the research...',
        stage: 'end',
        timestamp: 2000,
      },
      { type: 'result', text: 'done', timestamp: 3000 },
    ];
    const compacted = compactTurnEvents(events);
    if (compacted[0].type === 'tool') {
      expect(compacted[0].detail).toBe('');
    }
  });
});

/**
 * R2 Stage 3a-L1 cutover parity gate (2026-05-01).
 *
 * Pre-cutover, `eventCompaction.ts` declared a hand-authored
 * `COMPACTION_POLICY` const (30 keys, `'keep'|'compact'|'drop'`). The cutover
 * replaced it with `COMPACTION_POLICY_FROM_MANIFEST`. This block snapshots
 * the pre-cutover values verbatim and asserts the manifest-derived export
 * still produces identical key set and identical values for every variant.
 *
 * This is the explicit Stage C parity gate for L1: a non-vacuous,
 * direct-input/output parity check on the projection consumed by
 * `compactTurnEvents`. (The turn-pipeline replay corpus is a different
 * gate — it covers orchestrator dispatch, not renderer-side compaction.)
 */
describe('R2 Stage 3a-L1 cutover parity gate', () => {
  // Frozen pre-cutover values copied verbatim from the deleted hand-authored
  // const at src/shared/utils/eventCompaction.ts (Stage 2 baseline). Do not
  // re-derive these from the manifest — that would defeat the parity check.
  const PRE_CUTOVER_HAND_AUTHORED = {
    result: 'keep',
    error: 'keep',
    user_message: 'keep',
    user_question: 'keep',
    user_question_answered: 'keep',
    tool: 'compact',
    assistant: 'compact',
    status: 'drop',
    warning: 'drop',
    assistant_delta: 'drop',
    thinking_delta: 'drop',
    context_overflow: 'drop',
    turn_superseded: 'drop',
    compaction_started: 'drop',
    compaction_summary_ready: 'drop',
    compaction_retrying: 'drop',
    compaction_completed: 'drop',
    compaction_failed: 'drop',
    'recovery:started': 'keep',
    'recovery:fallback_attempting': 'drop',
    'recovery:fallback_succeeded': 'drop',
    'recovery:compacting': 'drop',
    'recovery:summary_ready': 'drop',
    'recovery:retrying': 'drop',
    'recovery:skeleton_attempting': 'drop',
    'recovery:depth4_attempting': 'drop',
    'recovery:succeeded': 'keep',
    'recovery:failed': 'keep',
    'recovery:last_resort_skipped': 'keep',
    turn_started: 'drop',
    answer_phase_started: 'drop',
  } as const satisfies Record<AgentEvent['type'], 'keep' | 'compact' | 'drop'>;

  it('manifest projection has identical key set to pre-cutover hand-authored values', () => {
    const handKeys = Object.keys(PRE_CUTOVER_HAND_AUTHORED).sort();
    const manKeys = Object.keys(COMPACTION_POLICY_FROM_MANIFEST).sort();
    expect(manKeys).toEqual(handKeys);
  });

  it.each(Object.entries(PRE_CUTOVER_HAND_AUTHORED))(
    'manifest projection equals pre-cutover hand-authored value for %s',
    (key, expectedValue) => {
      const manifestValue =
        COMPACTION_POLICY_FROM_MANIFEST[
          key as keyof typeof COMPACTION_POLICY_FROM_MANIFEST
        ];
      expect(manifestValue).toBe(expectedValue);
    },
  );
});

describe('compactTurnEvents preserves seq on compacted events', () => {
  it('keeps seq on a compacted assistant event', () => {
    const original: AgentEvent = {
      type: 'assistant',
      text: 'large text to strip',
      timestamp: 1_000,
      seq: 42,
    };
    const [compacted] = compactTurnEvents([original]);
    expect(compacted.type).toBe('assistant');
    expect(compacted.seq).toBe(42);
  });

  it('keeps seq on a compacted tool event', () => {
    const original: AgentEvent = {
      type: 'tool',
      toolName: 'Read',
      toolUseId: 'tool-1',
      detail: 'big payload',
      stage: 'end',
      timestamp: 2_000,
      seq: 99,
    };
    const [compacted] = compactTurnEvents([original]);
    expect(compacted.type).toBe('tool');
    expect(compacted.seq).toBe(99);
  });

  it('does not introduce a seq when the input had none', () => {
    const original: AgentEvent = {
      type: 'assistant',
      text: 'no seq',
      timestamp: 3_000,
    };
    const [compacted] = compactTurnEvents([original]);
    expect(compacted.seq).toBeUndefined();
  });
});
