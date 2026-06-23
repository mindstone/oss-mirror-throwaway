---
description: "Privacy Mode behaviour and implementation — memory/tool safety overrides, approval semantics, UI copy, key files"
last_updated: "2026-05-15"
---

# Privacy Mode

Privacy Mode is a per-session toggle that gives users extra control over how Rebel handles sensitive conversations. When enabled, Rebel prompts for approval before writing to memory spaces.

## See Also

- [MEMORY_SAFETY.md](MEMORY_SAFETY.md) - Memory write approval system (Privacy Mode forces `cautious` level)
- [TOOL_SAFETY.md](TOOL_SAFETY.md) - Tool safety evaluation system
- [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) - Safety system overview
- `src/renderer/features/composer/SessionSettingsMenu.tsx` - UI toggle component
- `src/main/services/safety/memoryWriteHook.ts` - Memory hook that respects private mode

## Planning References

- [251222_unified_safety_configuration.md](../plans/finished/251222_unified_safety_configuration.md) - Original design spec defining Privacy Mode as a session preset with `cautious` for both tool safety and memory safety
- [251226_privacy_mode_override_trusted_tools.md](../plans/finished/251226_privacy_mode_override_trusted_tools.md) - Privacy Mode overriding trusted tools and session approvals

## Current Behavior

| Area | Without Privacy Mode | With Privacy Mode |
|------|---------------------|-------------------|
| **Memory writes** | Uses per-space safety setting | Forces `cautious` (always ask before saving) |
| **Tool safety** | Uses global setting (permissive/balanced/cautious) | Forces `cautious` (always ask) |
| **Trusted tools** | Auto-allowed without prompting | **Prompts even for trusted tools** |
| **Session approvals** | Auto-allowed if approved earlier in session | **Prompts again even if approved earlier** |

### How It Works

1. User toggles Privacy Mode via the lock icon in the interaction strip
2. The `privateMode` flag is passed through the agent turn request
3. For memory writes: `memoryWriteHook.ts` forces `effectiveSafetyLevel = 'cautious'`
4. For tool safety: `agentTurnExecutor.ts` forces `effectiveToolSafetyLevel = 'cautious'`
5. For trusted tools: `toolSafetyService.ts` skips the trusted tools bypass when `privateMode` is true
6. For session approvals: `toolSafetyService.ts` skips the session pre-approval bypass when `privateMode` is true

### Single-Use Approvals Still Work

Single-use approvals (from "Allow once" / "Allow & Retry") are **not** blocked by Privacy Mode. This is intentional:
- When a tool is blocked and user clicks "Allow & Retry", a single-use approval is stored
- On retry, this approval is consumed to allow the action
- Without this, Privacy Mode would create an infinite deny loop

### UI Adaptation in Privacy Mode

When Privacy Mode is enabled, the tool approval menu only shows **"Allow once"** (renamed from "Allow & Retry"). The following options are hidden:
- "Allow for session" - would store session approval but get skipped on retry anyway
- "Always trust this tool" - contradicts Privacy Mode's "ask every time" intent

This ensures users only see options that actually work in Privacy Mode.

### User-Facing Copy

- **Toast** (first enable): "Private mode enabled. I'll ask before writing or taking any actions."
- **Tooltip** (on): "Private mode ON — will ask before writing or taking actions"
- **Tooltip** (off): "Private mode OFF — normal safety settings apply"

## Key Files

| File | Purpose |
|------|---------|
| `src/renderer/features/composer/SessionSettingsMenu.tsx` | UI toggle with toast/tooltip copy |
| `src/main/services/agentTurnExecutor.ts` | Forces `cautious` tool safety when private mode enabled |
| `src/main/services/toolSafetyService.ts` | Skips trusted tools and session pre-approvals when private mode enabled |
| `src/main/services/safety/memoryWriteHook.ts` | Forces `cautious` for memory writes |
| `src/main/services/agentTurnRegistry.ts` | Stores private mode state per-turn |
| `src/main/services/memoryUpdateService.ts` | Propagates private mode to memory update turns |
