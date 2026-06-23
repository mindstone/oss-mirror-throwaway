---
description: "CI / release-workflow gotchas and the guards that prevent them — embedded-shell parse traps, local-vs-CI environment masking, and the Windows-build publish chokepoint"
last_updated: "2026-06-18"
---

# CI Workflow Gotchas & Guards

A running log of CI/release failure classes we've hit, *why* they were hard to catch, and the guard (by-construction where possible) that now prevents each. Add to this when a CI failure cost real time — especially ones that pass locally / on PRs but fail only in the release pipeline.

See also: [`CI_PIPELINE.md`](CI_PIPELINE.md) (trigger rules), [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) (the watch-and-fix loop), [`BUILD_AND_RELEASE_OVERVIEW.md`](BUILD_AND_RELEASE_OVERVIEW.md).

---

## 1. Embedded PowerShell `$Var:` parses as a scope qualifier (deterministic parse error)

**Symptom.** A Windows build job fails *after* a long (~60 min) package step, in a `shell: pwsh` step, with:

```
ParserError: ...ps1:NN
Variable reference is not valid. ':' was not followed by a valid variable name
character. Consider using ${} to delimit the name.
```

**Cause.** Inside a PowerShell string, `$Name:` is interpreted as a **scope/drive-qualified variable** (`$env:PATH`, `$global:x`, `$function:foo`). PowerShell raises a **parse-time** error whenever the colon is *not* immediately followed by a valid variable-name character. So:

```powershell
# BROKEN — "$Attempts:" → colon followed by space → parse error, whole script never runs
Write-Warning "$Operation failed on attempt $attempt/$Attempts: $($_.Exception.Message)"
# FIXED — delimit the name
Write-Warning "$Operation failed on attempt $attempt/${Attempts}: $($_.Exception.Message)"
```

This is **deterministic, not flaky** — the script fails to parse before executing anything. It shipped in `fdb76a7a1` (2026-06-06) inside the Azure-signing PSGallery retry helper and, because **`publish-to-gcs` needs `build-windows`** (see §3), it blocked *every* beta publish for ~a day. It was invisible pre-merge because workflow YAML / embedded PowerShell isn't type-checked or linted by default.

**Guard.** [`scripts/check-workflow-powershell-syntax.ts`](../../scripts/check-workflow-powershell-syntax.ts) (`npm run validate:workflow-powershell-syntax`, wired into `validate:fast`). It statically flags `$ident:` followed by a non-name character inside `shell: pwsh|powershell` steps. The rule is purely lexical, so it needs no PowerShell interpreter (none on dev macOS / the Linux validate runner) and has no false positives on valid scope refs like `$env:PATH` (there the colon *is* followed by a name char). Tests: [`scripts/__tests__/check-workflow-powershell-syntax.test.ts`](../../scripts/__tests__/check-workflow-powershell-syntax.test.ts).

**Rule of thumb.** In embedded PowerShell, always write `${Var}` (not `$Var`) when a `:` , `.` , or other token can follow inside a string.

---

## 2. Tests that pass locally but fail in CI — "local-env ≠ CI-env" masking

A recurring class: a test silently depends on an environment difference between a dev machine and CI, so it's green locally and red in the release pipeline (where these cross-cutting tests often run for the first time, since they don't all run on PRs).

Two concrete instances and their guards:

- **Ambient credential masking.** The CLI / agent-turn / proxy auth gate resolves Claude credentials from `settings.models.apiKey` with an ambient `process.env.ANTHROPIC_API_KEY` (and OAuth token) **fallback**. Tests that mock only a stale namespace pass on a developer's machine (env var present) but fail in CI (no creds). **Guard:** [`vitest.setup.desktop-creds.ts`](../../vitest.setup.desktop-creds.ts) strips the ambient production Claude credentials in the desktop test project (skipped under `RUN_LIVE_API_TESTS`), so a dev sees the same failure CI would.

- **CI-detection masking.** `resolveEnvironment()` ([`src/main/sentry.ts`](../../src/main/sentry.ts)) returns `'ci-e2e'` whenever `CI` / `GITHUB_ACTIONS` is set (always true on Actions runners) and `'development'` otherwise. A test that asserts `environment: 'development'` without neutralising CI detection passes locally and fails in CI. **Fix pattern:** tests that assert on environment-resolved values must control the relevant env vars explicitly (e.g. `vi.stubEnv('CI', '')`, `vi.stubEnv('GITHUB_ACTIONS', '')`, `vi.stubEnv('SENTRY_ENVIRONMENT', '')`) in `beforeEach`. (We deliberately do *not* neutralise CI-detection vars globally — many tests legitimately need `isCI` — so this is caught per-test, not by a blunt guard.)

