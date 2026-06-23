/**
 * cloudClient 401 interceptor tests.
 */

import { configure, clearConfig, onUnauthorized, getSessions, CloudClientError } from '../cloudClient';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

afterEach(() => {
  clearConfig();
  mockFetch.mockReset();
  // Reset the callback by setting a no-op
  onUnauthorized(() => {});
});

describe('cloudClient 401 interceptor', () => {
  it('calls onUnauthorized callback on 401', async () => {
    configure({ cloudUrl: 'https://test.fly.dev', token: 'expired-tok' });
    const callback = vi.fn();
    onUnauthorized(callback);

    mockFetch.mockResolvedValueOnce({
      status: 401,
      ok: false,
      text: async () => 'Unauthorized',
    });

    await expect(getSessions()).rejects.toThrow('Unauthorized');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not call onUnauthorized on other errors', async () => {
    configure({ cloudUrl: 'https://test.fly.dev', token: 'tok' });
    const callback = vi.fn();
    onUnauthorized(callback);

    mockFetch.mockResolvedValueOnce({
      status: 500,
      ok: false,
      text: async () => 'Server Error',
    });

    await expect(getSessions()).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not call onUnauthorized for successful requests', async () => {
    configure({ cloudUrl: 'https://test.fly.dev', token: 'tok' });
    const callback = vi.fn();
    onUnauthorized(callback);

    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => [],
    });

    await getSessions();

    expect(callback).not.toHaveBeenCalled();
  });
});
