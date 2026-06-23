---
description: "Tool safety evaluation system: Safety Prompt-based pre-execution checks, approval flows, staged MCP calls, and deterministic fallback"
last_updated: "2026-06-07"
---

# Tool Safety

Rebel's tool safety system provides context-aware evaluation of MCP tool calls using the Safety Prompt system before execution. The evaluator returns `allow|block` decisions with confidence levels, enabling intelligent safety checks that understand intent rather than just pattern-matching on tool names.

## See Also

- [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) — Safety system overview (architecture, all subsystems, evaluator hardening, approval re-eval)
- [MEMORY_SAFETY.md](MEMORY_SAFETY.md) — Memory write safety (sibling system for file writes to memory spaces)
- [CONVERSATION_APPROVAL_TYPES.md](CONVERSATION_APPROVAL_TYPES.md) — Approval type taxonomy and UX flows
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — Full settings reference
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) — MCP and Super-MCP configuration
- `src/main/services/toolSafetyService.ts` — Core implementation (skip lists, evaluation, approval handling, all runtime branches)
- `src/core/safetyPromptLogic.ts` — Evaluation logic, principle generation, deterministic fallback
- `src/core/safetyEvaluationService.ts` — Platform-agnostic evaluator boundary interface

## Architecture Overview

```
Tool Call Generated
    │
    ▼
PreToolUse Hook (createToolSafetyHook)
    │
    ├── Bypass branches (see Runtime Branches table)
    │   └── Internal MCP / Admin-disabled / Framework / Trusted / Read-only / etc.
    │
    └── Safety Prompt Evaluation
            │
            ▼
        { decision: allow|block, confidence: high|medium|low, reason }
            │
            ▼
        Confidence Gate (shouldAllow)
            │
            ├── Side-effect tools: require HIGH confidence → allow
            ├── Non-side-effect: MEDIUM or HIGH → allow
            └── Block / LOW confidence → deny
                    │
                    ├── MCP tool → Stage for later execution
                    └── Non-MCP tool → Deny + approval card → user Allow/Deny → retry
```

## User-Facing Settings

### Settings > Safety Tab

The Safety tab has five zones (see `src/renderer/features/settings/components/tabs/SafetyTab.tsx`):

1. **Your Safety Rules** — `SafetyPromptEditor` for custom natural-language instructions. Includes a "Chat with Rebel about your rules" button for refining rules conversationally.
2. **What Rebel can do without asking** — Three sub-groups:
   - *Tools*: Trusted tools list (always-allow bypass, removable)
   - *Files*: Remembered file approvals (always-save, removable)
   - *Memory Spaces*: Per-space safety level selector
3. **Activity** — `SafetyActivityLog` showing actions evaluated against Safety Rules, with flag/unflag for incorrect decisions
4. **Built-in protections** — Collapsible list of read-only patterns that always skip evaluation
5. **Privacy & Data** — Privacy assurance cards (local-first, no AI training, etc.)

> **Note:** There is no tool-safety-level selector. The legacy `toolSafetyLevel` and `userSafetyInstructions` settings fields are deprecated. Tool evaluation is controlled entirely by the Safety Prompt and trusted tools list.

### Safety Rules (Safety Prompt)

Users write natural-language rules in Settings > Safety > "Your Safety Rules" (e.g., "Always ask before emailing anyone outside our company"). These rules are injected into the LLM evaluation prompt and considered alongside action context to produce `allow|block` decisions.

See [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) for the full Safety Prompt lifecycle (versioning, history, revert, reset, principle management).

## Safety Prompt Evaluation

### How Evaluation Works

Each non-skipped tool call is evaluated by the BTS evaluator model via `SafetyEvaluationService` (platform-agnostic boundary interface — Electron and Cloud provide their own LLM wiring). The evaluator receives:
- The user's Safety Rules (Safety Prompt)
- Tool name, description, and input parameters
- Action context (user message, session type)

All untrusted content is XML-fenced to mitigate prompt injection. Response format:

