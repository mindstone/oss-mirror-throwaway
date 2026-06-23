/**
 * validate:fast step runner.
 *
 * Replaces a 46-step bash `&&` chain in package.json with a sequential
 * runner whose only added value is a final FAILURE BANNER printed to
 * stderr identifying which step failed and how to rerun it. The banner
 * is what makes the actual cause survive terminal/CLI tail truncation
 * when pre-push or CI output is long.
 *
 * Why not just bash with `trap ... ERR`? A small TS list is easier to
 * maintain, the rerun-hint metadata is naturally typed, and the runner
 * is cross-platform via tsx (some agents/contributors are on Windows
 * where bash arrays are awkward).
 *
 * Per-step PREPUSH_TIMING markers and a JSON timing artefact at
 * `.local/validate-fast-timings.json` are emitted as of A1.0
 * (260522_compile-time-reliability plan). They are reporting-only —
 * no gate behaviour. CI artefact upload is deferred to A1.1 (DI-15).
 * Parallelisation remains deferred (DI-4).
 *
 * Behavioural contract:
 *   - Sequential execution, in declared order. Stops on first non-zero
 *     exit. Matches existing `&&`-chain semantics.
 *   - Inherits stdio so streamed output reaches the terminal live.
 *   - Exits with the failing step's exit code (or 0 on full success).
 *   - On failure, writes a multi-line banner to stderr at the very end,
 *     after the failing step's own output. Banner format is stable so
 *     the git-safe-sync timing log + human readers can grep for it.
 *
 * Cheap-spawn step resolution (260611_prepush-gate-speedup Stage 1): steps
 * whose command is `npm run <x>` wrapping a simple `[npx] tsx scripts/<p>.ts`
 * package script (or already written as one) are spawned directly as
 * `node --import tsx scripts/<p>.ts` — same script, same exit-code
 * propagation, minus ~0.9s/step of npm+npx launcher tax. Anything that
 * doesn't match the conservative classifier (extra flags, env prefixes,
 * compound shell, vitest/eslint/build commands) runs verbatim as before
 * (fail-open to today's behavior). Rerun hints are unchanged so
 * package.json stays the single source of truth. The committed
 * step-identity baseline (scripts/validate-fast-step-baseline.json +
 * scripts/__tests__/validate-fast-step-registry.test.ts) makes silently
 * dropping/renaming a guard a test failure by construction.
 *
 * CLI:
 *   tsx scripts/run-validate-fast.ts            # run the chain
 *   tsx scripts/run-validate-fast.ts --list     # print step list + rerun hints
 *   tsx scripts/run-validate-fast.ts --write-step-baseline  # regenerate baseline
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Step {
  /** Human-readable name used in the failure banner. */
  readonly name: string;
  /** Shell command to execute. */
  readonly command: string;
  /** Optional rerun hint (defaults to `npm run <name>` when the name looks like an npm script). */
  readonly rerun?: string;
}

export interface StepTiming {
  readonly name: string;
  readonly duration_ms: number;
  readonly exit_code: number;
  /** Actual executed command after cheap-spawn resolution (additive, reporting-only). */
  readonly resolved_command?: string;
}

export interface ValidateFastTimingArtifact {
  readonly run_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly surface: 'local' | 'ci';
  readonly git_sha: string;
  readonly branch: string;
  readonly steps: readonly StepTiming[];
}

export interface StepResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
}

export type RunStep = (step: Step, resolved: ResolvedStepCommand) => Promise<StepResult>;
export type TimingArtifactWriter = (
  artifact: ValidateFastTimingArtifact,
  artifactPath: string,
) => void;

export interface RunValidateFastOptions {
  readonly steps?: readonly Step[];
  readonly artifactPath?: string;
  readonly runStep?: RunStep;
  readonly writeTimingArtifact?: TimingArtifactWriter;
  readonly installSignalHandlers?: boolean;
}

