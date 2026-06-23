#!/usr/bin/env node
/**
 * RebelSettings MCP Server
 *
 * App configuration: get/update settings, environment info, STT vocabulary, use case library.
 *
 * Tools (22):
 * - rebel_internal_get_environment
 * - rebel_settings_get
 * - rebel_settings_update
 * - rebel_vocabulary_get
 * - rebel_vocabulary_update
 * - rebel_usecases_list
 * - rebel_usecases_add
 * - rebel_user_identity_set
 * - rebel_safety_prompt_get
 * - rebel_safety_prompt_update
 * - rebel_auth_set_claude_max_token
 * - rebel_settings_set_quality_tier
 * - rebel_settings_set_model_roles
 * - rebel_settings_set_api_key
 * - rebel_settings_set_voice
 * - rebel_settings_list_model_profiles
 * - rebel_settings_add_model_profile
 * - rebel_settings_edit_model_profile
 * - rebel_settings_remove_model_profile
 * - rebel_settings_activate_model_profile
 * - rebel_settings_set_memory_safety_defaults
 * - rebel_settings_set_space_safety
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
  console.error('[RebelSettings] Missing bridge configuration file.');
  process.exit(1);
}

const bridgePort = bridgeState.port;
const bridgeToken = bridgeState.token;
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;

// Localhost bridge fetch dispatcher.
// Node's global fetch (undici under the hood) defaults to 300s bodyTimeout
// and 300s headersTimeout. A bridge handler that legitimately takes longer —
// or worse, deadlocks waiting on the calling agent turn — silently dies at
// exactly 301s with a generic "fetch failed", which is what bit FOX-3331 /
// Sentry REBEL-5MG (2026-05-22). The deadlock itself is fixed at the
// callsite (in-turn handlers must pass priority=true to the embedder), but
// this dispatcher is defence-in-depth: it removes the 300s ceiling so
// future regressions of the same shape don't reincarnate the same mystery.
//
// Same `bodyTimeout: 0` strategy as src/core/rebelCore/mcpClient.ts, but
// we also disable `headersTimeout` (mcpClient uses 60_000): the bridge
// response is non-streaming so headers don't arrive until the handler
// completes, and `waitForModelReady()` can legitimately exceed 60s on
// first-time embedding-model init. The outer MCP tool timeout (~4h) and
// the embedder watchdog (30 min) remain the real ceilings.
//
// Requires `undici` in runtime deps (package.json `dependencies`). The
// try/catch is a belt-and-braces fallback so a missing-module would
// degrade rather than crash the server, but it should never trigger.
let bridgeDispatcher = null;
try {
  const { Agent } = require('undici');
  bridgeDispatcher = new Agent({
    bodyTimeout: 0,
    headersTimeout: 0,
    keepAliveTimeout: 60_000
  });
} catch (err) {
  console.warn('[RebelSettings] undici unavailable; bridge fetch will use Node fetch defaults (300s timeouts). This means the FOX-3331 defence-in-depth is inert — check that "undici" is in package.json dependencies. Error:', err?.message);
}

// Create the server instance
const server = new McpServer({
  name: 'RebelSettings',
  version: '1.0.0',
  description: `App configuration: get/update settings, environment info, STT vocabulary, use case library, safety rules.`
});

// Helper: Make bridge requests
const bridgeRequest = async (toolName, path, options = {}) => {
  const { method = 'POST', body } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {})
  };

  const fetchInit = {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  };
  if (bridgeDispatcher) {
    fetchInit.dispatcher = bridgeDispatcher;
  }
  const response = await fetch(`${bridgeBaseUrl}${path}`, fetchInit);

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
  env: 'rebel_internal_get_environment',
  getSettings: 'rebel_settings_get',
  updateSettings: 'rebel_settings_update',
  getVocabulary: 'rebel_vocabulary_get',
  updateVocabulary: 'rebel_vocabulary_update',
  usecasesList: 'rebel_usecases_list',
  usecasesAdd: 'rebel_usecases_add',
  userIdentitySet: 'rebel_user_identity_set',
  getSafetyPrompt: 'rebel_safety_prompt_get',
  updateSafetyPrompt: 'rebel_safety_prompt_update',
  setClaudeMaxToken: 'rebel_auth_set_claude_max_token',
  setQualityTier: 'rebel_settings_set_quality_tier',
  setModelRoles: 'rebel_settings_set_model_roles',
  setApiKey: 'rebel_settings_set_api_key',
  setVoice: 'rebel_settings_set_voice',
  listModelProfiles: 'rebel_settings_list_model_profiles',
  addModelProfile: 'rebel_settings_add_model_profile',
  editModelProfile: 'rebel_settings_edit_model_profile',
  removeModelProfile: 'rebel_settings_remove_model_profile',
  activateModelProfile: 'rebel_settings_activate_model_profile',
  setMemorySafetyDefaults: 'rebel_settings_set_memory_safety_defaults',
  setSpaceSafety: 'rebel_settings_set_space_safety'
};

// =============================================================================
// Schemas
// =============================================================================
const environmentSchema = z.object({
  format: z.enum(['text', 'json']).optional()
});

const getSettingsSchema = z.object({});

const updateSettingsSchema = z.object({
  updates: z.object({
    theme: z.enum(['light', 'dark', 'system']).optional().describe('UI theme preference'),
    accentColor: z.enum(['purple', 'blue', 'indigo', 'teal', 'rose', 'orange', 'amber', 'slate']).optional().describe('Accent color: purple (default), blue, indigo, teal, rose, orange, amber, or slate'),
    fontScale: z.enum(['small', 'default', 'large']).optional().describe('Font size scale: small (85%), default (100%), large (115%)'),
    uiDensity: z.enum(['compact', 'comfortable', 'spacious']).optional().describe('UI density: compact reduces spacing, spacious increases it'),
    conversationWidth: z.enum(['narrow', 'medium', 'wide']).optional().describe('Conversation content width: narrow (focused column), medium (default), wide (fills space)'),
    indexingEnabled: z.boolean().optional().describe('Enable/disable file indexing for search'),
    gpuEmbeddingEnabled: z.boolean().optional().describe('Enable/disable GPU acceleration for embeddings'),
    backgroundEnhancement: z.boolean().optional().describe('Enable/disable background visual effects'),
    streaming: z.object({
      enabled: z.boolean().optional().describe('Enable/disable streaming responses')
    }).optional()
  }).describe('Settings to update (only allowed fields)')
});

const getVocabularySchema = z.object({});

const updateVocabularySchema = z.object({
  action: z.enum(['add', 'remove', 'replace']).describe('Action: "add" merges new terms, "remove" deletes specific terms, "replace" overwrites all'),
  terms: z.array(z.string()).describe('Array of vocabulary terms (proper nouns, technical terms, company names, etc.)')
});

const usecasesListSchema = z.object({
  limit: z.number().min(1).max(50).optional().describe('Max use cases to return (default 10)')
});

const usecasesAddSchema = z.object({
  useCases: z.array(z.object({
    title: z.string().min(1).max(100).describe('Clear, action-oriented title (5-8 words)'),
    description: z.string().min(1).describe('One sentence describing the use case'),
    prompt: z.string().min(1).describe('The full prompt to execute this use case'),
    icon: z.string().optional().describe('Single emoji icon (default: ✨)'),
    qualityRating: z.number().min(0).max(100).optional().describe('Quality score 0-100 (default: 90)')
  })).min(1).describe('Array of use case candidates to add')
});

const userIdentitySetSchema = z.object({
  firstName: z.string().min(2).max(30).optional().describe('User\'s first name (2-30 characters)'),
  email: z.string().email().optional().describe('User\'s email address')
});

const getSafetyPromptSchema = z.object({});

const updateSafetyPromptSchema = z.object({
  prompt: z.string().min(1).max(50000).describe('The complete updated safety rules text. This replaces the entire document.')
});

const setClaudeMaxTokenSchema = z.object({
  token: z.string().min(33).describe('Claude Max OAuth token (starts with sk-ant-oat01- followed by at least 20 characters)')
});

const setQualityTierSchema = z.object({
  tier: z.enum(['quick', 'balanced', 'thorough', 'maximum']).describe('Quality tier: quick (fast), balanced (default), thorough (deep reasoning), maximum (best quality)')
});

const setModelRolesSchema = z.object({
  working: z.string().optional().describe('Claude model ID for the working role (e.g., "claude-opus-4-8")'),
  thinking: z.string().optional().describe('Claude model ID for the thinking role'),
  background: z.string().optional().describe('Claude model ID for behind-the-scenes tasks'),
  thinkingEffort: z.enum(['xhigh', 'high', 'medium', 'low']).optional().describe('Thinking effort level')
});

const setApiKeySchema = z.object({
  provider: z.enum(['claude', 'openai', 'elevenlabs', 'google', 'together', 'cerebras']).describe('API key provider'),
  apiKey: z.string().min(1).describe('The API key to store')
});

const setVoiceSchema = z.object({
  provider: z.enum(['openai-whisper', 'elevenlabs-scribe', 'local-parakeet', 'local-moonshine', 'custom-openai']).optional().describe('Voice provider'),
  ttsVoice: z.string().optional().describe('Text-to-speech voice ID (provider-specific)'),
  autoSpeak: z.boolean().optional().describe('Whether to auto-speak responses'),
  voiceInputLanguage: z.string().optional().describe('Voice input language (ISO 639-1 code or "auto")')
});

const listModelProfilesSchema = z.object({});

const addModelProfileSchema = z.object({
  name: z.string().min(1).describe('User-friendly profile name'),
  providerType: z.enum(['anthropic', 'openai', 'google', 'together', 'cerebras', 'openrouter', 'other', 'local']).describe('Model provider type'),
  serverUrl: z.string().optional().describe('Server URL (required for "other" and "local"; preset for known providers)'),
  model: z.string().optional().describe('Model identifier'),
  apiKey: z.string().optional().describe('Per-profile API key (optional if shared provider key exists)')
});

const editModelProfileSchema = z.object({
  profileId: z.string().min(1).describe('ID of the profile to edit'),
  name: z.string().min(1).optional().describe('New profile name'),
  model: z.string().optional().describe('New model identifier'),
  apiKey: z.string().optional().describe('New per-profile API key (set to empty string to clear)')
});

const removeModelProfileSchema = z.object({
  profileId: z.string().min(1).describe('ID of the profile to remove')
});

const activateModelProfileSchema = z.object({
  profileId: z.string().nullable().describe('Profile ID to activate, or null to deactivate and revert to Claude'),
  role: z.enum(['working', 'thinking']).describe('Which role to assign the profile to')
});

const setMemorySafetyDefaultsSchema = z.object({
  private: z.enum(['permissive', 'balanced', 'cautious']).optional().describe('Default safety level for private spaces'),
  shared: z.enum(['balanced', 'cautious']).optional().describe('Default safety level for shared spaces (cannot be permissive)')
});

const setSpaceSafetySchema = z.object({
  spacePath: z.string().min(1).describe('Workspace-relative POSIX path of the space (e.g., "work/Acme/General")'),
  level: z.enum(['permissive', 'balanced', 'cautious']).describe('Safety level for this space')
});

// =============================================================================
// Tool Registrations
// =============================================================================

// Get environment
server.registerTool(TOOL_NAMES.env, {
  title: 'Get Rebel environment',
  description: 'Returns context about the user\'s environment: OS, workspace path, current time/timezone, username, and shell. Useful when you need to understand the user\'s setup for file paths, scheduling, or platform-specific guidance. Prefer format="text" for readability.',
  inputSchema: environmentSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const format = input?.format || 'text';
  const payload = await bridgeRequest(TOOL_NAMES.env, '/environment', { method: 'GET' });
  const env = payload?.environment || {};

  if (format === 'json') {
    return {
      content: [{
        type: 'text',
        text: `Environment snapshot (JSON):\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\``
      }]
    };
  }

  const platform = env.platform || {};
  const nodeInfo = env.node || {};
  const time = env.time || {};
  const workspace = env.workspace || {};
  const envInfo = env.env || {};

  const lines = [];
  lines.push(
    `Platform: ${platform.os || 'unknown'} ${platform.release || ''} (${platform.arch || 'unknown'})`.trim()
  );
  if (nodeInfo.version) {
    lines.push(`Node: ${nodeInfo.version}`);
  }
  if (workspace.hasWorkspace) {
    lines.push(`Workspace: ${workspace.coreDirectory}`);
  } else {
    lines.push('Workspace: not configured');
  }
  if (time.local || time.iso) {
    const timeLabel = time.local || time.iso;
    const tz = time.timezone || '';
    lines.push(`Time: ${timeLabel}${tz ? ` (${tz})` : ''}`.trim());
  }
  if (envInfo.user) {
    lines.push(`User: ${envInfo.user}`);
  }
  if (envInfo.homeDir) {
    lines.push(`Home: ${envInfo.homeDir}`);
  }
  if (envInfo.shell) {
    lines.push(`Shell: ${envInfo.shell}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Get settings
server.registerTool(TOOL_NAMES.getSettings, {
  title: 'Get Rebel settings',
  description: `Get current Rebel settings with sensitive fields redacted.

Returns user preferences like theme, voice, indexing options, connected MCPs, etc.
API keys and secrets are automatically redacted for safety.
Use this to understand the user's current configuration.`,
  inputSchema: getSettingsSchema,
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.getSettings, '/settings/get', {});

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to get settings: ${result.error}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result.settings, null, 2)
    }]
  };
});

// Update settings
server.registerTool(TOOL_NAMES.updateSettings, {
  title: 'Update settings',
  description: `Update low-risk Rebel settings.

You MUST have explicit user permission before changing settings.

Only these fields can be updated via MCP (safety allowlist):
- theme: UI theme (light/dark/system)
- accentColor: Accent color (purple/blue/indigo/teal/rose/orange/amber/slate)
- fontScale: Font size (small/default/large)
- uiDensity: UI density (compact/comfortable/spacious)
- conversationWidth: Content width (narrow/medium/wide)
- indexingEnabled: File search indexing
- gpuEmbeddingEnabled: GPU acceleration
- backgroundEnhancement: Visual effects
- streaming.enabled: Response streaming

For other settings, direct the user to Settings in the app.`,
  inputSchema: updateSettingsSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.updateSettings, '/settings/update', {
    body: { updates: input.updates }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to update settings: ${result.error}`
      }]
    };
  }

  const updated = result.updated || [];
  return {
    content: [{
      type: 'text',
      text: `Updated settings: ${updated.join(', ')}`
    }]
  };
});

// Get vocabulary
server.registerTool(TOOL_NAMES.getVocabulary, {
  title: 'Get custom vocabulary',
  description: `Retrieve the custom vocabulary used for speech-to-text (STT) transcription and voice recognition.

This is also known as the "transcription vocabulary" or "voice dictation terms" — words and phrases that help the speech recognition system accurately transcribe difficult or domain-specific language.

**Returns:** The list of configured terms including:
- People's names (especially unusual spellings)
- Company and product names
- Technical terms and industry jargon
- Acronyms spoken as words
- Brand names and trademarks

These terms improve transcription accuracy when dictating via voice input.`,
  inputSchema: getVocabularySchema,
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.getVocabulary, '/vocabulary', { method: 'GET' });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to get vocabulary: ${result.error}`
      }]
    };
  }

  const vocabulary = result.vocabulary || [];
  if (vocabulary.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No custom transcription vocabulary configured. Add terms to improve recognition of names, technical terms, and domain-specific language.'
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `**Transcription Vocabulary (${vocabulary.length} terms):**\n\n${vocabulary.join('\n')}`
    }]
  };
});

// Update vocabulary
server.registerTool(TOOL_NAMES.updateVocabulary, {
  title: 'Update custom vocabulary',
  description: `Modify the custom vocabulary for speech-to-text (STT) transcription and voice recognition.

Use this tool to add, remove, or replace terms in the "transcription vocabulary" or "voice dictation word list" — the set of words and phrases that help the speech recognition system accurately transcribe difficult or domain-specific language.

**IMPORTANT**: You MUST have explicit user permission before modifying vocabulary.

**Use cases:** Improve recognition of difficult words including:
- People's names (especially unusual spellings like "Jyoti" or "Nguyen")
- Company and product names (e.g., "Mindstone", "Asana", "Figma")
- Technical terms and industry jargon
- Acronyms spoken as words (e.g., "HIPAA", "GDPR")
- Brand names and trademarks

**Actions:**
- \`add\`: Merge new terms with existing vocabulary (deduplicates automatically)
- \`remove\`: Delete specific terms from vocabulary
- \`replace\`: Overwrite entire vocabulary with new terms

**Limits:** Maximum 200 terms, maximum 100 characters per term.

**Returns:** A diff showing before/after term counts and what was added or removed.`,
  inputSchema: updateVocabularySchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.updateVocabulary, '/vocabulary/update', {
    body: { action: input.action, terms: input.terms }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to update vocabulary: ${result.error}`
      }]
    };
  }

  const { before, after, added, removed } = result;
  const lines = [];

  if (added.length > 0) {
    lines.push(`**Added (${added.length}):** ${added.join(', ')}`);
  }
  if (removed.length > 0) {
    lines.push(`**Removed (${removed.length}):** ${removed.join(', ')}`);
  }
  if (added.length === 0 && removed.length === 0) {
    lines.push('No changes made (terms already present or not found).');
  }

  lines.push('');
  lines.push(`**Total terms:** ${before.length} → ${after.length}`);

  return {
    content: [{
      type: 'text',
      text: lines.join('\n')
    }]
  };
});

// List use cases
server.registerTool(TOOL_NAMES.usecasesList, {
  title: 'List use cases',
  description: `List personalized use cases from the library.

Returns use case summaries without embeddings (for token efficiency).
Use this to see what use cases already exist before adding new ones.

Returns: Array of use cases with title, description, prompt, icon, and qualityRating.`,
  inputSchema: usecasesListSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.usecasesList, '/usecases/list', {
    body: { limit: input?.limit }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to list use cases: ${result.error}`
      }]
    };
  }

  const useCases = result.useCases || [];
  if (useCases.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No use cases found in the library.'
      }]
    };
  }

  const summary = useCases.map((uc, i) => {
    const icon = uc.icon || '✨';
    const quality = uc.qualityRating != null ? ` (quality: ${uc.qualityRating})` : '';
    return `${i + 1}. ${icon} **${uc.title}**${quality}\n   ${uc.description}`;
  }).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `Found ${useCases.length} use case(s):\n\n${summary}`
    }]
  };
});

// Add use cases
server.registerTool(TOOL_NAMES.usecasesAdd, {
  title: 'Add use cases',
  description: `Add personalized use cases to the library.

Handles semantic deduplication automatically - if a very similar use case already exists, it won't be added (returns "duplicate" reason).

Each use case needs:
- title: Clear, action-oriented (5-8 words)
- description: One sentence explaining what it does
- prompt: The full prompt to execute this use case
- icon: (optional) Single emoji, defaults to ✨
- qualityRating: (optional) 0-100 score, defaults to 90

Returns per-item results showing whether each was added or rejected.`,
  inputSchema: usecasesAddSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.usecasesAdd, '/usecases/add', {
    body: { useCases: input.useCases }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to add use cases: ${result.error}`
      }]
    };
  }

  const results = result.results || [];
  const added = results.filter(r => r.added);
  const rejected = results.filter(r => !r.added);

  const lines = [];
  if (added.length > 0) {
    lines.push(`✓ Added ${added.length} use case(s):`);
    for (const r of added) {
      lines.push(`  - "${r.title}"`);
    }
  }
  if (rejected.length > 0) {
    lines.push('');
    lines.push(`✗ Rejected ${rejected.length} use case(s):`);
    for (const r of rejected) {
      lines.push(`  - "${r.title}": ${r.reason}`);
    }
  }

  return {
    content: [{
      type: 'text',
      text: lines.join('\n')
    }]
  };
});

// Set user identity
server.registerTool(TOOL_NAMES.userIdentitySet, {
  title: 'Set user identity',
  description: `Set the user's first name and/or email address during onboarding discovery.

This tool is used internally by the onboarding-discovery skill to persist identity information
extracted from communication data (Gmail signatures, Calendar events, Slack profiles).

Only sets values if they are not already configured - existing values are preserved.

**Parameters:**
- firstName: User's first name (2-30 characters, must start with a letter)
- email: User's email address (must be valid email format)

**Returns:** Which fields were updated vs skipped (already set).`,
  inputSchema: userIdentitySetSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  if (!input.firstName && !input.email) {
    return {
      content: [{
        type: 'text',
        text: 'No identity fields provided. Provide at least firstName or email.'
      }]
    };
  }

  const result = await bridgeRequest(TOOL_NAMES.userIdentitySet, '/user/identity', {
    body: { firstName: input.firstName, email: input.email }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to set user identity: ${result.error}`
      }]
    };
  }

  const updated = result.updated || [];
  const skipped = result.skipped || [];
  const lines = [];

  if (updated.length > 0) {
    lines.push(`✓ Updated: ${updated.join(', ')}`);
  }
  if (skipped.length > 0) {
    lines.push(`○ Skipped (already set): ${skipped.join(', ')}`);
  }

  return {
    content: [{
      type: 'text',
      text: lines.join('\n') || 'No changes made.'
    }]
  };
});

// Get safety prompt
server.registerTool(TOOL_NAMES.getSafetyPrompt, {
  title: 'Get safety rules',
  description: `Read the user's current safety rules (principles document) and recent safety evaluation activity.

Use this to understand their current safety configuration before making changes.
Returns the full safety prompt text, version info, and the 10 most recent safety evaluations.`,
  inputSchema: getSafetyPromptSchema,
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.getSafetyPrompt, '/safety-prompt/get', {});

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to get safety rules: ${result.error}`
      }]
    };
  }

  const lines = [];
  lines.push(`**Safety Rules** (version ${result.version})`);
  if (result.lastUpdatedAt) {
    lines.push(`Last updated: ${new Date(result.lastUpdatedAt).toLocaleString()} by ${result.lastUpdatedBy || 'unknown'}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(result.prompt);

  if (result.recentActivity && result.recentActivity.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`**Recent Activity** (last ${result.recentActivity.length} evaluations):`);
    lines.push('');
    for (const entry of result.recentActivity) {
      if (entry.type === 'evaluation') {
        const icon = entry.decision === 'allow' ? '✓' : entry.decision === 'block' ? '✗' : '?';
        lines.push(`${icon} **${entry.toolDisplayName || entry.toolId}**: ${entry.actionSummary || 'No summary'} → ${entry.decision}${entry.reason ? ` (${entry.reason})` : ''}`);
      } else if (entry.type === 'version-change') {
        lines.push(`↻ Rules updated: v${entry.fromVersion} → v${entry.toVersion}`);
      }
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Update safety prompt
server.registerTool(TOOL_NAMES.updateSafetyPrompt, {
  title: 'Update safety rules',
  description: `Update the user's safety rules.

**IMPORTANT**: Always show the user the proposed changes and get explicit confirmation before calling this tool.

The complete rules text must be provided — this replaces the entire document.
Changes take effect immediately. The evaluation cache is cleared automatically.`,
  inputSchema: updateSafetyPromptSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.updateSafetyPrompt, '/safety-prompt/update', {
    body: { prompt: input.prompt }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to update safety rules: ${result.error}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `Safety rules updated to version ${result.version}. Changes are active immediately.`
    }]
  };
});

// Set Claude Max token
server.registerTool(TOOL_NAMES.setClaudeMaxToken, {
  title: 'Set Claude Max token',
  description: `Securely store a Claude Max OAuth token and switch the authentication method to Claude Max.

The token is saved to settings and the auth method is switched automatically.
The raw token is NEVER echoed back — only a masked confirmation is returned.

**IMPORTANT**: This tool writes a credential. Only call it when the user has explicitly
provided or generated a token (e.g., via the claude-max-token-setup skill).

**Input:** A Claude Max OAuth token (starts with sk-ant-oat01-...)
**Returns:** Masked confirmation like "sk-ant-oat01-****XXXX"`,
  inputSchema: setClaudeMaxTokenSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const token = input?.token;

  if (!token || !/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token)) {
    return {
      content: [{
        type: 'text',
        text: 'Invalid token format. Expected a token starting with sk-ant-oat01- followed by at least 20 characters.'
      }],
      isError: true
    };
  }

  try {
    const result = await bridgeRequest(TOOL_NAMES.setClaudeMaxToken, '/auth/set-claude-max-token', {
      body: { token }
    });

    if (!result.success) {
      return {
        content: [{
          type: 'text',
          text: `Failed to save token: ${result.error}`
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: 'text',
        text: `Claude Max token saved successfully. Masked: ${result.masked}\n\nAuthentication method has been switched to Claude Max.`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Failed to save Claude Max token: ${error.message}`
      }],
      isError: true
    };
  }
});

// Set quality tier
server.registerTool(TOOL_NAMES.setQualityTier, {
  title: 'Set quality tier',
  description: `Set the AI quality tier for conversations. Tiers control which models handle your work and how much reasoning depth is applied.

- quick: Fast responses for simple tasks (Haiku, low effort)
- balanced: Good balance of speed and quality (Sonnet, high effort) — the default
- thorough: Deep reasoning for complex tasks (Sonnet + Opus for thinking)
- maximum: Best available quality (Opus everywhere, maximum effort)

You MUST have explicit user permission before changing the quality tier.`,
  inputSchema: setQualityTierSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.setQualityTier, '/settings/set-quality-tier', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to set quality tier: ${error.message}` }], isError: true };
  }
});

// Set model roles (advanced)
server.registerTool(TOOL_NAMES.setModelRoles, {
  title: 'Set model roles',
  description: `Advanced: Set specific Claude models for working and thinking roles, or change the thinking effort level.

For most users, use rebel_settings_set_quality_tier instead — it maps friendly tier names to the right model configuration.

This tool is for users who explicitly name models (e.g., 'use Opus for everything' or 'set thinking effort to medium').

You MUST have explicit user permission.`,
  inputSchema: setModelRolesSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.setModelRoles, '/settings/set-model-roles', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to set model roles: ${error.message}` }], isError: true };
  }
});

// Set API key
server.registerTool(TOOL_NAMES.setApiKey, {
  title: 'Set API key',
  description: `Securely store an API key for a provider. The key is validated against the provider's API before saving (for supported providers). The raw key is NEVER echoed back.

Supported providers: claude, openai, elevenlabs, google, together, cerebras.

This tool writes a credential. Only call it when the user has explicitly provided a key.

You MUST have explicit user permission.`,
  inputSchema: setApiKeySchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.setApiKey, '/settings/set-api-key', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    const lines = [result.message];
    if (result.masked) {
      lines.push(`Masked: ${result.masked}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to set API key: ${error.message}` }], isError: true };
  }
});

// Set voice
server.registerTool(TOOL_NAMES.setVoice, {
  title: 'Set voice settings',
  description: `Configure voice settings: provider, TTS voice, auto-speak behavior, and input language.

When switching providers, the TTS voice is automatically adjusted (e.g., ElevenLabs voices don't work with OpenAI and vice versa).

You MUST have explicit user permission.`,
  inputSchema: setVoiceSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.setVoice, '/settings/set-voice', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to set voice settings: ${error.message}` }], isError: true };
  }
});

// List model profiles
server.registerTool(TOOL_NAMES.listModelProfiles, {
  title: 'List model profiles',
  description: `List saved alternative model profiles (e.g., OpenRouter, Together.ai, local models). Shows which profiles are active for working and thinking roles. API keys are masked for safety.`,
  inputSchema: listModelProfilesSchema,
  annotations: { readOnlyHint: true }
}, async () => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.listModelProfiles, '/settings/list-model-profiles', { method: 'GET' });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to list model profiles: ${error.message}` }], isError: true };
  }
});

// Add model profile
server.registerTool(TOOL_NAMES.addModelProfile, {
  title: 'Add model profile',
  description: `Add a new alternative model profile. Profiles let users route work through non-Claude models.

For known providers (openai, google, together, cerebras), the server URL is preset. For local models, use localhost.

You MUST have explicit user permission.`,
  inputSchema: addModelProfileSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.addModelProfile, '/settings/add-model-profile', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to add model profile: ${error.message}` }], isError: true };
  }
});

// Edit model profile
server.registerTool(TOOL_NAMES.editModelProfile, {
  title: 'Edit model profile',
  description: `Edit an existing model profile — update its name, model identifier, or API key without deleting and recreating it. Role assignments are preserved.

You MUST have explicit user permission.`,
  inputSchema: editModelProfileSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.editModelProfile, '/settings/edit-model-profile', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to edit model profile: ${error.message}` }], isError: true };
  }
});

// Remove model profile
server.registerTool(TOOL_NAMES.removeModelProfile, {
  title: 'Remove model profile',
  description: `Remove a saved model profile. If the profile is currently active for a role, that role reverts to Claude.

You MUST have explicit user permission.`,
  inputSchema: removeModelProfileSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.removeModelProfile, '/settings/remove-model-profile', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to remove model profile: ${error.message}` }], isError: true };
  }
});

// Activate model profile
server.registerTool(TOOL_NAMES.activateModelProfile, {
  title: 'Activate model profile',
  description: `Assign a model profile to the working or thinking role, or deactivate it to revert to Claude.

You MUST have explicit user permission.`,
  inputSchema: activateModelProfileSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.activateModelProfile, '/settings/activate-model-profile', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to activate model profile: ${error.message}` }], isError: true };
  }
});

// Set memory safety defaults
server.registerTool(TOOL_NAMES.setMemorySafetyDefaults, {
  title: 'Set memory safety defaults',
  description: `Set the default memory safety level for private and shared spaces.

- permissive: Auto-save without asking (available for private only)
- balanced: Check before saving sensitive content
- cautious: Always ask before saving

Shared spaces cannot be set to permissive.

You MUST have explicit user permission.`,
  inputSchema: setMemorySafetyDefaultsSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.setMemorySafetyDefaults, '/settings/set-memory-safety-defaults', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to set memory safety defaults: ${error.message}` }], isError: true };
  }
});

// Set space safety
server.registerTool(TOOL_NAMES.setSpaceSafety, {
  title: 'Set space safety level',
  description: `Set the memory safety level for a specific space. Chief-of-Staff is always permissive and cannot be changed.

You MUST have explicit user permission.`,
  inputSchema: setSpaceSafetySchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  try {
    const result = await bridgeRequest(TOOL_NAMES.setSpaceSafety, '/settings/set-space-safety', { body: input });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: result.message }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to set space safety: ${error.message}` }], isError: true };
  }
});

// =============================================================================
// Start the server
// =============================================================================
const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    console.error('[RebelSettings] Server started');
  })
  .catch((error) => {
    console.error('[RebelSettings] Failed to start', error);
    process.exit(1);
  });
