import { describe, it, expect } from 'vitest';
import {
  selectPlaudTranscriptSource,
  formatPlaudTranscriptFromSourceList,
  COMPLETE_COVERAGE_THRESHOLD,
  IMPLAUSIBLE_COVERAGE_THRESHOLD,
  MAX_RAW_SOURCE_LIST_LENGTH,
  NOT_READY_FALLBACK_GRACE_MS,
  type PlaudTranscriptSegment,
} from '../plaudTranscriptSelector';
import type { PlaudFile, PlaudFileDetails } from '../types';

const baseFile: PlaudFile = {
  id: 'file-1',
  name: 'meeting.mp3',
  created_at: '2026-05-24T10:00:00Z',
  serial_number: 'SN-1',
  start_at: '2026-05-24T10:00:00Z',
  duration: 120_000, // ms
};
const referenceNow = new Date('2026-05-24T10:30:00Z');

function makeDetails(sourceList: unknown[]): PlaudFileDetails {
  return {
    ...baseFile,
    presigned_url: 'https://example.com/audio.mp3',
    source_list: sourceList,
    note_list: [],
  };
}

describe('selectPlaudTranscriptSource', () => {
  it('returns fallback_local when source_list is empty', () => {
    const decision = selectPlaudTranscriptSource(makeDetails([]), baseFile, referenceNow);
    expect(decision.kind).toBe('fallback_local');
    if (decision.kind === 'fallback_local') {
      expect(decision.reason).toBe('plaud_source_list_absent');
    }
  });

  it('returns fallback_local when source_list is not an array', () => {
    const details = {
      ...baseFile,
      presigned_url: 'https://example.com/audio.mp3',
      source_list: 'not-an-array' as unknown as unknown[],
      note_list: [],
    };
    const decision = selectPlaudTranscriptSource(details, baseFile, referenceNow);
    expect(decision.kind).toBe('fallback_local');
  });

  it('returns invalid when segment shape fails Zod parse', () => {
    const decision = selectPlaudTranscriptSource(
      makeDetails([{ text: 42 }, { not_text: 'hi' }]),
      baseFile,
      referenceNow,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') {
      expect(decision.reason).toMatch(/^plaud_source_list_malformed:/);
    }
  });

  it('returns plaud_complete when timestamped segments cover the full duration', () => {
    const segments = [
      { text: 'Hello world.', start_time: 0, end_time: 60 },
      { text: 'Goodbye world.', start_time: 60, end_time: 120 },
    ];
    const decision = selectPlaudTranscriptSource(makeDetails(segments), baseFile, referenceNow);
    expect(decision.kind).toBe('plaud_complete');
    if (decision.kind === 'plaud_complete') {
      expect(decision.coverageRatio).toBeGreaterThanOrEqual(COMPLETE_COVERAGE_THRESHOLD);
      expect(decision.segments).toHaveLength(2);
    }
  });

  it('returns plaud_complete when coverage is plausible but above 1 due to overlap', () => {
    const segments = [
      { text: 'Speaker one.', start_time: 0, end_time: 80 },
      { text: 'Speaker two overlap.', start_time: 60, end_time: 124 },
    ]; // (80 + 64) / 120 = 1.2
    const decision = selectPlaudTranscriptSource(makeDetails(segments), baseFile, referenceNow);
    expect(decision.kind).toBe('plaud_complete');
    if (decision.kind === 'plaud_complete') {
      expect(decision.coverageRatio).toBeGreaterThan(1);
      expect(decision.coverageRatio).toBeLessThan(IMPLAUSIBLE_COVERAGE_THRESHOLD);
    }
  });

  it('returns invalid when coverage ratio is implausibly high (likely unit mismatch)', () => {
    const segments = [{ text: 'Tiny fragment with giant timestamp unit.', start_time: 0, end_time: 30_000 }];
    const decision = selectPlaudTranscriptSource(makeDetails(segments), baseFile, referenceNow);
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') {
      expect(decision.reason).toBe('plaud_coverage_implausible');
    }
  });

  it('returns not_ready for recent partial coverage within grace window', () => {
    const segments = [{ text: 'Hello world.', start_time: 0, end_time: 30 }]; // 30s of 120s
    const decision = selectPlaudTranscriptSource(makeDetails(segments), baseFile, referenceNow);
    expect(decision.kind).toBe('not_ready');
    if (decision.kind === 'not_ready') {
      expect(decision.coverageRatio).toBeLessThan(COMPLETE_COVERAGE_THRESHOLD);
      expect(decision.reason).toBe('plaud_coverage_below_threshold');
    }
  });

  it('returns fallback_local for partial coverage older than grace window', () => {
    const segments = [{ text: 'Hello world.', start_time: 0, end_time: 30 }];
    const oldNow = new Date(referenceNow.getTime() + NOT_READY_FALLBACK_GRACE_MS + 1);
    const decision = selectPlaudTranscriptSource(makeDetails(segments), baseFile, oldNow);
    expect(decision.kind).toBe('fallback_local');
    if (decision.kind === 'fallback_local') {
      expect(decision.reason).toBe('plaud_not_ready_grace_elapsed');
    }
  });

  it('returns fallback_local when created_at is missing/invalid for partial coverage', () => {
    const segments = [{ text: 'Hello world.', start_time: 0, end_time: 30 }];
    const fileWithoutCreatedAt: PlaudFile = {
      ...baseFile,
      created_at: '',
    };
    const decision = selectPlaudTranscriptSource(
      makeDetails(segments),
      fileWithoutCreatedAt,
      referenceNow,
    );
    expect(decision.kind).toBe('fallback_local');
    if (decision.kind === 'fallback_local') {
      expect(decision.reason).toBe('plaud_not_ready_missing_created_at');
    }
  });

  it('returns plaud_complete when segments lack timestamps but Zod validates', () => {
    const segments = [{ text: 'No timestamps here.' }];
    const decision = selectPlaudTranscriptSource(makeDetails(segments), baseFile, referenceNow);
    expect(decision.kind).toBe('plaud_complete');
    if (decision.kind === 'plaud_complete') {
      expect(decision.coverageRatio).toBe(1);
    }
  });

  it('returns plaud_complete when file duration is zero (heuristic falls through)', () => {
    const segments = [{ text: 'Some text.', start_time: 0, end_time: 5 }];
    const fileNoDuration: PlaudFile = { ...baseFile, duration: 0 };
    const decision = selectPlaudTranscriptSource(makeDetails(segments), fileNoDuration, referenceNow);
    expect(decision.kind).toBe('plaud_complete');
  });

  it('returns invalid when all segments are whitespace-only', () => {
    const decision = selectPlaudTranscriptSource(
      makeDetails([{ text: '  ' }, { text: '\t' }]),
      baseFile,
      referenceNow,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') {
      expect(decision.reason).toBe('plaud_transcript_empty_after_format');
    }
  });

  it('returns plaud_complete when whitespace segments are mixed with real content', () => {
    const decision = selectPlaudTranscriptSource(
      makeDetails([{ text: '  ' }, { text: 'Real content.' }]),
      baseFile,
      referenceNow,
    );
    expect(decision.kind).toBe('plaud_complete');
    if (decision.kind === 'plaud_complete') {
      expect(decision.segments).toHaveLength(1);
      expect(decision.segments[0].text).toBe('Real content.');
    }
  });

  it('returns invalid when segment text exceeds max size cap', () => {
    const decision = selectPlaudTranscriptSource(
      makeDetails([{ text: 'x'.repeat(50_001) }]),
      baseFile,
      referenceNow,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') {
      expect(decision.reason).toMatch(/^plaud_source_list_malformed:/);
    }
  });

  it('returns invalid when source_list exceeds max item cap', () => {
    const decision = selectPlaudTranscriptSource(
      makeDetails(new Array(MAX_RAW_SOURCE_LIST_LENGTH + 1).fill({ text: 'ok' })),
      baseFile,
      referenceNow,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') {
      expect(decision.reason).toBe('plaud_source_list_too_large');
    }
  });

  it('returns invalid when oversized raw list is mostly whitespace', () => {
    const decision = selectPlaudTranscriptSource(
      makeDetails([...new Array(51_000).fill({ text: '   ' }), { text: 'Real content.' }]),
      baseFile,
      referenceNow,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') {
      expect(decision.reason).toBe('plaud_source_list_too_large');
    }
  });

  it('returns invalid when transcript becomes empty after sanitization', () => {
    const decision = selectPlaudTranscriptSource(
      makeDetails([{ text: '\u0000\u0007' }]),
      baseFile,
      referenceNow,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') {
      expect(decision.reason).toBe('plaud_transcript_empty_after_format');
    }
  });
});

