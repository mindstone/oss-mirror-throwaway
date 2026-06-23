import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSkeletonMessages } from '../agentLoop';
import {
  SKELETON_FALLBACK_USER_TEXT,
  SkeletonOutputInvariantError,
  stripAgentTurnMessagesForSkeleton,
  stripBlocksForSkeleton,
} from '../skeletonStripping';
import type { ChatMessage, ContentBlock } from '../modelTypes';
import type { AgentTurnMessage } from '@shared/types';

const makeTurnMessage = (
  role: AgentTurnMessage['role'],
  text: string,
  content?: unknown,
): AgentTurnMessage => ({
  id: `${role}-${text || 'blocks'}`,
  turnId: 'turn-skeleton',
  role,
  text,
  createdAt: 1,
  ...(content === undefined ? {} : { content }),
} as AgentTurnMessage);

const messageTexts = (messages: ChatMessage[]): string[] =>
  messages.map((message) => {
    if (typeof message.content === 'string') return message.content;
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n');
  });

describe('skeletonStripping', () => {
  it('keeps ChatMessage and AgentTurnMessage skeleton stripping equivalent for the shared block fixture', () => {
    const userContent = [
      { type: 'text', text: '[COMPACTION_DEPTH:2]\n=== CONTINUE WITH REQUEST ===\nactual ask' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] },
      { type: 'thinking', thinking: 'private' },
      { type: 'image', data: 'inline', mimeType: 'image/png' },
    ] as unknown as ContentBlock[];
    const assistantContent = [
      { type: 'text', text: 'assistant text' },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
      { type: 'redacted_thinking', data: 'hidden' },
    ] as unknown as ContentBlock[];
    const chatMessages: ChatMessage[] = [
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ];
    const agentTurnMessages: AgentTurnMessage[] = [
      makeTurnMessage('user', '', userContent),
      makeTurnMessage('assistant', '', assistantContent),
    ];

    const chatResult = buildSkeletonMessages(chatMessages);
    const agentTurnResult = stripAgentTurnMessagesForSkeleton(agentTurnMessages);

    expect(agentTurnResult.messages.map((message) => message.text)).toEqual(messageTexts(chatResult.messages));
    expect(agentTurnResult).toMatchObject({
      droppedToolResultCount: chatResult.droppedToolResultCount,
      droppedToolUseCount: chatResult.droppedToolUseCount,
      droppedThinkingCount: chatResult.droppedThinkingCount,
      droppedImageCount: chatResult.droppedImageCount,
      userTextPreserved: chatResult.userTextPreserved,
    });
    expect(agentTurnResult.messages.every((message) => !('content' in message))).toBe(true);
  });

  it('inserts the same sentinel user message when no user text survives', () => {
    const result = stripAgentTurnMessagesForSkeleton([
      makeTurnMessage('user', '', [
        { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] },
      ]),
    ]);

    expect(result.userTextPreserved).toBe(false);
    expect(result.messages[0]).toMatchObject({
      role: 'user',
      text: SKELETON_FALLBACK_USER_TEXT,
    });
    expect(result.messages).toHaveLength(1);
  });

  it('throws SkeletonOutputInvariantError with kind=tool-blocks-leaked when buildMessage retains tool blocks', () => {
    type Msg = { role: string; content: unknown };
    const malformedOptions = {
      getRole: (m: Msg) => m.role,
      getContent: (m: Msg) => m.content as string | { type?: unknown }[],
      buildMessage: (m: Msg, _content: unknown): Msg => ({
        role: m.role,
        content: [
          { type: 'text', text: 'leaked' },
          { type: 'tool_result', tool_use_id: 't', content: [] },
        ],
      }),
      buildSentinelMessage: (text: string): Msg => ({ role: 'user', content: text }),
    };

    expect(() => stripBlocksForSkeleton<Msg, { type?: unknown }>(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      malformedOptions,
    )).toThrow(SkeletonOutputInvariantError);

    try {
      stripBlocksForSkeleton<Msg, { type?: unknown }>(
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        malformedOptions,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(SkeletonOutputInvariantError);
      expect((err as SkeletonOutputInvariantError).kind).toBe('tool-blocks-leaked');
    }
  });
});

describe('skeletonStripping diagnostic event emits', () => {
  let appendSpy: ReturnType<typeof vi.fn>;
  let stripBlocksForSkeletonReloaded: typeof stripBlocksForSkeleton;
  let SkeletonOutputInvariantErrorReloaded: typeof SkeletonOutputInvariantError;

  beforeEach(async () => {
    vi.resetModules();
    appendSpy = vi.fn();
     
    vi.doMock('@core/services/diagnosticEventsLedger', () => ({
      appendDiagnosticEvent: appendSpy,
    }));
    const mod = await import('../skeletonStripping');
    stripBlocksForSkeletonReloaded = mod.stripBlocksForSkeleton;
    SkeletonOutputInvariantErrorReloaded = mod.SkeletonOutputInvariantError;
  });

  afterEach(() => {
    vi.doUnmock('@core/services/diagnosticEventsLedger');
  });

  type Msg = { role: string; content: unknown };
  const baseOptions = {
    getRole: (m: Msg) => m.role,
    getContent: (m: Msg) => m.content as string | { type?: unknown }[],
    buildMessage: (m: Msg, content: unknown): Msg => ({ ...m, content }),
    buildSentinelMessage: (text: string): Msg => ({ role: 'user', content: text }),
  };

  // Note: `skeleton_empty_output` and `skeleton_no_user_text` are guarded
  // upstream by the sentinel-message insertion, so they're defensive paths
  // that can only fire if the sentinel itself fails. We exercise the only
  // currently fireable path (tool-blocks-leaked) here; emit-mapping for the
  // other two kinds is statically verified by the schema test.

  it('emits skeleton_tool_blocks_leaked with leaked block count before throwing', () => {
    const malformedOptions = {
      ...baseOptions,
      buildMessage: (m: Msg, _content: unknown): Msg => ({
        role: m.role,
        content: [
          { type: 'text', text: 'leaked' },
          { type: 'tool_result', tool_use_id: 't1', content: [] },
          { type: 'tool_use', id: 't2', name: 'X', input: {} },
        ],
      }),
    };
    expect(() => stripBlocksForSkeletonReloaded<Msg, { type?: unknown }>([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ], malformedOptions)).toThrowError(SkeletonOutputInvariantErrorReloaded);
    const calls = appendSpy.mock.calls.filter(
      ([entry]) => entry?.kind === 'streaming_invariant' && entry?.data?.violation === 'skeleton_tool_blocks_leaked',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0].data.occurrenceCount).toBeGreaterThanOrEqual(2);
    expect(calls[0][0].data.repaired).toBe(false);
  });
});
