import { describe, expect, it } from 'vitest';
import { createAgentMessageAdapter } from '../agentMessageAdapter';

describe('RebelCoreAgentMessageAdapter status events', () => {
  it('maps status events to system/status agent messages with copy preserved', () => {
    const adapter = createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: [],
      sessionId: 'test-session-id',
      cwd: '/tmp',
    });

    const messages = adapter.handleEvent({
      type: 'status',
      message: 'Taking a breather. Back in a moment.',
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'system',
      subtype: 'status',
      status: null,
      session_id: 'test-session-id',
      message: 'Taking a breather. Back in a moment.',
    });
  });
});
