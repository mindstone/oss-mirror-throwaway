/**
 * MCP Client for Rebel Core
 *
 * Connects to the already-running Super-MCP HTTP server to list available
 * tools and execute MCP tool calls. Uses a per-turn connection that is
 * created once and reused for all tool calls within the turn.
 *
 * The Super-MCP URL is injected by the caller to avoid importing from
 * @main/ (preserving core-first architecture).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
// eslint-disable-next-line no-restricted-syntax -- dns-decouple-justified: per-call MCP Agent wired through the centralized resolver selector (see MCP_HTTP_DISPATCHER below)
import { Agent as UndiciAgent } from 'undici';
import { createScopedLogger } from '@core/logger';
import { getDecoupledLookup, isCaresDnsEnabled } from '@core/utils/dnsThreadpoolDecouple';
import { delayWithAbort } from '@core/utils/delayWithAbort';
import { parseUseToolEnvelopeJson } from './superMcpEnvelope';
import {
  SUPER_MCP_META_TOOLS,
  SUPER_MCP_OUTER_META_ALLOWED_NAMESPACES,
  SUPER_MCP_READ_ONLY_META_TOOLS,
} from './superMcpContract';
import type { McpErrorInfo, McpErrorKind, OnMcpErrorCallback, ToolExecutionResult, TransportSeveranceSnapshot } from './types';
import type { ToolDefinition } from './modelTypes';

const log = createScopedLogger({ service: 'rebelCoreMcpClient' });

// Module-scope Undici dispatcher for the MCP Streamable HTTP client.
// Aligns transport-level idle timeouts with the agent-turn watchdog as the
// real ceiling instead of inheriting Node's defaults (300s bodyTimeout),
// which silently severs the SSE response stream when a `use_tool` request
// is queued behind another stdio call long enough for the queued-plus-
// executing window to exceed 5 minutes. See diagnosis:
// docs-private/investigations/260509_parallel_use_tool_result_dropped_codex_proxy.md
// This is a SEPARATE undici Agent — NOT covered by `setGlobalDispatcher` — so it
// must follow the same centralized resolver choice as global outbound HTTP
// (default OS resolver, c-ares only when opted in). See
// src/core/utils/dnsThreadpoolDecouple.ts and the DNS-starvation diagnosis:
// docs/plans/260617_meeting-bot-dns-starvation/PLAN.md
// eslint-disable-next-line no-restricted-syntax -- dns-decouple-justified: per-call MCP Agent (not covered by setGlobalDispatcher) wired through isCaresDnsEnabled()
const MCP_HTTP_DISPATCHER: UndiciAgent = new UndiciAgent({
  bodyTimeout: 0,
  headersTimeout: 60_000,
  keepAliveTimeout: 60_000,
  // Happy-eyeballs stays on for both resolver modes; c-ares lookup is included
  // only when the centralized selector opts into it.
  connect: isCaresDnsEnabled()
    ? { lookup: getDecoupledLookup(), autoSelectFamily: true }
    : { autoSelectFamily: true },
});

// Wrap the global `fetch` so EVERY fetch call the SDK's
// `StreamableHTTPClientTransport` makes — POST send(), GET _startOrAuthSse(),
// and DELETE terminateSession() — gets the module-scope Undici dispatcher.
// Going via `fetch:` (not `requestInit:`) is required because the SDK only
// spreads `requestInit` into the POST and DELETE `init` blobs; the GET SSE
// path calls `(this._fetch ?? fetch)(url, { method: 'GET', headers, signal })`
// with NO `requestInit` spread. Without dispatcher on GET, the standalone
// long-lived GET SSE inherits Undici's default 300s bodyTimeout and we'd
// fall right back into the original failure mode the moment that stream
// stays idle long enough. Node's global `fetch` is already undici under the
// hood, so we don't import undici's `fetch` separately to avoid hidden
// version drift.
const fetchWithDispatcher: typeof fetch = (input, init) =>
  fetch(input, { ...init, dispatcher: MCP_HTTP_DISPATCHER } as RequestInit);

// Scope of the dispatcher fix above: this file only.
// Other `StreamableHTTPClientTransport` instances in `src/main/`
// (mcpService.withSuperMcpClient, stagedToolCallsService, inboxHandlers,
// bugReportHandlers, mcpAppsHandlers) use shorter wall-clock timeouts
// (10–60s) and serve user-facing or batched UI operations where the
// queue+execute window is bounded well below Undici's default 300s
// bodyTimeout. If a future use case starts batching or queuing >2 minutes
// of work through one of those paths, extract a shared `createMcpClient()`
// helper and apply the same dispatcher + onerror narrowing there.

const MCP_CLIENT_INFO = {
  name: 'rebel-core',
  version: '1.0.0',
};

// 4-hour sentinel for every MCP tool call made from Rebel Core (list_tools,
// use_tool, authenticate, rebel_bridge_*, etc.). The agent-turn watchdog
// (`src/main/services/watchdogTracker.ts` AUTO_ABORT_MS) is the real
// effective ceiling for tool-in-flight; the LLM judge can extend that
// ceiling at runtime. This 4-hour value sits above the watchdog ceiling
// (and above its plausible judge extensions) so MCP-layer timeouts never
// win the race against legitimate long-running tools (deep research,
// pair waiting, large data queries, human-in-the-loop flows). It exists
// as a last-resort cap for pathological cases where the watchdog isn't
// running (tests, cloud routes that bypass the executor).
//
// Hard cap, not progress-extended: we do not pass `resetTimeoutOnProgress: true`,
// so a tool that emits frequent progress but never completes still gets killed.
// Users can cancel earlier via the Stop button (routes through AbortController
// in agentHandlers.ts).
//
// Related ceilings that must move together (Layer 0 → Layer 3):
//   - src/core/rebelCore/rebelCoreQuery.ts   TURN_WALL_CLOCK_DEADLINE_MS (Layer 0 sentinel)
//   - src/core/utils/timeoutAsyncIterator.ts DEFAULT_HARD_CAP_MS         (Layer 1 sentinel)
//   - src/main/services/watchdogTracker.ts   AUTO_ABORT_MS / STREAMING_STALL_ABORT_MS (Layer 2 — real ceiling)
//   - super-mcp/src/clients/httpClient.ts    SUPER_MCP_TOOL_TIMEOUT      (HTTP connectors)
//   - super-mcp/src/clients/stdioClient.ts   SUPER_MCP_TOOL_TIMEOUT      (stdio connectors, incl. RebelAppBridge)
//   - src/core/appBridge/server/hostRoutes.ts DEFAULT_PAIR_EVENTS_IDLE_TIMEOUT_MS
//   - src/core/appBridge/server/pairEventBus.ts REPLAY_TTL_MS
const TOOL_CALL_TIMEOUT = 4 * 60 * 60 * 1000;

/**
 * Centralizes per-call options forwarded to `client.callTool` so the
 * initial and retry call sites in `executeTool` can't diverge on
 * `timeout`/`signal`. Passing the externally-supplied `_signal` is what
 * lets watchdog cancellation (and any future per-call abort) settle
 * in-flight MCP calls via the SDK's per-request signal path
 * (protocol.js:675-717), which deletes the response handler and rejects
 * the awaiting promise. Without this forwarding, the SDK would only fall
 * back to the wall-clock `timeout` and the watchdog grace window would
 * fire before the call ever settled.
 */
