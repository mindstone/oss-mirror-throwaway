import { beforeEach, describe, expect, it, vi } from 'vitest';

const useRebelEvent = vi.fn();

vi.mock('../useRebelEvent', () => ({
  useRebelEvent,
}));

describe('usePostTurnHook', () => {
  let usePostTurnHook: typeof import('../usePostTurnHook').usePostTurnHook;

  beforeEach(async () => {
    vi.resetModules();
    useRebelEvent.mockReset();
    ({ usePostTurnHook } = await import('../usePostTurnHook'));
  });

  it('subscribes to turn:completed events', () => {
    const callback = vi.fn();
    usePostTurnHook(callback);

    expect(useRebelEvent).toHaveBeenCalledTimes(1);
    expect(useRebelEvent).toHaveBeenCalledWith('turn:completed', expect.any(Function));
  });

  it('forwards valid payload with normalized toolsUsed', () => {
    const callback = vi.fn();
    usePostTurnHook(callback);

    const handler = useRebelEvent.mock.calls[0][1] as (payload: unknown) => void;
    handler({
      sessionId: 'session-1',
      turnId: 'turn-1',
      assistantText: 'Done.',
      toolsUsed: ['Read', 42, 'Edit', null],
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      assistantText: 'Done.',
      toolsUsed: ['Read', 'Edit'],
    });
  });

  it('defaults toolsUsed to an empty array when missing', () => {
    const callback = vi.fn();
    usePostTurnHook(callback);

    const handler = useRebelEvent.mock.calls[0][1] as (payload: unknown) => void;
    handler({
      sessionId: 'session-1',
      turnId: 'turn-1',
      assistantText: 'No tools used',
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      assistantText: 'No tools used',
      toolsUsed: [],
    });
  });

  it('ignores malformed payloads', () => {
    const callback = vi.fn();
    usePostTurnHook(callback);

    const handler = useRebelEvent.mock.calls[0][1] as (payload: unknown) => void;
    handler(null);
    handler({ turnId: 'turn-1', assistantText: 'missing session id', toolsUsed: [] });
    handler({ sessionId: 'session-1', assistantText: 'missing turn id', toolsUsed: [] });
    handler({ sessionId: 'session-1', turnId: 'turn-1', toolsUsed: [] });

    expect(callback).not.toHaveBeenCalled();
  });
});