```json
{
  "decision": "allow" | "block",
  "confidence": "high" | "medium" | "low",
  "reason": "Brief explanation"
}
```

### Confidence Gate (`shouldAllow()`)

The confidence gate applies different thresholds based on whether the tool has side effects:

| Tool Type | Decision | Confidence | Result |
|-----------|----------|------------|--------|
| Side-effect (send, create, delete, post, write, update, etc.) | `allow` | `high` | **Allow** |
| Side-effect | `allow` | `medium` or `low` | **Block** (insufficient confidence) |
| Non-side-effect (read, list, search, etc.) | `allow` | `medium` or `high` | **Allow** |
| Any | `block` | any | **Block** |
| Any | `allow` | `low` | **Block** |

Side-effect detection uses word-boundary-aware verb matching via `sideEffectPatterns` and `NEVER_TRUST_SUBSTRINGS` in `src/core/services/safety/toolVerbs.ts`, applied through `shouldAllow()` in `src/core/safetyPromptLogic.ts`.

**Key files:**
- `src/core/safetyPromptLogic.ts` — `evaluateSafetyPrompt()`, `shouldAllow()`, XML fencing, cache, fallback
- `src/core/safetyEvaluationService.ts` — Platform-agnostic boundary interface
- `src/core/services/safety/btsSafetyEvalService.ts` — BTS model selection for safety evaluations

### Skip List (Performance Optimization)

Obvious metadata/read-only operations skip LLM evaluation entirely:

**Exact matches:**
- `mcp__super-mcp-router__list_tool_packages`
- `mcp__super-mcp-router__list_tools`
- `mcp__super-mcp-router__get_tool_details`
- `mcp__super-mcp-router__search_tools`
- `mcp__super-mcp-router__health_check_all`
- `mcp__super-mcp-router__health_check`
- `mcp__super-mcp-router__get_help`

**Verb-based matching** (applied to inner `tool_id` for `use_tool` calls via `isDeterministicallyReadOnly()`):
- Uses word-boundary-aware regex matching (not simple `includes()`)
- Read-only verbs: `list`, `get`, `search`, `read`, `fetch`, `find`, `describe`, `show`, `check`, `view`, `inspect`, `lookup`, `count`, `draft`, `history`, `preview`, `load`
- **Security hardening**: Tools containing BOTH read-only and side-effect verbs (e.g., `read_and_delete_files`, `list_users_and_send_email`) are NOT skipped — the side-effect verb counter-check forces them through LLM evaluation
- `SENSITIVE_SUBSTRINGS` (token, secret, password, etc.) override: tools with sensitive substrings always go through LLM evaluation regardless of verbs

**Bash command heuristics** (`isBashCommandSafeToSkip()` in `toolSafetyService.ts`):
- Read-only pipe chains are auto-allowed when every segment is a known read-only command (e.g., `cat file | head -5`, `grep pattern file | wc -l`)
- Heredoc/herestring handling: only the command header (before `<<`/`<<<`) is checked for dangerous patterns, preventing false positives from content in heredoc bodies
- `find` is allowed as read-only with a secondary check that blocks dangerous flags (`-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fls`, `-fprint`, `-fprintf`)

**Parameter-expansion bypass class (closed, commit `2f406ae8e`):** `isBashCommandSafeToSkip()` previously let a sensitive path hidden inside shell parameter expansion (e.g. `cat ${MISSING:-/etc/passwd}`, `cat ${PWD/*//etc/passwd}`) survive the prefilter and return skip-safety=`true`, even though the shell would expand it to a dangerous command. The prefilter now extracts the expandable bodies — default/alternate-operator words (`:-`/`:=`/`:?`/`:+`), pattern-substitution replacement words (`${VAR/pat/repl}`), and recomposed adjacent expansion bodies — and feeds them through the existing dangerous-pattern / sensitive-path / deny scanners, **failing closed** (not skippable) when an expansion can't be enumerated. **Scope boundary (by design):** pure substring/indirection/case-modification expansions (no literal path in the source) stay skippable. A behaviour-level pre-spawn test locks in the prior protected-path guard. Implementation: `src/core/services/safety/toolSafetyService.ts`.

