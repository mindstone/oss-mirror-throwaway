import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent, AgentTurnMessage, TurnEndReason } from '@shared/types';
import {
  updateConversationWithEvent,
  mergeResultMessage,
  mergeErrorMessage,
  type ConversationStateShape
} from '../conversationState';

const makeTurnId = () => 'turn-test-1';

const makeBaseState = (overrides?: Partial<ConversationStateShape>): ConversationStateShape => ({
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  focusedTurnId: null,
  isBusy: false,
  lastError: null,
  lastErrorSource: null,
  terminatedTurnIds: new Set(),
  ...overrides
});

const makeUserMessage = (turnId: string, text = 'Hello'): AgentTurnMessage => ({
  id: 'msg-user-1',
  turnId,
  role: 'user',
  text,
  createdAt: Date.now()
});

const makeAssistantMessage = (turnId: string, text: string): AgentTurnMessage => ({
  id: 'msg-assistant-1',
  turnId,
  role: 'assistant',
  text,
  createdAt: Date.now()
});

describe('updateConversationWithEvent', () => {
  it('creates assistant message on assistant event', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      activeTurnId: turnId,
      isBusy: true
    });

    const event: AgentEvent = { type: 'assistant', text: 'I will help you.', timestamp: Date.now() };
    const next = updateConversationWithEvent(state, turnId, event);

    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].role).toBe('assistant');
    expect(next.messages[1].text).toBe('I will help you.');
    expect(next.isBusy).toBe(true);
  });

  it('removes thinking-style assistant text on tool start', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [
        makeUserMessage(turnId),
        makeAssistantMessage(turnId, "I'll check that for you.")
      ],
      eventsByTurn: {
        [turnId]: [{ type: 'assistant', text: "I'll check that for you.", timestamp: Date.now() }]
      },
      activeTurnId: turnId,
      isBusy: true
    });

    const toolStartEvent: AgentEvent = {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    };
    const next = updateConversationWithEvent(state, turnId, toolStartEvent);

    // Thinking-style text (<300 chars, no structure) should be removed from messages
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].role).toBe('user');

    // But eventsByTurn still has the assistant event
    expect(next.eventsByTurn[turnId]).toHaveLength(2);
    expect(next.eventsByTurn[turnId][0].type).toBe('assistant');
    expect(next.eventsByTurn[turnId][1].type).toBe('tool');
  });

  it('preserves substantive assistant text on tool start', () => {
    const turnId = makeTurnId();
    // Substantive text: has markdown header, should NOT be removed
    const substantiveText = '## Analysis\n\nHere is a detailed breakdown of the data.';
    const state = makeBaseState({
      messages: [
        makeUserMessage(turnId),
        makeAssistantMessage(turnId, substantiveText)
      ],
      eventsByTurn: {
        [turnId]: [{ type: 'assistant', text: substantiveText, timestamp: Date.now() }]
      },
      activeTurnId: turnId,
      isBusy: true
    });

    const toolStartEvent: AgentEvent = {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    };
    const next = updateConversationWithEvent(state, turnId, toolStartEvent);

    // Substantive text should be preserved
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].role).toBe('assistant');
    expect(next.messages[1].text).toBe(substantiveText);
  });

  it('removes long narrated assistant text on tool start', () => {
    const turnId = makeTurnId();
    const narratedText = [
      'That error is from a PostHog query that failed in a previous turn.',
      'Let me check what I was doing and pick up from where things broke.',
      'Now I have full context and can proceed through the remaining steps.',
      'Excellent data from the subagents, so let me synthesise that while the background work keeps running.',
    ].join(' ');
    const state = makeBaseState({
      messages: [
        makeUserMessage(turnId),
        makeAssistantMessage(turnId, narratedText)
      ],
      eventsByTurn: {
        [turnId]: [{ type: 'assistant', text: narratedText, timestamp: Date.now() }]
      },
      activeTurnId: turnId,
      isBusy: true
    });

    const toolStartEvent: AgentEvent = {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    };
    const next = updateConversationWithEvent(state, turnId, toolStartEvent);

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].role).toBe('user');
  });

  it('preserves thinking-style assistant text on tool start when skipThinkingPrune is true', () => {
    const turnId = makeTurnId();
    const thinkingText = "I'll check that for you.";
    const state = makeBaseState({
      messages: [
        makeUserMessage(turnId),
        makeAssistantMessage(turnId, thinkingText)
      ],
      eventsByTurn: {
        [turnId]: [{ type: 'assistant', text: thinkingText, timestamp: Date.now() }]
      },
      activeTurnId: turnId,
      isBusy: true
    });

    const toolStartEvent: AgentEvent = {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    };
    const next = updateConversationWithEvent(state, turnId, toolStartEvent, { skipThinkingPrune: true });

    // Thinking-style text should be preserved when skipThinkingPrune is true
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].role).toBe('assistant');
    expect(next.messages[1].text).toBe(thinkingText);
  });

  it('strips thinking-style assistant text on tool start when skipThinkingPrune is false', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [
        makeUserMessage(turnId),
        makeAssistantMessage(turnId, "Let me look into that.")
      ],
      eventsByTurn: {
        [turnId]: [{ type: 'assistant', text: "Let me look into that.", timestamp: Date.now() }]
      },
      activeTurnId: turnId,
      isBusy: true
    });

    const toolStartEvent: AgentEvent = {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    };
    const next = updateConversationWithEvent(state, turnId, toolStartEvent, { skipThinkingPrune: false });

    // Thinking-style text should still be removed with explicit false
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].role).toBe('user');
  });

  it('preserves all assistant messages in full replay sequence with skipThinkingPrune', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      activeTurnId: turnId,
      isBusy: true
    });
    const opts = { skipThinkingPrune: true };

    // Replay event 1: substantive assistant message (has bullet structure)
    const firstText = 'Found relevant results:\n\n- Document A matches your query';
    state = updateConversationWithEvent(state, turnId, {
      type: 'assistant',
      text: firstText,
      timestamp: Date.now()
    }, opts);
    expect(state.messages).toHaveLength(2);

    // Replay event 2: tool start — would normally prune the assistant message
    state = updateConversationWithEvent(state, turnId, {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    }, opts);
    // Assistant message should survive
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe('assistant');

    // Replay event 3: tool end
    state = updateConversationWithEvent(state, turnId, {
      type: 'tool',
      toolName: 'search',
      detail: 'Done',
      stage: 'end',
      timestamp: Date.now()
    }, opts);

    // Replay event 4: second substantive assistant message (aggregated)
    const secondText = 'Additional findings:\n\n- Document B also relevant';
    state = updateConversationWithEvent(state, turnId, {
      type: 'assistant',
      text: secondText,
      timestamp: Date.now()
    }, opts);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].text).toContain(firstText);
    expect(state.messages[1].text).toContain(secondText);

    // Replay event 5: second tool start — would normally prune again
    state = updateConversationWithEvent(state, turnId, {
      type: 'tool',
      toolName: 'analyze',
      detail: 'Analyzing...',
      stage: 'start',
      timestamp: Date.now()
    }, opts);
    // Aggregated assistant message still present
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe('assistant');

    // Replay event 6: result with empty text — promotes existing assistant to result
    state = updateConversationWithEvent(state, turnId, {
      type: 'result',
      text: '',
      timestamp: Date.now()
    }, opts);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe('result');
    expect(state.messages[1].text).toContain(firstText);
    expect(state.messages[1].text).toContain(secondText);
  });
});

