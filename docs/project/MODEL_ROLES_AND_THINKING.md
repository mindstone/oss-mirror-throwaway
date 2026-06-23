---
description: "The four user-facing model roles (Working / Thinking / Background / Recovery), how they map to storage, defaults, and runtime resolvers, plus the two distinct 'thinking' axes (plan-mode split vs reasoning effort)."
last_updated: "2026-06-07"
---

# Model Roles and the Two "Thinking" Axes

Rebel lets a user assign a model to each of four **roles**. This doc captures the role abstraction, the (deliberately asymmetric) way each role is stored, the resolvers that turn storage into a runtime model, and — the part that trips people up — the **two completely different things "thinking" means** in this codebase.

Code is the source of truth for *how*; this doc is the map of *what maps to what* and *why*.

## The four roles

The user-facing role set is `RoleId` in `src/shared/types/modelChoice.ts` (`'working' | 'thinking' | 'background' | 'recovery'`), with display strings in `ROLE_LABELS` and per-role option support in `roleSupports()`. Every consumer reasons about the `ModelChoice` discriminated union (`model` / `profile` / `inherit` / `auto` / `off`) rather than raw storage fields — see the file header for the rationale and `docs/plans/260509_centralize_model_role_selection.md` for the centralisation decision.

| UI role (`RoleId`) | Storage field(s) | Empty-storage default | UI/health resolver | Runtime `ModelRole` |
|---|---|---|---|---|
| **Working** | `workingProfileId` OR `model` (falls back to `localModel.activeProfileId`) | provider default (`getDefaultModelForProvider`) | `resolveRoleAssignment` | `working` |
| **Thinking** | `thinkingProfileId` OR `thinkingModel` | none (`off`/inherit semantics) | `resolveRoleAssignment` | `thinking` |
| **Background** (a.k.a. BTS) | single prefix-encoded `behindTheScenesModel` string | `DEFAULT_AUXILIARY_MODEL` | `resolveRoleAssignment` | **`fast`** |
| **Recovery** | `longContextFallbackProfileId` OR `longContextFallbackModel` | `auto` | `resolveRoleAssignment` | **none** |

### CRUCIAL: the runtime role set is NOT the UI role set

The runtime `ModelRole` enum (`MODEL_ROLES` in `src/core/rebelCore/modelRoleResolver.ts`) is **`thinking` / `working` / `fast`** — only three, and the names don't all line up with the UI:

- UI **Background** == runtime **`fast`**. The "Background"/BTS role is what the runtime calls `fast` (subagents, summarisation, safety checks).
- UI **Recovery** has **no runtime `ModelRole`** — it is a documented **UI-only carve-out**: `roleToRuntimeRole('recovery')` in `roleAssignment.ts` returns `null`, so Recovery is *not* routed through the shared precedence core. It is the long-context fallback, resolved in the recovery pipeline rather than `modelRoleResolver.ts`. Because it sits outside the shared core, Recovery's row gets its own scoped inline warning + **"Pick fallback"** CTA (added in commit `293173fdc`) beneath the secondary-fallback picker on the Main-work row — a lighter hierarchy than a primary-row alarm, with copy derived from the recovery assignment's status via an exhaustive switch (it handles the new `profile-unavailable-model-active` status). The CTA focuses the recovery picker, not the model-role wizard. See `RoleRow.tsx` and `AgentsTab.tsx`.

### Resolvers (with different contracts) — but one shared precedence core

The UI resolver and the runtime resolver used to recompute role health **independently**, which let the Settings UI disagree with what the agent actually runs. As of the centralize-model-role-selection series (commit `50b9727a9`) the resolution *precedence* — usable profile → bare model-string → typed failure — is extracted into **`resolveModelRolePrecedence({effectiveModelId, failureReason})`** in `modelRoleResolver.ts`, consumed by **both** sides. UI role health therefore **cannot drift from runtime by construction** for the runtime-covered roles (working / thinking / background→fast).