const STEPS: readonly Step[] = [
  // First: fail fast with a clear message if core.bare is effectively true (shared-config
  // corruption under extensions.worktreeConfig). Otherwise later git-dependent steps fail
  // with a cryptic "must be run in a work tree". See scripts/check-core-bare.ts.
  { name: 'check-core-bare', command: 'npx tsx scripts/check-core-bare.ts', rerun: 'npx tsx scripts/check-core-bare.ts' },
  { name: 'check-husky-hooks-path', command: 'npx tsx scripts/check-husky-hooks-path.ts', rerun: 'npx tsx scripts/check-husky-hooks-path.ts' },
  // BATCHED (docs/plans/260618_git-safe-sync-speedup): 9 import-safe anti-rot/source/
  // config-hygiene guards run in ONE process via scripts/groups/anti-rot-source-checks.ts.
  // Each guard's UNCHANGED main() runs fail-closed with process.exit intercepted; all
  // verified import-safe with argv used only in the import guard. Members registered in
  // loadGroupExpansions() so the step-identity baseline flattens per-guard. Batched members:
  // check-husky-pre-push-fast-tier, check-oauth-setup-guidance, check-renderer-oauth-setup-guidance,
  // check-no-legacy-eval-tokens, validate:escape-hatches, validate:direct-session-puts,
  // validate:agent-error-emit-callers, check-no-raw-ipc-invoke, validate:r2-manifest-guard.
  { name: 'validate:anti-rot-source-checks', command: 'npx tsx scripts/groups/anti-rot-source-checks.ts', rerun: 'npx tsx scripts/groups/anti-rot-source-checks.ts' },
  { name: 'check-better-sqlite3-not-runtime', command: 'npx tsx scripts/check-better-sqlite3-not-runtime.ts', rerun: 'npx tsx scripts/check-better-sqlite3-not-runtime.ts' },
  { name: 'check-integration-test-provider-gates', command: 'npx tsx scripts/check-integration-test-provider-gates.ts', rerun: 'npx tsx scripts/check-integration-test-provider-gates.ts' },
  { name: 'check-auth-teardown-coverage', command: 'npx tsx scripts/check-auth-teardown-coverage.ts', rerun: 'npx tsx scripts/check-auth-teardown-coverage.ts' },
  // Native-teardown coverage (260622_teardown-lifecycle-contract Stage 1): every file that
  // establishes a long-lived in-MAIN native handle (LanceDB connection / ORT InferenceSession /
  // BLE central) must be CLASSIFIED against the teardown contract — registered in
  // src/main/services/nativeTeardownRegistry.ts (main-owner / tracked-gap) or EXEMPT
  // (out-of-process / transient) with a reason. Makes "an invisible native owner" (the structural
  // miss that hid moonshine + file-index from shutdown, REBEL-6AM) unrepresentable. Manifest-driven:
  // a pinned narrow signature set FINDS candidates; the registry is the source of truth.
  { name: 'check-native-teardown-coverage', command: 'npx tsx scripts/check-native-teardown-coverage.ts', rerun: 'npx tsx scripts/check-native-teardown-coverage.ts' },
  // Generalized from check-commercial-oauth-credentials (260610): every @private/mindstone
  // bootstrap capability (oauth creds, auth, current-user, contribution relay, auth-config
  // refresh, health check) must be commercially wired with the OSS stub staying inert.
  { name: 'check-commercial-capability-parity', command: 'npx tsx scripts/check-commercial-capability-parity.ts', rerun: 'npx tsx scripts/check-commercial-capability-parity.ts' },  { name: 'check-connector-smoke-readonly', command: 'npx tsx scripts/check-connector-smoke-readonly.ts', rerun: 'npx tsx scripts/check-connector-smoke-readonly.ts' },
  { name: 'check-no-routing-model-forge', command: 'npx tsx scripts/check-no-routing-model-forge.ts', rerun: 'npx tsx scripts/check-no-routing-model-forge.ts' },
  { name: 'check-no-legacy-resolver', command: 'npx tsx scripts/check-no-legacy-resolver.ts', rerun: 'npx tsx scripts/check-no-legacy-resolver.ts' },
  { name: 'check-chat-completions-chokepoint', command: 'npx tsx scripts/check-chat-completions-chokepoint.ts', rerun: 'npx tsx scripts/check-chat-completions-chokepoint.ts' },
  { name: 'check-direct-anthropic-route-chokepoint', command: 'npx tsx scripts/check-direct-anthropic-route-chokepoint.ts', rerun: 'npx tsx scripts/check-direct-anthropic-route-chokepoint.ts' },
  // Producer-granularity guard (postmortem 260622_memory_bts_codex_arm_dialect_blind_admission rec #3):
  // every route arm in providerRouting.ts that mints a dispatchable codex-proxy decision must gate
  // model eligibility through the shared isCodexServableModel predicate. Closes the producer gap the
  // 260608 sub-agent-door kill (check-agent-tool-body-model-source) missed, which let REBEL-5N8 recur.
  { name: 'check-codex-servable-route-chokepoint', command: 'npx tsx scripts/check-codex-servable-route-chokepoint.ts', rerun: 'npx tsx scripts/check-codex-servable-route-chokepoint.ts' },
  { name: 'check-model-id-inference-clone', command: 'npx tsx scripts/check-model-id-inference-clone.ts', rerun: 'npx tsx scripts/check-model-id-inference-clone.ts' },
  // BATCHED (docs/plans/260618_git-safe-sync-speedup): 11 import-safe source-policy
  // chokepoint guards run in ONE process via scripts/groups/source-policy-chokepoints.ts
  // (collapses ~11 tsx boots → 1). Each guard's UNCHANGED main() runs fail-closed with
  // process.exit intercepted (scripts/lib/guard-group-runner.ts). Per-guard rationale
  // lives in each guard's own header. Members are registered in loadGroupExpansions()
  // so the step-identity baseline flattens per-guard — a dropped member fails the
  // registry test. Batched members: check-agent-tool-body-model-source,
  // check-capability-resolution-dispatch-seam, check-agent-turn-dispatch-chokepoint,
  // check-role-resolution-chokepoint, check-app-exit-chokepoint,
  // check-will-quit-preventdefault-chokepoint, check-fsevents-containment,
  // check-safety-dir-call-sites, check-failopen-scope-readers,
  // check-pathroot-startswith-containment, check-trusted-tool-write-normalization.
  { name: 'validate:source-policy-chokepoints', command: 'npx tsx scripts/groups/source-policy-chokepoints.ts', rerun: 'npx tsx scripts/groups/source-policy-chokepoints.ts' },
  // Anti-rot: user-facing IPC must not await deferred Super-MCP restarts unless allowlisted.
  // (Not batched: no exported main() — AST-based, deferred to a later tranche.)
  { name: 'check-supermcp-restart-awaiters', command: 'npx tsx scripts/check-supermcp-restart-awaiters.ts', rerun: 'npx tsx scripts/check-supermcp-restart-awaiters.ts' },
  // Anti-rot: Super-MCP startup entry points must route through the retry/recovery wrapper.
  { name: 'check-supermcp-single-startup-path', command: 'npx tsx scripts/check-supermcp-single-startup-path.ts', rerun: 'npx tsx scripts/check-supermcp-single-startup-path.ts' },
  // Anti-rot: the agent-turn executor's @main/services/* import surface must match a recorded
  // baseline so a newly-added service that isn't wired into bootRealAgentServices() can't false-green
  // a real-boot turn test. Update with `--write` after confirming the boot helper + BOUNDARY_CHECKLIST.
  { name: 'check-executor-service-imports', command: 'npx tsx scripts/check-executor-service-imports.ts', rerun: 'npx tsx scripts/check-executor-service-imports.ts' },
  // Anti-false-green: a test importing bootRealAgentServices() must NOT vi.mock the provider
  // seam (@core/rebelCore/queryRouter / @main/services/agentQueryRunner) — doing so recreates
  // the mock-masking blind spot the real-boot helper exists to eliminate. Zero-tolerance.
  { name: 'check-real-boot-no-provider-mock', command: 'npx tsx scripts/check-real-boot-no-provider-mock.ts', rerun: 'npx tsx scripts/check-real-boot-no-provider-mock.ts' },
  { name: 'check-sk-test-token-drift', command: 'npx tsx scripts/check-sk-test-token-drift.ts', rerun: 'npx tsx scripts/check-sk-test-token-drift.ts' },  { name: 'check:oss-surface', command: 'npm run check:oss-surface' },
  { name: 'validate:recall-sdk-parity', command: 'npm run validate:recall-sdk-parity' },
  { name: 'validate:mirror-exclusion-list-parity', command: 'npm run validate:mirror-exclusion-list-parity' },
  { name: 'validate:trufflehog-public-allowlist', command: 'npm run validate:trufflehog-public-allowlist' },
  { name: 'validate:r1-r2-overlap', command: 'npm run validate:r1-r2-overlap' },
  // Warn-only soft-launch (Stage T1): flags zero-test-introducing commits (qa14
  // class). Exits 0 in warn mode so it never fails validate:fast; set
  // TEST_COVERAGE_DELTA_ENFORCE=1 to promote to blocking later.
  { name: 'validate:test-coverage-delta', command: 'npm run validate:test-coverage-delta' },
  { name: 'validate:workflow-checkout-depth', command: 'npm run validate:workflow-checkout-depth' },
  { name: 'validate:workflow-powershell-syntax', command: 'npm run validate:workflow-powershell-syntax' },
  { name: 'validate:eslint-preflight-r1-rule', command: 'npm run validate:eslint-preflight-r1-rule' },
  { name: 'lint', command: 'npm run lint' },
  { name: 'validate:bts-prefix-decoder-rule', command: 'npm run validate:bts-prefix-decoder-rule' },
  { name: 'validate:bts-transport-symmetry', command: 'npm run validate:bts-transport-symmetry' },
  { name: 'validate:proxy-auth-translator-centralization', command: 'npm run validate:proxy-auth-translator-centralization' },
  // Stacked dual-retry tripwire (PM 260619 Rec 3): every provider-proxy discriminator in
  // clientFactory.ts must make an EXPLICIT maxRetries decision (maxRetries:0 OR a documented
  // exemption) — never silently inherit the SDK default and stack over runWithRetry.
  { name: 'validate:provider-proxy-retry-stacking', command: 'npm run validate:provider-proxy-retry-stacking' },
  { name: 'validate:codex-connectivity-probe-funnel', command: 'npm run validate:codex-connectivity-probe-funnel' },
  { name: 'validate:eslint-warnings', command: 'npm run validate:eslint-warnings' },
  // Diff-scoped new-warning gate (260612_silent-swallow-gate Stage 1): runs the
  // tight per-changed-file ESLint check whenever a base derives (local pre-push
  // resolves via the @{upstream}/origin/dev merge-base fallback). A new swallow
  // in changed code FAILS; no derivable base or a base-prep/infra failure
  // degrades to a LOUD non-fatal skip (the lint --max-warnings cap is the
  // backstop). Skip-capable by design — declared in skip-capable-gate-manifest.ts.
  { name: 'validate:eslint-new-warnings', command: 'npm run validate:eslint-new-warnings' },
  { name: 'validate:conflict-matcher-consumer-guard', command: 'npm run validate:conflict-matcher-consumer-guard' },
  // Anti-rot (REBEL-696, the 3x-recurring Drive dual-writer class): the cloud→desktop
  // delivery surface (cloudWorkspaceSync/cloudStagingBridge) must not gain a NEW raw
  // in-place content write reachable on a desktop_fs_authoritative (OS-Drive-synced)
  // path — that second writer races the OS sync engine and mints self-feeding `(N)`
  // conflict copies. The GENERATOR analogue of the conflict-matcher consumer guard
  // (which guards the suppressor). New raw writers fail; current ones baselined.
  { name: 'validate:cloud-writer-authority-guard', command: 'npm run validate:cloud-writer-authority-guard' },
  // ENFORCING (260620, the #e513 payoff): every statically-resolvable cloud→desktop broadcast
  // emit-site (literal / resolved-constant / `// dynamic-broadcast-reviewed:`-annotated forwarder)
  // under src/main|core|shared + cloud-service/src must be DECLARED (allowlisted / not-cloud-pushed
  // exemption / dynamic-reviewed) or this gate FAILS — a forgotten allowlist entry then fails the
  // build instead of silently shipping the auto-title / show-more-activity / time-saved:status
  // cross-surface-no-show class (≥3 prior recurrences, PM 260618_autotitle rec 2/rec 1).
  // `audit:cloud-push-allowlist-coverage` is the same script for on-demand use. Scope is honest:
  // it does NOT cover channels emitted outside the scanned broadcast fn set or roots.
  { name: 'validate:cloud-push-allowlist', command: 'npm run validate:cloud-push-allowlist' },
  // Consolidated step for ALL always-on testing-infrastructure guards from
  // docs/plans/260610_testing-recs-drain (orphaned-tests today; Stages 4/6/9/10
  // register additional modules in scripts/check-testing-guards.ts, NOT new Steps).
  { name: 'validate:testing-guards', command: 'npm run validate:testing-guards' },  { name: 'check-no-new-slack-mention-poll-emission', command: 'npx tsx scripts/check-no-new-slack-mention-poll-emission.ts', rerun: 'npx tsx scripts/check-no-new-slack-mention-poll-emission.ts' },
  { name: 'validate:meeting-emit-eslint-scope', command: 'npm run validate:meeting-emit-eslint-scope' },
  { name: 'validate:meeting-emit-callers', command: 'npm run validate:meeting-emit-callers' },  { name: 'validate:ipc', command: 'npm run validate:ipc' },
  // BATCHED (docs/plans/260618_git-safe-sync-speedup): 5 import-safe registry/parity
  // guards run in ONE process via scripts/groups/registry-parity.ts. Each guard's
  // UNCHANGED main() runs fail-closed with process.exit intercepted; argv is used only
  // in each guard's invokedDirectly check (no flag parsing). Members registered in
  // loadGroupExpansions() so the step-identity baseline flattens per-guard. Batched
  // members: validate:ipc-schema-strictness, validate:startup-ipc-ordering,
  // validate:ipc-handler-parity, validate:ipc-bridge-exposure-parity,
  // validate:cloud-channel-parity. (validate:boundary-registry-paths stays standalone.)
  { name: 'validate:registry-parity', command: 'npx tsx scripts/groups/registry-parity.ts', rerun: 'npx tsx scripts/groups/registry-parity.ts' },
  { name: 'validate:boundary-forbidden-terms', command: 'npm run validate:boundary-forbidden-terms' },
  // ENFORCING (promoted 2026-06-06 after the soft-launch validated 6 opted-in seams):
  // for boundary-registry entries that opt in via `contract_test:`, asserts the named
  // test exists, is discoverable, and imports the seam's `owned_by` module (import-graph
  // floor). The npm script passes `--enforce`, so a violation (an opted-in seam losing
  // its contract test or import-floor) FAILS validate:fast. NOTE: this enforces
  // presence + import-floor, NOT that the test is actually run/non-vacuous — the
  // run-reachability check remains a deeper follow-up.
  { name: 'validate:boundary-contract-coverage', command: 'npm run validate:boundary-contract-coverage' },
  // Always-on registry integrity: dangling spec_doc paths and path-glob drift must
  // fail every push, not only when boundary-hints tests run via merge-gated related.
  // (Standalone — imports boundary-hints.ts, not worth cascading tsconfig includes to batch.)
  { name: 'validate:boundary-registry-paths', command: 'npm run validate:boundary-registry-paths' },
  { name: 'validate:model-pricing', command: 'npm run validate:model-pricing' },
  { name: 'validate:model-registry-consistency', command: 'npm run validate:model-registry-consistency' },
  { name: 'validate:model-routing-notes', command: 'npm run validate:model-routing-notes' },
  { name: 'validate:eval-canonical-panel', command: 'npm run validate:eval-canonical-panel' },
  { name: 'validate:eval-canonical-fixtures', command: 'npm run validate:eval-canonical-fixtures' },
  { name: 'validate:bts-eval-binding', command: 'npm run validate:bts-eval-binding' },
  { name: 'validate:store-versions', command: 'npm run validate:store-versions' },
  { name: 'validate:session-hydration-boundary', command: 'npm run validate:session-hydration-boundary' },
  { name: 'validate:migration-classification', command: 'npm run validate:migration-classification' },
  { name: 'validate:translators', command: 'npm run validate:translators' },
  { name: 'validate:e2e-testids', command: 'npm run validate:e2e-testids' },
  { name: 'validate:doc-frontmatter', command: 'npm run validate:doc-frontmatter' },
  { name: 'validate-mcp-bundles', command: 'npx tsx scripts/validate-mcp-bundles.ts', rerun: 'npx tsx scripts/validate-mcp-bundles.ts' },
  { name: 'validate-cloud-dockerfile', command: 'npx tsx scripts/validate-cloud-dockerfile.ts', rerun: 'npx tsx scripts/validate-cloud-dockerfile.ts' },
  { name: 'check-mobile-test-runner', command: 'npx tsx scripts/check-mobile-test-runner.ts', rerun: 'npx tsx scripts/check-mobile-test-runner.ts' },
  { name: 'check-mobile-barrel-imports', command: 'npx tsx scripts/check-mobile-barrel-imports.ts --expected-count=0', rerun: 'npx tsx scripts/check-mobile-barrel-imports.ts --expected-count=0' },
  // Mobile-reachable Node-only RN-safety boundary (260622_mobile-core-boundary-lint,
  // the renderer_node_core_import_leak class-killer for mobile): walks the import
  // graph from the mobile entry roots across the in-repo @core/@shared/cloud-client
  // alias frontier and FAILS if any reached module pulls in a Node-only API
  // (node:*/import.meta/createRequire/pino) Hermes can't run. The transitive class
  // an ESLint mobile/**-scoped rule is structurally blind to (the 2026-06-17→22
  // @core/logger outage). production-bundle-smoke (mobile-runtime-integrity.yml)
  // remains the authoritative backstop; this is the faster edit-time complement.
  { name: 'check-mobile-core-rn-safety', command: 'npx tsx scripts/check-mobile-core-rn-safety.ts --expected-count=0', rerun: 'npx tsx scripts/check-mobile-core-rn-safety.ts --expected-count=0' },
  // Renderer sibling (REBEL-6C0 Stage 4): the renderer ESLint `@core/**` ban is
  // silently clobbered by a later same-glob no-restricted-imports override, so a
  // renderer file can transitively import @core/logger→node:fs with the gate
  // green. This transitive-reachability graph check is immune to ESLint
  // override-replacement and kills the renderer_node_core_import_leak class by
  // construction. The renderer BUILD is the authoritative backstop; this is the
  // faster edit-time complement.
  { name: 'check-renderer-core-rn-safety', command: 'npx tsx scripts/check-renderer-core-rn-safety.ts --expected-count=0', rerun: 'npx tsx scripts/check-renderer-core-rn-safety.ts --expected-count=0' },
  { name: 'validate-new-postmortems', command: 'npx tsx scripts/validate-new-postmortems.ts', rerun: 'npx tsx scripts/validate-new-postmortems.ts' },
  { name: 'validate-new-augmentations', command: 'npx tsx scripts/validate-new-augmentations.ts', rerun: 'npx tsx scripts/validate-new-augmentations.ts' },
  { name: 'check-mcp-lockfiles', command: 'npx tsx scripts/check-mcp-lockfiles.ts', rerun: 'npx tsx scripts/check-mcp-lockfiles.ts' },
  { name: 'check-cloud-service-lockfile-parity', command: 'npx tsx scripts/check-cloud-service-lockfile-parity.ts', rerun: 'npx tsx scripts/check-cloud-service-lockfile-parity.ts' },
  { name: 'check-e2e-timeout-budget', command: 'npx tsx scripts/check-e2e-timeout-budget.ts', rerun: 'npx tsx scripts/check-e2e-timeout-budget.ts' },
  // Contract gate (260531_ci_aware_startup_probe_timeout, recs7 #28): an E2E startup SAFETY-abort
  // timeout (STARTUP_PROBE_TIMEOUT_MS in tests/e2e/test-utils.ts) must stay STRICTLY ABOVE the
  // documented CI startup PERF budget (warnThreshold in tests/e2e/perf-timing-signals.spec.ts) —
  // a 5000ms probe under a 6000ms CI startup envelope is the exact false-SAFETY-ABORT incident.
  // Distinct from check-e2e-timeout-budget (which guards fixed firstWindow waits ABOVE 30s).
  { name: 'check-e2e-startup-safety-budget', command: 'npx tsx scripts/check-e2e-startup-safety-budget.ts', rerun: 'npx tsx scripts/check-e2e-startup-safety-budget.ts' },
  { name: 'check-mcp-config-drift', command: 'npx tsx scripts/check-mcp-config-drift.ts', rerun: 'npx tsx scripts/check-mcp-config-drift.ts' },
  { name: 'check-orphaned-mcp-fixture-refs', command: 'npx tsx scripts/check-orphaned-mcp-fixture-refs.ts', rerun: 'npx tsx scripts/check-orphaned-mcp-fixture-refs.ts' },
  { name: 'check-hubspot-telemetry-salt', command: 'npx tsx scripts/check-hubspot-telemetry-salt.ts', rerun: 'npx tsx scripts/check-hubspot-telemetry-salt.ts' },
  { name: 'check-mcp-cohort-parity', command: 'npx tsx scripts/check-mcp-cohort-parity.ts', rerun: 'npx tsx scripts/check-mcp-cohort-parity.ts' },
  // Every @mindstone/mcp-server-* pin in the connector catalog must resolve to
  // a CONNECTOR_RELEASE_MAPPINGS entry or a documented EXCLUDED_PACKAGES
  // exclusion — otherwise the connector is silently unreleasable via
  // `npm run mcp:release`. See docs/plans/260611_mcp-landing-process/PLAN.md Stage 4.
  { name: 'check-release-mapping-completeness', command: 'npx tsx scripts/check-release-mapping-completeness.ts', rerun: 'npx tsx scripts/check-release-mapping-completeness.ts' },
  // Fail-closed release security policy: MCP releases must require a §13
  // review artifact and an exact one-shot push token; skip envs and
  // AUTO_APPROVE must not bypass those gates.
  { name: 'validate:mcp-release-security-policy', command: 'npx tsx scripts/validate-mcp-release-security-policy.ts', rerun: 'npx tsx scripts/validate-mcp-release-security-policy.ts' },
  // Meta-gate (260611_fix-mcp-equivalence-gate Stage 4 / postmortem rec #1): every SKIP-capable
  // gate wired into validate:fast (one that can exit 0 on a missing-environment precondition) must
  // be declared in scripts/skip-capable-gate-manifest.ts as either a strict CI leg (REQUIRE_*=1 env
  // verified present in its workflow) or an explicit exclusion with an honest reason. Two-way
  // staleness check kills the "guard rots to a permanent SKIP" class by construction — the exact
  // shape that hid the inert atomic-helper equivalence gate for ~5 weeks.
  { name: 'check-skip-capable-gate-strictness', command: 'npx tsx scripts/check-skip-capable-gate-strictness.ts', rerun: 'npx tsx scripts/check-skip-capable-gate-strictness.ts' },
  // Every validate:fast-wired gate script must itself be type-checked (in tsconfig.node.json
  // "include"). Kills the "new gate ships un-type-checked because the Scripts ratchet can't see it"
  // class by construction; ratchets against scripts/typecheck-coverage-baseline.json (shrink-only).
  { name: 'validate:typecheck-coverage', command: 'npm run validate:typecheck-coverage' },
  { name: 'validate:super-mcp-version-codegen', command: 'npx tsx scripts/generate-super-mcp-version.ts --check', rerun: 'npx tsx scripts/generate-super-mcp-version.ts --check  # use without --check to refresh' },
  { name: 'validate:super-mcp-gitsha-parity', command: 'npm run validate:super-mcp-gitsha-parity' },
  { name: 'validate:submodule-pin-ancestry', command: 'npm run validate:submodule-pin-ancestry' },
  { name: 'check-bridge-state-readers', command: 'npx tsx scripts/check-bridge-state-readers.ts', rerun: 'npx tsx scripts/check-bridge-state-readers.ts' },
  { name: 'validate:parity', command: 'npx vitest run tests/parity', rerun: 'npx vitest run tests/parity' },
  {
    name: 'validate:tiebreaker',
    command: 'npx vitest run tests/parity/__tests__/tiebreakerScenarios.test.ts src/core/services/__tests__/conflictDetector.tiebreaker.test.ts',
    rerun: 'npx vitest run tests/parity/__tests__/tiebreakerScenarios.test.ts src/core/services/__tests__/conflictDetector.tiebreaker.test.ts',
  },
  { name: 'check-conversation-state-parity', command: 'npx tsx scripts/check-conversation-state-parity.ts', rerun: 'npx tsx scripts/check-conversation-state-parity.ts' },
  { name: 'validate:event-envelope-codegen', command: 'npx tsx scripts/generate-event-envelope-validator.ts --check', rerun: 'npx tsx scripts/generate-event-envelope-validator.ts --check  # use without --check to refresh' },
  { name: 'check-office-package-version', command: 'npx tsx scripts/check-office-package-version.ts', rerun: 'npx tsx scripts/check-office-package-version.ts' },
  { name: 'check-persona-eligibility', command: 'npx tsx scripts/check-persona-eligibility.ts', rerun: 'npx tsx scripts/check-persona-eligibility.ts' },
  // Operator field producer-consumer precedence (recs8 #19 / 260531 Stage-8 postmortem):
  // a NEW OperatorDefinition precedence field (e.g. consultationPrompt over body, displayName
  // over name) must be wired AND its declared final consumers must not read only the older
  // field. Registry-driven (precedence is documented intent, not inferable).
  { name: 'validate:operator-field-precedence', command: 'npm run validate:operator-field-precedence' },
  // BotQA privacy-guard prompt sync (recs8 #36 / 260504 postmortem): the production prompt
  // (botQAService.ts answerFromTranscript) and the eval reproduction (evals/botqa-transcript.ts)
  // privacy bullet must stay byte-identical modulo ${ownerName}; replaces the PRIVACY-GUARD
  // human-process comment with static enforcement.
  { name: 'validate:botqa-privacy-prompt-sync', command: 'npm run validate:botqa-privacy-prompt-sync' },
  // BotQA privacy CI gate anti-rot (recs8 #36 / 260504 postmortem): static structural assertion
  // that the existing privacy enforcement can't silently rot — PR-path coverage present, the
  // 0-tolerance privacy hard-exit guard intact in the harness, >=1 privacy fixture.
  { name: 'validate:botqa-privacy-ci-gate', command: 'npm run validate:botqa-privacy-ci-gate' },
  { name: 'check-autopilot-no-mcp', command: 'npx tsx scripts/check-autopilot-no-mcp.ts', rerun: 'npx tsx scripts/check-autopilot-no-mcp.ts' },
  { name: 'validate:circular-deps', command: 'npm run validate:circular-deps' },
  { name: 'validate:core-imports', command: 'npm run validate:core-imports' },
  { name: 'validate:transitive-electron-deps', command: 'npm run validate:transitive-electron-deps' },
  { name: 'validate:cross-surface-imports', command: 'npm run validate:cross-surface-imports' },
  { name: 'validate:cross-surface-parity-gap', command: 'npm run validate:cross-surface-parity-gap' },
  { name: 'check-no-prod-test-imports', command: 'npx tsx scripts/check-no-prod-test-imports.ts', rerun: 'npx tsx scripts/check-no-prod-test-imports.ts' },
  // Only-door gate (260619_cloud-symlink-indexing Stage 4a): every cloud-relevant
  // index removal (LanceDB removeFile(s)FromIndex) must route through the Removal
  // Coordinator — a direct call outside the allowlist can half-purge/wipe the
  // last-known index on a transient cloud outage. Catches a planted violation.
  { name: 'check-index-removal-coordinator', command: 'npx tsx scripts/check-index-removal-coordinator.ts', rerun: 'npx tsx scripts/check-index-removal-coordinator.ts' },
  // Readlink-only gate (260619_cloud-symlink-indexing Stage 5, RS-F5): the
  // cloud-liveness helpers (readlinkChain / cloudLivenessProbe.types /
  // cloudSpaceContainment) must never issue a target-dereferencing fs call
  // (realpath/stat/readdir/access) on a possibly-dead cloud mount — readlinkSync
  // only. Catches a planted violation that would re-park the libuv pool.
  { name: 'check-cloud-readlink-only', command: 'npx tsx scripts/check-cloud-readlink-only.ts', rerun: 'npx tsx scripts/check-cloud-readlink-only.ts' },
  // SYNTHESIS S1/S3: boundary-governed consumer files must route cloud-capable
  // workspace fs through boundedWorkspaceFs (never a raw fs.stat/statSync/… on a
  // possibly-dead cloud mount). Set is empty in S1; populated as consumers migrate.
  { name: 'check-workspace-fs-boundary', command: 'npx tsx scripts/check-workspace-fs-boundary.ts', rerun: 'npx tsx scripts/check-workspace-fs-boundary.ts' },
  { name: 'validate:git-exec-maxbuffer', command: 'npm run validate:git-exec-maxbuffer' },
  { name: 'validate:cross-surface-registration-parity', command: 'npm run validate:cross-surface-registration-parity' },
  { name: 'validate:macos-clt-shim-guard', command: 'npm run validate:macos-clt-shim-guard' },
  // Anti-rot (260519_electron_forge_postpackage_heap_cap): every package.json script that
  // invokes `electron-forge package|make` must launch the Forge PARENT with the 8 GB heap
  // bump (NODE_OPTIONS=--max-old-space-size=8192 before the electron-forge token, or an
  // approved wrapper) — setting NODE_OPTIONS inside forge.config.cjs is too late for the
  // process that runs the postPackage hook, which OOMed. Guards against the next direct
  // invocation dropping the prefix.
  { name: 'validate:forge-heap-prefix', command: 'npm run validate:forge-heap-prefix' },
  {
    name: 'validate:sentry-breadcrumb-scrub',
    command: 'npx tsx scripts/check-sentry-breadcrumb-scrub.ts',
    rerun: 'npx tsx scripts/check-sentry-breadcrumb-scrub.ts',
  },
  // Desktop/mobile log-allowlist parity: mobile/src/utils/logFilter.ts is a deliberate,
  // security-critical COPY of src/core/utils/logFieldFilter.ts's SAFE/SANITIZED_LOG_FIELDS
  // (the bug-report privacy gate). This is the pre-push backstop that the two copies don't
  // drift — the same "two copies in sync" class as the validate:*-parity guards above. It
  // was previously a full-tier-only vitest test, so a change touching either allowlist could
  // ship without ever running it (which is how a false-positive comment-parse drift landed).
  {
    name: 'validate:log-filter-allowlist-parity',
    command: 'npx vitest run src/shared/utils/__tests__/logFilterSync.test.ts',
    rerun: 'npx vitest run src/shared/utils/__tests__/logFilterSync.test.ts',
  },
  { name: 'validate:cloud-bootstrap-policy', command: 'npm run validate:cloud-bootstrap-policy' },
  // Sibling of cloud-bootstrap-policy for the OSS desktop boot-crash class: no
  // production file under src/core/** may read a PlatformConfig-backed accessor
  // (getPlatformConfig/isPackaged/getDataPath/getAppVersion/getAppRoot/
  // getNativeModuleRequire) at module-load (import) time — that throws
  // "PlatformConfig not initialized" when imported before bootstrap wires it
  // (the toolIndexService.ts crash). Calls deferred into function/closure bodies
  // are fine.
  { name: 'validate:core-bootstrap-policy', command: 'npm run validate:core-bootstrap-policy' },
  // validate:cloud-channel-parity is batched in scripts/groups/registry-parity.ts.
  { name: 'validate:lancedb-predicates', command: 'npm run validate:lancedb-predicates' },
  { name: 'validate:settings-bootstrap', command: 'npm run validate:settings-bootstrap' },
  { name: 'validate:settings-search', command: 'npm run validate:settings-search' },
  { name: 'validate:alias-integrity', command: 'npm run validate:alias-integrity' },
  // Skip-safe in validate:fast: needs a BUILT renderer bundle (.vite/renderer),
  // which doesn't exist pre-commit, so it prints an advisory + exits 0 (clean
  // skip) here. Its teeth are post-package in the release pipeline, run with
  // RENDERER_BUNDLE_SINGLETONS_ENFORCE=1. Catches the 260422 dual-React /
  // null-useState class. Mirrors the warn-first posture of
  // validate:boundary-contract-coverage / validate:test-coverage-delta.
  { name: 'validate:renderer-bundle-singletons', command: 'npm run validate:renderer-bundle-singletons' },
  {
    name: 'validate:worker-build-smoke',
    command: 'npm run validate:worker-build-smoke',
    rerun: 'npm run validate:worker-build-smoke',
  },
  { name: 'validate:plugin-permissions', command: 'npm run validate:plugin-permissions' },
  { name: 'validate:app-bridge-registry', command: 'npm run validate:app-bridge-registry' },
  { name: 'validate:extend-skill-allowlist', command: 'npm run validate:extend-skill-allowlist' },
  { name: 'validate:no-guarded-transform-reexports', command: 'npm run validate:no-guarded-transform-reexports' },  { name: 'validate:r2-consumer-disposition', command: 'npm run validate:r2-consumer-disposition' },
  { name: 'validate:blur-budget', command: 'npm run validate:blur-budget' },
  { name: 'validate:diagnostic-events', command: 'npm run validate:diagnostic-events' },
  { name: 'validate:daily-spark-no-leak', command: 'npm run validate:daily-spark-no-leak' },
  { name: 'validate:prompt-registry-contract', command: 'npm run validate:prompt-registry-contract' },
  { name: 'validate:known-conditions', command: 'npm run validate:known-conditions' },
  { name: 'validate:postmortem-recommendations', command: 'npm run validate:postmortem-recommendations', rerun: 'npm run regenerate:postmortem-recommendations' },
  { name: 'validate:credential-writes', command: 'npm run validate:credential-writes' },
  { name: 'validate:atomic-helper-equivalence', command: 'npm run validate:atomic-helper-equivalence' },
  { name: 'validate:connector-auth-wiring', command: 'npm run validate:connector-auth-wiring' },
  { name: 'validate:connector-catalog-provider-keys', command: 'npm run validate:connector-catalog-provider-keys' },
  { name: 'validate:connector-catalog-schema', command: 'npm run validate:connector-catalog-schema' },
  { name: 'validate:mcp-release-parity', command: 'npm run validate:mcp-release-parity' },
  { name: 'packages/browser-extension build', command: 'npm --prefix packages/browser-extension run build', rerun: 'npm --prefix packages/browser-extension run build' },
  { name: 'validate:extension-dist', command: 'npm run validate:extension-dist' },
  { name: 'validate:host-tool-contracts', command: 'npm run validate:host-tool-contracts' },
  { name: 'validate:pointer-comments', command: 'npm run validate:pointer-comments' },
  { name: 'validate:ts-ratchet', command: 'npm run validate:ts-ratchet' },
  { name: 'validate:bounded-walkers', command: 'npm run validate:bounded-walkers' },
  { name: 'validate:feature-gate-budget', command: 'npm run validate:feature-gate-budget' },
  { name: 'validate:super-mcp-build', command: 'npm run validate:super-mcp-build' },
  // Step-registry + classifier-baseline live check: runs the committed
  // step-identity baseline (scripts/validate-fast-step-baseline.json) and the
  // per-script classifier-verdict baseline (scripts/validate-fast-classifier-baseline.json)
  // against the live STEPS and package.json — no .snap file, no vitest, always-on.
  // Regenerate both baselines via --write-step-baseline / --write-classifier-baseline
  // in the SAME commit as the package.json / STEPS change.
  // SAFE: --check-step-baseline early-returns before the STEPS loop — no recursion.
  { name: 'validate:step-registry', command: 'npm run validate:step-registry' },
];

