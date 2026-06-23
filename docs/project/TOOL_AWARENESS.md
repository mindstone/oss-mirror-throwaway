---
description: "How Rebel provides Claude with awareness of available MCP tools and user preferences"
last_updated: "2026-06-20"
---

# Tool Awareness

## Introduction

This document explains how Mindstone Rebel provides Claude with awareness of available MCP tools and user tool preferences. The tool awareness system consists of two components:

1. **Frequent Tools** — Personalized tool shortcuts based on user's historical usage
2. **Connected Packages** — List of available MCP packages with descriptions

Together, these components allow Claude to skip tool discovery calls (~80% of the time) and call tools directly, improving response speed and reducing token usage.

3. **Semantic Tool Search** — LanceDB-powered tool discovery that finds relevant tools by natural language query

## See also

- `docs/project/SYSTEM_PROMPT.md` — How the composite system prompt is constructed
- `docs/project/PROMPT_CACHING.md` — How prompt caching works; tool awareness affects cache efficiency
- `docs/project/MCP_ARCHITECTURE.md` — MCP and Super-MCP configuration
- `docs/project/SEMANTIC_SEARCH.md` — Semantic search architecture (shared by file search and tool search)
- `src/main/services/toolUsageStore.ts` — Tool usage tracking and frequent tools selection
- `src/main/services/toolIndexService.ts` — Semantic tool search via LanceDB
- `src/main/services/mcpService.ts` — `buildConnectedPackages()`, `buildFrequentToolGroups()`, and system prompt composition
- `src/core/services/promptTemplateService.ts` — `FrequentToolGroup` schema and template rendering
- `src/main/services/connectorCatalogService.ts` — Catalog lookup for package descriptions
- `src/main/services/agentTurnExecutor.ts` — SubagentStart hook for injecting context into subagents

## Overview

### Frequent Tools

Frequent tools provide Claude with **personalized parameter signatures** based on the user's actual tool usage, **grouped by package**. This grouping enables Claude to:

1. **Call tools directly** without discovery (the `package_id` is visible)
2. **Disambiguate multi-account scenarios** (e.g., which Google Workspace account to use)

Example output:

```markdown
**Your Frequent Packages / Tools:**

**GoogleWorkspace-greg-acme-com** ([external-email] - Email, calendar, drive tools):
- `search_workspace_emails`(query, max_results)
- `list_workspace_calendar_events`(time_min, time_max)

**Slack-mindstone** (Mindstone workspace - Team messaging):
- `post_message`(channel, text)

**Linear**:
- `create_issue`(title, description)

*Parameters shown are learned from usage — for full schema, use `get_tool_details(tool_ids=["PackageName__tool_name"])`.*
```

The package description includes **account identity** (email or workspace name) when available, making it clear which specific connector instance the user frequently uses.

### Connected Packages

Connected packages provide Claude with **awareness of what MCP packages are available** and what they do. This eliminates the need to call `list_tool_packages` for discovery:

```markdown
**Connected Tool Packages:**
- **Slack**: Search messages, read channels/threads, post messages, add reactions, list users.
- **GoogleWorkspace**: Email, calendar, docs, sheets, slides, contacts, drive.
- **HubSpot**: Search/create/update contacts, companies, deals, tickets, tasks.
```

## Implementation Details

### Frequent Tools Selection

The `toolUsageStore.ts` service tracks tool usage and selects frequent tools with these criteria:

1. **Usage Count** — Tools sorted by usage count (descending)
2. **Staleness Cutoff** — Tools unused for 60+ days are deprioritized
3. **Deterministic Tie-Breaker** — Equal counts use alphabetical order (not time-based)
4. **Limit** — Top 10 tools included (configurable via `FREQUENT_TOOLS_LIMIT`)

#### Staleness Handling

Tools are separated into "active" (used within 60 days) and "stale" buckets:

```typescript
// Active tools are prioritized
const activeTools = tools.filter(t => t.lastUsedAt > staleThreshold);
const staleTools = tools.filter(t => t.lastUsedAt <= staleThreshold);

// Select from active first, fill remainder from stale
const selected = [...activeTools.slice(0, limit)];
if (selected.length < limit) {
  selected.push(...staleTools.slice(0, limit - selected.length));
}
```

This ensures frequently-used tools appear, while allowing fallback to stale tools if the user hasn't used 10+ tools recently.

### Connected Packages Resolution

