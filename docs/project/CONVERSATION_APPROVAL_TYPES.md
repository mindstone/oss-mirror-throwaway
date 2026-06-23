---
description: "Approval system types, UX flows, and actions in Rebel's conversation UI"
last_updated: "2026-04-12"
---

# Rebel Approval System: A Tutorial Guide

How the approval system works in Rebel's conversation UI, what each approval type means, when users encounter them, and what actions are available.

**See also**:
- [APPROVAL_SYSTEM.md](APPROVAL_SYSTEM.md) — internal developer architecture: shared hooks/types, derivation pipeline, anti-injection seed prompts, cross-surface wiring
- [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) — broader security and safety architecture
- `rebel-system/help-for-humans/security-and-tool-safety.md` — end-user-facing safety documentation

---

## How Approvals Work

Rebel uses a safety evaluation layer to protect users from risky or sensitive actions. Every time Rebel wants to perform an action that could have real-world consequences — sending an email, saving sensitive content, running a command — the system evaluates whether it's safe to proceed automatically or whether the user should decide.

When the system determines that an action needs human review, it creates an **approval request**. These appear as interactive cards above the input field in the conversation, giving the user full control over what Rebel can and cannot do.

### The Three Gates

Every action passes through up to three evaluation gates. If any gate flags the action, an approval is created:

| Gate | What It Checks | `blockedBy` value | Example |
|------|---------------|-------------------|---------|
| **Safety Rules** | User-defined rules evaluated by Safety Prompt LLM | `safety_prompt` | "Never send emails without my approval" |
| **Evaluation Error** | Safety Prompt evaluation failed (LLM error/timeout) — fail-closed | `eval_error` | Network timeout during evaluation |
| **Structural Policy** | Space config, credential detection, or consent-required tools | `structural_policy` | Shared space at `cautious`; detected API key |

If an action passes all three gates, it proceeds silently — the user never sees an approval card.

---

## Where Approvals Appear

Approvals surface in multiple places throughout the UI, anchored by the **ApprovalPointerBar** (per-conversation) and the **NotificationDrawer** (global).

### Per-Conversation: ApprovalPointerBar

The **ApprovalPointerBar** is a lightweight ~55 LOC bar in the conversation footer that shows a pending approval count and a "Review" button. Clicking "Review" opens the NotificationDrawer. It appears whenever there are pending approvals for the current conversation.

### Global: NotificationDrawer

The **NotificationDrawer** is a right-side overlay panel that aggregates all pending approvals across all conversations. Approvals are grouped by conversation with accordion sections, each containing **DrawerApprovalCard** components for individual approval actions (allow, deny, preview, etc.).

The drawer can be opened via:
- The "Review" button in **ApprovalPointerBar** (from within a conversation)
- The notification bell icon (from anywhere in the app)

When the drawer is closed and approvals are still pending, an **ApprovalNudgeToast** shows a persistent reminder.

### Other Approval Surfaces

Approvals also appear in:
- **Inbox** — the homepage inbox tab shows pending approvals and staged files
- **Automations panel** — shows approvals from automation-triggered actions (with "Automation" badge)
- **Library (`Show: Memory`)** — cross-session pending memory approvals via `usePendingMemoryApprovals` / `PendingMemorySection`
- **Actions review pill** — "X to review" pill in `InboxPanel` aggregating all pending items

### Approval Receipts

When an approval is resolved, a compact `isApprovalReceipt` message is injected into the conversation transcript (hidden from the main conversation flow). This provides an audit trail without cluttering the conversation. See `conversationReducer.ts`.

---

## Approval Type 1: Tool Approvals

### What Are They?

Tool approvals are the most common type. They appear when Rebel wants to use an external tool (via MCP connectors) to perform an action that the safety system deems risky.

### When Do Users See Them?

Whenever Rebel tries to:
- Send an email or message (Gmail, Slack, etc.)
- Run a system command
- Delete, create, or modify files
- Access external services
- Perform any action with real-world side effects

### How They Look

Each tool approval card shows:

- **Risk badge** — a coloured icon indicating risk level:
  - Green shield = low risk
  - Amber circle = medium risk
  - Red triangle = high risk
- **Source label** — the service name (e.g., "Gmail", "Slack", "System") or a friendly description of what Rebel is trying to do
- **Reason text** — a plain-language explanation of why this needs approval (e.g., "Wants to send an email to 5 recipients")
- **Automation badge** — shown when the action was triggered by an automation rather than a direct conversation
- **Conversation badge** — shown when the action comes from a specific named conversation

### What Can Users Do?

| Action | What Happens |
|--------|-------------|
| **Allow once** | The action proceeds this time. Rebel will ask again next time. |
| **Allow & choose rule update...** | The action proceeds AND a dialog opens to update safety rules so similar actions are handled differently in the future. Only available when Safety Rules triggered the block. Options: "All uses of this tool" / "Similar actions" / "Just this specific action" / "Other (custom)..." |
| **Always allow** | The tool is added to the trusted list and will never require approval again. Only available for tools the system considers safe enough for permanent trust. Shows a confirmation dialog before applying. |
| **Deny** | The action is rejected. Rebel is told it was denied and can adjust its approach. |
| **Details** | Expands a section showing the raw technical tool name and the exact parameters being sent. Useful for power users who want to inspect what's happening under the hood. |