const BANNER_WIDTH = 63;
const BANNER_RULE = '═'.repeat(BANNER_WIDTH);

// ---------------------------------------------------------------------------
// Cheap-spawn step resolution (Stage 1, docs/plans/260611_prepush-gate-speedup)
// ---------------------------------------------------------------------------

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(RUNNER_DIR, '..');
const STEP_BASELINE_PATH = path.join(RUNNER_DIR, 'validate-fast-step-baseline.json');
const CLASSIFIER_BASELINE_PATH = path.join(RUNNER_DIR, 'validate-fast-classifier-baseline.json');

export interface ResolvedStepCommand {
  /**
   * 'transformed' = spawn `argv` directly (no shell, npm/npx skipped);
   * 'verbatim' = run `step.command` through the shell exactly as before.
   */
  readonly kind: 'transformed' | 'verbatim';
  /** Present iff kind === 'transformed': exact argv to spawn. */
  readonly argv?: readonly string[];
  /** Human-readable actual executed command (argv joined, or step.command). */
  readonly display: string;
}

export interface ScriptClassification {
  readonly transformable: boolean;
  /** Why the command was (not) transformable — used in tests and debugging. */
  readonly reason: string;
  readonly script?: string;
  readonly args?: readonly string[];
}

/**
 * Every argv token must match this conservative charset. Excludes shell
 * metacharacters, quotes, backslashes, whitespace and expansion syntax by
 * construction, so a command that tokenizes cleanly is safe to spawn
 * shell-free. Deliberately tight: anything unusual falls back to `npm run`.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_\-=./:@,]+$/;
// scripts/ plus mirror/ — the OSS leak-gate/mirror tooling lives under mirror/
// (moved off the public surface) but is still wired into validate:fast.
const SCRIPT_PATH = /^(scripts|mirror)\/[A-Za-z0-9_\-./]+\.ts$/;
/** Tool tokens that must never be transformed even if the shape ever matched. */
const TOOL_DENYLIST = new Set(['vitest', 'eslint', 'stylelint', 'playwright', 'cross-env', 'cd', 'electron-forge']);
/** Loader/config flags that change tsx semantics — require the npm/npx path. */
const FLAG_DENYLIST = new Set(['--tsconfig', '--require', '-r', '--loader', '--experimental-loader']);

