---
description: Restart the dev server and open Rebel with a new or existing conversation to integration-test your changes before committing
argument-hint: <what to test, e.g. "Gmail MCP search tool" or "new settings panel layout">
---

# Test in Rebel

Restart the Rebel dev server and send a test prompt into a live Rebel conversation so you can integration-test your changes before committing.

## Step 1: Determine What Changed

Inspect the working tree to understand what was changed and build test context:

```bash
git diff --name-only
git diff --cached --name-only
```

Categorize the changes:
- **MCP-related**: files in `resources/mcp/`, `super-mcp/`, `src/main/services/mcpService.ts`, `src/main/services/bundledMcpManager.ts`, MCP config files
- **UI-related**: files in `src/renderer/`
- **Agent/core-related**: files in `src/core/`, `src/main/services/`
- **Other**: everything else

Store the list of changed files and category as `$CHANGED_FILES` and `$CHANGE_CATEGORY`.

## Step 2: Build a Test Prompt

Using `$ARGUMENTS` (what the user wants to test) and `$CHANGED_FILES`, compose a test prompt for Rebel. The prompt should:

1. Describe what was changed (briefly)
2. Ask Rebel to exercise the changed functionality
3. Ask Rebel to report whether it worked or failed

**Template** (adapt based on the change):

```
I just made changes to test. Here's what changed:

<brief summary of changes from $CHANGED_FILES>

Please test this by:
<specific test steps based on $ARGUMENTS and $CHANGE_CATEGORY>

Report back whether it worked correctly or if you see any issues.
```

**Examples by category:**

- **MCP change** (e.g. Gmail tool): "I updated the Gmail MCP search tool. Please try searching for recent emails using the Gmail connector and confirm the results look correct."
- **UI change** (e.g. settings panel): "I changed the settings panel layout. Please open Settings and check that everything renders correctly — try toggling a few settings and navigating between sections."
- **Agent/core change** (e.g. safety prompt): "I updated the safety prompt logic. Please try a tool call that requires safety evaluation and check that it's handled correctly."

Ask the user to confirm or adjust the test prompt before sending it.

## Step 3: Restart the Dev Server

Kill any existing dev server and relaunch with the latest code:

```bash
# Kill existing dev server
lsof -ti:5173 | xargs kill 2>/dev/null || true
sleep 1

# Also quit the installed Rebel app if running (single-instance lock conflict)
ps aux | grep "Mindstone Rebel.app" | grep -v grep && osascript -e 'quit app "Mindstone Rebel"' 2>/dev/null || true
sleep 1

# Relaunch dev server in the background
cd /Users/you/development/desktop/rebel-app && npm run dev &
```

Wait for the dev server and Electron app to be ready:

```bash
sleep 10
lsof -i:5173 | head -5
```

If the dev server failed to start, report the error and troubleshoot before proceeding.

## Step 4: Send the Test Prompt to Rebel

Read the bridge configuration to get the port and auth token:

```bash
cat "$HOME/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json"
```

Extract `port` and `token`. If the file doesn't exist or is stale (from a previous run), wait for the dev server to write it — retry up to 3 times with 5-second intervals:

```bash
for i in 1 2 3; do
  cat "$HOME/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json" 2>/dev/null && break
  sleep 5
done
```

Then start a new conversation with the test prompt:

```bash
BRIDGE_PORT=$(jq -r '.port' "$HOME/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json")
BRIDGE_TOKEN=$(jq -r '.token' "$HOME/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json")

curl -s -X POST "http://127.0.0.1:${BRIDGE_PORT}/conversations/start" \
  -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg text "$TEST_PROMPT" \
    '{text: $text, sendMessage: true, switchToConversation: true}')"
```

This creates a new conversation, switches Rebel's UI to it, and sends the test message so the agent starts working immediately.

**If the bridge is unreachable** (Rebel hasn't finished starting yet), wait 10 more seconds and retry. If it still fails, tell the user:
> Rebel's bridge isn't responding yet. The dev server is running — please manually open Rebel and start a new chat with the test prompt above.

## Step 5: Report and Wait

Tell the user:

> **Dev server restarted and test sent to Rebel.**
>
> Rebel is now running the test in a new conversation. Switch to the Rebel window to watch the results.
>
> **What was sent**: <the test prompt>
> **Changed files**: <list of changed files>
>
> Once you've verified the results, come back here and let me know if anything needs fixing.

If the user wants to **send to an existing conversation** instead of creating a new one (e.g. they have ongoing context), they can provide a session ID and we use the `/conversations/{sessionId}/send` endpoint instead:

```bash
curl -s -X POST "http://127.0.0.1:${BRIDGE_PORT}/conversations/${SESSION_ID}/send" \
  -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg text "$TEST_PROMPT" \
    '{text: $text, sendMessage: true, switchToConversation: true}')"
```

## Important

- The dev server restart is mandatory — it ensures Rebel is running your latest code, not a stale build.
- The installed Rebel app must be quit first (single-instance lock). Step 3 handles this.
- The bridge config at `~/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json` is written on every startup; stale files from previous runs won't work (wrong port/token).
- For MCP changes: after the dev server restarts, MCP servers are re-bundled and reloaded automatically. No manual restart of individual MCP servers is needed.
- `sendMessage: true` tells Rebel to actually send the message to the agent (not just put it in the composer).
- `switchToConversation: true` brings the conversation to the foreground in Rebel's UI.
- This command does NOT commit or update Linear tickets — use `/finish-task` for that after testing passes.
