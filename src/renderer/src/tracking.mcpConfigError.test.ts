import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  captureRendererMessage: vi.fn(),
}));

vi.mock('./analytics', () => ({
  analytics: {
    track: mocks.track,
  },
}));

vi.mock('./sentry', () => ({
  captureRendererMessage: mocks.captureRendererMessage,
}));

import { tracking } from './tracking';

describe('tracking.tools.mcpConfigError', () => {
  beforeEach(() => {
    mocks.track.mockClear();
    mocks.captureRendererMessage.mockClear();
  });

  it('suppresses renderer Sentry capture for the current Super-MCP unavailable message', () => {
    tracking.tools.mcpConfigError(
      'load_error',
      'Tools are temporarily unavailable. Open Settings → Advanced and click "Restart Super-MCP" — if it keeps failing, restart Rebel and use Safe Mode to troubleshoot.',
    );

    expect(mocks.track).toHaveBeenCalledWith('MCP Config Error', {
      errorType: 'load_error',
      errorCode: expect.stringContaining('Tools are temporarily unavailable'),
    });
    expect(mocks.captureRendererMessage).not.toHaveBeenCalled();
  });

  it('keeps suppressing renderer Sentry capture for old cached Super-MCP unavailable messages', () => {
    tracking.tools.mcpConfigError(
      'load_error',
      'Super-MCP HTTP server is not running. Tools will not be available.',
    );

    expect(mocks.captureRendererMessage).not.toHaveBeenCalled();
  });

  it('captures other MCP config load errors in renderer Sentry', () => {
    tracking.tools.mcpConfigError('load_error', 'Malformed MCP configuration');

    expect(mocks.captureRendererMessage).toHaveBeenCalledWith('MCP Config Error', {
      level: 'warning',
      tags: { errorType: 'load_error', errorCode: 'Malformed MCP configuration' },
    });
  });
});