/**
 * Exact argv-token classifier (NOT a broad regex — see PLAN.md Amendment 2).
 * Transformable iff the command is exactly:
 *   `[npx] tsx scripts/<path>.ts [simple args]`   or
 *   `node --import tsx scripts/<path>.ts [simple args]`
 * with no env-var prefixes, no shell operators, no loader/tsconfig flags.
 */
export function classifyCommand(command: string): ScriptClassification {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') {
    return { transformable: false, reason: 'empty command' };
  }
  const unsafe = tokens.find((t) => !SAFE_TOKEN.test(t));
  if (unsafe !== undefined) {
    return { transformable: false, reason: `token outside safe charset (shell operator, quote, or env assignment?): ${JSON.stringify(unsafe)}` };
  }
  if (tokens.some((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t))) {
    return { transformable: false, reason: 'env-var prefix' };
  }
  const denied = tokens.find((t) => TOOL_DENYLIST.has(t));
  if (denied !== undefined) {
    return { transformable: false, reason: `denylisted tool token: ${denied}` };
  }
  const flagged = tokens.find((t) => FLAG_DENYLIST.has(t));
  if (flagged !== undefined) {
    return { transformable: false, reason: `loader/config flag requires npm path: ${flagged}` };
  }
  let rest: string[];
  if (tokens[0] === 'npx' && tokens[1] === 'tsx') {
    rest = tokens.slice(2);
  } else if (tokens[0] === 'tsx') {
    rest = tokens.slice(1);
  } else if (tokens[0] === 'node' && tokens[1] === '--import' && tokens[2] === 'tsx') {
    rest = tokens.slice(3);
  } else {
    return { transformable: false, reason: 'not an [npx] tsx / node --import tsx invocation' };
  }
  const [script, ...args] = rest;
  if (script === undefined || !SCRIPT_PATH.test(script) || script.includes('..')) {
    return { transformable: false, reason: `first argument is not a scripts/ or mirror/ <path>.ts file: ${script ?? '<none>'}` };
  }
  return { transformable: true, reason: 'simple tsx script invocation', script, args };
}

