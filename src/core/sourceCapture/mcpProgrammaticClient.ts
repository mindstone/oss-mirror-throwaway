/**
 * Thin programmatic MCP client for the source-capture prefilter
 * (`docs/plans/260614_automation-cost-efficiency/` Part B, Stage 1).
 *
 * Owns the Super-MCP session lifecycle (open → calls → close in a try/finally)
 * and unwraps the `use_tool` JSON envelope so callers receive the connector's
 * raw `result` payload. This is the script-side equivalent of what the LLM does
 * when it calls `use_tool`, but invoked deterministically with no model in the
 * loop.
 *
 * Core-first: connects via the injected `superMcpUrl` (the eval supplies the
 * hermetic-twin router URL; prod would supply the live Super-MCP URL). No
 * electron imports.
 */

import { createMcpSession, type McpSession } from '@core/rebelCore/mcpClient';
import { parseUseToolEnvelopeJson } from '@core/rebelCore/superMcpEnvelope';
import { SUPER_MCP_META_TOOLS } from '@core/rebelCore/superMcpContract';
import { createScopedLogger } from '@core/logger';
import type { EnumerationSpec, PrefilterMcpCall } from './types';

const log = createScopedLogger({ service: 'sourceCapturePrefilterMcp' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Unwrap the connector payload from the `use_tool` envelope's `result` field.
 * The twin connectors return an MCP `CallToolResult` shape
 * (`{ content: [{ type: 'text', text: '<connector-json>' }] }`); the connector's
 * real data is the JSON-parsed text. Returns:
 *  - the parsed connector JSON when `result.content[].text` parses as an object,
 *  - the raw `result` itself when it is already a plain object (no content wrapper),
 *  - `undefined` when nothing usable can be extracted.
 */
function unwrapToolResult(result: unknown): unknown {
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content
      .filter((c): c is { type?: unknown; text?: unknown } => isRecord(c))
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      // Some connectors return plain text (not JSON); hand it back as a string
      // so an extractor can decide what to do (extractors tolerate non-objects).
      return text;
    }
  }
  // Already-unwrapped object (e.g. a connector that returns structured data
  // directly, or a future Super-MCP that inlines the payload).
  if (isRecord(result)) return result;
  return result ?? undefined;
}

/**
 * Open a Super-MCP session and return:
 *  - `mcpCall`: a {@link PrefilterMcpCall} that issues `use_tool` against the
 *    session and unwraps the envelope to the connector's raw `result`.
 *  - `close`: terminates the session (call in a finally).
 *  - `listPackageIds`: discovery via `list_tool_packages` (no LLM), for callers
 *    that want to verify a connector package is present before enumerating.
 *
 * Returns null if the session can't be opened (e.g. no URL / connection failed),
 * so callers fail loudly rather than silently producing an empty manifest.
 */
export async function openPrefilterMcpClient(
  superMcpUrl: string | null,
): Promise<{
  mcpCall: PrefilterMcpCall;
  listPackageIds: () => Promise<string[]>;
  close: () => Promise<void>;
} | null> {
  const session: McpSession | null = await createMcpSession(superMcpUrl);
  if (!session) {
    log.warn({ hasUrl: superMcpUrl !== null }, 'source-capture prefilter: could not open Super-MCP session');
    return null;
  }

  const mcpCall: PrefilterMcpCall = async (spec: EnumerationSpec) => {
    try {
      const exec = await session.executeTool(SUPER_MCP_META_TOOLS.USE_TOOL, {
        package_id: spec.package_id,
        tool_id: spec.tool_id,
        args: spec.args,
        // Disable Super-MCP output materialization: the prefilter is a script,
        // not the LLM, so it wants the FULL inline payload (not a file pointer
        // + the Read-tool hint the LLM would follow). `null` turns off the
        // materialization threshold entirely (useTool.ts:1120-1124).
        max_output_chars: null,
      });
      if (exec.isError) {
        return { ok: false as const, error: exec.output };
      }
      // The use_tool envelope is JSON text: { package_id, tool_id, result, ... }
      // where `result` is the connector's raw MCP CallToolResult
      // ({ content: [{ type: 'text', text: '<connector-json>' }], ... }).
      const envelope = parseUseToolEnvelopeJson<{ result?: unknown }>(exec.output);
      if (!envelope) {
        return { ok: false as const, error: 'unparseable use_tool envelope' };
      }
      const connectorPayload = unwrapToolResult(envelope.result);
      if (connectorPayload === undefined) {
        return { ok: false as const, error: 'could not unwrap connector result from use_tool envelope' };
      }
      return { ok: true as const, result: connectorPayload };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const listPackageIds = async (): Promise<string[]> => {
    try {
      const exec = await session.executeTool(SUPER_MCP_META_TOOLS.LIST_TOOL_PACKAGES, {});
      if (exec.isError) return [];
      const parsed = parseUseToolEnvelopeJson<{ packages?: Array<{ package_id?: string }> }>(exec.output);
      const packages = parsed?.packages ?? [];
      return packages.map((p) => p.package_id).filter((id): id is string => typeof id === 'string');
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, 'list_tool_packages failed');
      return [];
    }
  };

  return {
    mcpCall,
    listPackageIds,
    close: async () => {
      await session.close();
    },
  };
}