When there are **2 or more** tool approvals at once, bulk actions appear: **Allow all** and **Deny all**.

### Blocking Behaviour

**Tool approvals are blocking.** The agent pauses and cannot continue its current train of thought until the user makes a decision. This is by design — the action could have irreversible consequences.

### Key Implementation Details

- **Type**: `ToolApprovalRequest`
- **Source file**: `src/renderer/features/agent-session/types.ts`
- **UI component**: `DrawerApprovalCard` inside `NotificationDrawer`
- **Data source**: Tool safety evaluation service (`src/main/services/toolSafetyService.ts`)

---

## Approval Type 2: Staged Tool Calls

### What Are They?

Staged tool calls are similar to tool approvals but with one important difference: they're **non-blocking**. The action has been queued for the user to review, but Rebel continues working on other things in the meantime.

### When Do Users See Them?

Most commonly when:
- An **automation** runs and triggers a tool call that needs approval
- A side-effect tool is staged rather than immediately executed
- Rebel queues up multiple actions as part of a larger workflow

### How They Look

Similar to tool approvals, with:
- **Risk badge** (same green/amber/red system)
- **Display name** — a user-friendly name for the queued action
- **Package label** — the service it belongs to
- **Automation badge** — when the action came from an automation
- **Error state** — if a previous execution attempt failed, the error message is shown in red
- **WHY section** — when the reason for requiring approval is specific and informative, it's displayed prominently

### What Can Users Do?

| Action | What Happens |
|--------|-------------|
| **Allow once** | Execute this specific queued action now |
| **Allow & choose rule update...** | Execute and update safety rules (only for Safety Rules blocks) |
| **Deny** | The queued action is discarded |

When there are **2 or more** staged tool calls, bulk actions appear: **Allow all [N]** and **Deny all**.

### Blocking Behaviour

**Staged tool calls are non-blocking.** Rebel continues working. The user can review and act on these at their convenience. This is the key difference from regular tool approvals.

### Key Implementation Details

- **Type**: `StagedToolCall`
- **Source file**: `src/renderer/features/agent-session/types.ts`
- **UI component**: `DrawerApprovalCard` inside `NotificationDrawer`
- **Status lifecycle**: `pending` → `executing` → `executed` / `failed` / `rejected` / `expired`

---

## Approval Type 3: Staged Files (Memory Write Approvals)

### What Are They?

Staged files represent content that Rebel wants to save to a memory space but that has been flagged as needing the user's review first. The content is held in a staging area (copy-on-stage) until the user decides what to do with it.

This covers all memory write operations: creating new documents, updating existing files, saving research, storing meeting notes — any time Rebel writes to a memory space and the write is flagged.

### When Do Users See Them?

When Rebel tries to save content to a memory space and one of the three gates flags it:
- The user's **Safety Rules** say "ask before saving to this type of space"
- The **sensitivity evaluation** detects potentially sensitive content (personal data, financial info, etc.)
- The target space has a **structural policy** that always requires confirmation (e.g., a shared space set to "always ask")

### How They Look

Each staged file card shows:
- **File icon**
- **File name** as the title
- **Action subtitle** — "Create in [Space Name]" for new files, "Update in [Space Name]" for modifications
- **Sharing badge** — indicates the space's sharing level (private, restricted, company-wide, public) when applicable
- **Summary preview** — a brief AI-generated summary of what the content contains

### What Can Users Do?

| Action | What Happens |
|--------|-------------|
| **Allow** | The file is published to the target memory space |
| **Deny** | The file is redirected to private memory instead — the content isn't lost, just kept private |
| **Allow & choose rule update...** | Save the file and update safety rules (only for Safety Rules blocks) |
| **Preview** | Opens a full preview dialog showing the content, with diff view for updates and conflict resolution if the file changed since staging |

**Single file shortcut**: When there's only one staged file, clicking the bar opens the preview dialog directly instead of expanding.

### Blocking Behaviour

**Staged files are non-blocking.** Rebel continues working. The content sits safely in the staging area until the user reviews it. No data is lost if the user takes their time.

### Key Implementation Details

- **Type**: `StagedFileItem`
- **Source file**: `src/renderer/features/inbox/hooks/useStagedFiles.ts`
- **UI component**: `DrawerApprovalCard` inside `NotificationDrawer`
- **Preview component**: `StagedFilePreviewDialog`

---

## Approval Type 4: Direct Memory Write Approvals

### What Are They?

Direct memory write approvals are the blocking counterpart to staged files. Where staged files let Rebel continue working while content waits in a staging area, direct memory approvals pause the agent until the user decides.

### Current Status

These appear in the **NotificationDrawer** (via `DrawerApprovalCard`) and the **Inbox** panel (via `UnifiedApprovalCard`).

### When Do Users See Them?