async function callToolWithOptions(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  return client.callTool(
    { name: toolName, arguments: args },
    undefined,
    { timeout: TOOL_CALL_TIMEOUT, ...(signal ? { signal } : {}) },
  ) as unknown as Promise<Record<string, unknown>>;
}

const CONNECTION_MAX_ATTEMPTS = 3;
const CONNECTION_BASE_DELAY_MS = 200;
const MCP_ERROR_DATA_MAX_LEN = 2000;
// Keep in sync with: super-mcp/src/handlers/materializeOutput.ts, src/main/utils/agentTurnUtils.ts
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

/**
 * Super-MCP meta-tools known to be read-only (safe to retry after reconnect).
 * Any tool NOT in this set (e.g. use_tool, authenticate, restart_package) will
 * NOT be retried — the caller gets an advisory error instead.
 */
const READ_ONLY_META_TOOLS = new Set<string>(SUPER_MCP_READ_ONLY_META_TOOLS);

export function isReadOnlyMetaTool(toolName: string): boolean {
  return READ_ONLY_META_TOOLS.has(toolName);
}

export interface McpToolDefinition {
  apiToolName: string;
  tool: ToolDefinition;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Per-turn MCP session. Created once via createMcpSession(), reused for
 * all listTools/callTool invocations, then closed when the turn ends.
 */
export interface McpSession {
  listTools: () => Promise<McpToolDefinition[]>;
  executeTool: (toolName: string, input: unknown, toolUseId?: string, signal?: AbortSignal) => Promise<ToolExecutionResult>;
  close: () => Promise<void>;
}

/**
 * Optional callback fired from `client.onerror` so callers can record
 * per-session severance state (e.g. for later attachment to McpErrorInfo
 * diagnostic payloads). MUST NOT throw — caller wraps in try/catch but the
 * SDK doesn't.
 *
 * `forcedClose` is true when the severance triggered the
 * `FATAL_PRE_RESPONSE_PREFIX` fail-closed path. Note: the close itself still
 * runs inside `connectClient` regardless of whether a callback is provided —
 * the callback is purely observational.
 */
type SeveranceCallback = (error: unknown, forcedClose: boolean) => void;

async function connectClient(
  url: string,
  onSeverance?: SeveranceCallback,
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client(MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: fetchWithDispatcher,
  });
  // Narrowed fail-closed: the SDK's `_handleSseStream` outer catch
  // (streamableHttp.js:237) emits `new Error('SSE stream disconnected: ...')`
  // for any mid-stream error on EITHER the POST response stream OR the
  // standalone GET SSE stream (both paths share that helper). For the POST
  // stream that's the exact failure mode of the parallel-use_tool drop we
  // fix here: `Protocol._onerror` only notifies, pending `callTool` promises
  // stay in `_responseHandlers`, so we force `client.close()` to route
  // through the SDK's `_onclose` path, which rejects every pending entry
  // with a `ConnectionClosed` McpError. Reconnect happens on the next
  // `createMcpSession` (per-turn lifecycle).
  //
  // Two related observations:
  //
  //   - GET SSE PRE-stream failures (auth, 401, 405, connection refused,
  //     headers-timeout) propagate their original errors with distinct
  //     prefixes (`Streamable HTTP error: ...`, `Failed to open SSE stream:
  //     ...`, `Maximum reconnection attempts (N) exceeded.`, `Failed to
  //     reconnect SSE stream: ...`). Those don't match our prefix and the
  //     SDK's existing `_scheduleReconnection` handles them — we don't
  //     fail-closed on those.
  //   - GET SSE MID-stream errors DO go through the same shared catch and
  //     DO match our prefix. With the `fetchWithDispatcher` wrapper above
  //     applying `bodyTimeout: 0` to the GET path too, the most common
  //     trigger (idle GET inheriting Undici's 300s default) is eliminated;
  //     only true network/server severance remains, where closing the
  //     client and surfacing a clean error to the next caller IS the right
  //     behaviour — strictly better than letting in-flight POST promises
  //     hang for the watchdog grace window.
  //
  // POST send() failures (`Streamable HTTP error: Error POSTing to endpoint:
  // ...`) ALSO fire `onerror` BEFORE the rethrow that already triggers
  // `isSessionNotFoundError` → `ensureReconnected`. Those don't match our
  // prefix either, so the existing single-flight reconnect path is left
  // undisturbed.
  //
  // Blast-radius caveat: when this DOES match, ALL pending requests on the
  // client are rejected. That's acceptable because (a) super-mcp doesn't use
  // resumable streams so the SDK's reconnection path wouldn't run anyway,
  // and (b) the per-turn `createMcpSession` lifecycle means the next turn
  // gets a fresh client.
  const FATAL_PRE_RESPONSE_PREFIX = 'SSE stream disconnected';
  client.onerror = (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    const errName = error instanceof Error
      ? error.constructor?.name
      : typeof error;
    log.warn({ err: msg, errName, url }, 'MCP client transport error');

    const forcedClose = msg.startsWith(FATAL_PRE_RESPONSE_PREFIX);
    if (onSeverance) {
      try { onSeverance(error, forcedClose); } catch { /* observer must not break the error path */ }
    }
    if (forcedClose) {
      log.warn(
        { url },
        'Forcing client.close() on fatal pre-response SSE severance',
      );
      void client.close().catch(() => undefined);
    }
  };
  await client.connect(transport);
  return { client, transport };
}

