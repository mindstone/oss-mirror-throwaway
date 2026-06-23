import { describe, expect, it, vi } from 'vitest';
import { MAX_DETAIL_PARSE_BYTES } from '../../../utils/safeParseDetail';
import { tryFormatDetail } from '../CompositionTab';

describe('CompositionTab.tryFormatDetail', () => {
  it('pretty-prints small valid JSON', () => {
    const out = tryFormatDetail('{"a":1,"b":"x"}');
    expect(out).toBe(JSON.stringify({ a: 1, b: 'x' }, null, 2));
  });

  it('returns empty string for empty detail', () => {
    expect(tryFormatDetail('')).toBe('');
  });

  it('returns the truncated display string for malformed small detail', () => {
    expect(tryFormatDetail('not json at all')).toBe('not json at all');
  });

  it('does NOT fully JSON.parse an over-budget detail (the dead-guard regression)', () => {
    // Valid JSON, but larger than the parse budget. The old code path
    // (`JSON.parse(truncated.length === detail.length ? detail : detail)`)
    // parsed the FULL string regardless of size — the OOM bug. The fix must
    // never call JSON.parse here.
    const filler = 'a'.repeat(MAX_DETAIL_PARSE_BYTES);
    const huge = `{"data":"${filler}"}`;
    expect(huge.length).toBeGreaterThan(MAX_DETAIL_PARSE_BYTES);

    const parseSpy = vi.spyOn(JSON, 'parse');
    const out = tryFormatDetail(huge);

    expect(parseSpy).not.toHaveBeenCalled();
    // Returns the truncated display string with a "[... total]" marker, not the
    // pretty-printed parse of the full payload.
    expect(out).toContain('... [');
    expect(out.length).toBeLessThan(huge.length);
    parseSpy.mockRestore();
  });
});