describe('mergeResultMessage', () => {
  const turnEndReasons: TurnEndReason[] = [
    'completed',
    'user_stopped',
    'superseded',
    'awaiting_user',
    'error'
  ];
  type EmptyNoAnchorPolicy = 'drop' | 'placeholder-quip' | 'placeholder-anchor';
  const expectedEmptyNoAnchorPolicy = ({
    turnEndReason,
    hasActivity,
    isSynthetic,
    hasUserQuestion
  }: {
    turnEndReason: TurnEndReason;
    hasActivity: boolean;
    isSynthetic: boolean;
    hasUserQuestion: boolean;
  }): EmptyNoAnchorPolicy => {
    if (hasUserQuestion) return 'placeholder-quip';
    switch (turnEndReason) {
      case 'awaiting_user':
        return 'placeholder-quip';
      case 'superseded':
        return isSynthetic && hasActivity ? 'placeholder-anchor' : 'drop';
      case 'completed':
      case 'user_stopped':
      case 'error':
        return 'drop';
    }
  };
  const matrixCases = turnEndReasons.flatMap(turnEndReason =>
    [false, true].flatMap(hasActivity =>
      [false, true].flatMap(isSynthetic =>
        [false, true].map(hasUserQuestion => ({
          turnEndReason,
          hasActivity,
          isSynthetic,
          hasUserQuestion,
          expected: expectedEmptyNoAnchorPolicy({
            turnEndReason,
            hasActivity,
            isSynthetic,
            hasUserQuestion
          })
        }))
      )
    )
  );

  it.each(matrixCases)(
    'classifies empty no-anchor result as $expected for reason=$turnEndReason activity=$hasActivity synthetic=$isSynthetic user_question=$hasUserQuestion',
    ({ turnEndReason, hasActivity, isSynthetic, hasUserQuestion, expected }) => {
      const turnId = `turn-empty-no-anchor-${turnEndReason}-${hasActivity}-${isSynthetic}-${hasUserQuestion}`;
      const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
      const resultEvent = {
        type: 'result' as const,
        text: '',
        turnEndReason,
        timestamp: Date.now(),
        ...(isSynthetic ? { isSynthetic: true as const } : {})
      };
      const turnEvents: AgentEvent[] = [
        ...(hasActivity
          ? [{ type: 'status' as const, message: 'Checking context', timestamp: Date.now() }]
          : []),
        ...(hasUserQuestion
          ? [{
            type: 'user_question' as const,
            batchId: 'b1',
            toolUseId: 't1',
            questions: [],
            timestamp: Date.now()
          }]
          : [])
      ];

      const result = mergeResultMessage(messages, turnId, resultEvent, turnEvents);

      if (expected === 'drop') {
        expect(result).toBe(messages);
        expect(result).toHaveLength(1);
        return;
      }

      expect(result).toHaveLength(2);
      expect(result[1].role).toBe('result');
      expect(result[1].turnId).toBe(turnId);

      if (expected === 'placeholder-anchor') {
        expect(result[1].text).toBe('Interrupted before I could finish.');
        expect(result[1].endedWith).toBe('superseded');
        return;
      }

      expect(result[1].text.length).toBeGreaterThan(0);
      expect(result[1].text).not.toBe('Interrupted before I could finish.');
      expect(result[1].endedWith).toBeUndefined();
    }
  );

  it('returns messages unchanged when result text is empty and no existing assistant (no activity)', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toEqual(messages);
    expect(result).toHaveLength(1);
  });

  it('mergeResultMessage creates placeholder for superseded turn with tool activity and no assistant message', () => {
    const turnId = 'turn-superseded-tool-only';
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent: Extract<AgentEvent, { type: 'result' }> & { isSynthetic: true } = {
      type: 'result',
      text: '',
      turnEndReason: 'superseded',
      isSynthetic: true,
      timestamp: Date.now()
    };
    const turnEvents: AgentEvent[] = [
      { type: 'tool', toolName: 'Read', detail: '{"path":"notes.md"}', stage: 'end', timestamp: Date.now() }
    ];

    const result = mergeResultMessage(messages, turnId, resultEvent, turnEvents);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text).toBe('Interrupted before I could finish.');
    expect(result[1].endedWith).toBe('superseded');
  });

  it('mergeResultMessage does NOT create placeholder for empty result without superseded reason (existing behaviour preserved)', () => {
    const turnId = 'turn-empty-completed';
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent: Extract<AgentEvent, { type: 'result' }> = {
      type: 'result',
      text: '',
      turnEndReason: 'completed',
      timestamp: Date.now()
    };
    const turnEvents: AgentEvent[] = [
      { type: 'tool', toolName: 'Read', detail: '{"path":"notes.md"}', stage: 'end', timestamp: Date.now() }
    ];

    const result = mergeResultMessage(messages, turnId, resultEvent, turnEvents);
    expect(result).toEqual(messages);
    expect(result).toHaveLength(1);
  });

  it('mergeResultMessage preserves question-pause quip path (no regression)', () => {
    const turnId = 'turn-question-pause-no-regression';
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent: Extract<AgentEvent, { type: 'result' }> = {
      type: 'result',
      text: '',
      turnEndReason: 'awaiting_user',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text.length).toBeGreaterThan(0);
    expect(result[1].text).not.toBe('Interrupted before I could finish.');
  });

  it('mergeResultMessage handles superseded turn that already has an assistant message via existing path', () => {
    const turnId = 'turn-superseded-with-assistant';
    const assistantText = 'Summary:\n\n- Collected context\n- Prepared draft';
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, assistantText)
    ];
    const resultEvent: Extract<AgentEvent, { type: 'result' }> & { isSynthetic: true } = {
      type: 'result',
      text: '',
      turnEndReason: 'superseded',
      isSynthetic: true,
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent, [
      { type: 'tool', toolName: 'Read', detail: '{"path":"notes.md"}', stage: 'end', timestamp: Date.now() }
    ]);

    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text).toBe(assistantText);
    expect(result[1].endedWith).toBeUndefined();
  });

  it('creates quip result message for question-pause turns (turnEndReason)', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      turnEndReason: 'awaiting_user' as const,
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text.length).toBeGreaterThan(0);
    expect(result[1].turnId).toBe(turnId);
  });

  it('creates quip result message for question-pause turns (user_question event)', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now()
    };
    const turnEvents: AgentEvent[] = [
      { type: 'tool', toolName: 'Read', toolUseId: 't1', parentToolUseId: null, detail: '{}', stage: 'end', timestamp: Date.now() },
      { type: 'user_question', batchId: 'b1', toolUseId: 't2', questions: [], timestamp: Date.now() },
    ];

    const result = mergeResultMessage(messages, turnId, resultEvent, turnEvents);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text.length).toBeGreaterThan(0);
  });

  it('produces stable quip for the same turnId', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      turnEndReason: 'awaiting_user' as const,
      timestamp: Date.now()
    };

    const result1 = mergeResultMessage(messages, turnId, resultEvent);
    const result2 = mergeResultMessage(messages, turnId, resultEvent);
    expect(result1[1].text).toBe(result2[1].text);
  });

  it('promotes existing assistant to result role when result text is empty', () => {
    const turnId = makeTurnId();
    // Use structured text (has bullet list) so it's not classified as narration
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, 'Here is the answer:\n\n- The key finding is X')
    ];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text).toBe('Here is the answer:\n\n- The key finding is X');
    // Keep same ID (no React remounting)
    expect(result[1].id).toBe('msg-assistant-1');
  });

  it('creates new result message when result has text and no existing assistant', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent = {
      type: 'result' as const,
      text: 'Final answer.',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text).toBe('Final answer.');
  });
});

describe('mergeResultMessage leaked planning JSON safety net', () => {
  it('suppresses leaked planning JSON from result text', () => {
    const turnId = makeTurnId();
    // Use structured text (has bullet list) so narration guard doesn't fire first
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, 'Working on the draft:\n\n- Gathering contacts')
    ];
    const planJson = JSON.stringify({
      goal: 'Draft and send an email',
      assumptions: ['User wants email sent'],
      steps: [{ id: '1', description: 'Search contacts' }],
    });
    const resultEvent = {
      type: 'result' as const,
      text: '```json\n' + planJson + '\n```',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result[1].role).toBe('result');
    // Should use existing assistant text, not the leaked plan
    expect(result[1].text).toBe('Working on the draft:\n\n- Gathering contacts');
    expect(result[1].text).not.toContain('"goal"');
  });

  it('allows normal JSON in result text', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent = {
      type: 'result' as const,
      text: '{"name": "test", "value": 42}',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].text).toBe('{"name": "test", "value": 42}');
  });

  it('allows normal markdown in result text', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const resultEvent = {
      type: 'result' as const,
      text: "I've sent the email to Sasha. Here's what I wrote:\n\n> Hey Sasha, could you forward this?",
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].text).toContain("I've sent the email");
  });
});

describe('mergeResultMessage narration filtering', () => {
  it('filters narration text when result is empty', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, "I'll check that for you.")
    ];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    // Narration should be removed — turn produced no user-visible output
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('preserves short response with structure when result is empty', () => {
    const turnId = makeTurnId();
    const structuredResponse = "Done!\n\n- Email sent to Sasha\n- CC'd the team";
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, structuredResponse)
    ];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text).toBe(structuredResponse);
  });

  it('preserves assistant text with markdown headers when result is empty', () => {
    const turnId = makeTurnId();
    const markdownResponse = '## Summary\n\nHere are the key findings from the analysis.';
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, markdownResponse)
    ];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text).toBe(markdownResponse);
  });

  it('uses non-empty result text over assistant narration', () => {
    const turnId = makeTurnId();
    const narration = 'Let me think about this...';
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, narration)
    ];
    const fullResult = narration + '\n\nHere is the actual answer to your question.';
    const resultEvent = {
      type: 'result' as const,
      text: fullResult,
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('result');
    expect(result[1].text).toBe(fullResult);
  });

  it('tool-start pruning still removes narration before result arrives', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      activeTurnId: turnId,
      isBusy: true
    });

    // Step 1: Assistant emits narration
    state = updateConversationWithEvent(state, turnId, {
      type: 'assistant',
      text: "I'll search for that.",
      timestamp: Date.now()
    });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe('assistant');

    // Step 2: Tool starts — narration should be pruned
    state = updateConversationWithEvent(state, turnId, {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');

    // Step 3: Empty result — no assistant message to promote
    state = updateConversationWithEvent(state, turnId, {
      type: 'result',
      text: '',
      timestamp: Date.now()
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
  });
});

