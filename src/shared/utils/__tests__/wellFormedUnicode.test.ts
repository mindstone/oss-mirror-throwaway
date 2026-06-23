import { describe, expect, it } from 'vitest';
import {
  ensureWellFormedDeep,
  ensureWellFormedString,
  summarizeWellFormedReplacementPaths,
  truncateWellFormed,
} from '../wellFormedUnicode';

describe('wellFormedUnicode', () => {
  it('manual fallback matches native toWellFormed output', () => {
    const input = 'ok\uD83Dbad\uDC00tail😀';

    const nativePath = ensureWellFormedString(input);
    const fallbackPath = ensureWellFormedString(input, { forceFallback: true });

    expect(fallbackPath.value).toBe(nativePath.value);
    expect(fallbackPath.replacementCount).toBe(nativePath.replacementCount);
  });

  it('truncateWellFormed avoids splitting surrogate pairs', () => {
    const input = `${'a'.repeat(118)}😀tail`;
    const truncated = truncateWellFormed(input, 119);

    expect(truncated).toBe('a'.repeat(118));
    expect(truncated).not.toContain('\uFFFD');
  });

  it('truncateWellFormed keeps a pre-existing lone trailing surrogate at the cut', () => {
    const input = `ab\uDC00tail`;
    const truncated = truncateWellFormed(input, 3);

    expect(truncated).toBe('ab\uDC00');
  });

  it('ensureWellFormedDeep handles cycles and reports touched paths', () => {
    const cyclic: Record<string, unknown> = { message: 'bad:\uD83D' };
    cyclic.self = cyclic;

    const normalized = ensureWellFormedDeep(cyclic, { forceFallback: true });
    const normalizedObj = normalized.value as Record<string, unknown>;

    expect(normalized.replacementCount).toBe(1);
    expect(normalized.replacementPaths).toEqual(['message']);
    expect(normalizedObj.self).toBe(normalizedObj);
    expect(normalizedObj.message).toBe('bad:\uFFFD');
  });

  it('returns the original object identity when no replacements are needed', () => {
    const clean = {
      message: 'clean',
      nested: { locale: '日本語', emoji: '😀😀', combining: 'e\u0301' },
      sdkProcessingMetadata: { request: { headers: { 'x-test': 'value' } } },
    };

    const result = ensureWellFormedDeep(clean);
    expect(result.value).toBe(clean);
    expect(result.replacementCount).toBe(0);
    expect(result.replacementPaths).toEqual([]);
  });

  it('normalizes object keys and resolves key collisions deterministically (last-write-wins)', () => {
    const input = {
      '\uD83D': 'first',
      '\uFFFD': 'second',
      nested: {
        '\uD83D': 'nested-first',
        '\uFFFD': 'nested-second',
      },
    };

    const result = ensureWellFormedDeep(input);
    const normalizedRoot = result.value as Record<string, unknown>;
    const normalizedNested = normalizedRoot.nested as Record<string, unknown>;

    expect(result.replacementCount).toBe(2);
    expect(result.replacementPaths).toEqual(['<dynamic>', 'nested.<dynamic>']);
    expect(normalizedRoot['\uFFFD']).toBe('second');
    expect(Object.keys(normalizedRoot).filter((key) => key === '\uFFFD')).toHaveLength(1);
    expect(normalizedNested['\uFFFD']).toBe('nested-second');
    expect(Object.keys(normalizedNested).filter((key) => key === '\uFFFD')).toHaveLength(1);
  });

  it('preserves well-formed multilingual/emoji strings and only replaces the hostile code unit', () => {
    const hostile = 'prefix\uD83Dsuffix';
    const input = {
      cjk: '東京の会議メモ',
      astral: '😀🧠🚀',
      combining: 'Cafe\u0301 notes',
      hostile,
    };

    const result = ensureWellFormedDeep(input, { forceFallback: true });
    const normalized = result.value as typeof input;

    expect(normalized.cjk).toBe(input.cjk);
    expect(normalized.astral).toBe(input.astral);
    expect(normalized.combining).toBe(input.combining);
    expect(normalized.hostile).toBe('prefix\uFFFDsuffix');
    expect(normalized.hostile.length).toBe(hostile.length);
    expect(result.replacementCount).toBe(1);
    expect(result.replacementPaths).toEqual(['hostile']);
  });

  it('skips sdkProcessingMetadata at the event root (no scan, no clone)', () => {
    const metadata = { nested: { value: '\uD83D' } };
    const event = {
      message: 'bad:\uD83D',
      sdkProcessingMetadata: metadata,
    };

    const result = ensureWellFormedDeep(event, { forceFallback: true });
    const normalizedEvent = result.value as Record<string, unknown>;

    expect(result.replacementCount).toBe(1);
    expect(result.replacementPaths).toEqual(['message']);
    expect(normalizedEvent.sdkProcessingMetadata).toBe(metadata);
  });

  it('leaves values beyond depth cap untouched', () => {
    const veryDeep = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  level7: {
                    level8: {
                      level9: {
                        level10: {
                          level11: {
                            level12: {
                              level13: {
                                level14: {
                                  level15: {
                                    level16: {
                                      level17: {
                                        level18: {
                                          level19: {
                                            level20: {
                                              level21: {
                                                hostile: '\uD83D',
                                              },
                                            },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = ensureWellFormedDeep(veryDeep, { forceFallback: true });
    expect(result.replacementCount).toBe(0);
    expect(result.value).toBe(veryDeep);
  });

  it('caps and sanitizes replacement paths for telemetry logging', () => {
    const summary = summarizeWellFormedReplacementPaths([
      'message',
      'extra.nested.detail',
      'extra.bad key.path',
      'breadcrumbs[0].data.detail',
      ...Array.from({ length: 20 }, (_, i) => `extra.segment_${i}`),
    ]);

    expect(summary.replacementPaths).toHaveLength(10);
    expect(summary.replacementPaths).toContain('message');
    expect(summary.replacementPaths).toContain('extra.nested.detail');
    expect(summary.replacementPaths).toContain('extra.<dynamic>.path');
    expect(summary.replacementPaths).toContain('breadcrumbs.<dynamic>.data.detail');
    expect(summary.omittedPathCount).toBeGreaterThan(0);
  });
});