**Tool descriptions**: When LLM evaluation IS triggered, the evaluator receives the tool's self-reported description (from MCP server) via `toolDescriptionCache`, fenced in XML tags to mitigate prompt injection.

### Runtime Branches (Pre-Evaluation)

Before Safety Prompt evaluation, tool calls pass through a series of bypass/override branches in `toolSafetyService.ts`:

| Branch | Condition | Behavior |
|--------|-----------|----------|
| **Rebel-internal MCP** | `packageId` in `INTERNAL_MCP_SERVER_NAMES` | Always allow — internal app tools |
| **Admin-disabled** | Tool in org `disabledConnectorTools` | Hard block — no approval card, cannot be overridden |
| **Agent framework** | Tool in `SKIP_TOOL_NAMES` | Always allow — read-only/orchestration |
| **Automation circuit breaker** | ≥10 safety blocks in session | Hard stop — prevents runaway automation |
| **Windows Python guard** | Python command on Windows | Block if resolves to MS Store alias |
| **MCP server mode** | `REBEL_MCP_SERVER_MODE=1` | Auto-approve all (audit logged) |
| **Trusted tools** | In user's `trustedTools` list (non-private mode) | Auto-allow (except consent-required tools) |
| **Single-use approval** | Previously approved this turn/session | Consume and allow |
| **Cross-turn pending** | Same tool pending approval in another turn | Block to prevent races |
| **Read-only skip** | `shouldSkipEvaluation()` / `isDeterministicallyReadOnly()` | Allow without LLM call |
| **Safety Prompt eval** | All remaining tools | LLM evaluation → confidence gate → allow / stage / deny |

**Consent-required tools:** Some tools (e.g., calendar mutations) always require explicit per-use approval even if trusted or if the evaluator returns `allow/high`. This forces staging regardless. See `isConsentRequiredTool()` in `src/core/services/safety/toolVerbs.ts`.

### Safety Prompt MCP Tools

Two MCP tools allow the agent to read and update the user's safety rules programmatically:

- `rebel_safety_prompt_get` — Returns the current safety prompt text
- `rebel_safety_prompt_update` — Updates the safety prompt (with user confirmation)

Both are in the `SKIP_TOOL_NAMES` bypass list to prevent evaluation loops — they are control-plane tools that manage safety policy, not user-facing actions with external side effects.

## Approval Flow

### Non-Blocking Design (Deny + Retry)

When a tool requires approval:
1. PreToolUse hook returns DENY immediately (no blocking)
2. Notification sent to renderer (fire-and-forget)
3. Denial card appears in conversation showing "Operation denied"
4. User reviews and clicks "Allow this once" or "Dismiss"
5. On approve: store approval via IPC, send continuation message via queue
6. Agent receives continuation, retries the tool
7. Retry hits pre-approved check, executes successfully

**Queueing behavior**: Continuation messages are routed through `useMessageQueue` with `queueMode: 'queue'`. If the agent is mid-turn, the continuation queues and drains after the turn completes. If idle, it sends immediately. This prevents approval continuations from interrupting active turns. Cross-session surfaces (Inbox, Automations, NotificationDrawer) use the same queue via callback injection. See `buildToolContinuationMessage.ts` for the shared message builder.

This design avoids timeout issues and handles parallel sub-agents gracefully by showing multiple denial cards.

**Auto-resolution after Safety Rules update:** When the user updates their Safety Rules (via Settings or principle option selection), all pending tool approvals are automatically re-evaluated against the new rules. Approvals that now pass are silently auto-resolved — the approval card vanishes and a continuation is sent to resume the agent. This handles the common case where multiple similar tool calls are blocked by the same rule. See `src/main/services/safety/approvalReEvalService.ts`.

