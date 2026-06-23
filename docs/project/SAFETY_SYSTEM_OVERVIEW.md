---
description: "Safety system overview: tool safety, inbound author policy, memory safety, bash commands, automation access, Safety Rules, and activity logging"
last_updated: "2026-06-02"
---

# Safety System

Rebel's safety system protects users from unintended actions while keeping the agent non-blocking. It covers tool calls, inbound author admission, memory writes, bash commands, and automation access — all configurable through user-editable Safety Rules (the "Safety Prompt").

This document is the single entry point for understanding and testing the safety system end-to-end.

## See Also

- [APPROVAL_SYSTEM.md](APPROVAL_SYSTEM.md) — Approval architecture: shared hooks/types, derivation pipeline, anti-injection seed prompts, cross-surface wiring
- [CONVERSATION_APPROVAL_TYPES.md](CONVERSATION_APPROVAL_TYPES.md) — User-facing approval-type tutorial (what each approval looks like)
- [TOOL_SAFETY.md](TOOL_SAFETY.md) — Deep dive: tool safety evaluation, skip lists, approval flow
- [INBOUND_AUTHOR_POLICY_RUNBOOK.md](INBOUND_AUTHOR_POLICY_RUNBOOK.md) — Slack inbound author policy operations: drop taxonomy, recovery playbooks, and known limits
- [MEMORY_SAFETY.md](MEMORY_SAFETY.md) — Deep dive: memory write safety, staging, per-space levels
- [MARKDOWN_URL_GUARD.md](MARKDOWN_URL_GUARD.md) — Deep dive: the markdown URL-scheme XSS trust boundary — shared scheme-safety SSOT, twin-guard + new-surface rules, and the CI ledger gate
- [WRITING_EVALS.md](WRITING_EVALS.md) — Central eval reference: quick start, shared infrastructure, CLI flags, CI integration
- [SAFETY_PROMPT_EVALS.md](SAFETY_PROMPT_EVALS.md) — Detailed safety eval: suites, fixtures, baselines, how to add fixtures
- [AUTOMATIONS.md](AUTOMATIONS.md) — Automation access rules, staging, auto-restart lifecycle
- [PRIVACY_MODE.md](PRIVACY_MODE.md) — Per-session privacy toggle
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — Full settings reference
- [for-customers/SECURITY_AND_ARCHITECTURE_WHITEPAPER.md](for-customers/SECURITY_AND_ARCHITECTURE_WHITEPAPER.md) — Customer-facing security whitepaper
- [../../super-mcp/docs/SECURITY_HARDENING.md](../../super-mcp/docs/SECURITY_HARDENING.md) — Super-MCP security hardening

---

## How the Safety System Works

Every action Rebel takes — tool calls, memory writes, bash commands — goes through a safety evaluation pipeline before execution. The system is **non-blocking**: denied actions are staged for later execution (MCP tools) or shown as approval cards (non-MCP tools) rather than halting the agent.

### Core Flow

```
Action → Skip Check → Safety Prompt Evaluation → Confidence Gate → Allow / Stage / Deny-Retry
```

1. **Skip check**: Read-only and known-safe operations bypass evaluation entirely (see "What Skips Evaluation" below)
2. **Safety Prompt evaluation**: `evaluateSafetyPrompt()` sends the action context + user's Safety Rules to the BTS evaluator model via `SafetyEvaluationService`, which returns `{ decision: 'allow' | 'block', confidence: 'high' | 'medium' | 'low', reason }`
3. **Confidence gate**: `shouldAllow()` applies a confidence threshold based on whether the tool is side-effecting:
   - **Side-effect tools** (verbs: send, create, delete, post, write, update, etc.) → require `high` confidence to auto-allow
   - **Non-side-effect tools** → `medium` or `high` confidence is sufficient
   - Any `block` decision or `low` confidence → always denied
4. **Outcome**: Allowed actions execute immediately. Denied MCP tools are **staged** for later execution. Denied non-MCP tools get a **deny-then-retry** approval card.

**Key files:**
- `src/core/safetyEvaluationService.ts` — Platform-agnostic `SafetyEvaluationService` boundary interface for LLM safety calls. Main/cloud implementations provide the actual LLM wiring.
- `src/core/safetyPromptLogic.ts` — All evaluation, decision, principle generation, and consolidation logic
- `src/core/safetyPromptTypes.ts` — Type definitions: `SafetyEvalResult`, `ActionContext`, `PrincipleOption`, `PrincipleUpdate`, `PrincipleDirection`
- `src/core/safetyPromptStore.ts` — Versioned Safety Prompt persistence, history, revert, reset, migration gating

### The Discourse Incident (v0.4.16)

