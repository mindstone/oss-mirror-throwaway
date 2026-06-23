import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DETAIL_PARSE_BYTES, safeParseDetail } from '../safeParseDetail';

describe('safeParseDetail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses small valid JSON', () => {
    const result = safeParseDetail('{"path":"/tmp/x","n":1}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ path: '/tmp/x', n: 1 });
    }
  });

  it('parses valid JSON arrays and primitives', () => {
    expect(safeParseDetail('[1,2,3]')).toEqual({ ok: true, value: [1, 2, 3] });
    expect(safeParseDetail('"hello"')).toEqual({ ok: true, value: 'hello' });
    expect(safeParseDetail('42')).toEqual({ ok: true, value: 42 });
  });

  it('returns malformed for invalid JSON within budget', () => {
    expect(safeParseDetail('{not json}')).toEqual({ ok: false, reason: 'malformed' });
    expect(safeParseDetail('')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns too-large WITHOUT calling JSON.parse when over budget', () => {
    // Build a string just over the budget. It is also valid JSON so that a
    // (buggy) parse would succeed — proving the guard ran BEFORE parsing.
    const filler = 'a'.repeat(MAX_DETAIL_PARSE_BYTES);
    const huge = `{"data":"${filler}"}`; // length > MAX_DETAIL_PARSE_BYTES
    expect(huge.length).toBeGreaterThan(MAX_DETAIL_PARSE_BYTES);

    const parseSpy = vi.spyOn(JSON, 'parse');
    const result = safeParseDetail(huge);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('parses a string exactly at the budget boundary', () => {
    // A valid JSON string whose .length === MAX_DETAIL_PARSE_BYTES is allowed
    // (the guard rejects only length > budget).
    const innerLen = MAX_DETAIL_PARSE_BYTES - '{"d":""}'.length;
    const atLimit = `{"d":"${'b'.repeat(innerLen)}"}`;
    expect(atLimit.length).toBe(MAX_DETAIL_PARSE_BYTES);
    const result = safeParseDetail(atLimit);
    expect(result.ok).toBe(true);
  });

  it('throttles the too-large breadcrumb but still returns the result every time', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const huge = `"${'z'.repeat(MAX_DETAIL_PARSE_BYTES + 10)}"`;
    expect(huge.length).toBeGreaterThan(MAX_DETAIL_PARSE_BYTES);

    // Many calls in quick succession; every call must still return too-large.
    for (let i = 0; i < 5; i += 1) {
      expect(safeParseDetail(huge)).toEqual({ ok: false, reason: 'too-large' });
    }
    // Throttled: far fewer warns than calls (at most a couple within the window).
    expect(warnSpy.mock.calls.length).toBeLessThan(5);
  });
});
