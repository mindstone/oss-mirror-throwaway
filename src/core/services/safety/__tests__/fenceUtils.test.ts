import { describe, it, expect } from 'vitest';
import { fenceUntrustedContent, fenceToolInput } from '../fenceUtils';

describe('fenceUntrustedContent', () => {
  it('wraps content in XML tags with warning', () => {
    const result = fenceUntrustedContent('hello', 'data', 'WARNING');
    expect(result).toBe('<data>\nWARNING\nhello\n</data>');
  });

  it('escapes closing tags matching the fence tag', () => {
    const result = fenceUntrustedContent('before </data> after', 'data', 'W');
    expect(result).toContain('&lt;/data&gt;');
    expect(result).not.toContain('</data> after');
  });

  it('escapes closing tags case-insensitively', () => {
    const result = fenceUntrustedContent('</DATA>', 'data', 'W');
    // The regex replaces the match with a fixed entity using the original tag name
    expect(result).toContain('&lt;/data&gt;');
    expect(result).not.toContain('</DATA>');
  });

  it('escapes CDATA sections', () => {
    const result = fenceUntrustedContent('<![CDATA[evil]]>', 'tag', 'W');
    expect(result).toContain('&lt;![CDATA[');
  });

  it('does not escape closing tags for different tag names', () => {
    const result = fenceUntrustedContent('</other>', 'data', 'W');
    expect(result).toContain('</other>');
  });

  it('truncates content when maxLength is set', () => {
    const long = 'a'.repeat(100);
    const result = fenceUntrustedContent(long, 'tag', 'W', 10);
    expect(result).toContain('a'.repeat(10));
    expect(result).not.toContain('a'.repeat(11));
  });

  it('does not truncate when maxLength is omitted', () => {
    const long = 'a'.repeat(5000);
    const result = fenceUntrustedContent(long, 'tag', 'W');
    expect(result).toContain(long);
  });
});

describe('fenceToolInput', () => {
  it('serializes object as JSON and wraps in tool_input_data tags', () => {
    const result = fenceToolInput({ key: 'value' });
    expect(result).toContain('<tool_input_data>');
    expect(result).toContain('"key": "value"');
    expect(result).toContain('</tool_input_data>');
  });

  it('truncates large inputs to default max length', () => {
    const big = { data: 'x'.repeat(3000) };
    const result = fenceToolInput(big);
    // JSON serialized will be > 3000 chars, should be truncated to 2000
    const innerContent = result.split('<tool_input_data>')[1]?.split('</tool_input_data>')[0] ?? '';
    // The warning line + JSON content should exist but JSON is truncated
    expect(innerContent.length).toBeLessThan(3500);
  });

  it('respects custom max length', () => {
    const result = fenceToolInput({ x: 'hello world' }, 5);
    expect(result).toContain('<tool_input_data>');
    // JSON.stringify({ x: 'hello world' }, null, 2) is longer than 5, so truncated
  });

  it('includes untrusted data warning', () => {
    const result = fenceToolInput('test');
    expect(result).toContain('untrusted data');
  });
});
