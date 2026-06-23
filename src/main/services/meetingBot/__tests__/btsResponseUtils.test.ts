import { removeCodeFence, extractTextFromBtsResponse, hashTranscriptTail } from '../btsResponseUtils';
import type { BehindTheScenesResponse } from '@core/services/behindTheScenesClient';

describe('removeCodeFence', () => {
  it('returns text unchanged when no fences present', () => {
    expect(removeCodeFence('hello world')).toBe('hello world');
  });

  it('strips fences with a language tag', () => {
    expect(removeCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips fences without a language tag', () => {
    expect(removeCodeFence('```\nplain text\n```')).toBe('plain text');
  });

  it('handles fences with hyphenated language tags', () => {
    expect(removeCodeFence('```type-script\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('trims surrounding whitespace', () => {
    expect(removeCodeFence('  ```json\n{"b":2}\n```  ')).toBe('{"b":2}');
  });

  it('preserves nested triple backticks within content', () => {
    const input = '```markdown\nHere is some code:\n```js\nconsole.log("hi")\n```';
    // The outer fence is stripped; inner backtick block remains as content
    const result = removeCodeFence(input);
    expect(result).toContain('console.log');
  });

  it('returns empty string for empty fences', () => {
    expect(removeCodeFence('```\n```')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(removeCodeFence('')).toBe('');
  });
});

describe('extractTextFromBtsResponse', () => {
  it('returns string structured_output when non-empty', () => {
    const response: BehindTheScenesResponse = {
      content: [{ type: 'text', text: 'fallback' }],
      model: 'test',
      structured_output: 'structured text',
    };
    expect(extractTextFromBtsResponse(response)).toBe('structured text');
  });

  it('returns null for empty string structured_output and falls through to content', () => {
    const response: BehindTheScenesResponse = {
      content: [{ type: 'text', text: 'from content block' }],
      model: 'test',
      structured_output: '',
    };
    expect(extractTextFromBtsResponse(response)).toBe('from content block');
  });

  it('returns null for whitespace-only string structured_output and falls through', () => {
    const response: BehindTheScenesResponse = {
      content: [{ type: 'text', text: 'content fallback' }],
      model: 'test',
      structured_output: '   ',
    };
    expect(extractTextFromBtsResponse(response)).toBe('content fallback');
  });

  it('stringifies object structured_output', () => {
    const response: BehindTheScenesResponse = {
      content: [],
      model: 'test',
      structured_output: { key: 'value' },
    };
    expect(extractTextFromBtsResponse(response)).toBe('{"key":"value"}');
  });

  it('stringifies array structured_output', () => {
    const response: BehindTheScenesResponse = {
      content: [],
      model: 'test',
      structured_output: [1, 2, 3],
    };
    expect(extractTextFromBtsResponse(response)).toBe('[1,2,3]');
  });

  it('falls back to text content block when structured_output is null', () => {
    const response: BehindTheScenesResponse = {
      content: [{ type: 'text', text: 'hello from content' }],
      model: 'test',
      structured_output: null,
    };
    expect(extractTextFromBtsResponse(response)).toBe('hello from content');
  });

  it('falls back to text content block when structured_output is undefined', () => {
    const response: BehindTheScenesResponse = {
      content: [{ type: 'text', text: 'hello from content' }],
      model: 'test',
    };
    expect(extractTextFromBtsResponse(response)).toBe('hello from content');
  });

  it('returns first text block when multiple content blocks exist', () => {
    const response: BehindTheScenesResponse = {
      content: [
        { type: 'tool_use' },
        { type: 'text', text: 'first text' },
        { type: 'text', text: 'second text' },
      ],
      model: 'test',
    };
    expect(extractTextFromBtsResponse(response)).toBe('first text');
  });

  it('returns null when no text content and no structured_output', () => {
    const response: BehindTheScenesResponse = {
      content: [{ type: 'tool_use' }],
      model: 'test',
    };
    expect(extractTextFromBtsResponse(response)).toBeNull();
  });

  it('returns null for completely empty response', () => {
    const response: BehindTheScenesResponse = {
      content: [],
      model: 'test',
    };
    expect(extractTextFromBtsResponse(response)).toBeNull();
  });
});

describe('hashTranscriptTail', () => {
  it('produces a consistent hash for the same input', () => {
    const hash1 = hashTranscriptTail('hello world');
    const hash2 = hashTranscriptTail('hello world');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = hashTranscriptTail('hello world');
    const hash2 = hashTranscriptTail('goodbye world');
    expect(hash1).not.toBe(hash2);
  });

  it('uses custom window size', () => {
    const longText = 'a'.repeat(1000) + 'b'.repeat(500);
    const defaultHash = hashTranscriptTail(longText);
    const customHash = hashTranscriptTail(longText, 200);
    // Both should hash the tail, but different window sizes → different hashes
    // (unless the last 200 chars happen to hash the same as last 500, which is unlikely)
    expect(typeof customHash).toBe('string');
    expect(customHash.length).toBeGreaterThan(0);
    // The key behavior: custom window hashes less of the tail
    expect(defaultHash).not.toBe(customHash);
  });

  it('handles empty string', () => {
    const hash = hashTranscriptTail('');
    expect(hash).toBe('0'); // hash of 0 in base 36
  });

  it('handles string shorter than window size', () => {
    const hash = hashTranscriptTail('short', 500);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('returns base-36 encoded string', () => {
    const hash = hashTranscriptTail('some transcript text');
    // Base-36 characters: 0-9, a-z, and optional leading minus
    expect(hash).toMatch(/^-?[0-9a-z]+$/);
  });
});