Same triggers as staged files — Safety Rules, sensitivity evaluation, or structural policy flagging a memory write — but through the blocking evaluation path rather than the staging path.

### What Can Users Do?

| Action | What Happens |
|--------|-------------|
| **Save** | The content is written to the target memory space |
| **Keep private** | The content is redirected to private memory |
| **Discard** | The write is skipped entirely — content is not saved anywhere |
| **Preview** | Opens a content preview dialog showing what would be saved |

### Memory Approval Subtypes

Direct memory approvals have an `approvalKind` field:

| Kind | When | Special Behavior |
|------|------|-----------------|
| `memory_write` | Standard memory write blocked | Normal approval flow |
| `shared_skill_checkpoint` | Non-author writes to a shared skill file | Special labels ("Confirm shared skill update"), author attribution, skill-aware continuation |

### Auto Re-evaluation

When the user updates their Safety Rules, pending memory approvals blocked by `safety_prompt` or `eval_error` are automatically re-evaluated. If the new rules allow the write, the approval is silently auto-resolved and a continuation is sent to the agent. See `src/main/services/safety/approvalReEvalService.ts`.

### Key Implementation Details

- **Type**: `MemoryWriteApprovalRequest`
- **Source file**: `src/renderer/features/agent-session/hooks/useMemoryApproval.ts`
- **UI component**: `DrawerApprovalCard` inside `NotificationDrawer`, `UnifiedApprovalCard` in Inbox
- **Block sources**: `'safety_prompt' | 'eval_error' | 'structural_policy'`
- **Approval resolution**: Approve stores single-use approval + sends system continuation for agent retry. Deny sends "don't retry" continuation. See `src/renderer/utils/saveMemoryApproval.ts`.

---

## Summary: All Four Approval Types at a Glance

| Type | Blocking? | Where It Appears | What Triggers It | Primary Actions |
|------|-----------|-----------------|-----------------|----------------|
| **Tool Approval** | Yes | NotificationDrawer (via ApprovalPointerBar) | MCP tool call flagged as risky | Allow once, Always allow, Deny |
| **Staged Tool Call** | No | NotificationDrawer (via ApprovalPointerBar) | Queued tool call from automation or workflow | Allow once, Deny |
| **Staged File** | No | NotificationDrawer (via ApprovalPointerBar) | Memory write flagged as high-sensitivity | Allow, Deny (→ private), Preview |
| **Direct Memory Write** | Yes | NotificationDrawer, Inbox | Memory write requiring immediate approval | Save, Keep private, Discard |

### Shared Actions Across Types

All approval types that are triggered by **Safety Rules** (the `safety_prompt` gate) also offer:
- **Allow & choose rule update...** — a dialog that lets the user update their safety rules to handle similar situations differently in the future, with options ranging from "always allow this specific action" to "allow all uses of this tool"

---

## How the NotificationDrawer Organises Approvals

The NotificationDrawer groups approvals by conversation using accordion sections. Each section header shows the conversation name and the count of pending approvals for that conversation. Expanding a section reveals individual `DrawerApprovalCard` entries.

Within each conversation group, approvals are ordered by urgency:

1. **Tool approvals** (blocking — most urgent, agent is waiting)
2. **Staged tool calls** (non-blocking but actionable)
3. **Staged files** (non-blocking, can be reviewed at leisure)

The **ApprovalPointerBar** in the conversation footer shows the total count of pending approvals and a "Review" button that opens the drawer, pre-focused on that conversation's section.

---

## Key Source Files

| File | Purpose |
|------|---------|
| `src/renderer/features/agent-session/components/ApprovalPointerBar.tsx` | Lightweight per-conversation bar with count + "Review" button |
| `src/renderer/features/inbox/components/NotificationDrawer.tsx` | Right-side overlay panel with grouped approval management |
| `src/renderer/features/inbox/components/DrawerApprovalCard.tsx` | Compact approval cards inside the drawer |
| `src/renderer/features/inbox/components/ApprovalNudgeToast.tsx` | Persistent toast when drawer is closed and approvals pending |
| `src/renderer/features/agent-session/components/SessionSurfaceContent.tsx` | Footer layout orchestration |
| `src/renderer/features/agent-session/types.ts` | `ToolApprovalRequest` type definition |
| `src/renderer/features/agent-session/hooks/useMemoryApproval.ts` | `MemoryWriteApprovalRequest` type + hook |
| `src/renderer/features/agent-session/hooks/useToolApproval.ts` | Tool approval state management |
| `src/renderer/features/inbox/hooks/usePendingApprovals.ts` | `PendingApprovalItem` unified type |
| `src/renderer/features/inbox/hooks/useStagedFiles.ts` | `StagedFileItem` type + hook |
| `src/renderer/features/inbox/components/DrawerApprovalCard.tsx` | Shared approval card for Inbox |
| `src/shared/ipc/channels/safety.ts` | IPC schemas for safety channel |
| `src/main/services/toolSafetyService.ts` | LLM-based tool safety evaluation |
| `src/main/services/safety/pendingApprovalsStore.ts` | Persisted approval requests |
