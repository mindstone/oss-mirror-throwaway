---
description: "Memory safety architecture — per-space write policy, Safety Prompt evaluation, staged writes, approvals, and conflict handling"
last_updated: "2026-05-27"
---

# Memory Safety

Rebel's memory safety system controls when the agent can automatically save content to memory spaces versus when it must ask for user approval. The architecture is designed to be simple, secure, and predictable.

## See Also

- [PRIVACY_MODE.md](PRIVACY_MODE.md) - Privacy Mode (forces `cautious` memory safety for sensitive sessions)
- [SCRATCHPAD.md](SCRATCHPAD.md) - Quick-capture notes with LLM-assisted organization into memory spaces
- [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) - Safety system overview (tool safety, memory safety, evals)
- [TOOL_SAFETY.md](TOOL_SAFETY.md) - Tool safety (sibling system)
- [SPACES.md](SPACES.md) - Spaces architecture (where memories are stored)
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - Settings reference
- `src/main/services/safety/memoryWriteHook.ts` - Core implementation
- `rebel-system/prompts/safety/eval-system.md` - Safety Prompt evaluation template
- `docs/tutorials/260129a_memory_safety_staged_writes.html` - Developer tutorial with architecture walkthrough

## Architecture Overview

```
Memory Write Request
    │
    ▼
PreToolUse Hook (memoryWriteHook) fires
    │
    ├── Already approved for this file in session?
    │   └── Yes → Allow immediately
    │
    ├── Private Mode active?
    │   └── Yes → Force cautious
    │
    ├── Unknown path (not in any space)?
    │   └── Yes → Force cautious
    │
    ├── Chief-of-Staff space?
    │   └── Yes → Allow immediately (always permissive)
    │
    └── Check per-space safety level
            │
            ├── Permissive → Structural secret gate → Allow (or Stage if credentials detected)
            ├── Balanced → Safety Prompt Evaluation → Allow or Stage/Ask
            └── Cautious → Stage or Ask
                          │
                          ├── Staged (default): File staged for later review
                          │   └── User reviews in Inbox → Publish or Discard
                          │
                          └── Blocking (non-heredoc Bash writes): Show approval card
                              └── User clicks "Allow once" → Store approval, retry
```

**Safety Prompt integration (balanced mode):** Balanced mode uses Safety Prompt evaluation to decide whether a memory write is safe. If the Safety Prompt allows the write with sufficient confidence, it is auto-approved with reason `safety_prompt_allowed`. If blocked, the write is staged for user review with `blockedBy: 'safety_prompt'`, enabling the "Allow & choose rule update..." button. If the Safety Prompt evaluation fails (LLM error/timeout), the write stages with `blockedBy: 'eval_error'` (fail-closed). Migration gating: evaluations are blocked until `migrationComplete` flag is set in the Safety Prompt store. This applies to all write tools including Bash.

**Block sources** (`blockedBy` field in approval requests):
| Source | Meaning |
|--------|---------|
| `safety_prompt` | Safety Prompt evaluation returned `block` |
| `eval_error` | Safety Prompt evaluation failed (LLM error, parse failure) — fail-closed |
| `structural_policy` | Structural credential detector matched (regex-based) |

Both `safety_prompt` and `eval_error` blocks are automatically re-evaluated when the user updates their Safety Rules. See [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) for re-evaluation details.

**Source Capture CoS-only gate:** Source capture automation writes (`automationId === 'system-source-capture'`) are hard-denied from all non-Chief-of-Staff spaces **before** reaching the Safety Prompt evaluation. This is a deterministic code gate — no staging, no LLM backstop. Both file-write and Bash-write paths are gated. See [planning doc](../plans/260418_source_capture_chief_of_staff_only.md).

## Staged Writes (Default Behavior)

Memory writes use a **staging-first, non-blocking** model by default. When approval is required, content is staged to `Chief-of-Staff/memory/pending/` with YAML frontmatter indicating the intended destination. Legacy files from the old Electron userData staging system are automatically migrated to this location at app startup.

