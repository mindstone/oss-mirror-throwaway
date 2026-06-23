import { describe, it, expect } from 'vitest';
import { parseUseToolEnvelopeJson } from '../superMcpEnvelope';

// Realistic production use_tool envelope shape.
const ENVELOPE = {
  package_id: 'test-server',
  tool_id: 'test-server__read_file',
  result: {
    content: [{ type: 'text', text: 'file contents here' }],
  },
  telemetry: { materialized: false, output_chars: 500 },
};

// Match production formatting exactly — super-mcp's useTool.ts uses
// JSON.stringify(result, null, 2) before appending any suffix.
const ENVELOPE_JSON = JSON.stringify(ENVELOPE, null, 2);

describe('parseUseToolEnvelopeJson', () => {
  it('T1: parses a plain pretty-printed JSON envelope (no suffix)', () => {
    const parsed = parseUseToolEnvelopeJson(ENVELOPE_JSON);

    expect(parsed).toEqual(ENVELOPE);
  });

  it('T2: parses envelope with truncation continuation hint suffix', () => {
    const text = ENVELOPE_JSON
      + '\n\n[To retrieve the full untruncated result: use_tool({ package_id: "pkg", tool_id: "tool", args: {}, result_id: "abc-123", output_offset: 0 })]';

    const parsed = parseUseToolEnvelopeJson(text);

    expect(parsed).toEqual(ENVELOPE);
  });

  it('T3: parses envelope with LARGE OUTPUT WARNING suffix', () => {
    const text = ENVELOPE_JSON
      + '\n\n---\n⚠️ LARGE OUTPUT WARNING: This response contains 500,000 characters (~125,000 tokens).\n'
      + 'If this causes context overflow errors, you can retry with the max_output_chars parameter to limit the output size.\n'
      + 'Example: use_tool({ package_id: "pkg", tool_id: "tool", args: {...}, max_output_chars: 50000 })';

    const parsed = parseUseToolEnvelopeJson(text);

    expect(parsed).toEqual(ENVELOPE);
  });

  it('T4: parses envelope with safety-net oversized_output suffix', () => {
    const text = ENVELOPE_JSON
      + '\n\n[Output too large for context (1,500,000 chars). To retrieve the full result: use_tool({ package_id: "pkg", tool_id: "tool", args: {}, result_id: "def-456", output_offset: 0 })]';

    const parsed = parseUseToolEnvelopeJson(text);

    expect(parsed).toEqual(ENVELOPE);
  });

  it('T5: returns null for non-JSON text', () => {
    const parsed = parseUseToolEnvelopeJson('this is not JSON at all');

    expect(parsed).toBeNull();
  });

  it('T6: returns null for primitive JSON (object-type guard)', () => {
    const parsed = parseUseToolEnvelopeJson('"hello"');

    expect(parsed).toBeNull();
  });

  it('T7: returns null for array JSON (envelope must be a record)', () => {
    const parsed = parseUseToolEnvelopeJson('[1, 2, 3]');

    expect(parsed).toBeNull();
  });
});
