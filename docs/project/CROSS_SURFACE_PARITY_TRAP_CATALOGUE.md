---
description: "Catalogue of cross-surface parity trap shapes and which CI/review gates catch them."
last_updated: "2026-05-30"
---

# Cross-Surface Parity Trap Catalogue

This catalogue names the recurring cross-surface parity traps that have caused production incidents, and maps each trap to the CI gate or human review step that catches it. It is written for reviewers and implementers working near settings sync, provider routing, token storage, and boundary-interface bootstrapping; use it alongside the human checklist in [CROSS_SURFACE_PARITY_CHECKLIST.md](CROSS_SURFACE_PARITY_CHECKLIST.md) and the mechanized gate in `scripts/check-cross-surface-parity-gap.ts`.

## What the gate cannot do (and what it can)

The gate verifies **structural parity**, not semantic completeness. It catches:

- Boundary-interface setters declared in core but not registered on cloud (Rule A).
- New `AppSettings` keys with capability-gating name patterns and cloud-syncing types (Rule B).

It does **not** catch:

- A registered boundary implementation that silently no-ops on cloud.
- Parallel transport layers with asymmetric guards (the 2026-04-26 class).
- Semantic provider-routing logic regressions (the 2026-04-29 class).
- Mobile-side bootstrap drift; mobile currently routes through cloud and does not register core boundaries directly.

For semantic completeness, [CROSS_SURFACE_PARITY_CHECKLIST.md](CROSS_SURFACE_PARITY_CHECKLIST.md) remains the non-mechanizable layer. The script is a bouncer, not a philosopher. It checks the door it can see.

## Trap 1 — Settings Flag Synced Without Backing Capability

### Shape

A new `AppSettings` field syncs to cloud because it is not in `LOCAL_ONLY_SETTINGS_KEYS`. Its name gates a capability (`activeProvider`, `codexAuthProvider`, `token*`, `*Service`) and its value tells cloud/mobile to use a backing service that only exists on desktop. The flag travels; the token store, OAuth provider, or service implementation does not.

### Canonical exemplar

[`260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md`](../../docs-private/postmortems/260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md) — `activeProvider: 'codex'` synced to cloud while cloud lacked OAuth tokens, producing a three-retry death loop.

### Why it happens

Review frames the feature as desktop UX, while cloud bootstrap and mobile behavior sit outside the changed-files diff. The setting flag travels via `CLOUD_CHANNEL_POLICIES` or by omission from `LOCAL_ONLY_SETTINGS_KEYS`, but the supporting service registration stays desktop-only.

### What the right fix looks like