export function safeStringify(value: unknown, maxLen: number): string {
  try {
    const seen = new WeakSet<object>();
    const maybeJson = JSON.stringify(value, (_key, currentValue) => {
      if (typeof currentValue === 'object' && currentValue !== null) {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }
      return currentValue;
    });
    const str = typeof maybeJson === 'string' ? maybeJson : String(maybeJson);
    if (str.length <= maxLen) return str;
    return `${str.slice(0, maxLen)}...[truncated]`;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

function getMcpErrorMessage(error: McpError): string {
  const prefix = `MCP error ${error.code}: `;
  if (error.message.startsWith(prefix)) {
    return error.message.slice(prefix.length);
  }
  return error.message;
}

function isStructuredMcpError(error: unknown): error is { code: number; message: string; data?: unknown } {
  return typeof error === 'object' && error !== null
    && 'code' in error && typeof (error as Record<string, unknown>).code === 'number'
    && 'message' in error && typeof (error as Record<string, unknown>).message === 'string';
}

/**
 * super-mcp's DOWNSTREAM_ERROR code: a structured wrapper around a downstream
 * connector's death (e.g. a stdio child like Brave Search closing its transport).
 * The wrapped message frequently contains "Connection closed" / "MCP error
 * -32000", which the substring checks below would otherwise mis-bucket as OUR
 * own `transport_connection_closed`. So we test this structured code FIRST.
 */
const MCP_DOWNSTREAM_ERROR_CODE = -33007;

/**
 * Delay between forcing a connector restart (`restart_package`) and re-issuing
 * the tool call on a `downstream_transport_closed` (-33007) failure. Gives the
 * child process time to come back up before the single bounded retry. Honors
 * the request's AbortSignal so a cancelled turn never waits the full delay.
 */
const CONNECTOR_RECONNECT_RETRY_DELAY_MS = 2_500;

/**
 * Classify an MCP-layer error into a discriminated kind for telemetry routing
 * and Sentry tagging.
 *
 * Ordering matters:
 *   1. A structured `-33007` (DOWNSTREAM_ERROR) is a DOWNSTREAM connector death,
 *      not severance of our own link to super-mcp — classify it as
 *      `downstream_transport_closed` BEFORE the message-substring checks, since
 *      its message usually contains "Connection closed" / "-32000".
 *   2. Then the message-pattern checks run BEFORE `instanceof McpError` so a
 *      hypothetical structured error with `message: 'Not connected'` still
 *      classifies as `transport_not_connected` rather than the generic
 *      `mcp_error` bucket.
 *
 * Best-effort — never throws.
 */
export function classifyMcpErrorKind(error: unknown): McpErrorKind {
  if (isStructuredMcpError(error) && error.code === MCP_DOWNSTREAM_ERROR_CODE) {
    return 'downstream_transport_closed';
  }
  const msg = error instanceof Error
    ? error.message
    : isStructuredMcpError(error)
      ? error.message
      : String(error);
  if (/^not connected$/i.test(msg)) return 'transport_not_connected';
  if (/\bconnection closed\b/i.test(msg)) return 'transport_connection_closed';
  if (/session not found/i.test(msg)) return 'session_not_found';
  if (error instanceof McpError || isStructuredMcpError(error)) return 'mcp_error';
  return 'unknown';
}

export function formatMcpToolError(error: unknown): string {
  if (error instanceof McpError) {
    return formatStructuredError(error.code, getMcpErrorMessage(error), error.data);
  }
  if (isStructuredMcpError(error)) {
    return formatStructuredError(error.code, error.message, error.data);
  }
  const msg = error instanceof Error ? error.message : String(error);
  return `MCP tool error: ${msg}`;
}

function formatStructuredError(code: number, message: string, data: unknown): string {
  const header = `MCP tool error [code=${code}]: ${message}`;
  if (data === undefined || data === null) return header;

  const dataRecord = (typeof data === 'object') ? data as Record<string, unknown> : null;
  const repairTicket = dataRecord?.repair_ticket;

  const lines = [header];
  if (repairTicket !== undefined) {
    lines.push(`Repair ticket: ${safeStringify(repairTicket, MCP_ERROR_DATA_MAX_LEN)}`);
  }

  // Show remaining data fields (excluding repair_ticket to avoid duplication)
  if (dataRecord && Object.keys(dataRecord).length > (repairTicket !== undefined ? 1 : 0)) {
    const { repair_ticket: _rt, ...rest } = dataRecord;
    lines.push(`Context: ${safeStringify(rest, MCP_ERROR_DATA_MAX_LEN)}`);
  } else if (!dataRecord) {
    lines.push(`Data: ${safeStringify(data, MCP_ERROR_DATA_MAX_LEN)}`);
  }

  // Enforce total output cap
  const full = lines.join('\n');
  if (full.length <= MCP_ERROR_DATA_MAX_LEN) return full;
  return `${full.slice(0, MCP_ERROR_DATA_MAX_LEN)}...[truncated]`;
}

// JSON-RPC INVALID_PARAMS. super-mcp's CallTool handler throws this with
// message `Unknown tool: <name>` for any name that is not one of its meta-tools
// (super-mcp/src/server.ts default case) — i.e. when the model emitted a
// downstream tool name (`rebel_inbox_list`, or the catalog form
// `RebelInbox__rebel_inbox_list`) as a TOP-LEVEL tool call instead of wrapping
// it in `use_tool`. See REBEL-61S.
const MCP_INVALID_PARAMS_CODE = -32602;

// The set of names super-mcp DOES accept as top-level calls. If super-mcp ever
// returns "Unknown tool" for one of THESE, it's a genuine contract regression /
// outage — not a model mistake — so the recovery shim below must NOT swallow it
// (review F1). Built from the contract authority so it can't drift.
const SUPER_MCP_META_TOOL_NAMES = new Set<string>(Object.values(SUPER_MCP_META_TOOLS));

/**
 * True when the error is super-mcp's `-32602 Unknown tool: <name>` — the model
 * called a connected-package tool by name at the top level instead of via the
 * `use_tool` meta-tool. Matched narrowly (code AND the `Unknown tool:` message
 * shape) so genuine INVALID_PARAMS errors against real meta-tools keep their
 * normal error path.
 */
function isUnknownToolError(error: unknown): boolean {
  let code: number | undefined;
  let message: string;
  if (error instanceof McpError) {
    code = error.code;
    message = getMcpErrorMessage(error);
  } else if (isStructuredMcpError(error)) {
    code = error.code;
    message = error.message;
  } else {
    return false;
  }
  return code === MCP_INVALID_PARAMS_CODE && /^Unknown tool:\s/i.test(message);
}

/**
 * Build an actionable correction for a downstream tool name that was called at
 * the top level (REBEL-61S). Returns an `isError` tool result whose text guides
 * the model back onto the discovery flow (`get_tool_details` → `use_tool`). The
 * guidance deliberately routes via `get_tool_details` first — not straight to
 * `use_tool` — to stay consistent with the get-details-before-use_tool rule (and
 * its enforcing gate), so this correction doesn't just bounce off that gate. For
 * the catalog `Package__tool` form the package/tool are parsed for an exact
 * example; for a bare name the model is pointed at `search_tools` / `list_tools`
 * to find the package. This is recoverable model behaviour, not an application
 * error — the caller intentionally returns this WITHOUT routing through the
 * `onMcpError` Sentry-capture path.
 */
function buildUnknownToolCorrection(toolName: string): ToolExecutionResult {
  // super-mcp namespaces catalog tools as `${packageId}__${toolName}`; the
  // package id is everything before the FIRST `__` (tool names use single `_`).
  const sepIdx = toolName.indexOf('__');
  if (sepIdx > 0) {
    const packageId = toolName.slice(0, sepIdx);
    const toolId = toolName.slice(sepIdx + 2);
    return {
      output:
        `"${toolName}" is not a directly callable tool. Tools from connected packages must be ` +
        `invoked through the "use_tool" meta-tool. First call get_tool_details(tool_ids=["${toolName}"]) ` +
        `to read the schema (if you haven't already), then re-issue as: use_tool with ` +
        `{ "package_id": "${packageId}", "tool_id": "${toolId}", "args": { /* the tool's arguments */ } }.`,
      isError: true,
    };
  }
  return {
    output:
      `"${toolName}" is not a directly callable tool. Tools from connected packages must be invoked ` +
      `through the "use_tool" meta-tool. Use "search_tools" or "list_tools" to find the package_id for ` +
      `"${toolName}", call get_tool_details for it to read the schema, then re-issue as: use_tool with ` +
      `{ "package_id": "<package>", "tool_id": "${toolName}", "args": { /* the tool's arguments */ } }.`,
    isError: true,
  };
}

// Defense-in-depth: hard cap on tool output entering conversation context.
// Should never fire when Super-MCP is working correctly — catches upstream bugs.
const MAX_TOOL_OUTPUT_CONTEXT_CHARS = 500_000;
const SHOULD_LOG_PASSTHROUGH_DEBUG =
  process.env['MINDSTONE_LOG_LEVEL'] === 'debug' ||
  process.env['MINDSTONE_LOG_LEVEL'] === 'trace' ||
  process.env['NODE_ENV'] === 'development' ||
  process.env['VITEST'] === 'true';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isModelVisibleMcpTool(tool: unknown): boolean {
  if (!isRecord(tool)) {
    return true;
  }

  // C3 visibility is currently carried on MCP tool `_meta.ui.visibility`.
  // The MCP SDK type does not expose this extension yet, so read it with a
  // narrow untyped projection until the upstream/manifest types catch up.
  const meta = isRecord(tool._meta) ? tool._meta : undefined;
  const ui = isRecord(meta?.ui) ? meta.ui : undefined;
  const visibility = ui?.visibility;
  if (visibility === undefined) {
    return true;
  }
  if (!Array.isArray(visibility)) {
    return true;
  }
  return visibility.includes('model');
}

/**
 * Super-MCP passthrough contract allowlist for outer `_meta` namespaces.
 * Keep in sync with docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md.
 */
const META_ALLOWED_NAMESPACES = new Set<string>(SUPER_MCP_OUTER_META_ALLOWED_NAMESPACES);

function filterMetaToAllowlist(meta: Record<string, unknown>): {
  filtered: Record<string, unknown> | undefined;
  droppedKeys: string[];
} {
  const keys = Object.keys(meta);
  let allowedKeyCount = 0;

  for (const key of keys) {
    if (
      META_ALLOWED_NAMESPACES.has(key)
    ) {
      allowedKeyCount += 1;
    }
  }

  if (keys.length === allowedKeyCount) {
    return {
      filtered: keys.length > 0 ? meta : undefined,
      droppedKeys: [],
    };
  }

  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const key of keys) {
    if (
      META_ALLOWED_NAMESPACES.has(key)
    ) {
      out[key] = meta[key];
    } else {
      dropped.push(key);
    }
  }

  return {
    filtered: Object.keys(out).length > 0 ? out : undefined,
    droppedKeys: dropped,
  };
}

export function processCallToolResult(result: Record<string, unknown>, toolUseId?: string): ToolExecutionResult {
  const contentArray = (result.content ?? []) as Array<Record<string, unknown>>;
  const textParts: string[] = [];
  const imageContent: NonNullable<ToolExecutionResult['imageContent']> = [];

  for (const entry of contentArray) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'text' && typeof entry.text === 'string') {
      textParts.push(entry.text);
      continue;
    }

    if (entry.type === 'image' && typeof entry.data === 'string' && typeof entry.mimeType === 'string') {
      const mimeType = entry.mimeType.toLowerCase();
      if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
        imageContent.push({
          type: 'image',
          data: entry.data,
          mimeType,
        });
      }
      continue;
    }

    if (entry.type === 'resource') {
      const resource = entry.resource;
      if (isRecord(resource) && typeof resource.blob === 'string' && !!resource.blob && typeof resource.mimeType === 'string') {
        const mimeType = resource.mimeType.toLowerCase();
        if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
          imageContent.push({
            type: 'image',
            data: resource.blob,
            mimeType,
          });
        }
      }
    }
  }

  let output = textParts.join('\n') || JSON.stringify(result.content ?? []);

  if (output.length > MAX_TOOL_OUTPUT_CONTEXT_CHARS) {
    const originalLength = output.length;
    output = output.slice(0, MAX_TOOL_OUTPUT_CONTEXT_CHARS)
      + `\n\n[Tool output truncated from ${originalLength.toLocaleString()} to ${MAX_TOOL_OUTPUT_CONTEXT_CHARS.toLocaleString()} chars to prevent context overflow. The full output may be available in a materialized file in .rebel/tool-outputs/.]`;
    log.warn(
      { originalLength, truncatedTo: MAX_TOOL_OUTPUT_CONTEXT_CHARS },
      'Tool output exceeded context size cap — truncated as defense-in-depth',
    );
  }

  const isError = result.isError === true;
  const rawMeta = result._meta;
  const meta = isRecord(rawMeta) ? rawMeta : undefined;
  if (rawMeta !== undefined && meta === undefined) {
    log.warn(
      {
        toolUseId,
        metaType: Array.isArray(rawMeta) ? 'array' : rawMeta === null ? 'null' : typeof rawMeta,
      },
      'super-mcp passthrough _meta malformed; dropping outer meta field',
    );
  }
  const structuredContent = result.structuredContent;
  const filteredMeta = meta ? filterMetaToAllowlist(meta) : undefined;
  if (filteredMeta && filteredMeta.droppedKeys.length > 0) {
    log.warn(
      {
        toolUseId,
        droppedKeys: filteredMeta.droppedKeys,
      },
      'super-mcp passthrough _meta dropped unknown namespaces — extend allowlist if intentional',
    );
  }
  const allowedMeta = filteredMeta?.filtered;
  if (SHOULD_LOG_PASSTHROUGH_DEBUG && (allowedMeta !== undefined || structuredContent !== undefined)) {
    log.debug(
      {
        toolUseId,
        hasMetaUi: isRecord(allowedMeta?.ui),
        hasStructuredContent: structuredContent !== undefined,
      },
      'super-mcp passthrough fields propagated',
    );
  }

  const toolExecutionResult: ToolExecutionResult = { output, isError };
  if (!isError && imageContent.length > 0) {
    toolExecutionResult.imageContent = imageContent;
  }
  if (allowedMeta !== undefined) {
    toolExecutionResult.meta = allowedMeta;
  }
  if (structuredContent !== undefined) {
    toolExecutionResult.structuredContent = structuredContent;
  }
  return toolExecutionResult;
}