describe('mergeResultMessage user_stopped preservation (FOX-3148)', () => {
  it('preserves narration when empty result carries turnEndReason: user_stopped', () => {
    const turnId = makeTurnId();
    const narration = "I'll check that for you.";
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, narration)
    ];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now(),
      turnEndReason: 'user_stopped' as const
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);

    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('assistant');
    expect(result[1].text).toBe(narration);
  });

  it('still deletes narration on empty result WITHOUT turnEndReason: user_stopped', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, "I'll check that for you.")
    ];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now()
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('still deletes narration on empty result with turnEndReason: completed', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      makeAssistantMessage(turnId, "I'll check that for you.")
    ];
    const resultEvent = {
      type: 'result' as const,
      text: '',
      timestamp: Date.now(),
      turnEndReason: 'completed' as const
    };

    const result = mergeResultMessage(messages, turnId, resultEvent);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });
});



describe('isBusy self-healing', () => {
  it('tool start event restores isBusy when incorrectly false', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: false,
      activeTurnId: null
    });

    const result = updateConversationWithEvent(state, turnId, {
      type: 'tool',
      toolName: 'Bash',
      toolUseId: 'tool-1',
      parentToolUseId: null,
      detail: '',
      stage: 'start',
      timestamp: Date.now()
    });

    expect(result.isBusy).toBe(true);
    expect(result.activeTurnId).toBe(turnId);
  });

  it('status event restores isBusy when incorrectly false', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: false,
      activeTurnId: null
    });

    const result = updateConversationWithEvent(state, turnId, {
      type: 'status',
      message: 'Tool is running. Standing by for results.',
      timestamp: Date.now()
    });

    expect(result.isBusy).toBe(true);
    expect(result.activeTurnId).toBe(turnId);
  });

  it('tool start does not change isBusy when already true', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    const result = updateConversationWithEvent(state, turnId, {
      type: 'tool',
      toolName: 'Bash',
      toolUseId: 'tool-1',
      parentToolUseId: null,
      detail: '',
      stage: 'start',
      timestamp: Date.now()
    });

    expect(result.isBusy).toBe(true);
    expect(result.activeTurnId).toBe(turnId);
  });

  it('creates warning message with synthetic turnId detached from active turn', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      activeTurnId: turnId,
      isBusy: true,
    });

    const event: AgentEvent = {
      type: 'warning',
      message: 'MCP tools unavailable',
      category: 'mcp',
      timestamp: Date.now(),
    };
    const next = updateConversationWithEvent(state, turnId, event);

    expect(next.messages).toHaveLength(2);
    const warningMsg = next.messages[1];
    expect(warningMsg.role).toBe('assistant');
    expect(warningMsg.isWarning).toBe(true);
    expect(warningMsg.text).toBe('MCP tools unavailable');
    // Synthetic turnId must differ from the active turn
    expect(warningMsg.turnId).not.toBe(turnId);
    // Warning must NOT change isBusy
    expect(next.isBusy).toBe(true);
  });

  it('warning message is not merged with existing assistant message', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [
        makeUserMessage(turnId),
        makeAssistantMessage(turnId, 'I will help you.'),
      ],
      activeTurnId: turnId,
      isBusy: true,
    });

    const event: AgentEvent = {
      type: 'warning',
      message: 'MCP tools unavailable',
      timestamp: Date.now(),
    };
    const next = updateConversationWithEvent(state, turnId, event);

    // Warning creates a new message, does not merge
    expect(next.messages).toHaveLength(3);
    expect(next.messages[1].text).toBe('I will help you.');
    expect(next.messages[1].isWarning).toBeUndefined();
    expect(next.messages[2].isWarning).toBe(true);
  });

  it('deduplicates consecutive identical warning messages', () => {
    const turnId = makeTurnId();
    const warningMsg: AgentTurnMessage = {
      id: 'msg-warning-1',
      turnId: 'synthetic-turn-1',
      role: 'assistant',
      text: 'MCP tools unavailable',
      isWarning: true,
      createdAt: Date.now(),
    };
    const state = makeBaseState({
      messages: [makeUserMessage(turnId), warningMsg],
      activeTurnId: turnId,
      isBusy: true,
    });

    const event: AgentEvent = {
      type: 'warning',
      message: 'MCP tools unavailable',
      timestamp: Date.now(),
    };
    const next = updateConversationWithEvent(state, turnId, event);

    // Duplicate warning suppressed — message count unchanged
    expect(next.messages).toHaveLength(2);
  });

  it('re-emits warning after intervening non-warning message', () => {
    const turnId = makeTurnId();
    const warningMsg: AgentTurnMessage = {
      id: 'msg-warning-1',
      turnId: 'synthetic-turn-1',
      role: 'assistant',
      text: 'MCP tools unavailable',
      isWarning: true,
      createdAt: Date.now(),
    };
    // Warning, then a result (successful turn), then same warning again
    const resultMsg: AgentTurnMessage = {
      id: 'msg-result-1',
      turnId,
      role: 'result',
      text: 'Done!',
      createdAt: Date.now(),
    };
    const state = makeBaseState({
      messages: [makeUserMessage(turnId), warningMsg, resultMsg],
      isBusy: true,
    });

    const event: AgentEvent = {
      type: 'warning',
      message: 'MCP tools unavailable',
      timestamp: Date.now(),
    };
    const next = updateConversationWithEvent(state, turnId, event);

    // Same warning text but last message is a result, not a warning — should create new warning
    expect(next.messages).toHaveLength(4);
    expect(next.messages[3].isWarning).toBe(true);
  });

  it('allows different warning messages', () => {
    const turnId = makeTurnId();
    const warningMsg: AgentTurnMessage = {
      id: 'msg-warning-1',
      turnId: 'synthetic-turn-1',
      role: 'assistant',
      text: 'MCP tools unavailable',
      isWarning: true,
      createdAt: Date.now(),
    };
    const state = makeBaseState({
      messages: [makeUserMessage(turnId), warningMsg],
      activeTurnId: turnId,
      isBusy: true,
    });

    const event: AgentEvent = {
      type: 'warning',
      message: 'A different warning',
      timestamp: Date.now(),
    };
    const next = updateConversationWithEvent(state, turnId, event);

    // Different text — new warning created
    expect(next.messages).toHaveLength(3);
    expect(next.messages[2].text).toBe('A different warning');
    expect(next.messages[2].isWarning).toBe(true);
  });
});

