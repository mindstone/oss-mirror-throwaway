import { describe, expect, it } from 'vitest';
import { createAgentMessageAdapter } from '../agentMessageAdapter';

describe('RebelCoreAgentMessageAdapter handleSubAgentEvent', () => {
  const makeAdapter = () =>
    createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['Read', 'Bash', 'Agent'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

  const parentToolUseId = 'parent-tu-123';

  describe('tool_use:start events', () => {
    it('produces assistant-type AgentMessage with tool_use content block', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        {
          type: 'tool_use:start',
          toolUseId: 'child-tu-1',
          toolName: 'Read',
          input: { file_path: '/tmp/test.txt' },
        },
        parentToolUseId,
      );

      expect(messages).toHaveLength(1);
      const msg = messages[0] as Record<string, unknown>;
      expect(msg.type).toBe('assistant');
      expect(msg.parent_tool_use_id).toBe(parentToolUseId);
      expect(msg.session_id).toBe('test-session');
      expect(msg.uuid).toBeDefined();

      const content = (msg.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('tool_use');
      expect(content[0].id).toBe('child-tu-1');
      expect(content[0].name).toBe('Read');
      expect(content[0].input).toEqual({ file_path: '/tmp/test.txt' });
    });
  });

  describe('tool_use:result events', () => {
    it('produces user-type AgentMessage with tool_result content block', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        {
          type: 'tool_use:result',
          toolUseId: 'child-tu-1',
          output: 'file contents here',
          isError: false,
        },
        parentToolUseId,
      );

      expect(messages).toHaveLength(1);
      const msg = messages[0] as Record<string, unknown>;
      expect(msg.type).toBe('user');
      expect(msg.parent_tool_use_id).toBe(parentToolUseId);
      expect(msg.session_id).toBe('test-session');
      expect(msg.uuid).toBeDefined();

      const messageObj = msg.message as Record<string, unknown>;
      expect(messageObj.role).toBe('user');
      const content = messageObj.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('tool_result');
      expect(content[0].tool_use_id).toBe('child-tu-1');
      expect(content[0].content).toBe('file contents here');
      expect(content[0].is_error).toBe(false);
    });

    it('sets is_error correctly for error results', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        {
          type: 'tool_use:result',
          toolUseId: 'child-tu-2',
          output: 'Permission denied',
          isError: true,
        },
        parentToolUseId,
      );

      const content = ((messages[0] as Record<string, unknown>).message as Record<string, unknown>).content as Array<Record<string, unknown>>;
      expect(content[0].is_error).toBe(true);
      expect(content[0].content).toBe('Permission denied');
    });
  });

  describe('unhandled event types return empty array', () => {
    it('returns [] for assistant:text', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        { type: 'assistant:text', text: 'Hello' },
        parentToolUseId,
      );
      expect(messages).toEqual([]);
    });

    it('returns [] for status', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        { type: 'status', message: 'Working...' },
        parentToolUseId,
      );
      expect(messages).toEqual([]);
    });

    it('returns [] for turn:complete', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        {
          type: 'turn:complete',
          usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
          stopReason: 'end_turn',
        },
        parentToolUseId,
      );
      expect(messages).toEqual([]);
    });

    it('returns [] for turn:error', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        { type: 'turn:error', error: new Error('boom') },
        parentToolUseId,
      );
      expect(messages).toEqual([]);
    });

    it('returns [] for loop:complete', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        {
          type: 'loop:complete',
          totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        },
        parentToolUseId,
      );
      expect(messages).toEqual([]);
    });

    it('returns [] for warning', () => {
      const adapter = makeAdapter();
      const messages = adapter.handleSubAgentEvent(
        { type: 'warning', category: 'mcp', message: 'MCP issue' },
        parentToolUseId,
      );
      expect(messages).toEqual([]);
    });
  });

  describe('state isolation', () => {
    it('does NOT mutate accumulatedText', () => {
      const adapter = makeAdapter();

      // Accumulate some text via normal handleEvent
      adapter.handleEvent({ type: 'assistant:text', text: 'Parent response' });

      // Process sub-agent events via handleSubAgentEvent
      adapter.handleSubAgentEvent(
        { type: 'tool_use:start', toolUseId: 'child-tu-1', toolName: 'Read', input: {} },
        parentToolUseId,
      );
      adapter.handleSubAgentEvent(
        { type: 'tool_use:result', toolUseId: 'child-tu-1', output: 'file data', isError: false },
        parentToolUseId,
      );

      // Finalize — accumulatedText should only contain parent text
      const results = adapter.handleEvent({
        type: 'loop:complete',
        totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      });

      const resultMessage = results.find((m) => m.type === 'result');
      expect((resultMessage as Record<string, unknown>).result).toBe('Parent response');
    });

    it('does NOT mutate turns count', () => {
      const adapter = makeAdapter();

      // Complete one parent turn
      adapter.handleEvent({
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end_turn',
      });

      // Sub-agent events should not increment turns
      adapter.handleSubAgentEvent(
        { type: 'tool_use:start', toolUseId: 'child-tu-1', toolName: 'Bash', input: {} },
        parentToolUseId,
      );

      // Finalize
      const results = adapter.handleEvent({
        type: 'loop:complete',
        totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      });

      const resultMessage = results.find((m) => m.type === 'result');
      expect((resultMessage as Record<string, unknown>).num_turns).toBe(1);
    });

    it('does NOT mutate usage tracking', () => {
      const adapter = makeAdapter();

      // Record parent usage
      adapter.handleEvent({
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 5 },
        stopReason: 'end_turn',
      });

      // Sub-agent events should not affect usage
      adapter.handleSubAgentEvent(
        { type: 'tool_use:start', toolUseId: 'child-tu-1', toolName: 'Read', input: {} },
        parentToolUseId,
      );

      // Finalize
      const results = adapter.handleEvent({
        type: 'loop:complete',
        totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 5 },
      });

      const resultMessage = results.find((m) => m.type === 'result') as Record<string, unknown>;
      const usage = resultMessage.usage as Record<string, number>;
      expect(usage.input_tokens).toBe(100);
      expect(usage.output_tokens).toBe(50);
    });
  });

  describe('unique UUIDs', () => {
    it('generates unique UUIDs for each message', () => {
      const adapter = makeAdapter();
      const msg1 = adapter.handleSubAgentEvent(
        { type: 'tool_use:start', toolUseId: 'tu-1', toolName: 'Read', input: {} },
        parentToolUseId,
      );
      const msg2 = adapter.handleSubAgentEvent(
        { type: 'tool_use:start', toolUseId: 'tu-2', toolName: 'Bash', input: {} },
        parentToolUseId,
      );

      expect((msg1[0] as Record<string, unknown>).uuid).not.toBe(
        (msg2[0] as Record<string, unknown>).uuid,
      );
    });
  });

  describe('mergeSubAgentUsage', () => {
    it('adds to usageByModel under sub-agent model key and appears in buildModelUsage()', () => {
      const adapter = makeAdapter();
      
      // Simulate parent turn
      adapter.handleEvent({
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end_turn',
      });
      
      // Merge sub-agent usage
      adapter.mergeSubAgentUsage('claude-haiku-4-20250414', {
        inputTokens: 500,
        outputTokens: 200,
        cacheCreationTokens: 10,
        cacheReadTokens: 5,
      });

      // Complete loop
      const results = adapter.handleEvent({
        type: 'loop:complete',
        totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      });

      const resultMessage = results.find((m) => m.type === 'result') as Record<string, unknown>;
      const modelUsage = resultMessage.modelUsage as Record<string, any>;
      
      expect(modelUsage['claude-sonnet-4-20250514']).toBeDefined();
      expect(modelUsage['claude-sonnet-4-20250514'].inputTokens).toBe(100);
      
      expect(modelUsage['claude-haiku-4-20250414']).toBeDefined();
      expect(modelUsage['claude-haiku-4-20250414'].inputTokens).toBe(500);
      expect(modelUsage['claude-haiku-4-20250414'].outputTokens).toBe(200);
      expect(modelUsage['claude-haiku-4-20250414'].cacheCreationInputTokens).toBe(10);
      expect(modelUsage['claude-haiku-4-20250414'].cacheReadInputTokens).toBe(5);
    });

    it('tracks multiple sub-agents with different models separately', () => {
      const adapter = makeAdapter();
      
      adapter.mergeSubAgentUsage('claude-haiku-4-20250414', {
        inputTokens: 500, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0,
      });
      
      adapter.mergeSubAgentUsage('claude-opus-4-7', {
        inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0,
      });

      const results = adapter.handleEvent({
        type: 'loop:complete',
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      });

      const modelUsage = (results.find((m) => m.type === 'result') as any).modelUsage;
      expect(modelUsage['claude-haiku-4-20250414'].inputTokens).toBe(500);
      expect(modelUsage['claude-opus-4-7'].inputTokens).toBe(1000);
    });

    it('merges correctly when sub-agent has same model as parent', () => {
      const adapter = makeAdapter();
      
      // Parent turn
      adapter.handleEvent({
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end_turn',
        model: 'claude-sonnet-4-20250514',
      });
      
      // Sub-agent with same model
      adapter.mergeSubAgentUsage('claude-sonnet-4-20250514', {
        inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0,
      });

      const results = adapter.handleEvent({
        type: 'loop:complete',
        totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      });

      const modelUsage = (results.find((m) => m.type === 'result') as any).modelUsage;
      expect(modelUsage['claude-sonnet-4-20250514'].inputTokens).toBe(300); // 100 + 200
      expect(modelUsage['claude-sonnet-4-20250514'].outputTokens).toBe(150); // 50 + 100
    });
  });
});