const NPM_RUN_COMMAND = /^npm run (\S+)$/;

/**
 * Resolve a step's command to its cheapest equivalent spawn.
 * `npm run <name>` steps are looked up in package.json at runtime (so
 * package.json stays the single source of truth — zero drift by
 * construction); both looked-up and literal commands go through
 * classifyCommand. Anything non-transformable runs verbatim (fail-open).
 */
export function resolveStepCommand(
  step: Step,
  pkgScripts: Readonly<Record<string, string | undefined>>,
): ResolvedStepCommand {
  const npmMatch = NPM_RUN_COMMAND.exec(step.command.trim());
  if (npmMatch && (pkgScripts[`pre${npmMatch[1]}`] !== undefined || pkgScripts[`post${npmMatch[1]}`] !== undefined)) {
    // npm run executes pre/post lifecycle hooks; a direct spawn would skip
    // them. None of today's validate:* scripts have hooks, but fall back by
    // construction so adding one later can't silently lose it.
    return { kind: 'verbatim', display: step.command };
  }
  const effective = npmMatch ? pkgScripts[npmMatch[1]] : step.command;
  if (effective === undefined) {
    // Unknown npm script — let npm produce its own loud error.
    return { kind: 'verbatim', display: step.command };
  }
  const classification = classifyCommand(effective);
  if (!classification.transformable || classification.script === undefined) {
    return { kind: 'verbatim', display: step.command };
  }
  const argv = ['node', '--import', 'tsx', classification.script, ...(classification.args ?? [])];
  return { kind: 'transformed', argv, display: argv.join(' ') };
}

