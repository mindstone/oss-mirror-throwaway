---
description: "Vitest workspace configuration, test infrastructure, and automation patterns for Mindstone Rebel"
last_updated: "2026-06-11"
---

# Testing Automation Overview

## Introduction

This document covers the testing tooling available in the Mindstone Rebel codebase: unit/integration tests (Vitest), agent UI testing routes, pointers to E2E testing, and the **opt-in live-API tier** (`npm run test:live` — real provider APIs; not in per-push gates; see [Consolidated live-API tier](#consolidated-live-api-tier-testslive-api--liveapiharness)). Use the decision matrix below to choose the right approach.

## See also

- `SETUP_DEVELOPMENT_ENVIRONMENT.md` – Dev environment setup, including test prerequisites.
- [Vitest documentation](https://vitest.dev/guide/) – Official docs for the test runner.
- [TESTING_E2E.md](./TESTING_E2E.md) – Playwright E2E tests: environment, suites, writing patterns, and troubleshooting.
- [E2E_TEST_FIXING_GUIDELINES.md](./E2E_TEST_FIXING_GUIDELINES.md) – Process for diagnosing and fixing E2E failures.
- [WRITING_EVALS.md](./WRITING_EVALS.md) – LLM eval harnesses (safety prompt, auto-continue, public channel safety, knowledge work, reproducible evals): real API calls, multi-run, baselines, CI. Includes reproducible evals with MCP twin servers for testing agent tool use against fictional corpus data.
- [AGENT_UI_TESTING.md](./AGENT_UI_TESTING.md) – Scenario router for agent UI verification: CLI, packaged, dev-CDP, MCP, and E2E paths.
- [MCP_ELECTRON_CONTROLLER.md](./MCP_ELECTRON_CONTROLLER.md) – rebel-electron MCP server setup and troubleshooting.
- [PERFORMANCE_TESTING.md](./PERFORMANCE_TESTING.md) – Automated perf regression tests: IPC payload guards, memory leak detection, CDP structural metrics, CI integration.
- [PERF_DIAGNOSTIC_PLAYBOOK.md](./PERF_DIAGNOSTIC_PLAYBOOK.md) – Operator playbook + `scripts/perf-acceptance-check.ts` AC1-AC5 harness asserting the periodic `Memory diagnostic` emission shape against a log tail. Safe to run locally, in CI, or against a QA build; exit 0 on pass/skip, 1 on fail.
- [ARCHITECTURE_IPC.md](./ARCHITECTURE_IPC.md) > "Contract-Parse Seam" + [`src/main/ipc/__tests__/harness/README.md`](../../src/main/ipc/__tests__/harness/README.md) – The dev/test-gated IPC contract-parse seam: every handler registered through `registerHandler` gets its request/response Zod-parsed by construction across the whole suite (plus a broadcast sink-seam + cloud-ingress parse). A CI/dev regression guard, NOT production enforcement.
- [CLOUD_SYNC_HARNESS.md](./CLOUD_SYNC_HARNESS.md) – Real (not mocked) local cloud-sync harness: spawns the real cloud-service + drives the real `cloudWorkspaceSync` of ≥2 instances + a `DriveSim` that mints Google-Drive conflict copies. Reproduces the Drive conflict-copy class (REBEL-62A file fix holds; folder REBEL-5QS still leaks). Lib in `src/test-utils/cloudHarness/`; operator CLI `scripts/cloud-sync-harness.ts`. The shared SSOT for "spawn + await-ready a local cloud-service".

## Which testing approach to use

| What changed | Recommended approach | Why |
|-------------|---------------------|-----|
| Pure logic, utils, services | `npm test` (Vitest) | Fast, deterministic, no UI needed |
| IPC contracts, type safety, store versions, boundary contracts | `npm run validate:fast` | Lint + IPC + store versions + MCP bundles + circular deps + settings search sync + TS ratchet + boundary contract enforcement (forbidden terms, cloud channel parity, IPC handler parity) + husky pre-push fast-tier check + integration-test provider-gate check |
| Bug fix affecting UI state | Agent UI testing router | Verify via the cheapest path that still exercises the rendered behavior |
| UI components, layouts, styles | Agent UI testing router | See the actual rendered result |
| State changes visible on screen | Agent UI testing router | Confirm state flows through to the UI |
| Settings, navigation, onboarding | Agent UI testing router | Interactive verification of user flows |
| Multi-step flows needing CI coverage | Playwright E2E | Runs headless in CI, isolated userData |
| Persistence across app restart | Playwright E2E | Can restart the app mid-test |
| Performance regressions (IPC size, memory leaks, layout thrashing) | `npm run test:e2e:perf` | Deterministic perf gates, separate from regular E2E |
| MCP server bundles | `npm run test:mcp:smoke` | Smoke test all MCPs via MCP SDK Client. See [MCP_TESTING.md](./MCP_TESTING.md) |
| MCP tool behavior | `npm run test:mcp:integration` | Integration tests with real API keys (skips if no keys) |
| LLM prompt changes, agent behavior | `npm run eval` → knowledge-work | Reproducible evals with fictional corpus + MCP twin servers. See [WRITING_EVALS.md](./WRITING_EVALS.md) |

**Rule of thumb:** If the change produces a visible difference on screen, route through [AGENT_UI_TESTING.md](./AGENT_UI_TESTING.md). If it's logic-only, unit tests are sufficient.

## Tooling overview

- **Test runner**: [Vitest](https://vitest.dev/) configured via `vitest.config.ts`.
- **Environment**: Node test environment (`environment: 'node'`) with globals enabled.
- **Language**: TypeScript-first; tests are written in `.ts`/`.tsx` alongside source files.
- **Module resolution**: Uses the same path aliases as the app code (for example `@main`, `@renderer`, `@shared`).

Key configuration lives in `vitest.config.ts`, which uses the `test.projects` API to define 4 named test projects. See the "Vitest Workspace Projects" section below for details.

## Vitest Workspace Projects

Tests are organized into 4 named projects in `vitest.config.ts` using `test.projects`. Each project maps to a CI environment with matching dependencies.

| Project | What it covers | CI workflow | npm script |
|---------|---------------|-------------|------------|
| **desktop** | `src/`, `packages/shared/`, 3 script tests | dev-checks.yml | `npm run test:desktop` |
| **cloud-service** | `cloud-service/src/` | cloud-ci.yml | `npm run test:cloud` |
| **mcp** | `resources/mcp/**/test-mcp.*`, 4 MCP script tests | mcp-catalog-tests.yml + release.yml | `npm run test:mcp:smoke` etc. |
| **evals** | `evals/__tests__/`, `evals/mcp-twins/__tests__/` | dev-checks.yml | `npm run test:evals` |

**Running by project:**
```bash
npx vitest run --project=desktop       # only desktop tests
npx vitest run --project=cloud-service # only cloud-service tests
npm test                               # all projects (no --project flag)
```

**Cloud-service rebuild contract:** `npm run test:cloud` and `npm run test:cloud:live` chain `node cloud-service/build.mjs &&` BEFORE running vitest, so `cloud-service/dist/server.mjs` is always rebuilt against the current sources before the spawn-based tests boot it. This is intentional — without the rebuild, the spawned binary may lag behind production fixes (esbuild incremental rebuild is sub-second, ~0.4s, so the cost is negligible). If you need to iterate without rebuilding (e.g., changing only the test code), use `npm run test:cloud:fast`, which skips the build step. CI's `cloud-ci.yml` builds explicitly via `cd cloud-service && node build.mjs` and then runs `npx vitest run --project=cloud-service` directly, so no double-build occurs in CI.

**Adding new test files:** Place the test in the appropriate directory and it will be auto-discovered by the matching project (`scripts/__tests__/` included — it is glob-matched into `desktop` since 260610, with the handful of mcp-owned suites excluded by exact name). The `validate:testing-guards` orphaned-test guard fails the push if a new test file is matched by no runner.

**Key design decisions:**
- Root config is NOT inherited by projects -- each project gets `sharedTestDefaults` and `sharedAliases` via spread.
- `vitest.setup.ts` (electron/sentry mocks, platform-config init) is used by every project except `mcp`.
- `mcpHttp.integration` runs in the `mcp` project (full tier only — fast mode excludes `*.integration.*`); it boots a real Super-MCP HTTP server on port 3333 and self-imports `vitest.setup.ts` at the top of the file since the `mcp` project has no setupFiles. Its former dead-suite sibling `devServerSmoke` was deleted 260611 (superseded by the packaged boot-smoke machinery).

> **Research reference:** `docs/research/260330_vitest_projects_api.md` documents the API behavior and migration gotchas.
> **Planning doc:** `docs/plans/260330_vitest_workspace_migration.md` documents the migration rationale and stages.

## Test Tiering: Fast vs Full

Tests are tiered into **fast** and **integration** categories using a naming convention:

- **Fast tests** (`*.test.ts`): Pure unit tests, contract tests, utility tests. Run in seconds.
- **Integration tests** (`*.integration.test.ts`): Tests that start servers, hit real APIs, or require submodules. Slower and may need environment setup.

### Running fast tests only

```bash
npm run test:fast    # VITEST_FAST=1 — excludes *.integration.* files
```

When `VITEST_FAST=1` is set, `vitest.config.ts` adds `**/*.integration.*` to the exclude list for **every project that runs integration suites** — desktop, cloud-service, and evals. (The mcp project does not run integration tests via this path.) This is implemented at the config level (not CLI `--exclude`) because workspace mode's CLI excludes were unreliable. A regression fixture (`scripts/__tests__/vitest-config-fast-mode.test.ts`, A3c) re-asserts the exclude list across all three projects.

### Live-API integration test pattern

There are several live / real-API test surfaces in the repo, for different jobs. **This
section is the signpost for all of them:**

1. **Consolidated live-API tier (`tests/live-api/` on `liveApiHarness`)** — the
   preferred home for **LLM provider/transport-shape** live tests (does direct-Anthropic /
   OpenRouter / OpenAI routing still round-trip end-to-end?). Documented just below.
2. **Connector live read-only smoke (`tests/connector-smoke/` on `connectorSmokeHarness`)** —
   exercises the real desktop **MCP connector** path (credential/token resolution → MCP spawn
   or remote HTTP connect → a real **read-only** tool call) for a representative sample of
   connectors spanning auth families (Slack/Google/Microsoft/ElevenLabs/Replit/Vanta over
   stdio, Notion over remote HTTP). Plus **L1**, a keyless CI catch
   (`src/main/__tests__/commercialOAuthCredentialResolution.test.ts`) asserting every
   commercial OAuth connector resolves its client creds — the cheap always-on guard for the
   OSS-scrub credential-regression class. **Full doc + safety model:
   [`CONNECTOR_LIVE_SMOKE.md`](CONNECTOR_LIVE_SMOKE.md).** Run: `npm run test:connectors:smoke`
   (and `npm run test:live` now runs it too — see below). Opt-in via `RUN_CONNECTOR_SMOKE_TESTS`;
   skip-green when a connector isn't connected.
3. **OSS-connector pre-publish real-API smoke (`scripts/test-oss-connectors.ts`)** — a
   catalog-driven, hand-curated real-API smoke run against the packed/published OSS connector
   package, the **mandatory pre-publish gate** in
   [`MCP_BUNDLED_TO_OSS_MIGRATION.md`](MCP_BUNDLED_TO_OSS_MIGRATION.md) (Phase C5). Run:
   `npm run test:oss-connectors`. (Distinct from #2: #2 validates the *desktop* path for a
   *connected* account; #3 validates an OSS *package* before publish.)
4. **Legacy real-settings direct-Anthropic diagnostic** (`fullPath.integration.test.ts`)
   — reads the user's real `app-settings.json` and composes provider-shape + auth-shape
   gating. The four-part pattern after that is its reference shape; it lives outside the
   `test:live` tier as a standalone diagnostic.

Canonical shape for any new live-API integration test: an `isDirectAnthropicConfig`-style
**provider-shape** guard (not just credential presence — the `canRun`/`skipIf` predicate must
match the API surface the test actually calls), an explicit skip diagnostic when gated out,
and `**/*.integration.*` naming so the fast tier excludes it.

#### Consolidated live-API tier (`tests/live-api/` + `liveApiHarness`)

The provider/transport live tests live in a dedicated `tests/live-api/` tree
(separate from `src/`) and gate through one shared helper,
[`src/test-utils/liveApiHarness.ts`](../../src/test-utils/liveApiHarness.ts) —
the **single source of truth** for the tier's five invariants (missing/blank key ⇒
SKIP not fail; one key-free skip line per skipped cell; key NEVER logged/returned
except as the opaque `key` to the callback; trim/blank-as-absent; no retries). The
helper enforces them *by construction*, so individual tests can't re-introduce the
260419 gating drift. A test declares a `LiveApiCell` (provider, label, model, and a
credential source) and wraps its body in `describeLiveApi(cell, ({ key }) => { … })`.

Two credential classes are supported:
- **Env-keyed providers** (`anthropic` / `openai` / `openrouter`) declare `envVar`;
  the resolved key is the harness's sole secret channel.
- **Non-env providers** (`codex` / **ChatGPT Pro subscription**) declare a cheap
  `credentialProbe` instead. ChatGPT Pro's OAuth tokens are `safeStorage`-encrypted
  on disk and **cannot** be sourced from `.env.test`, so there's no `TEST_CODEX_*`
  key. The cell — [`tests/live-api/codexSubscription.live.integration.test.ts`](../../tests/live-api/codexSubscription.live.integration.test.ts)
  — gates on the presence of the desktop `codex-oauth-tokens.json` (skip-green if
  you haven't signed in to ChatGPT Pro), then decrypts read-only via the sanctioned
  Electron helper ([`src/test-utils/codexLiveAuth.ts`](../../src/test-utils/codexLiveAuth.ts)
  → `scripts/eval/export-codex-tokens.cjs`) and drives a real turn through the local
  proxy's Codex egress (`forwardToCodexModel` → chatgpt.com). It never writes your
  token store and never refreshes — an expired/disconnected token surfaces as a real
  auth failure (the genuine "reconnect needed" signal), and a usage cap surfaces as a
  429 (the REBEL-66Q class). No secret flows through the harness for this cell.

- **Opt-in only; never in the per-PR / pre-push path.** The whole tier is
  additionally gated behind an explicit opt-in env `RUN_LIVE_API_TESTS`; unset ⇒
  every cell skips, so the files are inert in normal runs even if provider keys
  happen to be present. It is **not** wired into `validate:fast`, the pre-push hook,
  or any PR-blocking CI, and the `.integration.` suffix keeps it out of
  `VITEST_FAST=1`. There are exactly two sanctioned places that set
  `RUN_LIVE_API_TESTS=1`:
  - **Automated harness-health cron** — [`.github/workflows/live-eval.yml`](../../.github/workflows/live-eval.yml)
    runs the tier weekly (Mondays 05:30 UTC) plus on manual `workflow_dispatch`. It
    is not a PR trigger (real provider cost) and does not block PRs.
  - **Explicit operator run** — `npm run test:live` (`cross-env RUN_LIVE_API_TESTS=1
    RUN_CONNECTOR_SMOKE_TESTS=1 vitest run --project=desktop tests/live-api
    tests/connector-smoke`). Capture keys first with `npm run capture-live-api-keys`. **This
    one command now runs BOTH the LLM live-API tier and the connector live read-only smoke
    (#2 above)** — connectors you haven't connected skip-green. For connectors only, use
    `npm run test:connectors:smoke`.
- **Skip-green vs fail-loud policy.** Missing/blank keys ⇒ cells skip (the harness
  invariant — never fail). What differs is what happens *around* the skip:
  - **In automation, a keyless run is intentionally green** (clean no-op). But
    live-eval.yml's provider-aware **anti-rot guard** *fails* the job when a `TEST_*`
    secret **is** configured yet zero non-pending assertions ran for that provider —
    so a gate that has silently rotted to skip is caught instead of passing green.
  - **On an explicit operator run, a keyless skip-green is the wrong outcome** — if
    you asked for live tests you want to learn your keys are missing, not see a green
    no-op. `npm run test:live` enforces this: after vitest it runs
    [`scripts/check-live-api-ran.ts`](../../scripts/check-live-api-ran.ts), which fails
    the run when **zero** non-pending cells ran (the operator-side equivalent of the CI
    aggregate anti-rot backstop). It deliberately does **not** require every provider's
    key — a single-provider-key run still passes (present-provider cells run, absent
    ones skip). The skip-vs-fail distinction lives on the *entrypoint*, not in the
    harness, so the harness's "skip never fails" invariant stays intact for automation.
- **Keys via a read-only capture step.** `npm run capture-live-api-keys` reads your
  `app-settings.json` read-only and **merges** into a gitignored repo-root `.env.test`
  (0600, temp+rename; dry-run by default with fingerprint-only preview — never prints
  raw key values). Capture manages **only** the four live `TEST_*` keys it can derive
  from app settings: `TEST_OPENROUTER_API_KEY`, `TEST_ANTHROPIC_API_KEY`,
  `TEST_OPENAI_API_KEY`, and `TEST_CLAUDE_API_KEY` (alias of Anthropic). Hand-maintained
  lines for any other var — e.g. `TEST_ELEVENLABS_API_KEY`, `TEST_WORKSPACE_DIR` (see
  [TESTING_E2E](TESTING_E2E.md#environment-setup)) — are **preserved**; capture never
  writes or deletes them. Unmanaged lines always survive a refresh; capture never deletes
  managed keys that are absent from app settings either (e.g. OAuth-only Anthropic).
  Insert missing managed keys without `--force`; update an existing managed value only
  with `--force` (refusal names conflicting keys + fingerprints, never values); duplicate
  managed keys in the file fail closed (clean up manually). `vitest.setup.ts` loads
  `.env.test` into `process.env` (`override:false`, so shell/CI vars win).
  `.env.test.example` documents the recognised vars. Keys are NEVER committed or logged.
  The eval suite has a sibling mechanism with the same merge semantics:
  `npm run eval:capture-keys` → `evals/configs/.local/keys.env` (raw provider names) —
  see [TESTING_EVALS_KNOWLEDGE_WORK](TESTING_EVALS_KNOWLEDGE_WORK.md).
- **Enforced by the AST gate.** [`scripts/check-integration-test-provider-gates.ts`](../../scripts/check-integration-test-provider-gates.ts)
  now scans `tests/` too and **requires** any `*.live.integration.test.ts` to import
  `liveApiHarness` (or carry a non-empty `// SKIP-LIVE-HARNESS-INTENT: <reason>`),
  so a future live test that hand-rolls its own gate fails `validate:fast` by
  construction.

The legacy four-part pattern below applies to the standalone real-settings
diagnostic (item 2 above), which gates on provider-shape + auth-shape composition:

Integration tests with the `*.integration.test.ts` suffix are excluded from the
fast-tier scope under `VITEST_FAST=1` (the husky pre-push hook sets this) and
are gated by **provider-shape + auth-shape composition** when they hit live
external APIs. The four-part pattern:

1. **Explicit prerequisite check, read from a source-of-truth.** Load
   the real user settings (or the integration-test env override) and
   bind every prerequisite to a named local — settings present, auth
   credentials present, provider is direct-Anthropic, etc. Don't hide
   the prerequisites inside `canRun`'s expression; reading
   `realSettings`, `apiKey`, and `isDirectAnthropic` as separate locals
   lets the skip diagnostic (part 3) say *which* prerequisite failed.

2. **Provider-shape gate, NOT auth-shape gate.** The gate that decides
   "should this test run?" must compose `isDirectAnthropicConfig(settings)`
   alongside any auth check. **Auth-shape helpers**
   (`getApiKeyForDirectUse`, `hasDirectAuth`, etc. — full list in
   [`AUTH_SHAPE_HELPERS`](../../src/core/utils/authEnvUtils.ts))
   answer "are credentials present?", not "is direct-Anthropic the active
   provider?". Gating only on auth-shape lets the test run in OAuth /
   OpenRouter / cloud-relay configurations and emit live-API 404s,
   which is the bug
   [`docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md`](../../docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md)
   captured in full.

3. **Skip diagnostic — `console.log` *which* prerequisite failed.** When
   a prerequisite is missing, log a one-line diagnostic before
   `describe.skipIf` swallows the test. The most subtle failure mode
   (the 260419 shape) is "credentials present but provider is proxied" —
   without a diagnostic the test silently no-ops and the author thinks
   their gate works. Be specific: `'Skipping live-API integration test:
   settings route via OpenRouter/Codex; this suite is direct-Anthropic
   only.'` is far more useful than `'Skipping integration test'`.

4. **`*.integration.test.ts` filename + bounded timeout + no retries
   by default.** Use the `*.integration.test.ts` suffix so
   `**/*.integration.*` excludes pick the file up across desktop,
   cloud-service, and evals projects (see A3c regression fixture). Set
   an explicit `testTimeout` per test (or via the `it`-level timeout
   argument) — live API calls should not hang for the global default.
   Do NOT add `retry: N` unless you've understood the failure mode and
   documented it: a flaky live-API test masks real upstream issues, and
   retrying on a 404 in particular re-introduces the 260419 class.

**Copy-pasteable reference (the correct shape — based on the post-fix `fullPath.integration.test.ts`):**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';
/* eslint-disable no-console -- integration test diagnostic output */

// Part 1 — explicit prerequisite check, source-of-truth from disk.
function loadRealSettings(): AppSettings | null {
  try {
    const settingsPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'mindstone-rebel',
      'app-settings.json',
    );
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as AppSettings;
  } catch {
    return null;
  }
}

const realSettings = loadRealSettings();
const apiKey = realSettings ? getApiKeyForDirectUse(realSettings) : '';
const isDirectAnthropic = realSettings ? isDirectAnthropicConfig(realSettings) : false;

// Part 2 — provider-shape AND auth-shape composed.
const canRun = !!realSettings && !!apiKey && isDirectAnthropic;

// Part 3 — skip diagnostic identifying which prerequisite failed.
if (!realSettings) {
  console.log(
    'Skipping live-API integration test: no app-settings.json found (run the app once to seed settings).',
  );
} else if (!apiKey) {
  console.log(
    'Skipping live-API integration test: no Anthropic API key configured in settings.',
  );
} else if (!isDirectAnthropic) {
  console.log(
    'Skipping live-API integration test: settings route via proxy provider (OpenRouter/Codex); this suite is direct-Anthropic only.',
  );
}

// Part 4 — filename is `*.integration.test.ts`, per-test timeout is
// bounded explicitly, and we deliberately do not pass `{ retry: N }`.
describe.skipIf(!canRun)('live-API integration', () => {
  it(
    'hits the real Anthropic endpoint',
    async () => {
      // ...
    },
    /* testTimeout: */ 30_000,
  );
});
```

5. **`sk-*` prefix carries no provider semantics.** Both Anthropic
   (`sk-ant-*`) and OpenAI (`sk-proj-*`, `sk-or-*` for OpenRouter, etc.)
   use the `sk-` prefix. Test fixtures should NOT use `sk-*` literals as
   stand-ins for "direct Anthropic config" — that is the same auth/provider
   conflation that produced 260419. Use neutral tokens like `'fake-test-token'`
   in fakes, and reserve `sk-…` literals for tests where the prefix is
   the contract under test (log-redaction, secret-detection, prefix-shape
   validation, etc.).

   The drift-check scans **test surfaces only**: walks the SCAN_ROOTS
   list (`src`, `evals`, `scripts`, `cloud-service`, `cloud-client`,
   `packages`, `mobile`, `tests`) and admits any file that lives under a
   `__tests__/` directory, lives under `evals/fixtures/`, or has a
   `*.{test,spec}.{ts,tsx,js,jsx}` filename at any path (covers
   co-located Vitest unit tests, files like
   `resources/mcp/<server>/test-mcp.test.ts`, and Playwright E2E
   suites like `tests/e2e/<name>.spec.ts`). It fails closed on any `sk-*`
   literal that isn't covered by the allowlist. Production code paths
   are out of scope by design — if a production redactor mentions the
   `sk-` prefix, that's intentional contract documentation, not test
   drift.

   **Allowlist source-of-truth:** [`scripts/sk-test-token-allowlist.ts`](../../scripts/sk-test-token-allowlist.ts).
   The allowlist covers three categories: (a) **prefix-shape contract
   tests** (log-redaction, secret-detection, prefix-validation, masked-UI
   assertions), (b) **eval fixture directories** that intentionally embed
   realistic provider-prefix credentials for safety/memory/route-plan
   judges to score against, and (c) the **drift-check's own test fixture
   battery**. Each entry carries a one-line rationale; the in-file JSDoc
   explains the inclusion criterion.

   **Two-way drift detection:** the check fails not just on un-allowlisted
   `sk-*` hits but also on **orphan allowlist entries** — entries pointing
   at deleted/renamed files. That keeps the allowlist and the doc honest
   in both directions.

   **Don't enumerate the file list here.** The TS const is the single
   source-of-truth; duplicating filenames into this doc invariably drifts
   out of sync. The orphan-detection test
   ([`scripts/__tests__/check-sk-test-token-drift.test.ts`](../../scripts/__tests__/check-sk-test-token-drift.test.ts))
   catches drift between the allowlist and reality.

> **Signposts:**
> - [`docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md`](../../docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md) — full incident write-up.
> - [`docs/plans/260419_prepush_followups_roadmap.md`](../plans/260419_prepush_followups_roadmap.md) — A3, A3b, A3c, A6, B2, C3 prevention work that produced the checks linked above.
> - [`scripts/check-integration-test-provider-gates.ts`](../../scripts/check-integration-test-provider-gates.ts) — A3b mechanical enforcement (wired into `validate:fast`); walks every `**/*.integration.test.ts` AST and reports any gate that references an auth-shape helper or raw `settings?.claude?.apiKey` field without composing `isDirectAnthropicConfig`. Escape hatch: `// SKIP-GATE-INTENT: <non-empty rationale>` on the same/preceding line.
> - [Lens-Testability item 9 in CHIEF_ENGINEER2 review packet](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md#92-review-packet-chief--reviewer) — the reviewer cue that surfaces auth-shape-as-provider-gate misuse during plan review.
> - [`AUTH_SHAPE_HELPERS`](../../src/core/utils/authEnvUtils.ts) — source-of-truth list of auth-shape-only helpers, kept in sync via the AST check above.
> - [`src/core/rebelCore/__tests__/fullPath.integration.test.ts`](../../src/core/rebelCore/__tests__/fullPath.integration.test.ts) — the post-260419 reference implementation of the four-part pattern.

### Multi-state coverage for code that reads persisted user state

When refactoring code that reads persisted user state (active provider, model resolver, settings translator, credential adapter), test against ≥3 state shapes — not just the default:

1. **Default** — documented happy-path shape.
2. **Non-default** — user actively changed something (e.g. `activeProvider: 'openrouter'` when default is `'auto'`).
3. **Disagreement** — persisted `activeProvider` and the runtime resolver's chosen provider disagree.

Default-only tests pass while users with non-default or stale state hit the bug. Cheap surrogate when full E2E is too expensive: `describe.each(SCENARIOS)` over the state shapes in a unit test. Operationalised after the [`260430 eval-harness cluster postmortem`](../../docs-private/postmortems/260430_evals_s5b_cluster_anthropic_passthrough_sentinel_leak_postmortem.md) (6 bugs from one shared-primitive refactor) and the [`260503 eval-rerun spike`](../plans/260503_kw_eval_infra_robustness.md) (state-coupling bugs that single-state E2E missed).

### Compile-forced totality gates for per-axis sibling tables

When a `switch`/lookup over a union (provider, error kind, route role) has a `default`/catch-all that silently absorbs *unclassified* members, a union member added later inherits the default with **no compile error and no test failure** — the dominant `cross_module_assumption` / sibling-table-omission morphology (e.g. a new `ActiveProvider` validated as Anthropic via `default`). The guard is a **test-side exhaustive map** `… satisfies Record<TheUnion, …>` that fails to **compile** until every member is explicitly classified, and that drives the *real* production code per member (not a hand-asserted constant). Keep **one map per axis** — don't merge axes into a god-table (that drifts toward the rejected unified "model-identity descriptor"). Prove non-vacuity with a mutation: add a union member → compile RED; mis-classify a member → assertion RED.

- Template: [`settingsStore.providerHealSymmetry.test.ts`](../../src/main/__tests__/settingsStore.providerHealSymmetry.test.ts).
- Examples: [`validateProviderCredentials.totality.test.ts`](../../src/core/utils/__tests__/validateProviderCredentials.totality.test.ts) (provider × credential), [`providerErrorClassification.totality.test.ts`](../../src/core/rebelCore/__tests__/providerErrorClassification.totality.test.ts) (`ModelErrorKind` × the real classifier). Rationale + the full menu of cross-module test levers: [`docs/plans/260616_cross-module-test-coverage/PLAN.md`](../plans/260616_cross-module-test-coverage/PLAN.md).

### Real-boot agent-turn harness (`bootRealAgentServices()`)

`bootRealAgentServices()` ([`src/test-utils/bootRealAgentServices.ts`](../../src/test-utils/bootRealAgentServices.ts)) boots the **REAL** agent-turn service graph in Vitest — `executeAgentTurn`, `runAgentQuery`, `queryRouter`, `rebelCoreQuery`, the client factory, the real `AnthropicClient`, admission, and the runtime registry are all live (wired exactly as production wires them, via `createHeadlessRuntime`). It stubs **only** `globalThis.fetch`, with a fail-closed allowlist (`127.0.0.1` → real, `api.anthropic.com/v1/messages` → a canned response, everything else → throw). This catches **executor↔service contract drift** that the mock-heavy unit tests (the ~753-`vi.mock` status quo) are structurally blind to.

- **The canned provider response MUST be an SSE `text/event-stream` stream, not plain JSON** — the turn streams; a plain-JSON 200 hangs the streaming reader forever (a Stage-1 finding that cost ~88min). The helper emits the full Anthropic streaming event sequence.
- **Slow / opt-in tier.** Both consuming tests (`bootRealAgentServices.smoke.integration.test.ts` and `agentTurnExecutor.buildQueryOptions.realboot.integration.test.ts`) are `*.integration.test.ts` (excluded under `VITEST_FAST=1`) AND `describe.skipIf(!RUN_REALBOOT_TESTS)`, so they are inert in default runs. Opt in with `npm run test:realboot` (`RUN_REALBOOT_TESTS=1`, serial via `--no-file-parallelism` — `createHeadlessRuntime` is a per-process singleton).
- **Blocking pre-push beta gate.** Wired as a BLOCKING step in `.husky/pre-push` from Tier 2 up (`is_beta || is_production`) — `release.yml` has no CI unit-test job, so the beta push hook *is* the gate. Kept OUT of Tier 1 (every push), where a singleton cold boot is a flake risk; soaked 50/50 green before promotion. Bypassable only by the same `[skip-tests]` override as all pre-push test gating.
- **Anti-false-green guards** (both wired into `validate:fast`): `scripts/check-real-boot-no-provider-mock.ts` fails if a real-boot test `vi.mock`s the provider seam (which would recreate the mock-masking the helper exists to avoid), and `scripts/check-executor-service-imports.ts` keeps the boot helper's wired services in sync. Consuming tests must assert POSITIVELY that the seam was reached (`capturedRequests.length === 1`), since admission fails closed before the fetch seam.

### Convenience scripts

In addition to `test:fast`, scoped test scripts target specific source directories:

```bash
npm run test:core       # vitest run --project=desktop src/core/
npm run test:main       # vitest run --project=desktop src/main/
npm run test:renderer   # vitest run --project=desktop src/renderer/
```

These are useful for fast iteration when working in a specific area.

## Test locations and naming

Vitest is configured to discover tests under `src/` using common naming conventions:

- **Core (platform-agnostic) tests**: `src/core/__tests__/*.test.ts` and `src/core/utils/__tests__/*.test.ts` (for example `platform.test.ts`, `store.test.ts`, `boundaryInterfaces.test.ts`).
- **Service and main-process tests**: `src/main/services/__tests__/*.test.ts` (for example `mcpService.transport.test.ts`, `bundledMcpManager.test.ts`).
- **Integration tests**: Co-located with services under `src/main/services/__tests__/`, such as `mcpHttp.integration.test.ts` for Super-MCP HTTP mode.
- **Renderer/React utilities**: `src/renderer/**/*/__tests__/*.test.ts` (for example `resolutionToggle.test.ts`).

When adding new tests, follow these conventions:

- Place tests close to the code they cover (typically in a sibling `__tests__` directory).
- Use `*.test.ts` (or `*.spec.ts`) suffixes so Vitest will automatically pick them up.
- Prefer small, focused test files that mirror the structure of the code under test.

## Running the test suite

All commands below are defined in `package.json` and should be run from the repository root.

- `npm test` / `npm run test` – Run the full Vitest suite once in headless mode (`vitest run`).
- `npm run test:watch` – Run tests in watch mode, re-running affected tests on file changes.
- `npm run test:ui` – Start the Vitest UI for interactive test exploration and debugging in a browser.

You can narrow the test run in a few ways:

- Run a single file:
  - `npm test -- src/main/services/__tests__/mcpHttp.integration.test.ts`
  - `npm test -- src/renderer/features/agent-session/utils/__tests__/resolutionToggle.test.ts`
- Filter by test name using `-t` / `--testNamePattern`:
  - `npm test -- -t "should use HTTP mode when server is running"`

Vitest will respect the `vitest.config.ts` configuration for environment, timeouts, and path aliases regardless of how tests are invoked.

## Integration tests and environment considerations

Some tests exercise more of the runtime stack and may take longer to run:

- **MCP HTTP mode integration tests** (`mcpHttp.integration.test.ts`):
  - Use a temporary directory for Super-MCP configuration so they do not modify your real config.
  - Start and stop a local HTTP server via `superMcpHttpManager` and perform health checks against it.
  - Configure and verify HTTP router mode selection, port handling via `SUPER_MCP_HTTP_PORT`, and concurrent connection handling.

These tests are designed to be self-contained and to clean up any temporary files or processes they start (including temporary directories and HTTP server processes). If you see ports reported as in use or lingering processes, re-running the tests usually clears the state.

## Related validation commands

In addition to Vitest tests, the project uses TypeScript and CSS tooling as part of its validation pipeline:

- `npm run lint` – ESLint (warnings no longer block builds, but agents must fix any they introduce).
- `npm run lint:ts` – Raw TypeScript type-checking (`tsc --noEmit`) for strict type errors.
- `npm run lint:css` – Stylelint over CSS files under `src/**/*.css`.
- `npm run validate:fast` – Combined: lint + IPC + store versions + MCP bundles + circular deps + settings search sync + TS error ratchet + boundary contract enforcement (forbidden terms, cloud channel parity, IPC handler parity) + husky pre-push fast-tier check + integration-test provider-gate check (260419 A3 + A3b).
- `npm run verify:agent` – validate:fast + Knip unused file check + unit tests.
- `npm run verify:agent:full` – verify:agent + electron-vite build.
- `npm run test:e2e:perf` – Performance regression E2E tests only (IPC payload, memory leak, CDP metrics, timing signals). Requires packaged app.

These commands are typically run before packaging or distribution to catch regressions alongside test failures.

## Adding new tests

When adding new automated tests:

1. **Decide the scope** – Unit tests for pure utilities, or integration tests that exercise more of the Electron main process or renderer logic.
2. **Choose a location** – Place tests under a nearby `__tests__` directory (for example `src/main/services/__tests__/`) or as `*.test.ts` files next to the code.
3. **Follow existing patterns** – Mirror patterns used in neighboring tests (use `describe`/`it`, keep setup in `beforeEach`/`beforeAll`, and prefer explicit expectations via `expect`).
4. **Call production code, don't reimplement it** – Tests that duplicate business logic inline (instead of importing the real function) will pass even when the production code regresses. Import and invoke the actual code under test; extract testable helpers if the function is hard to call directly. "Contract tests" that validate external shapes (SDK messages, API schemas) are the exception — there, you're testing the shape, not reimplementing behavior.
5. **Keep tests isolated** – Avoid depending on real user data or external services; use temporary directories, in-memory data, and test doubles where needed, as seen in the existing MCP HTTP integration tests. For E2E tests, see `TESTING_E2E.md` > "Isolated UserData Testing" for the `createIsolatedUserData()` pattern that protects real Electron userData.
6. **Use core test helpers** – `vitest.setup.ts` initializes `PlatformConfig` and `StoreFactory` with test-safe in-memory implementations. `src/core/__tests__/testHelpers.ts` provides `initTestPlatformConfig()` and `TestMemoryStore` for tests that need `vi.resetModules()` re-initialization. Tests for core services no longer need to mock `electron` or `electron-store` — those dependencies are not in the import graph.
7. **Run the suite** – Before committing, run `npm test` and `npm run lint` to ensure new tests pass and the type-checker is satisfied.

### Tests that shell out to `git` (or any tool that reads ambient repo state)

A fixture that runs real `git` commands against a temp repo **must scrub the per-invocation `GIT_*` environment variables**, because the suite frequently runs *inside* the `git push` pre-push hook (`validate:fast` → `vitest related`), where git exports `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_PREFIX` / `GIT_COMMON_DIR` / `GIT_CONFIG_PARAMETERS` into the environment. If the fixture's `git` calls (or production code under test that calls `git`) inherit those, they operate on the **real repository** instead of the throwaway temp repo — silently creating stray commits/branches and even polluting the shared `.git/config`, which corrupts commit authorship for **concurrent agents in sibling worktrees**. Such a test passes standalone and only misbehaves under the hook, so the pre-push run is where you discover it the hard way.

Scrub the vars for the whole suite (`beforeAll` delete + restore in `afterAll`) and pin `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` for hermeticity against the developer's global config. Verify the suite is green **both** standalone **and** with `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` set (which simulates the hook). Reference implementation: [`scripts/__tests__/release-to-production-guards.test.ts`](../../scripts/__tests__/release-to-production-guards.test.ts).

## Editor-wrapping surfaces

When building a UI surface that wraps a third-party text editor (TipTap, Lexical, Slate, contenteditable + custom commands, etc.), follow this contract-test pattern. Editor-wrapping bugs are notorious for the test gap between **"pure helper transforms"** (`docToMarkdown(editor.getJSON())`) and **"the wire format that actually flows through production"** (`getCurrentPromptMarkdown(editor)` invoked via the production wrapper). The pattern below was canonicalised after a `&nbsp;`-corruption bug class shipped through that gap on the composer surface — see [`docs-private/postmortems/260501_composer_tiptap_atmention_nbsp_corruption_postmortem.md`](../../docs-private/postmortems/260501_composer_tiptap_atmention_nbsp_corruption_postmortem.md) for the full incident.

### Why this exists

Editor wrappers compose three contracts: the editor library's node schema, the library's serializer (markdown / HTML / JSON), and your wrapper's transformations (sanitisation, debouncing, snapshot caching, undo/redo glue). A regression in any one of those is invisible to a pure-helper test that operates on `editor.getJSON()` without exercising the wrapper. Production sees the wrapper output. Tests must too.

### The 5 invariants

1. **Shared factory exporting production extension list.** Production `useEditor` and every test consume a single source-of-truth (e.g., `src/renderer/features/composer/utils/composerEditorFactory.ts` exports `createPromptEditorExtensions()`). Drift between test extensions and production extensions is a known footgun: a test that omits `trailingNode: false` will pass while production fails, and vice versa.
2. **Assert through the wire-format wrapper, NOT pure helpers.** The bug surface is the wrapper. A test on `docToMarkdown(editor.getJSON())` will not detect a broken `editor.getMarkdown()` override. Always invoke the same entry point production invokes (e.g., `getCurrentPromptMarkdown(editor)` for the composer).
3. **Property-based fuzzing for round-trip invariants.** Drive a seedable PRNG (e.g., `mulberry32`) through multi-paragraph + special-character + Unicode + bidi-text inputs; assert markdown → doc → markdown returns the same wire string. Determinism via the seed is mandatory — random tests in CI are noise.
4. **`// @vitest-environment happy-dom` for DOM-driven editor behaviour.** Undo/redo, IME composition, paste handling, selection, and any command that touches `document` requires happy-dom (or jsdom). The default `desktop` Vitest project runs `node` environment by design — DOM-driven tests *silently no-op* without the directive. Pino-style "logged a warning, all good" is the failure mode.
5. **ESLint guards with a single sanctioned bypass.** Forbid direct API access in the feature scope (`editor.getMarkdown()`, `setContent({ contentType: 'markdown' })`, `editor.markdown.parse()`, `MemberExpression[property.name='getMarkdown']`). Allow exactly one wrapper site to use the guarded API via `// eslint-disable-next-line` on the single line. In the composer surface, the sanctioned bypass lives in `src/renderer/features/composer/utils/composerSnapshotCache.ts:getLayerASnapshot()` — the layer-A snapshot cache invokes `editor.getMarkdown()` once per doc-mutation cache miss, behind an audited `// eslint-disable-next-line no-restricted-syntax` comment. The public wrapper consumed by production is `getCurrentPromptMarkdown(editor)` (in `src/renderer/features/composer/components/TipTapPromptEditor.tsx`), which routes through the cache. Cross-file dynamic aliasing remains a residual gap; document it in the wrapper's header comment.

### Reference implementations

The composer surface ships the canonical examples — read these together as the working pattern:

- [`src/renderer/features/composer/__tests__/composerMarkdownContract.test.ts`](../../src/renderer/features/composer/__tests__/composerMarkdownContract.test.ts) — 86-row contract test against a real `Editor` instance built from the shared factory; covers serializer round-trip, sanitisation, mention chip insertion, multi-paragraph, special characters, Unicode, bidi, IME composition, undo/redo. The structural skeleton for the pattern.
- [`src/renderer/features/composer/__tests__/wireFormat.contract.test.ts`](../../src/renderer/features/composer/__tests__/wireFormat.contract.test.ts) — backend-regex contract: asserts the renderer-side `tokenForMention()` output is exactly what the council service's `detectModelReferences` regex consumes. Detects renderer/backend wire-format drift at the token level.
- [`src/renderer/features/composer/__tests__/realFixtures.test.ts`](../../src/renderer/features/composer/__tests__/realFixtures.test.ts) — 21 round-trip correctness cases against synthesised real-world fixtures (10 JSON files in the same directory). Uses pure helpers (`docToMarkdown(markdownToDoc(...))`) — complement to wrapper-output tests, NOT a substitute for invariant 2.
- [`src/renderer/features/composer/components/__tests__/TipTapPromptEditor.editor.test.tsx`](../../src/renderer/features/composer/components/__tests__/TipTapPromptEditor.editor.test.tsx) — 17-row happy-dom editor-level tests; uses `// @vitest-environment happy-dom` directive at the top. Demonstrates invariant 4 in practice.
- [`src/renderer/features/composer/utils/mentionContextScheduler.ts`](../../src/renderer/features/composer/utils/mentionContextScheduler.ts) and its tests — testable-without-React-rendering pattern: the scheduler is a pure factory consumed by the React component, so its IME-aware debouncing and fire-time editor re-read can be unit-tested against fakes without the React renderer overhead.
- [`eslint.config.mjs`](../../eslint.config.mjs) (composer scope) — 4 ESLint rules implementing invariant 5: bans on `getMarkdown` member access, `setContent` markdown contentType, `editor.markdown.parse()`, and aliased-options patterns. The single sanctioned bypass is in `getCurrentPromptMarkdown()`.

### How this differs from the live-API integration pattern

The Live-API integration test pattern (above) gates on **provider-shape composition** — auth-shape helpers ≠ provider-shape gates, and the postmortem there is about provider configuration drift. This editor-wrapping pattern gates on **wrapper-vs-helper composition** — pure helper assertions ≠ wrapper-output assertions, and the postmortem here is about wire-format drift between editor library internals and production consumers. They are parallel disciplines, not overlapping ones.

## Agent UI Testing

For UI changes, agents should choose the cheapest reliable verification path in [AGENT_UI_TESTING.md](./AGENT_UI_TESTING.md). The router covers static checks, standalone CLI, packaged Playwright, dev-CDP, MCP tools, and E2E regression paths.

### Quick start

Start with the router, then run the selected recipe:

```bash
npm run test:preflight
npx tsx scripts/ui-test/launch-rebel-test.ts --keep-alive
npx tsx scripts/ui-test/screenshot.ts --out /tmp/rebel-dev.png
```

### When to include UI testing in feature plans

When planning a UI feature (via the Chief Engineer workflow or otherwise), include a test verification stage if the change is testable on screen. See the decision matrix above.

For the planning doc, add a stage like:

```markdown
### Stage N: UI Test Verification

**Test Steps:**
1. Run `npm run test:preflight`
2. Choose the surface via `docs/project/AGENT_UI_TESTING.md`
3. Navigate to [changed area]
4. Verify [expected state] and capture evidence
5. Cleanup using the selected recipe's owner

**Success Criteria:**
- [ ] [What should be visible/true on screen]
```

### What NOT to UI test

- Voice/audio features (no mic automation)
- Native OS dialogs (file pickers, permission prompts)
- External OAuth flows (browser redirects)
- Performance characteristics (use profiling tools instead)

### Related files

- [AGENT_UI_TESTING.md](./AGENT_UI_TESTING.md) – Scenario router and budgets
- [MCP_ELECTRON_CONTROLLER.md](./MCP_ELECTRON_CONTROLLER.md) – Server setup
- [`skills/testing/ui-tester/SKILL.md`](../../skills/testing/ui-tester/SKILL.md) – Router pointer skill
- [`.factory/commands/test-ui.md`](../../.factory/commands/test-ui.md) – Factory `/test-ui` command