describe('post-terminal self-heal guard', () => {
  it('error → status: isBusy stays false, activeTurnId stays null', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    // Terminal event: error
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Connection failed',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);

    // Post-terminal status event — must NOT re-activate
    state = updateConversationWithEvent(state, turnId, {
      type: 'status',
      message: 'Connection lost...',
      timestamp: 1030
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('result → status: isBusy stays false, activeTurnId stays null', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    // Terminal event: result
    state = updateConversationWithEvent(state, turnId, {
      type: 'result',
      text: 'Done.',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);

    // Post-terminal status event — must NOT re-activate
    state = updateConversationWithEvent(state, turnId, {
      type: 'status',
      message: 'Cleanup in progress...',
      timestamp: 1030
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('error → tool:start: isBusy stays false', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'test error',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);

    // Post-terminal tool:start — must NOT re-activate
    state = updateConversationWithEvent(state, turnId, {
      type: 'tool',
      toolName: 'Bash',
      detail: '',
      stage: 'start',
      timestamp: 1050
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('error → assistant: isBusy stays false', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'test error',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);

    // Post-terminal assistant — must NOT re-activate
    state = updateConversationWithEvent(state, turnId, {
      type: 'assistant',
      text: 'Late streaming chunk',
      timestamp: 1050
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('error → empty assistant: isBusy stays false', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'test error',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);

    // Post-terminal empty assistant — must NOT re-activate
    state = updateConversationWithEvent(state, turnId, {
      type: 'assistant',
      text: '',
      timestamp: 1050
    });
    expect(state.isBusy).toBe(false);
  });

  it('self-heal still works for non-terminated turns (reload recovery)', () => {
    // Scenario: app reloaded, isBusy false, no terminal turn — status arrives from active turn
    let state = makeBaseState({
      messages: [],
      isBusy: false,
      activeTurnId: null
    });

    state = updateConversationWithEvent(state, 'turn-1', {
      type: 'status',
      message: 'Working...',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe('turn-1');
  });

  it('self-heal works for a different turn after terminal', () => {
    const turnId1 = 'turn-1';
    const turnId2 = 'turn-2';
    let state = makeBaseState({
      messages: [makeUserMessage(turnId1)],
      isBusy: true,
      activeTurnId: turnId1
    });

    // Terminate turn-1
    state = updateConversationWithEvent(state, turnId1, {
      type: 'error',
      error: 'test error',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnId1)).toBe(true);

    // New turn-2 status should self-heal normally
    state = updateConversationWithEvent(state, turnId2, {
      type: 'status',
      message: 'Starting new turn...',
      timestamp: 2000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnId2);
  });

  it('tracks terminatedTurnIds through error then result sequence', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    // Error terminates
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'oops',
      timestamp: 1000
    });
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);

    // Late result for same turn — still terminal
    state = updateConversationWithEvent(state, turnId, {
      type: 'result',
      text: '',
      timestamp: 1050
    });
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);
    expect(state.isBusy).toBe(false);

    // Post-terminal status — still guarded
    state = updateConversationWithEvent(state, turnId, {
      type: 'status',
      message: 'Cleanup...',
      timestamp: 1100
    });
    expect(state.isBusy).toBe(false);
  });

  // Classified-supersede regression — see conversationState.ts § event.type === 'error'
  // and conversation 40699a29-3656-4e73-9e00-e8611ddb97a6.
  it('classified follow-on error overrides earlier unclassified error for the same turn', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    // First emit: raw OpenRouter inner message, no errorKind
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Provider returned error',
      provider: 'OpenRouter',
      errorSource: 'main',
      timestamp: 1000
    });
    expect(state.lastError).toBe('Provider returned error');
    expect(state.activeTurnId).toBeNull();
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);

    // Second emit ~16ms later: classified rate-limit copy from turnErrorRecovery
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: "Your AI provider's rate limit was reached. Try again shortly.",
      errorKind: 'rate_limit',
      provider: 'OpenRouter',
      errorSource: 'main',
      timestamp: 1016
    });
    expect(state.lastError).toBe(
      "Your AI provider's rate limit was reached. Try again shortly."
    );
    expect(state.lastErrorSource).toBe('main');
  });

  it('does NOT downgrade a classified lastError with a later unclassified error', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    // First (and only legitimate) emit: classified
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: "Your AI provider's rate limit was reached. Try again shortly.",
      errorKind: 'rate_limit',
      errorSource: 'main',
      timestamp: 1000
    });
    expect(state.lastError).toBe(
      "Your AI provider's rate limit was reached. Try again shortly."
    );

    // Stray late unclassified error for the same turn — must NOT overwrite
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Provider returned error',
      errorSource: 'main',
      timestamp: 1050
    });
    expect(state.lastError).toBe(
      "Your AI provider's rate limit was reached. Try again shortly."
    );
  });

  it('does not let a classified error from an unknown turn overwrite lastError', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B';
    let state = makeBaseState({
      messages: [makeUserMessage(turnA)],
      isBusy: true,
      activeTurnId: turnA
    });

    // Turn A errors out, classified
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'A failed (classified)',
      errorKind: 'rate_limit',
      errorSource: 'main',
      timestamp: 1000
    });
    expect(state.lastError).toBe('A failed (classified)');
    expect(state.terminatedTurnIds.has(turnA)).toBe(true);

    // Stray error for turnB which is NOT in terminatedTurnIds AND not active —
    // must NOT overwrite. (Prevents drive-by classified errors from another
    // session/turn from clobbering the displayed error.)
    state = updateConversationWithEvent(state, turnB, {
      type: 'error',
      error: 'B failed (classified, but never started)',
      errorKind: 'auth',
      errorSource: 'main',
      timestamp: 1100
    });
    expect(state.lastError).toBe('A failed (classified)');
  });

  it('does not overwrite a newer turn error with a late classified follow-on for an older turn', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B';
    let state = makeBaseState({
      messages: [makeUserMessage(turnA)],
      isBusy: true,
      activeTurnId: turnA
    });

    // Turn A errors out (unclassified)
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'A initial failure',
      errorSource: 'main',
      timestamp: 1000
    });
    expect(state.lastError).toBe('A initial failure');

    // Turn B starts and errors out — Turn B's error must remain on lastError
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 1100
    });
    state = updateConversationWithEvent(state, turnB, {
      type: 'error',
      error: 'B failure (current)',
      errorKind: 'auth',
      errorSource: 'main',
      timestamp: 1200
    });
    expect(state.lastError).toBe('B failure (current)');
    expect(state.terminatedTurnIds.has(turnA)).toBe(true);
    expect(state.terminatedTurnIds.has(turnB)).toBe(true);

    // Late classified follow-on for the older Turn A — must NOT clobber B's
    // error. Cross-turn safety: only the most-recently-terminated turn (B)
    // can supersede.
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'A late classified copy',
      errorKind: 'rate_limit',
      errorSource: 'main',
      timestamp: 1300
    });
    expect(state.lastError).toBe('B failure (current)');
  });

  it('does not resurrect old turn error after a newer turn has cleared lastError via clean result', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B';
    let state = makeBaseState({
      messages: [makeUserMessage(turnA)],
      isBusy: true,
      activeTurnId: turnA
    });

    // Turn A errors out (unclassified)
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'A initial failure',
      errorSource: 'main',
      timestamp: 1000
    });
    expect(state.lastError).toBe('A initial failure');

    // Turn B starts and completes cleanly — clears lastError to null
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 1100
    });
    state = updateConversationWithEvent(state, turnB, {
      type: 'result',
      text: 'All good.',
      timestamp: 1200
    });
    expect(state.lastError).toBeNull();
    expect(state.terminatedTurnIds.has(turnA)).toBe(true);
    expect(state.terminatedTurnIds.has(turnB)).toBe(true);

    // Late classified follow-on for Turn A arrives — must NOT resurrect
    // (lastError === null guard prevents the supersede from firing).
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'A late classified copy',
      errorKind: 'rate_limit',
      errorSource: 'main',
      timestamp: 1300
    });
    expect(state.lastError).toBeNull();
  });
});

// The classified-supersede ONLY operates on the live in-process IPC path,
// where state.terminatedTurnIds is populated and ordered. On the rehydrated-
// from-disk path the field is stripped by incrementalSessionStore so the
// insertion-order-based "most recently terminated" check can't be relied on
// for cross-turn safety. The persisted `lastError` field captures the final
// state directly, so no supersede is needed at load time.
describe('classified-supersede is gated to live path only', () => {
  it('does NOT supersede on rehydrated-from-disk shape (empty terminatedTurnIds)', () => {
    const turnId = makeTurnId();
    const firstError: AgentEvent = {
      type: 'error',
      error: 'Provider returned error',
      errorSource: 'main',
      timestamp: 1000
    };
    // State right after a session was loaded from disk: eventsByTurn contains
    // the prior (unclassified) error, lastError carries the raw string,
    // terminatedTurnIds is the empty Set the persist layer leaves us.
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      eventsByTurn: { [turnId]: [firstError] },
      activeTurnId: null,
      isBusy: false,
      lastError: 'Provider returned error',
      lastErrorSource: 'main'
    });

    const next = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: "Your AI provider's rate limit was reached. Try again shortly.",
      errorKind: 'rate_limit',
      errorSource: 'main',
      timestamp: 1016
    });

    // No supersede — lastError stays as the persisted raw copy.
    expect(next.lastError).toBe('Provider returned error');
  });
});

