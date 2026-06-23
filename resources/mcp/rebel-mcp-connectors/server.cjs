#!/usr/bin/env node
/**
 * RebelMcpConnectors MCP Server
 *
 * Connectors & MCP admin: list/add/remove MCP servers, disable individual tools, validate config, restart router, authenticate, search connector catalog.
 * Requires explicit user permission for remove/restart/disable.
 *
 * Tools (10):
 * - rebel_mcp_list_servers
 * - rebel_mcp_add_server
 * - rebel_mcp_remove_server
 * - rebel_mcp_validate_config
 * - rebel_mcp_restart
 * - rebel_mcp_disable_tool
 * - rebel_mcp_authenticate
 * - rebel_mcp_search_connectors
 * - rebel_mcp_get_connector
 * - rebel_mcp_report_contribution_state
 */
// MUST be the first non-comment statement — see docs/plans/260428_graceful_fs_emfile_fix.md
// Uses globalThis.process so files that later `const process = require('node:process')` don't trigger TDZ.
if (globalThis.process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') {
  try { require('graceful-fs').gracefulify(require('node:fs')); } catch (e) {
    globalThis.__REBEL_BOOTSTRAP_LEAF_ERROR__ = { kind: 'graceful_fs_leaf_install_failed', error: { name: e?.name, message: e?.message, stack: e?.stack }, at: Date.now() };
    if (globalThis.process.env.REBEL_DEBUG_BOOTSTRAP === '1') console.warn('[installGracefulFs] failed:', e);
  }
}
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// Stage 1.B: gate top-level side effects (catalog load, bridge state load,
// MCP server.connect()) behind `require.main === module || MCP_RUN_SERVER=1`
// so Vitest can `require()` this file to access exported helpers without
// triggering the server lifecycle (which would call process.exit() on
// missing catalog / bridge state and tear down the test process).
const isServerEntrypoint = require.main === module || process.env.MCP_RUN_SERVER === '1';

let connectorCatalog;
let bridgePort;
let bridgeToken;
let bridgeBaseUrl;

if (isServerEntrypoint) {
  // Load connector catalog - prefer env var (set by main process), fallback to relative path for dev
  const catalogPath = process.env.MINDSTONE_REBEL_CONNECTOR_CATALOG_PATH ||
                      path.join(__dirname, '..', '..', 'connector-catalog.json');
  try {
    connectorCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    console.error('[RebelMcpConnectors] Failed to load connector catalog from', catalogPath, ':', err.message);
    process.exit(1);
  }

  const statePath = process.env.MINDSTONE_REBEL_BRIDGE_STATE;

  const loadBridgeState = () => {
    if (!statePath) {
      return null;
    }
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.port !== 'number' || !parsed.token) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const bridgeState = loadBridgeState();

  if (!bridgeState) {
    console.error('[RebelMcpConnectors] Missing bridge configuration file.');
    process.exit(1);
  }

  bridgePort = bridgeState.port;
  bridgeToken = bridgeState.token;
  bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;
}

// Create the server instance
const server = new McpServer({
  name: 'RebelMcpConnectors',
  version: '1.0.0',
  description: `Connectors & MCP admin: list/add/remove MCP servers, disable individual tools, validate config, restart router, search connector catalog. Requires explicit user permission for remove/restart/disable.`
});

