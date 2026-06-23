import { configure, clearConfig, isConfigured, checkHealth, CloudClientError } from '@rebel/cloud-client';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

afterEach(() => {
  clearConfig();
  mockFetch.mockReset();
});

describe('cloudClient', () => {
  describe('configure/clearConfig/isConfigured', () => {
    it('starts unconfigured', () => {
      expect(isConfigured()).toBe(false);
    });

    it('configures with URL and token', () => {
      configure({ cloudUrl: 'https://test.fly.dev', token: 'tok123' });
      expect(isConfigured()).toBe(true);
    });

    it('clears config', () => {
      configure({ cloudUrl: 'https://test.fly.dev', token: 'tok123' });
      clearConfig();
      expect(isConfigured()).toBe(false);
    });

    it('normalizes trailing slash', () => {
      configure({ cloudUrl: 'https://test.fly.dev/', token: 'tok123' });
      expect(isConfigured()).toBe(true);
    });
  });

  describe('checkHealth', () => {
    it('throws when not configured', async () => {
      await expect(checkHealth()).rejects.toThrow('not configured');
    });

    it('returns health data on success', async () => {
      configure({ cloudUrl: 'https://test.fly.dev', token: 'tok' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', version: '1.0.0' }),
      });
      const result = await checkHealth();
      expect(result).toEqual({ status: 'ok', version: '1.0.0' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.fly.dev/api/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('throws on HTTP error', async () => {
      configure({ cloudUrl: 'https://test.fly.dev', token: 'tok' });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(checkHealth()).rejects.toThrow('Health check failed');
    });
  });
});
