---
description: "Developer workflow for diagnosing Rebel conversations — session lookup, transcript JSONL, logs, diagnostics output, and bugfix handoff"
last_updated: "2026-05-10"
---

# Diagnose One of My Conversations

Developer workflow for deeply investigating weird behavior in a Rebel conversation you've had, using full access to logs, data storage, codebase, and multi-model review.


## See Also

- [READ_REBEL_CONVERSATION.md](./READ_REBEL_CONVERSATION.md) — **Start here** to get from a `rebel://conversation/{id}` link to the actual conversation data (session JSON + Claude SDK JSONL)
- [DEBUGGING.md](./DEBUGGING.md) — Quick-start log inspection and common debugging scenarios
- [LOGGING.md](./LOGGING.md) — Canonical source for log architecture, file locations, and configuration
- [DIAGNOSTICS.md](./DIAGNOSTICS.md) — System health checks, diagnostic bundle export, and sanitization
- [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md) — Complete reference for all Electron userData files
- [CLAUDE_AGENT_SDK_REFERENCE.md](../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md) — SDK session storage in `~/.claude/`
- [URL_PROTOCOL.md](./URL_PROTOCOL.md) — `rebel://conversation/{id}` URL format
- [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — Multi-stage workflow using multiple agents (subagents and/or called via CLI); when diagnosis reveals a code bug, fix it here with `bug_mode`
- `rebel-system/skills/operations/diagnose-conversation/SKILL.md` — Rebel's built-in diagnostic skill (for end-users)
- `rebel-system/scripts/claude_code_conversation_search.py` — Python script to search `.claude` transcripts


## When to Use This

Use this workflow when you (as a developer) have experienced strange behavior in your own Rebel conversations and want to deeply investigate:

- Agent produced unexpected output or got stuck
- Tools failed silently or behaved unexpectedly
- Context overflow or compaction issues
- Performance problems (slow TTFT, excessive tokens)
- MCP failures or connection issues

**Prerequisites:**
- Access to the Rebel codebase
- The conversation happened on your machine (you have local logs/storage)


## Input Collection

Gather as much of the following as you have:

### 1. Rebel Conversation Identifier

Either:
- **Rebel session ID**: From the URL bar, Insights drawer, or diagnostic bundle
- **rebel:// URL**: e.g., `rebel://conversation/abc123-def456`

### 2. User Context

A brief description of:
- What you expected to happen
- What actually happened
- Any specific turn or tool that seemed problematic

### 3. Diagnose-Conversation Output (Optional)

If you ran the `diagnose-conversation` skill in Rebel, paste or attach its markdown output. It provides:
- Session metadata and aggregate metrics
- Error/failure counts
- Tool breakdown
- Recent message previews


## Step 1: Locate All Data Sources

### Rebel Session Files

```bash
# macOS
SESSION_DIR=~/Library/Application\ Support/mindstone-rebel/sessions

# Find session by ID
grep -l "CONVERSATION_ID" "$SESSION_DIR"/*.json

# Or find by title keyword
grep -l "keyword" "$SESSION_DIR"/*.json
```

### Transcript JSONL (Full-Fidelity)

```bash
TRANSCRIPT_DIR=~/Library/Application\ Support/mindstone-rebel/transcripts

# Full-fidelity transcript for the conversation (complete tool I/O, usage, subagent events)
cat "$TRANSCRIPT_DIR/CONVERSATION_ID.jsonl" | python3 -m json.tool --no-ensure-ascii

# Check if transcript exists (14-day TTL — may have been cleaned up)
ls "$TRANSCRIPT_DIR/CONVERSATION_ID.jsonl"
```

> **Note:** Transcripts contain pre-sanitization events with full un-truncated tool content. They are the richest data source for conversation investigation, but are retained for only 14 days. See `src/core/services/transcriptService.ts` for the `TranscriptEntry` schema.

### Turn-Specific Logs

```bash
LOG_DIR=~/Library/Application\ Support/mindstone-rebel/logs

# Main log
cat "$LOG_DIR/mindstone-rebel.log"

# Turn-specific logs (contain session ID prefix)
ls "$LOG_DIR/sessions/"*CONVERSATION_ID_PREFIX*.log
```

## Step 2: Initial Triage

### Quick Health Check

Look for obvious problems first:

```bash
# Errors in main log around the conversation time
grep -i "error\|failed\|exception" "$LOG_DIR/mindstone-rebel.log" | tail -50

# MCP/tool failures
grep -i "mcp\|tool.*fail\|stream closed" "$LOG_DIR/mindstone-rebel.log"

# Context overflow signals
grep -i "compaction\|context.*overflow\|token" "$LOG_DIR/mindstone-rebel.log"
```

### Session File Analysis

Read the session JSON to understand:
- `messages` array — all user/assistant turns
- `events` — raw SDK events (errors, tool calls, status)
- `totalCostUsd` / `totalInputTokens` / `totalOutputTokens` — resource usage

Look for:
- Messages with `error` or `isError` flags
- Tool events with non-zero exit codes or error content
- Compaction/summarization events


## Step 3: Deep Investigation

**If the investigation points to a code bug**, fix it with [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) in `bug_mode` — evidence-first intake, parallel diverse-model diagnosis, surgical fix, and an unconditional postmortem; this investigation's findings become its Phase 0 evidence.

For issues that don't clearly point to a single code bug (ambiguous behavior, multiple possible causes), use multi-model review to get diverse perspectives:

### Prepare Investigation Prompt

Create a prompt containing:

```markdown
## Investigation Request

**Conversation ID**: [rebel://conversation/...]
**Upstream Session ID**: [...] (optional)
**Symptom**: [Brief description of the problem]

## Available Data

### Session Metadata
[Paste relevant fields from session JSON]

### Error Summary
[Paste grep output or error counts]

### Diagnose-Conversation Output (if available)
[Paste markdown output from skill]

### Key Log Entries
[Paste relevant log snippets]

## Focus Area
[tool-failures | performance | context | general]

## Questions
1. What went wrong?
2. Why did it happen?
3. Where in the codebase is this behavior implemented?
4. What could prevent this in the future?
```

### Launch Reviewers in Parallel

Use the three different reviewers for diverse perspectives:

```
Task: researcher-gpt
Prompt: [Investigation prompt + "Focus on codebase exploration to find relevant implementation"]

Task: reviewer-gpt5.5-high
Prompt: [Investigation prompt + "Focus on patterns and quick diagnosis"]

Task: reviewer-opus4.7-thinking
Prompt: [Investigation prompt + "Focus on deep architectural analysis"]
```

### Synthesize Findings

Collect reports from all three and look for:
- **Consensus** — Issues all three identify
- **Unique insights** — Problems only one reviewer caught
- **Contradictions** — Disagreements to investigate further


## Step 4: Codebase Correlation

Once you have hypotheses, verify against the codebase:

### Key Implementation Files

| Area | Files |
|------|-------|
| Agent turn execution | `src/main/index.ts` (executeAgentTurn) |
| Agent message handling | `src/main/services/agentMessageHandler.ts` |
| MCP/Super-MCP | `src/main/services/mcpService.ts`, `superMcpHttpManager.ts` |
| Context management | `src/core/services/recovery/recoveryPipeline.ts` |
| Tool safety | `src/main/services/toolSafetyService.ts` |
| Session state | `src/renderer/features/agent-session/store/` |

### Search Patterns

```bash
# Find where specific error messages originate
rg "error message text" src/

# Find tool handling
rg "tool.*name.*specific_tool" src/

# Find MCP-related code
rg "mcp|superMcp" src/main/
```


## Step 5: Document Findings

Create a conversation doc in Google Drive (`Shared drives/Product/droid-conversations/<repo-slug>/YYYY/MM/`):

```markdown
# Investigation: [Brief Title]

**Date**: YYYY-MM-DD
**Conversation**: rebel://conversation/...
**Symptom**: [What went wrong]

## Root Cause
[What we found]

## Evidence
- [Specific log entries]
- [Code references]
- [Reviewer findings]

## Resolution
- [Fix applied, if any]
- [Workaround for users]

## Prevention
- [Code changes to prevent recurrence]
- [Documentation updates needed]
```


## Quick Reference: Common Issues

| Symptom | Likely Cause | Where to Look |
|---------|--------------|---------------|
| "Stream closed" errors | MCP race condition | `superMcpHttpManager.ts`, check `mcpMode` |
| Tool failures | MCP server unhealthy | `mcpService.ts`, specific server logs |
| Context overflow | Long conversation | Session JSON `maxContextUtilization` |
| Slow TTFT | Large system prompt or MCP startup | Turn logs, `cli -- run --profile` |
| Missing tool output | Tool safety blocked | `toolSafetyService.ts`, approval events |
| Unexpected compaction | Context pressure | `recoveryPipeline.ts` |
| Missing/truncated tool output in session JSON | Normal truncation boundary | Check `transcripts/{id}.jsonl` for full content |


## Maintenance

Update this doc when:
- New diagnostic data sources are added
- Log formats change significantly
- New common failure patterns emerge
