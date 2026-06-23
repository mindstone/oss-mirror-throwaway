---
description: "Hand-curated registry of cross-boundary contracts whose drift causes silent regressions, consumed by boundary-hints.ts during plan review."
last_updated: "2026-05-11"
---

# Boundary Registry

**Purpose:** a hand-curated list of cross-boundary contracts whose drift has caused or is likely to cause silent regressions. Consumed by `scripts/boundary-hints.ts` during plan / stage review to point reviewers at the canonical spec doc for each boundary *before* they read the diff.

**Why this exists.** Three postmortems in five days (`260417`, `260420`, `260421`) all traced to the same class of failure: a contract the code was upholding *implicitly* got silently broken during a migration, template copy, or name change. In the 260420 case, nine multi-model reviewers approved the plan in Round 1; none opened the canonical spec doc that would have flagged the spec violation. A Round 2 Devil's Advocate — explicitly instructed to read the spec first — caught it within one invocation. The registry + hints script + process rule together make that "read the spec first" step mandatory and auditable whenever a reviewer touches a known-risky boundary.

## How it works

1. **The YAML registry** (`docs/project/boundary-registry.yaml`) lists each boundary with a canonical `spec_doc`, match patterns (paths / identifiers), optional `exclude_paths` (per-file filter), optional `forbidden_terms`, and references to the postmortem(s) that motivated the entry. `spec_doc` paths point at canonical plan locations — update them when a plan moves to `docs/plans/finished/`.
2. **The hints script** (`scripts/boundary-hints.ts`) reads the registry and a planning doc (or diff, or explicit file list) and emits a YAML block of fired hints. Exits `0` on success (even when hints fire — they're advisory to the user, mandatory to reviewers). Exits `2` on registry/schema/regex/usage errors so reviewers cannot mistake silent failure for "no hints".
3. **The process rule** lives in [`CHIEF_ENGINEER2` § 6.4 BOUNDARY_CHECKLIST.md](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md#64-boundarychecklistmd): reviewers paste the script output, and for each fired hint complete a "Spec Reader" block quoting 3–6 invariants verbatim from the spec before approving.

### `exclude_paths` semantics

`match.exclude_paths` is an **optional per-file filter**, not entry-wide suppression. When a changed file matches any `exclude_paths` glob, that single file is removed from the candidate set BEFORE path matching runs. If the same change also touches another file that DOES match `match.paths` (and is NOT in `exclude_paths`), the entry still fires via the surviving match. Use `exclude_paths` to exclude a narrow, incidental overlap (e.g., catalog-JSON files that happen to live in paths watched by another boundary), never to suppress an entry wholesale. Defaults to `[]` when omitted — existing entries behave identically.

## When to add an entry

**Add an entry when:**
- A postmortem classifies a bug as `incomplete_implementation`, `contract_not_encoded`, `configuration_default_wrong`, or similar *and* the postmortem recommends spec-side hardening.
- During review you identify a cross-process / cross-package contract the codebase encodes only informally, and you can cite a spec doc (or are willing to create one).

**Do NOT add an entry for:**
- One-off bugs without a cross-boundary dimension.
- Things that are better expressed as Zod schemas, TypeScript types, or runtime assertions — those mechanisms are stronger than a reviewer-side check. The registry is for contracts where a typed encoding isn't feasible or hasn't been invested in yet.
- Boundaries that already have machine-enforced validation (e.g., IPC contracts validated via `validate:ipc`).

**How to add an entry:** append to `docs/project/boundary-registry.yaml` following the schema comment at the top of that file. Include at least one `postmortems:` reference. If no postmortem exists yet but you're proposing prevention before a bug ships, link the planning doc that established the contract. `match.exclude_paths` is optional (defaults to `[]`) and should only be added when a narrow path overlap would otherwise cause false positives; prefer tightening `paths` globs over adding broad excludes.

## Current registry entries

See `docs/project/boundary-registry.yaml` for the source of truth. Summary:

| id | category | spec doc | motivated by |
|---|---|---|---|
| `mcp-workspace-env-propagation` | `mcp-env` | MCP_SERVER_STANDARD.md | 260420, 260327 |
| `mcp-catalog-bundledconfig-preservation` | `mcp-catalog` | MCP_SERVER_STANDARD.md | 260417 |
| `mcp-apps-package-identity-routing` | `mcp-resource-routing` | 260412 postmortem | 260412 |
| `mcp-connector-request-timeout` | `mcp-timeout` | 260421 postmortem | 260421 |
| `provider-routing-class-central-resolver` | `provider-routing` | 260427 ProviderRoutePlan | 260419, 260417, 260421 |
| `model-role-resolver-runtime-fallback-fence` | `provider-routing` | 260507 model resolver plan (Stage 1) | 260421, 260419 |
| `learned-output-cap-cascade-coupling` | `provider-routing` | 260507 model resolver plan (Stage 3) | 260421, 260419 |
| `session-event-delta-sync-contract` | `cloud-parity` | 260509 session event delta sync plan | 260509 session sync plan |
| `super-mcp-owner-tag-contract` | `super-mcp-spawn` | SUPER_MCP_LIFECYCLE.md | 260429 |
| `proxy-passthrough-auth-symmetry` | `auth-boundary` | 260430 sentinel-leak postmortem | 260430, 260417 |
| `local-openai-compatible-translation` | `provider-routing` | 260516 DS4 local integration plan (Stage 4) | 260516 DS4 integration plan |
| `evals-judge-panel-shared-primitives` | `eval-harness` | 260430 deleted-constants postmortem | 260430 (5x cluster) |
| `composer-tiptap-markdown-overrides` | `editor-wrapper` | 260501 planning doc | 260501 |
| `spaces-write-realpath-boundary` | `file-system-trust-boundary` | 260423 symlink-write-through plan | 260423 |
| `cross-surface-coupling` | `cross-surface-coupling` | 260514 SurfaceCapabilities + ratchet plan | 260330 de-electronification plan |
| `headless-runtime-options` | `headless-runtime` | 260515 CLI alternative interface plan | 260515, 260330 |
| `locked-session-persistence` | `session-persistence` | 260515 CLI alternative interface plan | 260515 |
| `cli-flag-env-contract` | `cli-contract` | HEADLESS_CLI_ENTRYPOINT_REFERENCE.md | 260515 |
| `cli-approval-protocol` | `cli-safety` | HEADLESS_CLI_ENTRYPOINT_REFERENCE.md | 260515 |
| `wizard-provider-presets` | `settings-wizard` | 260516 DS4 local integration plan (Stage 1) | 260516 DS4 integration plan |

`wizard-provider-presets` protects the Settings model-profile wizard provider-picker contract: the section order in `ProviderStep.tsx` stays **Built-in providers → Models on your machine → Your custom providers**, and the local-machine cards come from the shared `LOCAL_INFERENCE_PRESETS` constant in `src/shared/data/modelProviderPresets.ts` (not duplicated inline).

It also pins the local BYO save-shape invariant in `useProfileWizard.ts`: local presets must persist as `providerType: 'other'` + `routeSurface: 'local'` + `presetKey: 'local:*'` with preset server/model defaults, so DS4 / LM Studio / Ollama custom / llama.cpp onboarding remains stable through future wizard refactors.

`local-openai-compatible-translation` is the Stage 4 counterpart: BOTH OpenAI-compatible translators (desktop proxy + core client) must keep `supportsReasoningReplay`-gated `reasoning_content` replay in sync, including bounded late-reasoning buffer flush invariants and degraded-status signaling on cap hits.

The first four entries share an underlying theme: **OSS migration or template propagation dropped an implicit contract**. The pattern cluster spans env-var naming, catalog field preservation, resource-URI identity threading, and inherited default constants — sibling failure modes at the same class of boundary. The provider-routing entry covers the parallel-path variant of the same pathology: call sites re-derived a boundary decision instead of consuming the central plan.

The `cross-surface-coupling` entry is the structural counterpart: rather than codifying drift after a postmortem, it ratchets the genuine current `@main/*` coupling in `cloud-service/**` and `mobile/**` (12 known sites, May 2026) so future agents cannot quietly grow the cross-surface dependency graph. The primary enforcement is `scripts/check-cross-surface-imports.ts` (catches dynamic imports — ESLint does not) wired into `validate:fast`; an `@typescript-eslint/no-restricted-imports` rule provides a faster dev-loop signal for static imports.

## Pattern cluster (related postmortems)

- [`260412_mcp_apps_resource_routing_postmortem.md`](../../docs-private/postmortems/260412_mcp_apps_resource_routing_postmortem.md) — sourcePackageId dropped in the main↔super-mcp↔renderer routing chain; every `ui://` resource request failed with -33010.
- [`260417_rebel_oss_bundledconfig_regression_postmortem.md`](../../docs-private/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md) — catalog fields dropped during OSS migration.
- [`260420_nano_banana_workspace_path_propagation_postmortem.md`](../../docs-private/postmortems/260420_nano_banana_workspace_path_propagation_postmortem.md) — env-var contract drift at super-mcp → OSS subprocess boundary. Includes detailed Review Analysis of how nine reviewers missed F11.
- [`260421_nano_banana_request_timeout_postmortem.md`](../../docs-private/postmortems/260421_nano_banana_request_timeout_postmortem.md) — template-inherited timeout default wrong for long-running APIs.
- [`260327_mcp_subagent_inheritance_postmortem.md`](../../docs-private/postmortems/260327_mcp_subagent_inheritance_postmortem.md) — prior env-propagation gap at a different MCP boundary.

## Pattern-library entries

Both `env-var-boundary-contract-drift` and `inherited-default-from-template` are documented in [`coding-agent-instructions/AGENTS-BASE.md`](../../coding-agent-instructions/AGENTS-BASE.md) under the `Patterns (postmortem-derived)` section. The registry is the tooling side of those patterns; AGENTS-BASE is the educational side.

*See also: [`MCP_SERVER_STANDARD.md`](MCP_SERVER_STANDARD.md) (canonical MCP spec), [`MCP_IMPROVEMENT_WORKFLOW.md`](MCP_IMPROVEMENT_WORKFLOW.md) (workflow signpost), [`CODING_PRINCIPLES.md`](CODING_PRINCIPLES.md) (patterns cross-reference).*

## CI enforcement (2026-05-13)

Three new CI checks enforce boundary contracts structurally in `validate:fast`:

| Check | Script | What it enforces |
|---|---|---|
| **Forbidden terms** | `scripts/check-boundary-forbidden-terms.ts` | Registry `forbidden_terms` on git-diff added lines. Supports `// boundary-allow: <entry-id> — <reason>` escape hatch. |
| **Cloud channel parity** | `scripts/check-cloud-channel-parity.ts` | Every channel in `CLOUD_CHANNEL_POLICIES` has cloud-side route/handler coverage (IPC allowlist, REST endpoint, or WS handler). |
| **IPC handler parity** | `scripts/check-ipc-handler-parity.ts` | Every channel in `ipcContract` has a registered handler in `src/main/ipc/`, and vice versa. |

These address F-U-2 (CI enforcement of forbidden_terms) and F-U-4 (cloud-service parity) via a lighter mechanism than the originally-deferred PR-comment approach. See `docs/plans/260513_boundary_contract_enforcement.md` for the full design.

## Follow-ups (not yet implemented)

- **F-U-1** — JSON-Schema validator for `boundary-registry.yaml` (warranted when entries exceed ~10 or on the first malformed-entry incident).
- ~~**F-U-2** — CI wrapper that invokes the hints script on PR `files_changed` and posts the output as a PR comment.~~ **Partially addressed** by `check-boundary-forbidden-terms.ts` — forbidden_terms are now CI-enforced. The full hints-as-PR-comment scope remains deferred.
- **F-U-3** — Pre-commit hook that runs the script when touching any registry path glob. Same deferral as F-U-2.
- ~~**F-U-4** — Extend the registry to cover cloud-service parity boundaries.~~ **Addressed** by `check-cloud-channel-parity.ts`.
- **F-U-5** — Sibling OSS connector timeout sweep (from 260421 Prevention section): audit the 16 other OSS connectors sharing `REQUEST_TIMEOUT_MS = 30_000`.
- **F-U-6** — Real-subprocess integration test for SDK-drift protection (D17 from `260418_nano_banana_workspace_path_injection.md`).

## Maintenance

This doc stays **short** by design. When the registry grows past ~10 entries or the pattern cluster gains new failure modes, migrate the detail into a richer structure (per-category subdirectories, per-postmortem anchors) rather than bloating this single page.
