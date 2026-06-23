import { describe, expect, it } from 'vitest';
import { sanitizeTaskContext, unwrapCompactionArtifact } from '../compactionUtils';

describe('unwrapCompactionArtifact', () => {
  it('returns normal messages unchanged', () => {
    const input = 'Please draft a follow-up email about the Q2 plan.';
    expect(unwrapCompactionArtifact(input)).toBe(input);
  });

  it('extracts the request from a single-depth compaction artifact', () => {
    const input = [
      '[COMPACTION_DEPTH:1]',
      '=== CONVERSATION CONTEXT ===',
      'Older summary here',
      '=== CONTINUE WITH REQUEST ===',
      'actual request'
    ].join('\n');

    expect(unwrapCompactionArtifact(input)).toBe('actual request');
  });

  it('extracts from the last marker for multi-depth nested artifacts', () => {
    const input = [
      '[COMPACTION_DEPTH:2]',
      '=== CONTINUE WITH REQUEST ===',
      '[COMPACTION_DEPTH:1]',
      '=== CONTINUE WITH REQUEST ===',
      'latest request payload'
    ].join('\n');

    expect(unwrapCompactionArtifact(input)).toBe('latest request payload');
  });

  it('returns malformed artifacts unchanged when marker is missing', () => {
    const input = '[COMPACTION_DEPTH:1]\nThis text has no continue marker.';
    expect(unwrapCompactionArtifact(input)).toBe(input);
  });

  it('returns original text when extraction is empty', () => {
    const input = '[COMPACTION_DEPTH:1]\n=== CONTINUE WITH REQUEST ===';
    expect(unwrapCompactionArtifact(input)).toBe(input);
  });
});

describe('sanitizeTaskContext', () => {
  it('applies unwrap and compaction cleaning together', () => {
    const input = [
      '[COMPACTION_DEPTH:2]',
      '=== CONVERSATION CONTEXT ===',
      '<conversation_history>REMOVE HISTORY</conversation_history>',
      '=== CONTINUE WITH REQUEST ===',
      'Please continue this task @model:gpt-5.2',
      '<user-request>REMOVE REQUEST BLOCK</user-request>',
      '<suggested-skills>REMOVE SKILLS BLOCK</suggested-skills>',
      'Keep this line'
    ].join('\n');

    const sanitized = sanitizeTaskContext(input);

    expect(sanitized).toContain('Please continue this task');
    expect(sanitized).toContain('Keep this line');
    expect(sanitized).not.toContain('[COMPACTION_DEPTH:');
    expect(sanitized).not.toContain('<conversation_history>');
    expect(sanitized).not.toContain('<user-request>');
    expect(sanitized).not.toContain('<suggested-skills>');
    expect(sanitized).not.toContain('@model:');
  });
});
