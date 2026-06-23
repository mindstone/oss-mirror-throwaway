import { describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  redact,
  DEFAULT_REDACTED_KEYS,
} from '../../src/lib/logger';

describe('redact', () => {
  it('redacts known-secret keys case-insensitively', () => {
    const scrubbed = redact({
      clientId: 'abc',
      token: 'supersecret',
      Authorization: 'Bearer mysecretvaluethatistrulylong',
      Code: '123456',
      inner: { pairCode: '9999' },
    }) as Record<string, unknown>;
    expect(scrubbed.clientId).toBe('abc');
    expect(scrubbed.token).toBe('[redacted]');
    expect(scrubbed.Authorization).toBe('[redacted]');
    expect(scrubbed.Code).toBe('[redacted]');
    expect((scrubbed.inner as Record<string, unknown>).pairCode).toBe('[redacted]');
  });

  it('redacts JWT-like strings and Bearer tokens inside raw strings', () => {
    const out = redact(
      'Got token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload1234.signature5678',
    );
    expect(out).toEqual(expect.stringContaining('[redacted]'));
    const out2 = redact('Authorization: Bearer abcdefghijklmnop12345');
    expect(out2).toEqual(expect.stringContaining('[redacted]'));
  });

  it('handles arrays and primitives without mutating them', () => {
    const input = [1, 'two', { token: 'x' }];
    const out = redact(input) as unknown[];
    expect(out[0]).toBe(1);
    expect(out[1]).toBe('two');
    expect((out[2] as Record<string, unknown>).token).toBe('[redacted]');
    // original untouched
    expect((input[2] as { token: string }).token).toBe('x');
  });

  it('caps recursion depth to avoid hangs on cyclic graphs', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const scrubbed = redact(a);
    expect(scrubbed).toBeDefined();
  });
});

describe('createLogger', () => {
  it('forwards to the provided backend with the prefix', () => {
    const backend = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const log = createLogger({ prefix: '[test]', backend });
    log.info('hello', { clientId: 'abc', token: 'secretvaluethatislong' });
    expect(backend.info).toHaveBeenCalledOnce();
    const call = backend.info.mock.calls[0];
    if (!call) throw new Error('expected at least one call');
    expect(call[0]).toBe('[rebel][test] INFO');
    expect(call[1]).toBe('hello');
    expect(call[2]).toEqual({ clientId: 'abc', token: '[redacted]' });
  });

  it('default secret keys include token, code, password', () => {
    const list = DEFAULT_REDACTED_KEYS.map((k) => k.toLowerCase());
    expect(list).toContain('token');
    expect(list).toContain('code');
    expect(list).toContain('password');
  });
});
