#!/usr/bin/env node
/**
 * RebelPlugins MCP Server
 *
 * Plugin management: create/list/get-source/delete/open plugins,
 * lifecycle operations (fork/archive/restore), and cross-space copy/move.
 *
 * Tools (10):
 * - rebel_plugins_create
 * - rebel_plugins_list
 * - rebel_plugins_get_source
 * - rebel_plugins_delete
 * - rebel_plugins_open
 * - rebel_plugins_fork
 * - rebel_plugins_archive
 * - rebel_plugins_restore
 * - rebel_plugins_copy_to_space
 * - rebel_plugins_move_to_space
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
const process = require('node:process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

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
  console.error('[RebelPlugins] Missing bridge configuration file.');
  process.exit(1);
}

const bridgePort = bridgeState.port;
const bridgeToken = bridgeState.token;
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;

// Create the server instance
const server = new McpServer({
  name: 'RebelPlugins',
  version: '1.0.0',
  description: 'Plugin management via Rebel bridge endpoints.'
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
    let structuredPayload = null;
    try {
      structuredPayload = await response.json();
      detail = structuredPayload?.error ?? detail;
    } catch {
      detail = await response.text();
    }

    // Include previousCrashes context in error so the agent can see what was crashing
    if (structuredPayload?.previousCrashes?.length) {
      const crashSummary = structuredPayload.previousCrashes
        .slice(0, 5)
        .map((c) => {
          let msg = `  - ${c.name}: ${c.message}`;
          if (c.stack) msg += `\n    Stack:\n      ${c.stack.replace(/\n/g, '\n      ')}`;
          if (c.componentStack) msg += `\n    Component:\n      ${c.componentStack.replace(/\n/g, '\n      ')}`;
          return msg;
        })
        .join('\n\n');
      detail += `\n\nPrevious runtime crashes from this plugin:\n${crashSummary}`;
    }

    throw new Error(`[${toolName}] ${detail || `Request failed (${response.status})`}`);
  }

  return response.json();
};

// =============================================================================
// Tool Names
// =============================================================================
const TOOL_NAMES = {
  create: 'rebel_plugins_create',
  list: 'rebel_plugins_list',
  getSource: 'rebel_plugins_get_source',
  delete: 'rebel_plugins_delete',
  open: 'rebel_plugins_open',
  fork: 'rebel_plugins_fork',
  archive: 'rebel_plugins_archive',
  restore: 'rebel_plugins_restore',
  copyToSpace: 'rebel_plugins_copy_to_space',
  moveToSpace: 'rebel_plugins_move_to_space'
};

// =============================================================================
// Schemas
// =============================================================================
const createPluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  description: z.string().optional(),
  documentation: z.string().optional(),
  version: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  externalDomains: z.array(z.string()).optional(),
  // 'hero' marks the plugin as marquee in the Library Plugins lens (sorted first, Hero badge).
  // 'utility' (default) is the standard role. Honor system; no enforcement.
  role: z.enum(['hero', 'utility']).optional()
});

const listPluginsSchema = z.object({
  includeArchived: z.boolean().optional()
});

const pluginIdSchema = z.object({
  id: z.string()
});

const forkPluginSchema = z.object({
  id: z.string(),
  targetId: z.string().optional(),
  targetSpace: z.string().optional()
});

const archivePluginSchema = z.object({
  id: z.string()
});

const restorePluginSchema = z.object({
  id: z.string()
});

const copyToSpaceSchema = z.object({
  id: z.string(),
  sourceSpace: z.string(),
  targetSpace: z.string()
});

const moveToSpaceSchema = z.object({
  id: z.string(),
  sourceSpace: z.string(),
  targetSpace: z.string()
});

// =============================================================================
// Tool Registrations
// =============================================================================
server.registerTool(TOOL_NAMES.create, {
  title: 'Create or update plugin',
  description: `Read rebel-system/skills/system/build-custom-plugin/SKILL.md before generating any source. For HTML-to-plugin conversions, also read references/import-existing-html.md.

Create or update a UI plugin tab from TSX source code and return compile errors when invalid.

Use this when creating a new plugin or updating an existing one by ID.
The plugin becomes available in the app as a tab when compilation succeeds.

Security review: a NEW plugin that requests elevated permissions (external-fetch, conversations:write, conversations:transcript, skills:write, automations:create, inbox:write) is NOT activated automatically. The response will be { pendingSecurityReview: true } with a message. When you see that, tell the user the plugin is ready to enable from Settings → Plugins and do NOT call rebel_plugins_open until they approve it. Read-only plugins (and updates to plugins the user already enabled) activate immediately as before.

Plugins can declare accepted params in their manifest (via the \`params\` array in the manifest comment block) so agents know what to pass when opening with rebel_plugins_open. Example: \`params: [{ name: "path", description: "File path to display", required: true }]\`.

Optional:
- permissions: array of permission strings (e.g. 'conversations:read', 'conversations:write', 'conversations:transcript', 'memory:read', 'skills:read', 'skills:write', 'automations:create', 'entities:read', 'external-fetch'). Omit to preserve existing permissions on update, or inherit legacy read-only defaults on create.
- externalDomains: array of allowed HTTP domains for useExternalFetch (requires the 'external-fetch' permission).
- role: 'hero' or 'utility'. 'hero' marks the plugin as the marquee/featured plugin in the Library Plugins lens (sorted first with a Hero badge). 'utility' (default) is the standard role. Use 'hero' for the Space's primary dashboard or anchor surface; use 'utility' for everything else (timers, helpers, single-purpose tools). Discovery/sort signal only — does NOT change render placement, surfaces, or permissions.`,
  inputSchema: createPluginSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.create, '/plugins/create', {
    body: {
      id: input.id,
      name: input.name,
      source: input.source,
      description: input.description,
      documentation: input.documentation,
      version: input.version,
      // Only include if explicitly provided (preserve undefined vs [] distinction).
      ...(input.permissions !== undefined && { permissions: input.permissions }),
      ...(input.externalDomains !== undefined && { externalDomains: input.externalDomains }),
      ...(input.role !== undefined && { role: input.role })
    }
  });

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(TOOL_NAMES.list, {
  title: 'List plugins',
  description: `List all currently registered UI plugins.

Use this to discover available plugin IDs before calling rebel_plugins_get_source, rebel_plugins_delete, or rebel_plugins_open.
Pass includeArchived: true to also show archived plugins (for restore).`,
  inputSchema: listPluginsSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const queryParam = input.includeArchived ? '?includeArchived=true' : '';
  const result = await bridgeRequest(TOOL_NAMES.list, `/plugins/list${queryParam}`, { method: 'GET' });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(TOOL_NAMES.getSource, {
  title: 'Get plugin source',
  description: `Retrieve the TSX source code and documentation of an existing plugin by ID.

Use rebel_plugins_list first if you need to find the plugin ID.`,
  inputSchema: pluginIdSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.getSource, '/plugins/get-source', {
    body: { id: input.id }
  });

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(TOOL_NAMES.delete, {
  title: 'Delete plugin',
  description: `Remove a registered plugin by ID. This disables the plugin and removes its tab.`,
  inputSchema: pluginIdSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async (input) => {
  await bridgeRequest(TOOL_NAMES.delete, '/plugins/delete', {
    body: { id: input.id }
  });

  return {
    content: [{ type: 'text', text: `Plugin "${input.id}" has been removed.` }]
  };
});

const openPluginSchema = z.object({
  id: z.string(),
  params: z.record(z.string(), z.string()).optional()
});

server.registerTool(TOOL_NAMES.open, {
  title: 'Open plugin',
  description: `Navigate to a plugin tab in the UI, making it the active surface.
Optionally pass params to configure the plugin's initial view (e.g. { path: "/docs/README.md" }).

Use rebel_plugins_list first if you need to find the plugin ID.`,
  inputSchema: openPluginSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  await bridgeRequest(TOOL_NAMES.open, '/plugins/open', {
    body: { id: input.id, ...(input.params ? { params: input.params } : {}) }
  });

  const paramsNote = input.params ? ` with params: ${JSON.stringify(input.params)}` : '';
  return {
    content: [{ type: 'text', text: `Navigated to plugin "${input.id}"${paramsNote}.` }]
  };
});

server.registerTool(TOOL_NAMES.fork, {
  title: 'Fork plugin',
  description: `Create an editable copy of a plugin with lineage tracking (forkedFrom). Optionally specify a targetId and/or targetSpace (workspace-relative path, e.g. 'Chief-of-Staff').`,
  inputSchema: forkPluginSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.fork, '/plugins/fork', {
    body: { id: input.id, targetId: input.targetId, targetSpace: input.targetSpace }
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(TOOL_NAMES.archive, {
  title: 'Archive plugin',
  description: `Archive a plugin. Removes it from active lists but preserves on disk. Use rebel_plugins_list with includeArchived to find archived plugins.`,
  inputSchema: archivePluginSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.archive, '/plugins/archive', {
    body: { id: input.id }
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(TOOL_NAMES.restore, {
  title: 'Restore plugin',
  description: `Restore an archived plugin back to active status.`,
  inputSchema: restorePluginSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.restore, '/plugins/restore', {
    body: { id: input.id }
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(TOOL_NAMES.copyToSpace, {
  title: 'Copy plugin to Space',
  description: `Copy a plugin to another Space. The original stays in place. Space paths are workspace-relative (e.g. 'Chief-of-Staff', 'work/my-project').`,
  inputSchema: copyToSpaceSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.copyToSpace, '/plugins/copy-to-space', {
    body: { id: input.id, sourceSpace: input.sourceSpace, targetSpace: input.targetSpace }
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(TOOL_NAMES.moveToSpace, {
  title: 'Move plugin to Space',
  description: `Move a plugin to another Space. Copies to target and removes from source.`,
  inputSchema: moveToSpaceSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.moveToSpace, '/plugins/move-to-space', {
    body: { id: input.id, sourceSpace: input.sourceSpace, targetSpace: input.targetSpace }
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
});

// =============================================================================
// Start the server
// =============================================================================
const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    console.error('[RebelPlugins] Server started');
  })
  .catch((error) => {
    console.error('[RebelPlugins] Failed to start', error);
    process.exit(1);
  });