### Key Principle: Chief of Staff as Draft Space

- **Direct writes to Chief of Staff**: If agent intends to write to Chief of Staff, it writes directly to the appropriate location (no staging needed - CoS is always permissive)
- **Writes requiring approval**: If agent writes to another space that requires approval, the file is first written to `Chief-of-Staff/memory/pending/` with YAML frontmatter indicating the intended destination

### Staging Flow

```
Write Request to Space X (needs approval)
    │
    ▼
Write to Chief-of-Staff/memory/pending/ with frontmatter
(Chief of Staff is always permissive, so this always succeeds)
    │
    ▼
Return guidance: "Saved to Chief of Staff pending review"
    │
    ▼
Agent continues turn (no blocking)
    │
    ▼
User reviews in Inbox:
├── Allow → Move file to intended destination (publish)
├── Deny → Redirect to private space
└── Preview content via staged file preview dialog
```

### Pending File Format

Pending files are markdown with YAML frontmatter containing destination metadata:

```yaml
---
pending_destination: work/Acme/General/memory/topics/project-notes.md
staged_at: 2026-01-31T10:00:00Z
session_id: abc123
summary: Notes about the Acme project kickoff
original_space: Acme General
base_hash: a1b2c3d4e5f6...  # SHA-256 hash of destination at staging time, or 'new-file'
blocked_by: safety_prompt  # Policy source that blocked (safety_prompt | eval_error | structural_policy)
---

# Actual content here...
```

**File naming**: `{YYMMDD}_{HHmmss}_{sanitized-filename}.pending.md` (e.g., `260131_143052_project-notes.pending.md`)

The `base_hash` field is used for conflict detection when publishing—if the destination file has changed since staging, the user is prompted to resolve the conflict.