/**
 * Detect "Session not found" errors from Super-MCP.
 * Conservative matching — only clear session loss patterns trigger reconnect.
 */
export function isSessionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  // "Session not found" text from super-mcp HTTP 404 response body
  if (/session not found/i.test(message)) return true;

  // MCP error code -32001 with session-related text (alternate server implementations).
  // Exclude timeout errors which also use code -32001 in this codebase.
  const code = typeof (error as Record<string, unknown>)?.code === 'number'
    ? (error as Record<string, unknown>).code as number
    : undefined;
  if (code === -32001 && /session/i.test(message) && !/timed?\s*out/i.test(message)) return true;

  return false;
}

function isPreflightTransportDisconnect(error: unknown): boolean {
  // Strictly matches the MCP SDK pre-flight disconnect path:
  // `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:619-621`
  // checks `!this._transport`, rejects with a bare `new Error('Not connected')`,
  // and returns before allocating the JSON-RPC id / request object or calling
  // `transport.send()`. Because no bytes leave the client in this path, retrying
  // after reconnect cannot duplicate a server-side side effect. Do NOT widen this
  // to McpError, structured/wrapped errors, Connection refused/closed, or POST
  // failures — those can be server-originated, mid-flight, or otherwise ambiguous.
  //
  // SDK version pin: verified against `@modelcontextprotocol/sdk` as bundled
  // 2026-05-21. If you upgrade the SDK, re-verify the cited line still throws
  // bare `Error('Not connected')` synchronously BEFORE any JSON-RPC allocation
  // or transport.send(). The bypass of read-only/idempotent gating in
  // `executeTool` depends on this invariant; if the SDK changes shape, this
  // predicate must be updated in lockstep or narrowed.
  if (!(error instanceof Error)) return false;
  if (error.constructor !== Error) return false;
  if (error.message !== 'Not connected') return false;
  if ('code' in error) return false;

  const ownPropertyNames = Object.getOwnPropertyNames(error)
    .filter((name) => name !== 'message' && name !== 'stack');
  if (ownPropertyNames.length > 0) return false;
  if (Object.getOwnPropertySymbols(error).length > 0) return false;

  return true;
}

