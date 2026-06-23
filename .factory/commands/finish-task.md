---
description: Finish a Rebel-handed-off task — notify Rebel and exit cleanly so the SessionEnd hook fires
argument-hint: <optional: summary of what was done>
---

# Finish Task

Finish up the current Rebel-handed-off task. This notifies the originating Rebel conversation that work is complete and prompts for a clean session exit so the SessionEnd hook fires properly.

## Step 1: Find the contract file

Look for the Rebel hand-off contract:

```bash
ls -t /tmp/rebel-droid-contracts/*.json 2>/dev/null | head -1
```

If no contract file exists, tell the user: "No Rebel hand-off contract found — this session wasn't started by Rebel. You can just `/quit` to exit."

If a contract file is found, read it:

```bash
cat /tmp/rebel-droid-contracts/<filename>.json
```

Extract: `rebel_session_id`, `ticket_id`, `ticket_title`.

**Also extract these optional fields if present** (the hand-off skill may include them when the task is a bug fix):

- `task_type` — `"bug"`, `"feature"`, `"refactor"`, etc.
- `bug_summary` — short human description of the bug being fixed
- `affected_users` — array of `{ email, name?, source? }` (e.g. extracted from Sentry, Slack, Zendesk, or the originating conversation)
- `sentry_issue_url` / `sentry_issue_id` — if the bug was reported via Sentry
- `source_conversation_url` / `source_thread_url` — Slack/Zendesk/email link that surfaced the bug

These fields drive the bug-fix release-notification flow in Step 3. They are **all optional** — gracefully fall back to "missing" if absent.

## Step 2: Gather completion context

Check what was done during this session:

```bash
# Get the handoff time from the contract
HANDOFF_TIME=$(jq -r '.handoff_time' /tmp/rebel-droid-contracts/<filename>.json)

# Check for commits since handoff
git log dev --since="$HANDOFF_TIME" --oneline
```

Also pull the ticket title (needed for the bug-fix heuristic below) and the optional bug-context fields (use `// ""` so missing fields are empty strings, not `null`):

```bash
TICKET_ID=$(jq -r '.ticket_id' /tmp/rebel-droid-contracts/<filename>.json)
TICKET_TITLE=$(jq -r '.ticket_title' /tmp/rebel-droid-contracts/<filename>.json)
TASK_TYPE=$(jq -r '.task_type // ""' /tmp/rebel-droid-contracts/<filename>.json)
BUG_SUMMARY=$(jq -r '.bug_summary // ""' /tmp/rebel-droid-contracts/<filename>.json)
AFFECTED_USERS_JSON=$(jq -c '.affected_users // []' /tmp/rebel-droid-contracts/<filename>.json)
SENTRY_ISSUE_URL=$(jq -r '.sentry_issue_url // ""' /tmp/rebel-droid-contracts/<filename>.json)
SOURCE_CONVERSATION_URL=$(jq -r '.source_conversation_url // ""' /tmp/rebel-droid-contracts/<filename>.json)
```

Determine whether to treat this as a bug fix:

```bash
# Treat as bug fix if contract says so OR ticket title strongly suggests it
IS_BUGFIX="false"
if [ "$TASK_TYPE" = "bug" ]; then
  IS_BUGFIX="true"
elif echo "$TICKET_TITLE" | grep -qiE '^(fix|bug|hotfix|regression)\b|\bfix(es|ed)?\b.*\b(bug|crash|regression|error)\b'; then
  IS_BUGFIX="true"
fi
```

If `IS_BUGFIX` cannot be confidently determined from the contract or title, leave the bug-fix block out and let Rebel decide based on the Linear ticket labels/state when it processes the message.

