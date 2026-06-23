---
description: "How persisted AppSettings model/provider fields (the canonical models.* namespace, with the legacy claude.* block as an inert read-only bridge) become the runtime resolved model view — the per-field read-shadow rule for legacy installs, the renderer-safe pure twin, normalizeSettings, and the two divergent activeProvider reification paths."
last_updated: "2026-06-10"
---

# Model settings resolution

How the model/provider fields persisted in `AppSettings` become the *effective* model settings the runtime actually uses. This is the read path; for the write/migrate path see `normalizeSettings` below.

## The two namespaces, and why reads compose them per-field

The canonical, provider-neutral home for model fields is `settings.models` (`ModelSettings`). As of the **models-block cutover** (commit `470e92eae`, 260604 series) the runtime reads `models` as the source of truth: `normalizeSettings` writes only `models` and **no longer emits the legacy `claude` mirror**, so a post-cutover install has no `claude` block at all (the schema field is `claude?: ClaudeSettings` — `ClaudeSettingsSchema.optional()` — and the block is inert on write).

The legacy `claude` block survives only as a **read-only bridge for un-migrated installs**: an upgrade that still carries `claude.*` but no `models.*` must continue to resolve correctly until the next save migrates it forward. The single bridge is `materializeModelsFromLegacy` in `modelSettingsResolver.ts` — it composes the two namespaces **per field** (the rule below), and is the only place legacy `claude` is still read.

The per-field rule (do not deviate) — applies wherever a legacy `claude` block may still be present:

- For each canonical field `K`, prefer `models[K]` **when `models` has `K` as an own-property** — including when the user has deliberately cleared it to `null`. A `null` own-property is authoritative: the user cleared that slot, so it must win.
- Only when `models` lacks `K` as an own-property do we fall back to `claude[K]`.

**Whole-object fallback (`models ?? claude`) is forbidden.** It looks equivalent but is not: the moment `models` exists at all (e.g. the user set one field, or a `null` clear was written), the entire `claude` block is shadowed, silently resurrecting stale values for every *other* field. The per-field composition is the durable fix for that bug class — see the comment on `resolveEffectiveModelSettings` in `modelSettingsResolver.ts`, which calls this out explicitly. (Note: the read-shadow rule still matters because legacy installs persist `claude` until normalized; on a post-cutover install `claude` is absent and `materializeModelsFromLegacy` reads `models` alone.)

Canonical implementations:

- `src/shared/utils/modelSettingsResolver.ts` — `resolveModelSettings` (raw per-field compose), `resolveEffectiveModelSettings` (the derived `ResolvedModelSettings` view: profile lookup + bare-id normalization applied once), `toBareModelId` (provider-aware `anthropic/` prefix strip — preserves cross-provider routing ids), and the `ResolvedModelSettings` interface. Read the module-level "Decision Rule — Which API to Use" comment first; it tells you the smallest API for your read.
- `src/shared/utils/getDefaultModelForProvider.ts` — `getDefaultModelForProvider`, the provider-aware default applied when neither namespace carries a working model.

## Pure twin pattern (renderer-safe)

`MODEL_SETTINGS_FIELD_KEYS` and the full per-field accessor surface (`getCurrentModel`, `getThinkingModel`, `getPermissionMode`, …) live in **two layers**:

- `src/core/rebelCore/settingsAccessorsPure.ts` — the **canonical declaration** of `MODEL_SETTINGS_FIELD_KEYS`, plus `readField` and `resolveModelSettings`. It has **no `@core/*` runtime imports**. Observability is injected via an optional `onWarn` callback.
- `src/core/rebelCore/settingsAccessors.ts` — the Node/Electron wrapper. Same public signatures, but it imports `@core/logger` and `@core/errorReporter` and wires `onWarn` to a scoped logger + `errorReporter.captureException`. It **re-exports** `MODEL_SETTINGS_FIELD_KEYS` from the pure twin.

**The rule: renderer code MUST import the pure twin.** `@core/logger` calls `node:fs.mkdirSync` at module-init time, which crashes renderer-bundle externalization on the landing loader. Importing `settingsAccessors.ts` (or anything that transitively does) from a renderer path drags that in. See the 260529 renderer-core-logger-import-leak postmortem for a live instance of that failure.

### Why the declaration must not move or become a re-export

`MODEL_SETTINGS_FIELD_KEYS` is **AST-parsed as source text** by `scripts/check-integration-test-provider-gates.ts` (`loadModelSettingsFieldKeys`, wired into `npm run validate:fast`). That guardrail flags integration tests that read legacy `claude.<field>` directly. The parser does **no module resolution** — it walks `VariableDeclarator`s in one named file. In this worktree that file is `settingsAccessorsPure.ts` (the actual declaration), not `settingsAccessors.ts` (a re-export the parser cannot see).

Relocating the declaration, or turning the parsed file back into a re-export, will break `validate:fast` with `Could not parse MODEL_SETTINGS_FIELD_KEYS` — even though TypeScript imports still compile. If you move it, update `loadModelSettingsFieldKeys`'s path in the same change. This exact drift is documented in `docs-private/postmortems/260529_model_settings_field_keys_loader_reexport_blindness_postmortem.md`. (Note: the script's own TSDoc still says it parses `settingsAccessors.ts`; the code parses `settingsAccessorsPure.ts` — trust the code.)

