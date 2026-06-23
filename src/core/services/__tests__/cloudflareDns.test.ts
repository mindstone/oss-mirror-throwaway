import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDnsRecord, deleteDnsRecord } from '../cloud/cloudflareDns';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function cfSuccess(result: Record<string, unknown>) {
  return { json: () => Promise.resolve({ success: true, result }) };
}

function cfError(code: number, message: string) {
  return { json: () => Promise.resolve({ success: false, errors: [{ code, message }] }), status: 400 };
}

describe('createDnsRecord', () => {
  it('creates an A record and returns the record ID', async () => {
    mockFetch.mockResolvedValueOnce(cfSuccess({ id: 'rec-123' }));

    const result = await createDnsRecord({
      zoneId: 'zone-1',
      apiToken: 'token-1',
      name: 'test.cloud.mindstone.com',
      ip: '1.2.3.4',
    });

    expect(result).toEqual({ success: true, recordId: 'rec-123' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      type: 'A',
      name: 'test.cloud.mindstone.com',
      content: '1.2.3.4',
      ttl: 60,
      proxied: false,
    });
  });

  it('includes comment when provided', async () => {
    mockFetch.mockResolvedValueOnce(cfSuccess({ id: 'rec-456' }));

    await createDnsRecord({
      zoneId: 'zone-1',
      apiToken: 'token-1',
      name: 'test.cloud',
      ip: '5.6.7.8',
      comment: 'auto-provisioned',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.comment).toBe('auto-provisioned');
  });

  it('returns error on Cloudflare failure', async () => {
    mockFetch.mockResolvedValueOnce(cfError(1004, 'DNS Validation Error'));

    const result = await createDnsRecord({
      zoneId: 'zone-1',
      apiToken: 'token-1',
      name: 'bad.cloud',
      ip: '0.0.0.0',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('DNS Validation Error');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await createDnsRecord({
      zoneId: 'zone-1',
      apiToken: 'token-1',
      name: 'test.cloud',
      ip: '1.2.3.4',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network timeout');
  });

  it('returns error when result has no id', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ success: true, result: {} }) });

    const result = await createDnsRecord({
      zoneId: 'zone-1',
      apiToken: 'token-1',
      name: 'test.cloud',
      ip: '1.2.3.4',
    });

    expect(result.success).toBe(false);
  });
});

describe('deleteDnsRecord', () => {
  it('deletes a record by ID', async () => {
    mockFetch.mockResolvedValueOnce(cfSuccess({ id: 'rec-123' }));

    const result = await deleteDnsRecord({
      zoneId: 'zone-1',
      apiToken: 'token-1',
      recordId: 'rec-123',
    });

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/rec-123',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
        }),
      }),
    );
  });

  it('returns error on Cloudflare failure', async () => {
    mockFetch.mockResolvedValueOnce(cfError(1032, 'Record not found'));

    const result = await deleteDnsRecord({
      zoneId: 'zone-1',
      apiToken: 'token-1',
      recordId: 'rec-missing',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Record not found');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await deleteDnsRecord({
      zoneId: 'zone-1',
      apiToken: 'token-1',
      recordId: 'rec-123',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
  });
});
