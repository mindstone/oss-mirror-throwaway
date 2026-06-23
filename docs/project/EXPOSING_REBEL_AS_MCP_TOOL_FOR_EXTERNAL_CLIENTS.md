---
description: "Guide to exposing Rebel as an MCP server for external clients — setup, client config, tool reference, safety mode, and troubleshooting"
last_updated: "2026-02-09"
---

# Rebel as MCP Server

Rebel can be exposed as an MCP (Model Context Protocol) server, allowing external AI-powered tools like Cursor, Claude Desktop, and VS Code to invoke Rebel's agent capabilities.

## Introduction

This feature lets you leverage Rebel's unique strengths from any MCP-compatible tool:

- **Memories and learned context**: User preferences, project knowledge, accumulated insights
- **Connected MCPs**: All tools configured via Super-MCP (Linear, Slack, Fathom, Google, etc.)
- **Skills and workflows**: Rebel's prompted capabilities and domain expertise
- **Progressive tool disclosure**: Super-MCP's intelligent tool discovery

**Value proposition**: Configure your MCPs once in Rebel (with OAuth, API keys, skills), then access them from anywhere via `rebel_run_turn` (interactive turns) and `rebel_conversations_start` (background conversations).

## See also

- [HEADLESS_CLI_ENTRYPOINT_REFERENCE.md](./HEADLESS_CLI_ENTRYPOINT_REFERENCE.md) — CLI commands including `mcp-server`
- [TOOL_SAFETY.md](./TOOL_SAFETY.md) — Tool safety system (auto-approved in MCP server mode)
- [MEMORY_SAFETY.md](./MEMORY_SAFETY.md) — Memory write safety (auto-approved in MCP server mode)
- [MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md) — Configuring MCP servers that Rebel connects to
- [SUPERMCP_OVERVIEW.md](./SUPERMCP_OVERVIEW.md) — Super-MCP architecture
- `src/main/mcpServer/index.ts` — MCP server implementation


## Setup

### Step 1: Enable in Rebel Settings

1. Open Rebel
2. Go to **Settings → Connectors**
3. Enable **"Allow external MCP access"** (toggle)
4. A JSON configuration block will appear — copy it

> **Note**: This is a beta feature. The toggle shows a warning badge to indicate it may have rough edges.

### Step 2: Configure Your MCP Client

Paste the copied JSON into your MCP client's configuration file. The JSON looks like this:

```json
{
  "mcpServers": {
    "rebel": {
      "command": "/Applications/Rebel.app/Contents/MacOS/Rebel",
      "args": ["--headless-cli", "mcp-server"]
    }
  }
}
```

> **Platform note**: The `command` path varies by platform:
> - **macOS**: `/Applications/Rebel.app/Contents/MacOS/Rebel`
> - **Windows**: `C:\Users\<username>\AppData\Local\Rebel\Rebel.exe`
> - **Linux**: Depends on installation method

### Client-Specific Configuration

**Claude Desktop** (macOS):

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rebel": {
      "command": "/Applications/Rebel.app/Contents/MacOS/Rebel",
      "args": ["--headless-cli", "mcp-server"]
    }
  }
}
```

**Claude Desktop** (Windows):

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rebel": {
      "command": "C:\\Users\\<username>\\AppData\\Local\\Rebel\\Rebel.exe",
      "args": ["--headless-cli", "mcp-server"]
    }
  }
}
```

**Cursor**:

Edit `~/.cursor/mcp.json` (macOS/Linux) or `%USERPROFILE%\.cursor\mcp.json` (Windows):

```json
{
  "mcpServers": {
    "rebel": {
      "command": "/Applications/Rebel.app/Contents/MacOS/Rebel",
      "args": ["--headless-cli", "mcp-server"]
    }
  }
}
```

**VS Code** (with MCP extension):

Refer to your MCP extension's documentation for configuration location. The JSON structure is the same.

### Step 3: Restart Your MCP Client

After saving the configuration, restart Claude Desktop, Cursor, or your VS Code MCP extension to pick up the new server.


## Tool Reference

### `rebel_run_turn`

The single tool exposed by Rebel's MCP server. Runs a full agent turn with all of Rebel's context.

**Input Schema**:

```json
{
  "type": "object",
  "properties": {
    "prompt": {
      "type": "string",
      "description": "The user prompt to send to Rebel"
    },
    "sessionId": {
      "type": "string",
      "description": "Optional session ID for multi-turn context within this MCP connection"
    }
  },
  "required": ["prompt"]
}
```