The side-effect confidence gate was added after a bug where the LLM returned `allow/medium` for a Discourse forum post. The old logic accepted medium confidence for all tools, causing an unintended public post. The fix: side-effect tools now require `high` confidence. The eval harness now tests this gate explicitly with 15 pipeline-annotated fixtures.

---

## Safety Subsystems

### 1. Tool Safety

MCP tool calls are evaluated before execution via the `PreToolUse` hook in `createToolSafetyHook()`.

**Key files:**
- `src/main/services/toolSafetyService.ts` — Main service: skip lists, approval handling, all runtime branches
- `src/core/safetyPromptLogic.ts` — `evaluateSafetyPrompt()`, `shouldAllow()`, principle generation
- `src/core/services/safety/toolVerbs.ts` — Side-effect verb detection, read-only classification

**What skips evaluation:**
- Internal tools: `Read`, `Grep`, `Glob`, `Task*`, `Todo*`, `AskUserQuestion`, `TaskOutput`, `SearchFiles`
- MCP infrastructure: `list_tool_packages`, `list_tools`, `get_tool_details`, `search_tools`, `health_check`, `get_help`
- Safety tools: `rebel_safety_prompt_get`, `rebel_safety_prompt_update`
- Deterministically read-only MCP tools: verbs like `list`, `get`, `search`, `read`, `fetch` (via `isDeterministicallyReadOnly()`)
- Automation-only bypass: `WebSearch` (in `AUTOMATION_SAFE_BUILTIN_TOOLS`)

**Note on restored builtin tools**: `SearchFiles` is in `SKIP_TOOL_NAMES` (deterministically read-only, no exfiltration risk). `WebSearch` is in `AUTOMATION_SAFE_BUILTIN_TOOLS` (auto-allowed in automation sessions). `WebFetch` is intentionally NOT auto-allowed — URL fetching carries exfiltration risk and goes through standard LLM safety evaluation. `WebFetch` may still be auto-allowed via the `isDeterministicallyReadOnly()` pre-evaluation gate (the `fetch` verb is classified as read-only).

**MCP tool unwrapping:** Tools routed through `mcp__super-mcp-router__use_tool` are unwrapped to their inner `tool_id` via `getEffectiveToolIdentifier()` before evaluation. Alias resolution maps package-specific tool names to canonical IDs.

**Canonical tool identity contract:** `getEffectiveToolIdentifier()` returns a **bare tool name** (e.g. `query-run`), never a compound `packageId/toolId` form. All code that compares tool identities — trusted-tool lookups, approval matching, safety evaluations — must use this bare form. Use `bareToolId()` from `src/shared/utils/trustedToolNormalization.ts` to normalize. See postmortem `docs-private/postmortems/260330_always_allow_staged_mcp_bug_postmortem.md` for the format-mismatch bug this contract prevents.

**Runtime branches (evaluation order):**

| Branch | Condition | Behavior |
|--------|-----------|----------|
| **Rebel-internal MCP** | `packageId` in `INTERNAL_MCP_SERVER_NAMES` | Always allow — internal app tools |
| **Admin-disabled** | Tool in org `disabledConnectorTools` | Hard block — no approval card, cannot be overridden |
| **Agent framework** | Tool in `SKIP_TOOL_NAMES` | Always allow — read-only/orchestration |
| **Automation circuit breaker** | ≥10 safety blocks in session | Hard stop — prevents runaway automation |
| **Windows Python guard** | Python command on Windows | Block if resolves to MS Store alias |
| **MCP server mode** | `REBEL_MCP_SERVER_MODE=1` | Auto-approve all (audit logged) |
| **Trusted tools** | In user's trusted list (non-private mode) | Auto-allow (except consent-required tools) |
| **Single-use approval** | Previously approved this turn/session | Consume and allow |
| **Cross-turn pending** | Same tool pending approval in another turn | Block to prevent races |
| **Read-only skip** | `shouldSkipEvaluation()` / `isDeterministicallyReadOnly()` | Allow without LLM call |
| **Safety Prompt eval** | All remaining tools | LLM evaluation → allow / stage / deny |

**Consent-required tools:** Some tools (e.g. calendar mutations) always require explicit per-use approval even if trusted or if the evaluator returns `allow/high`. This forces staging regardless. See `isConsentRequiredTool()` in `src/core/services/safety/toolVerbs.ts`.

**Approval flow (interactive sessions):**
- **Staged MCP calls**: Denied MCP tools are staged via `stageToolCall()`. The agent sees `_rebel_staged = true` and continues working. The user reviews and approves staged calls at their convenience — approved calls are executed server-side.
- **Deny-then-retry (non-MCP)**: Denied non-MCP tools (Bash, TextEditor) emit `tool-safety:approval-request` and show approval cards. On approval, a single-use approval is stored and a continuation message triggers the agent to retry.
- **Trust Always**: Permanent bypass stored in `settings.trustedTools` — visible and removable in Settings > Safety > Permissions.

