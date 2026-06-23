#!/usr/bin/env node
/**
 * RebelSearchAndConversations MCP Server
 *
 * Search files, sources, and entities (people/companies), browse and search past conversations.
 * Semantic file search, meeting/email/slack source search, entity search/resolve,
 * list/search/get conversation history.
 *
 * Tools (10):
 * - rebel_search_files
 * - rebel_search_sources
 * - rebel_entities_search
 * - rebel_entities_resolve
 * - rebel_conversations_list
 * - rebel_conversations_search
 * - rebel_conversations_get_summary
 * - rebel_conversations_export_full
 * - rebel_conversations_send_message
 * - rebel_conversations_start
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
  console.error('[RebelSearchAndConversations] Missing bridge configuration file.');
  process.exit(1);
}

const bridgePort = bridgeState.port;
const bridgeToken = bridgeState.token;
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;

// Create the server instance
const server = new McpServer({
  name: 'RebelSearchAndConversations',
  version: '1.0.0',
  description: `Search files, sources, and entities (people/companies), browse and search past conversations. Semantic file search, meeting/email/slack source search, entity search/resolve, list/search/summarize/export/send/start conversation history.`
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
  files: 'rebel_search_files',
  sources: 'rebel_search_sources',
  entitiesSearch: 'rebel_entities_search',
  entitiesResolve: 'rebel_entities_resolve',
  conversationList: 'rebel_conversations_list',
  conversationSearch: 'rebel_conversations_search',
  conversationGetSummary: 'rebel_conversations_get_summary',
  conversationExportFull: 'rebel_conversations_export_full',
  conversationSendMessage: 'rebel_conversations_send_message',
  conversationStart: 'rebel_conversations_start'
};

// =============================================================================
// Schemas
// =============================================================================
const semanticSearchSchema = z.object({
  query: z.string().min(1).describe("Search query - natural language describing what you're looking for"),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum results (default: 5, max: 20)'),
  threshold: z.number().min(0).max(1).optional().describe('Minimum relevance score 0-1 (default: 0.25)'),
  fileTypes: z.array(z.string()).optional().describe('Filter by extensions, e.g., [".ts", ".py"]'),
  pathPrefix: z.string().optional().describe('Filter by directory path relative to workspace root, e.g., "Chief-of-Staff" or "memory/topics"')
});

const searchSourcesSchema = z.object({
  query: z.string().optional().describe("Natural language search query (optional - if omitted, returns all matching filters)"),
  sourceTypes: z.array(z.string()).optional().describe('Filter by source type: ["meeting", "email", "slack_thread"]'),
  participants: z.array(z.string()).optional().describe('Filter by participant names (case-insensitive substring match)'),
  dateRange: z.object({
    after: z.string().optional().describe('ISO date string (YYYY-MM-DD) - sources on or after this date'),
    before: z.string().optional().describe('ISO date string (YYYY-MM-DD) - sources on or before this date'),
    relative: z.string().optional().describe('Relative time period: "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days". Takes precedence over after/before if specified.')
  }).optional().describe('Filter by date range'),
  limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default: 20, max: 50)')
});

const entitiesSearchSchema = z.object({
  query: z.string().optional().describe("Fuzzy name search (e.g., 'Sarah', 'Acme Corp')"),
  email: z.string().optional().describe("Filter by email address (substring match)"),
  company: z.string().optional().describe("Filter by company name (e.g., 'Acme' matches people at Acme Corp)"),
  entityType: z.enum(['person', 'company']).optional().describe("Filter by entity type: 'person' or 'company'"),
  noInteractionSince: z.string().optional().describe("ISO date string (e.g., '2026-02-01') — filter to people whose last meeting interaction is before this date. Only applies to person entities. Note: limited to ~30 days of meeting history."),
  limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default: 20, max: 50)')
});

const entitiesResolveSchema = z.object({
  email: z.string().optional().describe("Exact email lookup (e.g., '[external-email]')"),
  name: z.string().optional().describe("Fuzzy name lookup (e.g., 'Sarah Chen')")
});

const conversationListSchema = z.object({
  limit: z.number().int().min(1).max(50).optional()
    .describe('Maximum conversations to return (default: 5, max: 50)'),
  excludeCurrentSession: z.string().optional()
    .describe('Session ID to exclude from results (e.g., current conversation)')
});

const conversationSearchSchema = z.object({
  query: z.string().min(1).describe('Natural language search query (e.g., "discussion about project deadlines")'),
  limit: z.number().min(1).max(20).optional().describe('Maximum results to return (1-20, default: 10)')
});

const conversationIdentifierSchema = z.object({
  sessionId: z.string().optional().describe('Conversation session ID (UUID)'),
  url: z.string().optional().describe('rebel://conversation/{id} URL')
});

const conversationGetSummarySchema = conversationIdentifierSchema;

const conversationExportFullSchema = conversationIdentifierSchema;

const conversationStartSchema = z.object({
  text: z.string().min(1).describe('The message text for the new conversation'),
  sendMessage: z.boolean().optional().describe('Whether to send the message immediately (default: true). If false, text is saved as a draft.'),
  switchToConversation: z.boolean().optional().describe('Whether to switch the UI to the new conversation (default: false). When false, the conversation runs in the background.')
});

const conversationSendMessageSchema = z.object({
  sessionId: z.string().optional().describe('Session ID of the existing conversation'),
  url: z.string().optional().describe('rebel://conversation/{id} URL'),
  text: z.string().min(1).describe('The message text to send'),
  sendMessage: z.boolean().optional().describe('Whether to send immediately (default: true). If false, saved as draft.'),
  switchToConversation: z.boolean().optional().describe('Whether to navigate the UI to the conversation (default: false).')
});

// =============================================================================
// Tool Registrations
// =============================================================================

// Semantic file search
server.registerTool(TOOL_NAMES.files, {
  title: 'Search workspace files',
  description: `Search workspace files by meaning, not just keywords.

PREFER this tool when:
- Looking for files about a topic (e.g., "meeting notes", "authentication code", "project plans")
- User mentions their files, documents, notes, or workspace
- You need relevant context before answering a question about user's work
- Filesystem search (find/grep) would require knowing exact filenames

This finds files even when exact words don't match - much better than 'find' for conceptual searches like "files about onboarding" or "notes from last week".

Returns: File paths, relevant snippets, and relevance scores (0-100%).`,
  inputSchema: semanticSearchSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.files, '/file-search', {
    body: {
      query: input.query,
      limit: input.limit,
      threshold: input.threshold,
      fileTypes: input.fileTypes,
      pathPrefix: input.pathPrefix
    }
  });

  if (!result.success) {
    return {
      content: [{ type: 'text', text: `Search failed: ${result.error}` }]
    };
  }

  if (result.message) {
    return {
      content: [{ type: 'text', text: result.message }]
    };
  }

  const results = result.results || [];
  if (results.length === 0) {
    return {
      content: [{ type: 'text', text: `No relevant files found for: "${input.query}"` }]
    };
  }

  const formatted = results
    .map((r, i) => {
      const score = Math.round((r.score || 0) * 100);
      const snippet = r.snippet || '';
      const truncatedSnippet = snippet.length > 500 ? snippet.slice(0, 500) + '...' : snippet;
      return `### ${i + 1}. ${r.relativePath} (${score}% relevant)\n\`\`\`\n${truncatedSnippet}\n\`\`\``;
    })
    .join('\n\n');

  return {
    content: [{ type: 'text', text: `Found ${results.length} relevant file(s):\n\n${formatted}` }]
  };
});

// Search sources (meetings, emails, slack threads)
server.registerTool(TOOL_NAMES.sources, {
  title: 'Search meetings and sources',
  description: `Search meeting transcripts, emails, slack threads, and other captured sources.

THIS IS THE MEETING SEARCH TOOL - use it to find past meetings, calls, and conversations.

ALWAYS use this tool when the user mentions:
- Meetings, calls, discussions, conversations ("what did we discuss with X?", "my meeting with Y")
- Meeting transcripts, recordings, or notes
- Emails or messages ("any emails about Y?")
- What someone said or what was talked about
- Finding information from past conversations with specific people

Supports powerful filtering:
- By participant: "alice" matches "Alice Chen" and "[external-email]"
- By date: "meetings this week", after/before specific dates
- By type: meetings, emails, slack_threads
- By content: natural language semantic search

Examples of when to use:
- "What did I discuss with Sarah last week?" -> participants=["Sarah"], dateRange={after: last week}
- "Find my meeting with the design team" -> query="design team", sourceTypes=["meeting"]
- "Any emails about the budget?" -> query="budget", sourceTypes=["email"]

Returns: Source titles, types, dates, participants, summaries, and file paths.`,
  inputSchema: searchSourcesSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.sources, '/sources/search', {
    body: {
      query: input.query,
      sourceTypes: input.sourceTypes,
      participants: input.participants,
      dateRange: input.dateRange,
      limit: input.limit
    }
  });

  // Honest unavailable state: the bridge returns success:false ONLY when the
  // semantic backend was needed, failed, and yielded no text/metadata results.
  // Must be the FIRST check — the genuine no-match path below returns
  // success:true, so this only intercepts the intended unavailable envelopes.
  if (!result.success) {
    return {
      content: [{ type: 'text', text: `Search failed: ${result.error}` }]
    };
  }

  if (result.message) {
    return {
      content: [{ type: 'text', text: result.message }]
    };
  }

  const sources = result.sources || [];
  if (sources.length === 0) {
    const filterDesc = [];
    if (input.sourceTypes?.length) filterDesc.push(`type=${input.sourceTypes.join(',')}`);
    if (input.participants?.length) filterDesc.push(`participants=${input.participants.join(',')}`);
    if (input.dateRange?.after || input.dateRange?.before) {
      filterDesc.push(`date=${input.dateRange.after || '*'} to ${input.dateRange.before || '*'}`);
    }
    const query = input.query ? `"${input.query}"` : 'no query';
    const filters = filterDesc.length > 0 ? ` (filters: ${filterDesc.join(', ')})` : '';
    return {
      content: [{ type: 'text', text: `No sources found for ${query}${filters}` }]
    };
  }

  // Format as Markdown for better agent consumption
  const formatted = sources.map((s) => {
    const relevance = s.relevanceScore ? ` (${Math.round(s.relevanceScore * 100)}% relevant)` : '';
    const participants = s.participants?.length > 0 ? s.participants.join(', ') : 'unknown';
    const lines = [
      `## ${s.title || 'Untitled'}${relevance}`,
      `- **Type**: ${s.sourceType || 'unknown'}`,
      `- **Date**: ${s.occurredAt || 'unknown'}`,
      `- **Participants**: ${participants}`,
      `- **Path**: ${s.relativePath || s.filePath}`
    ];
    if (s.summary) {
      lines.push('', s.summary);
    }
    return lines.join('\n');
  }).join('\n\n---\n\n');

  return {
    content: [{ type: 'text', text: `Found ${sources.length} source(s):\n\n${formatted}` }]
  };
});

// Search entities (people, companies)
server.registerTool(TOOL_NAMES.entitiesSearch, {
  title: 'Search people and companies',
  description: `Search the user's known people and companies from their workspace memory.

Use this tool when:
- User asks about a person or company ("who do I know at Acme?", "tell me about Sarah")
- Looking up contacts, colleagues, or business relationships
- Finding people by name, email, or company affiliation
- Listing all known people or companies
- Temporal queries: "who haven't I talked to recently?", "people I haven't met with in 30 days"

Supports filtering by:
- Name (fuzzy match): "Sarah" matches "Sarah Chen", "S. Chen"
- Email (substring match): "acme.com" matches all @acme.com addresses
- Company: "Acme" matches people at Acme Corp
- Entity type: "person" or "company"
- Last interaction: noInteractionSince filters to people not met with since a date (based on ~30 days of meeting history)

Examples:
- All people at Acme: entityType="person", company="Acme"
- Who do I know named Sarah: query="Sarah", entityType="person"
- All known companies: entityType="company"
- People with gmail addresses: email="gmail.com"
- People not talked to in 30 days: entityType="person", noInteractionSince="2026-02-06"

Returns: Entity names, emails, companies, roles, aliases, and file paths.`,
  inputSchema: entitiesSearchSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.entitiesSearch, '/entities/search', {
    body: {
      query: input.query,
      email: input.email,
      company: input.company,
      entityType: input.entityType,
      noInteractionSince: input.noInteractionSince,
      limit: input.limit
    }
  });

  const entities = result.entities || [];
  if (entities.length === 0) {
    const filterDesc = [];
    if (input.query) filterDesc.push(`name="${input.query}"`);
    if (input.email) filterDesc.push(`email="${input.email}"`);
    if (input.company) filterDesc.push(`company="${input.company}"`);
    if (input.entityType) filterDesc.push(`type=${input.entityType}`);
    const filters = filterDesc.length > 0 ? ` (filters: ${filterDesc.join(', ')})` : '';
    return {
      content: [{ type: 'text', text: `No entities found${filters}. The user may not have any entity files indexed yet — entities are created when the memory update skill adds structured frontmatter to topic files about people and companies.` }]
    };
  }

  const formatted = entities.map((e) => {
    const lines = [
      `## ${e.canonicalName} (${e.entityType})`,
    ];
    if (e.emails?.length > 0) lines.push(`- **Emails**: ${e.emails.join(', ')}`);
    if (e.company) lines.push(`- **Company**: ${e.company}`);
    if (e.role) lines.push(`- **Role**: ${e.role}`);
    if (e.aliases?.length > 0) lines.push(`- **Aliases**: ${e.aliases.join(', ')}`);
    lines.push(`- **Space**: ${e.spacePath || '(root)'}`);
    lines.push(`- **File**: ${e.relativePath}`);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  const total = result.totalCount || entities.length;
  const showing = entities.length < total ? ` (showing ${entities.length} of ${total})` : '';

  return {
    content: [{ type: 'text', text: `Found ${total} entity/entities${showing}:\n\n${formatted}` }]
  };
});

// Resolve entity by email or name
server.registerTool(TOOL_NAMES.entitiesResolve, {
  title: 'Resolve a specific entity',
  description: `Resolve a specific person or company by exact email or name.

Use this tool when:
- You have an exact email and need to find the associated person ("who is [external-email]?")
- Matching a meeting participant to a known entity
- Looking up a specific person by full name

Email lookup is exact match (preferred — most reliable).
Name lookup uses fuzzy matching against canonical names and aliases.

Provide either email or name (email takes priority if both given).

Examples:
- Find entity for [external-email]: email="[external-email]"
- Look up Sarah Chen: name="Sarah Chen"

Returns: The matched entity with all metadata, or null if not found.`,
  inputSchema: entitiesResolveSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  if (!input.email && !input.name) {
    return {
      content: [{ type: 'text', text: 'Either email or name is required.' }]
    };
  }

  const result = await bridgeRequest(TOOL_NAMES.entitiesResolve, '/entities/resolve', {
    body: {
      email: input.email,
      name: input.name
    }
  });

  if (!result.found || !result.entity) {
    const lookupDesc = input.email ? `email "${input.email}"` : `name "${input.name}"`;
    return {
      content: [{ type: 'text', text: `No entity found for ${lookupDesc}. The person/company may not have a topic file with entity frontmatter yet.` }]
    };
  }

  const e = result.entity;
  const lines = [
    `# ${e.canonicalName} (${e.entityType})`,
  ];
  if (e.emails?.length > 0) lines.push(`- **Emails**: ${e.emails.join(', ')}`);
  if (e.company) lines.push(`- **Company**: ${e.company}`);
  if (e.role) lines.push(`- **Role**: ${e.role}`);
  if (e.aliases?.length > 0) lines.push(`- **Aliases**: ${e.aliases.join(', ')}`);
  lines.push(`- **Space**: ${e.spacePath || '(root)'}`);
  lines.push(`- **File**: ${e.relativePath}`);

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// List recent conversations
server.registerTool(TOOL_NAMES.conversationList, {
  title: 'List recent conversations',
  description: `List recent conversations with metadata. Returns titles, timestamps, message counts, and URLs for browsing conversation history.

Use this to see what conversations exist before searching or reading them.
Use rebel_conversations_search for semantic search across conversation content.
Use rebel_conversations_get_summary for an AI summary, or rebel_conversations_export_full for the full transcript.

Note: Privacy mode conversations are always excluded. Returns empty in Demo Mode.`,
  inputSchema: conversationListSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.conversationList, '/conversations/list', {
    body: {
      limit: input.limit ?? 5,
      excludeCurrentSession: input.excludeCurrentSession
    }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to list conversations: ${result.error}`
      }]
    };
  }

  const sessions = result.sessions || [];
  if (sessions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No recent conversations found.'
      }]
    };
  }

  const formatted = sessions.map((s, i) => {
    const created = new Date(s.createdAt).toLocaleDateString();
    const updated = new Date(s.updatedAt).toLocaleDateString();
    const title = s.title || '(Untitled)';
    const msgs = s.messageCount ? `${s.messageCount} messages` : '0 messages';
    return `${i + 1}. "${title}"\n   ${msgs} | Created: ${created} | Updated: ${updated}\n   URL: ${s.url}`;
  }).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `Recent conversations (${sessions.length}):\n\n${formatted}`
    }]
  };
});

// Search conversations
server.registerTool(TOOL_NAMES.conversationSearch, {
  title: 'Search conversations',
  description: `Search past conversations using semantic/natural language search.

Returns conversation summaries with rebel:// URLs you can share with the user.
Use rebel_conversations_get_summary for an AI summary, or rebel_conversations_export_full for the full transcript.

Note: Returns empty results when Demo Mode is active (data isolation).`,
  inputSchema: conversationSearchSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.conversationSearch, '/conversations/search', {
    body: { query: input.query, limit: input.limit }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Search failed: ${result.error}`
      }]
    };
  }

  const results = result.results || [];
  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No conversations found matching "${input.query}".`
      }]
    };
  }

  const summary = results.map((r, i) => {
    const date = new Date(r.createdAt).toLocaleDateString();
    const msgs = r.messageCount ? ` (${r.messageCount} messages)` : '';
    return `${i + 1}. "${r.title}"${msgs}\n   Score: ${r.score.toFixed(2)} | Date: ${date}\n   URL: ${r.url}`;
  }).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `Found ${results.length} conversation(s):\n\n${summary}`
    }]
  };
});

// Get conversation summary
server.registerTool(TOOL_NAMES.conversationGetSummary, {
  title: 'Get conversation summary',
  description: `Generate an AI summary of a specific conversation by session ID or rebel:// URL.

Provide either sessionId or url (from search results).
Use this when you need a structured overview of prior work without pulling the full transcript.

Note: Respects Demo Mode data isolation.`,
  inputSchema: conversationGetSummarySchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  if (!input.sessionId && !input.url) {
    return {
      content: [{
        type: 'text',
        text: 'Either sessionId or url is required.'
      }]
    };
  }

  const result = await bridgeRequest(TOOL_NAMES.conversationGetSummary, '/conversations/get-summary', {
    body: { sessionId: input.sessionId, url: input.url }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to generate summary: ${result.error}`
      }]
    };
  }

  if (!result.summary) {
    const title = result.title || 'Untitled';
    return {
      content: [{
        type: 'text',
        text: `No summary available for "${title}". This can happen if no API key is configured or the summary request failed.`
      }]
    };
  }

  const summary = result.summary;
  const lines = [
    '# Conversation Summary',
    `**Title:** ${result.title || 'Untitled'}`,
    `**URL:** ${result.url || input.url || 'rebel://conversation/unknown'}`,
    '',
    '## Overview',
    summary.overview || 'No overview available.',
  ];

  if (summary.userIntent) {
    lines.push('', '## User Intent', summary.userIntent);
  }
  if (summary.currentStatus) {
    lines.push('', '## Current Status', summary.currentStatus);
  }

  lines.push(
    '', '## Key Decisions',
    summary.keyDecisions?.length ? summary.keyDecisions.map((item) => `- ${item}`).join('\n') : '- None noted',
  );

  if (summary.openQuestions?.length) {
    lines.push('', '## Open Questions', summary.openQuestions.map((item) => `- ${item}`).join('\n'));
  }

  lines.push(
    '', '## Gotchas & Insights',
    summary.gotchasAndInsights?.length ? summary.gotchasAndInsights.map((item) => `- ${item}`).join('\n') : '- None noted',
    '', '## Resources Mentioned',
    summary.resourcesMentioned?.length ? summary.resourcesMentioned.map((item) => `- ${item}`).join('\n') : '- None noted',
  );

  return {
    content: [{
      type: 'text',
      text: lines.join('\n')
    }]
  };
});

// Export full conversation to temp file
server.registerTool(TOOL_NAMES.conversationExportFull, {
  title: 'Export full conversation to file',
  description: `Export the full conversation transcript to a temporary markdown file.

Provide either sessionId or url (from search results).
Returns the file path — use this when you need the complete message history. Read the file to access the full content.
For a structured overview without the full transcript, use rebel_conversations_get_summary instead.

Note: Respects Demo Mode data isolation.`,
  inputSchema: conversationExportFullSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  if (!input.sessionId && !input.url) {
    return {
      content: [{
        type: 'text',
        text: 'Either sessionId or url is required.'
      }]
    };
  }

  const result = await bridgeRequest(TOOL_NAMES.conversationExportFull, '/conversations/export-full', {
    body: { sessionId: input.sessionId, url: input.url }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to export conversation: ${result.error}`
      }]
    };
  }

  const lines = [
    `Conversation exported to: ${result.filePath}`,
    `Title: ${result.title || 'Untitled'}`,
    `Messages: ${result.messageCount}`,
    `URL: ${result.url}`,
    '',
    'Read the file to access the full conversation transcript.'
  ];

  return {
    content: [{
      type: 'text',
      text: lines.join('\n')
    }]
  };
});

// Send message to an existing conversation
server.registerTool(TOOL_NAMES.conversationSendMessage, {
  title: 'Send message to existing conversation',
  description: `Send a message to an existing Rebel conversation by session ID or URL.

ONLY use this when you have a specific existing session ID to send to.
Otherwise, use rebel_conversations_start to create a new conversation.

A 200 response means the message was accepted for delivery to the renderer,
not that it was fully processed. If the agent is busy, the message will be queued.

Provide either sessionId or url (rebel://conversation/{id}).
Returns 404 if the session doesn't exist, is deleted, or is private.`,
  inputSchema: conversationSendMessageSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  let sessionId = input.sessionId;
  if (!sessionId && input.url) {
    const match = input.url.match(/rebel:\/\/conversation\/([a-zA-Z0-9_-]+)/i);
    if (match) {
      sessionId = match[1];
    }
  }

  if (!sessionId) {
    return {
      content: [{ type: 'text', text: 'Either sessionId or url is required.' }]
    };
  }

  const result = await bridgeRequest(
    TOOL_NAMES.conversationSendMessage,
    `/conversations/${sessionId}/send`,
    {
      body: {
        text: input.text,
        sendMessage: input.sendMessage,
        switchToConversation: input.switchToConversation
      }
    }
  );

  if (!result.success) {
    return {
      content: [{ type: 'text', text: `Failed to send message: ${result.error}` }]
    };
  }

  const action = input.sendMessage === false ? 'Draft saved' : 'Message sent';
  const view = input.switchToConversation ? ' (navigated to conversation)' : '';

  return {
    content: [{
      type: 'text',
      text: `Message delivered to existing conversation. ${action}${view}.\n\nSession ID: ${result.sessionId}\nURL: ${result.url}`
    }]
  };
});

// Start a new conversation
server.registerTool(TOOL_NAMES.conversationStart, {
  title: 'Start a new conversation',
  description: `Start a new Rebel conversation with specified text.

By default, the message is sent immediately and the conversation runs in the background.
The user will see it in their conversation history when ready.

Use sendMessage: false to save as a draft instead.
Use switchToConversation: true to navigate the user to the new conversation.

Returns the new conversation's session ID and rebel:// URL.`,
  inputSchema: conversationStartSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.conversationStart, '/conversations/start', {
    body: {
      text: input.text,
      sendMessage: input.sendMessage,
      switchToConversation: input.switchToConversation
    }
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to start conversation: ${result.error}`
      }]
    };
  }

  const action = input.sendMessage === false ? 'Draft saved' : 'Message sent';
  const view = input.switchToConversation ? ' (navigated to conversation)' : ' (running in background)';

  return {
    content: [{
      type: 'text',
      text: `Conversation started. ${action}${view}.\n\nSession ID: ${result.sessionId}\nURL: ${result.url}`
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
    console.error('[RebelSearchAndConversations] Server started');
  })
  .catch((error) => {
    console.error('[RebelSearchAndConversations] Failed to start', error);
    process.exit(1);
  });