**Response Format**:

```json
{
  "text": "The final assistant response text",
  "turnId": "mcp-<uuid>",
  "conversationId": "mcp-session-<timestamp>",
  "usage": {
    "inputTokens": 1500,
    "outputTokens": 800,
    "cacheCreationTokens": 0,
    "cacheReadTokens": 500,
    "costUsd": 0.0234
  }
}
```

**Fields**:

- `text`: The final response from Rebel's agent turn
- `turnId`: Unique identifier for this turn
- `conversationId`: Session identifier (use `sessionId` input for multi-turn context)
- `usage`: Token usage and cost statistics

**Example prompts**:

```
"What's on my calendar today?"
"Create a Linear issue for the auth bug we discussed"
"Summarize my recent Slack messages from #engineering"
"What do you know about the Project Atlas initiative?"
```


## Security Considerations

### Opt-in Requirement

The MCP server feature is **off by default**. You must explicitly enable it in Settings. This prevents unintended access to Rebel's capabilities.

### Auto-Approved Safety

When running as an MCP server:

- **Tool safety prompts are auto-approved**: There's no GUI to show approval dialogs
- **Memory write safety prompts are auto-approved**: Same reasoning

This is safe because:
1. **Explicit opt-in**: User consciously enabled the feature
2. **Local only**: Uses stdio transport (no network exposure)
3. **Process isolation**: MCP client spawns Rebel as a subprocess
4. **Audit logging**: All tool calls and memory writes are logged

### Transport Security

Rebel's MCP server uses **stdio transport** exclusively:
- No HTTP server is exposed
- No network ports are opened
- The MCP client spawns Rebel as a local subprocess
- Communication happens through stdin/stdout

This avoids DNS rebinding and localhost security vulnerabilities that affect HTTP-based MCP servers.


## Known Limitations

### Performance

- **Turn duration**: Complex requests may take 30–120 seconds. This is normal for agent turns that involve multiple tool calls.
- **Cold start**: First request after spawning takes longer due to initialization.

### Concurrency

- **Single turn at a time**: Only one `rebel_run_turn` can execute at a time per MCP connection. Concurrent calls return an error.
- **Sequential calls share context**: Within the same MCP connection, sequential calls can share conversation context via `sessionId`.

### Session Persistence

- **In-memory only**: Session context is held in memory during the MCP server's lifetime.
- **Not persistent**: If the MCP server is restarted (e.g., MCP client restarts), session context is lost.

### Development Mode

- **Requires packaged build**: The MCP server command does not work in development mode (`npm run dev`). You must build and package Rebel first.
- **Settings UI warning**: When in dev mode, the Settings UI shows a warning that the configuration won't work.

### Rebel Must Be Configured

For the MCP server to work:
- Rebel must be installed (not just built)
- Core directory must be configured
- Claude API key or OAuth token must be set
- Any MCPs you want to use must be configured in Rebel


## Troubleshooting

### "MCP server is not enabled"

Open Rebel, go to Settings → Connectors, and enable "Allow external MCP access".

### "Core directory is not configured"

Open Rebel and set your default workspace directory in Settings.

### "Claude authentication is missing"

Configure your Claude API key or sign in via OAuth in Rebel's Settings.

### MCP client shows "spawn failed" or "command not found"

The executable path in your MCP config is incorrect. Verify:
1. Rebel is installed (not just built from source)
2. The path matches your installation location
3. On macOS, the full path should be `/Applications/Rebel.app/Contents/MacOS/Rebel`

### Rebel is processing another request

Only one turn can run at a time. Wait for the current request to complete before sending another.

### Requests are slow

This is expected behavior. Agent turns that involve multiple tool calls or complex reasoning can take 30–120 seconds. Rebel processes requests using Claude, which takes time for thorough responses.

### Can't find conversations in Rebel history

MCP server sessions are currently not persisted to Rebel's conversation history. The `conversationId` in responses is an in-memory session identifier only.


## Future Enhancements

The following are planned but not yet implemented:

- **Streaming responses**: Stream assistant text as it's generated
- **More tools**: `rebel_query_memory`, `rebel_list_spaces`, `rebel_get_capabilities`
- **MCP Resources**: Expose memories as MCP resources
- **MCP Prompts**: Expose skills as MCP prompts
- **Session persistence**: Maintain conversation state across MCP connections
- **Workspace override**: Allow specifying a different workspace per request
- **Visible audit log**: Show MCP server activity in Rebel's UI
