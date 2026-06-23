import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
const mockComposeCommunitySharePost = vi.fn();
const mockStorePreview = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('../../services/communityShareService', () => ({
  composeCommunitySharePost: (...args: unknown[]) => mockComposeCommunitySharePost(...args),
  buildDiscourseNewTopicUrl: vi.fn(() => 'https://rebels.mindstone.com/new-topic'),
}));

vi.mock('../../services/communityShareStore', () => ({
  getEligibility: vi.fn(),
  storePreview: (...args: unknown[]) => mockStorePreview(...args),
  getPreview: vi.fn(),
  dismissEligibility: vi.fn(),
  setOptedOut: vi.fn(),
  clearSessionData: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('@core/lazyElectron', () => ({
  getElectronModule: vi.fn(() => null),
}));

import { registerCommunityHandlers } from '../communityHandlers';

describe('communityHandlers compose-share-post', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    mockComposeCommunitySharePost.mockReset();
    mockStorePreview.mockReset();

    registerCommunityHandlers({
      getCommunityHighlightsService: () => ({ getState: vi.fn() } as any),
      getSettings: () => ({}) as any,
      getSession: vi.fn(async () => ({ id: 'session-1', messages: [] } as any)),
    });
  });

  it('forwards structured community share errors from the core service', async () => {
    // Stage 6b: the core communityShareService now produces subtype+provider-aware copy.
    // This test only verifies the IPC handler forwards whatever the core service returns;
    // updated mock data keeps it aligned with the real post-migration output.
    mockComposeCommunitySharePost.mockResolvedValue({
      success: false,
      error:
        'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
      errorKind: 'billing',
    });

    const handler = registeredHandlers.get('community:compose-share-post');
    const result = await handler?.({}, { sessionId: 'session-1' });

    expect(result).toEqual({
      preview: null,
      error:
        'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
      errorKind: 'billing',
    });
    expect(mockStorePreview).not.toHaveBeenCalled();
  });
});