For MCP side-effect tools, approvals can be staged—the agent continues while tool calls queue for user review. Staged calls use an in-memory execution lock to prevent double-execution races, and allowlisted tools bypass staging entirely. See `src/main/services/safety/stagedToolCallsService.ts`.

### Session-Type Variations

| Session Type | Prefix | Behavior |
|-------------|--------|----------|
| **Interactive** | (default) | Full Safety Prompt evaluation, approval cards, staged MCP calls |
| **Automation** | `automation-*` | Same evaluation, but uses `handleAutomationSafetyPromptBlock()`. Circuit breaker at 10 blocks. |
| **Role** | `role-*` | Trust-level-aware: `supervised` = force-stage all external tools; `trusted`/`autonomous` = Safety Prompt evaluation. Circuit breaker at 10 blocks. |
| **Inbound Slack** | `inbound-*` | Auto-approves `reply_to_slack_thread` and `post_slack_message` before evaluation — user opted in via @-mention. |

### Safety-Evaluator Infra Failure Behavior

When the evaluator fails closed (`failClosed === true`), tool execution still fails closed (never auto-allow), but routing is no longer blanket hard-deny:
- Interactive + human path: ASK via approval card (`blockedBy: 'eval_error'`) with honest copy from `src/shared/safety/evalErrorCopy.ts`
- Automation/no-human MCP path: STAGE for later approval (`blockedBy: 'eval_error'`)
- Residual no-human non-MCP path: deny with explicit "safety check couldn't run" copy
- Cloud ingress approval registration: inbound `failClosed === true` metadata is still dropped (defense-in-depth)
- Before these routes, the evaluator first attempts a fallback-model hop; if that also fails, fail-closed routing applies

### Approval Re-evaluation

When the user updates their Safety Rules, `approvalReEvalService.ts` automatically re-evaluates all pending approvals:

- **Tool approvals** — Re-evaluates deny-retry approvals. If now allowed, auto-resolves and sends continuation.
- **Staged MCP calls** — Re-evaluates staged calls blocked by Safety Rules. If now allowed, **auto-executes** the call server-side.
- **Memory approvals** — Re-evaluates pending writes blocked by `safety_prompt` or `eval_error`.
- **Triggers:** Safety Prompt update, revert, reset, or async consolidation.
- **Session grouping:** Continuations are grouped by session to prevent flooding.
- **Mid-run abort:** If the Safety Prompt version changes again during re-evaluation, the run stops early.
- **Duplicate continuation deduplication:** Re-eval checks if an approval was already resolved to avoid duplicate continuations (see commit `e47d541ee`).

See [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) for more details on re-evaluation.

### User Actions

Current approval UI uses principle-based rule updates (not legacy approval scopes):

| Button | Behavior | Implementation |
|--------|----------|----------------|
| **Allow once** | Approve once, trigger retry | Stores single-use approval (consumed on next check), sends continuation message |
| **Allow & choose rule update...** | Approve + update Safety Rules | Opens scope dialog: "All uses of this tool" / "Similar actions" / "Just this specific action". Only for Safety Rules blocks. |
| **Always allow** | Add to trusted tools list | Updates `settings.trustedTools`, sends continuation. Shows confirmation dialog first. |
| **Deny once** | Reject this action | Agent is told it was denied, no retry |
| **Deny & choose rule update...** | Reject + add deny rule | Opens scope dialog to add a deny rule to Safety Rules |

### Approval Storage

Approvals use **single-use** storage via `sessionApprovals.ts`:
- Stored per `(sessionId, toolIdentifier)` using the **bare tool name** (e.g., `send_email`, not `gmail/send_email`)
- Consumed on the next tool check — if the retry fails and the tool is called again, it requires re-approval
- For `use_tool` calls, stores the inner `tool_id` (resolved via `getEffectiveToolIdentifier()`)

**Trusted tools** (permanent bypass): Stored in `settings.trustedTools` — visible and removable in Settings > Safety > Permissions. Auto-approved across all sessions. Disabled when Privacy Mode is active.

### Batch Actions

