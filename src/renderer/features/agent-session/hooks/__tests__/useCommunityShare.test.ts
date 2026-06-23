// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSharePost } from '../useCommunityShare';

describe('composeSharePost', () => {
  let composeSharePostMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    composeSharePostMock = vi.fn();
    (window as { api?: unknown }).api = {
      composeSharePost: composeSharePostMock,
    };
  });

  it('throws the structured renderer-facing error when preview composition fails', async () => {
    composeSharePostMock.mockResolvedValue({
      preview: null,
      error:
        "Your API account needs billing attention. Add credits at your provider's console. If you're using OpenRouter, you can also set up auto top-up to avoid running out.",
      errorKind: 'billing',
    });

    await expect(composeSharePost('session-1')).rejects.toThrow(
      "Your API account needs billing attention. Add credits at your provider's console. If you're using OpenRouter, you can also set up auto top-up to avoid running out.",
    );
  });
});
