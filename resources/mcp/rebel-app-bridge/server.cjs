#!/usr/bin/env node
/**
 * RebelAppBridge MCP Server — stdio surface for App Bridge capabilities.
 *
 * Stage 4 delivers seven browser tools that relay through the App Bridge
 * host (`src/core/appBridge/server/bridge.ts`) over localhost HTTP:
 *
 *   tools/list   → the 7 tools defined in ./tools/browser.js
 *   tools/call   → POST http://127.0.0.1:<port>/apps/browser-extension/<capability>
 *                  Authorization: Bearer <routerToken>       (from state.json)
 *                  X-Rebel-App-Id: browser-extension         (route echo)
 *
 * The state file is always at the path in `REBEL_APP_BRIDGE_STATE`; the host
 * writes it on start and deletes it on stop. We read it on *every* tool call
 * rather than caching, because a restart issues a new `routerToken` and the
 * port can move between runs. Missing / stale state files translate to a
 * structured MCP error ("bridge isn't running") — never a silent failure.
 *
 * Security:
 *   - The router-internal token must only travel between this MCP process
 *     and the bridge on the same host. We never log it and never echo it.
 *   - The MCP server itself doesn't accept inbound network traffic — it's
 *     stdio-only, spawned as a subprocess of the main Rebel process.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */
// MUST be the first non-comment statement — see docs/plans/260428_graceful_fs_emfile_fix.md
// Uses globalThis.process so files that later `const process = require('node:process')` don't trigger TDZ.
if (globalThis.process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') {
  try { require('graceful-fs').gracefulify(require('node:fs')); } catch (e) {
    globalThis.__REBEL_BOOTSTRAP_LEAF_ERROR__ = { kind: 'graceful_fs_leaf_install_failed', error: { name: e?.name, message: e?.message, stack: e?.stack }, at: Date.now() };
    if (globalThis.process.env.REBEL_DEBUG_BOOTSTRAP === '1') console.warn('[installGracefulFs] failed:', e);
  }
}
const process = require('node:process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { TOOLS_BY_APP_ID, ROUTE_BY_TOOL_NAME } = require('./tools');
const { discoverBridge } = require('./bridge-discovery');
const { handleHostTool } = require('./tools/host');

// ---------------------------------------------------------------------------
// Server instance + tool registration
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'RebelAppBridge',
  version: '0.1.0',
  description:
    'Relays Rebel browser-extension (and future app-bridge-hosted) tools over localhost HTTP.',
});

const STATE_FILE_PATH = process.env.REBEL_APP_BRIDGE_STATE || null;

// Register every tool once so `tools/list` returns the full catalogue even
// when the bridge happens to be stopped — the tool description still helps
// the agent decide whether to call it.
for (const [appId, tools] of Object.entries(TOOLS_BY_APP_ID)) {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      // eslint-disable-next-line no-loop-func -- `appId`/`tool` are block-scoped; one handler per iteration is intentional.
      async (input) => handleToolCall({ appId, tool, input }),
    );
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Shape of the `data` key on a successful relay response.
 * The bridge returns `{ success: true, commandId, data }`; we render `data`
 * as JSON text so the agent sees the raw shape. Anything non-standard
 * just round-trips unchanged.
 */
const RelayResponseSchema = z.object({
  success: z.literal(true),
  commandId: z.string(),
  data: z.unknown(),
});

/**
 * Structured relay error envelope, mirroring the shared `AppBridgeError`
 * JSON on `src/core/appBridge/shared/errors.ts`.
 */
const RelayErrorSchema = z.object({
  success: z.literal(false),
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  commandId: z.string().optional(),
});

