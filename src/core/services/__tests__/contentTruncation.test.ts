import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { truncateForBudget } from '../contentTruncation';

describe('truncateForBudget', () => {
  it('returns content unchanged when under budget', () => {
    const result = truncateForBudget('hello world', 1024, 'cid-1');
    expect(result.wasTruncated).toBe(false);
    expect(result.text).toBe('hello world');
    expect(result.marker).toBe('');
    expect(result.originalBytes).toBe(Buffer.byteLength('hello world', 'utf8'));
    expect(result.keptBytes).toBe(Buffer.byteLength('hello world', 'utf8'));
  });

  it('middle truncates with marker when over budget', () => {
    const content = `${'A'.repeat(4000)}${'B'.repeat(4000)}`;
    const result = truncateForBudget(content, 1200, 'cid-2');
    expect(result.wasTruncated).toBe(true);
    expect(result.text).toContain('tool output truncated to fit context budget');
    expect(result.text.startsWith('AAA')).toBe(true);
    expect(result.text.endsWith('BBB')).toBe(true);
    expect(result.keptBytes).toBeLessThan(result.originalBytes);
  });

  it('keeps valid utf-8 boundaries', () => {
    const content = '日本語🙂'.repeat(300);
    const result = truncateForBudget(content, 600, 'cid-3');
    expect(result.wasTruncated).toBe(true);
    expect(() => Buffer.from(result.text, 'utf8')).not.toThrow();
  });
});