**Session-type variations:**
- **Automation sessions** (`automation-*`): Same Safety Prompt evaluation, but blocks use `handleAutomationSafetyPromptBlock()` for staging/deny. Circuit breaker at 10 blocks.
- **Role sessions** (`role-*`): Trust-level-aware gating. `supervised` = force-stage all external tools. `trusted`/`autonomous` = Safety Prompt evaluation. Circuit breaker at 10 blocks.
- **Inbound Slack** (`inbound-*`): Auto-approves `reply_to_slack_thread` and `post_slack_message` before Safety Prompt eval — user opted in via @-mention.

**Public broadcast safety (inbound-trigger replies):**
Inbound sessions that reply back to public broadcast surfaces run an additional content-sensitivity gate before posting. This is no longer Slack-specific wiring: `src/main/services/inboundTriggers/publicBroadcastSafetyHook.ts` resolves outbound replies through the per-connector registry in `src/core/services/safety/outboundBroadcastGates/`. Each connector gate owns the broadcast tool IDs, reply-content extraction, and prompt descriptors; adding a new public surface should register a gate there and provide fail-closed descriptors rather than branching inside the hook.

The external prompt was renamed from `safety/public-channel.md` to `safety/public-broadcast.md`. The renamed prompt adds surface descriptors — `SURFACE_KIND`, `INBOUND_TRIGGER_DESCRIPTION`, and `AUDIENCE_VISIBILITY_STATEMENT` — so the same evaluator can describe Slack channels, Discord channels, GitHub issues, mailing lists, and future public surfaces accurately. The general safety evaluator now includes up to 4,000 characters of the user's request instead of 500, which keeps later authorizations visible on long multi-step asks and reduces false approval prompts.

See [TOOL_SAFETY.md](TOOL_SAFETY.md) for full details.

### 2. Memory Write Safety

File writes to memory spaces go through destination-aware safety checks.

**Key files:**
- `src/main/services/safety/memoryWriteHook.ts` — Main hook
- `src/main/services/safety/pendingApprovalsStore.ts` — Persistent staging

**Flow:**
```
Memory Write → Space Safety Level → Safety Prompt Evaluation → Stage / Allow
```

- **Staged writes (default):** Instead of blocking, writes to non-permissive spaces are drafted as physical files in `Chief-of-Staff/memory/pending/` with YAML routing frontmatter. Users review in the Inbox to "Publish" or "Discard".
- **Per-space safety levels:** Each space has its own level (`permissive`, `balanced`, `cautious`), configurable in Settings > Safety > Permissions.
- **Private default + structural secret gate:** Private spaces now default to `permissive`, but `memoryWriteHook.ts` still checks for structural credential patterns first. If a write looks like it contains credentials, it is staged for approval with `blockedBy: structural_policy` instead of auto-saving.
- **Shared space floor:** Non-private spaces enforce at least `balanced`, regardless of user setting.
- **Safety Prompt integration:** In balanced mode, the Safety Prompt evaluation decides whether a write is safe. If allowed with sufficient confidence, it's auto-approved with reason `safety_prompt_allowed`. If blocked, it's staged for review with `blockedBy: safety_prompt`.
- **User-intent context parity (with the tool-safety path):** The memory-write evaluator's `ActionContext` carries the same authorizing user-intent context the normal tool-safety path already supplies — `userMessage` (the turn prompt) and `sessionIntent` (recent user messages, resolved against `originalSessionId`). Both render through the shared `buildEvalUserMessage` fences (`fenceUserMessage`/`fenceSessionIntent`), so the evaluator can recognize when the user explicitly requested a shared-space write and stop over-staging it. Wired once in `src/core/services/turnPipeline/agentTurnExecute.ts` (covers desktop + cloud main turns); background memory-update turns are system-initiated and intentionally omit it. **Security invariant (do not weaken): intent _informs_ the evaluator, it never _authorizes_ a write.** `evaluateSafetyPrompt`, `shouldAllow`, the credential gate, and the per-space confidence floor are unchanged — sensitive content (credentials/PII/HR) still blocks even when the user "asked for" the write. `userIntentExplicit` (a salience hint) is intentionally deferred. Two other memory `ActionContext` builders — `approvalReEvalService.ts` (Safety-Rules-update re-evaluation) and `transcriptSensitivityGuard.ts` (system-initiated) — stay intent-light by design (no in-turn user request to attach). See [planning doc](../plans/260529_memory_write_intent_context_parity.md) and the over-asking diagnostic [`260525_approval_overasking_diagnostic.md`](../plans/260525_approval_overasking_diagnostic.md).
- **Approval copy stays human-readable:** Approval surfaces translate credential detector labels into plain-language descriptions via `packages/shared/src/credentialLabels.ts` (canonical location; `src/renderer/utils/credentialLabels.ts (path removed — verify)` is a back-compat re-export) so users see phrases like "what looks like an API key" instead of internal enum names.
- **Conflict detection:** If the destination file changes after staging, the user sees a diff and can resolve.
- **Source Capture CoS-only gate (deterministic):** Source capture automation writes (`automationId === 'system-source-capture'`) are blocked deterministically from **all** non-Chief-of-Staff spaces — hard deny, no staging, no Safety Prompt evaluation. This is a belt-and-suspenders security gate: the prompt layer (AUTOMATION.md/SKILL.md) directs source capture to CoS-only, and the code gate in `memoryWriteHook.ts` enforces it as a fail-closed backstop. Both file-write and Bash-write paths are gated identically. Gate errors also fail closed. Non-source-capture automations (e.g. wins-learnings) are unaffected and continue through the existing balanced/cautious path. See [planning doc](../plans/260418_source_capture_chief_of_staff_only.md) and incident [REBEL-1A9 postmortem](../../docs-private/postmortems/260409_source_capture_sensitive_meeting_routing_postmortem.md). Approval cards for source capture files use humanised copy (e.g. "Share Q3 Review meeting notes with your General space?") via `extractSourceMetadata.ts` + `humanizeApprovalText.ts`.