async function handleToolCall({ appId, tool, input }) {
  if (appId === '__host') {
    try {
      return await handleHostTool(tool.name, input);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`[RebelAppBridge] Host tool failed: ${message}`);
      return renderError({
        code: 'APP_BRIDGE_HOST_TOOL_ERROR',
        text: `The Rebel App Bridge host tool "${tool.name}" failed: ${message}`,
      });
    }
  }

  const discovery = discoverBridge(STATE_FILE_PATH);
  if (!discovery.ok) {
    return renderBridgeOffline(discovery.reason);
  }

  const { port, routerToken } = discovery.state;
  const url = `http://127.0.0.1:${port}/apps/${encodeURIComponent(appId)}/${encodeURIComponent(tool.capability)}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${routerToken}`,
        'X-Rebel-App-Id': appId,
      },
      body: JSON.stringify({ payload: input ?? {} }),
    });
  } catch (err) {
    // ECONNREFUSED means the state file won the PID-alive race but the
    // HTTP listener has already shut down. Treat it the same as stale-state.
    const msg = err && err.message ? err.message : String(err);
    return renderError({
      code: 'APP_BRIDGE_UNREACHABLE',
      text:
        'I couldn\'t reach the Rebel App Bridge on this machine. ' +
        'It may be starting up or have just stopped — try again in a moment. ' +
        `(internal: ${msg})`,
    });
  }

  return await renderRelayResponse(response, { toolName: tool.name, capability: tool.capability });
}

/**
 * Translate a bridge reason into Rebel-voice copy. Matches the MCP content
 * converter in `shared/errors.ts` where possible (e.g., 'APP_NOT_CONNECTED'
 * copy).
 */
function renderBridgeOffline(reason) {
  switch (reason) {
    case 'no-state-path':
      return renderError({
        code: 'APP_BRIDGE_NOT_CONFIGURED',
        text:
          "The Rebel App Bridge isn't configured for this MCP process. " +
          "That's an installer bug — let the Rebel team know.",
      });
    case 'missing-state':
      return renderError({
        code: 'APP_BRIDGE_NOT_RUNNING',
        text:
          "The Rebel App Bridge isn't running. Start Rebel (or reopen it) and try again.",
      });
    case 'stale-state':
    default:
      return renderError({
        code: 'APP_BRIDGE_NOT_RUNNING',
        text:
          "The Rebel App Bridge stopped without cleaning up. " +
          "Restart Rebel and try again.",
      });
  }
}

/**
 * Turn an HTTP response from the relay into an MCP tool result.
 *
 *   - 200 → success text (the agent will parse JSON from data).
 *   - 401/403/404/405/409/500/502/503/504 → structured text error with the
 *     relay's `code` preserved so the agent can react accordingly.
 *   - Anything else → generic "unexpected error" with the status.
 */
async function renderRelayResponse(response, { toolName, capability }) {
  if (response.ok) {
    let parsed;
    try {
      parsed = await response.json();
    } catch (err) {
      return renderError({
        code: 'APP_BRIDGE_BAD_RESPONSE',
        text:
          `The Rebel App Bridge returned an unreadable response for ${toolName} (${capability}). ` +
          `(internal: ${err && err.message ? err.message : String(err)})`,
      });
    }

    const ok = RelayResponseSchema.safeParse(parsed);
    if (!ok.success) {
      return renderError({
        code: 'APP_BRIDGE_BAD_RESPONSE',
        text:
          `The Rebel App Bridge returned an unexpected success shape for ${toolName}. ` +
          `Expected { success: true, commandId, data }.`,
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(ok.data.data, null, 2),
        },
      ],
    };
  }

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }

  let parsedErr = null;
  if (bodyText) {
    try {
      parsedErr = JSON.parse(bodyText);
    } catch {
      parsedErr = null;
    }
  }
  const structured = parsedErr ? RelayErrorSchema.safeParse(parsedErr) : null;

  if (structured && structured.success) {
    return renderError({
      code: structured.data.code,
      text: friendlyTextForRelayCode({
        code: structured.data.code,
        message: structured.data.message,
        details: structured.data.details,
        toolName,
        capability,
      }),
    });
  }

  return renderError({
    code: 'APP_BRIDGE_HTTP_ERROR',
    text:
      `The Rebel App Bridge returned HTTP ${response.status} for ${toolName} (${capability})` +
      (bodyText ? `: ${bodyText.slice(0, 300)}` : '.'),
  });
}

/**
 * Map a relay error code to user-visible copy. Keeps the MCP-facing strings
 * in one place so the agent doesn't see inconsistent language for the same
 * failure mode.
 */
function getInjectionRefusedReason(details) {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const reason = details.reason;
  switch (reason) {
    case 'no-host-permission':
    case 'denied-by-user':
    case 'unsupported-scheme':
    case 'chrome-blocked':
    case 'request-failed':
    case 'transient':
      return reason;
    default:
      return null;
  }
}