let cachedPkgScripts: Record<string, string | undefined> | null = null;

function loadPackageJsonScripts(): Record<string, string | undefined> {
  if (cachedPkgScripts) return cachedPkgScripts;
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    cachedPkgScripts = parsed.scripts ?? {};
  } catch (err) {
    // Fail-open: every `npm run` step simply runs verbatim as before.
    process.stderr.write(
      `[run-validate-fast] warning: could not read package.json scripts (steps run verbatim): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    cachedPkgScripts = {};
  }
  return cachedPkgScripts;
}

/**
 * Compute the per-script classifier verdict map for every script in
 * package.json, in the same format recorded by the snapshot test today:
 *   transformable → "transform → node --import tsx <script> [args]"
 *   not transformable → "fallback (<reason>)"
 * This is the canonical computation used by both --write-classifier-baseline
 * and --check-step-baseline.
 */
function computeClassifierBaseline(
  pkgScripts: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(pkgScripts).sort()) {
    const script = pkgScripts[name];
    if (script === undefined) continue;
    const c = classifyCommand(script);
    result[name] = c.transformable
      ? `transform → node --import tsx ${[c.script, ...(c.args ?? [])].join(' ')}`
      : `fallback (${c.reason})`;
  }
  return result;
}

/**
 * Spawn env for transformed steps: clone process.env and PREPEND
 * node_modules/.bin to PATH — exact environmental parity with the npm/npx
 * launch paths, so a guard that shells out to a local binary behaves
 * identically whether the gate spawned it directly or the rerun hint went
 * through npm. (PLAN.md Amendment 2 / DA F3 — kills the gate-fails-but-
 * rerun-hint-passes divergence class.)
 */
export function spawnEnvWithLocalBin(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const binDir = path.join(REPO_ROOT, 'node_modules', '.bin');
  // PATH key casing varies by platform (PATH/Path); match case-insensitively.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const existing = env[pathKey];
  env[pathKey] = existing && existing.length > 0 ? `${binDir}${path.delimiter}${existing}` : binDir;
  return env;
}

// ---------------------------------------------------------------------------
// Step-identity baseline (kill-by-construction safety net for the step list)
// ---------------------------------------------------------------------------

export type StepIdentity =
  | { readonly kind: 'script'; readonly name: string; readonly script: string }
  | { readonly kind: 'command'; readonly name: string; readonly command: string }
  | { readonly kind: 'group-member'; readonly group: string; readonly member: string };

// Validate:fast-wired script files live under scripts/ and (since the OSS
// leak-gate/mirror tooling moved out of the public surface) mirror/.
const SCRIPT_FILE_TOKEN = /^(scripts|mirror)\/\S+\.(ts|tsx|mts|cts|mjs|js)$/;

/**
 * Compute one stable identity per protection unit:
 * - steps whose (npm-resolved) command references exactly one scripts/* file
 *   → `{ kind: 'script', name, script }` (renaming the file or pointing the
 *   npm script elsewhere changes the identity);
 * - everything else (lint, vitest suites, builds) → `{ kind: 'command' }`
 *   with the step's literal command;
 * - consolidated steps additionally expand one `group-member` identity per
 *   registered member (e.g. validate:testing-guards × GUARDS), so silently
 *   dropping a member of an already-consolidated step also fails the test.
 */
export function computeStepIdentities(
  steps: readonly Step[],
  pkgScripts: Readonly<Record<string, string | undefined>>,
  groupExpansions: Readonly<Record<string, readonly string[]>>,
): StepIdentity[] {
  const identities: StepIdentity[] = [];
  for (const step of steps) {
    const npmMatch = NPM_RUN_COMMAND.exec(step.command.trim());
    const effective = (npmMatch ? pkgScripts[npmMatch[1]] : undefined) ?? step.command;
    const scriptTokens = effective
      .trim()
      .split(/\s+/)
      .filter((t) => SCRIPT_FILE_TOKEN.test(t));
    if (scriptTokens.length === 1) {
      identities.push({ kind: 'script', name: step.name, script: scriptTokens[0] });
    } else {
      identities.push({ kind: 'command', name: step.name, command: step.command });
    }
    const members = groupExpansions[step.name];
    if (members) {
      for (const member of members) {
        identities.push({ kind: 'group-member', group: step.name, member });
      }
    }
  }
  return identities;
}

/**
 * Registered group expansions for the baseline: consolidated steps whose
 * members live in their own registry. Dynamic import keeps the guard modules
 * off the runner's hot path.
 */
export async function loadGroupExpansions(): Promise<Record<string, readonly string[]>> {
  const { GUARDS } = await import('./check-testing-guards');
  const { GROUP_NAME: sourcePolicyGroup, GUARD_NAMES: sourcePolicyMembers } = await import(
    './groups/source-policy-chokepoints'
  );
  const { GROUP_NAME: registryParityGroup, GUARD_NAMES: registryParityMembers } = await import(
    './groups/registry-parity'
  );
  const { GROUP_NAME: antiRotGroup, GUARD_NAMES: antiRotMembers } = await import(
    './groups/anti-rot-source-checks'
  );
  return {
    'validate:testing-guards': GUARDS.map((g) => g.name),
    [sourcePolicyGroup]: sourcePolicyMembers,
    [registryParityGroup]: registryParityMembers,
    [antiRotGroup]: antiRotMembers,
  };
}

function defaultRerun(step: Step): string {
  if (step.rerun) return step.rerun;
  return `npm run ${step.name}`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function detectSurface(): 'local' | 'ci' {
  return process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true'
    ? 'ci'
    : 'local';
}

function readGitField(args: readonly string[]): string {
  try {
    // git-exec-allow: validate timing metadata reads one bounded git field
    const result = spawnSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return 'unknown';
    const value = result.stdout.trim();
    return value.length > 0 ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function emitTimingMarker(step: Step, durationMs: number, exitCode: number): void {
  process.stderr.write(
    `[PREPUSH_TIMING] step=${step.name} duration_ms=${durationMs} exit_code=${exitCode}\n`,
  );
}

function defaultTimingArtifactPath(): string {
  return path.join(process.cwd(), '.local', 'validate-fast-timings.json');
}

function resolveTimingArtifactPath(artifactPath?: string): string {
  return artifactPath ?? process.env.VALIDATE_FAST_TIMINGS_PATH ?? defaultTimingArtifactPath();
}

function writeTimingArtifact(artifact: ValidateFastTimingArtifact, artifactPath: string): void {
  try {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[run-validate-fast] warning: failed to write validate-fast timings artifact: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function printFailureBanner(opts: {
  step: Step;
  exitCode: number;
  signal: NodeJS.Signals | null;
  stepMs: number;
  totalMs: number;
  /** Actual executed command when it differs from the step command (transformed spawns). */
  executedCommand?: string;
}): void {
  const { step, exitCode, signal, stepMs, totalMs, executedCommand } = opts;
  const exitDescription = signal != null ? `signal ${signal}` : `exit ${exitCode}`;
  const lines = [
    '',
    BANNER_RULE,
    '  validate:fast FAILED',
    `  step:    ${step.name}`,
    `  ${exitDescription}`,
    `  elapsed: ${formatSeconds(stepMs)} (step) / ${formatSeconds(totalMs)} (total)`,
    `  rerun:   ${defaultRerun(step)}`,
    ...(executedCommand !== undefined ? [`  ran:     ${executedCommand}`] : []),
    BANNER_RULE,
    '',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

function runStep(step: Step, resolved: ResolvedStepCommand): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    const child =
      resolved.kind === 'transformed' && resolved.argv && resolved.argv.length > 0
        ? // Shell-free direct spawn of the same script file npm/npx would have
          // reached, with node_modules/.bin prepended for env parity.
          spawn(resolved.argv[0], [...resolved.argv.slice(1)], {
            stdio: 'inherit',
            env: spawnEnvWithLocalBin(),
            // npm run always executes from the package.json dir; anchor the
            // transformed spawn there too so script paths stay repo-relative
            // even if the runner is ever invoked from elsewhere.
            cwd: REPO_ROOT,
          })
        : spawn(step.command, {
            shell: true,
            stdio: 'inherit',
          });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('exit', (code, signal) => {
      resolve({ exitCode: code ?? (signal != null ? 130 : 1), signal });
    });
  });
}

interface RunState {
  readonly runId: string;
  readonly startedAt: string;
  readonly steps: StepTiming[];
  readonly artifactPath: string;
  readonly writeTimingArtifact: TimingArtifactWriter;
}

let activeRun: RunState | null = null;
let signalHandlersInstalled = false;
let sigintHandler: (() => void) | null = null;
let sigtermHandler: (() => void) | null = null;

function installSignalHandlersOnce(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  sigintHandler = () => onValidateFastSignal('SIGINT');
  sigtermHandler = () => onValidateFastSignal('SIGTERM');
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
}

function beginRun(state: RunState, opts: { installSignalHandlers: boolean }): void {
  activeRun = state;
  if (opts.installSignalHandlers) {
    installSignalHandlersOnce();
  }
}

function finishRun(): void {
  const state = activeRun;
  if (!state) return;
  activeRun = null;
  try {
    state.writeTimingArtifact(
      {
        run_id: state.runId,
        started_at: state.startedAt,
        ended_at: new Date().toISOString(),
        surface: detectSurface(),
        git_sha: readGitField(['rev-parse', 'HEAD']),
        branch: readGitField(['rev-parse', '--abbrev-ref', 'HEAD']),
        steps: state.steps,
      },
      state.artifactPath,
    );
  } catch {
    // Best-effort — never let artefact-write errors mask the real exit code.
  }
}

function signalExitCode(signal: NodeJS.Signals): 130 | 143 {
  return signal === 'SIGINT' ? 130 : 143;
}

function onValidateFastSignal(
  signal: NodeJS.Signals,
  exitProcess: (code: 130 | 143) => never = process.exit,
): never {
  finishRun();
  exitProcess(signalExitCode(signal));
  throw new Error(`[run-validate-fast] process.exit returned after ${signal}`);
}

function __resetValidateFastLifecycleForTests(): void {
  activeRun = null;
  if (sigintHandler) {
    process.off('SIGINT', sigintHandler);
  }
  if (sigtermHandler) {
    process.off('SIGTERM', sigtermHandler);
  }
  sigintHandler = null;
  sigtermHandler = null;
  signalHandlersInstalled = false;
}

async function runValidateFast(
  args: readonly string[],
  opts: RunValidateFastOptions = {},
): Promise<number> {
  const stepsToRun = opts.steps ?? STEPS;
  const runStepImpl = opts.runStep ?? runStep;
  const writeTimingArtifactImpl = opts.writeTimingArtifact ?? writeTimingArtifact;
  const artifactPath = resolveTimingArtifactPath(opts.artifactPath);
  const shouldInstallSignalHandlers = opts.installSignalHandlers ?? true;

  if (args.includes('--list')) {
    const pkgScripts = loadPackageJsonScripts();
    for (const step of stepsToRun) {
      const resolved = resolveStepCommand(step, pkgScripts);
      process.stdout.write(`${step.name}\t${defaultRerun(step)}\t${resolved.display}\n`);
    }
    return 0;
  }
  if (args.includes('--write-step-baseline')) {
    const identities = computeStepIdentities(
      stepsToRun,
      loadPackageJsonScripts(),
      await loadGroupExpansions(),
    );
    fs.writeFileSync(STEP_BASELINE_PATH, `${JSON.stringify(identities, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `[run-validate-fast] wrote ${identities.length} step identities to ${path.relative(REPO_ROOT, STEP_BASELINE_PATH)}\n` +
        '[run-validate-fast] commit the baseline diff in the SAME commit as the step change so reviewers see it.\n',
    );
    return 0;
  }
  if (args.includes('--write-classifier-baseline')) {
    const pkgScripts = loadPackageJsonScripts();
    const baseline = computeClassifierBaseline(pkgScripts);
    fs.writeFileSync(CLASSIFIER_BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `[run-validate-fast] wrote ${Object.keys(baseline).length} classifier verdicts to ${path.relative(REPO_ROOT, CLASSIFIER_BASELINE_PATH)}\n` +
        '[run-validate-fast] commit the baseline diff in the SAME commit as the package.json script change so reviewers see it.\n',
    );
    return 0;
  }
  if (args.includes('--check-step-baseline')) {
    // CRITICAL: early-return — never falls through into the STEPS execution loop,
    // so validate:step-registry wired as a STEPS entry is safe (no recursion).
    const pkgScripts = loadPackageJsonScripts();

    // (a) Step-identity drift check (mirrors the vitest set-equality assertion)
    const liveIdentities = computeStepIdentities(stepsToRun, pkgScripts, await loadGroupExpansions());
    let stepBaselineIdentities: StepIdentity[];
    try {
      stepBaselineIdentities = JSON.parse(
        fs.readFileSync(STEP_BASELINE_PATH, 'utf8'),
      ) as StepIdentity[];
    } catch (err) {
      process.stderr.write(
        `[validate:step-registry] FAIL: could not read step baseline at ${STEP_BASELINE_PATH}: ${err instanceof Error ? err.message : String(err)}\n` +
          '  Regenerate with: npx tsx scripts/run-validate-fast.ts --write-step-baseline\n',
      );
      return 1;
    }

    function identityKey(identity: StepIdentity): string {
      switch (identity.kind) {
        case 'script':
          return `script | ${identity.name} | ${identity.script}`;
        case 'command':
          return `command | ${identity.name} | ${identity.command}`;
        case 'group-member':
          return `group-member | ${identity.group} | ${identity.member}`;
      }
    }

    const liveKeys = liveIdentities.map(identityKey);
    const baselineKeys = stepBaselineIdentities.map(identityKey);
    const liveSet = new Set(liveKeys);
    const baselineSet = new Set(baselineKeys);
    const stepRemoved = [...baselineSet].filter((k) => !liveSet.has(k));
    const stepAdded = [...liveSet].filter((k) => !baselineSet.has(k));

    // (b) Classifier verdict drift check
    const liveClassifier = computeClassifierBaseline(pkgScripts);
    let committedClassifier: Record<string, string>;
    try {
      committedClassifier = JSON.parse(
        fs.readFileSync(CLASSIFIER_BASELINE_PATH, 'utf8'),
      ) as Record<string, string>;
    } catch (err) {
      process.stderr.write(
        `[validate:step-registry] FAIL: could not read classifier baseline at ${CLASSIFIER_BASELINE_PATH}: ${err instanceof Error ? err.message : String(err)}\n` +
          '  Regenerate with: npx tsx scripts/run-validate-fast.ts --write-classifier-baseline\n',
      );
      return 1;
    }

    const classifierAdded = Object.keys(liveClassifier).filter((k) => !(k in committedClassifier));
    const classifierRemoved = Object.keys(committedClassifier).filter((k) => !(k in liveClassifier));
    const classifierChanged = Object.keys(liveClassifier).filter(
      (k) => k in committedClassifier && liveClassifier[k] !== committedClassifier[k],
    );

    const hasDrift =
      stepRemoved.length > 0 ||
      stepAdded.length > 0 ||
      classifierAdded.length > 0 ||
      classifierRemoved.length > 0 ||
      classifierChanged.length > 0;

    if (hasDrift) {
      const lines: string[] = ['[validate:step-registry] FAIL: baseline drift detected.', ''];
      if (stepRemoved.length > 0) {
        lines.push(
          'STEP IDENTITIES REMOVED from the live gate (a guard that ran yesterday no longer runs):',
          ...stepRemoved.map((k) => `  - ${k}`),
          '',
        );
      }
      if (stepAdded.length > 0) {
        lines.push(
          'STEP IDENTITIES ADDED to the live gate (not yet in the baseline):',
          ...stepAdded.map((k) => `  + ${k}`),
          '',
        );
      }
      if (classifierAdded.length > 0) {
        lines.push(
          'CLASSIFIER BASELINE: new package.json scripts (not yet in baseline):',
          ...classifierAdded.map((k) => `  + ${k}: ${liveClassifier[k]}`),
          '',
        );
      }
      if (classifierRemoved.length > 0) {
        lines.push(
          'CLASSIFIER BASELINE: package.json scripts removed (still in baseline):',
          ...classifierRemoved.map((k) => `  - ${k}`),
          '',
        );
      }
      if (classifierChanged.length > 0) {
        lines.push(
          'CLASSIFIER BASELINE: package.json scripts changed verdict:',
          ...classifierChanged.map((k) => `  ~ ${k}: ${committedClassifier[k]} → ${liveClassifier[k]}`),
          '',
        );
      }
      lines.push(
        'Regenerate both baselines in the SAME commit as your package.json / STEPS change:',
        '  npx tsx scripts/run-validate-fast.ts --write-step-baseline',
        '  npx tsx scripts/run-validate-fast.ts --write-classifier-baseline',
        '',
      );
      process.stderr.write(lines.join('\n'));
      return 1;
    }

    process.stdout.write('[validate:step-registry] OK: step-registry and classifier baselines match.\n');
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'Usage: tsx scripts/run-validate-fast.ts [--list]',
        '',
        'Runs the validate:fast step chain sequentially. On failure,',
        'prints a banner to stderr identifying which step failed and',
        'how to rerun just that step.',
        '',
        'Options:',
        '  --list                    Print step list + rerun hints + resolved commands and exit.',
        '  --write-step-baseline     Regenerate scripts/validate-fast-step-baseline.json.',
        '  --write-classifier-baseline  Regenerate scripts/validate-fast-classifier-baseline.json.',
        '  --check-step-baseline     Verify the step-registry + classifier baselines match the live package.json/STEPS (= validate:step-registry inside validate:fast).',
        '  --help                    Print this message.',
        '',
      ].join('\n'),
    );
    return 0;
  }

  const overallStart = Date.now();
  const startedAt = new Date(overallStart).toISOString();
  const runId = randomUUID();
  const steps: StepTiming[] = [];
  beginRun(
    {
      runId,
      startedAt,
      steps,
      artifactPath,
      writeTimingArtifact: writeTimingArtifactImpl,
    },
    { installSignalHandlers: shouldInstallSignalHandlers },
  );
  const finish = finishRun;
  const pkgScripts = loadPackageJsonScripts();
  for (const step of stepsToRun) {
    const resolved = resolveStepCommand(step, pkgScripts);
    const executedCommand = resolved.kind === 'transformed' ? resolved.display : undefined;
    const stepStart = Date.now();
    let result: StepResult;
    try {
      result = await runStepImpl(step, resolved);
    } catch (err) {
      const stepMs = Date.now() - stepStart;
      const totalMs = Date.now() - overallStart;
      steps.push({ name: step.name, duration_ms: stepMs, exit_code: 1, resolved_command: resolved.display });
      emitTimingMarker(step, stepMs, 1);
      process.stderr.write(
        `[run-validate-fast] spawn failed for step '${step.name}': ${err instanceof Error ? err.message : String(err)}\n`,
      );
      printFailureBanner({
        step,
        exitCode: 1,
        signal: null,
        stepMs,
        totalMs,
        executedCommand,
      });
      finish();
      return 1;
    }
    const stepMs = Date.now() - stepStart;
    steps.push({
      name: step.name,
      duration_ms: stepMs,
      exit_code: result.exitCode,
      resolved_command: resolved.display,
    });
    emitTimingMarker(step, stepMs, result.exitCode);
    if (result.exitCode !== 0) {
      const totalMs = Date.now() - overallStart;
      printFailureBanner({
        step,
        exitCode: result.exitCode,
        signal: result.signal,
        stepMs,
        totalMs,
        executedCommand,
      });
      finish();
      return result.exitCode;
    }
  }
  finish();
  return 0;
}

async function main(args: readonly string[]): Promise<number> {
  return runValidateFast(args);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[run-validate-fast] unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      finishRun();
      process.exitCode = 1;
    });
}

export {
  STEPS,
  STEP_BASELINE_PATH,
  CLASSIFIER_BASELINE_PATH,
  computeClassifierBaseline,
  defaultRerun,
  printFailureBanner,
  writeTimingArtifact,
  runStep,
  runValidateFast,
  main,
  installSignalHandlersOnce,
  onValidateFastSignal,
  __resetValidateFastLifecycleForTests,
};