The `buildConnectedPackages()` function in `mcpService.ts`:

1. Fetches package metadata from Super-MCP via `list_tool_packages`
2. Maps each package to a display name and description
3. Sorts alphabetically by name for cache stability
4. Returns empty array on error (graceful degradation)

#### Description Sources

Package descriptions come from the **connector catalog** (`resources/connector-catalog.json`), which contains curated descriptions for 60+ connectors. For custom/unknown MCPs, a generic fallback is used.

```typescript
// Catalog has curated descriptions
"Slack": "Search messages, read channels/threads, post messages..."

// Unknown servers get generic fallback
"my-custom-mcp": "(custom MCP server)"
```

### Frequent Tools Grouping

The `buildFrequentToolGroups()` function in `mcpService.ts` transforms flat tool usage data into grouped format:

1. **Extract server ID** from `toolName` (format: `serverId/toolShortName`)
2. **Look up server description** from connected packages (includes email/workspace)
3. **Group tools by server** and sort alphabetically for cache stability

```typescript
// Input: flat list from toolUsageStore
[{ toolName: "GoogleWorkspace-greg-acme-com/gmail_search_emails", shortName: "gmail_search_emails", params: [...] }]

// Output: grouped by server
[{
  serverId: "GoogleWorkspace-greg-acme-com",
  serverDescription: "[external-email] - Email, calendar, drive tools",
  tools: [{ shortName: "gmail_search_emails", params: [...] }]
}]
```

## Subagent Injection

When Claude spawns subagents (via the `SubagentStart` hook), tool awareness context is injected into their prompts as well. This ensures subagents have the same tool knowledge as the main agent.

The hook builds grouped frequent tools and combines with connected packages:

```typescript
SubagentStart: [{
  hooks: [async () => {
    const frequentTools = getFrequentTools();
    const connectedPackages = await buildConnectedPackages();
    const frequentToolGroups = buildFrequentToolGroups(frequentTools, connectedPackages);

    const frequentToolsContext = formatFrequentToolsContext(frequentToolGroups);
    const connectedPackagesContext = formatConnectedPackagesContext(connectedPackages);

    const contextParts = [frequentToolsContext, connectedPackagesContext].filter(Boolean);
    if (contextParts.length === 0) return undefined;

    return {
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: contextParts.join('\n\n'),
      },
    };
  }],
}]
```

## Token Budget Analysis

The tool awareness system is designed to be efficient with context window usage:

| Component | Typical Size | Notes |
|-----------|--------------|-------|
| Frequent tools (10 tools) | ~200 tokens | Personalized shortcuts |
| Connected packages (20 packages) | ~400 tokens | Available integrations |
| **Total** | **~600 tokens** | Enables skipping discovery |

### By User Profile

| Profile | Packages | Frequent Tools | Total |
|---------|----------|----------------|-------|
| Light user | 5-10 (~150) | ~150 | ~300 |
| Typical user | 15-20 (~350) | ~200 | ~550 |
| Power user | 25+ (~500) | ~200 | ~700 |

This overhead is offset by **not needing to call discovery tools**, which would otherwise consume ~500-1000 tokens per discovery call.

## Cache Stability Design

Both frequent tools and connected packages are **sorted alphabetically** before injection. This ensures:

1. **Consistent ordering** — Same input produces same output
2. **Prompt cache efficiency** — Repeated prompts have identical prefixes
3. **Deterministic behavior** — No flapping between API calls

### Why Alphabetical Sorting Matters

Without stable sorting, the prompt content would change randomly between turns:

```markdown
# Turn 1 (cached)
- Asana, GoogleWorkspace, Slack

# Turn 2 (cache miss! different order)
- Slack, GoogleWorkspace, Asana
```

By sorting alphabetically, the prompt stays consistent and cache hits are maximized.

## Configuration

### Constants

| Constant | Value | Location |
|----------|-------|----------|
| `TOOL_STALENESS_DAYS` | 60 | `src/main/constants.ts` |
| `FREQUENT_TOOLS_LIMIT` | 10 | `src/main/constants.ts` |

### Environment Variables

No environment variables control tool awareness directly. The feature is always enabled.

## Troubleshooting

### Frequent tools not showing

1. **Check usage history** — Tools must be used at least once to appear
2. **Check staleness** — If all tools are 60+ days old, they'll still appear (as fallback)
3. **Check Super-MCP** — Tool usage is tracked via Super-MCP tool calls