// Stage 1 (260528 terminal-state-presentation-health): the production
// transient-error dual-emit ordering. The main process fans out two error
// events for one upstream failure (see PLAN.md Root Cause Assessment / F3):
//   seq37 — generic, NO `isTransient`, NO `errorKind`, arrives while the turn
//           is still active. Terminates the turn; the `mergeErrorMessage`
//           trajectory stamp gate (`turnIsActive && event.isTransient === true`)
//           is skipped because `isTransient` is falsy.
//   seq38 — typed, `errorKind: 'server_error'`, `isTransient: true`, arrives
//           ~36ms later AFTER the turn is already terminated, taking the
//           `isFollowOnClassifiedError` supersede branch.
// Before the fix the supersede branch skipped `mergeErrorMessage` entirely, so
// `endedWith: 'transient_error'` never landed for this ordering (F3). The fix
// (variant b) moves the stamp onto the supersede branch when the typed event
// is transient. These tests pin both the repro and the fix.
describe('Stage 1 — transient-error dual-emit trajectory stamp (F3)', () => {
  const turnId = 'turn-dual-emit-1';
  // Substantive assistant text so `mergeErrorMessage` Tier 2 has something to
  // promote/stamp — makes the `endedWith` outcome unambiguous (a stamp lands
  // iff mergeErrorMessage runs).
  const substantiveText = '## Progress\n\nGathered the relevant context and drafted a plan.';

  const seedActiveTurn = (): ConversationStateShape =>
    makeBaseState({
      messages: [makeUserMessage(turnId), makeAssistantMessage(turnId, substantiveText)],
      eventsByTurn: {
        [turnId]: [{ type: 'assistant', text: substantiveText, timestamp: 900 }]
      },
      activeTurnId: turnId,
      isBusy: true
    });

  const findTurnResult = (state: ConversationStateShape): AgentTurnMessage | undefined =>
    [...state.messages].reverse().find(m => m.turnId === turnId && m.role === 'result');

  it('reproduces the production seq37 → (turn terminated) → seq38 ordering', () => {
    let state = seedActiveTurn();

    // seq37 — generic, unclassified, while the turn is genuinely active.
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Something went sideways.',
      errorSource: 'main',
      timestamp: 1000
    });

    // MANDATORY faithfulness guard (Runtime Safety F2 / Arbitrator 3a): the
    // generic event must have ACTUALLY terminated the turn, so that the later
    // stamp behaviour is attributable to the supersede branch — NOT to the turn
    // already being inactive when the first event arrived (which would make the
    // test pass green for the wrong reason).
    expect(state.activeTurnId).toBeNull();
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);
    expect(state.lastError).toBe('Something went sideways.');
    // The generic event carries no `isTransient`, so the trajectory stamp was
    // skipped on its (active) branch.
    expect(findTurnResult(state)?.endedWith).not.toBe('transient_error');

    // seq38 — typed/transient, same turn, now most-recently-terminated. Hits
    // the `isFollowOnClassifiedError` supersede branch.
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'The AI service had a moment.',
      errorKind: 'server_error',
      isTransient: true,
      errorSource: 'main',
      timestamp: 1036
    });

    // Confirm the supersede branch was the one taken (lastError upgraded in
    // place), not a no-op.
    expect(state.lastError).toBe('The AI service had a moment.');
  });

  it('stamps endedWith: transient_error on the supersede branch (F3 fix)', () => {
    let state = seedActiveTurn();

    // seq37 — generic, terminates the turn without stamping.
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Something went sideways.',
      errorSource: 'main',
      timestamp: 1000
    });
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);

    // seq38 — typed/transient follow-on on the supersede branch.
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'The AI service had a moment.',
      errorKind: 'server_error',
      isTransient: true,
      errorSource: 'main',
      timestamp: 1036
    });

    // The fix: the typed transient follow-on now stamps the trajectory even on
    // the supersede branch.
    expect(findTurnResult(state)?.endedWith).toBe('transient_error');
    // And the in-place lastError upgrade (invariant #2) still happened.
    expect(state.lastError).toBe('The AI service had a moment.');
  });

  it('does NOT stamp when the typed follow-on is non-transient (e.g. auth)', () => {
    let state = seedActiveTurn();

    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Something went sideways.',
      errorSource: 'main',
      timestamp: 1000
    });

    // Non-transient classified follow-on (auth). Supersede still upgrades
    // lastError in place, but no transient trajectory stamp.
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Authentication failed.',
      errorKind: 'auth',
      errorSource: 'main',
      timestamp: 1036
    });

    expect(state.lastError).toBe('Authentication failed.');
    expect(findTurnResult(state)?.endedWith).not.toBe('transient_error');
  });

  it('still stamps on the standard active path (single transient terminal, no dual-emit)', () => {
    let state = seedActiveTurn();

    // A single transient error arriving while the turn is active — the
    // pre-existing happy path. Stamp must still land here.
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'The AI service had a moment.',
      errorKind: 'server_error',
      isTransient: true,
      errorSource: 'main',
      timestamp: 1000
    });

    expect(state.activeTurnId).toBeNull();
    expect(findTurnResult(state)?.endedWith).toBe('transient_error');
  });

  it('still produces a user-visible error for a genuinely-unknown one-shot error (no fail-open)', () => {
    let state = seedActiveTurn();

    // A lone unclassified error with no typed follow-on — must still surface a
    // user-visible error (invariant #1: no swallowed errors).
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Something went sideways.',
      errorSource: 'main',
      timestamp: 1000
    });

    expect(state.lastError).toBe('Something went sideways.');
    expect(state.activeTurnId).toBeNull();
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);
    // No transient stamp for a genuinely-unknown error (correct: it isn't
    // transient).
    expect(findTurnResult(state)?.endedWith).not.toBe('transient_error');
  });
});

// Stage 2 (260529 error-emit-funnel): the bulletproof F3 guard. Replays the
// production dual-emit through the REAL `conversationState` reducer (not a
// mock) and asserts `endedWith === 'transient_error'` lands in BOTH orderings.
// This is the HARD-CONSTRAINT regression fence for the descoped Stage 2: the
// renderer stays the sole arbiter, and any future change to the funnel /
// emit sites / reducer that breaks this ordering must fail loudly here.
//
//   Ordering (i)  — the canonical F3 trace: blind `unknown` (no errorKind, no
//                   isTransient) terminates the turn while active, then a typed
//                   `server_error`/`isTransient:true` follow-on arrives after
//                   termination and takes the supersede branch. The stamp must
//                   land via `isFollowOnClassifiedError`.
//   Ordering (ii) — the reverse: a typed transient error terminates the turn on
//                   the active path (stamps immediately), then a later blind
//                   `unknown` follow-on arrives. The blind follow-on must NOT
//                   downgrade/unstamp it (it carries no errorKind, so it cannot
//                   supersede), and `endedWith: 'transient_error'` must survive.
describe('Stage 2 — F3 both-orderings real-reducer regression fence', () => {
  const turnId = 'turn-both-orderings';
  const substantiveText = '## Progress\n\nDrafted a plan before the connection dropped.';

  const seedActiveTurn = (): ConversationStateShape =>
    makeBaseState({
      messages: [makeUserMessage(turnId), makeAssistantMessage(turnId, substantiveText)],
      eventsByTurn: {
        [turnId]: [{ type: 'assistant', text: substantiveText, timestamp: 900 }]
      },
      activeTurnId: turnId,
      isBusy: true
    });

  const findTurnResult = (state: ConversationStateShape): AgentTurnMessage | undefined =>
    [...state.messages].reverse().find(m => m.turnId === turnId && m.role === 'result');

  // The blind first emit, faithfully shaped as the funnel emits it for an
  // `unknown` kind: errorKind OMITTED (the I2 wire contract), no isTransient.
  const blindUnknownEvent: AgentEvent = {
    type: 'error',
    error: 'Provider returned error',
    errorSource: 'main',
    timestamp: 1000
  };
  // The typed follow-on: a transient server_error carrying the authoritative
  // `isTransient: true` and a concrete `errorKind`.
  const typedTransientEvent: AgentEvent = {
    type: 'error',
    error: 'The AI service had a moment.',
    errorKind: 'server_error',
    isTransient: true,
    errorSource: 'main',
    timestamp: 1036
  };

  it('ordering (i): blind unknown (terminates active) → typed transient follow-on → stamp lands', () => {
    let state = seedActiveTurn();

    // Emit #1 — blind unknown while the turn is genuinely active.
    state = updateConversationWithEvent(state, turnId, blindUnknownEvent);

    // Faithfulness guard: the blind event must have ACTUALLY terminated the
    // turn (so the stamp below is attributable to the supersede branch, not to
    // the turn already being inactive). Mirrors the Stage-1 F3 block's guard.
    expect(state.activeTurnId).toBeNull();
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);
    expect(state.lastError).toBe('Provider returned error');
    // The blind event carries no isTransient → no stamp yet.
    expect(findTurnResult(state)?.endedWith).not.toBe('transient_error');

    // Emit #2 — typed transient follow-on, same turn, now most-recently
    // terminated → supersede branch.
    state = updateConversationWithEvent(state, turnId, typedTransientEvent);

    // HARD CONSTRAINT: the transient classification wins and the trajectory is
    // stamped, even though the blind unknown arrived first.
    expect(findTurnResult(state)?.endedWith).toBe('transient_error');
    // The lastError was upgraded in place to the typed copy (never the blind one).
    expect(state.lastError).toBe('The AI service had a moment.');
  });

  it('ordering (ii): typed transient (terminates active, stamps) → blind unknown follow-on → stamp survives', () => {
    let state = seedActiveTurn();

    // Emit #1 — typed transient while active. Stamps on the active path.
    state = updateConversationWithEvent(state, turnId, {
      ...typedTransientEvent,
      timestamp: 1000
    });

    expect(state.activeTurnId).toBeNull();
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);
    expect(state.lastError).toBe('The AI service had a moment.');
    expect(findTurnResult(state)?.endedWith).toBe('transient_error');

    // Emit #2 — a later blind unknown follow-on. It carries no errorKind, so it
    // is NOT eligible to supersede (the guard keys on errorKind !== undefined).
    state = updateConversationWithEvent(state, turnId, {
      ...blindUnknownEvent,
      timestamp: 1036
    });

    // HARD CONSTRAINT: the blind follow-on must NOT downgrade the classified
    // prior or unstamp the trajectory.
    expect(findTurnResult(state)?.endedWith).toBe('transient_error');
    expect(state.lastError).toBe('The AI service had a moment.');
  });
});

