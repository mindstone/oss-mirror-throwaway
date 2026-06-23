import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractSubAgentMetadataFromRawDetail } from '../subAgents';

// Mirror of the core-local MAX_RAW_FIELD_PARSE_CHARS guard in subAgents.ts.
const MAX_RAW_FIELD_PARSE_CHARS = 16 * 1024;

describe('extractSubAgentMetadataFromRawDetail — bounded field parse (Stage 3 sibling-class fix)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives label + small summary for normal-size fields', () => {
    const detail = JSON.stringify({
      subagent_type: 'general_helper',
      description: 'Short description',
      prompt: 'A reasonably short prompt',
    });

    const meta = extractSubAgentMetadataFromRawDetail(detail);
    expect(meta).not.toBeNull();
    expect(meta?.label).toBe('General Helper');
    expect(meta?.subagentType).toBe('general_helper');
    expect(meta?.summary).toBe('Short description');
  });

  it('does NOT JSON.parse an over-size captured field, yet still derives small metadata', () => {
    const hugePrompt = 'x'.repeat(MAX_RAW_FIELD_PARSE_CHARS + 10_000);
    const detail = JSON.stringify({
      subagent_type: 'general_helper',
      description: 'Short description',
      prompt: hugePrompt,
    });

    const parseSpy = vi.spyOn(JSON, 'parse');

    const meta = extractSubAgentMetadataFromRawDetail(detail);

    // The huge prompt's decoded string was never handed to JSON.parse — every
    // parse call operated on a SMALL captured field (subagent_type/description).
    for (const call of parseSpy.mock.calls) {
      const arg = call[0];
      expect(typeof arg).toBe('string');
      expect((arg as string).length).toBeLessThanOrEqual(MAX_RAW_FIELD_PARSE_CHARS + 2);
    }

    // Metadata is still derived from the small fields; oversize prompt is skipped.
    expect(meta).not.toBeNull();
    expect(meta?.label).toBe('General Helper');
    expect(meta?.summary).toBe('Short description');
  });

  it('falls back to a bounded prompt when no description and prompt is small', () => {
    const detail = JSON.stringify({
      agent: 'researcher',
      prompt: 'Investigate the thing',
    });

    const meta = extractSubAgentMetadataFromRawDetail(detail);
    expect(meta?.label).toBe('Researcher');
    expect(meta?.summary).toBe('Investigate the thing');
  });

  it('skips an over-size prompt when it is the only summary source', () => {
    const hugePrompt = 'y'.repeat(MAX_RAW_FIELD_PARSE_CHARS + 1);
    const detail = JSON.stringify({
      agent: 'researcher',
      prompt: hugePrompt,
    });

    const meta = extractSubAgentMetadataFromRawDetail(detail);
    // Label still derives (small field); summary is undefined because the only
    // summary source was the over-size prompt, which we decline to decode.
    expect(meta?.label).toBe('Researcher');
    expect(meta?.summary).toBeUndefined();
  });
});