See [MEMORY_SAFETY.md](MEMORY_SAFETY.md) for full details.

### 3. Bash Command Safety

Bash/shell commands get special handling before standard tool evaluation.

**Key file:** `src/main/services/toolSafetyService.ts` — `isBashCommandSafeToSkip()`

- **Read-only pipelines auto-skip:** Chains where every segment is a known read-only command (e.g., `cat file | head -5`) bypass evaluation.
- **Dangerous pattern blocking:** Operators like `rm -rf`, `>` (redirect/overwrite), `sudo`, and dangerous flags on `find` (`-delete`, `-exec`) are caught.
- **Heredoc safety:** Only the header (before `<<`) is checked for dangerous patterns — data payloads don't trigger false positives.
- **Windows Python guard:** Blocks Python commands that would resolve to Microsoft Store aliases.
- **Bash file writes:** Writes to non-private balanced spaces via Bash are evaluated by Safety Prompt on the command string. Heredoc writes can be staged with full content; opaque writes (piped/redirected) fall back to blocking approval. Safety Prompt evaluation enables the "Allow & choose rule update..." button for Bash memory writes.

### 4. Inbound Author Policy (Slack inbound triggers)

Slack inbound triggers have a separate admission safety surface: unauthorized principals are silently dropped, self-loop echoes are suppressed through layered guards (metadata/bot/user fallbacks), per-principal bursts are rate-limited, and filtered context stays private via `digestFilteredCount` + renderer indicator. This sits alongside tool/memory/bash safety but runs in the inbound webhook path (`inboundAuthorGates`) rather than the tool-approval pipeline. Operational triage (logs, root causes, recovery) lives in [INBOUND_AUTHOR_POLICY_RUNBOOK.md](INBOUND_AUTHOR_POLICY_RUNBOOK.md).

### 5. Automation Access Rules

Headless automations are constrained by per-automation access rules — LLM-generated allowlists of permitted tools and memory destinations.

**Key files:**
- `src/core/safetyPromptLogic.ts` — LLM-based rule generation
- `src/core/safetyPromptLogic.ts` — Rule management and expansion
- `src/main/services/safety/automationPendingItemsTracker.ts` — Staging tracker

**Flow:**
- Out-of-scope actions are **staged for user approval** (not hard-denied)
- Approved actions automatically expand the access rules for future runs
- The automation auto-restarts after all staged items are resolved (max 3 retries)

See [AUTOMATIONS.md](AUTOMATIONS.md) for the full staging-approval-restart lifecycle.

### 6. Safety Rules (Safety Prompt)

User-editable natural-language principles that guide all safety decisions. Users write rules like "Never share customer data externally" in Settings > Safety > "Your Safety Rules".

**Key files:**
- `src/core/safetyPromptLogic.ts` — All evaluation and principle generation functions
- `src/core/safetyPromptTypes.ts` — `PrincipleDirection`, `PrincipleOption`, `PrincipleUpdate`, `SafetyEvalResult`, `ActionContext`
- `src/core/safetyPromptStore.ts` — Versioned persistence, history, revert, reset
- `src/shared/safetyPromptDefaults.ts` — Default Safety Prompt shipped with new installs
- `rebel-system/skills/safety/safety-guard/SKILL.md` — The evaluation prompt template

**How rules are used:**
- Injected into the LLM evaluation prompt for both tool safety and memory write safety
- The evaluator considers rules alongside action context to produce `allow/block` + confidence
- Core evaluation rules: explicit allow rules win, specificity wins over general rules, uncovered side-effect actions fail closed