// Helper: Make bridge requests
const bridgeRequest = async (toolName, path, options = {}) => {
  const { method = 'POST', body } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {})
  };

  const response = await fetch(`${bridgeBaseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    let detail = 'Request failed.';
    try {
      const payload = await response.json();
      detail = payload?.error ?? detail;
    } catch {
      detail = await response.text();
    }
    throw new Error(`[${toolName}] ${detail || `Request failed (${response.status})`}`);
  }

  return response.json();
};

// =============================================================================
// Tool Names
// =============================================================================
const TOOL_NAMES = {
  mcpListServers: 'rebel_mcp_list_servers',
  mcpAddServer: 'rebel_mcp_add_server',
  mcpRemoveServer: 'rebel_mcp_remove_server',
  mcpValidate: 'rebel_mcp_validate_config',
  mcpRestart: 'rebel_mcp_restart',
  mcpDisableTool: 'rebel_mcp_disable_tool',
  mcpAuthenticate: 'rebel_mcp_authenticate',
  connectorSearch: 'rebel_mcp_search_connectors',
  connectorGet: 'rebel_mcp_get_connector',
  contributionReportState: 'rebel_mcp_report_contribution_state'
};

// =============================================================================
// Connector Catalog helpers
// =============================================================================
const searchConnectorCatalog = (query, options = {}) => {
  const { limit = 10, category } = options;
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return [];

  const results = [];
  for (const entry of connectorCatalog.connectors || []) {
    if (entry.isInternal) continue;
    if (category && entry.category !== category) continue;

    const nameMatch = entry.name.toLowerCase().includes(normalizedQuery);
    const descMatch = entry.description.toLowerCase().includes(normalizedQuery);
    const catMatch = entry.category.toLowerCase().includes(normalizedQuery);
    const idMatch = entry.id.toLowerCase().includes(normalizedQuery);

    if (nameMatch || descMatch || catMatch || idMatch) {
      results.push({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        category: entry.category,
        provider: entry.provider,
        authType: entry.bundledConfig?.authType || (entry.mcpConfig?.oauth ? 'oauth' : 'none'),
        accountIdentity: entry.accountIdentity || 'none',
        setupUrl: entry.setupUrl,
        setupInstructions: entry.setupInstructions,
        setupToolName: entry.bundledConfig?.setupToolName,
        setupFields: entry.setupFields || [],
        requiresSetup: entry.requiresSetup,
        isOAuth: entry.mcpConfig?.oauth === true || entry.bundledConfig?.authType === 'oauth' || entry.bundledConfig?.authType === 'oauth-user-provided',
      });
    }
    if (results.length >= limit) break;
  }
  return results;
};

const getConnectorById = (connectorId) => {
  const entry = (connectorCatalog.connectors || []).find(c => c.id === connectorId);
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    provider: entry.provider,
    authType: entry.bundledConfig?.authType || (entry.mcpConfig?.oauth ? 'oauth' : 'none'),
    accountIdentity: entry.accountIdentity || 'none',
    setupUrl: entry.setupUrl,
    setupInstructions: entry.setupInstructions,
    setupToolName: entry.bundledConfig?.setupToolName,
    setupFields: entry.setupFields || [],
    requiresSetup: entry.requiresSetup,
    isOAuth: entry.mcpConfig?.oauth === true || entry.bundledConfig?.authType === 'oauth' || entry.bundledConfig?.authType === 'oauth-user-provided',
  };
};

// =============================================================================
// Schemas
// =============================================================================
const mcpAddServerSchema = z.object({
  name: z.string().min(1).optional().describe('Server display name. Required for custom MCPs, auto-generated for catalog entries.'),
  catalogId: z.string().optional().describe('Catalog connector ID (from rebel_mcp_search_connectors). When provided, the server is built from the catalog — no need to specify url/command/args.'),
  setupFields: z.record(z.string(), z.string()).optional().describe('Key-value map of setup field values (e.g., { apiKey: "sk-..." }). Field IDs come from the setupFields array in search/get results.'),
  email: z.string().min(1).optional().describe('Account identity for multi-instance connectors whose accountIdentity is an email (Google, HubSpot) or workspace name (Slack). Subdomain/domain/tenant identities (Zendesk, Freshdesk, Workday, BambooHR) are NOT passed here — provide those via the matching setupFields entry instead. Check the accountIdentity field from search/get results.'),
  url: z.string().url().optional().describe('Server URL for HTTP/SSE transport'),
  command: z.string().optional().describe('Command for stdio transport'),
  args: z.array(z.string()).optional().describe('Arguments for stdio command'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables'),
  headers: z.record(z.string(), z.string()).optional().describe('HTTP headers'),
  transport: z.enum(['http', 'sse', 'stdio']).optional().describe('Transport type (default: auto-detect)'),
  oauth: z.boolean().optional().describe('Whether the server uses OAuth'),
}).refine(
  data => data.catalogId || data.name,
  { message: 'Either catalogId or name must be provided' }
);

const mcpRemoveServerSchema = z.object({
  name: z.string().min(1).describe('Name of the server to remove')
});

const mcpValidateSchema = z.object({
  config: z.record(z.string(), z.any()).describe('MCP server configuration object to validate')
});

const mcpRestartSchema = z.object({});

const mcpDisableToolSchema = z.object({
  serverId: z.string().min(1).describe('MCP server name (e.g., "Gmail", "GoogleWorkspace-you-work-com", "Slack-mindstone"). Get from list_tool_packages().'),
  toolName: z.string().min(1).describe('Short tool name to disable (e.g., "send_email", "delete_file"). Get from list_tools(package_id). Do NOT use the namespaced form (e.g., "Gmail__send_email").')
});

const mcpAuthenticateSchema = z.object({
  serverId: z.string().min(1).describe('MCP server name to authenticate (e.g., "Linear", "Notion-user-email-com"). Use the serverName from rebel_mcp_add_server response.')
});

const connectorSearchSchema = z.object({
  query: z.string().min(1).describe('Search query to find connectors (matches name, description, category)'),
  limit: z.number().min(1).max(20).optional().describe('Max results to return (default: 10, max: 20)'),
  category: z.string().optional().describe('Filter by category (e.g., "productivity", "communication", "development")')
});

const connectorGetSchema = z.object({
  connectorId: z.string().min(1).describe('The connector ID to look up (e.g., "slack", "notion", "bundled-fathom")')
});

// =============================================================================
// Tool Registrations
// =============================================================================

// List MCP servers
server.registerTool(TOOL_NAMES.mcpListServers, {
  title: 'List MCP servers',
  description: 'List all configured MCP servers in Rebel. Returns server names, their configuration type (HTTP/SSE/stdio), URL or command, and any external config paths being aggregated. Format: "- name (type) → url_or_command". Use this to understand what tools are currently available, check for duplicate configurations, or before adding/removing servers.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.mcpListServers, '/mcp/list-servers', { method: 'GET' });
  if (!result.configured) {
    return {
      content: [{
        type: 'text',
        text: 'No MCP configuration file is set up yet. The user should visit Settings → Connectors to configure their first connection.'
      }]
    };
  }
  const servers = result.servers || {};
  const configPaths = result.configPaths || [];
  const serverNames = Object.keys(servers);
  const lines = [];
  if (serverNames.length === 0 && configPaths.length === 0) {
    lines.push('No MCP servers configured.');
  } else {
    if (serverNames.length > 0) {
      lines.push(`**Direct servers (${serverNames.length}):**`);
      for (const name of serverNames) {
        const cfg = servers[name];
        const type = cfg.type || (cfg.url ? 'http' : cfg.command ? 'stdio' : 'unknown');
        let endpoint = '';
        if (cfg.url) {
          endpoint = cfg.url;
        } else if (cfg.command) {
          const argsStr = Array.isArray(cfg.args) && cfg.args.length > 0 ? cfg.args.join(' ') : '';
          endpoint = argsStr ? `${cfg.command} ${argsStr}` : cfg.command;
        }
        const endpointSuffix = endpoint ? ` → ${endpoint}` : '';
        lines.push(`- ${name} (${type})${endpointSuffix}`);
      }
    }
    if (configPaths.length > 0) {
      lines.push('');
      lines.push(`**External config paths (${configPaths.length}):**`);
      for (const p of configPaths) {
        lines.push(`- ${p}`);
      }
    }
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Add MCP server
server.registerTool(TOOL_NAMES.mcpAddServer, {
  title: 'Add MCP server',
  description: `Add or update an MCP server in Rebel's configuration.

Call directly when the user is in the build or setup flow — skill invocation is consent, no further confirmation needed. When the agent initiates this on its own (outside an active skill), confirm with the user first.

**Preferred flow — Catalog connectors** (recommended):
1. Use rebel_mcp_search_connectors to find the connector
2. Check accountIdentity — if "email" or "workspace", ask the user for it BEFORE calling this tool
3. Call this tool with catalogId + email (if needed) + any required setupFields
Example: { catalogId: "bundled-fathom", setupFields: { apiKey: "..." } }
Example: { catalogId: "bundled-google", email: "[external-email]" }
Example: { catalogId: "notion" }

**Custom MCPs** (when not in catalog):
For HTTP/SSE: { name: "my-server", url: "https://..." }
For stdio: { name: "my-server", command: "npx", args: [...] }

The server will be added and the router restarted automatically. Do NOT call rebel_mcp_restart afterwards.

**After adding an OAuth connector**: If the response has requiresAuth: true, call rebel_mcp_authenticate(serverId: "<serverName from response>") to open the browser sign-in.

Responses include:
- outcome: "added" | "already_exists"
- requiresAuth: true if OAuth setup is needed
- serverName: the server name to use with rebel_mcp_authenticate
- nextStep: human-readable instructions for what to do next`,
  inputSchema: mcpAddServerSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.mcpAddServer, '/mcp/upsert-server', { body: input });

  // Structured response from catalog-aware bridge (has outcome field)
  if (result.outcome) {
    if (result.outcome === 'already_exists') {
      return {
        content: [{ type: 'text', text: `${result.serverName || 'Server'} is already connected. ${result.nextStep || ''}` }]
      };
    }
    let response = result.nextStep || `Server "${result.serverName}" added successfully.`;
    if (result.requiresAuth) {
      response += `\n\nIMPORTANT: Call rebel_mcp_authenticate(serverId: "${result.serverName}") now to open the browser for OAuth sign-in.`;
    }
    return {
      content: [{ type: 'text', text: response }]
    };
  }

  // Raw add response (existing behavior for custom MCPs without catalogId)
  const lines = [`Added MCP server "${input.name}" to configuration.`];
  if (result.backupPath) {
    lines.push(`Backup saved at: ${result.backupPath}`);
  }
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Remove MCP server
server.registerTool(TOOL_NAMES.mcpRemoveServer, {
  title: 'Remove MCP server',
  description: `Remove an MCP server from Rebel's configuration.

**IMPORTANT**: Only call this tool after receiving explicit user permission.

The server will be removed from the Super-MCP router. This cannot remove servers defined in external config files (configPaths) - only direct servers.

**NOTE**: This tool automatically restarts the router. Do NOT call rebel_mcp_restart afterwards - doing so can cause the turn to hang.`,
  inputSchema: mcpRemoveServerSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.mcpRemoveServer, '/mcp/remove-server', { body: { name: input.name } });
  const lines = [`Removed MCP server "${input.name}" from configuration.`];
  if (result.backupPath) {
    lines.push(`Backup saved at: ${result.backupPath}`);
  }
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Validate MCP config
server.registerTool(TOOL_NAMES.mcpValidate, {
  title: 'Validate MCP server configuration',
  description: `Check if an MCP server configuration object is valid before adding it.

This is a preview/validation tool - it returns warnings but does NOT block adding.
Use this to check pasted JSON before calling rebel_mcp_add_server.

Pass the configuration object (not the outer wrapper with server name as key).
Example: { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }`,
  inputSchema: mcpValidateSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const warnings = [];
  const config = input.config || {};

  const hasUrl = typeof config.url === 'string' && config.url.trim();
  const hasCommand = typeof config.command === 'string' && config.command.trim();
  let detectedTransport = 'unknown';

  if (!hasUrl && !hasCommand) {
    warnings.push('Missing required field: needs either "url" (for HTTP/SSE) or "command" (for stdio)');
  } else if (hasUrl && hasCommand) {
    warnings.push('Has both "url" and "command" - typically only one is needed. URL will take precedence for HTTP/SSE.');
    detectedTransport = 'http (url takes precedence)';
  } else if (hasUrl) {
    detectedTransport = 'http/sse';
  } else {
    detectedTransport = 'stdio';
  }

  if (hasCommand) {
    if (config.args === undefined || config.args === null) {
      warnings.push('Suggestion: No "args" array provided for stdio server. Many servers need arguments (e.g., ["--port", "3000"]).');
    } else if (!Array.isArray(config.args)) {
      warnings.push('"args" should be an array of strings, not ' + typeof config.args);
    }
  }

  if (hasUrl) {
    try {
      new URL(config.url);
    } catch {
      warnings.push(`"url" doesn't appear to be a valid URL: "${config.url}"`);
    }
  }

  const transportValue = config.transport || config.type;
  if (transportValue !== undefined && transportValue !== null) {
    const validTransports = ['http', 'sse', 'stdio'];
    if (!validTransports.includes(transportValue)) {
      warnings.push(`"transport"/"type" value "${transportValue}" is not recognized. Expected one of: ${validTransports.join(', ')}`);
    } else {
      detectedTransport = transportValue;
    }
  }

  if (config.env !== undefined && config.env !== null) {
    if (typeof config.env !== 'object' || Array.isArray(config.env)) {
      warnings.push('"env" should be an object with string key-value pairs');
    }
  }
  if (config.headers !== undefined && config.headers !== null) {
    if (typeof config.headers !== 'object' || Array.isArray(config.headers)) {
      warnings.push('"headers" should be an object with string key-value pairs');
    }
  }

  const lines = [];
  if (warnings.length === 0) {
    lines.push('✓ Configuration looks valid');
  } else {
    lines.push(`Found ${warnings.length} warning(s):`);
    for (const w of warnings) {
      lines.push(`  • ${w}`);
    }
  }
  lines.push('');
  lines.push(`Detected transport: ${detectedTransport}`);

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Restart Super-MCP
server.registerTool(TOOL_NAMES.mcpRestart, {
  title: 'Restart Super-MCP',
  description: `Restart the Super-MCP router to reload MCP server configurations.

**IMPORTANT**: Do NOT use this tool after rebel_mcp_add_server or rebel_mcp_remove_server - those tools already restart the router automatically. Calling this tool in parallel with add/remove operations can cause the agent turn to hang.

Use this ONLY for manual restarts when troubleshooting connection issues.
The restart happens asynchronously - tools will be briefly unavailable.

WARNING: This affects all active sessions. Use only when necessary.`,
  inputSchema: mcpRestartSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.mcpRestart, '/mcp/restart', {});

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to restart Super-MCP: ${result.error}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: 'Super-MCP restart initiated. Tools will be briefly unavailable while reloading.'
    }]
  };
});