1. **Default answer: sync the underlying data via dual-write.** Add the needed channel policy in `src/shared/cloudChannelPolicies.ts` and register a cloud-side boundary implementation in `cloud-service/src/bootstrap.ts` or the appropriate cloud bootstrap site.
2. **Alternative: explicit `LOCAL_ONLY` exemption.** Add the key to `LOCAL_ONLY_SETTINGS_KEYS_ARRAY` in `src/shared/cloudSettingsPolicy.ts`; the `satisfies readonly (keyof AppSettings)[]` type-lock enforces consistency. Rule C is retired structurally; see [planning doc §22](../plans/260516_cross_surface_parity_gap_gate.md#stage-15-implementation-2026-05-16).
3. **Wrong fix: silently disable the feature on cloud/mobile.** That creates a neat-looking null path and an actual product regression. Revolutionary, in the worst possible sense.

### Related postmortems

- [`260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md`](../../docs-private/postmortems/260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md) (canonical)
- [`260429_codex_disconnected_anthropic_fallthrough_postmortem.md`](../../docs-private/postmortems/260429_codex_disconnected_anthropic_fallthrough_postmortem.md) (semantic; gate does **not** catch — listed for reviewer awareness)
- [`260330_claude_max_oauth_refresh_race_postmortem.md`](../../docs-private/postmortems/260330_claude_max_oauth_refresh_race_postmortem.md) (sibling: desktop encrypted storage vs cloud refresh metadata)
- [`260424_safety_eval_unavailable_5_gap_fixes_postmortem.md`](../../docs-private/postmortems/260424_safety_eval_unavailable_5_gap_fixes_postmortem.md) (BTS safety eval hardcoded `codexConnected: false` on cloud — gate does **not** catch directly)
- [`260511_openrouter_oauth_active_provider_fix.md`](../plans/260511_openrouter_oauth_active_provider_fix.md) (OpenRouter OAuth active-provider fix planning doc)

### Mechanized via

- **Rule A (BIRP)** in `scripts/check-cross-surface-parity-gap.ts`: catches the registration-gap side when desktop sets `setXProvider` or `setXService` non-`NULL` but cloud does not.
- **Rule B (CSACG)** in `scripts/check-cross-surface-parity-gap.ts`: catches the settings-shape side for a new `AppSettings` key with a capability-gating name and union/boolean type that is not `LOCAL_ONLY`. Pre-existing capability-gating fields (`activeProvider`, `exposeProviderKeysInShell`) were investigated and confirmed safe under sync-with-policy; see [`260516_rule_b_baseline_disposition_followup.md`](../plans/260516_rule_b_baseline_disposition_followup.md). Rule B remains diff-scoped under `--all-files` until the `CLOUD_SYNCED_CAPABILITY_SETTINGS` manifest (§23.1) lets it distinguish confirmed-synced fields from unconfirmed ones.
- **Stage 5 baseline acknowledgment (2026-05-30):** `AppSettings.managedProviderDeactivated` is an intentional exemption alongside `activeProvider`. The field is cloud-synced for UX continuity, but the reconcile path that consumes it (`extractManagedProviderInfo`) is desktop-main-only and cloud-service does not register Auth handlers, so there is no cloud-side reactivation behavior to parity-bind.
- **Stage 5 baseline acknowledgment (2026-06-19):** `AppSettings.enabledProviders` (added by the multiprovider foundation, Stage 2) is an intentional exemption alongside `activeProvider`. It is cloud-synced by design — `stripLocalSettings` does not strip it, so it rides the `settings:update` dual-write exactly like `activeProvider` — and is inert until a writer exists (Stage 6), so there is no surface-specific behavior to parity-bind yet.
- **Rationale-quality enforcement (Stage 9)**: every `// CROSS_SURFACE_PARITY_EXEMPT:` comment used to suppress a violation must have a rationale of ≥30 characters and contain none of the weak markers `TODO`, `FIXME`, `XXX`, `WIP`, `temp/temporary`, `later`. Weak rationales surface in `--list-exemptions` for audit but do not suppress violations; a precise warning explains why. The strict-template rationale used by the two existing production exemptions (`appNavigationService.ts`, `screenshotCaptureService.ts`) is the canonical example.
- **Stage 1.5 type-lock** (`satisfies readonly (keyof AppSettings)[]` on `LOCAL_ONLY_SETTINGS_KEYS_ARRAY`): compile-time guarantee that no typo or stale local-only entry slips through.
- **Detector-owned acknowledgment baseline (2026-06-19):** the set of acknowledged escape hatches is now pinned in `EXPECTED_ACKNOWLEDGED_EXEMPTIONS` **inside `scripts/check-cross-surface-parity-gap.ts`** and enforced in the detector's normal CLI run (which `validate:fast` → `validate:cross-surface-parity-gap` always runs, so it is pre-push-guaranteed). Adding/removing/moving a `CROSS_SURFACE_PARITY_EXEMPT` without updating that manifest fails the detector (exit 1) at pre-push time — a long rationale comment alone does **not** auto-accept a new escape hatch (the two-part invariant: source rationale explains *why* safe; the manifest records that the team *consciously accepted* this hatch). Regenerate after review with `npx tsx scripts/check-cross-surface-parity-gap.ts --update-acknowledged-exemptions`. This replaced the previous standalone `check-cross-surface-parity-gap.baseline.test.ts` vitest pin, which the import-graph-selected pre-push test tier (`vitest related`) did not run for a source-only change — letting a baseline drift escape to dev/beta (the 2026-06-19 `enabledProviders` incident).

## Trap 2 — Parallel Transport Boundary Without Replicated Guard

### Shape

Two transport layers — for example IPC and HTTP, or REST and WebSocket — share a backing store. One path strips secrets, blocks internal fields, or enforces a trust boundary; the other path exposes the same data without the guard. Everyone assumes the other layer already handled it. The database quietly disagrees.

### Canonical exemplar

[`260426_cloud_api_settings_client_secret_exposure_postmortem.md`](../../docs-private/postmortems/260426_cloud_api_settings_client_secret_exposure_postmortem.md) — the IPC settings blocklist was not replicated on the parallel HTTP boundary, exposing client secrets through the cloud API path.

### Why it happens

Cloud-service plumbing lands as deployment scaffolding rather than a security boundary. Each transport implementer assumes the sibling transport's guard exists, and duplicated predicates drift because duplicated predicates are like that.

### What the right fix looks like

Centralize the predicate and force both transports through the same wrapper. The existing precedent is `src/shared/cloudChannelPolicies.ts`: one source of truth for which IPC channels route to cloud, with derived allowlists rather than hand-copied guards.

### Related postmortems

- [`260426_cloud_api_settings_client_secret_exposure_postmortem.md`](../../docs-private/postmortems/260426_cloud_api_settings_client_secret_exposure_postmortem.md) (canonical)
- [`260412_staged_approval_secret_leak_postmortem.md`](../../docs-private/postmortems/260412_staged_approval_secret_leak_postmortem.md) (sibling)

### Mechanized via

**Not mechanized by this gate.** Rule A would only fire if a new boundary interface were added without cloud registration; it does not reason about existing transport-layer guard replication. This trap is listed for reviewer awareness, and [CROSS_SURFACE_PARITY_CHECKLIST.md](CROSS_SURFACE_PARITY_CHECKLIST.md) item 5 remains the safety net.

## Trap 3 — Inline Surface Branch Instead of Boundary Interface

### Shape

Core business logic branches on a surface name and returns a null or degraded path, such as `if (platform === 'cloud') return null;`. That defeats the boundary-interface abstraction: instead of one shared core path with surface-specific providers, the product gains a quiet fork in the middle of logic that future reviewers are unlikely to inspect.

### Mechanized via

**Partial.** Covered by the cross-surface-imports ratchet; see [`260514_surface_capabilities_and_quick_wins.md`](../plans/260514_surface_capabilities_and_quick_wins.md), Stage 3. This trap catalogue lists it for completeness. The gate in `scripts/check-cross-surface-parity-gap.ts` does **not** cover it directly.

---

## How to use this catalogue

- **When adding a setting to `AppSettings`:** check Trap 1. Ask whether this flag gates a capability that requires a backing service or token. If yes, register that capability on cloud or add the setting to `LOCAL_ONLY_SETTINGS_KEYS_ARRAY`.
- **When adding a boundary interface in `src/core/`:** check Trap 1. Register it on both desktop and cloud bootstrap files, or exempt it with `// CROSS_SURFACE_PARITY_EXEMPT: <reason>` if it is intentionally desktop-only.
- **When working on cloud-service transport plumbing:** check Trap 2. Verify guards are centralized, not duplicated.
- **When tempted to write `if (platform === ...)` in core:** check Trap 3. Use a boundary interface instead.

## Known limitations

- On push-trigger CI runs (`workflow_dispatch`, direct push to dev/main without PR), the gate auto-detects `event.before` from `GITHUB_EVENT_PATH` and compares against that. PR-trigger runs use `GITHUB_BASE_REF`. The only remaining no-op case is initial push to a fresh branch (no prior SHA to compare against), which is rare and intentional.

## How to retire rules (future direction)

Per [planning doc §23](../plans/260516_cross_surface_parity_gap_gate.md#23-structural-eliminators-future-direction), the long-term direction is to replace gate rules with compile-time or runtime structural guarantees. Stage 1.5 already retired Rule C via the `satisfies` clause. Future eliminators — boundary requirement manifests, cloud-boot assertions, explicit synced-capability setting manifests — would retire Rules A and B. When a structural eliminator lands, remove the corresponding rule from the gate script and update this catalogue.

## See also

- [CROSS_SURFACE_PARITY_CHECKLIST.md](CROSS_SURFACE_PARITY_CHECKLIST.md) — the human-judgment layer
- `src/shared/cloudSettingsPolicy.ts` — the canonical exemption list
- `src/shared/cloudChannelPolicies.ts` — the canonical routing table
- `scripts/check-cross-surface-parity-gap.ts` — the gate
- [`260516_cross_surface_parity_gap_gate.md`](../plans/260516_cross_surface_parity_gap_gate.md) — planning doc with full spec
- [BOUNDARY_REGISTRY.md](BOUNDARY_REGISTRY.md) — boundary registry
- [`260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md`](../../docs-private/postmortems/260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md) — canonical exemplar
