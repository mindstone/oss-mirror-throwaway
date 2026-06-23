/**
 * Tests for MCP Apps UI metadata extraction in collectToolHints.
 *
 * Covers the three detection methods:
 *  1. _meta.ui.resourceUri on tool_result blocks
 *  2. Resource content blocks with MCP Apps mime types
 *  3. [View: ui://...] text markers (fallback)
 *
 * Particular focus on the [View:] regex edge cases (dots in URIs, trailing punctuation).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAgentMessageHandlerLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

 
vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    createScopedLogger: () => mockAgentMessageHandlerLog,
  };
});

 
vi.mock('../../services/superMcpHttpManager', () => ({
  superMcpHttpManager: { getState: () => ({ isRunning: false }) },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
import {
  collectToolHints,
  SUPER_MCP_ENVELOPE_PREFIX_MARKER,
  SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS,
} from '../agentMessageHandler';

function makeToolResult(content: unknown[], meta?: Record<string, unknown>, structuredContent?: unknown) {
  const block: Record<string, unknown> = {
    type: 'tool_result',
    tool_use_id: 'tu_test',
    content,
  };
  if (meta) block._meta = meta;
  if (structuredContent !== undefined) block.structuredContent = structuredContent;
  return {
    type: 'user' as const,
    message: { content: [block] },
  };
}

function makeUseToolEnvelopeText({
  packageId = 'google-workspace',
  toolId = 'compose_workspace_email',
  argsUsed = { to: ['x@y'] },
  result,
  telemetry = { duration_ms: 12, status: 'ok' },
  suffix = '',
}: {
  packageId?: string;
  toolId?: string;
  argsUsed?: Record<string, unknown>;
  result: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
  suffix?: string;
}) {
  return `${JSON.stringify(
    {
      package_id: packageId,
      tool_id: toolId,
      args_used: argsUsed,
      result,
      telemetry,
    },
    null,
    2,
  )}${suffix}`;
}

function makeUseToolEnvelopeTextWithPackageMarkerAt(markerIndex: number) {
  if (markerIndex < 1) {
    throw new Error('markerIndex must leave room for the opening JSON brace');
  }
  return `{${' '.repeat(markerIndex - 1)}"package_id":"google-workspace","tool_id":"compose_workspace_email","args_used":{},"result":{"content":[{"type":"text","text":"Draft ready."}],"_meta":{"ui":{"resourceUri":"ui://google-workspace/compose-email"}},"structuredContent":{"subject":"Boundary"}},"telemetry":{"duration_ms":12,"status":"ok"}}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  initTestPlatformConfig();
});

describe('collectToolHints — MCP Apps UI metadata', () => {
  describe('Method 0: Super-MCP envelope pre-parse heuristic', () => {
    it('rejects plain prose before JSON.parse and keeps outer metadata unchanged', () => {
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const structuredContent = { ok: true };
      const msg = makeToolResult(
        [{ type: 'text', text: 'Plain prose. Not an envelope. Mercifully obvious.' }],
        { ui: { resourceUri: 'ui://outer/plain-prose' } },
        structuredContent,
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      const envelopeDebugCalls = debugSpy.mock.calls.filter(
        ([, message]) => message === 'Super-MCP use_tool envelope detected; metadata adoption status logged',
      );

      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://outer/plain-prose');
      expect(toolEnd?.toolResult?.structuredContent).toBe(structuredContent);
      expect(envelopeDebugCalls).toHaveLength(0);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tu_test',
          reason: 'non_json_text',
        }),
        'Super-MCP use_tool envelope rejected by pre-parse heuristic; skipping JSON parse',
      );
    });

    it('heuristic rejects on 1MB pathological JSON without package_id in 64-char window', () => {
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const pathologicalText = `{"some_other_key":"${'x'.repeat(1024 * 1024)}"}`;
      const msg = makeToolResult([{ type: 'text', text: pathologicalText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      const envelopeDebugCalls = debugSpy.mock.calls.filter(
        ([, message]) => message === 'Super-MCP use_tool envelope detected; metadata adoption status logged',
      );

      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
      expect(envelopeDebugCalls).toHaveLength(0);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tu_test',
          reason: 'missing_package_id_prefix',
          textLength: pathologicalText.length,
        }),
        'Super-MCP use_tool envelope rejected by pre-parse heuristic; skipping JSON parse',
      );
    });

    it('rejects bash-shaped JSON output without package_id in the first 64 chars', () => {
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const bashOutput = `{
  "stdout": "${'x'.repeat(80)}",
  "stderr": "",
  "exitCode": 0
}`;
      const msg = makeToolResult([{ type: 'text', text: bashOutput }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      const envelopeDebugCalls = debugSpy.mock.calls.filter(
        ([, message]) => message === 'Super-MCP use_tool envelope detected; metadata adoption status logged',
      );

      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
      expect(envelopeDebugCalls).toHaveLength(0);
    });

    it('unwrapUseToolEnvelopeMeta returns baseEffective when text is empty string', () => {
      const structuredContent = { preserved: true };
      const msg = makeToolResult(
        [{ type: 'text', text: '' }],
        { ui: { resourceUri: 'ui://outer/empty-text' } },
        structuredContent,
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');

      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://outer/empty-text');
      expect(toolEnd?.toolResult?.structuredContent).toBe(structuredContent);
    });

    it('tolerates leading whitespace before a valid use_tool envelope', () => {
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const structuredContent = {
        to: ['x@y'],
        subject: 'Whitespace is not a personality defect',
        body: 'Still parse the envelope.',
      };
      const envelopeText = `\n\n   ${makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent,
        },
      })}`;
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      const heuristicRejectCalls = debugSpy.mock.calls.filter(
        ([, message]) => message === 'Super-MCP use_tool envelope rejected by pre-parse heuristic; skipping JSON parse',
      );

      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(toolEnd?.toolResult?.structuredContent).toEqual(structuredContent);
      expect(heuristicRejectCalls).toHaveLength(0);
    });

    it('documents the deliberate 64-char package_id prefix boundary', () => {
      const acceptedMarkerIndex = SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS - 4;
      const rejectedMarkerIndex = SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS + 1;
      expect(acceptedMarkerIndex).toBe(60);

      const acceptedMsg = makeToolResult([
        { type: 'text', text: makeUseToolEnvelopeTextWithPackageMarkerAt(acceptedMarkerIndex) },
      ]);
      const rejectedMsg = makeToolResult([
        { type: 'text', text: makeUseToolEnvelopeTextWithPackageMarkerAt(rejectedMarkerIndex) },
      ]);

      const acceptedToolEnd = collectToolHints(acceptedMsg as any).find((e) => e.stage === 'end');
      const rejectedToolEnd = collectToolHints(rejectedMsg as any).find((e) => e.stage === 'end');

      expect(SUPER_MCP_ENVELOPE_PREFIX_MARKER).toBe('"package_id"');
      expect(acceptedToolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(acceptedToolEnd?.toolResult?.structuredContent).toEqual({ subject: 'Boundary' });
      expect(rejectedToolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(rejectedToolEnd?.toolResult?.structuredContent).toBeUndefined();
    });

    it('unwraps envelope metadata and propagates all A3a fields plus structuredContent', () => {
      const structuredFallback = {
        kind: 'email-draft' as const,
        payload: {
          to: ['person@example.com'],
          cc: [],
          bcc: [],
          subject: 'Hello',
          body: 'Draft body.',
        },
      };
      const structuredContent = { subject: 'Hello', body: 'Draft body.' };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [{ type: 'text', text: 'Draft ready.' }],
          _meta: {
            ui: {
              resourceUri: 'ui://google-workspace/compose-email',
              presentation: 'primary',
              viewSummary: 'Email draft to person@example.com — subject "Hello".',
              viewRoleLabel: 'Editable email draft',
              structuredFallback,
            },
          },
          structuredContent,
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const toolEnd = collectToolHints(msg as any).find((e) => e.stage === 'end');

      expect(toolEnd?.mcpAppUiMeta).toEqual({
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: 'Email draft to person@example.com — subject "Hello".',
        viewRoleLabel: 'Editable email draft',
        structuredFallback,
      });
      expect(toolEnd?.toolResult?.structuredContent).toEqual(structuredContent);
    });
  });

  describe('Method 1: _meta.ui.resourceUri on tool_result block', () => {
    it('extracts resourceUri from _meta.ui', () => {
      const msg = makeToolResult(
        [{ type: 'text', text: 'Done' }],
        { ui: { resourceUri: 'ui://my-app/dashboard' } },
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toEqual({ resourceUri: 'ui://my-app/dashboard' });
    });

    it('propagates presentation metadata, role labels, and structured fallback from _meta.ui', () => {
      const structuredFallback = {
        kind: 'email-draft' as const,
        payload: {
          to: ['person@example.com'],
          cc: ['team@example.com'],
          bcc: [],
          subject: 'Hello',
          body: 'Draft body.',
        },
      };
      const msg = makeToolResult(
        [{ type: 'text', text: 'Draft ready' }],
        {
          ui: {
            resourceUri: 'ui://google-workspace/compose-email',
            presentation: 'primary',
            viewSummary: '  Email draft to person@example.com — subject "Hello".  ',
            viewRoleLabel: 'Editable email draft',
            structuredFallback,
          },
        },
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toEqual({
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: 'Email draft to person@example.com — subject "Hello".',
        viewRoleLabel: 'Editable email draft',
        structuredFallback,
      });
    });

    it('truncates viewSummary above the display cap and logs a schema breadcrumb', () => {
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const msg = makeToolResult(
        [{ type: 'text', text: 'Draft ready' }],
        {
          ui: {
            resourceUri: 'ui://google-workspace/compose-email',
            presentation: 'primary',
            viewSummary: 'x'.repeat(281),
          },
        },
      );

      const toolEnd = collectToolHints(msg as any).find((e) => e.stage === 'end');

      expect(toolEnd?.mcpAppUiMeta?.viewSummary).toBe('x'.repeat(280));
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tu_test',
          originalLength: 281,
          truncatedLength: 280,
          source: 'schema',
        }),
        'MCP App viewSummary truncated at schema boundary',
      );
    });

    it.each([
      ['whitespace-only', '   ', ['viewSummary']],
      ['over 500 characters', 'x'.repeat(501), ['viewSummary']],
      ['HTML-bearing', '<script>alert("nope")</script>', ['viewSummary']],
      ['ANSI-bearing', '\x1b[31mhello', ['viewSummary']],
    ])('warns and drops invalid viewSummary at schema boundary: %s', (_label, viewSummary, fieldPath) => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const msg = makeToolResult(
        [{ type: 'text', text: 'Draft ready' }],
        {
          ui: {
            resourceUri: 'ui://google-workspace/compose-email',
            presentation: 'primary',
            viewSummary,
          },
        },
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tu_test',
          toolName: 'tu_test',
          method: 'Method 1',
          fieldPath,
          reason: expect.any(String),
          presentationDeclared: true,
          primaryPresentationRejected: true,
        }),
        'MCP App _meta.ui rejected at schema boundary; tool view will not render as primary',
      );
    });

    it('drops primary presentation without viewSummary at schema boundary', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const msg = makeToolResult(
        [{ type: 'text', text: 'Draft ready' }],
        {
          ui: {
            resourceUri: 'ui://google-workspace/compose-email',
            presentation: 'primary',
          },
        },
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tu_test',
          method: 'Method 1',
          fieldPath: ['viewSummary'],
          reason: "viewSummary is required when presentation is 'primary'",
          presentationDeclared: true,
          issues: expect.arrayContaining([
            expect.objectContaining({ fieldPath: ['viewSummary'] }),
          ]),
        }),
        'MCP App _meta.ui rejected at schema boundary; tool view will not render as primary',
      );
    });

    it('preserves structuredContent for MCP App Views', () => {
      const structuredContent = {
        to: 'person@example.com',
        subject: 'Hello',
        body: 'A properly filled form. Shocking.',
      };
      const msg = makeToolResult(
        [{ type: 'text', text: 'Draft ready' }],
        { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
        structuredContent,
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.toolResult).toEqual({
        content: [{ type: 'text', text: 'Draft ready' }],
        structuredContent,
      });
    });

    it('ignores _meta without ui property', () => {
      const msg = makeToolResult(
        [{ type: 'text', text: 'Done' }],
        { something: 'else' },
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
    });
  });

  describe('Method 0: Super-MCP use_tool envelope unwrap', () => {
    it('extracts resourceUri and structuredContent from Super-MCP use_tool envelope', () => {
      const structuredContent = {
        to: ['x@y'],
        subject: 'S',
        body: 'B',
      };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent,
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(toolEnd?.toolResult?.structuredContent).toEqual(structuredContent);
    });

    it('multiple tool_result blocks in same message each independently trigger heuristic', () => {
      const firstStructuredContent = { subject: 'First draft' };
      const secondStructuredContent = { subject: 'Second draft' };
      const firstEnvelopeText = makeUseToolEnvelopeText({
        result: {
          content: [{ type: 'text', text: 'First.\n\n[View: ui://google-workspace/compose-email]' }],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent: firstStructuredContent,
        },
      });
      const secondEnvelopeText = makeUseToolEnvelopeText({
        result: {
          content: [{ type: 'text', text: 'Second.\n\n[View: ui://google-workspace/compose-email-2]' }],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email-2' } },
          structuredContent: secondStructuredContent,
        },
      });
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const msg = {
        type: 'user' as const,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_first',
              content: [{ type: 'text', text: firstEnvelopeText }],
            },
            {
              type: 'tool_result',
              tool_use_id: 'tu_second',
              content: [{ type: 'text', text: secondEnvelopeText }],
            },
          ],
        },
      };

      const events = collectToolHints(msg as any);
      const toolEnds = events.filter((e) => e.stage === 'end');
      const envelopeDebugCalls = debugSpy.mock.calls.filter(
        ([, message]) => message === 'Super-MCP use_tool envelope detected; metadata adoption status logged',
      );

      expect(toolEnds).toHaveLength(2);
      expect(toolEnds[0]?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(toolEnds[0]?.toolResult?.structuredContent).toEqual(firstStructuredContent);
      expect(toolEnds[1]?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email-2');
      expect(toolEnds[1]?.toolResult?.structuredContent).toEqual(secondStructuredContent);
      expect(envelopeDebugCalls).toHaveLength(2);
      expect(envelopeDebugCalls.map(([payload]) => (payload as { toolUseId?: string }).toolUseId)).toEqual([
        'tu_first',
        'tu_second',
      ]);
    });

    it('skips metadata adoption for use_tool envelope with oversized_output placeholder', () => {
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          status: 'oversized_output',
          message: 'Output too large for context.',
          original_chars: 1_000_000,
          result_id: 'result-oversized',
        },
        suffix: '\n\n[Output too large for context. Use result_id to retrieve the full output.]',
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
    });

    it('preserves Method 3 [View:] regex when use_tool envelope has no inner _meta or structuredContent', () => {
      const envelopeText = makeUseToolEnvelopeText({
        packageId: 'my-app',
        toolId: 'show_page',
        result: {
          content: [
            {
              type: 'text',
              text: 'Open the page here: [View: ui://my-app/page]',
            },
          ],
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://my-app/page');
    });

    it('rejects bare ui:// Method 3 marker inside use_tool envelope text', () => {
      const infoSpy = vi.spyOn(mockAgentMessageHandlerLog, 'info');
      const envelopeText = makeUseToolEnvelopeText({
        packageId: 'my-app',
        toolId: 'show_page',
        result: {
          content: [
            {
              type: 'text',
              text: 'Do not treat placeholder prose as a view: [View: ui://...]',
            },
          ],
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('surfaces inner metadata from truncated use_tool envelopes with retrieval suffix', () => {
      const structuredContent = {
        to: ['x@y'],
        subject: 'Truncated but still usable',
        body: 'The UI metadata should survive the retrieval hint suffix.',
      };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent,
        },
        suffix:
          '\n\n[To retrieve the full untruncated result: use_tool({ package_id: "google-workspace", tool_id: "compose_workspace_email", args: {}, result_id: "result-123", output_offset: 0 })]',
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(toolEnd?.toolResult?.structuredContent).toEqual(structuredContent);
      expect(toolEnd?.detail).toBe(envelopeText);
    });

    it('preserves event.detail as outer envelope text after unwrap', () => {
      const structuredContent = {
        to: ['x@y'],
        subject: 'S',
        body: 'B',
      };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent,
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      const parsedDetail = JSON.parse(toolEnd?.detail ?? '{}');
      expect(parsedDetail.package_id).toBe('google-workspace');
      expect(parsedDetail.tool_id).toBe('compose_workspace_email');
    });

    it('skips metadata adoption for use_tool envelope with materialized placeholder', () => {
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          status: 'materialized',
          preserved_text: 'Large output saved outside context.',
          materialized_resource_id: 'mat-abc',
          file_path: 'super-mcp-results/mat-abc.json',
        },
        suffix: '\n\n[Materialized output saved to workspace: super-mcp-results/mat-abc.json]',
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
    });

    it('logs info-level signal for use_tool envelope with `[View:]` marker but missing inner metadata (silent-failure-risk case)', () => {
      const infoSpy = vi.spyOn(mockAgentMessageHandlerLog, 'info');
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Drafting email... [View: ui://google-workspace/compose-email]',
            },
          ],
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.detail).toBe(envelopeText);
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: 'google-workspace',
          toolId: 'compose_workspace_email',
          hasInnerMetaUi: false,
          hasInnerStructuredContent: false,
          hasInnerViewMarker: true,
          silentFailureRisk: true,
        }),
        expect.stringContaining('possible silent-failure regression'),
      );
    });

    it('skips metadata adoption for use_tool envelope with `dry_run: true` (Super-MCP dry-run preview)', () => {
      const infoSpy = vi.spyOn(mockAgentMessageHandlerLog, 'info');
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          dry_run: true,
          package_id: 'google-workspace',
          tool_id: 'compose_workspace_email',
          args: { to: ['x@y'] },
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('no info log for non-MCP-Apps use_tool envelope without `[View:]` marker', () => {
      const infoSpy = vi.spyOn(mockAgentMessageHandlerLog, 'info');
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const envelopeText = makeUseToolEnvelopeText({
        toolId: 'list_messages',
        argsUsed: { query: 'from:alice' },
        result: {
          content: [
            {
              type: 'text',
              text: 'Found 3 messages matching the query.',
            },
          ],
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      const envelopeDebugCalls = debugSpy.mock.calls.filter(
        ([, message]) => message === 'Super-MCP use_tool envelope detected; metadata adoption status logged',
      );
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(envelopeDebugCalls).toHaveLength(1);
      expect(envelopeDebugCalls[0]?.[0]).toEqual(
        expect.objectContaining({
          silentFailureRisk: false,
          hasInnerViewMarker: false,
        }),
      );
    });

    // T-NEW-10: malformed inner _meta.ui must NOT suppress the silent-failure canary.
    // hasInnerMetaUi is gated on a record-shaped ui with a non-empty string resourceUri.
    // Anything else (truthy primitive, empty record, array, missing resourceUri,
    // non-string resourceUri, empty-string resourceUri) is "unusable" and must
    // preserve silentFailureRisk: true so the log.info canary fires.
    it.each([
      ['empty _meta.ui object', {}],
      ['_meta.ui as string', 'not-an-object'],
      ['_meta.ui as array', []],
      ['_meta.ui without resourceUri', { other: 'field' }],
      ['_meta.ui with non-string resourceUri', { resourceUri: 42 }],
      ['_meta.ui with empty-string resourceUri', { resourceUri: '' }],
      // T-NEW-14: shape-invalid resourceUri values (Phase 7 codex DA findings).
      // These pass the old `length > 0` check but would fail the renderer
      // and / or super-mcp's "No package found for resource URI: ui://" branch.
      // The shared predicate uses the same shape rule as Method 3's
      // post-strip validation, so all four reject and the canary fires.
      ['_meta.ui with whitespace-only resourceUri', { resourceUri: '   ' }],
      ['_meta.ui with bare ui:// prefix', { resourceUri: 'ui://' }],
      ['_meta.ui with non-ui scheme', { resourceUri: 'https://example.com' }],
      // Null-byte: round-3 codex MEDIUM. Without rejecting C0 controls + DEL,
      // an injected `\u0000` would pass the `[^\s/]+` class.
      ['_meta.ui with null-byte resourceUri', { resourceUri: 'ui://\u0000pkg/x' }],
    ])('malformed inner _meta.ui (%s) does NOT suppress silent-failure-risk canary', (_label, malformedUi) => {
      const infoSpy = vi.spyOn(mockAgentMessageHandlerLog, 'info');
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Drafting email... [View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: malformedUi },
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');

      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          hasInnerMetaUi: false,
          silentFailureRisk: true,
        }),
        expect.stringContaining('possible silent-failure regression'),
      );
    });

    // T-NEW-11: production-shape string tool_result.content (not array).
    // agentMessageAdapter.toToolResultContent() emits a plain string when no
    // images are present. The string→array normalization at the top of the
    // tool_result branch must run BEFORE Method 0; verify the helper still
    // unwraps the envelope and surfaces inner metadata end-to-end.
    it('unwraps envelope when tool_result.content is a plain string (production shape)', () => {
      const structuredContent = {
        to: ['x@y'],
        subject: 'Production-shape draft',
        body: 'String content path coverage.',
      };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent,
        },
      });
      // Production agentMessageAdapter passes content as a STRING here, not an array.
      const msg = {
        type: 'user' as const,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_test',
              content: envelopeText,
            },
          ],
        },
      };

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(toolEnd?.toolResult?.structuredContent).toEqual(structuredContent);
      expect(toolEnd?.detail).toBe(envelopeText);
    });

    // T-NEW-12: parallel hardening — malformed OUTER _meta.ui must not shadow
    // usable inner metadata and must not suppress the silent-failure canary.
    // Forward-compat for the case where the agentMessageAdapter starts
    // preserving outer _meta on the use_tool block; today it's stripped, but
    // the predicate must agree on both sides regardless.
    it('malformed outer _meta.ui does NOT suppress silent-failure canary', () => {
      // Method 3 (text-marker fallback) will still pick up the inner [View:]
      // marker from the outer envelope text, so mcpAppUiMeta is populated.
      // What matters here: structuredContent is missing AND the canary fires
      // because the outer _meta.ui shape is unusable, just like the inner
      // case. Mirrors T-NEW-6 but with malformed outer instead of absent outer.
      const infoSpy = vi.spyOn(mockAgentMessageHandlerLog, 'info');
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Drafting email... [View: ui://google-workspace/compose-email]',
            },
          ],
        },
      });
      const msg = makeToolResult(
        [{ type: 'text', text: envelopeText }],
        { ui: {} }, // outer malformed (truthy but unusable)
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.toolResult?.structuredContent).toBeUndefined();
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          hasInnerMetaUi: false,
          silentFailureRisk: true,
        }),
        expect.stringContaining('possible silent-failure regression'),
      );
    });

    // T-NEW-13: malformed outer + usable inner — inner should win (precedence inversion
    // vs. old "truthy outer wins" path that silently absorbed unusable outer metadata).
    it('malformed outer _meta.ui falls through to usable inner metadata', () => {
      const structuredContent = {
        to: ['x@y'],
        subject: 'Inner wins when outer is malformed',
        body: 'B',
      };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent,
        },
      });
      const msg = makeToolResult(
        [{ type: 'text', text: envelopeText }],
        { ui: {} }, // outer malformed
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(toolEnd?.toolResult?.structuredContent).toEqual(structuredContent);
    });

    it('outer block already has `_meta.ui` / `structuredContent` — outer wins, no info log', () => {
      const infoSpy = vi.spyOn(mockAgentMessageHandlerLog, 'info');
      const structuredContent = { foo: 'bar' };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [],
        },
      });
      const msg = makeToolResult(
        [{ type: 'text', text: envelopeText }],
        { ui: { resourceUri: 'ui://outer/x' } },
        structuredContent,
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://outer/x');
      expect(toolEnd?.toolResult?.structuredContent).toEqual(structuredContent);
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('outer `_meta.ui` wins over inner envelope metadata and does not adopt Method 0 payload', () => {
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const outerStructuredContent = {
        to: ['outer@example.com'],
        subject: 'Outer subject',
        body: 'Outer body.',
      };
      const innerStructuredContent = {
        to: ['inner@example.com'],
        subject: 'Inner subject',
        body: 'Inner body.',
      };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Inner draft ready.\n\n[View: ui://inner/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://inner/compose-email' } },
          structuredContent: innerStructuredContent,
        },
      });
      const msg = makeToolResult(
        [{ type: 'text', text: envelopeText }],
        { ui: { resourceUri: 'ui://outer/compose-email' } },
        outerStructuredContent,
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://outer/compose-email');
      expect(toolEnd?.toolResult?.structuredContent).toBe(outerStructuredContent);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tu_test',
          packageId: 'google-workspace',
          toolId: 'compose_workspace_email',
          outerResourceUri: 'ui://outer/compose-email',
          innerResourceUri: 'ui://inner/compose-email',
        }),
        'super-mcp passthrough divergence: outer _meta.ui.resourceUri differs from inner — outer wins per contract; investigate super-mcp hoist correctness',
      );

      const envelopeDebugCall = debugSpy.mock.calls.find(
        ([, message]) => message === 'Super-MCP use_tool envelope detected; metadata adoption status logged',
      );
      expect(envelopeDebugCall?.[0]).toEqual(
        expect.objectContaining({
          hasInnerMetaUi: true,
          hasInnerStructuredContent: true,
          adoptedFromEnvelope: false,
          divergenceDetected: true,
        }),
      );
    });

    it('does not log divergence when outer and inner _meta.ui.resourceUri agree', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const debugSpy = vi.spyOn(mockAgentMessageHandlerLog, 'debug');
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
        },
      });
      const msg = makeToolResult(
        [{ type: 'text', text: envelopeText }],
        { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      const resourceDivergenceCalls = warnSpy.mock.calls.filter(
        ([, message]) => message === 'super-mcp passthrough divergence: outer _meta.ui.resourceUri differs from inner — outer wins per contract; investigate super-mcp hoist correctness',
      );
      const envelopeDebugCall = debugSpy.mock.calls.find(
        ([, message]) => message === 'Super-MCP use_tool envelope detected; metadata adoption status logged',
      );

      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(resourceDivergenceCalls).toHaveLength(0);
      expect(envelopeDebugCall?.[0]).toEqual(
        expect.objectContaining({
          divergenceDetected: false,
        }),
      );
    });

    it('logs divergence when outer and inner structuredContent shapes disagree', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const outerStructuredContent = { to: ['outer@example.com'] };
      const innerStructuredContent = ['inner@example.com'];
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent: innerStructuredContent,
        },
      });
      const msg = makeToolResult(
        [{ type: 'text', text: envelopeText }],
        { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
        outerStructuredContent,
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');

      expect(toolEnd?.toolResult?.structuredContent).toBe(outerStructuredContent);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tu_test',
          packageId: 'google-workspace',
          toolId: 'compose_workspace_email',
          outerStructuredShape: { kind: 'object', keys: ['to'] },
          innerStructuredContentShape: { kind: 'array', length: 1, elementShape: 'string' },
        }),
        'super-mcp passthrough divergence: outer structuredContent shape differs from inner — outer wins per contract; investigate super-mcp hoist correctness',
      );
    });

    it('logs divergence when outer and inner structuredContent object keys disagree', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const outerStructuredContent = {
        to: ['outer@example.com'],
        subject: 'Outer',
        body: 'Outer body.',
      };
      const innerStructuredContent = {
        to: ['inner@example.com'],
        cc: ['copy@example.com'],
        subject: 'Inner',
        body: 'Inner body.',
      };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
          structuredContent: innerStructuredContent,
        },
      });
      const msg = makeToolResult(
        [{ type: 'text', text: envelopeText }],
        { ui: { resourceUri: 'ui://google-workspace/compose-email' } },
        outerStructuredContent,
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');

      expect(toolEnd?.toolResult?.structuredContent).toBe(outerStructuredContent);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tu_test',
          packageId: 'google-workspace',
          toolId: 'compose_workspace_email',
          outerStructuredShape: { kind: 'object', keys: ['body', 'subject', 'to'] },
          innerStructuredContentShape: { kind: 'object', keys: ['body', 'cc', 'subject', 'to'] },
        }),
        'super-mcp passthrough divergence: outer structuredContent shape differs from inner — outer wins per contract; investigate super-mcp hoist correctness',
      );
    });

    it('does not log divergence when outer metadata is present and inner metadata is absent', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [{ type: 'text', text: 'Done.' }],
        },
      });
      const msg = makeToolResult(
        [{ type: 'text', text: envelopeText }],
        { ui: { resourceUri: 'ui://outer/no-inner' } },
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');

      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://outer/no-inner');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not log divergence when outer metadata is absent and inner metadata is present', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const structuredContent = { to: ['inner@example.com'] };
      const envelopeText = makeUseToolEnvelopeText({
        result: {
          content: [
            {
              type: 'text',
              text: 'Draft ready.\n\n[View: ui://inner/compose-email]',
            },
          ],
          _meta: { ui: { resourceUri: 'ui://inner/compose-email' } },
          structuredContent,
        },
      });
      const msg = makeToolResult([{ type: 'text', text: envelopeText }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');

      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://inner/compose-email');
      expect(toolEnd?.toolResult?.structuredContent).toEqual(structuredContent);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('Method 2: resource content block with MCP Apps mime type', () => {
    it('detects text/html;profile=mcp-app resource block', () => {
      const msg = makeToolResult([
        {
          type: 'resource',
          uri: 'ui://widget/chart',
          mimeType: 'text/html;profile=mcp-app',
          _meta: { ui: { csp: { resourceDomains: ['https://cdn.example.com'] } } },
        },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toEqual({
        resourceUri: 'ui://widget/chart',
        csp: { resourceDomains: ['https://cdn.example.com'] },
      });
    });

    it('detects text/html+mcp resource block', () => {
      const msg = makeToolResult([
        {
          type: 'resource',
          uri: 'ui://widget/chart',
          mimeType: 'text/html+mcp',
        },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://widget/chart');
    });

    it('propagates all A3a fields from resource content block _meta.ui', () => {
      const structuredFallback = {
        kind: 'plain' as const,
        payload: { markdown: 'Plain fallback body.' },
      };
      const msg = makeToolResult([
        {
          type: 'resource',
          uri: 'ui://widget/plain',
          mimeType: 'text/html+mcp',
          _meta: {
            ui: {
              presentation: 'primary',
              viewSummary: 'Plain fallback summary.',
              viewRoleLabel: 'Plain fallback view',
              structuredFallback,
            },
          },
        },
      ]);

      const toolEnd = collectToolHints(msg as any).find((e) => e.stage === 'end');

      expect(toolEnd?.mcpAppUiMeta).toEqual({
        resourceUri: 'ui://widget/plain',
        presentation: 'primary',
        viewSummary: 'Plain fallback summary.',
        viewRoleLabel: 'Plain fallback view',
        structuredFallback,
      });
      expect(toolEnd?.toolResult?.content).toEqual([
        expect.objectContaining({ uri: 'ui://widget/plain' }),
      ]);
    });
  });

  describe('Method 3: [View: ui://...] text marker (regex fallback)', () => {
    it('extracts simple dotless URI', () => {
      const msg = makeToolResult([
        { type: 'text', text: '[View: ui://google-workspace/compose-email]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
      expect(toolEnd?.mcpAppUiMeta?.presentation).toBe('inline');
    });

    it('does not promote prose-only [View:] marker results to primary', () => {
      const msg = makeToolResult([
        { type: 'text', text: 'Draft ready.\n\n[View: ui://google-workspace/compose-email]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toEqual({
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'inline',
      });
    });

    it('extracts URI with .html extension', () => {
      const msg = makeToolResult([
        { type: 'text', text: '[View: ui://google-workspace/compose-email.html]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email.html');
    });

    it('extracts URI with multiple dots (e.g. versioned path)', () => {
      const msg = makeToolResult([
        { type: 'text', text: '[View: ui://app/v2.1.0/dashboard]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://app/v2.1.0/dashboard');
    });

    it('strips trailing dot (sentence punctuation)', () => {
      const msg = makeToolResult([
        { type: 'text', text: 'Here is the form [View: ui://app/form.html].' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://app/form.html');
    });

    it('strips trailing semicolons and commas', () => {
      const msg = makeToolResult([
        { type: 'text', text: 'See [View: ui://app/page];' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://app/page');
    });

    it('handles extra whitespace after [View:', () => {
      const msg = makeToolResult([
        { type: 'text', text: '[View:   ui://app/dashboard]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://app/dashboard');
    });

    it('does not match bare ui:// URIs without [View:] wrapper', () => {
      const msg = makeToolResult([
        { type: 'text', text: 'The URI is ui://app/dashboard for reference.' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
    });

    it('does not match non-ui:// schemes', () => {
      const msg = makeToolResult([
        { type: 'text', text: '[View: https://example.com/form]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
    });

    it('skips [View:] fallback when _meta.ui already found', () => {
      const msg = makeToolResult(
        [{ type: 'text', text: '[View: ui://fallback/should-not-use]' }],
        { ui: { resourceUri: 'ui://primary/used' } },
      );

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://primary/used');
    });

    it('extracts URI with query parameters', () => {
      // Query params are unusual for ui:// URIs but should not break extraction
      const msg = makeToolResult([
        { type: 'text', text: '[View: ui://app/form?theme=dark]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://app/form?theme=dark');
    });

    it('handles URI embedded in larger text content', () => {
      const text = `Email compose form created successfully.

Draft data:
{"to":"user@example.com","subject":"Hello"}

[View: ui://google-workspace/compose-email]

The form above lets you review and edit the email before sending.`;

      const msg = makeToolResult([{ type: 'text', text }]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://google-workspace/compose-email');
    });
  });

  describe('Method 3: post-strip URI shape validation (regression guard for bare ui://)', () => {
    it('does NOT extract from literal ellipsis prose [View: ui://...]', () => {
      // Repro for 260423_method3_bare_ui_resource — prose about the bug itself used to
      // collapse to bare `ui://` after trailing-dot strip, and super-mcp then errored.
      const msg = makeToolResult([
        { type: 'text', text: 'fix summary ([View: ui://...] marker removed)' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
    });

    it('does NOT extract from punctuation-only capture [View: ui://..,;.]', () => {
      const msg = makeToolResult([
        { type: 'text', text: 'something [View: ui://..,;.] here' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
    });

    it('does NOT extract from bare [View: ui://.]', () => {
      const msg = makeToolResult([
        { type: 'text', text: '[View: ui://.]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta).toBeUndefined();
    });

    it('still extracts legitimate URI with trailing period (sentence end)', () => {
      // Regression guard: shape validation must not break the original reason for
      // the trailing-dot strip (clean up sentence-end punctuation on real URIs).
      const msg = makeToolResult([
        { type: 'text', text: 'Here is the form [View: ui://app/form.html].' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://app/form.html');
    });

    it('still extracts legitimate URI with dots inside host or path', () => {
      const msg = makeToolResult([
        { type: 'text', text: '[View: ui://app.v2/dashboard]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://app.v2/dashboard');
    });

    it('still extracts legitimate host-only URI (no path)', () => {
      // super-mcp accepts `ui://package-id` as a prefix for Strategy 1 lookup, so
      // the main process must not reject it.
      const msg = makeToolResult([
        { type: 'text', text: '[View: ui://my-package]' },
      ]);

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');
      expect(toolEnd?.mcpAppUiMeta?.resourceUri).toBe('ui://my-package');
    });
  });

  describe('Empty primary fallback canary (REBEL-5MF)', () => {
    function makeComposeEmailToolResult(payload: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
    }) {
      return makeToolResult(
        [{ type: 'text', text: `Drafting email\n\n[View: ui://google-workspace/compose-email]` }],
        {
          ui: {
            resourceUri: 'ui://google-workspace/compose-email',
            presentation: 'primary',
            viewSummary: 'Email draft summary',
            viewRoleLabel: 'Editable email draft',
            structuredFallback: {
              kind: 'email-draft',
              payload,
            },
          },
        },
        { ...payload, email: 'user@example.com' },
      );
    }

    it('fires warn when email-draft fallback payload is fully empty', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const msg = makeComposeEmailToolResult({
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        body: '',
      });

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');

      expect(toolEnd?.mcpAppUiMeta?.presentation).toBe('primary');
      const canaryCalls = warnSpy.mock.calls.filter(
        ([, message]) =>
          typeof message === 'string' &&
          message.includes('empty structuredFallback payload'),
      );
      expect(canaryCalls).toHaveLength(1);
      expect(canaryCalls[0]?.[0]).toMatchObject({
        structuredFallbackKind: 'email-draft',
        resourceUri: 'ui://google-workspace/compose-email',
      });
    });

    it('does NOT fire when email-draft fallback has body text', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const msg = makeComposeEmailToolResult({
        to: ['alice@example.com'],
        cc: [],
        bcc: [],
        subject: 'Project update',
        body: 'Hi Alice, here is the latest...',
      });

      const events = collectToolHints(msg as any);
      const toolEnd = events.find((e) => e.stage === 'end');

      expect(toolEnd?.mcpAppUiMeta?.presentation).toBe('primary');
      const canaryCalls = warnSpy.mock.calls.filter(
        ([, message]) =>
          typeof message === 'string' &&
          message.includes('empty structuredFallback payload'),
      );
      expect(canaryCalls).toHaveLength(0);
    });

    it('does NOT fire when only subject+to are present but body is empty (still has user-visible content)', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const msg = makeComposeEmailToolResult({
        to: ['alice@example.com'],
        cc: [],
        bcc: [],
        subject: 'Project update',
        body: '',
      });

      collectToolHints(msg as any);
      const canaryCalls = warnSpy.mock.calls.filter(
        ([, message]) =>
          typeof message === 'string' &&
          message.includes('empty structuredFallback payload'),
      );
      expect(canaryCalls).toHaveLength(0);
    });

    it('does NOT fire when presentation is inline (only fires on primary)', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const msg = makeToolResult(
        [{ type: 'text', text: '[View: ui://google-workspace/compose-email]' }],
        {
          ui: {
            resourceUri: 'ui://google-workspace/compose-email',
            presentation: 'inline',
            structuredFallback: {
              kind: 'email-draft',
              payload: { to: [], subject: '', body: '' },
            },
          },
        },
      );

      collectToolHints(msg as any);
      const canaryCalls = warnSpy.mock.calls.filter(
        ([, message]) =>
          typeof message === 'string' &&
          message.includes('empty structuredFallback payload'),
      );
      expect(canaryCalls).toHaveLength(0);
    });

    it('fires for plain fallback with empty markdown', () => {
      const warnSpy = vi.spyOn(mockAgentMessageHandlerLog, 'warn');
      const msg = makeToolResult(
        [{ type: 'text', text: '[View: ui://some-app/plain]' }],
        {
          ui: {
            resourceUri: 'ui://some-app/plain',
            presentation: 'primary',
            viewSummary: 'Plain fallback',
            structuredFallback: {
              kind: 'plain',
              payload: { markdown: '   \n  ' },
            },
          },
        },
      );

      collectToolHints(msg as any);
      const canaryCalls = warnSpy.mock.calls.filter(
        ([, message]) =>
          typeof message === 'string' &&
          message.includes('empty structuredFallback payload'),
      );
      expect(canaryCalls).toHaveLength(1);
      expect(canaryCalls[0]?.[0]).toMatchObject({ structuredFallbackKind: 'plain' });
    });
  });
});
