import { describe, expect, it } from 'vitest';
import { summarizeStagedExecutionResult } from '../stagedExecutionSummary';

describe('summarizeStagedExecutionResult', () => {
  it('unwraps super-mcp envelopes and strips nested base64 payloads', () => {
    const innerResult = JSON.stringify({
      id: 'draft-123',
      message: {
        threadId: 'thread-456',
        raw: 'A'.repeat(2_000),
      },
      status: 'ok',
    });

    const rawContent = `${JSON.stringify({
      package_id: 'GoogleWorkspace-teammember-mindstone-com',
      tool_id: 'create_workspace_draft',
      args_used: { subject: 'Important Documents' },
      result: {
        content: [{ type: 'text', text: innerResult }],
      },
      telemetry: { output_chars: 2_500_000 },
    }, null, 2)}\n\n---\n⚠️ LARGE OUTPUT WARNING: This response contains too many characters.`;

    const summary = summarizeStagedExecutionResult(rawContent);

    expect(summary).toContain('draft-123');
    expect(summary).toContain('thread-456');
    expect(summary).toContain('[base64 content stripped]');
    expect(summary).not.toContain('⚠️ LARGE OUTPUT WARNING');
    expect(summary).not.toContain('package_id');
  });

  it('replaces embedded base64 runs in plain-text payloads', () => {
    const summary = summarizeStagedExecutionResult(
      `Result:\n${'B'.repeat(2_000)}\n---\nDone.`
    );

    expect(summary).toContain('[base64 content stripped]');
    expect(summary).toContain('Done.');
  });

  it('truncates oversized plain-text results', () => {
    const summary = summarizeStagedExecutionResult('Useful text '.repeat(500));

    expect(summary.length).toBeLessThanOrEqual(4_100);
    expect(summary).toContain('[truncated');
  });
});
