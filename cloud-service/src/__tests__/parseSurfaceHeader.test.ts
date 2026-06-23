import type http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { parseSurfaceHeader } from '../routes/sessions';

function makeReq(headers?: Record<string, string | undefined>): http.IncomingMessage {
  const mergedHeaders = Object.fromEntries(
    Object.entries({ host: 'localhost', ...(headers ?? {}) })
      .filter(([, value]) => value !== undefined),
  ) as Record<string, string>;

  return {
    method: 'PUT',
    url: '/api/sessions/session-1',
    headers: mergedHeaders,
  } as http.IncomingMessage;
}

describe('parseSurfaceHeader', () => {
  it.each([
    ['desktop', 'desktop'],
    ['mobile', 'mobile'],
    ['cloud', 'cloud'],
    ['cli', 'cli'],
    ['DeSkToP', 'desktop'],
  ] as const)('parses %s as %s', (raw, expected) => {
    expect(parseSurfaceHeader(makeReq({ 'x-rebel-surface': raw }))).toBe(expected);
  });

  it('maps missing headers to cloud-untagged and logs a warning', () => {
    const warn = vi.fn<(entry: Record<string, unknown>) => void>();

    const parsed = parseSurfaceHeader(makeReq(), warn);

    expect(parsed).toBe('cloud-untagged');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      msg: 'surface.untagged-request',
      path: '/api/sessions/session-1',
      method: 'PUT',
      rawHeader: undefined,
    }));
  });

  it('maps unknown headers to cloud-untagged and logs rawHeader', () => {
    const warn = vi.fn<(entry: Record<string, unknown>) => void>();

    const parsed = parseSurfaceHeader(makeReq({ 'x-rebel-surface': 'martian' }), warn);

    expect(parsed).toBe('cloud-untagged');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      msg: 'surface.untagged-request',
      rawHeader: 'martian',
    }));
  });
});