### Connected packages empty

1. **Check Super-MCP is running** — `superMcpHttpManager.getState().isRunning`
2. **Check package health** — Use `health_check_all` to verify connections
3. **Check logs** — Look for "Built connected packages" in main process logs

### Package descriptions wrong or missing

1. **Check connector catalog** — `resources/connector-catalog.json`
2. **Custom MCPs get generic description** — This is expected behavior
3. **Bundled packages should have descriptions** — Check `bundledMcpManager.ts`


## Semantic Tool Search

In addition to the static "frequent tools" and "connected packages" injected at turn start, Rebel performs **semantic tool search** to find relevant tools based on the user's query.

### How It Works

1. **Index Building**: On app startup and MCP config changes, MCP tools are incrementally indexed into LanceDB with BGE-small embeddings (only changed/added/removed packages are re-embedded; see [incremental refresh planning doc](../../docs/plans/260402_tool_index_incremental_refresh.md))
2. **Query Embedding**: When a turn starts, the user's message is embedded
3. **Hybrid Search**: Uses BM25 keyword matching + vector similarity with RRF (Reciprocal Rank Fusion)
4. **Results Injection**: Top matching tools (up to 10, max 5 per package) are collected into the `contextSections.suggestedTools` slot and assembled via `buildUserMessageContext()` with XML `<suggested-tools>` tags

**Note**: Unlike frequent tools and connected packages (which are in the system prompt), suggested tools are injected into the **user message**. This keeps the system prompt stable for caching while providing query-specific context. All user-message context sections (files, tools, conversations, meeting) use consistent XML tag wrapping via `buildUserMessageContext()` in `agentTurnUtils.ts`.

### Runtime Interception (PreToolUse Hook)

In addition to pre-turn `<suggested-tools>` injection, Rebel intercepts `search_tools` MCP tool calls at runtime via a PreToolUse hook in `agentTurnExecutor.ts`. This routes the query to `toolIndexService.searchTools()` (LanceDB hybrid: FTS + vector + RRF) instead of Super-MCP's BM25, returning results directly without hitting the upstream server. Falls through to Super-MCP BM25 when the tool index isn't ready. See `src/core/services/toolIndex/searchToolInterceptHook.ts`.

**Contract alignment (2026-03-30):** Both the Rebel LanceDB intercept and Super-MCP's BM25 fallback return the same **lite** result shape: `{ tool_id, package_id, name, summary, description, relevance_score }` plus optional security annotations from BM25. Full schemas are intentionally excluded from search results — the agent should call `get_tool_details` to hydrate specific tool schemas before calling `use_tool`. This aligns with the progressive disclosure pattern (discover → hydrate → execute) established in the v2.5.0 API redesign. See `docs/plans/260330_supermcp_search_contract_and_descriptions.md`.

**Bare-name tool-call correction (REBEL-61S):** If the model calls a connected-package tool by its bare name at the top level (instead of via the `use_tool` meta-tool), Super-MCP returns `-32602 Unknown tool: <name>`. Rebel detects this (`isUnknownToolError()` in `src/core/rebelCore/mcpClient.ts`) and replaces the error with a corrective `isError` tool result (`buildUnknownToolCorrection()`) that guides the model back onto the discovery flow — `get_tool_details` first (consistent with the get-details-before-`use_tool` rule), then re-issue as `use_tool` — rather than surfacing a dead-end "Unknown tool" error.

### Architecture

The tool index uses the same LanceDB infrastructure as file semantic search:

- **Storage**: `~/Library/Application Support/mindstone-rebel/indices/tools/`
- **Embedding Model**: `Xenova/bge-small-en-v1.5` (384 dimensions)
- **Refresh Triggers**: App startup, MCP config changes, manual refresh
- **Refresh Mode**: Per-package incremental (SHA-256 change detection). Only added/modified packages are re-embedded; unchanged packages are skipped. Full rebuilds only occur on first build or when upgrading from the pre-incremental index format. See [planning doc](../plans/260402_tool_index_incremental_refresh.md) for design rationale.
- **Concurrency**: `refreshSerializer` serializes concurrent refresh requests (queue-chain pattern). A separate `mutationBarrier` provides a brief reader block during the add/delete phase only — readers (`searchTools`, `getToolSchema`) wait on this sub-second barrier instead of the full refresh duration.

### Indexed Content Per Tool

Each tool record contains:

| Field | Source | Used For |
|-------|--------|----------|
| `name` | Tool name | BM25 + vector |
| `summary` | Tool summary (description fallback) | Vector embedding |
| `description` | Tool description | BM25 + vector |
| `inputSchema` | JSON stringified | Display only |
| `serverId` | MCP server ID | Grouping + incremental refresh |

### Suggested Tools Format

When relevant tools are found, they are assembled into the user message with XML tags:

```xml
<suggested-tools>
Potentially relevant tools for this request (not an exclusive list). Use if helpful; call get_tool_details for schemas before first use.
- `Slack-mindstone-team/post_message` (mindstone-team workspace) - Send a message to a channel or DM
- `GoogleWorkspace-teammember-mindstone-com/send_email` ([Mindstone-email]) - Send an email
</suggested-tools>

<user-request>
[user's actual message]
</user-request>
```

The format includes:
- **Tool ID**: Full package/tool identifier (e.g., `Slack-mindstone-team/post_message`)
- **Account hint**: Email or workspace name in parentheses for multi-account disambiguation
- **Short description**: Truncated to ~100 chars to minimize token overhead

The account hints help Claude choose the right connector instance when users have multiple accounts (e.g., work + personal Gmail). Claude can discover full parameter schemas via the MCP discovery tools if needed.

**Important: Runtime vs. skill authoring.** The account-slugged tool IDs above (e.g., `Slack-mindstone-team/post_message`, `GoogleWorkspace-teammember-mindstone-com/send_email`) are generated at runtime and are correct for tool routing. However, **skills must never hardcode these account-specific identifiers**. In skill text and `tools_required` frontmatter, use short tool names (`post_message`, `send_email`) or service names (`[Slack]`, `[GoogleWorkspace]`). Rebel resolves the correct package at runtime. See the PII/identity rules in `write-skill/SKILL.md` and `mcp-add-update-remove-connector/SKILL.md`.

### Per-Server Tool Breakdown

The tool index maintains a `toolCountByServer` Map in `toolIndexService.ts`, tracking how many tools each server contributes. Exposed via `getToolIndexStatus().byServer` as `Record<string, number> | undefined` (undefined when the index is not yet initialized).

- **Keys are safe base server names** (e.g., "Slack", "GoogleWorkspace") via `getSafeServerName()` — never raw instance IDs (which can contain email slugs)
- Populated during both initial index load and refresh cycles
- Included in the `toolIndexHealth` check `details.byServer` field, making it available in Sentry context (via the per-check allowlist in `systemHealthService.ts`)
- Helps diagnose missing-tool issues by showing whether a server contributed zero tools vs. not being indexed at all

See [DIAGNOSTICS.md § Safe Health Check Detail Extraction](./DIAGNOSTICS.md#safe-health-check-detail-extraction) for how this feeds into bug report diagnostics.

### Health Check

System Health includes a tool index check:

| Status | Meaning |
|--------|---------|
| `healthy` | Index initialized, tools indexed |
| `degraded` | Index empty or very few tools |
| `unhealthy` | Index failed to initialize |

### Implementation References

| File | Purpose |
|------|---------|
| `src/main/services/toolIndexService.ts` | Index management, search, and incremental refresh (per-package change detection, mutation barrier) |
| `src/main/services/agentTurnExecutor.ts` | Prepends suggested tools to user message; registers PreToolUse hook for `search_tools` interception |
| `src/core/services/toolIndex/searchToolInterceptHook.ts` | PreToolUse hook that intercepts `search_tools` and routes to LanceDB hybrid search |
| `src/main/services/health/checks/toolIndex.ts` | Health check implementation |
| `src/main/constants.ts` | `TOOL_SEARCH_LIMIT`, `TOOL_SEARCH_PER_PACKAGE_LIMIT` |
| `docs/plans/260402_tool_index_incremental_refresh.md` | Design rationale for incremental refresh, lock splitting, per-package hashing |

### Comparison: Three Tool Awareness Mechanisms

| Mechanism | When Used | Token Cost | Purpose |
|-----------|-----------|------------|---------|
| **Connected Packages** | Every turn | ~400 | Know what's available |
| **Frequent Tools** | Every turn | ~200 | Personalized shortcuts |
| **Semantic Tool Search** | Per query | ~300-500 | Find relevant tools dynamically |

All three work together: connected packages tell Claude what's installed, frequent tools provide personalized shortcuts, and semantic search suggests specific tools based on the current query.