// Disable a specific tool on an MCP server
server.registerTool(TOOL_NAMES.mcpDisableTool, {
  title: 'Disable MCP tool',
  description: `Disable a specific tool on any connected MCP server. The tool will be blocked from use until re-enabled by the user in Settings → Connectors.

**Requires explicit user permission before calling.** Only disable tools when the user asks you to.

To see which tools are available and their current status, use list_tools(package_id: "<serverId>") — it shows blocked/user_disabled status per tool.

To re-enable a disabled tool, the user must go to Settings → Connectors, find the server, and toggle the tool back on.

IMPORTANT:
- Use the SHORT tool name (e.g., "send_email"), not the namespaced form ("Gmail__send_email")
- Get serverId from list_tool_packages() and toolName from list_tools()
- This is idempotent: disabling an already-disabled tool is a no-op
- Cannot disable tools on RebelMcpConnectors (would lock out admin tools)`,
  inputSchema: mcpDisableToolSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const { serverId, toolName } = input;

  // Strip namespace prefix if the agent accidentally passes the full namespaced form
  const shortName = toolName.includes('__') ? toolName.split('__').slice(1).join('__') : toolName;

  // Prevent disabling admin tools on this server
  if (serverId === 'RebelMcpConnectors') {
    return {
      content: [{
        type: 'text',
        text: 'Cannot disable tools on RebelMcpConnectors — this would lock out admin functionality. The user can manage these in Settings → Connectors if needed.'
      }]
    };
  }

  const result = await bridgeRequest(TOOL_NAMES.mcpDisableTool, '/mcp/disable-tool', {
    body: { serverId, toolName: shortName }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to disable tool "${shortName}" on ${serverId}: ${result.error}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `Disabled tool "${shortName}" on ${serverId}. The tool is now blocked and will not execute.\n\nTo re-enable: Settings → Connectors → ${serverId} → toggle the tool back on.`
    }]
  };
});

