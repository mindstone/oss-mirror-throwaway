import { describe, expect, it } from 'vitest';

import { cleanForCompaction } from '../compactionUtils';

describe('cleanForCompaction', () => {
  it('strips [COMPACTION_DEPTH:N] markers', () => {
    expect(cleanForCompaction('[COMPACTION_DEPTH:1] Hello world')).toBe('Hello world');
    expect(cleanForCompaction('[COMPACTION_DEPTH:2] Test')).toBe('Test');
  });

  it('strips multiple depth markers idempotently', () => {
    expect(cleanForCompaction('[COMPACTION_DEPTH:1] [COMPACTION_DEPTH:2] Hello')).toBe('Hello');
    expect(cleanForCompaction(cleanForCompaction('[COMPACTION_DEPTH:1] Hello'))).toBe('Hello');
  });

  it('strips @model:`Name` backtick-quoted references', () => {
    expect(cleanForCompaction('Ask @model:`GPT-5.2` to review this')).toBe('Ask  to review this');
    expect(cleanForCompaction('Use @model:`OpenAI / GPT-5.2 — High Thinking` for analysis')).toBe('Use  for analysis');
  });

  it('strips @model:Name legacy references', () => {
    expect(cleanForCompaction('Check with @model:gpt-5.2-codex')).toBe('Check with ');
    expect(cleanForCompaction('@model:gemini-3-pro please weigh in')).toBe(' please weigh in');
  });

  it('strips multiple model references in one prompt', () => {
    const input = 'Ask @model:`GPT-5.2` and @model:gemini-3-pro to compare approaches';
    expect(cleanForCompaction(input)).toBe('Ask  and  to compare approaches');
  });

  it('is case-insensitive for @model references', () => {
    expect(cleanForCompaction('Use @Model:`Test` and @MODEL:other')).toBe('Use  and ');
  });

  it('strips both depth markers and model refs together', () => {
    const input = '[COMPACTION_DEPTH:1] Ask @model:`GPT-5.2` to help with this task';
    expect(cleanForCompaction(input)).toBe('Ask  to help with this task');
  });

  it('strips <conversation_history> blocks and preserves surrounding text', () => {
    const input = 'Before\n<conversation_history>REMOVE HISTORY</conversation_history>\nAfter';
    expect(cleanForCompaction(input)).toBe('Before\nAfter');
  });

  it('strips nested <conversation_history> blocks from prior-depth retries', () => {
    const input = [
      'Before',
      '<conversation_history>outer <conversation_history>inner</conversation_history> tail</conversation_history>',
      'After',
    ].join('\n');

    expect(cleanForCompaction(input)).not.toContain('<conversation_history>');
  });

  it('strips multiple wrapper blocks used by compaction payloads', () => {
    const input = [
      'Keep this',
      '<conversation_history>REMOVE A</conversation_history>',
      '<user-request>REMOVE B</user-request>',
      '<suggested-skills>REMOVE C</suggested-skills>',
      '<conversation_history>REMOVE D</conversation_history>',
      'Keep this too',
    ].join('\n');

    expect(cleanForCompaction(input)).toBe('Keep this\nKeep this too');
  });

  it('preserves normal text with no markers or model refs', () => {
    const input = 'Write a summary of the quarterly report including model performance metrics';
    expect(cleanForCompaction(input)).toBe(input);
  });

  it('does not strip bare model names', () => {
    const input = 'The gpt-5.2 results were better than expected';
    expect(cleanForCompaction(input)).toBe(input);
  });
});
