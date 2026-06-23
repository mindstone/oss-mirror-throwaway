import { describe, it, expect } from 'vitest';
import type { AgentTurnMessage } from '@shared/types';
import {
  buildEnhancedPrompt,
  buildEnhancedPromptWithWindow,
  type ToolLimitSuggestion,
} from '../compactionUtils';

// --- Helpers ---

let msgCounter = 0;

function makeMessage(
  overrides: Partial<AgentTurnMessage> & { turnId: string; role: AgentTurnMessage['role'] }
): AgentTurnMessage {
  msgCounter++;
  return {
    id: `msg-${msgCounter}`,
    text: overrides.text ?? `Message ${msgCounter}`,
    createdAt: Date.now() + msgCounter,
    ...overrides,
  };
}

function makeToolSuggestions(): ToolLimitSuggestion[] {
  return [
    { toolName: 'filesystem/read_file', currentSize: 200000, suggestedLimit: 50000 },
  ];
}

// --- Tests ---

describe('buildEnhancedPromptWithWindow', () => {
  beforeEach(() => {
    msgCounter = 0;
  });

  it('includes COMPACTION_DEPTH marker', () => {
    const result = buildEnhancedPromptWithWindow(
      'Original prompt',
      'Summary of older context',
      [],
      1,
      []
    );

    expect(result).toContain('[COMPACTION_DEPTH:1]');
  });

  it('includes correct depth for depth 2', () => {
    const result = buildEnhancedPromptWithWindow(
      'Original prompt',
      'Summary',
      [],
      2,
      []
    );

    expect(result).toContain('[COMPACTION_DEPTH:2]');
  });

  it('includes OLDER CONTEXT section when summary is present', () => {
    const result = buildEnhancedPromptWithWindow(
      'Original prompt',
      'This is the older context summary',
      [],
      1,
      []
    );

    expect(result).toContain('--- OLDER CONTEXT (COMPRESSED) ---');
    expect(result).toContain('This is the older context summary');
  });

  it('skips OLDER CONTEXT section when summary is empty', () => {
    const result = buildEnhancedPromptWithWindow(
      'Original prompt',
      '',
      [],
      1,
      []
    );

    expect(result).not.toContain('--- OLDER CONTEXT (COMPRESSED) ---');
  });

  it('skips OLDER CONTEXT section when summary is whitespace-only', () => {
    const result = buildEnhancedPromptWithWindow(
      'Original prompt',
      '   \n\n  ',
      [],
      1,
      []
    );

    expect(result).not.toContain('--- OLDER CONTEXT (COMPRESSED) ---');
  });

  it('includes RECENT CONTEXT with formatted messages', () => {
    const recentMessages = [
      makeMessage({ turnId: 'turn-1', role: 'user', text: 'What is the weather?' }),
      makeMessage({ turnId: 'turn-1', role: 'assistant', text: 'The weather is sunny.' }),
    ];

    const result = buildEnhancedPromptWithWindow(
      'Continue discussion',
      'Earlier context',
      recentMessages,
      1,
      []
    );

    expect(result).toContain('--- RECENT CONTEXT (VERBATIM) ---');
    expect(result).toContain('User: What is the weather?');
    expect(result).toContain('Assistant: The weather is sunny.');
  });

  it('labels result messages correctly', () => {
    const recentMessages = [
      makeMessage({ turnId: 'turn-1', role: 'result', text: 'Tool result output' }),
    ];

    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      '',
      recentMessages,
      1,
      []
    );

    expect(result).toContain('Result: Tool result output');
  });

  it('skips RECENT CONTEXT section when no recent messages', () => {
    const result = buildEnhancedPromptWithWindow(
      'Original prompt',
      'Summary only',
      [],
      1,
      []
    );

    expect(result).not.toContain('--- RECENT CONTEXT (VERBATIM) ---');
  });

  it('includes tool guidance when suggestions are provided', () => {
    const suggestions = makeToolSuggestions();

    const result = buildEnhancedPromptWithWindow(
      'Original prompt',
      'Summary',
      [],
      1,
      suggestions
    );

    expect(result).toContain('filesystem/read_file');
    expect(result).toContain('max_output_chars');
    expect(result).toContain('50000');
  });

  it('uses IMPORTANT severity at depth 1', () => {
    const suggestions = makeToolSuggestions();

    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      'Summary',
      [],
      1,
      suggestions
    );

    expect(result).toContain('IMPORTANT:');
  });

  it('uses CRITICAL severity at depth 2', () => {
    const suggestions = makeToolSuggestions();

    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      'Summary',
      [],
      2,
      suggestions
    );

    expect(result).toContain('CRITICAL:');
  });

  it('includes generic fallback guidance when no tool suggestions', () => {
    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      'Summary',
      [],
      1,
      []
    );

    expect(result).toContain('max_output_chars');
    expect(result).toContain('100000');
  });

  it('uses stricter fallback limit at depth 2 with no suggestions', () => {
    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      'Summary',
      [],
      2,
      []
    );

    expect(result).toContain('50000');
    expect(result).toContain('CRITICAL');
  });

  it('strips @model: references from original prompt', () => {
    const result = buildEnhancedPromptWithWindow(
      'Ask @model:`GPT-5.2` to review this code',
      'Summary',
      [],
      1,
      []
    );

    expect(result).not.toContain('@model:');
    expect(result).not.toContain('GPT-5.2');
    expect(result).toContain('to review this code');
  });

  it('strips @model: references from summary', () => {
    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      'Previously asked @model:gemini-3-pro for help',
      [],
      1,
      []
    );

    expect(result).not.toContain('@model:gemini-3-pro');
    expect(result).toContain('Previously asked');
  });

  it('strips @model: references from recent messages', () => {
    const recentMessages = [
      makeMessage({
        turnId: 'turn-1',
        role: 'user',
        text: 'Use @model:`OpenAI / GPT-5.2` for analysis',
      }),
    ];

    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      '',
      recentMessages,
      1,
      []
    );

    expect(result).not.toContain('@model:');
    expect(result).toContain('for analysis');
  });

  it('strips existing COMPACTION_DEPTH markers from original prompt', () => {
    const result = buildEnhancedPromptWithWindow(
      '[COMPACTION_DEPTH:1] Original prompt text',
      'Summary',
      [],
      2,
      []
    );

    // Should have only the new depth marker, not the old one
    const depthMatches = result.match(/\[COMPACTION_DEPTH:\d+\]/g) || [];
    expect(depthMatches).toHaveLength(1);
    expect(depthMatches[0]).toBe('[COMPACTION_DEPTH:2]');
  });

  it('includes CONTINUE WITH REQUEST section with cleaned prompt', () => {
    const result = buildEnhancedPromptWithWindow(
      'Please summarize the report',
      'Summary',
      [],
      1,
      []
    );

    expect(result).toContain('=== CONTINUE WITH REQUEST ===');
    expect(result).toContain('Please summarize the report');
  });

  it('includes CONVERSATION CONTEXT header', () => {
    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      'Summary',
      [],
      1,
      []
    );

    expect(result).toContain('=== CONVERSATION CONTEXT ===');
  });

  it('produces well-ordered sections', () => {
    const recentMessages = [
      makeMessage({ turnId: 'turn-1', role: 'user', text: 'Recent message' }),
    ];

    const result = buildEnhancedPromptWithWindow(
      'My prompt',
      'Older summary',
      recentMessages,
      1,
      makeToolSuggestions()
    );

    const depthIdx = result.indexOf('[COMPACTION_DEPTH:1]');
    const contextIdx = result.indexOf('=== CONVERSATION CONTEXT ===');
    const olderIdx = result.indexOf('--- OLDER CONTEXT (COMPRESSED) ---');
    const recentIdx = result.indexOf('--- RECENT CONTEXT (VERBATIM) ---');
    const continueIdx = result.indexOf('=== CONTINUE WITH REQUEST ===');

    expect(depthIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(olderIdx);
    expect(olderIdx).toBeLessThan(recentIdx);
    expect(recentIdx).toBeLessThan(continueIdx);
  });

  it('includes break-into-smaller-steps guidance at depth >= 2 with tool suggestions', () => {
    const result = buildEnhancedPromptWithWindow(
      'Prompt',
      'Summary',
      [],
      2,
      makeToolSuggestions()
    );

    expect(result).toContain('break it into smaller steps');
  });

  it('strips <conversation_history> blocks from original prompt in windowed builder', () => {
    const result = buildEnhancedPromptWithWindow(
      'Before\n<conversation_history>REMOVE THIS HISTORY</conversation_history>\nAfter',
      'Summary',
      [],
      1,
      []
    );

    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('<conversation_history>');
    expect(result).not.toContain('REMOVE THIS HISTORY');
  });

  it('strips <conversation_history> blocks from original prompt in legacy builder', () => {
    const result = buildEnhancedPrompt(
      'Request start\n<conversation_history>SHOULD NOT APPEAR</conversation_history>\nRequest end',
      'Summary',
      1,
      []
    );

    expect(result).toContain('Request start');
    expect(result).toContain('Request end');
    expect(result).not.toContain('<conversation_history>');
    expect(result).not.toContain('SHOULD NOT APPEAR');
  });

  it('strips multiple conversation_history blocks from nested retry payload text', () => {
    const result = buildEnhancedPromptWithWindow(
      [
        'Top',
        '<conversation_history>FIRST BLOCK</conversation_history>',
        'Middle',
        '[COMPACTION_DEPTH:1]',
        '=== CONTINUE WITH REQUEST ===',
        '<conversation_history>SECOND BLOCK</conversation_history>',
        'Bottom'
      ].join('\n'),
      '',
      [],
      2,
      []
    );

    expect(result).toContain('Top');
    expect(result).toContain('Middle');
    expect(result).toContain('Bottom');
    expect(result).not.toContain('FIRST BLOCK');
    expect(result).not.toContain('SECOND BLOCK');
    expect(result).not.toContain('<conversation_history>');
  });

  it('strips <user-request> and <suggested-skills> blocks from original prompt', () => {
    const result = buildEnhancedPromptWithWindow(
      [
        'Keep me',
        '<user-request>REMOVE REQUEST WRAPPER</user-request>',
        '<suggested-skills>REMOVE SKILLS WRAPPER</suggested-skills>',
        'Keep me too'
      ].join('\n'),
      '',
      [],
      1,
      []
    );

    expect(result).toContain('Keep me');
    expect(result).toContain('Keep me too');
    expect(result).not.toContain('<user-request>');
    expect(result).not.toContain('<suggested-skills>');
    expect(result).not.toContain('REMOVE REQUEST WRAPPER');
    expect(result).not.toContain('REMOVE SKILLS WRAPPER');
  });
});
