import { describe, it, expect } from 'vitest';
import type { AgentEvent, ToolAgentEvent } from '@shared/types';
import { extractFileOperations } from '../fileOperations';

const makeToolEvent = (
  overrides: Partial<ToolAgentEvent> & { toolName: string; stage: 'start' | 'end' }
): ToolAgentEvent => ({
  type: 'tool',
  timestamp: Date.now(),
  toolUseId: 'toolu_default',
  detail: '',
  ...overrides,
} as ToolAgentEvent);

describe('extractFileOperations', () => {
  describe('built-in tools', () => {
    it('extracts Write tool start+end with path inheritance', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'Write',
          stage: 'start',
          toolUseId: 'toolu_1',
          detail: JSON.stringify({ path: '/workspace/report.md', content: '# Report' }),
        }),
        makeToolEvent({
          toolName: 'Write',
          stage: 'end',
          toolUseId: 'toolu_1',
          detail: 'File written successfully',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(2);

      const startOp = ops.find(o => o.stage === 'start');
      const endOp = ops.find(o => o.stage === 'end');

      expect(startOp?.filePath).toBe('/workspace/report.md');
      expect(startOp?.operation).toBe('write');

      expect(endOp?.filePath).toBe('/workspace/report.md');
      expect(endOp?.operation).toBe('write');
    });

    it('preserves failed tool result state for downstream activity classification', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'Write',
          stage: 'start',
          toolUseId: 'toolu_failed_write',
          detail: JSON.stringify({ path: '/workspace/missing/report.md', content: '# Report' }),
        }),
        makeToolEvent({
          toolName: 'Write',
          stage: 'end',
          toolUseId: 'toolu_failed_write',
          detail: "Error: ENOENT: no such file or directory",
          isError: true,
        }),
      ];

      const ops = extractFileOperations(events);
      const endOp = ops.find(o => o.stage === 'end');

      expect(endOp?.filePath).toBe('/workspace/missing/report.md');
      expect(endOp?.isError).toBe(true);
    });

    it('extracts Create tool operations', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'Create',
          stage: 'start',
          toolUseId: 'toolu_2',
          detail: JSON.stringify({ path: '/workspace/new-file.txt', content: 'hello' }),
        }),
        makeToolEvent({
          toolName: 'Create',
          stage: 'end',
          toolUseId: 'toolu_2',
          detail: 'created',
        }),
      ];

      const ops = extractFileOperations(events);
      const endOp = ops.find(o => o.stage === 'end');
      expect(endOp?.filePath).toBe('/workspace/new-file.txt');
      expect(endOp?.operation).toBe('create');
    });
  });

  describe('MCP router use_tool wrappers', () => {
    it('extracts filesystem write_file through use_tool wrapper', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'start',
          toolUseId: 'toolu_mcp_1',
          detail: JSON.stringify({
            package_id: 'filesystem',
            tool_id: 'write_file',
            args: { path: '/workspace/UX Audits/report.md', content: '# UX Report' },
          }),
        }),
        makeToolEvent({
          toolName: 'filesystem/write_file',
          stage: 'end',
          toolUseId: 'toolu_mcp_1',
          detail: 'File written successfully',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(2);

      const startOp = ops.find(o => o.stage === 'start');
      const endOp = ops.find(o => o.stage === 'end');

      expect(startOp?.filePath).toBe('/workspace/UX Audits/report.md');
      expect(startOp?.operation).toBe('write');
      expect(startOp?.toolName).toBe('filesystem/write_file');

      expect(endOp?.filePath).toBe('/workspace/UX Audits/report.md');
      expect(endOp?.operation).toBe('write');
    });

    it('extracts filesystem create_file through use_tool wrapper', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'start',
          toolUseId: 'toolu_mcp_2',
          detail: JSON.stringify({
            package_id: 'filesystem',
            tool_id: 'create_file',
            args: { path: '/docs/notes.md', content: 'notes' },
          }),
        }),
        makeToolEvent({
          toolName: 'filesystem/create_file',
          stage: 'end',
          toolUseId: 'toolu_mcp_2',
          detail: 'created',
        }),
      ];

      const ops = extractFileOperations(events);
      const endOp = ops.find(o => o.stage === 'end');
      expect(endOp?.filePath).toBe('/docs/notes.md');
      expect(endOp?.operation).toBe('create');
    });

    it('extracts filesystem read_file through use_tool wrapper', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'start',
          toolUseId: 'toolu_mcp_3',
          detail: JSON.stringify({
            package_id: 'filesystem',
            tool_id: 'read_file',
            args: { path: '/workspace/data.json' },
          }),
        }),
        makeToolEvent({
          toolName: 'filesystem/read_file',
          stage: 'end',
          toolUseId: 'toolu_mcp_3',
          detail: '{"key": "value"}',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(2);
      expect(ops[0]?.operation).toBe('read');
      expect(ops[0]?.filePath).toBe('/workspace/data.json');
    });

    it('handles use_tool wrapper when end event is NOT resolved (falls back to wrapper)', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'start',
          toolUseId: 'toolu_mcp_4',
          detail: JSON.stringify({
            package_id: 'LocalFiles',
            tool_id: 'write_file',
            args: { path: '/workspace/output.md', content: 'content' },
          }),
        }),
        makeToolEvent({
          toolName: 'toolu_mcp_4',
          stage: 'end',
          toolUseId: 'toolu_mcp_4',
          detail: 'done',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(2);

      const endOp = ops.find(o => o.stage === 'end');
      expect(endOp?.filePath).toBe('/workspace/output.md');
      expect(endOp?.operation).toBe('write');
      expect(endOp?.toolName).toBe('LocalFiles/write_file');
    });

    it('ignores use_tool wrappers for non-filesystem tools', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'start',
          toolUseId: 'toolu_mcp_5',
          detail: JSON.stringify({
            package_id: 'gmail',
            tool_id: 'send_email',
            args: { to: 'test@example.com', subject: 'hello' },
          }),
        }),
        makeToolEvent({
          toolName: 'gmail/send_email',
          stage: 'end',
          toolUseId: 'toolu_mcp_5',
          detail: 'sent',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(0);
    });

    it('handles use_tool wrapper with missing args gracefully', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'start',
          toolUseId: 'toolu_mcp_6',
          detail: JSON.stringify({
            package_id: 'filesystem',
            tool_id: 'write_file',
          }),
        }),
        makeToolEvent({
          toolName: 'filesystem/write_file',
          stage: 'end',
          toolUseId: 'toolu_mcp_6',
          detail: 'written',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(2);
      const endOp = ops.find(o => o.stage === 'end');
      expect(endOp?.operation).toBe('write');
      expect(endOp?.filePath).toBeNull();
    });

    it('handles use_tool wrapper with malformed detail gracefully', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'start',
          toolUseId: 'toolu_mcp_7',
          detail: 'not valid json',
        }),
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'end',
          toolUseId: 'toolu_mcp_7',
          detail: 'error',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(0);
    });
  });

  describe('truncated JSON (sanitization artifact)', () => {
    it('extracts Write path from truncated JSON detail', () => {
      const truncatedDetail =
        '{"path":"/Users/test/Documents/UX Audits/260225-Inbox-Report.md","content":"# Inbox Report\\n\\nLong content that goes on and on... [truncated, 40000 chars omitted]';
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'Write',
          stage: 'start',
          toolUseId: 'toolu_trunc_1',
          detail: truncatedDetail,
        }),
        makeToolEvent({
          toolName: 'Write',
          stage: 'end',
          toolUseId: 'toolu_trunc_1',
          detail: 'File written successfully',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(2);

      const startOp = ops.find(o => o.stage === 'start');
      const endOp = ops.find(o => o.stage === 'end');

      expect(startOp?.filePath).toBe('/Users/test/Documents/UX Audits/260225-Inbox-Report.md');
      expect(startOp?.operation).toBe('write');

      expect(endOp?.filePath).toBe('/Users/test/Documents/UX Audits/260225-Inbox-Report.md');
      expect(endOp?.operation).toBe('write');
    });

    it('extracts Create path from truncated JSON detail', () => {
      const truncatedDetail =
        '{"file_path":"/workspace/docs/analysis.md","content":"Long analysis... [truncated, 25000 chars omitted]';
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'Create',
          stage: 'start',
          toolUseId: 'toolu_trunc_2',
          detail: truncatedDetail,
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(1);
      expect(ops[0]?.filePath).toBe('/workspace/docs/analysis.md');
    });

    it('handles truncated JSON with no path keys gracefully', () => {
      const truncatedDetail =
        '{"query":"search term","results":"very long results... [truncated, 15000 chars omitted]';
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'Write',
          stage: 'start',
          toolUseId: 'toolu_trunc_3',
          detail: truncatedDetail,
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(1);
      expect(ops[0]?.filePath).toBeNull();
    });
  });

  describe('mixed events', () => {
    it('handles built-in tools and MCP router tools in the same turn', () => {
      const events: AgentEvent[] = [
        makeToolEvent({
          toolName: 'Read',
          stage: 'start',
          toolUseId: 'toolu_builtin_1',
          detail: JSON.stringify({ path: '/workspace/input.txt' }),
        }),
        makeToolEvent({
          toolName: 'Read',
          stage: 'end',
          toolUseId: 'toolu_builtin_1',
          detail: 'file contents here',
        }),
        makeToolEvent({
          toolName: 'mcp__super-mcp-router__use_tool',
          stage: 'start',
          toolUseId: 'toolu_mcp_mix',
          detail: JSON.stringify({
            package_id: 'filesystem',
            tool_id: 'write_file',
            args: { path: '/workspace/output.md', content: '# Output' },
          }),
        }),
        makeToolEvent({
          toolName: 'filesystem/write_file',
          stage: 'end',
          toolUseId: 'toolu_mcp_mix',
          detail: 'written',
        }),
      ];

      const ops = extractFileOperations(events);
      expect(ops).toHaveLength(4);

      const readOps = ops.filter(o => o.operation === 'read');
      const writeOps = ops.filter(o => o.operation === 'write');

      expect(readOps).toHaveLength(2);
      expect(writeOps).toHaveLength(2);

      const writeEnd = writeOps.find(o => o.stage === 'end');
      expect(writeEnd?.filePath).toBe('/workspace/output.md');
    });
  });
});