**Principle management (allow direction):**
- `generatePrincipleOptions()` — Generates 3 scope-graduated option labels (`trusted_tool`, `broad`, `specific`) when an action is blocked
- `applySelectedPrinciple()` — Applies a user-selected principle to the safety prompt, with deduplication and conflict resolution
- `consolidateSafetyPrompt()` — Reorganizes and deduplicates the prompt

**Principle management (deny direction):**
- `generateDenyPrincipleOptions()` — Generates 3 scope-graduated deny/block option labels when a user wants to add a restriction after an action was allowed
- `applySelectedDenyPrinciple()` — Applies a user-selected deny principle to the safety prompt

Both directions support `PrincipleDirection: 'allow' | 'deny'` and use the same validation, patching, and supersession logic.

**Re-evaluation on update:** When the user updates their Safety Rules, pending approvals are automatically re-evaluated via `approvalReEvalService.ts`. See "Approval Re-evaluation" section below.

### Safety Prompt Lifecycle

The Safety Prompt is a versioned document stored in `safetyPromptStore.ts`:

| Feature | Implementation |
|---------|---------------|
| **Versioning** | Monotonically incrementing `version` counter, bumped on every update |
| **History** | Last 10 versions stored as `SafetyPromptHistoryEntry[]` for undo |
| **Revert** | `revertToVersion(targetVersion)` — restores a previous version (creates a new version entry) |
| **Reset** | `resetToDefaults()` — restores the factory-shipped default prompt |
| **Updater provenance** | `lastUpdatedBy: 'user' | 'system' | 'migration'` tracks who made each change |
| **Migration gating** | `migrationComplete` flag — evaluations are blocked (fail-closed) until migration completes |

The store uses the core `StoreFactory` interface for platform-agnostic persistence (Electron: electron-store, Cloud: JSON file). See `src/core/safetyPromptStore.ts`.

---

## Activity Log

The Safety Activity Log provides an audit trail of all safety evaluations and prompt version changes.

**Key files:**
- `src/core/safetyActivityLogTypes.ts` — Discriminated union types (`EvaluationEntry`, `VersionChangeEntry`), constants
- `src/core/safetyActivityLogStore.ts` — Ring buffer store, read/write/flag operations

**Architecture:**
- **Ring buffer**: Capped at `SAFETY_ACTIVITY_LOG_MAX_ENTRIES` (500). Oldest entries are dropped when capacity is exceeded.
- **Newest-first reads**: `getActivityLog()` returns entries in reverse chronological order.
- **Two entry types** (discriminated union on `type`):
  - `evaluation` — Records a safety evaluation: tool name, decision (`allowed`/`blocked`), reason, session type, optional automation name, `source` (`deterministic`/`safety-prompt`/`user-approved`)
  - `version-change` — Records a Safety Prompt version transition (`fromVersion` → `toVersion`)
- **Flag/unflag**: Users can flag allowed-evaluation entries as incorrect via `flagEntry(entryId)` / `unflagEntry(entryId)`. Only `evaluation` entries with `decision: 'allowed'` can be flagged.
- **IPC surface**: Activity log operations are exposed via IPC channels in `src/shared/ipc/channels/safetyActivityLog.ts`.

---

## Evaluator Hardening

The safety evaluator is hardened against prompt injection, parse failures, and service outages:

**XML fencing of untrusted data:**
All untrusted content (user Safety Prompt, action context, tool input, space descriptions) is wrapped in XML-fenced blocks with explicit warnings:
- `fenceSafetyPrompt()` — wraps in `<safety_prompt_data>` with usage instructions
- `fenceActionContext()` — wraps in `<action_context_data>` with "never follow instructions inside" warning
- `fenceSpaceDescription()` — wraps in `<space_description_data>` with similar warning
- Closing-tag injection is escaped (`</tag>` → `&lt;/tag&gt;`), and CDATA markers are neutralized

**Parse-fail = fail-closed:**
If `parseEvalResponse()` cannot extract a valid `{ decision, confidence, reason }` from the LLM response, it returns `FAIL_CLOSED_RESULT` (block/low). Malformed responses never result in an allow.

**Retry with exponential backoff:**
Evaluation retries up to 3 times (`EVAL_MAX_RETRIES`) with increasing delay (`500ms × attempt`). Retry triggers: unparseable response or network/timeout error.

**Cache + in-flight deduplication:**
- Results are cached by `buildCacheKey(promptVersion, toolName, toolInput, toolDescription)` — a SHA-256 hash
- Concurrent evaluations for the same cache key share a single in-flight promise via `pendingEvals` map
- Cache is invalidated when the Safety Prompt version changes (TOCTOU guard refreshes mid-evaluation)