## normalizeSettings — the translator / migrator (write + boot)

`normalizeSettings` in `src/shared/utils/settingsUtils.ts` runs on **every save and every boot**. It is the counterpart to the resolver: where the resolver reads, `normalizeSettings` writes the storage into the consistent, migrated `models`-only shape. It is intentionally broad; keep the detail in the code and signpost. Its responsibilities include:

- Materializing the canonical `models` block from the legacy `claude` block on an un-migrated install (via `materializeModelsFromLegacy`), then **dropping the legacy `claude` mirror from its output** — post-cutover (`470e92eae`) the `claude` block is destructured out and never re-emitted (see the `no-restricted-syntax` eslint-disable comment at the `claude: _claudeIn` drop site). So a save migrates a legacy install forward to `models`-only.
- OAuth → API-key migration.
- OpenRouter-format (`OR_MODEL_MAP`) validation and `anthropic/`-prefix normalization of `model` / `thinkingModel` when not effectively on OpenRouter.
- `activeProvider` derivation and the `isEffectivelyOpenRouter` predicate (treats `openrouter`, `mindstone`, and legacy OR-credential users as OpenRouter-effective).

Because it is provider-blind in places, a careless change here can clobber a user's persisted model choice on boot (see the FOX-3267 / 0.4.40 model-selection lock-in investigation, `docs-private/investigations/260514_fox-3267_rebel-codex-gpt55-rejection.md`, for the failure mode). Treat normalization edits as high-blast-radius.

## activeProvider reification from 'auto' — two intentionally divergent paths

`activeProvider` can be `'auto'`/undefined in storage and must be reified to a concrete provider before routing. There are **two deliberately separate** implementations — do not unify them:

- **Runtime (card-driven):** `planProviderSwitch` in `src/shared/utils/providerSwitch.ts`. Reads the persisted `AppSettings` (current provider, profiles, credentials) to plan a switch, preserving/clearing model slots per provider.
- **Eval bootstrap (bundle-pure):** `resolveActivationProvider` and `resolveActiveProviderForRun` in `evals/knowledge-work-bootstrap.ts`. These resolve purely from the run *bundle* (and explicit inputs) and **never read persisted settings** — an eval run must be reproducible from its bundle alone, independent of whatever happens to be on the operator's machine.

The divergence is the point: runtime honours the user's persisted state; the eval harness must not.

## From resolved fields to per-role health — one precedence core

Once the per-field read above produces the effective model settings, turning those into per-role health/display went through **two** resolvers that recomputed precedence independently — so the Settings UI could disagree with what the agent actually runs. As of the centralize-model-role-selection series (commit `50b9727a9`) the precedence (usable profile → bare model-string → typed failure) is extracted into **`resolveModelRolePrecedence`** in `src/core/rebelCore/modelRoleResolver.ts`, shared by the UI resolver (`roleAssignment.ts`) and the runtime resolver (`resolveDefaultModelForRole`). UI role health therefore **cannot drift from runtime by construction** for working / thinking / background→fast (Recovery is a UI-only carve-out). The role abstraction, the new informational `profile-unavailable-model-active` status, and the recovery carve-out are owned by [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md) — this doc only signposts that the role layer now sits on the same core as runtime.

Two downstream surfaces that previously re-derived global model health from raw settings fields now route through the canonical `resolveAllRoleAssignments` instead (commit `81ad597bc`):

- **Conversation-override panel** — `ConversationModelSelector` (`src/renderer/features/agent-session/components/ConversationModelSelector.tsx`) computes the assignment map once and feeds `effectiveModelId` / `display.modelLabel` / `primary` into its "Global (…)" label and tier-match.
- **Quality tiers** — `overridesMatchGlobalDefault` in `src/shared/data/qualityTiers.ts` now takes caller-resolved effective values (so it stays `@shared`-pure with no `@core` import) and keeps only the inherit-working comparison rule. A disconnected global profile (one with no usable resolved model) no longer matches its tier; note that a profile which is unusable but still carries a model string resolves at runtime via the `profile-unavailable-model-active` fallback, so it is not treated as non-resolving.

## See also

- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — where `AppSettings` is defined, persisted, and loaded; this doc is the model-field slice of that surface.
- [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md) — how the resolved model/provider then drives the routing decision and client construction. (Note: `CONTEXT_AND_PROVIDER_HIERARCHY.md` is the *React* context tree, **not** LLM providers — a known naming trap.)
- [MODEL_CONSTANTS](./MODEL_CONSTANTS.md) — the canonical defaults (`DEFAULT_MODEL`, `PREFERRED_PLANNING_MODEL`, etc.); never hardcode these — signpost to the owning constant instead.
- `docs/plans/260505_canonical_settings_accessor_and_lint_enforced_read_path.md` — the original rationale for the canonical accessor + lint-enforced read path (Stage 1 of this design).
- `docs-private/postmortems/260529_model_settings_field_keys_loader_reexport_blindness_postmortem.md` — why the AST-parsed declaration must stay in its named file.
- `src/core/AGENTS.md` — directory rules for `src/core/`, including the renderer-import constraint that motivates the pure twin.