- `src/core/rebelCore/roleAssignment.ts:resolveRoleAssignment` — **UI-facing.** Still surfaces choice-level health (missing profile, incomplete, disconnected, off, auto), but for runtime-covered roles it now derives the *effective model* from `resolveModelRolePrecedence` (the runtime core) and then decorates that outcome with UI-only states — rather than recomputing precedence itself. `resolveAllRoleAssignments` does all four in one pass; this is the canonical resolver that the conversation-override panel and quality-tier matching now route through (see MODEL_SETTINGS_RESOLUTION).
- `src/core/rebelCore/modelRoleResolver.ts:resolveDefaultModelForRole` / `resolveFastRole` — **strict runtime.** Resolves `thinking` / `working` / `fast` with **no provider-default injection**; returns a typed `RoleResolutionFailure` rather than guessing. (`resolveFastRole` has one narrow legacy fallback to `DEFAULT_AUXILIARY_MODEL` when *no* BTS setting exists at all — see its inline comment.) `resolveModelRolePrecedence` wraps the same internal `resolveRoleResolution` used here, so the two share the precedence by construction.
- `src/shared/utils/btsModelResolver.ts:resolveBtsModel` — per-category BTS resolution (`safety`, etc.) layered on top of the Background setting.

#### Two contradictions killed by construction

The shared core removes two long-standing UI-vs-runtime contradictions:

1. **Deleted role profile.** The UI no longer falsely shows "Using default model for now" when the chosen profile is gone — runtime would actually *throw* (`role-key-references-unknown-profile`), so the UI now routes its copy through `summarizeRoleResolutionFailureReason` and tells the user to pick another model.
2. **Disabled-but-model-stringed profile.** A profile that is disabled/incomplete but still carries a usable model string is no longer flagged "needs setup" — runtime runs it fine. The UI now shows a new **informational** status `profile-unavailable-model-active` ("Using `<model>` for now" / "Review profile") — not a flat `ok`, so the stale profile is still nudged, but the row no longer claims the role is broken when the agent runs it. `effectiveModelId` for this case reflects the runtime model, so the Smart-Picking toolbar, Model Team section, and quality-tier matching all agree with runtime.

A cross-resolver parity test (`roleAssignment.test.ts`) locks UI == runtime over the divergence fixtures.

## Storage asymmetry (and why it's fenced)

Working / Thinking / Recovery use **dual fields** on the `models` namespace: a `*ProfileId` *or* a bare model-id field. Background is different — it uses a **single prefix-encoded string** `behindTheScenesModel` (`model:<id>` / `profile:<id>` / bare). The encoding lives in `src/shared/utils/modelChoiceCodec.ts` (`PROFILE_PREFIX`, `MODEL_PREFIX`, `decodeRoleChoice`, `encodeRoleChoice`, `normalizeStoredBtsModelValue`); that file's header documents the per-role encoding table.

The codec discipline (normalise on read, never let a `profile:<id>` value leak onto the model wire, reject `model:profile:...` collisions) is not incidental — it is the fix for a real incident. See `docs-private/postmortems/260529_bts_model_choice_storage_prefix_wire_leak_postmortem.md` for the WHY: a prefix-encoded value escaped to the API and broke BTS calls.

## The two "thinking" axes — contrasted

These are independent and frequently conflated. Keep them separate.

### Axis 1 — plan-mode model SPLIT (a *different model* for planning vs execution)

When a distinct Thinking model exists, the agent runs planning on one model and execution on another. The mechanism (all in `src/shared/utils/modelNormalization.ts`):

- `resolveModelConfig` emits the synthetic alias `PLAN_MODE_ALIAS` plus env overrides `ENV_THINKING_MODEL` (`PLANNING_MODEL`) and `ENV_EXECUTION_MODEL` (`EXECUTION_MODEL`).
- At runtime, `src/core/rebelCore/planningMode.ts:resolveRuntimeModels` decodes that alias + env overrides back into the concrete planning and execution model ids.

#### What triggers split mode (typed plan-mode target, not a sentinel)

As of v0.4.46 (the routing-SSOT series; trigger refactor in commit `ac972b417`) plan mode is requested by an explicit **typed target**, not by a model-string sentinel. `resolveModelConfig(requestedModel, planMode, …)` keys split mode off `planMode !== null`, where `planMode` is a `PlanModeTarget | null` — see `resolveModelConfig`'s plan-mode branch in `modelNormalization.ts`. The single authority that produces it is `resolvePlanModeTarget()` (same file): it resolves the **real** thinking model (never a synthetic Claude id) via `resolvePlanningThinkingModel`, collapses to `null` when the thinking model is absent or equals the working model (single-model mode), and otherwise brands the thinking model into a `PlanModeTarget` carrying a typed `RoutingModelId`. Producers that already hold a concrete model string (the auth-failure fallback, a bare thinking setting) enter through the same gate via `planModeTargetFromThinkingModel`.