describe('formatPlaudTranscriptFromSourceList', () => {
  it('joins segment text with double newlines and escapes periods in raw markdown source', () => {
    const segments: PlaudTranscriptSegment[] = [
      { text: 'First sentence.' },
      { text: 'Second sentence.' },
    ];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).toBe('First sentence\\.\n\nSecond sentence\\.');
  });

  it('escapes Markdown link syntax (no clickable javascript: links)', () => {
    const segments = [{ text: '[click here](javascript:alert(1))' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).not.toMatch(/^\[click/);
    expect(formatted).toContain('\\[click here\\]');
    expect(formatted).toContain('\\(javascript\\:alert\\(1\\)\\)');
  });

  it('escapes HTML/script-like content', () => {
    const segments = [{ text: '<script>alert(1)</script>' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).toContain('\\<script\\>');
    expect(formatted).toContain('\\<\\/script\\>');
  });

  it('escapes Markdown image syntax (no auto-fetched images)', () => {
    const segments = [{ text: '![track](https://evil.example/track.gif)' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).toContain('\\!\\[track\\]');
    expect(formatted).toContain('\\(https\\:\\/\\/evil\\.example\\/track\\.gif\\)');
  });

  it('escapes ampersands to prevent entity-decoding bypasses', () => {
    const segments = [{ text: '&lt;script&gt; &amp;copy;' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).toContain('\\&lt;script\\&gt;');
    expect(formatted).toContain('\\&amp;copy;');
  });

  it('escapes colon/slash to prevent bare URL autolinks', () => {
    const segments = [{ text: 'https://evil.example/track' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).toContain('https\\:\\/\\/evil\\.example\\/track');
    expect(formatted).not.toContain('https://evil.example/track');
  });

  it('escapes periods to neutralize bare www autolinks', () => {
    const segments = [{ text: 'www.evil.example' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).toContain('www\\.evil\\.example');
    expect(formatted).not.toContain('www.evil.example');
  });

  it('escapes backticks and pipes (no code-fence or table injection)', () => {
    const segments = [{ text: '```bash\nrm -rf /\n```\n| col | col |' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).toContain('\\`\\`\\`bash');
    expect(formatted).toContain('\\| col \\| col \\|');
  });

  it('strips ASCII control characters', () => {
    const segments = [{ text: 'Hello\u0000World\u001FEnd' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).not.toContain('\u0000');
    expect(formatted).not.toContain('\u001F');
    expect(formatted).toContain('HelloWorldEnd');
  });

  it('collapses embedded newlines so setext-style headings cannot form', () => {
    const segments = [{ text: 'Title\n===\nBody' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    // No raw newlines mid-segment, no setext underline opportunity.
    expect(formatted).not.toMatch(/\n===\n/);
    expect(formatted).toContain('\\=\\=\\=');
  });

  it('strips bidi / zero-width formatting characters', () => {
    const segments = [{ text: 'Hello\u202EWorld\u200BEnd' }];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).not.toContain('\u202E');
    expect(formatted).not.toContain('\u200B');
    expect(formatted).toContain('HelloWorldEnd');
  });

  it('drops empty segments after trim', () => {
    const segments: PlaudTranscriptSegment[] = [
      { text: 'real' },
      { text: '   ' },
      { text: 'content' },
    ];
    const formatted = formatPlaudTranscriptFromSourceList(segments);
    expect(formatted).toBe('real\n\ncontent');
  });
});