Build a brief summary of:
- What commits were made (if any)
- The ticket ID and title
- Whether this looked like a bug fix (`IS_BUGFIX`)
- Any affected users surfaced in the contract (`AFFECTED_USERS_JSON`)
- Any additional context from `$ARGUMENTS` (the user's summary)

## Step 3: Notify Rebel via HTTP bridge

Read the Rebel bridge configuration:

```bash
cat "$HOME/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json"
```

Extract `port` and `token`, build the message once, then try the originating Rebel conversation first and fall back to starting a **new** conversation if that session no longer exists (HTTP 404 from the bridge).

```bash
BRIDGE_PORT=$(jq -r '.port' "$HOME/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json")
BRIDGE_TOKEN=$(jq -r '.token' "$HOME/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json")
REBEL_SESSION_ID=$(jq -r '.rebel_session_id' /tmp/rebel-droid-contracts/<filename>.json)
TICKET_ID=$(jq -r '.ticket_id' /tmp/rebel-droid-contracts/<filename>.json)
TICKET_TITLE=$(jq -r '.ticket_title' /tmp/rebel-droid-contracts/<filename>.json)

# Count commits
COMMIT_COUNT=$(git log dev --since="$HANDOFF_TIME" --oneline | wc -l | tr -d ' ')

# Build the message (same text works for both existing-conversation send and new-conversation start)
if [ "$COMMIT_COUNT" -gt 0 ]; then
    LATEST=$(git log dev --since="$HANDOFF_TIME" --oneline -1)
    STATUS_LINE="**Status: $COMMIT_COUNT commit(s) landed on dev** ✅"
else
    STATUS_LINE="**Status: Session ended with no commits on dev** ⚠️"
fi

# Build a bug-fix release-notification block when applicable. Skipped for non-bug tasks
# or when no commits landed (nothing to notify users about yet).
BUGFIX_BLOCK=""
if [ "$IS_BUGFIX" = "true" ] && [ "$COMMIT_COUNT" -gt 0 ]; then
  # Format affected users (if any) as a readable bullet list
  AFFECTED_USERS_BULLETS=""
  if [ "$AFFECTED_USERS_JSON" != "[]" ] && [ -n "$AFFECTED_USERS_JSON" ]; then
    AFFECTED_USERS_BULLETS=$(echo "$AFFECTED_USERS_JSON" | jq -r '
      .[] | "  - " + (.email // "unknown") +
            (if .name then " (" + .name + ")" else "" end) +
            (if .source then " — source: " + .source else "" end)
    ')
  fi

  BUG_CONTEXT_LINES=""
  [ -n "$BUG_SUMMARY" ]            && BUG_CONTEXT_LINES="${BUG_CONTEXT_LINES}- **Bug:** ${BUG_SUMMARY}\n"
  [ -n "$SENTRY_ISSUE_URL" ]       && BUG_CONTEXT_LINES="${BUG_CONTEXT_LINES}- **Sentry issue:** ${SENTRY_ISSUE_URL}\n"
  [ -n "$SOURCE_CONVERSATION_URL" ] && BUG_CONTEXT_LINES="${BUG_CONTEXT_LINES}- **Source thread:** ${SOURCE_CONVERSATION_URL}\n"

  if [ -n "$AFFECTED_USERS_BULLETS" ]; then
    AFFECTED_BLOCK="**Affected users (from contract):**\n${AFFECTED_USERS_BULLETS}"
  else
    AFFECTED_BLOCK="**Affected users:** _none captured in contract — please check the Linear ticket description, the originating Rebel conversation, and any linked Sentry/Slack/Zendesk threads to identify who reported or was hit by this bug._"
  fi

  BUGFIX_BLOCK=$(printf "\n---\n\n**This was a bug fix.** Before closing the ticket, please update release notifications:\n\n%b\n%b\n\n**Action:** For each affected user, add (or update) an entry in \`General/memory/topics/Release-Notifications-Next.md\` with:\n- The user's name + email\n- A short description of what was fixed (plain-English, brand voice)\n- A link to the Linear ticket (${TICKET_ID}) and/or Sentry issue\n- A draft reply they should receive when the next release ships\n\n**Do NOT send the email now.** The fix is on \`dev\` — it ships to users on the next release. The release-to-production flow is what triggers the actual outreach. We're queuing the notification so it goes out at the right moment.\n\nIf no affected users can be identified from the contract, ticket, conversation, Sentry, or linked threads, say so explicitly and ask the user whether to skip release-notification queueing for this fix.\n" "$BUG_CONTEXT_LINES" "$AFFECTED_BLOCK")
elif [ "$COMMIT_COUNT" -gt 0 ]; then
  # Fallback: contract didn't flag this as a bug and the title heuristic didn't fire,
  # but we don't want to silently miss release-notification queueing for unflagged bugs.
  BUGFIX_BLOCK=$'\n\n_If this turns out to be a bug fix (check Linear labels / ticket type), please queue affected users into `General/memory/topics/Release-Notifications-Next.md` with a draft reply before closing the ticket — do not send email until the next release ships._'
fi

MSG_TEXT="🤖 **Droid finished task: ${TICKET_ID} — ${TICKET_TITLE}**

${STATUS_LINE}

Please:
1. Read the result file and check git log to see what was committed
2. If commits landed on dev: **close the Linear ticket** (mark ${TICKET_ID} as Done)
3. Report what was done and offer next actions${BUGFIX_BLOCK}"

# Try sending to the originating conversation first
SEND_RESPONSE=/tmp/rebel-notify-response.json
SEND_STATUS=$(curl -s -o "$SEND_RESPONSE" -w "%{http_code}" \
  -X POST "http://127.0.0.1:${BRIDGE_PORT}/conversations/${REBEL_SESSION_ID}/send" \
  -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg text "$MSG_TEXT" \
    '{text: $text, sendMessage: true, switchToConversation: true}')")

echo "send -> HTTP ${SEND_STATUS}"
cat "$SEND_RESPONSE" 2>/dev/null; echo

# If the originating conversation is gone (404), start a fresh one
if [ "$SEND_STATUS" = "404" ]; then
  START_RESPONSE=/tmp/rebel-notify-start.json
  START_STATUS=$(curl -s -o "$START_RESPONSE" -w "%{http_code}" \
    -X POST "http://127.0.0.1:${BRIDGE_PORT}/conversations/start" \
    -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg text "$MSG_TEXT" \
      '{text: $text, sendMessage: true, switchToConversation: true}')")
  echo "start (fallback) -> HTTP ${START_STATUS}"
  cat "$START_RESPONSE" 2>/dev/null; echo
fi
```

Interpret the result and tell the user:

- **Send succeeded (HTTP 200 on `/send`)** → "Rebel has been notified in the originating conversation. The deep-link in the task description will take you there."
- **Send returned 404, start succeeded (HTTP 200 on `/conversations/start`)** → "The originating conversation was no longer available, so I started a fresh conversation in Rebel with the result. The new conversation URL is in the response JSON — Rebel should have switched to it automatically."
- **Both calls failed (Rebel not running, wrong port, auth error, etc.)** → "Couldn't reach Rebel (send status: X, start status: Y). You can manually return via the deep-link in the task description."

**Why the fallback matters:** If the user closed the originating conversation, deleted it, or switched it to private mode before the droid finished, the send endpoint returns 404. Starting a new conversation ensures the completion notice and ticket-close reminder still land somewhere visible instead of being silently dropped.

## Step 4: Restart the Dev Server

Ensure `npm run dev` is running with the latest code. Always kill any existing instance first, then relaunch — this guarantees the user is testing against fresh code, not a stale build.

```bash
# Kill any existing dev server (electron-vite uses port 5173)
lsof -ti:5173 | xargs kill 2>/dev/null || true
# Give it a moment to clean up
sleep 1
# Relaunch in the background from the repo root
cd "$(git rev-parse --show-toplevel)" && npm run dev &
```

Wait a few seconds, then confirm the dev server is running:

```bash
sleep 5 && lsof -i:5173 | head -5
```

If the dev server failed to start, report the error and troubleshoot.

## Step 5: Prompt for Integration Testing and Clean Exit

After notifying Rebel and restarting the dev server, tell the user:

> **Rebel has been notified. Dev server restarted with latest changes.**
>
> **Integration testing**: Please test the change manually in the app to verify it works end-to-end.

If the change is **MCP-related** (touched files in `resources/mcp/`, `src/main/services/mcpService.ts`, `super-mcp/`, or MCP-related config), add:

> **MCP integration test recommended**: This change touches MCP code. Please test the MCP server end-to-end in Rebel — trigger the relevant tool/resource and verify it behaves correctly. If the MCP server needs to be restarted, do so from Settings > MCP Servers or restart the app.

If the change is **UI-related** (touched files in `src/renderer/`), add:

> **UI integration test recommended**: Open the app and verify the UI change looks correct in both light and dark modes.

Then prompt for exit:

> To ensure the SessionEnd hook fires and cleans everything up, please run `/quit` or press Ctrl+D to exit this session cleanly.
>
> (Closing the terminal window directly may skip the hook — use `/quit` instead.)

Do **NOT** automatically run `/quit` — let the user do it so they can review anything first.

## Important

- This command is for **Rebel-initiated sessions** (ones started via the hand-off-to-coding-agent skill)
- The contract file at `/tmp/rebel-droid-contracts/` is how we know which Rebel conversation to notify
- The HTTP bridge (`rebel-inbox-bridge.json`) provides the local port and auth token for Rebel's API
- Always use `jq` for JSON parsing — it's available on macOS
- If any step fails, explain what went wrong and suggest the manual fallback (click the deep-link in the task description)

## Bug-fix flow (release notifications)

When the contract marks a task as a bug fix (`task_type: "bug"`) — or the ticket title looks like a bug fix and commits landed on `dev` — this command appends a release-notification block to the message Rebel receives. That block instructs Rebel to:

1. Identify affected users from the contract's `affected_users` field, the Linear ticket, the originating conversation, and any linked Sentry/Slack/Zendesk threads
2. Add (or update) an entry per user in `General/memory/topics/Release-Notifications-Next.md` with name, email, what was fixed, ticket/Sentry link, and a draft reply
3. **Not send the email yet** — drafts are queued; outreach goes out when the next release ships (driven by the release-to-production flow)

The hand-off-to-coding-agent skill should populate the contract with bug context where possible:

```json
{
  "rebel_session_id": "...",
  "ticket_id": "FOX-1234",
  "ticket_title": "...",
  "handoff_time": "...",
  "task_type": "bug",
  "bug_summary": "Cross-conversation leak when continuing a deck draft",
  "affected_users": [
    { "email": "user@example.com", "name": "Jane Doe", "source": "Sentry REBEL-4ZQ" }
  ],
  "sentry_issue_url": "https://mindstone.sentry.io/issues/REBEL-4ZQ/",
  "source_conversation_url": "https://example.slack.com/archives/C123/p456"
}
```

All bug fields are optional — when missing, the message asks Rebel to identify affected users itself before queueing.