describe('turn_started event', () => {
  it('turn_started sets isBusy and activeTurnId', () => {
    const turnId = makeTurnId();
    const state = makeBaseState();

    const next = updateConversationWithEvent(state, turnId, {
      type: 'turn_started',
      timestamp: 1000
    });

    expect(next.isBusy).toBe(true);
    expect(next.activeTurnId).toBe(turnId);
    expect(next.lastError).toBeNull();
  });

  it('turn_started does not re-activate after result', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    // Terminate with result
    state = updateConversationWithEvent(state, turnId, {
      type: 'result',
      text: 'Done.',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);

    // Late turn_started for same turn — must NOT re-activate
    state = updateConversationWithEvent(state, turnId, {
      type: 'turn_started',
      timestamp: 1050
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('turn_started does not re-activate after error', () => {
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    // Terminate with error
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Connection failed',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnId)).toBe(true);

    // Late turn_started for same turn — must NOT re-activate
    state = updateConversationWithEvent(state, turnId, {
      type: 'turn_started',
      timestamp: 1050
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('turn_started for new turn after previous completed', () => {
    const turnIdA = 'turn-A';
    const turnIdB = 'turn-B';
    let state = makeBaseState({
      messages: [makeUserMessage(turnIdA)],
      isBusy: true,
      activeTurnId: turnIdA
    });

    // Terminate turn A
    state = updateConversationWithEvent(state, turnIdA, {
      type: 'result',
      text: 'Done.',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnIdA)).toBe(true);

    // turn_started for new turn B — should activate
    state = updateConversationWithEvent(state, turnIdB, {
      type: 'turn_started',
      timestamp: 2000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnIdB);
  });

  it('turn_started is idempotent with existing busy state', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      isBusy: true,
      activeTurnId: turnId,
      lastError: null,
      lastErrorSource: null
    });

    // turn_started for same already-busy turn — no change
    const next = updateConversationWithEvent(state, turnId, {
      type: 'turn_started',
      timestamp: 1000
    });
    expect(next.isBusy).toBe(true);
    expect(next.activeTurnId).toBe(turnId);
  });
});

describe('concurrent turn terminal guard', () => {
  it('late status from older terminated turn does not re-activate busy', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B';
    let state = makeBaseState({
      messages: [makeUserMessage(turnA)],
      isBusy: true,
      activeTurnId: turnA
    });

    // Turn A errors
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'Turn A failed',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnA)).toBe(true);

    // Turn B starts and completes
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 2000
    });
    expect(state.isBusy).toBe(true);

    state = updateConversationWithEvent(state, turnB, {
      type: 'result',
      text: 'Done B.',
      timestamp: 3000
    });
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnA)).toBe(true);
    expect(state.terminatedTurnIds.has(turnB)).toBe(true);

    // Late status for turn A arrives — must NOT re-activate
    state = updateConversationWithEvent(state, turnA, {
      type: 'status',
      message: 'Stale status from A',
      timestamp: 3100
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('late assistant from older terminated turn does not re-activate busy', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B';
    let state = makeBaseState({
      messages: [makeUserMessage(turnA)],
      isBusy: true,
      activeTurnId: turnA
    });

    // Turn A errors
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'Turn A failed',
      timestamp: 1000
    });

    // Turn B completes
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 2000
    });
    state = updateConversationWithEvent(state, turnB, {
      type: 'result',
      text: 'Done B.',
      timestamp: 3000
    });
    expect(state.isBusy).toBe(false);

    // Late assistant for turn A — must NOT re-activate
    state = updateConversationWithEvent(state, turnA, {
      type: 'assistant',
      text: 'Late streaming chunk from A',
      timestamp: 3100
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('late turn_started from older terminated turn does not re-activate busy', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B';
    let state = makeBaseState({
      messages: [makeUserMessage(turnA)],
      isBusy: true,
      activeTurnId: turnA
    });

    // Turn A errors
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'Turn A failed',
      timestamp: 1000
    });

    // Turn B completes
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 2000
    });
    state = updateConversationWithEvent(state, turnB, {
      type: 'result',
      text: 'Done B.',
      timestamp: 3000
    });
    expect(state.isBusy).toBe(false);

    // Late turn_started for turn A — must NOT re-activate
    state = updateConversationWithEvent(state, turnA, {
      type: 'turn_started',
      timestamp: 3100
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('new turn C starts correctly after A and B both terminated', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B';
    const turnC = 'turn-C';
    let state = makeBaseState({
      messages: [makeUserMessage(turnA)],
      isBusy: true,
      activeTurnId: turnA
    });

    // Turn A errors
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'Turn A failed',
      timestamp: 1000
    });

    // Turn B completes
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 2000
    });
    state = updateConversationWithEvent(state, turnB, {
      type: 'result',
      text: 'Done B.',
      timestamp: 3000
    });
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnA)).toBe(true);
    expect(state.terminatedTurnIds.has(turnB)).toBe(true);

    // New turn C starts — should activate normally
    state = updateConversationWithEvent(state, turnC, {
      type: 'turn_started',
      timestamp: 4000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnC);
    expect(state.terminatedTurnIds.has(turnC)).toBe(false);
  });

  it('three concurrent turns — all terminate, late events from first two are ignored', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B';
    const turnC = 'turn-C';
    let state = makeBaseState({
      messages: [makeUserMessage(turnA)],
      isBusy: true,
      activeTurnId: turnA
    });

    // Turn A errors
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'Turn A failed',
      timestamp: 1000
    });

    // Turn B errors
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 2000
    });
    state = updateConversationWithEvent(state, turnB, {
      type: 'error',
      error: 'Turn B failed',
      timestamp: 2500
    });

    // Turn C completes
    state = updateConversationWithEvent(state, turnC, {
      type: 'turn_started',
      timestamp: 3000
    });
    state = updateConversationWithEvent(state, turnC, {
      type: 'result',
      text: 'Done C.',
      timestamp: 4000
    });
    expect(state.isBusy).toBe(false);
    expect(state.terminatedTurnIds.has(turnA)).toBe(true);
    expect(state.terminatedTurnIds.has(turnB)).toBe(true);
    expect(state.terminatedTurnIds.has(turnC)).toBe(true);

    // Late status for turn A — ignored
    state = updateConversationWithEvent(state, turnA, {
      type: 'status',
      message: 'Stale from A',
      timestamp: 4100
    });
    expect(state.isBusy).toBe(false);

    // Late status for turn B — ignored
    state = updateConversationWithEvent(state, turnB, {
      type: 'status',
      message: 'Stale from B',
      timestamp: 4200
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('bounded Set evicts oldest entries when exceeding MAX_TERMINATED_TURN_IDS', () => {
    let state = makeBaseState();

    // Terminate 55 turns (exceeds the 50 limit)
    for (let i = 0; i < 55; i++) {
      const turnId = `turn-${i}`;
      state = updateConversationWithEvent(state, turnId, {
        type: 'error',
        error: `Error ${i}`,
        timestamp: 1000 + i
      });
    }

    // Set should be bounded to 50
    expect(state.terminatedTurnIds.size).toBe(50);

    // Oldest turns (0-4) should have been evicted
    expect(state.terminatedTurnIds.has('turn-0')).toBe(false);
    expect(state.terminatedTurnIds.has('turn-1')).toBe(false);
    expect(state.terminatedTurnIds.has('turn-2')).toBe(false);
    expect(state.terminatedTurnIds.has('turn-3')).toBe(false);
    expect(state.terminatedTurnIds.has('turn-4')).toBe(false);

    // Recent turns should still be tracked
    expect(state.terminatedTurnIds.has('turn-54')).toBe(true);
    expect(state.terminatedTurnIds.has('turn-5')).toBe(true);
  });
});

describe('question-pause turn creates visible result message', () => {
  it('creates quip message when turn has user_question events and empty result', () => {
    const turnId = 'turn-question-pause';
    let state = makeBaseState();

    state = updateConversationWithEvent(state, turnId, {
      type: 'turn_started',
      timestamp: 1000
    });

    state = updateConversationWithEvent(state, turnId, {
      type: 'user_question',
      batchId: 'batch-1',
      toolUseId: 'tool-1',
      questions: [{ id: 'q0', question: 'Which browser?', header: 'Browser', multiSelect: false, options: [{ id: 'q0-opt0', label: 'Chrome', description: '' }] }],
      timestamp: 2000
    });

    state = updateConversationWithEvent(state, turnId, {
      type: 'result',
      text: '',
      timestamp: 3000
    });

    const resultMessages = state.messages.filter(m => m.role === 'result');
    expect(resultMessages).toHaveLength(1);
    expect(resultMessages[0].text.length).toBeGreaterThan(0);
    expect(resultMessages[0].turnId).toBe(turnId);
  });
});

