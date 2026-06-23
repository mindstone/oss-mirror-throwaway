#!/usr/bin/env node
/**
 * RebelSpaces MCP Server
 *
 * Memory Spaces: list/create spaces, get/update space config (description + associated accounts).
 *
 * Tools (4):
 * - rebel_spaces_list
 * - rebel_spaces_create
 * - rebel_spaces_get_config
 * - rebel_spaces_update_config
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
  console.error('[RebelSpaces] Missing bridge configuration file.');
  process.exit(1);
}

const bridgePort = bridgeState.port;
const bridgeToken = bridgeState.token;
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;

// Create the server instance
const server = new McpServer({
  name: 'RebelSpaces',
  version: '1.0.0',
  description: `Memory Spaces: list/create spaces, get/update space config (description + associated accounts).`
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
  spacesList: 'rebel_spaces_list',
  createSpace: 'rebel_spaces_create',
  spaceGetConfig: 'rebel_spaces_get_config',
  spaceUpdateConfig: 'rebel_spaces_update_config'
};

// =============================================================================
// Schemas
// =============================================================================
const spacesListSchema = z.object({});

const createSpaceSchema = z.object({
  name: z.string().min(1).describe('Name for the new Space (becomes folder name)'),
  targetPath: z.string().optional().describe('Parent folder path within workspace (optional, default: workspace root)'),
  description: z.string().optional().describe('Description for the Space (optional)'),
  type: z.enum(['personal', 'professional', 'research', 'health', 'finance', 'other']).optional().describe('Space type category (optional, default: other)'),
  createSubfolders: z.boolean().optional().describe('Create memory/ and skills/ subfolders (default: true)')
});

const spaceGetConfigSchema = z.object({
  spacePath: z.string().min(1).describe('Path to Space relative to workspace (e.g., "Work/Acme", "Chief-of-Staff")')
});

const spaceUpdateConfigSchema = z.object({
  spacePath: z.string().min(1).describe('Path to Space relative to workspace (e.g., "Work/Acme")'),
  updates: z.object({
    rebel_space_description: z.string().optional().describe('New description for the Space'),
    emails: z.array(z.string()).optional().describe('Associated email accounts (exact match like "[external-email]" or wildcard like "*@acme.com")')
  }).describe('Fields to update')
});

// =============================================================================
// Tool Registrations
// =============================================================================

// List all Spaces
server.registerTool(TOOL_NAMES.spacesList, {
  title: 'List all Spaces',
  description: `List all memory Spaces in the current workspace.

Returns each Space's name, path, type, and frontmatter metadata.
Use this to discover available Spaces before reading or writing files.`,
  inputSchema: spacesListSchema,
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.spacesList, '/spaces/list', {});

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to list spaces: ${result.error}`
      }]
    };
  }

  const spaces = result.spaces || [];
  if (spaces.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No Spaces found in the current workspace.'
      }]
    };
  }

  const summary = spaces.map(s => {
    const parts = [`- ${s.name} (${s.path})`];
    if (s.frontmatter?.space_type) parts.push(`  Type: ${s.frontmatter.space_type}`);
    if (s.frontmatter?.rebel_space_description) parts.push(`  Description: ${s.frontmatter.rebel_space_description}`);
    return parts.join('\n');
  }).join('\n');

  return {
    content: [{
      type: 'text',
      text: `Found ${spaces.length} Space(s):\n${summary}`
    }]
  };
});

// Create Space
server.registerTool(TOOL_NAMES.createSpace, {
  title: 'Create Space',
  description: `Create a new memory Space in the workspace.

You MUST have explicit user permission before creating Spaces.
The Space will be created as a local folder (no symlinks via MCP).

Example: Create a "Projects" Space for work-related memory.`,
  inputSchema: createSpaceSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.createSpace, '/spaces/create', {
    body: {
      name: input.name,
      targetPath: input.targetPath,
      description: input.description,
      type: input.type,
      createSubfolders: input.createSubfolders
    }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to create Space: ${result.error}`
      }]
    };
  }

  const space = result.space;
  return {
    content: [{
      type: 'text',
      text: `Created Space "${space.name}" at ${space.path}`
    }]
  };
});

// Get Space configuration
server.registerTool(TOOL_NAMES.spaceGetConfig, {
  title: 'Get Space configuration',
  description: `Get a Space's frontmatter configuration (description, type, sharing, emails, etc.).

Use this to check the current configuration of a Space, including associated email accounts.

Returns all frontmatter fields: rebel_space_description, space_type, sharing, memoryTrust, emails, etc.`,
  inputSchema: spaceGetConfigSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.spaceGetConfig, '/space/get-config', {
    body: { spacePath: input.spacePath }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to get Space config: ${result.error}`
      }]
    };
  }

  const config = result.config || {};

  // Return both human-readable summary and full JSON for agent consumption
  const lines = [`**Space: ${input.spacePath}**`, ''];

  // Human-readable summary of key fields
  if (config.rebel_space_description) {
    lines.push(`Description: ${config.rebel_space_description}`);
  }
  if (config.space_type) {
    lines.push(`Type: ${config.space_type}`);
  }
  if (config.sharing) {
    lines.push(`Sharing: ${config.sharing}`);
  }
  if (config.memoryTrust) {
    lines.push(`Memory Trust: ${config.memoryTrust}`);
  }
  if (config.sensitivity) {
    lines.push(`Sensitivity: ${config.sensitivity}`);
  }
  if (config.emails && config.emails.length > 0) {
    lines.push(`Associated Accounts: ${config.emails.join(', ')}`);
  }
  if (config.display_name) {
    lines.push(`Display Name: ${config.display_name}`);
  }
  if (config.organisation_name) {
    lines.push(`Organisation: ${config.organisation_name}`);
  }
  if (config.owner) {
    lines.push(`Owner: ${config.owner}`);
  }
  if (config.related_spaces && config.related_spaces.length > 0) {
    lines.push(`Related Spaces: ${config.related_spaces.join(', ')}`);
  }

  // Append full JSON for programmatic access
  lines.push('');
  lines.push('**Full Configuration (JSON):**');
  lines.push('```json');
  lines.push(JSON.stringify(config, null, 2));
  lines.push('```');

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Update Space configuration
server.registerTool(TOOL_NAMES.spaceUpdateConfig, {
  title: 'Update Space configuration',
  description: `Update a Space's description or associated email accounts.

**Allowed fields:** rebel_space_description, emails
**Blocked fields:** sharing, memoryTrust, sensitivity, space_type (use Settings > Spaces for these)

Use this to save email preferences for a Space so the agent remembers which MCP accounts to use.

Examples:
- Update description: { spacePath: "Work/Acme", updates: { rebel_space_description: "Client projects for Acme Corp" } }
- Add email associations: { spacePath: "Work", updates: { emails: ["*@work.com", "[external-email]"] } }`,
  inputSchema: spaceUpdateConfigSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.spaceUpdateConfig, '/space/update-config', {
    body: { spacePath: input.spacePath, updates: input.updates }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to update Space config: ${result.error}`
      }]
    };
  }

  const updatedFields = result.updated || [];
  return {
    content: [{
      type: 'text',
      text: `Updated Space "${input.spacePath}": ${updatedFields.join(', ')}`
    }]
  };
});

// =============================================================================
// Start the server
// =============================================================================
const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    console.error('[RebelSpaces] Server started');
  })
  .catch((error) => {
    console.error('[RebelSpaces] Failed to start', error);
    process.exit(1);
  });