When multiple operations are denied, batch action buttons appear:
- **Allow All & Retry** — Approves all pending operations, sends grouped continuation
- **Deny All** — Rejects all pending operations

## Implementation Details

### Key Files

| File | Purpose |
|------|---------|
| `src/main/services/toolSafetyService.ts` | Core service: hooks, evaluation, approval handling |
| `src/main/services/agentTurnExecutor.ts` | Integrates hook into agent turn |
| `rebel-system/prompts/safety/eval-system.md` | Evaluation prompt template (loaded via `buildEvalSystemPrompt()`) |
| `src/renderer/features/settings/components/tabs/SafetyTab.tsx` | Settings UI |
| `src/renderer/features/agent-session/components/ApprovalPointerBar.tsx` | Lightweight per-conversation approval pointer (opens NotificationDrawer) |
| `src/renderer/features/inbox/components/InboxItemCard.tsx` | Rich approval card (used in Inbox) |
| `src/renderer/components/approval/primitives/` | Shared approval UI primitives (RiskBadge, DetailsAccordion, WhySection, SharingBadge, ContextRow) |
| `src/renderer/features/inbox/components/NotificationDrawer.tsx` | Right-side grouped approval drawer (replaces bell dropdown) |
| `src/renderer/features/inbox/components/DrawerApprovalCard.tsx` | Compact approval card inside notification drawer |
| `src/main/services/safety/stagedToolCallsService.ts` | Staged tool call queue for MCP side-effect tools |
| `src/main/services/safety/automationPendingItemsTracker.ts` | Coordinates staged items across all approval mechanisms for automation auto-restart |
| `src/main/services/safety/approvalReEvalService.ts` | Auto-resolves pending approvals after safety prompt updates |
| `src/renderer/features/agent-session/hooks/useToolApproval.ts` | React hook for approval state |
| `src/renderer/features/agent-session/utils/buildToolContinuationMessage.ts` | Shared continuation message builder (used by all approval surfaces) |

### IPC Channels

**Subscription (main → renderer):**
- `tool-safety:approval-request` — Sends deny-retry approval request with tool details
- `tool-safety:approval-resolved` — Approval auto-resolved (e.g., after Safety Rules update)
- `tool-safety:staged-call` — New staged MCP call created
- `tool-safety:staged-call-updated` — Staged call status changed (executing, executed, failed, rejected)

**Invoke (renderer → main):**
- `agent:tool-safety-response` — User's approval response (allow/deny)
- `tool-safety:pending` — Get all pending tool approvals
- `tool-safety:staged-get-all` — Get all staged MCP calls
- `tool-safety:staged-execute` — Execute a staged call
- `tool-safety:staged-execute-batch` — Batch-execute multiple staged calls
- `tool-safety:staged-reject` — Reject a staged call

See `src/shared/ipc/channels/safety.ts` for full schemas. Staged call statuses: `pending → executing → executed | failed | rejected | expired`.

### Persistence & Recovery

- **Pending approvals** persist across app restarts via `pendingApprovalsStore.ts`
- **`effectiveToolId`** is recovered from persisted data on restart
- **Cloud-pushed approvals** register local metadata before user response via `cloudEventChannel.ts`
- See `src/main/services/safety/__tests__/toolSafetyApprovalRecovery.test.ts` for recovery tests

### Types (Current)

```typescript
// Safety Prompt evaluation result (src/core/safetyPromptTypes.ts)
interface SafetyEvalResult {
  decision: 'allow' | 'block';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

// Legacy settings (deprecated — still in AppSettings for backwards compat, ignored by evaluation)
toolSafetyLevel?: ToolSafetyLevel;       // No longer drives evaluation
userSafetyInstructions?: string;           // Replaced by Safety Prompt store
```

## Performance

### Latency

| Operation | Expected Latency |
|-----------|------------------|
| Skip check / bypass branch | <1ms |
| Cache hit | <1ms |
| BTS evaluator API call | 200-500ms |
| Deterministic fallback (outage) | <5ms |
| Total overhead per evaluated tool | ~200-500ms (first call), <1ms (cached) |