function getInjectionRefusedDisplayOrigin(details) {
  if (!details || typeof details !== 'object') {
    return 'this page';
  }
  if (typeof details.displayOrigin === 'string' && details.displayOrigin.trim().length > 0) {
    return details.displayOrigin.trim();
  }
  if (typeof details.origin !== 'string' || details.origin.trim().length === 0) {
    return 'this page';
  }
  const origin = details.origin.trim();
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'https:') {
      return parsed.host;
    }
    if (parsed.protocol === 'http:') {
      return `${parsed.host} (http)`;
    }
    return parsed.origin;
  } catch {
    return origin;
  }
}

function friendlyTextForRelayCode({ code, message, details, toolName, capability }) {
  const suffix = `(tool: ${toolName}, capability: ${capability})`;
  switch (code) {
    case 'APP_NOT_CONNECTED':
      return `The Rebel browser extension isn't connected. Pair it in Settings → Connectors → Rebel App Bridge, then try again. ${suffix}`;
    case 'CAPABILITY_NOT_SUPPORTED':
      return `The browser extension is connected but doesn't advertise "${capability}". Update the extension and try again. ${suffix}`;
    case 'INJECTION_REFUSED': {
      // This sidecar currently has no dedicated unit harness; the app-bridge
      // relay contract tests above/below assert this reason-aware message path.
      const displayOrigin = getInjectionRefusedDisplayOrigin(details);
      const reason = getInjectionRefusedReason(details);
      switch (reason) {
        case 'no-host-permission':
          return `Rebel doesn't have permission to act on ${displayOrigin} yet — open the Rebel browser extension and tap Allow, then ask me again.`;
        case 'denied-by-user':
          return `Rebel doesn't have access to ${displayOrigin} right now. If you'd like to enable it, you can turn on site access in your browser's extension settings.`;
        case 'unsupported-scheme':
          return `${displayOrigin} isn't a page I can act on (it's a special browser surface). Open a normal web page and try again.`;
        case 'chrome-blocked':
          return `The browser refused to let me run on ${displayOrigin}. This page may be restricted by browser policy.`;
        case 'request-failed':
        case 'transient':
          return `I tried to ask for access to ${displayOrigin} but the browser rejected the request. If you're on a managed device, check with your admin; otherwise try reloading the extension.`;
        default:
          return "Rebel couldn't get browser access for that page. Open the Rebel browser extension, allow access, then ask me again.";
      }
    }
    case 'UNSUPPORTED_SURFACE':
      return `That page doesn't allow browser automation. Open a normal web page and try again. ${suffix}`;
    case 'COMMAND_TIMEOUT':
      return `The browser didn't respond in time. The tab may be busy — try again in a moment, or narrow the scope. ${suffix}`;
    case 'ADDIN_DISCONNECTED':
      return `The browser extension disconnected mid-task. Reopen Rebel or the browser, then try again. ${suffix}`;
    case 'IDEMPOTENT_DROP':
      return `That retry was a duplicate — the original request already completed. ${suffix}`;
    case 'FORBIDDEN':
      return `That request was rejected (${message || 'unauthorized'}). This is usually an installer bug — let the Rebel team know. ${suffix}`;
    case 'UNAUTHORIZED':
      return `The App Bridge rejected the router token. Restart Rebel and try again; if it keeps happening, let the Rebel team know. ${suffix}`;
    case 'METHOD_NOT_ALLOWED':
      return `Internal wiring error: the App Bridge refused the relay method. Let the Rebel team know. ${suffix}`;
    case 'TAB_CONTEXT_DIVERGED':
      return `The page changed before Rebel could act. Please try again. ${suffix}`;
    default:
      return `The Rebel App Bridge returned an error (${code}): ${message || 'no message'} ${suffix}`;
  }
}

function renderError({ code, text }) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, code, error: text }, null, 2),
      },
    ],
  };
}

// Retain the ROUTE_BY_TOOL_NAME import for consistency-check tooling that
// parses this module to infer tool → route mappings. Never actually used at
// runtime — the closure-captured `appId` + `tool.capability` do the work.
void ROUTE_BY_TOOL_NAME;

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    // stderr is the only safe channel — stdout is the MCP pipe.
    console.error('[RebelAppBridge] Server started');
  })
  .catch((error) => {
    console.error('[RebelAppBridge] Failed to start', error);
    process.exit(1);
  });
