import { afterEach, describe, expect, it, vi } from 'vitest';
import { testRecallApiKey } from '../recallApiKeyTester';

describe('testRecallApiKey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success for a valid Recall API key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ next: null, previous: null, results: [] }), { status: 200 })
    );

    const result = await testRecallApiKey(' rk_live_valid ');

    expect(result).toEqual({
      success: true,
      message: 'Connected. New recordings will go straight to your Recall account.',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://us-west-2.recall.ai/api/v1/sdk_upload/',
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: 'Token rk_live_valid',
        },
      }
    );
  });

  it('returns a recoverable error for an invalid Recall API key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );

    const result = await testRecallApiKey('rk_live_invalid');

    expect(result).toEqual({
      success: false,
      recoverable: true,
      error: 'That key did not work. Recall rejected it, so nothing was saved. Check you copied the whole key from your Recall dashboard, then try again.',
    });
  });
});