/**
 * Regression tests for the AskUserQuestion continuation stall fix.
 *
 * Bug: After a user answers an inline AskUserQuestion, a deny-and-retry flow
 * produces a late `result` from the old turn. If a continuation turn (Turn B)
 * has already started via `turn_started`, the late result from Turn A must NOT
 * clear the busy state for Turn B.
 *
 * Fix: `result` and `error` handlers guard with `state.activeTurnId === turnId`
 * before clearing isBusy.
 *
 * See: docs/plans/260414_user_question_continuation_stall_fix.md
 */
describe('AskUserQuestion continuation race condition', () => {
  it('late result from old turn does NOT clear busy state for newer turn', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B-continuation';
    let state = makeBaseState();

    // Step 1: Turn A starts → isBusy=true, activeTurnId=turnA
    state = updateConversationWithEvent(state, turnA, {
      type: 'turn_started',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnA);

    // Step 2: Turn B (continuation after user answers question) starts
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 2000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnB);

    // Step 3: Late result from Turn A arrives (deny-and-retry result)
    // This must NOT clear isBusy — Turn B is still active
    state = updateConversationWithEvent(state, turnA, {
      type: 'result',
      text: '',
      timestamp: 2500
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnB);

    // Step 4: Normal result from Turn B completes the conversation
    state = updateConversationWithEvent(state, turnB, {
      type: 'result',
      text: 'Here is the answer.',
      timestamp: 3000
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('late error from old turn does NOT clear busy state for newer turn', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B-continuation';
    let state = makeBaseState();

    // Step 1: Turn A starts
    state = updateConversationWithEvent(state, turnA, {
      type: 'turn_started',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnA);

    // Step 2: Turn B (continuation) starts
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 2000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnB);

    // Step 3: Late error from Turn A arrives
    // This must NOT clear isBusy — Turn B is still active
    state = updateConversationWithEvent(state, turnA, {
      type: 'error',
      error: 'Turn A failed after question deny-and-retry',
      timestamp: 2500
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnB);
    // Turn A should still be tracked as terminated
    expect(state.terminatedTurnIds.has(turnA)).toBe(true);

    // Step 4: Turn B completes normally
    state = updateConversationWithEvent(state, turnB, {
      type: 'result',
      text: 'Done.',
      timestamp: 3000
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
  });

  it('late result from old turn does not overwrite error from newer turn', () => {
    const turnA = 'turn-A';
    const turnB = 'turn-B-continuation';
    let state = makeBaseState();

    // Turn A starts
    state = updateConversationWithEvent(state, turnA, {
      type: 'turn_started',
      timestamp: 1000
    });

    // Turn B starts (continuation)
    state = updateConversationWithEvent(state, turnB, {
      type: 'turn_started',
      timestamp: 2000
    });

    // Turn B errors out first
    state = updateConversationWithEvent(state, turnB, {
      type: 'error',
      error: 'Turn B hit an error',
      timestamp: 2500
    });
    expect(state.isBusy).toBe(false);
    expect(state.lastError).toBe('Turn B hit an error');

    // Late result from Turn A — must NOT clear the error from Turn B
    state = updateConversationWithEvent(state, turnA, {
      type: 'result',
      text: '',
      timestamp: 3000
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
    // lastError from Turn B must persist — the late result from Turn A must not
    // clear it. Fixed: removed activeTurnId===null fallback that incorrectly
    // allowed late results to clear errors from newer turns.
    expect(state.lastError).toBe('Turn B hit an error');
  });
});

describe('duplicate turn_started idempotency', () => {
  it('duplicate turn_started for same turn is idempotent', () => {
    const turnX = 'turn-X';
    let state = makeBaseState();

    // First turn_started
    state = updateConversationWithEvent(state, turnX, {
      type: 'turn_started',
      timestamp: 1000
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnX);

    // Second turn_started (e.g., redelivered broadcast or replay)
    state = updateConversationWithEvent(state, turnX, {
      type: 'turn_started',
      timestamp: 1001
    });
    expect(state.isBusy).toBe(true);
    expect(state.activeTurnId).toBe(turnX);

    // Known minor side-effect: eventsByTurn has TWO turn_started events
    // This is acceptable — they don't affect message rendering or state
    expect(state.eventsByTurn[turnX]).toHaveLength(2);
    expect(state.eventsByTurn[turnX][0].type).toBe('turn_started');
    expect(state.eventsByTurn[turnX][1].type).toBe('turn_started');
  });

  it('duplicate turn_started does not affect subsequent result processing', () => {
    const turnX = 'turn-X';
    let state = makeBaseState();

    // Duplicate turn_started events
    state = updateConversationWithEvent(state, turnX, {
      type: 'turn_started',
      timestamp: 1000
    });
    state = updateConversationWithEvent(state, turnX, {
      type: 'turn_started',
      timestamp: 1001
    });
    expect(state.isBusy).toBe(true);

    // Result should still correctly terminate the turn
    state = updateConversationWithEvent(state, turnX, {
      type: 'result',
      text: 'Done.',
      timestamp: 2000
    });
    expect(state.isBusy).toBe(false);
    expect(state.activeTurnId).toBeNull();
    expect(state.terminatedTurnIds.has(turnX)).toBe(true);
  });
});

describe('mergeErrorMessage — transient error trajectory recovery (4-tier fallback)', () => {
  const makeErrorEvent = (overrides?: Partial<Extract<AgentEvent, { type: 'error' }>>): Extract<AgentEvent, { type: 'error' }> => ({
    type: 'error',
    error: 'Connection dropped',
    isTransient: true,
    timestamp: 1000,
    ...overrides
  });

  it('Tier 1: stamps existing result-role message with endedWith=transient_error', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      { id: 'r1', turnId, role: 'result', text: 'Saved 7 meeting preps. Updated 8 tasks.', createdAt: 500 }
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent(), []);
    expect(next).toHaveLength(2);
    expect(next[1].role).toBe('result');
    expect(next[1].text).toBe('Saved 7 meeting preps. Updated 8 tasks.');
    expect(next[1].endedWith).toBe('transient_error');
    expect(next[1].id).toBe('r1');
  });

  it('Tier 1 idempotent: already-stamped result returns identical messages reference', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      { id: 'r1', turnId, role: 'result', text: 'Anchor', endedWith: 'transient_error', createdAt: 500 }
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent(), []);
    expect(next).toBe(messages);
  });

  it('Tier 2: promotes substantive assistant-role message to result + stamps marker', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      { id: 'a1', turnId, role: 'assistant', text: 'Saved seven meeting preps with full agendas.', createdAt: 500 }
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent({ timestamp: 999 }), []);
    expect(next).toHaveLength(2);
    expect(next[1].role).toBe('result');
    expect(next[1].text).toBe('Saved seven meeting preps with full agendas.');
    expect(next[1].endedWith).toBe('transient_error');
    expect(next[1].id).toBe('a1');
    expect(next[1].createdAt).toBe(999);
  });

  it('Tier 2 falls through when assistant text is process narration', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      { id: 'a1', turnId, role: 'assistant', text: "I'll check that for you.", createdAt: 500 }
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent(), []);
    expect(next).toHaveLength(3);
    expect(next[2].role).toBe('result');
    expect(next[2].text).toContain('connection dropped');
    expect(next[2].text).not.toContain('is saved');
    expect(next[2].text).not.toContain('is preserved');
    expect(next[2].endedWith).toBe('transient_error');
  });

  it('Tier 2 falls through when assistant text is too short', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      { id: 'a1', turnId, role: 'assistant', text: 'ok', createdAt: 500 }
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent(), []);
    expect(next).toHaveLength(3);
    expect(next[2].role).toBe('result');
    expect(next[2].endedWith).toBe('transient_error');
  });

  it('Tier 3: anchors new result on substantive assistant event when no prior message', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const turnEvents: AgentEvent[] = [
      { type: 'assistant', text: 'I researched the topic and found three relevant patterns.', timestamp: 600 }
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent({ timestamp: 1000 }), turnEvents);
    expect(next).toHaveLength(2);
    expect(next[1].role).toBe('result');
    expect(next[1].text).toBe('I researched the topic and found three relevant patterns.');
    expect(next[1].endedWith).toBe('transient_error');
    expect(next[1].createdAt).toBe(1000);
  });

  it('Tier 3 prefers most-recent substantive assistant event', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const turnEvents: AgentEvent[] = [
      { type: 'assistant', text: 'First substantive answer with enough detail.', timestamp: 500 },
      { type: 'assistant', text: 'Second answer that supersedes the first response.', timestamp: 700 }
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent(), turnEvents);
    expect(next[1].text).toBe('Second answer that supersedes the first response.');
  });

  it('Tier 3 skips narration events and falls through if all are narration', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const turnEvents: AgentEvent[] = [
      { type: 'assistant', text: "I'll look into that.", timestamp: 500 }
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent(), turnEvents);
    expect(next).toHaveLength(2);
    expect(next[1].text).toContain('connection dropped');
    expect(next[1].text).not.toContain('is saved');
    expect(next[1].text).not.toContain('is preserved');
    expect(next[1].endedWith).toBe('transient_error');
  });

  it('Tier 4: minimal anchor when no recoverable text exists', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent({ timestamp: 1234 }), []);
    expect(next).toHaveLength(2);
    expect(next[1].role).toBe('result');
    expect(next[1].text).toContain('connection dropped');
    expect(next[1].text).not.toContain('is saved');
    expect(next[1].text).not.toContain('is preserved');
    expect(next[1].endedWith).toBe('transient_error');
    expect(next[1].turnId).toBe(turnId);
    expect(next[1].createdAt).toBe(1234);
  });

  it('does not consult assistant_delta events (dropped by dispatcher manifest)', () => {
    // Defense-in-depth: if a delta ever leaked into eventsForTurn, recovery
    // must still skip it and fall through to the anchor path.
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [makeUserMessage(turnId)];
    const turnEvents = [
      { type: 'assistant_delta', text: 'streaming chunk', timestamp: 500 } as unknown as AgentEvent
    ];
    const next = mergeErrorMessage(messages, turnId, makeErrorEvent(), turnEvents);
    expect(next[1].text).toContain('connection dropped');
    expect(next[1].text).not.toContain('is saved');
    expect(next[1].text).not.toContain('is preserved');
    expect(next[1].endedWith).toBe('transient_error');
  });
});

