#!/usr/bin/env node
/**
 * RebelAutomations MCP Server
 *
 * Scheduled automations: list/create/update/delete automations, run now, enable/disable.
 *
 * Tools (10):
 * - rebel_automations_list
 * - rebel_automations_create
 * - rebel_automations_update
 * - rebel_automations_delete
 * - rebel_automations_run
 * - rebel_automations_toggle
 * - rebel_automations_list_tool_grants
 * - rebel_automations_add_tool_grant
 * - rebel_automations_remove_tool_grant
 * - rebel_list_models
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
  console.error('[RebelAutomations] Missing bridge configuration file.');
  process.exit(1);
}

const bridgePort = bridgeState.port;
const bridgeToken = bridgeState.token;
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;

// Create the server instance
const server = new McpServer({
  name: 'RebelAutomations',
  version: '1.0.0',
  description: `Scheduled automations: list/create/update/delete automations, run now, enable/disable.`
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
  list: 'rebel_automations_list',
  create: 'rebel_automations_create',
  update: 'rebel_automations_update',
  delete: 'rebel_automations_delete',
  run: 'rebel_automations_run',
  toggle: 'rebel_automations_toggle',
  listToolGrants: 'rebel_automations_list_tool_grants',
  addToolGrant: 'rebel_automations_add_tool_grant',
  removeToolGrant: 'rebel_automations_remove_tool_grant',
  listModels: 'rebel_list_models'
};

// =============================================================================
// Schemas
// =============================================================================
const scheduleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hourly'),
    minute: z.number().int().min(0).max(59)
  }),
  z.object({
    type: z.literal('daily'),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    additionalTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).optional()
  }),
  z.object({
    type: z.literal('weekly'),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1)
  }),
  z.object({
    type: z.literal('monthly'),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    daysOfMonth: z.array(z.number().int().min(1).max(31)).min(1),
    runOnLastDayIfShorter: z.boolean().optional()
  }),
  z.object({
    type: z.literal('every_n_days'),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    intervalDays: z.number().int().min(1),
    anchorDate: z.string().optional()
  }),
  z.object({
    type: z.literal('event'),
    event_type: z.string().min(1).optional(),
    eventType: z.string().min(1).optional(),
    trigger: z.string().min(1).optional()
  }).refine(
    (value) => Boolean(value.event_type || value.eventType || value.trigger),
    {
      message: 'event schedule requires event_type',
      path: ['event_type']
    }
  ),
  z.object({
    type: z.literal('once'),
    dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })
]);

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  filePath: z.string().min(1),
  schedule: scheduleSchema,
  enabled: z.boolean().optional(),
  catchUpIfMissed: z.boolean().optional(),
  model: z.string().optional(),
  thinkingModel: z.string().optional()
});

const updateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  filePath: z.string().min(1).optional(),
  schedule: scheduleSchema.optional(),
  catchUpIfMissed: z.boolean().optional(),
  model: z.string().optional(),
  thinkingModel: z.string().optional()
});

const idSchema = z.object({
  id: z.string().min(1)
});

const toggleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean()
});

// =============================================================================
// Helper Functions
// =============================================================================
const formatSchedule = (schedule) => {
  if (!schedule) return 'Unknown';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  switch (schedule.type) {
    case 'hourly':
      return `Hourly at :${String(schedule.minute).padStart(2, '0')}`;
    case 'daily': {
      let result = `Daily at ${schedule.time}`;
      if (schedule.additionalTimes?.length) {
        result += ` and ${schedule.additionalTimes.join(', ')}`;
      }
      return result;
    }
    case 'weekly': {
      const days = (schedule.daysOfWeek || []).map(d => dayNames[d]).join(', ');
      return `Weekly on ${days} at ${schedule.time}`;
    }
    case 'monthly': {
      const days = (schedule.daysOfMonth || []).join(', ');
      return `Monthly on day ${days} at ${schedule.time}`;
    }
    case 'every_n_days':
      return `Every ${schedule.intervalDays} days at ${schedule.time}`;
    case 'event': {
      const eventType = schedule.event_type || schedule.eventType || schedule.trigger;
      return `On event: ${eventType || 'unknown'}`;
    }
    case 'once': {
      const dt = new Date(schedule.dateTime);
      return `Once on ${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} at ${dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    }
    default:
      return 'Unknown schedule';
  }
};

let MODEL_LABELS = {};
try {
  MODEL_LABELS = require('./model-labels.json');
} catch {
  // Label degradation only — formatModelLabel falls back to the raw model id.
}

const formatModelLabel = (modelId) => {
  const normalized = typeof modelId === 'string' ? modelId.trim() : '';
  if (!normalized) return 'default';
  return MODEL_LABELS[normalized] || normalized;
};

const summarizeAutomations = (definitions, runs) => {
  if (!definitions || definitions.length === 0) {
    return 'No automations configured.';
  }

  return definitions.map((def, index) => {
    const recentRuns = runs?.filter(r => r.automationId === def.id).slice(0, 1) || [];
    const lastRun = recentRuns[0];
    const lastRunInfo = lastRun
      ? `Last run: ${new Date(lastRun.startedAt).toLocaleString()} (${lastRun.status})`
      : 'Never run';

    const grantCount = def.toolApprovalGrants?.length || 0;
    const grantInfo = grantCount > 0 ? `Pre-approved tools: ${grantCount}` : '';

    const hasModelOverride = typeof def.model === 'string' && def.model.trim().length > 0;
    const hasThinkingModelOverride = typeof def.thinkingModel === 'string' && def.thinkingModel.trim().length > 0;
    let modelInfo = 'default';
    if (hasModelOverride || hasThinkingModelOverride) {
      const workingModel = hasModelOverride ? `${formatModelLabel(def.model)} (custom)` : 'default';
      modelInfo = hasThinkingModelOverride
        ? `${workingModel}; thinking: ${formatModelLabel(def.thinkingModel)} (custom)`
        : workingModel;
    }

    return `${index + 1}. [${def.id}] ${def.name}
   Status: ${def.enabled ? 'Enabled' : 'Disabled'}
   Schedule: ${formatSchedule(def.schedule)}
   Model: ${modelInfo}
   File: ${def.filePath}
   ${lastRunInfo}${grantInfo ? `\n   ${grantInfo}` : ''}`;
  }).join('\n\n');
};

// =============================================================================
// Tool Registrations
// =============================================================================

// List automations
server.registerTool(TOOL_NAMES.list, {
  title: 'List automations',
  description: `List all configured automations with their IDs, schedules, and recent run status.

Call this first when the user asks to "show automations", "what automations do I have", or before update/delete operations to get automation IDs.

Returns a list with [id] for each automation, plus schedule and status info.`,
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.list, '/automations', { method: 'GET' });
  return {
    content: [{ type: 'text', text: summarizeAutomations(result.definitions ?? [], result.runs ?? []) }]
  };
});

// Create automation
server.registerTool(TOOL_NAMES.create, {
  title: 'Create automation',
  description: `Create a new scheduled automation.

PARAMETERS:
- name (required): Human-readable name for the automation
- filePath (required): Path to the skill or file to execute (relative to Library)
- schedule (required): When to run. Object with "type" and schedule-specific fields:
  * {type:"hourly", minute:30} - Every hour at minute 30
  * {type:"daily", time:"09:00"} - Every day at time
  * {type:"daily", time:"09:00", additionalTimes:["17:00"]} - Multiple times per day
  * {type:"weekly", time:"09:00", daysOfWeek:[1,5]} - Specific days (0=Sun, 6=Sat)
  * {type:"monthly", time:"09:00", daysOfMonth:[1,15]} - Specific days of month
  * {type:"every_n_days", time:"09:00", intervalDays:3} - Every N days (anchorDate auto-set if omitted)
  * {type:"event", event_type:"transcript-ready"} - On event trigger (legacy aliases: eventType, trigger)
  * {type:"once", dateTime:"2026-03-26T15:00"} - Run once at specific date/time
- description (optional): What this automation does
- enabled (optional): Start enabled (default: true)
- catchUpIfMissed (optional): Run missed executions (default: true)
- model (optional): Claude model to use (e.g., "claude-haiku-4-5", "claude-sonnet-4-6"). Defaults to your global model setting. Use "" to clear and revert to default.
- thinkingModel (optional): Claude model for thinking/planning phase. Only useful when model is also set. Use "" to clear.

EXAMPLE: Create a daily standup prep at 8:30am:
{
  "name": "Daily Standup Prep",
  "filePath": "skills/standup-prep/SKILL.md",
  "schedule": {"type": "daily", "time": "08:30"},
  "description": "Prepares standup notes each morning"
}`,
  inputSchema: createSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const payload = {
    name: input.name.trim(),
    description: input.description?.trim() || '',
    filePath: input.filePath.trim(),
    schedule: input.schedule,
    enabled: input.enabled ?? true,
    catchUpIfMissed: input.catchUpIfMissed ?? true,
    ...(input.model !== undefined && { model: input.model.trim() }),
    ...(input.thinkingModel !== undefined && { thinkingModel: input.thinkingModel.trim() })
  };

  const result = await bridgeRequest(TOOL_NAMES.create, '/automations/upsert', { body: payload });
  const def = result?.definition ?? result;
  const nextRunAt = def?.nextRunAt ? new Date(def.nextRunAt).toLocaleString() : null;
  const scheduleWarning = (input.schedule?.type === 'once' && !nextRunAt)
    ? '\n\n⚠️ WARNING: nextRunAt is null — the scheduled time may have already passed. This automation will not fire.'
    : '';
  return {
    content: [{ type: 'text', text: `Created automation "${input.name}" (id: ${def?.id ?? 'unknown'}). Schedule: ${formatSchedule(input.schedule)}. Next run: ${nextRunAt ?? 'not scheduled'}${scheduleWarning}` }]
  };
});

// Update automation
server.registerTool(TOOL_NAMES.update, {
  title: 'Update automation',
  description: `Modify an existing automation's settings.

PARAMETERS:
- id (required): Automation ID (from rebel_automations_list)
- name (optional): New name
- description (optional): New description
- filePath (optional): New skill/file path
- schedule (optional): New schedule (same format as create):
  * {type:"hourly", minute:30} - Every hour at minute 30
  * {type:"daily", time:"09:00"} - Every day at time
  * {type:"weekly", time:"09:00", daysOfWeek:[1,5]} - Specific days (0=Sun, 6=Sat)
  * {type:"monthly", time:"09:00", daysOfMonth:[1,15]} - Specific days of month
  * {type:"every_n_days", time:"09:00", intervalDays:3} - Every N days (anchorDate auto-set if omitted)
  * {type:"event", event_type:"transcript-ready"} - On event trigger (legacy aliases: eventType, trigger)
  * {type:"once", dateTime:"2026-03-26T15:00"} - Run once at specific date/time
- catchUpIfMissed (optional): Whether to run missed executions
- model (optional): Claude model to use (e.g., "claude-haiku-4-5", "claude-sonnet-4-6"). Defaults to your global model setting. Use "" to clear and revert to default.
- thinkingModel (optional): Claude model for thinking/planning phase. Only useful when model is also set. Use "" to clear.

Only include fields you want to change. Call rebel_automations_list first to get the ID.`,
  inputSchema: updateSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  // Note: anchorDate auto-fill is handled at the IPC bridge boundary by
  // AutomationSchedule.fromUntrusted({source:'mcp', existingCreatedAt, now}).
  // For updates, it backfills from existing definition's createdAt; for creates,
  // it backfills from `now`. The scheduler's upsertDefinition no longer does
  // runtime anchorDate backfill (removed in R6 Stage 3 da3171553).

  const payload = {
    id: input.id,
    ...(input.name && { name: input.name.trim() }),
    ...(input.description !== undefined && { description: input.description?.trim() || '' }),
    ...(input.filePath && { filePath: input.filePath.trim() }),
    ...(input.schedule && { schedule: input.schedule }),
    ...(input.catchUpIfMissed !== undefined && { catchUpIfMissed: input.catchUpIfMissed }),
    ...(input.model !== undefined && { model: input.model.trim() }),
    ...(input.thinkingModel !== undefined && { thinkingModel: input.thinkingModel.trim() })
  };

  await bridgeRequest(TOOL_NAMES.update, '/automations/upsert', { body: payload });
  return {
    content: [{ type: 'text', text: `Updated automation ${input.id}.` }]
  };
});

// Toggle automation
server.registerTool(TOOL_NAMES.toggle, {
  title: 'Enable/disable automation',
  description: `Turn an automation on or off.

PARAMETERS:
- id (required): Automation ID (from rebel_automations_list)
- enabled (required): true to enable, false to disable

Use when user says "pause", "stop", "disable", "turn off" or "enable", "start", "turn on" an automation.`,
  inputSchema: toggleSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const payload = {
    id: input.id,
    enabled: input.enabled
  };

  await bridgeRequest(TOOL_NAMES.toggle, '/automations/upsert', { body: payload });
  const action = input.enabled ? 'Enabled' : 'Disabled';
  return {
    content: [{ type: 'text', text: `${action} automation ${input.id}.` }]
  };
});

// Delete automation
server.registerTool(TOOL_NAMES.delete, {
  title: 'Delete automation',
  description: `Permanently delete an automation.

PARAMETERS:
- id (required): Automation ID (from rebel_automations_list)

Use when user says "delete", "remove", or "get rid of" an automation. This cannot be undone.`,
  inputSchema: idSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async (input) => {
  await bridgeRequest(TOOL_NAMES.delete, '/automations/delete', { body: { id: input.id } });
  return {
    content: [{ type: 'text', text: `Deleted automation ${input.id}.` }]
  };
});

// Run automation now
server.registerTool(TOOL_NAMES.run, {
  title: 'Run automation now',
  description: `Trigger an automation to run immediately, regardless of its schedule.

PARAMETERS:
- id (required): Automation ID (from rebel_automations_list)

Use when user says "run now", "execute", "trigger", or wants to test an automation.`,
  inputSchema: idSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.run, '/automations/run-now', { body: { id: input.id } });
  return {
    content: [{ type: 'text', text: `Started automation ${input.id}. Check the Automations panel for run status.` }]
  };
});

// =============================================================================
// Tool Grant Management
// =============================================================================

const toolGrantAddSchema = z.object({
  id: z.string().min(1),
  toolId: z.string().min(1)
});

const toolGrantRemoveSchema = z.object({
  id: z.string().min(1),
  grantId: z.string().min(1)
});

// List tool grants
server.registerTool(TOOL_NAMES.listToolGrants, {
  title: 'List pre-approved tools for automation',
  description: `Show which tools are pre-approved to run without asking when a specific automation runs.

PARAMETERS:
- id (required): Automation ID (from rebel_automations_list)

Returns the list of tool grants with their grant IDs and tool identifiers. Use this when the user asks "what tools are approved for this automation" or before removing a grant.`,
  inputSchema: idSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.listToolGrants, `/automations/tool-grants?id=${encodeURIComponent(input.id)}`, { method: 'GET' });
  const grants = result.grants || [];
  if (grants.length === 0) {
    return {
      content: [{ type: 'text', text: `No pre-approved tools for "${result.automationName}" (${result.automationId}). Tools will require approval each time they run.` }]
    };
  }
  const lines = grants.map((g, i) =>
    `${i + 1}. ${g.toolId}\n   Grant ID: ${g.grantId || g.id}\n   Added: ${new Date(g.createdAt).toLocaleString()} (${g.createdFrom})`
  ).join('\n\n');
  return {
    content: [{ type: 'text', text: `Pre-approved tools for "${result.automationName}":\n\n${lines}` }]
  };
});

// Add tool grant
server.registerTool(TOOL_NAMES.addToolGrant, {
  title: 'Pre-approve a tool for automation',
  description: `Pre-approve a tool so it runs without asking when a specific automation runs.

PARAMETERS:
- id (required): Automation ID (from rebel_automations_list)
- toolId (required): The tool identifier to pre-approve (e.g. "gmail:send_message", "calendar:list_events")

Use when the user says "always allow this tool for that automation" or wants to pre-approve tools. If duplicate, the existing grant is kept.`,
  inputSchema: toolGrantAddSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  await bridgeRequest(TOOL_NAMES.addToolGrant, '/automations/tool-grants/add', { body: { id: input.id, toolId: input.toolId } });
  return {
    content: [{ type: 'text', text: `Pre-approved "${input.toolId}" for automation ${input.id}. It will run without asking on future runs.` }]
  };
});

// Remove tool grant
server.registerTool(TOOL_NAMES.removeToolGrant, {
  title: 'Remove pre-approved tool from automation',
  description: `Remove a pre-approved tool from an automation so it requires approval again.

PARAMETERS:
- id (required): Automation ID (from rebel_automations_list)
- grantId (required): The grant ID to remove (from rebel_automations_list_tool_grants)

Call rebel_automations_list_tool_grants first to get the grant ID.`,
  inputSchema: toolGrantRemoveSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async (input) => {
  await bridgeRequest(TOOL_NAMES.removeToolGrant, '/automations/tool-grants/remove', { body: { id: input.id, grantId: input.grantId } });
  return {
    content: [{ type: 'text', text: `Removed tool grant ${input.grantId} from automation ${input.id}. The tool will require approval again.` }]
  };
});

// List available models
server.registerTool(TOOL_NAMES.listModels, {
  title: 'List available models',
  description: `List all models and model profiles the user has configured.

Returns Claude models (Haiku, Sonnet, Opus) and any custom model profiles (OpenAI, Gemini, local models, etc.).
Also shows the user's current default working and thinking models.

Use this when:
- Setting a model for an automation (to know what's available)
- The user asks "what models do I have?" or "which models can I use?"
- You need the correct model ID before calling rebel_automations_create or rebel_automations_update

IMPORTANT: Only models marked "supported for automations" can be used as automation model overrides.
Custom model profiles are shown for reference but are not yet supported for per-automation overrides.
Use the "id" field from supported models for the model/thinkingModel parameters.`,
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.listModels, '/automations/models', { method: 'GET' });
  const models = result.models || [];
  const current = result.current || {};

  const supported = models.filter(m => m.supportedForAutomations);
  const profiles = models.filter(m => !m.supportedForAutomations);

  let output = 'Models available for automations:\n\n';
  supported.forEach((m, i) => {
    output += `  ${i + 1}. ${m.label} — id: ${m.id}${m.isMainModel ? '' : ' (auxiliary only)'}\n`;
  });

  if (profiles.length > 0) {
    output += '\nCustom model profiles (not yet supported for per-automation overrides):\n';
    profiles.forEach((m, i) => {
      output += `  ${i + 1}. ${m.label} — id: ${m.id}\n`;
    });
  }

  output += `\nCurrent defaults:\n`;
  output += `  Working model: ${current.working || 'not set'}\n`;
  output += `  Thinking model: ${current.thinking || 'none (single-model mode)'}`;

  return {
    content: [{ type: 'text', text: output }]
  };
});

// =============================================================================
// Start the server
// =============================================================================
const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    console.error('[RebelAutomations] Server started');
  })
  .catch((error) => {
    console.error('[RebelAutomations] Failed to start', error);
    process.exit(1);
  });