For same-session replacements (Edit #2 replacing Edit #1 for the same destination), `base_hash` is preserved from the original pending file instead of recomputed from disk. This keeps the first-stage snapshot as the conflict baseline, so external disk edits between staged writes still surface at publish time. Cross-session replacements for the same destination are refused with a `destination_locked` warning; one session cannot overwrite another session's pending file.

### Stickiness: pending writes block subsequent same-session writes

`checkExistingPendingPreflight` enforces a strict invariant: if session `S` already has a pending file for destination `D`, every subsequent write from `S` to `D` stages again, even if a fast path would otherwise auto-approve. This preflight runs before single-use approval consumption, inbox auto-approve checks, permissive auto-approve checks, shared-skill checkpoint auto-approve, and Bash shared-skill checkpoint auto-approve.

The reason is decision-branch integrity. If the user denies, disk must stay at the original pre-stage state. If the user approves, disk must reflect the cumulative staged content. Same-session writes therefore sticky-stage into one pending destination flow; cross-session writes to the same destination are denied with `FILE ALREADY PENDING REVIEW`.

`REBEL_MCP_SERVER_MODE=1` is the explicit exception: preflight still executes in dry-run mode for auditability, but stickiness is bypassed and a `[SECURITY]` warning is logged. Sticky restaging also re-runs credential checks on new content. If credentials are detected (or Bash content is non-inspectable), restaging is forced to `blocked_by: structural_policy` with the fixed safe summary `Possible credentials detected — review before saving`; new credential-bearing content is never sent through `summarizeContent()`. See `src/main/services/safety/memoryWriteHook.ts` (`checkExistingPendingPreflight`) and `src/main/services/safety/cosPendingService.ts` (`writeToPending` session/destination invariants).

### Where Staged Content Lives

Pending files live in `Chief-of-Staff/memory/pending/`. This means:
- **Visible in Finder**: Users can see pending content without opening the app
- **Syncs across devices**: If Chief of Staff backs to cloud storage
- **No data loss on rejection**: If user chooses "Keep" instead of "Publish", content stays in pending folder
- **Searchable**: Pending content is included in semantic search

See `src/main/services/safety/cosPendingService.ts` for implementation details.

**Auto-resolution after Safety Rules update:** When the user updates their Safety Rules, pending memory approval requests that were blocked by `safety_prompt` **or** `eval_error` are automatically re-evaluated. Approvals that now pass are silently auto-resolved and a continuation is sent to the original session. See `src/main/services/safety/approvalReEvalService.ts` and [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md).

### Why This Approach?

- **No data loss**: Rejected content stays in Chief of Staff (user's private space)
- **Transparency**: Real files visible in filesystem, not hidden in app storage
- **Cross-device**: Syncs via whatever backs Chief of Staff (iCloud, Dropbox, etc.)
- **Agent awareness**: Agent can reference pending files in follow-up turns
- **Non-blocking**: Agent doesn't wait for approval

### Blocking Fallback

The blocking approval flow is used in specific cases:

- **Bash writes**: Command output can't be reliably previewed/staged
- **Staging disabled**: Set `REBEL_DISABLE_STAGED_WRITES=1` for debugging
- **Staging failure**: If writing to pending folder fails, falls back to blocking approval

Additional blocking fallback triggers:
- **Edit `old_str` not found** — cannot reconstruct full content for preview
- **File unreadable** during edit staging — IO error prevents content reconstruction
- **Non-heredoc Bash writes** — opaque content (piped/redirected) cannot be extracted for staging

The blocking flow uses `pendingApprovalsStore.ts` and shows an approval card via the `NotificationDrawer`.

## Safety Levels

Each space has one safety level, stored locally in app settings:

| Level | UI Label | Behavior |
|-------|----------|----------|
| `permissive` | Save without asking | Auto-approve all writes. Only available for private spaces. |
| `balanced` | Ask, if content is sensitive | Evaluate sensitivity; prompt only for high-risk content. |
| `cautious` | Always ask before saving | Prompt for every write. |

### Per-Space Settings

Safety levels are stored in `AppSettings.spaceSafetyLevels`:

```typescript
spaceSafetyLevels: {
  'work/Acme/General': 'balanced',
  'work/Acme/Exec': 'cautious',
  'personal/journal': 'permissive'
}
```

**Note:** Chief-of-Staff is not stored in `spaceSafetyLevels` because it's hardcoded to `permissive` in the resolution function. This prevents misconfiguration.

## Intent & Design Rationale

**Problem:** Private spaces defaulted to `balanced` (LLM eval per write), but the safety prompt already said "private writes are allowed" — creating friction for no benefit. For non-technical users, "my private space" implies "my notes save without drama."

**Approach:** Permissive default for private spaces + structural secret gate. Normal content auto-saves; credentials get caught by fast regex scan and staged for approval. Best of both worlds.

**Rejected:** (1) Just changing default without secret gate — user explicitly wanted credential protection. (2) LLM-based detection — must be fast, deterministic, no network calls. (3) New secretDetection.ts module — over-engineering; existing logRedaction.ts has the patterns.

**Constraints future agents must preserve:** (1) The secret gate goes DIRECTLY to staging, never through Safety Prompt (would override detection). (2) Never send detected-secret content to `summarizeContent()` (leaks to LLM). (3) `sharing === undefined` (legacy) stays `balanced`. (4) Non-inspectable Bash writes fail closed in permissive mode.

## Key Design Decisions

### 1. Chief-of-Staff is Always Permissive

Chief-of-Staff is the user's private router space. It is **always** `permissive` (auto-save) with no exceptions and no user setting needed. This is hardcoded in the resolution function.

Detection uses `space.type === 'chief-of-staff'` from `SpaceInfo`, verified against the local `settings.spaces` configuration (not README frontmatter) for security.

### 2. No Direct Writes to Pending

Direct writes to `memory/pending/` paths by the agent are blocked—staging is managed exclusively by the memory write hook. This ensures all staged content has proper frontmatter and goes through the approval flow.

### 3. Safety Floor for Shared Spaces

Shared spaces enforce a minimum floor of `balanced`. Even if a user sets a shared space to `permissive` in settings, the system treats it as `balanced` to prevent accidental exposure of sensitive content.

**Why?** Users might accidentally set a shared space to "Save without asking" not realizing others can access it. The floor protects against misconfiguration.

Private spaces can be `permissive` if the user chooses—they're the user's own data.

### 4. Defaults and Migration

- **Private spaces** default to `permissive` (auto-save) — matches the safety prompt ("private writes are allowed") and the `memorySafetyPrivate` type intent
- **Shared/restricted/company-wide/public spaces** default to `balanced`
- **Legacy spaces** (no `sharing` in frontmatter, `sharing === undefined`) default to `balanced` (conservative — we can't assume they're private)
- **Chief-of-Staff** is always `permissive` (hardcoded)
- **Unknown paths** (not in any configured space) default to `cautious`
- **Existing spaces** with explicit `spaceSafetyLevels` entries keep their settings (no migration)

**Structural secret gate (applies to ALL permissive writes):** Even in permissive mode, a regex-based credential detector scans content before auto-saving. If credentials are detected (API keys, passwords, PEM keys, bearer tokens, connection strings), the write is staged for user approval instead of auto-saving. This gate:
- Goes directly to staging — bypasses Safety Prompt evaluation and LLM summarization (to avoid leaking detected secrets)
- Runs on Chief-of-Staff too (it's also permissive)
- Fails closed for non-inspectable content (e.g., non-heredoc Bash writes)
- Uses `blockedBy: 'structural_policy'` in the approval request
- Is best-effort structural detection — encoded/obfuscated secrets may pass through

### 5. Safety Settings Are Local Only

Safety settings are **never** read from shared files (e.g., README.md frontmatter). This is a security boundary—shared files could be modified by malicious collaborators.

The legacy `memoryTrust` frontmatter field was deprecated and removed. See the Security section below.

## Resolution Function

The resolution logic is in `resolveMemorySafetyLevel()`. It returns `{ level: SafetyLevel, hasSpaceOverride: boolean }`:

```typescript
function resolveMemorySafetyLevel(
  spacePath: string | null,
  sharing: 'private' | 'restricted' | 'company-wide' | 'public' | undefined,
  settings: AppSettings,
  privateMode: boolean
): { level: SafetyLevel; hasSpaceOverride: boolean } {
  // 1. Private Mode forces cautious
  if (privateMode) return { level: 'cautious', hasSpaceOverride: false };
  
  // 2. Unknown path → cautious
  if (!spacePath) return { level: 'cautious', hasSpaceOverride: false };
  
  // 3. Chief-of-Staff → always permissive (verified from settings)
  if (isVerifiedChiefOfStaff(spacePath, settings)) return { level: 'permissive', hasSpaceOverride: false };
  
  // 4. Per-space setting or default (private → 'permissive', others → 'balanced')
  // Invalid/corrupted values (null, wrong type) fail closed to 'cautious'
  const rawLevel = settings.spaceSafetyLevels?.[spacePath];
  const hasOverride = spacePath in (settings.spaceSafetyLevels ?? {});
  const isValid = typeof rawLevel === 'string' && ['permissive', 'balanced', 'cautious'].includes(rawLevel);
  const defaultLevel = (sharing === 'private') ? 'permissive' : 'balanced';
  const spaceLevel = isValid ? rawLevel : (hasOverride ? 'cautious' : defaultLevel);
  
  // 5. Safety floor: shared spaces (or undefined sharing) must be at least 'balanced'
  const isPrivate = sharing === 'private';
  const effectiveLevel = (!isPrivate && spaceLevel === 'permissive') ? 'balanced' : spaceLevel;
  
  return { level: effectiveLevel, hasSpaceOverride: hasOverride };
}
```

### Stale Entry Cleanup

When spaces are deleted, their `spaceSafetyLevels` entries are automatically cleaned up during settings normalization. This prevents accumulation of dead entries.

## User Interface

### Settings UI

The Settings > Safety tab shows a simple per-space list:

- **Chief-of-Staff**: Shows "Save without asking" with a lock icon (not editable)
- **Other spaces**: Dropdown to select safety level

For shared spaces, the "Save without asking" option is hidden since the backend enforces `balanced` minimum.

### Approval Surfaces

Memory write approvals appear in multiple UI surfaces:

| Surface | Component | Scope |
|---------|-----------|-------|
| **Conversation footer** | `ApprovalPointerBar` → opens `NotificationDrawer` | Current session |
| **Notification Drawer** | `DrawerApprovalCard` | All sessions (grouped by conversation) |
| **Library (`Show: Memory`)** | `PendingMemorySection` via `usePendingMemoryApprovals` | Cross-session pending approvals |
| **Inbox** | `UnifiedApprovalCard` | All pending items |
| **Automation panel** | `useAutomationApprovals` | Automation-triggered approvals |

### Approval Actions

**Blocking memory approvals** (deny-retry flow):

| Action | Behavior |
|--------|----------|
| **Allow once** | Stores single-use approval, sends system continuation telling agent to retry the write |
| **Allow & choose rule update...** | Allow + opens scope dialog to update Safety Rules (only for `safety_prompt` blocks) |
| **Deny** | Sends "don't retry" continuation, agent stops attempting the write |
| **Preview** | Opens `MemoryPreviewDialog` showing content and destination |

**Staged file approvals** (non-blocking, content in CoS pending):

| Action | Behavior |
|--------|----------|
| **Allow** (Publish) | Moves file from pending to intended destination |
| **Deny** (Keep private) | Redirects to private memory (content preserved) |
| **Allow & choose rule update...** | Publish + update Safety Rules (for `safety_prompt` blocks) |
| **Preview** | Opens `StagedFilePreviewDialog` with diff view, conflict resolution, and revision instructions |

**Approval resolution semantics:** Approving a blocking memory write does NOT perform the write directly. Instead: (1) a single-use approval is stored via `handleMemoryWriteApprovalResponse()`, (2) a system continuation message is sent to the agent telling it to retry, (3) on retry, the write hits the single-use approval check and is auto-allowed. Denial sends a "don't retry" continuation via `buildContinuationMessage()`. See `src/renderer/utils/saveMemoryApproval.ts`.

### Shared Skill Checkpoint

When a non-author writes to a shared skill file, a special memory approval is created:
- `approvalKind: 'shared_skill_checkpoint'`
- Special preview labels: "Confirm shared skill update", "Keep shared skill unchanged"
- Special continuation messages referencing the skill context
- See `memoryWriteHook.ts` (lines ~1117-1176) and `MemoryPreviewDialog.tsx`

### Staged File Advanced Features

The staged file preview dialog (`StagedFilePreviewDialog.tsx`) supports:
- **Diff view** for file updates (shows what changed)
- **Conflict detection** via `base_hash` — if the destination changed since staging, prompts for resolution
- **Conflict resolution** — user chooses "keep staged" or "keep real" version
- **Revision instructions** — user can send instructions to the originating session to modify content before publishing
- **"Allow & choose rule update..."** for `safety_prompt` blocks — publish and update Safety Rules in one action

## Private Mode

Private Mode is a per-session toggle that forces `cautious` behavior regardless of space settings. All memory writes require approval.

Enable via the interaction strip (privacy toggle next to the input).

## Automation-Specific Behavior

When memory writes originate from automation sessions, blocked writes follow a **staging** flow that integrates with the automation pending items tracker:

1. `stageAutomationMemoryWriteBlock()` in `memoryWriteHook.ts` writes the content to CoS pending (same as interactive staging)
2. The item is registered with `automationPendingItemsTracker` for coordination
3. The hook returns deny-without-continue (agent is told the write was staged for review, no retry)
4. User reviews the pending file in the Inbox or NotificationDrawer
5. On approval/rejection, `resolveItem()` is called in the relevant memory handler (`memoryHandlers.ts`)
6. When all items are resolved, the tracker fires a callback that triggers auto-restart of the automation

This avoids blocking the automation run while ensuring the user reviews and approves memory writes before they're published. Approved writes also trigger access rules expansion so future runs can write to the same destinations without re-staging.

**Known limitation — restart recovery:** The `automationPendingItemsTracker` rebuild after restart only restores **staged-tool** items; memory pending items are not yet restored (tracked as a TODO in `automationPendingItemsTracker.ts`). Memory approval coordination is fully reliable within the same runtime, but may lose tracking across app restarts.

See [AUTOMATIONS.md](AUTOMATIONS.md) for the full access rules and staging approval lifecycle.

## Bash Write Special-Casing

Bash writes to non-`private` balanced spaces are evaluated via Safety Prompt on the **command string** (not the actual file content, which is opaque for most Bash writes). This enables the "Allow & choose rule update..." button in the approval UI, giving users a path to create permanent safety rules for recurring Bash write patterns.

**Content extraction limitations:**
- **Heredoc Bash writes** (e.g., `cat > file.md << 'EOF' ... EOF`): Full content can be extracted and staged for preview.
- **Opaque Bash writes** (e.g., `curl ... > file.md`, `echo $VAR > file.md`): Content cannot be extracted. Safety Prompt evaluates the command string only. If blocked, these fall back to blocking approval (no staging/preview).

**Trade-off:** Evaluating the command string is less accurate than evaluating actual file content, but it enables rule updates and provides meaningful context (file paths, tool names, command intent). The Safety Prompt requires high-confidence allows for Bash (via `NEVER_TRUST_SUBSTRINGS` in `toolVerbs.ts`), so medium-confidence allows are rejected.

**Exceptions (unchanged):**
- **Chief-of-Staff / permissive spaces:** Auto-approved unless the structural secret gate detects credentials (in which case, staged for user review).
- **Private spaces:** Already excluded from special handling.
- **Private mode / unknown paths:** Resolved to `cautious` level by `resolveMemorySafetyLevel()`, which skips Safety Prompt evaluation entirely (always prompts).

### Multi-Target Bash Writes

When a Bash command writes to multiple files (e.g., `for f in *.md; do echo "text" >> $f; done`), the system selects the **most restrictive** space among all targets for evaluation. Unknown sharing levels (`undefined`) are treated as `public` (most restrictive).

## Security

### Why Safety Settings Are Local Only

The previous architecture allowed `memoryTrust` in README.md frontmatter to override safety settings. This was a security vulnerability:

**Problem:** A malicious collaborator could set `memoryTrust: always_write` in a shared README.md file, causing everyone syncing that folder to auto-save potentially sensitive content.

**Solution:** Safety settings are now stored **locally only** in `AppSettings.spaceSafetyLevels`. Shared files can provide metadata (description, sharing level) but never control security behavior.

### Chief-of-Staff Verification

The system verifies Chief-of-Staff status against the local `settings.spaces` configuration, not README frontmatter. This prevents a malicious space from setting `space_type: chief-of-staff` in their README to bypass safety controls.

### Migration

On app startup, the system migrated from the legacy tiered architecture:
1. Existing local preferences were preserved as baseline
2. Only `always_ask` from README.md was honored (made things stricter)
3. `always_write` and `balanced` from README.md were ignored
4. `memoryTrust` field was removed from README.md files for cleanliness

## Key Files

| File | Purpose |
|------|---------|
| `src/main/services/safety/memoryWriteHook.ts` | PreToolUse hook and resolution logic |
| `src/main/services/safety/cosPendingService.ts` | CoS pending folder management (write, publish, discard, keep-private, migrate) |
| `src/main/services/safety/stagedReadHook.ts` | Returns pending content when agent re-reads a staged file |
| `src/main/services/safety/hashUtils.ts` | Shared hash functions (`hashContent`, `hashFile`) for conflict detection |
| `src/main/services/safety/legacyStagingReader.ts` | Legacy staging reader for migration (deprecated, safe to remove after v1.5) |
| `src/main/services/safety/sessionApprovals.ts` | Session-scoped approval storage |
| `src/main/services/safety/pendingApprovalsStore.ts` | Persistent pending approvals (blocking flow) |
| `src/main/ipc/memoryHandlers.ts` | IPC handlers for all `memory:staging-*` channels |
| `src/shared/utils/settingsUtils.ts` | Settings migration (`migrateToSpaceSafetyLevels`) |
| `src/renderer/features/settings/components/tabs/SafetyTab.tsx` | Safety settings UI |
| `src/renderer/features/inbox/hooks/useStagedFiles.ts` | Staged files state management in renderer |
| `src/renderer/features/inbox/components/StagedFilePreviewDialog.tsx` | Preview/publish/discard/keep-private UI for staged files |
| `src/renderer/features/agent-session/components/ApprovalPointerBar.tsx` | Per-conversation approval pointer (opens NotificationDrawer for staged file review) |
| `src/renderer/features/inbox/components/NotificationDrawer.tsx` | Right-side grouped approval drawer with staged file management |
| `src/renderer/components/approval/primitives/` | Shared approval UI primitives (SharingBadge, WhySection, etc.) |
| `src/renderer/utils/saveMemoryApproval.ts` | Memory approval continuation (supports queue-aware callback injection) |

## IPC Channels

**Subscription (main → renderer):**
- `memory:write-approval-request` - Sends approval request with destination details (blocking flow)
- `memory:write-approval-resolved` - Approval completed (blocking flow)
- `memory:staged-files-changed` - Notifies renderer when staging area changes
- `memory:file-staged` - Notifies when a new file is staged (includes metadata)

**Invoke (renderer → main):**
- `memory:write-approval-response` - User's approval response (blocking flow)
- `memory:get-pending-approvals` - Retrieve persisted pending approvals (blocking flow)
- `memory:staging-get-all` - List all staged files
- `memory:staging-get-content` - Retrieve staged file content for preview
- `memory:staging-publish` - Publish a staged file to its destination
- `memory:staging-discard` - Discard a staged file
- `memory:staging-keep-private` - Move staged file to CoS memory/topics
- `memory:staging-publish-all` - Batch publish all staged files
- `memory:staging-discard-all` - Batch discard all staged files
- `memory:staging-mint-conflict-capability` - Mint a short-lived, one-time-use capability token authorizing a single conflict resolution. Required by the resolve channel below.
- `memory:staging-resolve-conflict` - Resolve conflict (`keep-staged` or `keep-real`). **Requires a capability token from the mint channel above** — see [APPROVAL_SYSTEM.md § Conflict-resolution capability tokens](APPROVAL_SYSTEM.md) for the Stage B security rationale.

## Deprecated (Removed)

The following are no longer used:

- **`memoryTrust` frontmatter field** - Removed from README.md files; ignored if present
- **`spaceSafetyOverrides`** - Replaced by `spaceSafetyLevels`
- **`memorySafetyBySharing`** - Per-sharing-level defaults removed
- **`memorySafetyPrivate` / `memorySafetyShared`** - Base tier defaults removed
- **3-tier resolution system** - Replaced by simple per-space lookup
- **`resolveMemorySafetyLevelLegacy()`** - Legacy resolution function removed; only the simplified `resolveMemorySafetyLevel()` is used

The legacy settings fields may still exist in user settings for historical reasons but are completely ignored by the current resolution logic.