describe('error event branch — transient trajectory recovery wiring', () => {
  it('only inserts recovery message when isTransient === true', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    // Non-transient error: no recovery message inserted
    const next = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Auth failed',
      isTransient: false,
      timestamp: 1000
    });
    expect(next.messages).toHaveLength(1);
    expect(next.lastError).toBe('Auth failed');
  });

  it('inserts recovery message with endedWith marker on transient error', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      eventsByTurn: {
        [turnId]: [
          { type: 'assistant', text: 'I researched seven topics and saved findings.', timestamp: 500 }
        ]
      },
      isBusy: true,
      activeTurnId: turnId
    });

    const next = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Connection dropped',
      isTransient: true,
      timestamp: 1000
    });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].role).toBe('result');
    expect(next.messages[1].endedWith).toBe('transient_error');
    expect(next.lastError).toBe('Connection dropped');
    expect(next.isBusy).toBe(false);
  });

  it('skips recovery when isTransient is undefined (preserves existing behavior)', () => {
    const turnId = makeTurnId();
    const state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    const next = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Generic error',
      timestamp: 1000
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages.find(m => m.endedWith === 'transient_error')).toBeUndefined();
  });

  it('does not re-promote on classified-supersede follow-on errors', () => {
    // A follow-on classified error for the same turn must not double-stamp.
    const turnId = makeTurnId();
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      isBusy: true,
      activeTurnId: turnId
    });

    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Stream ended without sending any chunks',
      isTransient: true,
      timestamp: 1000
    });
    const recoveryMessageCount = state.messages.filter(m => m.endedWith === 'transient_error').length;
    expect(recoveryMessageCount).toBe(1);

    // Follow-on classified error (~16ms later, classified copy)
    state = updateConversationWithEvent(state, turnId, {
      type: 'error',
      error: 'Provider returned 503',
      isTransient: true,
      errorKind: 'server_error',
      timestamp: 1016
    });
    const finalRecoveryCount = state.messages.filter(m => m.endedWith === 'transient_error').length;
    expect(finalRecoveryCount).toBe(1);
  });
});

describe('mergeResultMessage — transient error supersede', () => {
  it('clears endedWith marker and replaces text when real result arrives later', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      { id: 'r1', turnId, role: 'result', text: 'Anchor copy', endedWith: 'transient_error', createdAt: 1000 }
    ];

    const result = mergeResultMessage(messages, turnId, {
      type: 'result',
      text: 'Real model output that came in late.',
      timestamp: 2000
    } as Extract<AgentEvent, { type: 'result' }>, []);

    expect(result).toHaveLength(2);
    expect(result[1].text).toBe('Real model output that came in late.');
    expect(result[1].endedWith).toBeUndefined();
    expect(result[1].id).toBe('r1');
  });

  it('keeps endedWith marker when late result has empty text', () => {
    const turnId = makeTurnId();
    const messages: AgentTurnMessage[] = [
      makeUserMessage(turnId),
      { id: 'r1', turnId, role: 'result', text: 'Anchor copy', endedWith: 'transient_error', createdAt: 1000 }
    ];

    const result = mergeResultMessage(messages, turnId, {
      type: 'result',
      text: '',
      timestamp: 2000
    } as Extract<AgentEvent, { type: 'result' }>, []);

    expect(result[1].endedWith).toBe('transient_error');
    expect(result[1].text).toBe('Anchor copy');
  });
});

/**
 * Killer regression: a late `assistant` event byte-identical to the
 * already-promoted `result`-role text used to unconditionally double the
 * user-visible bubble via `existing.text + '\n\n' + text`. See
 * docs-private/investigations/260513_duplicate_result_text_in_message_bubble.md.
 */
describe('updateConversationWithEvent — late assistant after result (duplicate guard)', () => {
  it('does NOT double the result text when an exact duplicate assistant arrives late', () => {
    const turnId = makeTurnId();
    const finalText = 'This is the final answer the model produced for the user.';
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      activeTurnId: turnId,
      isBusy: true,
    });
    state = updateConversationWithEvent(state, turnId, {
      type: 'result',
      text: finalText,
      timestamp: 1_000,
    });
    expect(state.messages.filter((m) => m.role === 'result')).toHaveLength(1);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const next = updateConversationWithEvent(state, turnId, {
      type: 'assistant',
      text: finalText,
      timestamp: 1_001,
    });

    const resultMessages = next.messages.filter((m) => m.role === 'result');
    expect(resultMessages).toHaveLength(1);
    expect(resultMessages[0].text).toBe(finalText);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[conversationState] Late assistant event after result',
      expect.objectContaining({
        isExactDuplicate: true,
        existingTextLength: finalText.length,
        incomingTextLength: finalText.length,
        turnIdHash: expect.any(String),
      }),
    );

    warnSpy.mockRestore();
  });

  it('still appends genuinely-new text and emits the warn', () => {
    const turnId = makeTurnId();
    const initialText = 'First half of the answer.';
    const additional = 'Second half came later, with more detail.';
    let state = makeBaseState({
      messages: [makeUserMessage(turnId)],
      activeTurnId: turnId,
      isBusy: true,
    });
    state = updateConversationWithEvent(state, turnId, {
      type: 'result',
      text: initialText,
      timestamp: 1_000,
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const next = updateConversationWithEvent(state, turnId, {
      type: 'assistant',
      text: additional,
      timestamp: 1_001,
    });

    const resultMessages = next.messages.filter((m) => m.role === 'result');
    expect(resultMessages).toHaveLength(1);
    expect(resultMessages[0].text).toBe(initialText + '\n\n' + additional);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[conversationState] Late assistant event after result',
      expect.objectContaining({
        isExactDuplicate: false,
      }),
    );

    warnSpy.mockRestore();
  });
});

describe('AgentTurnMessageSchema — endedWith Zod round-trip', () => {
  it('parses and preserves endedWith=transient_error through Zod', async () => {
    const { AgentTurnMessageSchema } = await import('@shared/ipc/schemas/agent');
    const message: AgentTurnMessage = {
      id: 'm1',
      turnId: 't1',
      role: 'result',
      text: 'Recovered',
      createdAt: 1000,
      endedWith: 'transient_error'
    };
    const parsed = AgentTurnMessageSchema.parse(message);
    expect(parsed.endedWith).toBe('transient_error');
  });

  it('parses and preserves endedWith=superseded through Zod', async () => {
    const { AgentTurnMessageSchema } = await import('@shared/ipc/schemas/agent');
    const message: AgentTurnMessage = {
      id: 'm1',
      turnId: 't1',
      role: 'result',
      text: 'Interrupted before I could finish.',
      createdAt: 1000,
      endedWith: 'superseded'
    };
    const parsed = AgentTurnMessageSchema.parse(message);
    expect(parsed.endedWith).toBe('superseded');
  });

  it('rejects invalid endedWith values', async () => {
    const { AgentTurnMessageSchema } = await import('@shared/ipc/schemas/agent');
    expect(() =>
      AgentTurnMessageSchema.parse({
        id: 'm1',
        turnId: 't1',
        role: 'result',
        text: 'x',
        createdAt: 1000,
        endedWith: 'something_else'
      })
    ).toThrow();
  });

  it('omits endedWith on round-trip when not set', async () => {
    const { AgentTurnMessageSchema } = await import('@shared/ipc/schemas/agent');
    const parsed = AgentTurnMessageSchema.parse({
      id: 'm1',
      turnId: 't1',
      role: 'result',
      text: 'normal',
      createdAt: 1000
    });
    expect(parsed.endedWith).toBeUndefined();
  });
});
