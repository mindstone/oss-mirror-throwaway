/**
 * Manifest of SKIP-capable validate:fast gates and how each is held strict.
 *
 * A "SKIP-capable" gate is a `scripts/check-*.ts` / `scripts/validate-*.ts`
 * wired into validate:fast that can exit 0 on a *missing-environment*
 * precondition (a sibling repo absent, no built bundle, not a git repo, a diff
 * it can't classify, …) — i.e. it can pass-by-skipping rather than pass-by-
 * verifying. That is the exact shape that let the atomic-helper equivalence
 * gate rot to a permanent SKIP for ~5 weeks while a credential-write helper
 * drifted (postmortem
 * docs-private/postmortems/260612_inert_atomic_helper_equivalence_gate_postmortem.md;
 * fix run docs/plans/260611_fix-mcp-equivalence-gate/PLAN.md Stage 4).
 *
 * This manifest is the AUTHORITATIVE list of those gates. The meta-gate
 * scripts/check-skip-capable-gate-strictness.ts verifies it stays honest in
 * BOTH directions (rot-proof, mirroring scripts/check-release-mapping-completeness.ts):
 *
 *   - Every script declared here (strict OR excluded) must still exist AND
 *     still match the conservative SKIP pattern. A declaration whose script no
 *     longer skip-capable is STALE and must be removed (a gate that lost its
 *     skip path shouldn't masquerade as one).
 *   - Every validate:fast script that matches the SKIP pattern must appear here
 *     (UNDECLARED ones fail the meta-gate) — so a new SKIP-capable gate can't
 *     be added without an explicit decision about how it runs strict. An entry
 *     whose script is no longer wired into validate:fast is also stale.
 *   - A STRICT entry names an env var (e.g. REQUIRE_MCP_OSS_EQUIVALENCE) and a
 *     workflow file; the meta-gate verifies the env var is actually WIRED there
 *     (a non-comment `ENV:`/`ENV=` line — a mention in a comment doesn't count;
 *     no full YAML semantics).
 *   - An EXCLUSION carries a human-readable reason (blank/trivial reasons are
 *     rejected) explaining why a SKIP path is acceptable-by-design, or honestly
 *     recording that there is no strict leg today.
 *
 * The detector deliberately over-flags (it can't distinguish a whole-gate
 * skip from a per-file "skipped" log without semantic analysis); the manifest
 * is where each flagged script is classified honestly. The gate's job is to
 * make that list explicit and force a decision on every new entry — NOT to
 * lie any gate green.
 */

/** A SKIP-capable gate held strict by a CI env flag in a named workflow. */
export interface StrictSkipCapableGate {
  /** Repo-relative path to the check script (must exist + match the SKIP pattern). */
  readonly script: string;
  /** Env var that forces the gate to hard-fail instead of skipping (the REQUIRE_* lever). */
  readonly strictEnv: string;
  /** Workflow file that sets `strictEnv` for the validate:fast run (string presence verified). */
  readonly ciLocation: string;
  /** Why/how this gate runs strict — human-readable. */
  readonly note: string;
}

/** A SKIP-capable gate whose SKIP path is accepted by design (no strict leg required, or none today). */
export interface ExcludedSkipCapableGate {
  /** Repo-relative path to the check script (must exist + match the SKIP pattern). */
  readonly script: string;
  /** Why the SKIP is acceptable-by-design — or an honest "no strict leg today" note. Non-blank required. */
  readonly reason: string;
}

/**
 * Gates that DO have a strict CI leg. The meta-gate verifies `strictEnv`
 * literally appears in `ciLocation`.
 */
export const STRICT_SKIP_CAPABLE_GATES: readonly StrictSkipCapableGate[] = [
  {
    script: 'scripts/check-atomic-helper-equivalence.ts',
    strictEnv: 'REQUIRE_MCP_OSS_EQUIVALENCE',
    ciLocation: '.github/workflows/reusable-validation.yml',
    note:
      'OSS atomicCredentialWrite equivalence gate. Skips locally when the mcp-servers ' +
      'submodule is uninitialized; the validate job sets REQUIRE_MCP_OSS_EQUIVALENCE=1 ' +
      'so the gate hard-fails (cannot skip) in CI. This is the gate this whole meta-gate ' +
      'exists to keep honest — see the Stage 4 postmortem.',
  },
];

/**
 * Gates whose SKIP path is acceptable-by-design (or which the detector
 * over-flags). Each carries an honest reason. An exclusion is NOT a free pass —
 * "no strict leg today — candidate for one" is a legitimate, visible reason; it
 * keeps the list truthful rather than inventing a CI leg that doesn't exist.
 */
