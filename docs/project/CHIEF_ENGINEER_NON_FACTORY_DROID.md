---
description: "Setup guide for running Chief Engineer workflows outside Factory Droid — Cursor, Claude Code, manual subagents, handoffs"
last_updated: "2026-02-20"
---

# Chief Engineer Workflow: Non-Factory Droid Setup

Setup instructions for using the Chief Engineer workflow with tools other than Factory Droid.

> **Note**: This document covers Cursor, Claude Code, and other tools. For the main workflow documentation, see [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md).

---

## Cursor

### Option 1: Sub-Agents MCP (Recommended)

Install the Sub-Agents MCP server for explicit delegation similar to Factory droids:
- Repository: `github.com/shinpr/sub-agents-mcp`
- Provides: `delegate_task` tool for spawning subagents with prompts
- Each subagent runs with its own context window

**Setup:**
1. Clone the repo: `git clone https://github.com/shinpr/sub-agents-mcp.git`
2. Install dependencies: `cd sub-agents-mcp && npm install`
3. Add to your MCP config (usually `~/.cursor/mcp.json` or project `.cursor/mcp.json`):
   ```json
   {
     "mcpServers": {
       "sub-agents": {
         "command": "node",
         "args": ["/path/to/sub-agents-mcp/dist/index.js"],
         "env": {
           "AGENTS_DIR": "/path/to/your/project/docs/project"
         }
       }
     }
   }
   ```
4. Create agent definition files (Markdown) for each subagent role
5. Use the subagent definitions from `coding-agent-instructions/droids/` and `coding-agent-instructions/sub_agents/`
6. Restart Cursor

### Option 2: Background Agents

Use Cursor's native Background Agents (`Cmd/Ctrl+E`) for parallel execution:
- Good for: Running implementation and review tasks in parallel
- Limitation: Less structured delegation - agents run independently without returning structured responses to you
- Each agent has its own context window

**To use:**
1. Open Background Agent Panel (`Cmd/Ctrl+E`)
2. Start an agent with the implementer/reviewer prompt from `coding-agent-instructions/droids/`
3. Monitor progress in the panel
4. Review results and incorporate into main conversation

### Option 3: Manual Session Management

For simple cases, manually start separate Cursor chat sessions:
1. Start a new chat for each subagent role
2. Paste the relevant system prompt from `coding-agent-instructions/droids/`
3. Provide the task prompt
4. Copy results back to your main session

---

## Claude Code

Use Claude Code's native subagent capability (if available) or the Task tool:
```
dispatch_agent(
  agent_name: "implementer" | "reviewer",
  task: <your prompt>
)
```

Configure agents using the definitions from `coding-agent-instructions/droids/`.

---

## Other Tools

For other AI coding tools that support subagent or multi-agent workflows:

1. Check if the tool supports spawning subagents with custom prompts
2. Use the subagent definitions from `coding-agent-instructions/droids/` as system prompts
3. Follow the workflow phases documented in the main guide

---

## Key Behaviors (All Tools)

- **Fresh context per invocation**: Each subagent call creates a new instance with no memory of previous calls
- **Planning doc provides continuity**: All subagents read the planning doc for context
- **Main agent maintains continuous context**: You have full conversation history to bridge handoffs

---

## See Also

- [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) - Main workflow documentation and planning doc template
- `coding-agent-instructions/droids/` - Subagent definitions (base + model-specific)