// Authenticate MCP server (OAuth)
server.registerTool(TOOL_NAMES.mcpAuthenticate, {
  title: 'Authenticate MCP server',
  description: `Trigger OAuth authentication for an MCP server that requires it.

**When to use**: After rebel_mcp_add_server returns requiresAuth: true, call this tool with the serverName from that response.

This opens the user's browser for OAuth sign-in. The tool waits for authentication to complete (up to ~5 minutes) and returns the result.

**IMPORTANT**: Use the exact serverName returned by rebel_mcp_add_server. For multi-instance connectors, this includes the identity suffix (e.g., "Notion-user-email-com").

Example: { serverId: "Linear" }`,
  inputSchema: mcpAuthenticateSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.mcpAuthenticate, '/mcp/authenticate', {
      body: { serverId: input.serverId }
    });

    if (result.success) {
      const status = result.status || 'authenticated';
      if (status === 'already_authenticated') {
        return {
          content: [{ type: 'text', text: `${input.serverId} is already authenticated and ready to use.` }]
        };
      }
      return {
        content: [{ type: 'text', text: `${input.serverId} authenticated successfully. The connector is now ready to use.` }]
      };
    }

    return {
      content: [{ type: 'text', text: `Authentication failed for ${input.serverId}: ${result.error || 'Unknown error'}. The user can retry via Settings → Connectors.` }]
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to authenticate ${input.serverId}: ${err.message || 'Unknown error'}. The user can authenticate via Settings → Connectors.` }]
    };
  }
});

// Search connector catalog
server.registerTool(TOOL_NAMES.connectorSearch, {
  title: 'Search connector catalog',
  description: `Search Rebel's built-in connector catalog to find available integrations.

Use this BEFORE suggesting custom MCP configurations or web searches. Rebel has 70+ pre-configured connectors with verified setup flows.

Returns matching connectors with:
- Setup instructions and URLs
- Whether it uses OAuth (handled automatically) or requires API keys
- The setup tool name if available

Examples:
- Search "slack" to find Slack connectors
- Search "meeting" to find meeting transcription tools (Fathom, Fireflies, Otter)
- Search "calendar" to find Google Calendar, Outlook Calendar

Categories: communication, productivity, development, sales, analytics, storage, payments`,
  inputSchema: connectorSearchSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const results = searchConnectorCatalog(input.query, { limit: input.limit, category: input.category });

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No connectors found matching "${input.query}". This service may not be in Rebel's catalog - you can help the user add a custom MCP server instead.`
      }]
    };
  }

  const lines = [`Found ${results.length} connector(s) matching "${input.query}":\n`];
  for (const c of results) {
    lines.push(`**${c.name}** (${c.category}) [${c.provider}]`);
    lines.push(`  ${c.description}`);
    lines.push(`  Auth: ${c.authType}${c.isOAuth ? ' (OAuth)' : ''}`);
    if (c.accountIdentity && c.accountIdentity !== 'none') {
      lines.push(`  Account identity: ${c.accountIdentity} (ask user for this before adding)`);
    }
    if (c.isOAuth) {
      lines.push(`  Setup: OAuth — add via rebel_mcp_add_server, then call rebel_mcp_authenticate with the serverName from the response`);
    } else if (c.setupToolName) {
      lines.push(`  Setup: Use \`${c.setupToolName}\` tool`);
    } else if (c.setupUrl) {
      lines.push(`  Setup URL: ${c.setupUrl}`);
    }
    if (c.setupFields.length > 0) {
      const fieldLabels = c.setupFields.map(f => f.label || f.id).join(', ');
      lines.push(`  Required fields: ${fieldLabels}`);
    }
    if (c.setupInstructions) {
      const firstLine = c.setupInstructions.split('\n')[0];
      lines.push(`  Instructions: ${firstLine}...`);
    }
    lines.push('');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Get connector details
server.registerTool(TOOL_NAMES.connectorGet, {
  title: 'Get connector setup details',
  description: `Get detailed setup information for a specific connector from Rebel's catalog.

Use this after finding a connector with rebel_mcp_search_connectors to get full setup instructions.

Returns:
- Full setup instructions
- Setup URL (where to get API keys or start OAuth)
- Setup tool name (if available)
- Whether it uses OAuth`,
  inputSchema: connectorGetSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const c = getConnectorById(input.connectorId);

  if (!c) {
    return {
      content: [{
        type: 'text',
        text: `Connector "${input.connectorId}" not found in catalog.`
      }]
    };
  }

  const lines = [`**${c.name}** (${c.category}) [${c.provider}]`, `${c.description}`, ''];

  lines.push(`**Provider:** ${c.provider}`);
  lines.push(`**Auth Type:** ${c.authType}${c.isOAuth ? ' (OAuth)' : ''}`);
  if (c.accountIdentity && c.accountIdentity !== 'none') {
    // Orthogonality convention: when a setupField's id matches accountIdentity
    // (subdomain/domain/tenant connectors like Zendesk/Freshdesk/Workday/BambooHR),
    // the value is collected via that setupField (→ env var), NOT the `email` param.
    // Otherwise (email/workspace) it goes via the top-level `email` param.
    const identityField = c.setupFields.find(f => f.id === c.accountIdentity);
    if (identityField) {
      lines.push(`**Account Identity:** ${c.accountIdentity} — ask the user for their ${c.accountIdentity} before adding this connector. Pass it via the \`setupFields\` parameter in rebel_mcp_add_server, e.g. \`setupFields: { "${c.accountIdentity}": "<value>" }\` (NOT the \`email\` parameter).`);
    } else {
      lines.push(`**Account Identity:** ${c.accountIdentity} — ask the user for their ${c.accountIdentity} before adding this connector. Pass it as the \`email\` parameter in rebel_mcp_add_server.`);
    }
  }
  lines.push('');

  if (c.isOAuth) {
    lines.push('**Setup Type:** OAuth (automatic)');
    lines.push(`To connect: Add via \`rebel_mcp_add_server(catalogId: "${c.id}")\`, then call \`rebel_mcp_authenticate(serverId: "<serverName from response>")\` to open the browser sign-in.`);
  } else if (c.setupToolName) {
    lines.push(`**Setup Tool:** \`${c.setupToolName}\``);
  }

  if (c.setupUrl) {
    lines.push(`**Setup URL:** ${c.setupUrl}`);
  }

  if (c.setupFields.length > 0) {
    lines.push('');
    lines.push('**Setup Fields:**');
    for (const field of c.setupFields) {
      const label = field.label || field.id;
      const type = field.type ? ` (${field.type})` : '';
      lines.push(`  - ${label}${type}`);
    }
  }

  if (c.setupInstructions) {
    lines.push('');
    lines.push('**Setup Instructions:**');
    lines.push(c.setupInstructions);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// =============================================================================
// Contribution State Reporting
// =============================================================================

const contributionReportStateSchema = z.object({
  sessionId: z.string().min(1).describe('The conversation session ID where the build/extend skill is running.'),
  connectorName: z.string().min(1).describe('Name of the connector being built or extended.'),
  status: z.enum([
    'draft', 'testing', 'ready_to_submit', 'submitted',
    'ci_pass', 'ci_fail', 'changes_requested', 'approved',
    'rejected', 'published'
  ]).describe('The contribution lifecycle status to report.'),
  localServerPath: z.string().optional().describe('Local file path to the built connector server directory.'),
  catalogEntryId: z.string().optional().describe('Catalog entry ID if the connector is being submitted to the catalog.'),
});

/**
 * Stage 1.B — Pure renderer for /contribution/report-state bridge responses.
 *
 * Reads the new typed `decision` envelope when present (Stage 1.A bridge),
 * falls back to the legacy `success`/`error` shape for older bridges. Returns
 * the MCP-tool-result content + isError flag.
 *
 * Format spec (per planning doc Decision 3):
 *
 *   Success (kind ∈ {created, updated, noop}, isError=false):
 *     "{Verb} contribution {contributionId} — status: {status}"
 *
 *   Failure (kind ∈ {deferred, rejected}, isError=true):
 *     "Contribution state report {kind}: {reason}.\n
 *      Next action: {nextAction}.\n
 *      {guidance}\n
 *      \n
 *      (contribution_id={id}, current_status={status})"
 *
 * Exported via `module.exports` so Vitest can unit-test it directly without
 * spawning the MCP transport. See `tests/mcp-wrapper-contribution-isError.test.ts`.
 */
const renderContributionToolResult = (bridgeBody) => {
  // Defensive defaults — every legacy + new bridge body should at least carry
  // `success` and either `error` or some envelope shape.
  const body = bridgeBody && typeof bridgeBody === 'object' ? bridgeBody : {};
  const decision = body.decision && typeof body.decision === 'object' ? body.decision : null;

  // Legacy fallback: no decision field at all (bridge predates Stage 1.A).
  // The Stage 1.A bridge ALWAYS attaches `decision` on every non-malformed-
  // input response — so seeing this branch on a 2xx response indicates the
  // bridge dropped the field somehow, which would silently re-introduce the
  // matrix #2 hidden-defer risk. Emit a structured diagnostic on stderr to
  // surface the regression in dev runs and CI logs. (The unknown-kind branch
  // below uses the same pattern.)
  if (!decision) {
    console.error(JSON.stringify({
      component: 'rebel-mcp-connectors',
      event: 'contribution-state-decision-missing',
      bodyHasSuccess: !!(body && body.success),
      bodyHasError: !!(body && body.error),
      contributionId: (body && body.contributionId) || null,
    }));
    if (body.success) {
      const action = body.created ? 'Created' : 'Updated';
      return {
        content: [{
          type: 'text',
          text: `${action} contribution ${body.contributionId} — status: ${body.status}`,
        }],
        isError: false,
      };
    }
    return {
      content: [{
        type: 'text',
        text: `Failed to report contribution state: ${body.error || 'Unknown error'}`,
      }],
      isError: true,
    };
  }

  const { kind } = decision;

  // Success kinds — backward-compatible verb prefixed text.
  if (kind === 'created' || kind === 'updated' || kind === 'noop') {
    const verb = kind === 'created' ? 'Created' : kind === 'updated' ? 'Updated' : 'No change to';
    const buildId = decision.build && decision.build.id;
    const buildStatus = decision.build && decision.build.status;
    const id = buildId || body.contributionId;
    const status = buildStatus || body.status;
    return {
      content: [{
        type: 'text',
        text: `${verb} contribution ${id} — status: ${status}`,
      }],
      isError: false,
    };
  }

  // Failure kinds — structured machine-parsable text. First line carries
  // `kind: reason.`, second line `Next action: nextAction.`, then guidance,
  // then the immutable identifiers in a parseable parenthetical.
  if (kind === 'deferred' || kind === 'rejected') {
    const reason = decision.reason || 'unknown';
    const nextAction = decision.nextAction || 'unknown';
    const guidance = decision.guidance || '';
    const buildId = (decision.build && decision.build.id) || body.contributionId || 'unknown';
    const buildStatus = (decision.build && decision.build.status) || body.status || 'unknown';
    // Note: any guidance text in this result is for the AGENT to re-narrate to the user in plain English. Do NOT show field names like next_action/run_tests/contribution_id verbatim — see build-custom-mcp-server/SKILL.md § Voice Firewall.
    const text =
      `Contribution state report ${kind}: ${reason}.\n` +
      `Next action: ${nextAction}.\n` +
      `${guidance}\n` +
      `\n` +
      `(contribution_id=${buildId}, current_status=${buildStatus})`;
    return {
      content: [{ type: 'text', text }],
      isError: true,
    };
  }

  // Unknown decision.kind — degrade to legacy success path with a defensive
  // log on stderr so future enum additions surface during dev runs. We
  // err on the side of "show success but flag" rather than masking with
  // a hard error, since the bridge already returned `success: true`.
  console.error('[RebelMcpConnectors] Unknown decision.kind in /contribution/report-state response:', kind);
  if (body.success) {
    const action = body.created ? 'Created' : 'Updated';
    return {
      content: [{
        type: 'text',
        text: `${action} contribution ${body.contributionId} — status: ${body.status}`,
      }],
      isError: false,
    };
  }
  return {
    content: [{
      type: 'text',
      text: `Failed to report contribution state: ${body.error || 'Unknown error'}`,
    }],
    isError: true,
  };
};

server.registerTool(TOOL_NAMES.contributionReportState, {
  title: 'Report contribution state',
  description: 'Report build progress for an OSS MCP connector contribution. Call at checkpoints: contribution.created (draft), testing_started (testing), testing_finished (ready_to_submit). Updates the persistent contribution store that drives the MCPBuildCard, notifications, and homepage banner. Internal field names (draft/testing/ready_to_submit/Phase N/testing_evidence/DoD) must NEVER be shown to the user — they are non-technical knowledge workers. Translate to plain English per build-custom-mcp-server/SKILL.md § Voice Firewall.',
  inputSchema: contributionReportStateSchema
}, async ({ sessionId, connectorName, status, localServerPath, catalogEntryId }) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.contributionReportState, '/contribution/report-state', {
      body: {
        sessionId,
        connectorName,
        status,
        ...(localServerPath ? { localServerPath } : {}),
        ...(catalogEntryId ? { catalogEntryId } : {}),
      }
    });
    return renderContributionToolResult(result);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reporting contribution state: ${error.message}` }],
      isError: true,
    };
  }
});

// =============================================================================
// Start the server
// =============================================================================
// Stage 1.B: gate transport connect so Vitest can `require()` this file
// without spawning the MCP server. See top-of-file `isServerEntrypoint`.
if (isServerEntrypoint) {
  const transport = new StdioServerTransport();

  server
    .connect(transport)
    .then(() => {
      console.error('[RebelMcpConnectors] Server started');
    })
    .catch((error) => {
      console.error('[RebelMcpConnectors] Failed to start', error);
      process.exit(1);
    });
}

// Stage 1.B: export the pure renderer for unit tests. The MCP runtime loads
// this file via stdio transport and ignores `module.exports`; the export is
// purely for Vitest. See `mcp-wrapper-contribution-isError.test.ts`.
module.exports = { renderContributionToolResult };