export const EXCLUDED_SKIP_CAPABLE_GATES: readonly ExcludedSkipCapableGate[] = [
  {
    script: 'scripts/validate-mcp-bundles.ts',
    reason:
      'Bundle smoke test skips (exit 0) when no built bundles exist in resources/mcp-generated — ' +
      'a clean skip pre-build. Its teeth are post-package in the release/E2E pipelines where bundles ' +
      'are built first; failing validate:fast on a missing pre-build artifact would be wrong. ' +
      'No REQUIRE_* leg today and that is intentional, not an oversight.',
  },
  {
    script: 'scripts/check-core-bare.ts',
    reason:
      'Skips (exit 0) only when git is unavailable or the cwd is not a git work context — never the ' +
      'steady state for a developer or CI runner (both always run inside the checkout). The skip is a ' +
      'graceful-degradation affordance for genuinely non-git environments, not a precondition that can ' +
      'rot to a permanent skip in normal use.',
  },
  {
    script: 'scripts/check-prompt-registry-contract.ts',
    reason:
      'Diff-scoped: skips (exit 0) when the changed files do not touch the prompt registry, and fails ' +
      'CLOSED (runs the contract test) whenever it cannot classify the diff. The skip is a correct ' +
      'no-op-when-irrelevant optimization, not a missing-environment skip; there is nothing to force ' +
      'strict because the skip means "no relevant change to verify".',
  },
  {
    script: 'scripts/validate-new-augmentations.ts',
    reason:
      'Diff-scoped (same shape as validate-new-postmortems): skips (exit 0) when there is no upstream ' +
      '(fresh branch / detached HEAD — a non-CI affordance) or no outgoing postmortem touched its augment ' +
      'layer ("no relevant change to verify"), and fails CLOSED on any git error once an upstream resolves. ' +
      'It also degrades to a loud-but-non-blocking SKIP when python3 is unavailable (the augment validator ' +
      'is Python) — CI runners always have python3, so this is a developer-environment affordance, not a ' +
      'precondition that rots to a permanent skip; when it DOES run it hard-fails on malformed augment lines ' +
      'and surfaces_count drift. No REQUIRE_* leg needed — same disposition as the sibling postmortem gate.',
  },
  {
    script: 'scripts/check-submodule-pin-ancestry.ts',
    reason:
      'Offline surface: per-pin SKIP (with a loud warning) for submodule pins it cannot verify without ' +
      'fetching; the gate still hard-fails on every pin it CAN verify offline. It is not a whole-gate ' +
      'skip — partial unverifiability degrades to a warning while the verifiable subset stays strict.',
  },
  {
    script: 'scripts/check-integration-test-provider-gates.ts',
    reason:
      'Detector false-positive: its exit-0 path is the PASS branch (zero violations). The "SKIP-GATE-INTENT" ' +
      'lines log already-annotated, reason-bearing suppressions to stderr so reviewers see each bypass — ' +
      'they are not a whole-gate skip. The gate hard-fails on any un-annotated violation.',
  },
  {
    script: 'scripts/check-doc-frontmatter.ts',
    reason:
      'Skips (returns early, exit 0) only when the tracked docs/project directory is genuinely absent — ' +
      'a committed source directory that always exists in a real checkout and in CI. The skip is a ' +
      'graceful affordance for an unexpected layout, not a precondition that rots to a permanent skip; ' +
      'no strict leg is warranted because the dir is never legitimately missing in the steady state.',
  },
  {
    script: 'scripts/check-mcp-config-drift.ts',
    reason:
      'Skips (returns early, exit 0) only when the committed resources/mcp directory is absent — never the ' +
      'steady state in a real checkout or CI. Same committed-source-dir affordance as check-doc-frontmatter; ' +
      'no REQUIRE_* leg needed.',
  },
  {
    script: 'scripts/check-mcp-lockfiles.ts',
    reason:
      'Skips the resources/mcp leg of the lockfile check (log + continue, exit 0) only when that committed ' +
      'directory is absent — never the steady state. The browser-extension lockfile leg still runs and can ' +
      'fail. Same committed-source-dir affordance; no REQUIRE_* leg needed.',
  },
  {
    script: 'scripts/check-cloud-service-lockfile-parity.ts',
    reason:
      'Skips (log + exit 0) only if committed cloud-service/package.json is absent — never the steady state ' +
      '(it is a tracked file). When package.json exists but the lockfile is missing it HARD-fails; the parity ' +
      'check always runs in this repo. Same committed-source affordance as check-mcp-lockfiles; no REQUIRE_* leg needed.',
  },
  {
    script: 'scripts/check-e2e-timeout-budget.ts',
    reason:
      'Skips (log + exit 0) only if the committed tests/e2e/ directory is absent — never the steady state. ' +
      'The static firstWindow-timeout-budget scan always runs against the committed specs in this repo; the ' +
      'skip is a defensive guard for non-repo contexts. Committed-source affordance; no REQUIRE_* leg needed.',
  },
  {
    script: 'scripts/check-renderer-bundle-singletons.ts',
    reason:
      'Skips (advisory, exit 0) when no built renderer bundle exists — the normal pre-commit/validate:fast ' +
      'state. It has a strict lever (RENDERER_BUNDLE_SINGLETONS_ENFORCE=1 / --enforce, bundle-missing = hard ' +
      'fail) designed for post-package release contexts, but NO automated pipeline currently sets it — the ' +
      'enforce leg is manual today. Honest status: no strict leg wired anywhere — candidate for one in the ' +
      'release pipeline; this entry is the visible record of that gap (exactly the gate-shape this manifest ' +
      'exists to surface).',
  },
  {
    script: 'scripts/check-worker-build-smoke.ts',
    reason:
      'Changed-files-scoped: returns 0 when no worker-relevant files changed (a correct no-op-when-irrelevant ' +
      'optimization) and fail-safes to RUNNING the build when the diff cannot be determined. The ' +
      'WORKER_BUILD_SMOKE=skip path is an explicit operator force-skip (with force-run as the counterpart), ' +
      'not a rot-prone environmental precondition.',
  },
  {
    script: 'scripts/check-cross-surface-parity-gap.ts',
    reason:
      'Whole-gate bypass exists ONLY via the explicit emergency env SKIP_CROSS_SURFACE_PARITY_GAP=1 ' +
      '(documented for emergency rollback; warns loudly on stderr when used). The default state runs the ' +
      'full analysis; nothing environmental can flip it to skipping. An operator-set bypass is a deliberate ' +
      'act, not precondition rot.',
  },
  {
    script: 'scripts/check-boundary-contract-coverage.ts',
    reason:
      'Detector false-positive for whole-gate skip: the "Import-graph floor SKIPPED (no owned_by)" line is a ' +
      'per-entry sub-check skip (floor (c) does not apply to entries without owned_by, by documented design); ' +
      'the gate still enforces test presence + import-floor for every opted-in seam and fails on violations.',
  },
  {
    script: 'scripts/check-bounded-walker-recursion.ts',
    reason:
      'Detector false-positive: its "skipping" logs are per-file resilience WARNs (unstatable/unreadable/' +
      'unparsable file during the walk), not a whole-gate environment skip. The check still fails on any ' +
      'real unbounded-walker finding.',
  },
  {
    script: 'scripts/check-eslint-new-warnings.ts',
    reason:
      'Diff-scoped: enforces tightly (FAILS) on a new ESLint warning in a changed file whenever a base ' +
      'SHA derives (--base > BASE_SHA env > git merge-base @{upstream}/origin/dev HEAD). It LOUD-skips ' +
      '(stderr banner + ::warning::, exit 0) only when no base is derivable (e.g. detached/no-upstream ' +
      'with no origin/dev) or a base-prep/infra op fails (git diff / git show / ESLint stdin) — flaky git ' +
      'must not block the whole team. The always-on backstop is the npm run lint --max-warnings cap, not a ' +
      'REQUIRE_* env; CI strictness comes from the blocking eslint-new-warnings job + an always-present base, ' +
      'so no STRICT leg applies.',
  },
  {
    script: 'scripts/check-commercial-capability-parity.ts',
    reason:
      'Skips only the commercial-side assertions when the @private/mindstone commercial tree is absent — ' +
      'which is by design the permanent state of the OSS public mirror, and never the state of this repo ' +
      '(commercial checkout + CI always have the tree). Stub/desktop-side assertions still run and hard-fail ' +
      'either way.',
  },
  {
    script: 'scripts/run-validate-fast.ts',
    reason:
      'The validate:fast RUNNER itself, wired as a gate step only via `validate:step-registry` ' +
      '(= `run-validate-fast.ts --check-step-baseline`). That mode is fail-closed: it exits 1 on a ' +
      'missing/unreadable step-baseline or classifier-baseline (both committed repo files) or on ANY ' +
      'drift, and exits 0 only on a verified match — it never passes-by-skipping on a missing-environment ' +
      'precondition. The detector over-flags the file because its operator-only CLI modes ' +
      '(--write-step-baseline / --write-classifier-baseline / --list / --help) return 0 by design, but ' +
      'those are never invoked as gate steps.',
  },
];