**Rule of thumb.** If a test asserts on a value that's derived from `process.env` or ambient credentials, stub that input explicitly. "Works on my machine" is the signature.

---

## 3. The Windows build is a publish chokepoint — a Windows-only failure blocks *all* platforms

`publish-to-gcs.needs` includes `build-macos`, `build-linux`, **and `build-windows`** (but intentionally *not* `test-e2e`). Consequences:

- **A Windows-only failure — even a flaky one — blocks the entire beta publish** (mac + linux + windows). There's no partial publish.
- It also tends to surface *late and expensively*: the Windows package step alone runs ~60 min, so a failure in a step *after* packaging (signing, NSIS) costs an hour before you even see it. (This is why the §1 parse error in a *signing-setup* step was so costly.)
- Conversely, **E2E failing does not block publish** — the artifact ships "shipped-but-red." Report run-state and artifact-state separately when they diverge (see [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) §3).

**Implication.** Keep the Windows build green as a first priority during a beta push; treat a red Windows build as publish-blocking even if the failing test looks peripheral. Consider bounding long build/sign steps with `timeout-minutes` so a true hang fails fast instead of sitting near the 6-hour default.

---

## 4. Windows `npm ci` fails on `better-sqlite3` when the install runs on Node 20

**Symptom.** The Windows build job dies during `npm ci` with `node-gyp` trying to compile `better-sqlite3` from source — `find-visualstudio` noise and an `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` crash. Looks like a missing-Visual-Studio problem; it isn't.

**Root cause.** `better-sqlite3` (a devDependency, post–Electron-42/Node-24 upgrade) ships no prebuilt binary for **win32-x64 on Node 20**, so `npm ci` falls back to a source build that the runner can't complete. The runtime build itself wants Node 20.

**Fix (shipped 2026-06-14, commit `5863cf71`).** Run the Windows **install step only** on Node 22 (which *does* have a matching prebuild) via `WINDOWS_BUILD_NODE_VERSION` in `release.yml`, then restore Node 20 for the build/package runtime. Don't "fix" this by bumping the whole Windows job to Node 22 — only the `npm ci` install needs it. See [CI_PIPELINE](CI_PIPELINE.md) and `docs/plans/260614_ci-release-robustness/`.

---

## 5. Diagnostic techniques that saved time

- **`gh run view --log` is often empty** for large/just-completed release runs. Use the REST endpoint instead: `gh api repos/<owner>/<repo>/actions/jobs/<jobId>/logs` (strip ANSI with `sed -E 's/\x1b\[[0-9;]*m//g'`). Get `<jobId>` from `gh run view <runId> --json jobs`.
- **Per-step timing / current step:** `gh api repos/<owner>/<repo>/actions/jobs/<jobId> --jq '.steps[] | "\(.number). \(.name): \(.status) \(.started_at)→\(.completed_at)"'` — tells you whether an in-progress job is hung on a specific step and how long each step took.
- **Characterising a suspected flake (instead of re-run roulette):** spin up a *throwaway* `windows-latest` (or relevant-OS) workflow that runs only the suspect test **N times in fresh processes** and prints an `M/N failed` summary. A `0/8` result (each run fast) is strong evidence of a transient one-off, not a deterministic bug — and tells you a timeout bump would only mask runner contention. Delete the throwaway workflow + branch afterwards. (Note: `workflow_dispatch` only works for workflows on the default branch; trigger a non-default-branch throwaway via a `push:` trigger scoped to that branch.)

---

## 6. Open hardening ideas (not yet done)