/**
 * Create a per-turn MCP session connected to Super-MCP.
 * Retries with exponential backoff on transient connection failures.
 * Returns null if the URL is not available or all attempts fail.
 */
export async function createMcpSession(
  superMcpUrl: string | null,
  options?: {
    onMcpError?: OnMcpErrorCallback;
    getLatestUrl?: () => string | null;
    sessionId?: string;
  },
): Promise<McpSession | null> {
  if (!superMcpUrl) {
    return null;
  }

  const initialUrl: string = superMcpUrl;
  let client: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;
  let connectedAtMs: number | undefined;
  let lastSeveranceSnapshot: TransportSeveranceSnapshot | undefined;
  // Hoisted ahead of recordSeverance/connectClient call so the SDK's onerror
  // callback cannot reach a TDZ binding if it fires before connect() resolves.
  let generation = 0;
  const recordSeverance: SeveranceCallback = (error, forcedClose) => {
    const msg = error instanceof Error ? error.message : String(error);
    const errName = error instanceof Error ? error.constructor?.name : typeof error;
    lastSeveranceSnapshot = {
      atMs: Date.now(),
      reason: msg.slice(0, 200),
      errName,
      forcedClose,
      sessionGenerationAtSeverance: generation,
      connectionAgeMsAtSeverance: connectedAtMs !== undefined ? Date.now() - connectedAtMs : 0,
    };
  };

  for (let attempt = 1; attempt <= CONNECTION_MAX_ATTEMPTS; attempt++) {
    try {
      const connectedClient = await connectClient(superMcpUrl, recordSeverance);
      client = connectedClient.client;
      transport = connectedClient.transport;
      connectedAtMs = Date.now();
      if (attempt > 1) {
        log.info({ attempt }, 'Connected to Super-MCP after retry');
      }
      break;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const httpCode = (error as { code?: number }).code;
      const cause = (error as { cause?: Error }).cause?.message;
      if (attempt < CONNECTION_MAX_ATTEMPTS) {
        const delay = CONNECTION_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        log.warn({ err: errMsg, httpCode, cause, attempt, maxAttempts: CONNECTION_MAX_ATTEMPTS, retryInMs: delay, url: superMcpUrl }, 'Failed to connect to Super-MCP — retrying');
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      } else {
        log.warn({ err: errMsg, httpCode, cause, attempt, maxAttempts: CONNECTION_MAX_ATTEMPTS, url: superMcpUrl }, 'Failed to connect to Super-MCP — all attempts exhausted');
        return null;
      }
    }
  }

  // --- Session reconnect state (generation-aware single-flight) ---
  // `generation` is hoisted above to keep `recordSeverance` TDZ-safe.
  let reconnectPromise: Promise<number> | null = null;
  let initialToolNames: Set<string> | null = null;
  let closed = false;
  const OLD_CLIENT_CLEANUP_DELAY_MS = 2000;

  // Per-session cache of connector tool annotations (populated from use_tool responses)
  const connectorAnnotationsCache = new Map<string, { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }>();

  function injectRebelBrowserContext(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const sessionId = options?.sessionId;
    if (!sessionId) return args;

    if (toolName.startsWith('rebel_browser_')) {
      return { ...args, __rebel_conversation_id: sessionId };
    }

    if (
      toolName === SUPER_MCP_META_TOOLS.USE_TOOL &&
      typeof args.tool_id === 'string' &&
      args.tool_id.startsWith('rebel_browser_')
    ) {
      const nestedArgs =
        typeof args.args === 'object' && args.args !== null && !Array.isArray(args.args)
          ? args.args as Record<string, unknown>
          : {};
      return {
        ...args,
        args: {
          ...nestedArgs,
          __rebel_conversation_id: sessionId,
        },
      };
    }

    return args;
  }

  async function performReconnect(): Promise<number> {
    const oldClient = client;
    const oldTransport = transport;

    const freshUrl = options?.getLatestUrl?.() ?? initialUrl;
    const reconnected = await connectClient(freshUrl, recordSeverance);
    client = reconnected.client;
    transport = reconnected.transport;
    connectedAtMs = Date.now();
    generation++;

    // Deferred cleanup — in-flight sibling calls may still use the old client/transport
    setTimeout(() => {
      oldTransport?.terminateSession().catch(() => {});
      oldClient?.close().catch(() => {});
    }, OLD_CLIENT_CLEANUP_DELAY_MS);

    // Compare tool lists for observability (do not abort — just log drift)
    if (initialToolNames) {
      const baseline = initialToolNames;
      try {
        const result = await client.listTools();
        const newNames = new Set((result.tools ?? []).filter(isModelVisibleMcpTool).map(t => t.name));
        const added = [...newNames].filter(n => !baseline.has(n));
        const removed = [...baseline].filter(n => !newNames.has(n));
        if (added.length > 0 || removed.length > 0) {
          log.warn({ added, removed, generation }, 'MCP tool list changed after reconnect');
        }
      } catch (listErr) {
        log.warn({ err: listErr instanceof Error ? listErr.message : String(listErr) }, 'Failed to compare tool lists after reconnect');
      }
    }

    return generation;
  }

  async function ensureReconnected(callerGeneration: number): Promise<number> {
    if (closed) throw new Error('MCP session is closed');

    // Another caller already reconnected — just retry with new client
    if (callerGeneration < generation) {
      return generation;
    }

    // Reconnect already in-flight — join it
    if (reconnectPromise !== null) {
      log.debug({ callerGeneration, generation }, 'Joining existing MCP reconnect');
      return reconnectPromise;
    }

    // Start new single-flight reconnect
    const startTime = Date.now();

    reconnectPromise = performReconnect()
      .then((newGen) => {
        log.info({ generation: newGen, reconnectMs: Date.now() - startTime }, 'MCP session reconnected successfully');
        return newGen;
      })
      .catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'MCP reconnect failed');
        throw err;
      })
      .finally(() => {
        reconnectPromise = null;
      });

    return reconnectPromise;
  }

  /** Build error result for a failed tool call — logging, telemetry, formatting. */
  function handleToolCallError(
    error: unknown,
    toolName: string,
    callContext?: {
      toolUseId?: string;
      callGeneration?: number;
      requestSignalAborted?: boolean;
    },
  ): ToolExecutionResult {
    const errorKind = classifyMcpErrorKind(error);
    if (error instanceof McpError) {
      log.warn({ err: getMcpErrorMessage(error), toolName, code: error.code, hasData: !!error.data, errorKind }, 'MCP tool call failed');
    } else if (isStructuredMcpError(error)) {
      log.warn({ err: error.message, toolName, code: error.code, hasData: !!error.data, errorKind }, 'MCP tool call failed');
    } else {
      log.warn({ err: error instanceof Error ? error.message : String(error), toolName, errorKind }, 'MCP tool call failed');
    }
    // Best-effort telemetry — must not affect tool execution
    try {
      const errorInfo: McpErrorInfo = {
        operation: 'execute_tool',
        toolName,
        code: (error instanceof McpError) ? error.code : isStructuredMcpError(error) ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
        rawError: error,
        data: (error instanceof McpError) ? error.data : isStructuredMcpError(error) ? error.data : undefined,
        errorKind,
        toolUseId: callContext?.toolUseId,
        callGeneration: callContext?.callGeneration,
        sessionGeneration: generation,
        mcpSessionId: transport?.sessionId,
        requestSignalAborted: callContext?.requestSignalAborted,
        connectionAgeMs: connectedAtMs !== undefined ? Date.now() - connectedAtMs : undefined,
        lastTransportSeverance: lastSeveranceSnapshot,
      };
      options?.onMcpError?.(errorInfo);
    } catch {
      // telemetry must not break tool execution
    }
    const errorOutput = formatMcpToolError(error);
    const isTimeout = (error instanceof McpError && error.code === -32001) ||
      (typeof errorOutput === 'string' && errorOutput.includes('timed out'));
    const output = isTimeout && !errorOutput.includes(toolName)
      ? `${errorOutput} (tool: ${toolName})`
      : errorOutput;
    return { output, isError: true };
  }

  /**
   * Best-effort cache of connector tool annotations from use_tool responses.
   * Parsing failures are silently ignored — must not affect tool execution.
   */
  function cacheConnectorAnnotations(
    toolName: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
  ): void {
    if (toolName !== SUPER_MCP_META_TOOLS.USE_TOOL) return;
    if (typeof args.package_id !== 'string' || typeof args.tool_id !== 'string') return;
    try {
      const content = result.content as Array<{ type?: string; text?: string }> | undefined;
      if (!content) return;
      const textPart = content.find(c => c.type === 'text' && typeof c.text === 'string');
      if (!textPart?.text) return;

      // Strip any "\n\n[suffix]" appended by Super-MCP (continuation hint,
      // large-output warning, oversized-output placeholder) before parsing.
      const parsed = parseUseToolEnvelopeJson<{ annotations?: Record<string, unknown> }>(textPart.text);
      if (!parsed) return;
      if (parsed.annotations && typeof parsed.annotations === 'object') {
        const cacheKey = `${args.package_id}:${args.tool_id}`;
        connectorAnnotationsCache.set(cacheKey, {
          readOnlyHint: parsed.annotations.readOnlyHint as boolean | undefined,
          destructiveHint: parsed.annotations.destructiveHint as boolean | undefined,
          idempotentHint: parsed.annotations.idempotentHint as boolean | undefined,
        });
      }
    } catch {
      // Best-effort — parsing failure must not affect tool execution
    }
  }

  return {
    async listTools(): Promise<McpToolDefinition[]> {
      if (!client) return [];

      try {
        const result = await client.listTools();
        if (!result.tools || result.tools.length === 0) return [];
        const visibleTools = result.tools.filter(isModelVisibleMcpTool);

        const definitions: McpToolDefinition[] = visibleTools.map((mcpTool) => ({
          apiToolName: mcpTool.name,
          tool: {
            name: mcpTool.name,
            description: mcpTool.description ?? '',
            input_schema: (mcpTool.inputSchema as ToolDefinition['input_schema']) ?? {
              type: 'object' as const,
              properties: {},
            },
          },
          ...(mcpTool.annotations ? { annotations: mcpTool.annotations } : {}),
        }));

        // Capture initial tool set on first successful call (for reconnect drift detection)
        if (initialToolNames === null) {
          initialToolNames = new Set(definitions.map(d => d.apiToolName));
        }

        log.info(
          { toolCount: definitions.length, hiddenAppOnlyToolCount: result.tools.length - visibleTools.length },
          'Listed MCP tools from Super-MCP',
        );
        return definitions;
      } catch (error) {
        const errorKind = classifyMcpErrorKind(error);
        if (error instanceof McpError) {
          log.warn({ err: error.message, code: error.code, hasData: !!error.data, errorKind }, 'Failed to list MCP tools');
        } else if (isStructuredMcpError(error)) {
          log.warn({ err: error.message, code: error.code, hasData: !!error.data, errorKind }, 'Failed to list MCP tools');
        } else {
          log.warn({ err: error instanceof Error ? error.message : String(error), errorKind }, 'Failed to list MCP tools');
        }
        // Best-effort telemetry — must not affect tool execution
        try {
          const errorInfo: McpErrorInfo = {
            operation: 'list_tools',
            code: (error instanceof McpError) ? error.code : isStructuredMcpError(error) ? error.code : undefined,
            message: error instanceof Error ? error.message : String(error),
            rawError: error,
            data: (error instanceof McpError) ? error.data : isStructuredMcpError(error) ? error.data : undefined,
            errorKind,
            sessionGeneration: generation,
            mcpSessionId: transport?.sessionId,
            connectionAgeMs: connectedAtMs !== undefined ? Date.now() - connectedAtMs : undefined,
            lastTransportSeverance: lastSeveranceSnapshot,
          };
          options?.onMcpError?.(errorInfo);
        } catch {
          // telemetry must not break tool execution
        }
        return [];
      }
    },

    async executeTool(
      toolName: string,
      input: unknown,
      toolUseId?: string,
      _signal?: AbortSignal,
    ): Promise<ToolExecutionResult> {
      if (!client) {
        return { output: 'MCP session is not connected', isError: true };
      }

      const myGeneration = generation;
      const rawArgs = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {};
      const args = injectRebelBrowserContext(toolName, rawArgs);

      // Forward `_signal` to the SDK so watchdog cancellation actually
      // settles in-flight MCP calls. Without this, the SDK's per-request
      // signal path (protocol.js:675-717) — which deletes the response
      // handler and rejects the awaiting promise — never runs.
      const requestSignal = _signal;

      try {
        const result = await callToolWithOptions(client, toolName, args, requestSignal);
        cacheConnectorAnnotations(toolName, args, result);
        return processCallToolResult(result, toolUseId);
      } catch (error) {
        // Pre-flight transport disconnect → reconnect + retry once.
        // This intentionally bypasses readOnlyHint/idempotentHint gating:
        // `isPreflightTransportDisconnect` only matches the SDK's synchronous
        // `Protocol.request`/`_send` guard before any JSON-RPC is sent, so the
        // original call provably had no server-side side effect to duplicate.
        if (isPreflightTransportDisconnect(error)) {
          try {
            await ensureReconnected(myGeneration);
          } catch {
            // Reconnect failed — return the original pre-flight disconnect error
            return handleToolCallError(error, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }

          if (!client) {
            return { output: 'MCP session is not connected after reconnect', isError: true };
          }

          log.info(
            { toolName, retryDecision: 'retry', retryReason: 'preflight_transport_disconnect' },
            'MCP reconnect: retrying after pre-flight transport disconnect',
          );

          try {
            const retryResult = await callToolWithOptions(client, toolName, args, requestSignal);
            cacheConnectorAnnotations(toolName, args, retryResult);
            return processCallToolResult(retryResult, toolUseId);
          } catch (retryError) {
            return handleToolCallError(retryError, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }
        }

        // Session-not-found → single-flight reconnect + one retry
        if (isSessionNotFoundError(error)) {
          try {
            await ensureReconnected(myGeneration);
          } catch {
            // Reconnect failed — return the original session-not-found error
            return handleToolCallError(error, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }

          // Gate: retry read-only meta-tools; for use_tool, check connector annotations
          if (!isReadOnlyMetaTool(toolName)) {
            if (toolName === SUPER_MCP_META_TOOLS.USE_TOOL) {
              const cacheKey = `${args.package_id}:${args.tool_id}`;
              const connAnns = connectorAnnotationsCache.get(cacheKey);
              const isSafeToRetry =
                connAnns !== undefined
                && (connAnns.readOnlyHint === true || connAnns.idempotentHint === true)
                && connAnns.destructiveHint !== true;

              if (!isSafeToRetry) {
                log.warn(
                  { toolName, packageId: args.package_id, toolId: args.tool_id, hasAnnotation: !!connAnns, retryDecision: 'skip' },
                  'MCP reconnect: skipping retry for use_tool without safe connector annotation',
                );
                return {
                  output: `Tool connection was lost during execution of ${args.package_id || 'unknown'}/${args.tool_id || 'unknown'}. This action may have already been performed — please verify the current state before retrying manually.`,
                  isError: true,
                };
              }
              log.info(
                { toolName, packageId: args.package_id, toolId: args.tool_id, retryDecision: 'retry' },
                'MCP reconnect: retrying use_tool with safe connector annotation',
              );
            } else {
              log.warn(
                { toolName, retryDecision: 'skip' },
                'MCP reconnect: skipping retry for non-read-only meta-tool',
              );
              return {
                output: 'Tool connection was lost during execution. This action may have already been performed — please verify the current state before retrying manually.',
                isError: true,
              };
            }
          } else {
            log.info({ toolName, retryDecision: 'retry' }, 'MCP reconnect: retrying read-only meta-tool');
          }

          // Retry once with reconnected client
          if (!client) {
            return { output: 'MCP session is not connected after reconnect', isError: true };
          }

          try {
            const retryResult = await callToolWithOptions(client, toolName, args, requestSignal);
            cacheConnectorAnnotations(toolName, args, retryResult);
            return processCallToolResult(retryResult, toolUseId);
          } catch (retryError) {
            return handleToolCallError(retryError, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }
        }

        // Downstream connector transport death (-33007 → `downstream_transport_closed`).
        // The dead handle is super-mcp ↔ its child process (NOT Rebel ↔ super-mcp),
        // so a plain reconnect of OUR link won't help and a bare retry can hit the
        // same dead handle (the -32000 reuse-of-stale-transport reap race). Force a
        // real child restart via super-mcp's `restart_package` meta-tool, wait a
        // bounded abortable delay, then retry the original call EXACTLY ONCE.
        //
        // SAFETY: idempotency-gated, fail-safe by DEFAULT. We only retry when the
        // connector tool is provably safe to re-run (readOnly/idempotent and not
        // destructive, from the per-session annotations cache). When in doubt —
        // unknown annotations, destructive, missing/non-string package_id, or any
        // call that isn't a `use_tool` carrying package_id/tool_id — we DENY the
        // retry and fall through to the honest B2 failure copy. We NEVER blindly
        // re-run a tool that may have already partially executed.
        if (classifyMcpErrorKind(error) === 'downstream_transport_closed') {
          // Gate 1: must be a `use_tool` call with a string package_id.
          if (toolName !== SUPER_MCP_META_TOOLS.USE_TOOL || typeof args.package_id !== 'string') {
            log.warn(
              { toolName, retryReason: 'downstream_transport_closed', skipReason: 'no-package-id' },
              'MCP connector reconnect: skipping retry — not a use_tool call with package_id',
            );
            return handleToolCallError(error, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }

          // Gate 2: idempotency annotations must say it's safe to re-run.
          const cacheKey = `${args.package_id}:${args.tool_id}`;
          const connAnns = connectorAnnotationsCache.get(cacheKey);
          const isSafeToRetry =
            connAnns !== undefined
            && (connAnns.readOnlyHint === true || connAnns.idempotentHint === true)
            && connAnns.destructiveHint !== true;

          if (!isSafeToRetry) {
            const skipReason =
              connAnns === undefined ? 'no-annotation'
                : connAnns.destructiveHint === true ? 'destructive'
                  : 'not-idempotent';
            log.warn(
              {
                toolName,
                packageId: args.package_id,
                toolId: args.tool_id,
                retryReason: 'downstream_transport_closed',
                skipReason,
              },
              'MCP connector reconnect: skipping retry — connector not safe to re-run',
            );
            return handleToolCallError(error, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }

          log.info(
            {
              toolName,
              packageId: args.package_id,
              toolId: args.tool_id,
              readOnlyHint: connAnns?.readOnlyHint,
              idempotentHint: connAnns?.idempotentHint,
              retryReason: 'downstream_transport_closed',
              forcedRestart: true,
            },
            'MCP connector reconnect: forcing restart_package before single retry',
          );

          // Force the child to restart. If THIS fails, the handle is still dead —
          // do not retry against it; fall through to honest failure.
          //
          // super-mcp's `restart_package` signals failure two ways: it can THROW,
          // or (when the package is missing/invalid) it RETURNS a result with
          // `isError: true` (success:false) WITHOUT throwing. Treat both the same:
          // a non-throw isError result means the child did NOT come back, so retrying
          // would just hit the same dead handle. Route it to the identical honest
          // failure outcome (original -33007 error, no delay, no retry).
          try {
            const restartResult = await callToolWithOptions(
              client,
              SUPER_MCP_META_TOOLS.RESTART_PACKAGE,
              { package_id: args.package_id },
              requestSignal,
            );
            if (restartResult.isError === true) {
              log.warn(
                {
                  toolName,
                  packageId: args.package_id,
                  retryReason: 'downstream_transport_closed',
                },
                'MCP connector reconnect: restart_package failed — not retrying',
              );
              return handleToolCallError(error, toolName, {
                toolUseId,
                callGeneration: myGeneration,
                requestSignalAborted: requestSignal?.aborted,
              });
            }
          } catch (restartError) {
            log.warn(
              {
                toolName,
                packageId: args.package_id,
                err: restartError instanceof Error ? restartError.message : String(restartError),
                retryReason: 'downstream_transport_closed',
              },
              'MCP connector reconnect: restart_package failed — not retrying',
            );
            return handleToolCallError(error, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }

          // Bounded, abortable delay before the retry.
          const aborted = await delayWithAbort(CONNECTOR_RECONNECT_RETRY_DELAY_MS, requestSignal);
          if (aborted) {
            log.info(
              { toolName, packageId: args.package_id, retryReason: 'downstream_transport_closed' },
              'MCP connector reconnect: aborted during delay — not retrying',
            );
            return handleToolCallError(error, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }

          if (!client) {
            return { output: 'MCP session is not connected after connector restart', isError: true };
          }

          // Exactly ONE retry. Success → user sees nothing. Failure → honest copy.
          try {
            const retryResult = await callToolWithOptions(client, toolName, args, requestSignal);
            cacheConnectorAnnotations(toolName, args, retryResult);
            log.info(
              { toolName, packageId: args.package_id, retryReason: 'downstream_transport_closed' },
              'MCP connector reconnect: retry succeeded after restart_package',
            );
            return processCallToolResult(retryResult, toolUseId);
          } catch (retryError) {
            log.warn(
              { toolName, packageId: args.package_id, retryReason: 'downstream_transport_closed' },
              'MCP connector reconnect: retry failed after restart_package',
            );
            return handleToolCallError(retryError, toolName, {
              toolUseId,
              callGeneration: myGeneration,
              requestSignalAborted: requestSignal?.aborted,
            });
          }
        }

        // Model called a downstream package tool by name at the top level
        // instead of via `use_tool` → super-mcp returns `-32602 Unknown tool`.
        // This is expected, recoverable model behaviour (esp. the scheduled
        // inbox automations that prompt bare `rebel_inbox_*` names — REBEL-61S,
        // 146 users). Return actionable `use_tool` guidance so the model
        // self-corrects, and treat it as HANDLED — log a breadcrumb but do NOT
        // route it through `onMcpError`, so it stops generating Sentry error
        // events. (The first bad call still happens; the durable reduction is
        // the prompt-fix/auto-rewrite follow-up.)
        //
        // Guard (review F1): only for NON-meta-tool names. If super-mcp returns
        // "Unknown tool" for a real meta-tool (`use_tool`, `list_tools`, …) that
        // is a genuine contract regression/outage — fall through to the normal
        // telemetry path so it surfaces as an alert rather than being masked by
        // bogus self-referential guidance.
        if (isUnknownToolError(error) && !SUPER_MCP_META_TOOL_NAMES.has(toolName)) {
          log.warn(
            { toolName, code: MCP_INVALID_PARAMS_CODE, errorKind: 'unknown_tool' },
            'MCP tool call used a downstream tool name at the top level; returning use_tool guidance',
          );
          return buildUnknownToolCorrection(toolName);
        }

        return handleToolCallError(error, toolName, {
          toolUseId,
          callGeneration: myGeneration,
          requestSignalAborted: requestSignal?.aborted,
        });
      }
    },

    async close(): Promise<void> {
      closed = true;
      // Wait for any in-flight reconnect to settle before cleanup
      if (reconnectPromise) {
        try { await reconnectPromise; } catch { /* ignore — we're closing */ }
      }
      try {
        await transport?.terminateSession();
      } catch {
        // Ignore cleanup errors
      }
      try {
        await client?.close();
      } catch {
        // Ignore cleanup errors
      }
      client = null;
      transport = null;
    },
  };
}

/**
 * Check if a tool name is an MCP-routed tool (not a built-in).
 */
export function isMcpToolName(toolName: string): boolean {
  const BUILTIN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'SearchFiles', 'Glob', 'LS', 'Agent', 'Task', 'TaskOutput', 'TodoWrite', 'suggest_connector_setup', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Skill', 'NotebookEdit', 'TaskStop']);
  return !BUILTIN_TOOLS.has(toolName);
}