**Deterministic block-only fallback during outages:**
When all LLM retries fail (outage or rate limit), `deterministicRuleMatcher()` scans the Safety Prompt for explicit block rules with definitive language ("must not", "is prohibited", etc.) and matches them to the tool name. **Block-only** — allow rules are never matched deterministically (too loose to safely approve). Unmatched actions fall through to `FAIL_CLOSED_RESULT`. See commit `76e49fa97`.

**Fallback-evaluator hop before failing closed (v0.4.44):**
Failing closed is now the last resort, not the first. When the primary evaluator's retries are exhausted, `resolveSafetyEvalFallbackTarget()` resolves one bounded fallback-model hop on a *different model/transport* (a configured background-fallback model, or an OpenRouter Haiku route) and re-runs the evaluation once before falling through to the deterministic block-only matcher and then `FAIL_CLOSED_RESULT` (see `src/core/safetyPromptLogic.ts`; commit `7f4ea4b90`). When that degraded route is taken, a user-visible "suggest a fallback model" degradation nudge surfaces (e.g. the API-cooldown toast pointing to *Settings → Agents & Voice*), so a degraded evaluator route is visible rather than the action being silently denied. Memory-write paths that still can't run a check fail closed by staging an `eval_error` for later review rather than silently dropping (commit `ec19f0526`).

**Infra-failure routing (fail-closed):**
When safety evaluation still fails closed after the fallback hop (`failClosed === true`), Rebel never auto-allows. Routing depends on session/human path policy in `failClosedPolicy`:
- Interactive with a human approval path: ASK with `blockedBy: 'eval_error'`, using honest copy from `src/shared/safety/evalErrorCopy.ts`
- Automation/no-human MCP paths: STAGE with `blockedBy: 'eval_error'` so it can be reviewed later
- Residual no-human non-MCP paths: deny with explicit "safety check couldn't run" copy (no fake policy-block framing)
- Cloud ingress metadata registration: still fail-closed drop for inbound approvals where `failClosed === true`

**Rate-limited fail-closed coalescing:**
For sustained `failClosedReason: 'rate-limited'` outages on MCP staging paths, the system coalesces to first-wins approval cards per cooldown window using a generation-aware key (`src/core/safetyEvalProcessIdentity.ts` + `apiRateLimitCooldown.currentGenerationId()`), preventing duplicate card floods during a single cooldown epoch.

**Suspicious pattern detection:**
`isSuspiciousUpdate()` scans generated principle updates for overly broad patterns ("allow all", "disable safety", "block all tools") and rejects them before they can be applied to the Safety Prompt.

---

## Approval Re-evaluation

When the user updates their Safety Rules, `approvalReEvalService.ts` automatically re-evaluates all pending approvals:

**What gets re-evaluated:**
1. **Tool approvals** — Pending deny-retry approvals (`getPendingApprovals()`)
2. **Staged MCP calls** — Staged calls blocked by Safety Rules (`reason.startsWith('Safety Rules blocked:')`)
3. **Memory approvals** — Pending memory writes blocked by `safety_prompt` or `eval_error`

**Behavior:**
- Re-evaluates each pending item against the new Safety Prompt version
- Auto-resolves items that now pass: stores single-use approval, removes from pending, broadcasts resolution
- **Staged MCP calls are auto-executed** — `executeStagedCall()` runs the tool server-side and sends the result
- **Session grouping** — Continuation messages are grouped by session to avoid flooding
- **Mid-run abort on version change** — If the Safety Prompt version changes again during re-evaluation, the run stops early to avoid stale decisions
- **`eval_error` memory approvals** are included — these may now resolve cleanly with the updated prompt

**Key file:** `src/main/services/safety/approvalReEvalService.ts`

---

## Approval Contract Invariants

These invariants are enforced across the approval system to prevent format-mismatch bugs:

1. **Bare trusted-tool IDs**: `getEffectiveToolIdentifier()` returns bare tool names (e.g., `query-run`), never compound `packageId/toolId`. All trusted-tool comparisons use `bareToolId()`. See postmortem `docs-private/postmortems/260330_always_allow_staged_mcp_bug_postmortem.md`.
2. **Canonical memory approval event shape**: Memory write approval responses use a consistent `{ toolUseId, originalSessionId, approved }` shape across interactive, automation, and re-eval paths. See `src/main/services/safety/memoryWriteHook.ts`.
3. **Approval-response cloud routing**: The `memory:write-approval-response` channel is cloud-routable. See `src/shared/cloudChannelPolicies.ts` for the single source of truth on cloud-routable IPC channels.

---

## User-Facing Controls

### Settings > Safety Tab

Five zones (see `src/renderer/features/settings/components/tabs/SafetyTab.tsx`):