The invariant: **the only way into plan mode is a typed/branded `PlanModeTarget`, not a model-string sentinel.** Because the target carries a branded `RoutingModelId` decoded from a real role resolution, a synthetic string such as `PREFERRED_PLANNING_MODEL` can no longer reach `resolveModelConfig` positionally to *trigger* split mode and masquerade as a thinking model the active provider cannot serve. This is the class-kill for the old `provider_route_plan_missing_axis` failure mode (a Claude planning id leaking for Codex/OpenRouter users). The constraint is lint-enforced — see the `planningSentinel` fixtures under `src/core/services/turnPipeline/__lint_fixtures__/`.

`PREFERRED_PLANNING_MODEL` / `FALLBACK_PLANNING_MODEL` still exist in `modelNormalization.ts`, but only as model-id *values* — **never** as a *trigger* for split mode. Their surviving value uses:

- **Planner auth-failure fallback** — `agentTurnExecute.ts`, the thinking-profile `'unavailable'` branch (`reason: 'thinking-profile-auth-failure'`): falls the planner back to `PREFERRED_PLANNING_MODEL`.
- **1M-context downgrade** — `modelNormalization.ts:downgradeThinkingModelConfig`: detects `PREFERRED_PLANNING_MODEL` (plan-mode thinking model or direct model) and downgrades it to `FALLBACK_PLANNING_MODEL`, preserving the `[1m]` suffix only when the fallback supports extended context.
- **Council / Opus model value** — used where the council lead / quality path names Opus directly.
- **Settings / default thinking-seed value** — `settingsStore/index.ts` seeds the default `claude.model` with `PREFERRED_PLANNING_MODEL`.
- **Hero-choice fallback** — `heroChoiceService.ts:resolveHeroChoiceModel` falls back to `PREFERRED_PLANNING_MODEL` at the end of its cascade.

Treat both as owned by `modelNormalization.ts`; do not hardcode their model-id values elsewhere.

### Axis 2 — reasoning EFFORT (same model, harder thinking)

`thinkingEffort` (`ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh'`, defined in `src/shared/types/settings.ts`) tunes how much the chosen model reasons, with per-model overrides via `modelEfforts`. Resolved by `modelNormalization.ts:getModelEffort` (per-model override first, then the global `thinkingEffort`). A per-turn `thinkingEffortOverride` exists in `src/shared/types/agent.ts`.

A model can be in split plan-mode *and* at high effort, or neither, independently.

## Council is orthogonal

Council Mode is **not** one of the four roles — it is a parallel multi-model fan-out + synthesis feature layered on top. See [MULTI_MODEL_COUNCIL_MODE](./MULTI_MODEL_COUNCIL_MODE.md).

## See also

- [ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK](./ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md) — the automatic fallbacks; per-role *configured* fallback lives in `src/core/rebelCore/configuredRoleFallback.ts` (`decodeRoleFallback`, `ConfiguredFallbackRole` = working/thinking/background) which the resolvers here feed into.
- [MODEL_CONSTANTS](./MODEL_CONSTANTS.md) — canonical home for default-model and effort constants; cite symbols (e.g. `PREFERRED_PLANNING_MODEL`, `DEFAULT_AUXILIARY_MODEL`) rather than hardcoding ids.
- [MULTI_MODEL_COUNCIL_MODE](./MULTI_MODEL_COUNCIL_MODE.md) — the orthogonal multi-model path.
- `src/shared/utils/modelChoiceCodec.ts` — the canonical encode/decode for every role's storage; its header has the per-role encoding table.
- `docs-private/postmortems/260529_bts_model_choice_storage_prefix_wire_leak_postmortem.md` — the incident that motivates the BTS codec discipline.
- `docs/plans/260509_centralize_model_role_selection.md` — why `ModelChoice` exists and replaced the ad-hoc per-surface resolvers.
- `docs/plans/260606_centralize-model-role-selection/PLAN.md` and `docs/plans/260606_role-resolution-chokepoint/PLAN.md` — the staged work that extracted `resolveModelRolePrecedence` (the shared UI/runtime core), added the recovery inline CTA, and routed conversation overrides + quality tiers through `resolveAllRoleAssignments`.