- Run an **authoritative** embedded-PowerShell parse check (`[Parser]::ParseInput`) on a pwsh-capable CI runner, complementing the static lexical guard in §1, to catch parse errors beyond the `$Var:` class.
- Add `timeout-minutes` to the long Windows package/sign steps (§3).
- The macOS E2E harness intermittently fails with "Timed out waiting for local cloud service" (a different failing set run-to-run) — a persistent infra flake in the E2E cloud-service startup, worth hardening (longer/retried startup wait) since it muddies every beta's run-state even though it doesn't block publish.
- **Catch chronic-E2E staleness *before* beta, by construction.** The three chronic publish-gating specs (`settings`, `quality-tier-selector`, `onboarding-organisation-grouping`) run **only in the beta workflow** — not on PRs, not in `dev-checks` — so they go stale silently and a beta pushed by an *unrelated* agent dies on them ~2h in (e.g. 2026-06-18: a Fable-5 catalog withdrawal broke `quality-tier-selector`'s tier-count assertion → publish skipped). The runbook now mitigates this at push time by mandating a local run ([`RELEASE_TO_BETA.md` §5.1](RELEASE_TO_BETA.md)). The *root-cause* kill is to run the subset in `dev-checks`/PRs (path-filtered to renderer / shared-component / catalog-data changes) so staleness surfaces at PR time, where the agent who broke it is present. Cost caveat: this is **build/package + 3 specs** (~10+ min on macOS), not just "3 specs" — unless it reuses an existing CI packaged artifact. It's a CI-topology/cost call that should coordinate with the in-flight E2E gate-readiness work ([`docs/plans/260617_deflake-ci-for-blocking-gates/PLAN.md`](../plans/260617_deflake-ci-for-blocking-gates/PLAN.md), [`docs/plans/260617_release_outcome_observability/PLAN.md`](../plans/260617_release_outcome_observability/PLAN.md)) so it doesn't create an overlapping macOS package/E2E job with an inconsistent signal.

---

## 7. Beta cancelled (not failed) by the secret-scan concurrency group — multi-agent dev churn

**Symptom.** A beta release run shows terminal state **`cancelled`** (not `failure`) ~5–15 min in. The job view shows the **`Secret Scan (verified-only)` job individually `cancelled`** while its siblings (`verify-submodules`, `MCP Integration`, `GPU Worker WASM Smoke`) are `success`, and every downstream job (`Validate & Test`, all platform builds, E2E, publish) is `skipped`. A single early job cancelled + everything after it skipped = a **concurrency-group cancellation targeting that job**, not a run-level/manual cancel (which would cancel *all* in-progress jobs).

**Root cause.** `release.yml` gates builds on a secret scan via `uses: ./.github/workflows/secret-scan.yml` (workflow_call). `secret-scan.yml` also runs standalone `on: push` to `dev`/`main`, and its workflow-level `concurrency` group resolved the **same** for the standalone push-triggered scan and the release's reusable-call scan, with `cancel-in-progress: true`. So when *any* concurrent dev push fired the standalone scan, it entered the release's group and cancelled it — cascading the whole ~2h beta. With 5–7 agents pushing (observed: 10 commits in ~10 min on 2026-06-18), a beta reliably died in its early secret-scan window. (GitHub docs say `github.workflow` in a called workflow = the *caller's* name, which *should* separate the groups; empirically they collided anyway. The fix below doesn't depend on resolving that discrepancy.)

**Fix (shipped 2026-06-18).** Give the release-gate invocation a **unique-per-run concurrency group** so nothing else can ever share it (immune to cancellation regardless of the collision mechanism), while push/PR runs keep their shared dedup group:
- `secret-scan.yml` takes a `workflow_call` input `concurrency-group` (default `''`) and sets `group: ${{ inputs.concurrency-group || format('secret-scan-{0}-{1}', github.workflow, github.ref) }}`. A missing-property dereference is `''` (falsy), so push/PR fall through to the shared group by construction.
- `release.yml` passes `concurrency-group: secret-scan-release-${{ github.run_id }}-${{ github.run_attempt }}` (unique per release run *and* per re-run attempt; protects both the dev/`workflow_dispatch` beta path and the `main`/`push` stable path).
- `inputs` *is* a permitted context in a workflow-level `concurrency.group`, and `cancel-in-progress` may be an expression (GitHub workflow-syntax docs); verified by `actionlint`. **Don't** "fix" this with `cancel-in-progress: false` — GitHub still allows only one *pending* run per group, so a newer pending scan can supersede a queued release scan; unique groups are strictly more robust.

**Operational workaround (if you hit this on an un-patched checkout):** re-dispatch via `gh workflow run release.yml --ref dev` (no new push, so you don't add churn) and catch a lull in the early secret-scan window.