### Caching

Results are cached by `buildCacheKey(promptVersion, toolName, toolInput, toolDescription)` — a SHA-256 hash. Concurrent evaluations for the same cache key share a single in-flight promise via `pendingEvals` map. Cache is invalidated when the Safety Prompt version changes.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| LLM API timeout/failure | Retry up to 3 times with exponential backoff (500ms × attempt) |
| All retries exhausted | **Fallback-model hop, then deterministic fallback**: retry on fallback model, then scan Safety Prompt for explicit block rules. Unmatched → `FAIL_CLOSED_RESULT` (block/low), routed through eval-error ASK/STAGE policies. |
| Parse error in LLM response | Retry (counts toward 3-retry limit). If all retries fail, deterministic fallback → fail-closed. |
| Abort signal during evaluation | Return allow (turn is already being cancelled — safe to allow since no execution happens) |
| No window for approval (headless) | Stage for MCP tools (including eval-error `blockedBy: 'eval_error'` paths); deny for non-MCP tools where no review path exists. |
| Continuation message fails | User can retry manually or dismiss |
| Principle update fails | Error surfaced to user — NOT silently treated as success (see commit `e47d541ee`) |

**Deterministic fallback details:** `deterministicRuleMatcher()` scans the Safety Prompt text for explicit block rules with definitive language ("must not", "is prohibited", "never allow", etc.) and matches them to the tool name. This is **block-only** — allow rules are never matched deterministically because word-part matching is too loose to safely approve. See commit `76e49fa97` and [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) for evaluator hardening details.

## Known Limitations

### Sub-agent Context

The tool use hook input does not include `agent_id` or `parent_tool_use_id`, so when a sub-agent triggers a tool that needs approval:
- The denial card cannot show which sub-agent requested the operation
- Approvals are scoped to `(sessionId, toolIdentifier)`, not per sub-agent

### Continuation Message Visibility

When user clicks "Allow this once", a continuation message is sent to trigger the retry. This message is visible in the conversation (e.g., "Approved. Please retry: Send email to alice@example.com"). This is intentional for transparency but may feel redundant to some users.

## Automation-Specific Behavior

When tool calls originate from automation sessions (headless runs), blocked actions follow a **staging-approval-restart** flow instead of the normal interactive deny-then-retry:

### MCP Tools (via Super-MCP)

Blocked MCP tool calls are **staged** via `stagedToolCallsService`:
1. The tool call is recorded as a staged call with `automationId` and `automationName` metadata
2. The hook returns `_rebel_staged` (allow) with an error result telling the agent the tool was staged for review
3. The agent continues its turn without blocking
4. User reviews the staged call in the NotificationDrawer (with an "Automation" badge) or ApprovalPointerBar

### Non-MCP Tools (Bash, etc.)

Blocked non-MCP tool calls use the existing **deny-then-retry** pattern:
1. The hook returns DENY with a message explaining the tool needs approval
2. A pending approval notification is sent to the renderer
3. User reviews in the standard approval card (with "Automation" badge if session starts with `automation-`)

### Coordination

Both staging paths register items with `automationPendingItemsTracker`, which coordinates resolution callbacks for auto-restart. See [AUTOMATIONS.md](AUTOMATIONS.md) for the full access rules and staging approval lifecycle.

**Implementation:** `handleAutomationSafetyPromptBlock()` in `src/main/services/toolSafetyService.ts` handles the routing decision based on whether the tool is an MCP `use_tool` call.

## Memory Write Safety

Memory write operations (Edit, Create to memory spaces) have a separate approval flow with destination visibility. This shares the same safety infrastructure but has its own safety configuration stored locally.

**See [MEMORY_SAFETY.md](MEMORY_SAFETY.md)** for full documentation including:
- Safety level configuration (per-space, stored locally)
- Safety floor for shared spaces (sensitive content always prompts)
- Private mode behavior
- Approval flow details
- Known concerns and edge cases