1. **Your Safety Rules** — `SafetyPromptEditor` for custom natural-language instructions. Includes a "Chat with Rebel about your rules" button that opens a conversation to refine rules interactively.
2. **What Rebel can do without asking** — Three sub-groups:
   - *Tools*: Trusted tools list (always-allow bypass, removable)
   - *Files*: Remembered file approvals (always-save, removable)
   - *Memory Spaces*: Per-space safety level selector (`permissive` / `balanced` / `cautious`)
3. **Activity** — `SafetyActivityLog` showing actions evaluated against Safety Rules, with flag/unflag
4. **Built-in protections** — Collapsible list of read-only operation patterns that always skip evaluation
5. **Privacy & Data** — Privacy assurance cards (local-first, no AI training, privacy mode, etc.)

> **Note:** There is no tool-safety-level selector in the Safety Tab. Tool evaluation is controlled entirely by the Safety Prompt and trusted tools list.

### Safety Levels (Memory Spaces)

| Level | UI Label | Behavior |
|-------|----------|----------|
| `permissive` | Save without asking | Writes auto-allowed, except structural credential matches which stage for approval. Only available for private spaces. |
| `balanced` (default) | Ask, if content is sensitive | Safety Prompt evaluation decides. Allowed = auto-save. Blocked = staged for review. |
| `cautious` | Always ask before saving | All writes staged for approval. |

### Trust Hierarchy

```
Trusted Always → Session Approved → Single-Use Approved → Evaluate
```

### Privacy Mode

Per-session toggle that forces `cautious` behavior for all writes and disables trusted-tool auto-allow. Overrides all per-space settings. See [PRIVACY_MODE.md](PRIVACY_MODE.md).

---

## IPC & Persistence

Safety-related IPC channels and persistence stores:

| Surface | Key Files |
|---------|-----------|
| **Safety Prompt** IPC | `src/shared/ipc/channels/safetyPrompt.ts` — get, update, revert, reset, generate options, apply principle |
| **Safety Activity Log** IPC | `src/shared/ipc/channels/safetyActivityLog.ts` — get log, flag/unflag entries |
| **Tool Safety** IPC | `src/shared/ipc/channels/safety.ts` — approval request/response, staged call events |
| **Staged calls** | `src/main/services/safety/stagedToolCallsService.ts` — stage, execute, list, reject staged MCP calls |
| **Pending approvals** | `src/main/services/safety/pendingApprovalsStore.ts` — persistent storage for crash recovery |
| **IPC handlers** | `src/main/ipc/safetyHandlers.ts`, `safetyPromptHandlers.ts`, `safetyActivityLogHandlers.ts` |

Staged call statuses: `pending → executing → executed | failed | rejected | expired`

---

## Shared Safety Infrastructure

Components in `src/main/services/safety/`:

| Component | Purpose |
|-----------|---------|
| `types.ts` | Shared types: SafetyLevel, RiskLevel, SafetyDecision |
| `decisionMatrix.ts` | Maps risk levels to allow/deny/ask decisions |
| `sessionApprovals.ts` | In-memory single-use approval storage with domain isolation |
| `pendingApprovalsStore.ts` | Persistent storage for crash recovery |
| `automationPendingItemsTracker.ts` | Coordinates staged items for automation auto-restart |
| `approvalReEvalService.ts` | Auto-resolves pending approvals after Safety Rules updates |
| `accessRulesGenerator.ts` | LLM-based generation/expansion of automation access rules |
| `accessRulesManager.ts` | Orchestrates rule updates and cache management |

---

## Infrastructure Security

Beyond agent safety, Rebel implements defense-in-depth for application security:

### Electron Security

| Setting | Value | Notes |
|---------|-------|-------|
| `contextIsolation` | `true` | Renderer cannot access Node.js |
| `nodeIntegration` | `false` | Disabled in renderer |
| `sandbox` | `false` | *Planned for hardening* |

### Local Model Proxy

When using local models (LM Studio, Ollama), the translation proxy implements bearer token authentication, CORS allowlisting, DNS rebinding protection, and localhost-only binding. See `src/main/services/localModelProxyServer.ts`.

### OAuth Security

All OAuth integrations implement PKCE, state parameter CSRF protection, and `0o600` token file permissions.

### Audit Logging

Security-relevant events are logged with `[AUDIT]` or `[SECURITY]` prefix. Search logs to review: safety bypasses via `REBEL_MCP_SERVER_MODE`, memory write safety bypass, tool safety bypass.

### MCP Server Mode

When running as MCP server (`REBEL_MCP_SERVER_MODE=1`), tool and memory safety checks are bypassed (no UI for approval prompts). This is logged for audit purposes.

---

## Postmortem-Derived Rules

Key lessons from safety-related postmortems, distilled as rules:

1. **Side-effect tools require `high` confidence** — Medium confidence is insufficient for write operations. See the Discourse incident above.
2. **Bare tool IDs only** — All tool identity comparisons must use `bareToolId()`. Compound `packageId/toolId` forms cause silent bypass. See `docs-private/postmortems/260330_always_allow_staged_mcp_bug_postmortem.md`.
3. **Silent failure is a bug** — Principle updates that fail silently leave the user thinking they're protected when they're not. The `applySelectedPrinciple()` flow now surfaces all errors. See `docs-private/postmortems/260410_silent_principle_update_failure_postmortem.md` (commit `e47d541ee`).
4. **Deterministic fallback is block-only** — During outages, the fallback must never allow actions (word-part matching is too loose). See commit `76e49fa97`.
5. **Duplicate continuation deduplication** — Re-eval must group continuations by session to prevent flooding. See `approvalReEvalService.ts` `sendGroupedContinuations()`.
6. **Watchdog stream-activity gates fail closed on unknown provider events** — The level-1 watchdog Sentry-capture gate uses the closed-form predicate `shouldSuppressLevel1WatchdogCapture(activity)` over the typed `RuntimeActivityEvent` taxonomy; see [`src/main/services/watchdogTracker.ts`](../../src/main/services/watchdogTracker.ts). Unknown event types capture Sentry rather than silently suppressing (per prevention recommendation #5 in [`260427_rebel_1ad_watchdog_streaming_third_regression_postmortem.md`](../../docs-private/postmortems/260427_rebel_1ad_watchdog_streaming_third_regression_postmortem.md)); `unmapped_stream_event=true` is the operational signal to classify OpenAI Responses vocabulary drift in [`runtimeActivity.ts`](../../src/core/rebelCore/runtimeActivity.ts) within one beta cycle. The general form: for stall/observability gates over an open, provider-controlled activity-type space, **allow-list known idle states rather than deny-listing activity types** — fail closed on unknown event types, not open.
7. **BTS transports carry cross-cutting contracts** — maintain the transport/entry-point ledger enumerating each BTS-bound transport and entry point and the contracts each must satisfy (classified-error throwing, cooldown gating, JSON-capability runtime guard), so a new entry point can't silently skip one.

See `docs-private/postmortems/` for full postmortem details.

---

## Testing & Validation

### Quick Reference

```bash
# Full safety validation (unit tests + all LLM eval suites)
npx vitest run src/core/__tests__/safetyPromptLogic.test.ts && \
  npx tsx --tsconfig tsconfig.node.json evals/safety-prompt.ts --suite all

# Unit tests only (deterministic, no API key needed)
npx vitest run src/core/__tests__/safetyPromptLogic.test.ts

# Individual LLM eval suites (require ANTHROPIC_API_KEY)
npx tsx --tsconfig tsconfig.node.json evals/safety-prompt.ts --suite evaluation       # ~90 fixtures
npx tsx --tsconfig tsconfig.node.json evals/safety-prompt.ts --suite principle-update  # 51 fixtures
npx tsx --tsconfig tsconfig.node.json evals/safety-prompt.ts --suite principle-options # 51 fixtures
npx tsx --tsconfig tsconfig.node.json evals/safety-prompt.ts --suite consolidation    # 17 fixtures
```

> **Note:** Fixture counts change as new tests are added. Run the eval harness for current counts.

### What Each Suite Tests

| Suite | What it tests | Approx. Fixtures | Key metrics |
|-------|---------------|-------------------|-------------|
| **Unit tests** | `shouldAllow()` confidence gate logic (deterministic, mocked LLM) | 111+ | All must pass |
| **Evaluation** | `evaluateSafetyPrompt()` allow/block decisions + pipeline gate | ~90 | LLM accuracy, Pipeline accuracy |
| **Principle-update** | `applySelectedPrinciple()` round-trip | 51 | Round-trip, Safety preservation |
| **Principle-options** | `generatePrincipleOptions()` label quality | 51 | Format, Scope ordering, Clarity |
| **Consolidation** | `consolidateSafetyPrompt()` decision preservation | 17 | Preservation, Expected-block floor |

See [SAFETY_PROMPT_EVALS.md](SAFETY_PROMPT_EVALS.md) for detailed baselines, fixture schemas, and how to add new fixtures.

---

## Known Limitations

- OAuth tokens stored as plaintext JSON (migration to `safeStorage` planned)
- Chromium sandbox mode not yet enabled
- Verb-bypass gap: tool names using `new` (e.g., `discourse_new_topic`) aren't detected as side-effect verbs — flagged for production fix
- MCP alias resolution not exercised in eval harness (documented, no active mismatch)

See [Security Review Report](../plans/finished/260114_Security_Review_Report.md) for full audit findings.
