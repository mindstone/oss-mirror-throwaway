import { describe, it, expect } from 'vitest';
import { stripLeakedInvokeXml, isAssistantProcessNarration } from '../assistantNarration';

describe('stripLeakedInvokeXml', () => {
  it('returns text unchanged when no invoke XML present', () => {
    const text = 'Here is a normal response about your question.';
    expect(stripLeakedInvokeXml(text)).toBe(text);
  });

  it('strips a single invoke block', () => {
    const text = '<invoke name="TaskUpdate"><parameter name="taskId">1</parameter><parameter name="status">completed</parameter></invoke>';
    expect(stripLeakedInvokeXml(text)).toBe('');
  });

  it('strips multiple consecutive invoke blocks', () => {
    const text = [
      '<invoke name="TaskUpdate"><parameter name="taskId">1</parameter><parameter name="status">completed</parameter></invoke>',
      '<invoke name="TaskUpdate"><parameter name="taskId">2</parameter><parameter name="status">completed</parameter></invoke>',
      '<invoke name="TaskUpdate"><parameter name="taskId">3</parameter><parameter name="status">completed</parameter></invoke>',
    ].join(' ');
    expect(stripLeakedInvokeXml(text)).toBe('');
  });

  it('strips invoke blocks but preserves surrounding prose', () => {
    const text = '<invoke name="TaskUpdate"><parameter name="taskId">1</parameter><parameter name="status">completed</parameter></invoke>\nThe thread has the answer — your colleague solved it.';
    expect(stripLeakedInvokeXml(text)).toBe(
      'The thread has the answer — your colleague solved it.'
    );
  });

  it('preserves invoke XML inside markdown code fences', () => {
    const text = 'Here is an example:\n```\n<invoke name="TaskUpdate"><parameter name="taskId">1</parameter><parameter name="status">completed</parameter></invoke>\n```';
    expect(stripLeakedInvokeXml(text)).toBe(text);
  });

  it('strips invoke outside fences but preserves inside fences', () => {
    const text = [
      '<invoke name="TaskUpdate"><parameter name="taskId">1</parameter><parameter name="status">completed</parameter></invoke>',
      '```',
      '<invoke name="TaskCreate"><parameter name="subject">example</parameter></invoke>',
      '```',
      'Real content here.',
    ].join('\n');
    const result = stripLeakedInvokeXml(text);
    expect(result).toContain('```');
    expect(result).toContain('<invoke name="TaskCreate">');
    expect(result).toContain('Real content here.');
    expect(result).not.toContain('<invoke name="TaskUpdate">');
  });

  it('handles invoke blocks with whitespace between parameters', () => {
    const text = '<invoke name="TaskUpdate"> <parameter name="taskId">1</parameter> <parameter name="status">completed</parameter> </invoke>';
    expect(stripLeakedInvokeXml(text)).toBe('');
  });

  it('collapses excessive blank lines after stripping', () => {
    const text = 'Before.\n\n\n<invoke name="TaskUpdate"><parameter name="taskId">1</parameter><parameter name="status">completed</parameter></invoke>\n\n\nAfter.';
    const result = stripLeakedInvokeXml(text);
    expect(result).toBe('Before.\n\nAfter.');
  });

  it('strips multiline invoke blocks with indentation', () => {
    const text = [
      '<invoke name="TaskUpdate">',
      '  <parameter name="taskId">1</parameter>',
      '  <parameter name="status">completed</parameter>',
      '</invoke>',
      'Visible reply.',
    ].join('\n');
    expect(stripLeakedInvokeXml(text)).toBe('Visible reply.');
  });

  it('strips invoke blocks with no parameters', () => {
    expect(stripLeakedInvokeXml('<invoke name="TaskList"></invoke>')).toBe('');
  });

  it('leaves partial or malformed invoke XML unchanged', () => {
    const text = 'Keep this: <invoke name="TaskUpdate"><parameter name="taskId">1</parameter>';
    expect(stripLeakedInvokeXml(text)).toBe(text);
  });

  it('preserves invoke XML inside language-tagged markdown code fences', () => {
    const text = [
      'Here is XML:',
      '```xml',
      '<invoke name="TaskUpdate"><parameter name="taskId">1</parameter></invoke>',
      '```',
    ].join('\n');
    expect(stripLeakedInvokeXml(text)).toBe(text);
  });

  it('returns empty string unchanged', () => {
    expect(stripLeakedInvokeXml('')).toBe('');
  });

  it('handles the exact format from the original bug report', () => {
    const bugText = [
      '<invoke name="TaskUpdate"> <parameter name="taskId">1</parameter> <parameter name="status">completed</parameter> </invoke>',
      '<invoke name="TaskUpdate"> <parameter name="taskId">2</parameter> <parameter name="status">completed</parameter> </invoke>',
      '<invoke name="TaskUpdate"> <parameter name="taskId">3</parameter> <parameter name="status">completed</parameter> </invoke>',
      '<invoke name="TaskUpdate"> <parameter name="taskId">4</parameter> <parameter name="status">completed</parameter> </invoke>',
      '<invoke name="TaskUpdate"> <parameter name="taskId">5</parameter> <parameter name="status">completed</parameter> </invoke>',
      '<invoke name="TaskUpdate"> <parameter name="taskId">6</parameter> <parameter name="status">completed</parameter> </invoke>',
      'The thread has the answer — your colleague who raised it effectively solved it themselves at 22:45 tonight:',
    ].join('\n');
    const result = stripLeakedInvokeXml(bugText);
    expect(result).not.toContain('<invoke');
    expect(result).toContain('The thread has the answer');
  });

  it('does not strip text that merely mentions invoke without matching the pattern', () => {
    const text = 'You can use <invoke> tags to call tools in XML format.';
    expect(stripLeakedInvokeXml(text)).toBe(text);
  });
});

describe('isAssistantProcessNarration', () => {
  it('detects short unstructured text as narration', () => {
    expect(isAssistantProcessNarration('Let me check that for you.')).toBe(true);
  });

  it('does not flag structured text as narration', () => {
    expect(isAssistantProcessNarration('# Heading\n\nSome content here.')).toBe(false);
  });

  it('does not flag empty text as narration', () => {
    expect(isAssistantProcessNarration('')).toBe(false);
  });
});
