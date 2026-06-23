---
description: "OSS connector contribution flow evals — what we have today, what they validate, and the gaps that limit their signal as end-to-end tests"
last_updated: "2026-04-28"
---

# OSS Connector Contribution Flow Evals

## See Also

- [WRITING_EVALS.md](WRITING_EVALS.md) — Central eval overview and links to the other harness docs
- [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) — Sister harness, shares the headless bootstrap, has multi-judge LLM scoring + hermetic MCP twins
- [docs/plans/260427_oss_connector_eval_realism_gaps.md](../plans/260427_oss_connector_eval_realism_gaps.md) — Planning doc proposing the side-by-side conversational eval and other realism upgrades

---

## Overview

Three eval harnesses cover different parts of the OSS connector contribution flow. Their scopes are very different and they should not be conflated.

| Harness | Type | What it actually validates | CI gate? |
|---|---|---|---|
| `evals/connector-build.ts` | Multi-turn agent eval (32 fixtures) | Agent loop wiring, contribution-state tool protocol, store reducer transitions, post-turn sweep, tool-call ordering | Manual menu only (`npm run eval -- connector-build`, ~$2, ~10min) |
| `evals/community-share.ts` | Single-prompt LLM eval (14 fixtures) | The `composeCommunitySharePost` blurb prompt — anonymisation, signoff, no PII, no gushing | Manual menu only |
| `evals/app-bridge-install/harness.ts` | Deterministic contract eval (~12 fixtures) | Settings setup-prompt routing through `rebel_bridge_prepare_install`; pins canonical `browser_id` and the legacy `browserId` alias | **Yes** — runs in `verify:agent` |

The **only** OSS-area eval that gates pre-commit is `app-bridge-install`, and it pins setup-prompt routing rather than the build/extend flow. The full multi-turn build flow (`connector-build`) is an opt-in, manual eval.

---

## `connector-build.ts` — multi-turn build/extend/setup eval

Runs the production agent (`executeAgentTurn`) headlessly against fixtures that prompt the agent to build a custom MCP server, extend an existing one, or set up a connector via the offramp.

### Quick Start

```bash
# One-time key capture + shell load
npm run eval:capture-keys -- --apply
set -a; source evals/configs/.local/keys.env; set +a

# Full suite (32 fixtures, parallel = 1)
npx tsx evals/connector-build.ts --config evals/configs/default.json

# One fixture for iteration
npx tsx evals/connector-build.ts --config evals/configs/default.json --fixture build-coda-contrib-06 --verbose

# Type filter
npx tsx evals/connector-build.ts --config evals/configs/default.json --type build       # build-custom-mcp-server
npx tsx evals/connector-build.ts --config evals/configs/default.json --type extend      # extend-mcp-server
npx tsx evals/connector-build.ts --config evals/configs/default.json --type setup       # connector-setup

# Parallel workers (subprocess fan-out)
npx tsx evals/connector-build.ts --config evals/configs/default.json --parallel 4

# Override models
npx tsx evals/connector-build.ts --config evals/configs/default.json --model claude-sonnet-4-6 --thinking claude-opus-4-7
```

Default model: `claude-sonnet-4-6`. Provider keys are read from env (`process.env`), and runtime settings are resolved from the selected `--config` file.

### `--use-codex` mode (run via your ChatGPT Pro subscription)

The connector-build harness can route working- and background-tier turns through your ChatGPT Pro subscription instead of paying per-token Anthropic charges. This is **opt-in** and has quota guards because ChatGPT Pro has weekly usage limits and a 32-fixture suite at ~30 turns/fixture can burn through them quickly.

```bash
# Single fixture (recommended for iteration)
npx tsx --tsconfig tsconfig.node.json --require tsconfig-paths/register \
  evals/connector-build.ts --use-codex --fixture build-weather-api-01 --verbose

# A specific type
npx tsx --tsconfig tsconfig.node.json --require tsconfig-paths/register \
  evals/connector-build.ts --use-codex --type extend

# A small named batch (sequential, single bootstrap)
npx tsx --tsconfig tsconfig.node.json --require tsconfig-paths/register \
  evals/connector-build.ts --use-codex \
  --worker-batch extend-zendesk-classify-01,setup-apple-reminders-offramp-11 --verbose

# Full suite (will burn quota — explicit override required)
npx tsx --tsconfig tsconfig.node.json --require tsconfig-paths/register \
  evals/connector-build.ts --use-codex --allow-codex-suite
```

Defaults in `--use-codex` mode:
- **Working tier:** `gpt-5.4` with `reasoningEffort: 'medium'`.
- **Background (BTS) tier:** `gpt-5.4-mini`.
- **Anthropic API key:** not required.
- **Output filename:** `..._connector-build_gpt-54.json`.

**Quota guards** (enforced in `main()` of `evals/connector-build.ts`):
- `--parallel > 1` is rejected (parallel Codex requests trip rate limits and confuse the local model proxy).
- A bare `--use-codex` with no `--fixture`, `--type`, or `--worker-batch` is rejected — pass `--allow-codex-suite` to override.

**Prerequisites:**
- You must have signed in to ChatGPT Pro inside the Rebel app at least once. The eval reads encrypted Codex tokens from `~/Library/Application Support/mindstone-rebel/codex-oauth-tokens.json` via an Electron one-shot helper (`scripts/eval/export-codex-tokens.cjs`) that uses `safeStorage.decryptString()`. The helper exits before any windows are created.
- Tokens must be unexpired. The eval **deliberately does not refresh** Codex tokens (refresh-token rotation could corrupt your real token store), so if the access token is expired the eval fails with a clear error and you re-sign in via the app.

**How it works (high level):**
1. `evals/knowledge-work-bootstrap.ts` decrypts your tokens via the Electron helper and registers a `CodexAuthProvider` that returns the cached access token (refresh deliberately throws).
2. `evals/connector-build.ts` constructs two eval-only profiles in the in-memory settings adapter: `codex-eval-gpt-5.4-medium` (working) and `codex-eval-gpt-5.4-mini` (BTS), each with `authSource: 'codex-subscription' + providerType: 'openai'` so they match `isCodexSubscriptionProfile()` in `src/shared/utils/providerKeys.ts`.
3. Any user profile whose model collides with `gpt-5.4` / `gpt-5.4-mini` is dropped from the eval's in-memory profile list (your real persisted settings are untouched) so `findProfile()` deterministically picks the eval profile.
4. `providerKeys.openai` is sanitised to `null` to prevent fallback to a shared OpenAI API key (REBEL-1DZ).
5. `activateTierBundle({ working: 'gpt-5.4', background: 'gpt-5.4-mini' })` resolves to the eval profiles and starts the local model proxy at `http://127.0.0.1:18765`, which forwards to `chatgpt.com/.../codex/responses`.

**Code entry points:**
- `scripts/eval/export-codex-tokens.cjs` — Electron one-shot helper script. Hides Dock, decrypts via `safeStorage`, prints JSON to stdout, exits.
- `evals/knowledge-work-bootstrap.ts` — `useCodex?: boolean` option on `bootstrapEval()`, `createEvalCodexAuthProvider()` reads `node_modules/electron/path.txt` directly (bypasses the bootstrap's `Module.prototype.require` electron stub) and spawns the helper via `execFileSync` with `ELECTRON_RUN_AS_NODE` cleared. The bootstrap intentionally does NOT mutate any other settings — profile injection is the caller's responsibility.
- `evals/connector-build.ts` — `parseUseCodexArg()` / `parseAllowCodexSuiteArg()`, inline construction of the eval Codex profiles in `runSequentialFixtures()`, quota guards in `main()`.

### How it runs

The harness shares `evals/knowledge-work-bootstrap.ts` with the knowledge-work eval, so the headless agent surface is identical. Per fixture:

1. **Bootstrap** (once per run): set up `PlatformConfig`, in-memory settings adapter, error reporter, store factory, handler registry, broadcast service, license tier. Spawn **real Super-MCP** as an HTTP child process, wait for `/api/tools` discovery, register a `search:tools` IPC handler, optionally start the local model proxy.
2. **Memory write hook bypass**: `bypassMemoryWriteHook()` replaces `createMemoryWriteHook` with a no-op so file writes to `~/mcp-servers/` don't stall behind the production approval prompt (which has no headless equivalent).
3. **Per-fixture sandbox**: `createFixtureSandbox()` creates a fresh tmpdir with `.rebel/`, `Documents/`, `Desktop/`, and `mcp-servers/`. `~/.rebel/tool-outputs` is symlinked to a stable workspace base so super-mcp output paths still resolve. `HOME` is rewritten and `process.chdir` points at the sandbox so tilde expansion and relative paths land inside it.
4. **Pre-seed (optional)**: if the fixture sets `preSeedContributions`, those records are created via `createContribution()` directly so cross-session linking can be exercised.
5. **`runConversation()`** — multi-turn loop, max `maxTurns` (default 30):
   - Send prompt → wait for `result` event.
   - If a `user_question` event was emitted during the turn, the regex shim (`evals/connector-build-question-shim.ts`) matches the question text against `fixture.questionAnswers.answers[]` and synthesises a continuation message.
   - If no question, send the next `followUpPrompts[i]` until exhausted.
   - Loop until the agent ends a turn with no question and no follow-ups remain.
6. **Assertions** — built in `buildAssertions()`:
   - `expected_tool` / `forbidden_tool` — regex against tool names (resolves `use_tool` envelopes to the inner `tool_id`).
   - `expected_file` — glob against files created in the sandbox.
   - `evidence` — the `keyEvidence` rubric, evaluated by `checkEvidence()` (regex/`tool_used`/`output_contains`/`tool_input_contains`).
   - `expected_contribution_status`, `expected_transition_error` — read from the contribution store after the turn settles.
   - `expected_tool_test_before_report` — `use_tool(tool_id matches)` was called with non-empty input **before** any `rebel_mcp_report_contribution_state` with `status='ready_to_submit'`.
   - `expected_all_contributions_count`, `expected_contribution_by_name` — multi-connector hijack guard.
   - `expected_wrapper_iserror`, `expected_decision_kind`, `expected_decision_next_action` — Decision envelope parsing on the `rebel_mcp_report_contribution_state` tool result text.
   - `expected_self_correction_within_turns` — anchor on the first deferred report-state call, recovery on first subsequent successful `ready_to_submit`, count distinct turn IDs spanning the two.
   - `expected_linked_session_count` — `linkedSessionIds.length` on the active record (path-keyed identity check).
   - `expected_no_inherited_readiness` — durable-readiness fields on a pre-seeded record do **not** satisfy promotion until the eval session emits fresh `test_passed` / `ready_requested` observations.
   - `forbidden_assistant_text` — assistant text must not match any of the listed regex patterns (used to pin specific failure narration, e.g. "I need permission to register").
7. **Reports** — JSON results plus a per-fixture markdown table (assertions, tool calls, files created, contribution state reports). Default output: `evals/results/connector-build/`.

### Fixture schema

Defined in `evals/connector-build-types.ts`. Sample (`build-weather-api-01.json`):

```json
{
  "id": "build-weather-api-01",
  "evalType": "build-custom-mcp-server",
  "skillAttachment": "rebel-system/skills/coding/build-custom-mcp-server/SKILL.md",
  "prompt": "I want to build a custom MCP server from scratch for the OpenWeatherMap API…",
  "questionAnswers": {
    "answers": [
      { "questionMatch": "ready to build|proceed|shall I", "selectedOptions": ["Yes"], "freeText": "Yes, build it." },
      { "questionMatch": "service name|api name", "selectedOptions": [], "freeText": "OpenWeatherMap" }
    ]
  },
  "expectedToolCalls": ["rebel_mcp_(search|list)_connectors", "rebel_mcp_report_contribution_state"],
  "expectedFiles": ["mcp-servers/**/*"],
  "expectedContributionStatus": "ready_to_submit",
  "rubric": { "keyEvidence": [ /* … */ ] },
  "followUpPrompts": [
    "Great work — now please call rebel_mcp_report_contribution_state with 'draft', then 'testing', then 'ready_to_submit'.",
    "Did you call it with all three statuses? If not, please do so now."
  ],
  "maxTurns": 30
}
```

The full schema is in `connector-build-types.ts`. Notable optional fields covered above: `expectedToolTestsBeforeReport`, `expectedWrapperIsError`, `expectedDecisionKind`, `expectedDecisionNextAction`, `expectedSelfCorrectionWithinTurns`, `expectedAllContributionsBySession`, `expectedLinkedSessionCount`, `expectedNoInheritedReadiness`, `forbiddenAssistantTextPatterns`, `preSeedContributions`.

### What the agent actually runs against

| Surface | Real vs mocked |
|---|---|
| Agent turn loop (`executeAgentTurn`) | **Real** — same code path as desktop |
| Anthropic API | **Real** — live Sonnet 4.6 calls |
| Super-MCP | **Real** — HTTP child process spawned, `/api/tools` discovery |
| `rebel-mcp-connectors` wrapper | **Real** — handlers fire, responses flow back through Decision envelope rendering |
| Contribution store + reducer + post-turn sweep | **Real** — store reads/writes are observable, path-keyed identity is exercised |
| `Task` subagent dispatch | **Real** — fixture `build-subagent-throwaway-realistic-22` deliberately tests it |
| File writes to `~/mcp-servers/` | **Real but bypassed approval** — `createMemoryWriteHook` is replaced with a no-op |
| User questions | **Mocked** — regex shim, falls back to first option silently if unmatched |
| Bash | **Heavily restricted** — `npm`, `node -e`, `curl`, `wget`, `bash -c`, etc. blocked; in hermetic mode a tiny positive allowlist (ls/cat/grep/find/mkdir/touch/git read-only) |
| Tool safety | `cautious`, `trustedTools=[]`, internal MCP servers auto-allowed, others non-blocking-deny |
| Settings | In-memory adapter; never persists |
| MCP router config | **Default mode reads the developer's real router config** — `bootstrapEval()` is called with no options so `hermeticMcp` defaults to `false` |

### Multi-turn shape

`runConversation()` (in `connector-build.ts`) loops up to `maxTurns` per fixture:

```
turn 0: send fixture.prompt
        ├─ agent emits user_question?  → shim answers via regex match → loop
        ├─ no question, follow-ups remain? → send followUpPrompts[i++] → loop
        └─ no question, no follow-ups → done
```

The shim is in `evals/connector-build-question-shim.ts`:
- Match the question text against each scripted `questionMatch` regex; first hit wins.
- For each `selectedOptions`, try exact label match → regex match → fall back to first option (with a warning).
- If no scripted answer matches the question and `skipUnmatched: false`, the shim picks the first option silently.
- Continuation messages are built with `buildUserQuestionContinuationMessage()` (production format).

### Assertion model — what passes a fixture

A fixture passes when **every** assertion passes. There is no LLM-as-judge layer. `keyEvidence` items run through `checkEvidence()` which is regex / `tool_used` / `output_contains` / `tool_input_contains` — deterministic only.

This is materially different from the knowledge-work eval, which runs a multi-judge consensus (Anthropic + OpenAI) with weighted dimensions and a calibration tier — see [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) § Judge System.

### Fixture inventory (32 fixtures)

```
evals/fixtures/connector-build/
├── build-*  (19 fixtures)   custom MCP server creation
├── extend-* (9 fixtures)    extending an existing connector
└── setup-*  (3 fixtures)    offramp setup flows
```

Selected fixtures and what they pin:

| Fixture | What it pins |
|---|---|
| `build-weather-api-01` | Three-status lifecycle (draft → testing → ready_to_submit) — directive follow-ups |
| `build-coda-contrib-06` | Natural contribution-state behaviour — no follow-up, no tool name in prompt |
| `build-clockify-contrib-07`, `build-tally-contrib-08` | Other natural-flow regressions |
| `build-deferred-visible-20` | Deferred decision visibility + recovery flow |
| `build-cross-session-followup-19` | Cross-session linking via path-keyed identity |
| `build-multi-connector-realistic-23` | Two distinct contribution records in one session (multi-connector hijack guard) |
| `build-subagent-throwaway-realistic-22` | Parent dispatches `Task` subagent; post-turn-sweep auto-creates `ready_to_submit` |
| `build-no-self-block-at-registration-24` | Agent must register without pausing for permission; tests per-tool inputs before report |
| `build-same-path-different-connector-21` | Path-keyed identity edge case |
| `build-testing-before-ready-to-submit-16` | `expectedToolTestsBeforeReport` gate |
| `extend-zendesk-registration-wiring-06` | Extending a bundled connector through registration wiring |

---

## `community-share.ts` — composition prompt eval

Tests `composeCommunitySharePost()` in `src/core/services/communityShareService.ts`. **Not** a flow eval — it's a one-shot prompt eval over 14 transcript fixtures.

### What it asserts (per fixture)

Format gates (deterministic):
- Valid JSON with `title` and `body`
- Title length within bounds, follows `How I saved ~` pattern
- Body length within bounds, ends with the required signoff
- Body uses first-person pronouns
- No emails / phone numbers / URLs (PII regex)
- No "gushing" promotional language
- For `pii-heavy` fixtures, body must not contain any `piiTerms` from the fixture

LLM judge (Haiku):
- Faithfulness verdict on the body — does it mischaracterise the session, attribute user ideas to collaboration, or embellish scope?

### Pass-rate ceiling

Documented baseline (as of 2026-04-05): 78.6% median over 4 runs with Haiku. Failures cluster on faithfulness violations on PII-heavy fixtures. Comment in `community-share.ts` notes this is likely the Haiku ceiling and Sonnet would be the next lever.

### Fixtures

`evals/fixtures/community-share/` — categories: `standard`, `pii-heavy`, `short-session`, `edge`. Each fixture supplies a transcript, a formatted `timeSavedFormatted`, and optional `piiTerms`.

---

## `app-bridge-install/harness.ts` — bridge prepare-install contract eval

Pins the Settings setup-prompt routing for the rebel-browser app bridge. Deterministic, fast, runs in `verify:agent`.

### What it pins

- The Settings setup prompt **must** route through `rebel_bridge_prepare_install`.
- Canonical `browser_id` is used (legacy `browserId` alias is accepted).
- `rebel_bridge_list_browsers` exposes the `none-of-the-above` sentinel for unsupported Chromium forks.
- The deprecated skill-led / pairing / reset setup paths fail.

### Fixtures

```
evals/app-bridge-install/
├── harness.ts                          # Runner (deterministic contract checks)
├── adversarial-injection.json
├── diagnose-auto.json
├── no-fingerprint-in-chat.json
├── pair-session-hallucination.json
├── post-consolidation-shape.json
├── post-install-walkthrough.json
├── renderer-owns-success.json
├── reset-install.json
├── step2-turn-boundary.json
├── unknown-fork.json
├── wait-pair-event-happy.json
└── wait-pair-event-timeout.json
```

This is the only OSS-area eval that runs in `verify:agent`. It catches contract regressions but does not exercise an end-to-end agent flow with real LLM calls.

---

## Comparison to knowledge-work evals

The two harnesses share the same headless bootstrap but have very different signal:

| Capability | Knowledge-work | Connector-build |
|---|---|---|
| Hermetic reproducible env | Default for reproducible fixtures | **Off by default** — inherits user's MCP config |
| Real MCP twin servers | Yes (Gmail, Slack, Calendar, export) | n/a (different domain) |
| LLM-as-judge with multi-judge consensus | Yes (Anthropic + OpenAI, calibration tiers) | **No** — pure deterministic gates |
| Multi-dimensional weighted scoring | Yes (3 dimensions, configurable weights) | No |
| Baseline + regression tolerance | Yes | No |
| Pareto / model comparison | Yes | No |
| Multi-turn fixtures with per-turn rubrics | Yes (`turn.rubric`) | Limited (`followUpPrompts` only, no per-turn assertions) |
| Build / compile / run verification of artifacts | n/a | **No** — bash blocks make it impossible |
| Reports separated by fixture realism | Partial (family) | **No** — natural and directive-followup blended |
| CI gating | Manual menu | Manual menu (only `app-bridge-install` runs in `verify:agent`) |

---

## Baselines and regression detection

`connector-build.ts` does not yet support a `--baseline` flag (unlike `narration-eval.ts`). Regression detection is **manual**: re-run the same fixture set on the same model, then diff the per-fixture pass status and the failed-assertion list against a checked-in baseline JSON.

### Where baselines live

```
evals/results/connector-build/
├── baseline-v3-pre-refactor.json          # Aggregated baseline (single file, fast to diff)
└── baselines/
    └── v3-pre-refactor/                   # Raw per-fixture artifacts from the run
        ├── build-*.json                   # Full result JSON (questions, tool calls, assertions)
        └── build-*.md                     # Human-readable per-fixture report
```

The aggregated `baseline-v*.json` schema (per fixture) is intentionally minimal — only the fields needed to detect a regression:

| Field | Purpose |
|---|---|
| `passed` | Top-line per-fixture status |
| `assertionTotal` / `assertionPassed` | Granular pass count (a fixture flipping from 8/10 to 6/10 is a regression even if `passed` was already false) |
| `failedAssertions[]` | The shape of failure (`{type, pattern, detail}`) — diffing this catches "different assertion now failing" |
| `turnCount`, `elapsedMs`, `inputTokens`, `outputTokens` | Cost/latency drift |
| `stalledByWatchdog` | Hard-fail signal — a new stall is always a regression |

### Run history

| Date | Commit | Fixtures | Pass rate (fixtures) | Pass rate (assertions) | Wall time | Stalls | Notes |
|---|---|---|---|---|---|---|---|
| 2026-04-28 | `2197fb8a2` | 6 | 1/6 (17%) | 48/63 (76%) | 41 min | 0 | **V3 baseline** — post-polish, pre-refactor. See [V3 baseline doc](../plans/260428_oss_connector_eval_baseline_v3_pre_refactor.md). |
| 2026-04-27 | (pre-polish) | 6 | n/a (3 stalled) | 25/54 (46%) | ~1h40 | 3 | V2 reference, not checked in. Watchdog stalls inflated wall time. |

The V3 baseline only covers the 6 Tier-S adversarial fixtures (`build-vague-initial-ask-CRM-27` through `build-two-connectors-mixed-auth-32`). It was captured **before** the upcoming main-flow refactor lands and is the gate that refactor must clear.

**Fixtures authored after V3 capture** (deliberately excluded from the V3 baseline JSON):

- `build-skip-se-workflow-33` (commit `454a7d3de`, 2026-04-28) — regression-lock for the SE-workflow-skip / PR #20 failure mode. Currently fails at fixture-load time with a Zod parse error on `expectedDecisionNextAction: run_software_engineer_workflow` because the enum value is not yet added to `evals/connector-build-loader.ts` lines 144-168 (single + array form). That work is scheduled in Stage 0 of [`docs/plans/260428_se_evidence_and_build_context.md`](../plans/260428_se_evidence_and_build_context.md) along with the matching `DecisionNextAction` enum extension in `src/shared/contribution/decisionEnvelope.ts`, the `requiredCreatedFilePatterns` assertion handler (currently a silent-failure bug per the planning doc), and the SKILL grammar row. The fixture will appear in the next baseline once Stage 0 lands. See also [`docs/plans/260428_eval_fixture_skip_se_workflow.md`](../plans/260428_eval_fixture_skip_se_workflow.md) for the fixture's design rationale.

## SE-evidence gate fixture flags

The SE-evidence gate plan ([`docs/plans/260428_se_evidence_and_build_context.md`](../plans/260428_se_evidence_and_build_context.md)) introduces two per-fixture flags that control gate behaviour and assertion coverage:

### `enforceSoftwareEngineerEvidence`

Boolean flag (default: `false` for Stages 0–5). When `true`, the contribution promotion predicate requires Software Engineer evidence before accepting `ready_to_submit`. Fixtures with this flag can exercise the deferred-recovery cycle and the `nextAction: run_software_engineer_workflow` recovery grammar.

- **Default `false`** (Stages 0–5): gate is dormant; all fixtures run with the gate off. This preserves V3 baseline pass-rate during rollout.
- **Default `true`** (future migration plan): gate is on by default; non-SE fixtures that don't expect the gate need updating. The migration plan is tracked separately.
- **Per-fixture override**: any fixture can explicitly set `enforceSoftwareEngineerEvidence: true` or `false` to run on a specific axis.

The V3 baseline fixtures all run with `enforceSoftwareEngineerEvidence: false`. The `build-skip-se-workflow-33` fixture uses `true` to exercise the gate-on path.

### `expectedBuildContextSection`

Boolean flag (default: `false`; opt-in per fixture). When `true`, the harness asserts that the submitted PR body contains a Build Context appendix block (`**Build Context**` heading + structured field block). The assertion targets the `prBody` field in `ConnectorBuildResult`.

- **Default `false`**: the assertion is skipped; no pass/fail signal on appendix presence.
- **Opt-in per fixture**: fixtures that need to verify the appendix lands explicitly set this to `true`.
- **V3 baseline opted in**: the V3 baseline fixtures (Stage 4) set `expectedBuildContextSection: true` to pin the appendix-attaches-on-every-PR contract.

The assertion target is the FINAL submitted PR body — the body composed at the SUCCESSFUL `ready_to_submit` after any deferral-recovery cycles. For `build-skip-se-workflow-33`, this means the post-recovery body where the SE Task has completed and the appendix surfaces `appWorkflow: 'software-engineer'`.

Optional `expectedBuildContextProvenance` assertion can additionally verify specific provenance fields:

```json
{
  expectedBuildContextSection: true,
  expectedBuildContextProvenance: {
    appWorkflow: 'software-engineer',
    buildPlanShape: 'se-working-doc'
  }
}
```

## `scripts/connector-build-baseline-diff.ts` — Stage 4.B baseline comparison tool

Created in Stage 4.B of the SE-evidence gate plan. This is the load-bearing tool for the three-axis comparison protocol; without it, comparing eval runs is manual + error-prone + non-machine-checkable.

### CLI shape

```bash
npx tsx scripts/connector-build-baseline-diff.ts
  --baseline <path-to-baseline-result.json>
  --candidate <path-to-candidate-result.json>
  [--axis v3-set-off | fixture-33-off | fixture-33-on]
  [--strict-config-match]      # fail if superMcpRouterConfigHash differs
  [--allow-trial-mismatch]     # allow trialIndex/trialCount differences
  [--json]                     # machine-readable output (default: human-readable)
```

### Output sections

1. **Run metadata diff** — model, gitHash, gitBranch, timestamp delta, `seEvidenceGateEnabled`, `superMcpRouterConfigHash`, `trialIndex`/`trialCount`, `anthropicApiErrorsObserved`. Flags any unexpected divergence.
2. **Pass-rate delta** — per-axis pass-rate (baseline → candidate), with absolute and relative delta.
3. **Per-fixture verdict matrix** — `pass→pass`, `pass→fail` (REGRESSION), `fail→pass` (IMPROVEMENT), `fail→fail` (no change). Each fixture surfaces its `error` if present + watchdog-stall flags + assertion-mismatch summary.
4. **Infrastructure-error guard** — when `anthropicApiErrorsObserved / totalFixtures > 0.10`, the diff is marked `low-confidence`: regressions in this run are suspect because >10% of fixtures hit infra errors. The user is advised to re-run before treating a regression as real.
5. **Verdict** — one of `regression` / `improvement` / `flat` / `low-confidence` / `incomparable`. `incomparable` fires when `seEvidenceGateEnabled` differs without explicit axis flag, or `gitHash` differs without explicit override.

### Exit codes

- `0` — `flat` or `improvement` (no regression)
- `1` — `regression` (candidate pass-rate below baseline)
- `2` — `low-confidence` or `incomparable` (cannot determine)
- `3` — infrastructure error (script crashed or malformed input)

### Per-fixture flip matrix interpretation

Even when aggregate pass-rate looks flat, per-fixture flips are reported individually. An improvement on one fixture masking a regression on another is a real signal. The matrix surfaces:
- Which fixtures flipped `pass→fail` (regression candidates)
- Which fixtures flipped `fail→pass` (improvement candidates)
- Whether the flip was on an assertion that was previously passing or a new failure mode

## Three-axis comparison protocol

When validating a change to the SE-evidence gate, build-context appendix, or any contribution-flow runtime contract, runs MUST be commissioned across three axes. A change is **validated** only when all three axes pass their per-axis criteria.

| Axis | Fixture set | `enforceSoftwareEngineerEvidence` | Purpose |
|---|---|---|---|
| V3-set-OFF | V3 baseline (6 fixtures) | `false` | Verifies the gate is dormant for non-SE fixtures; pass-rate must NOT regress from V3 baseline (currently 73%). |
| fixture-33-OFF | `build-skip-se-workflow-33` | `false` | Sanity check: with the gate off, the SE-skip fixture's deferred-recovery cycle should NOT fire. Confirms gate-OFF semantics. |
| fixture-33-ON | `build-skip-se-workflow-33` | `true` | The load-bearing test: gate fires, agent recovers within `expectedSelfCorrectionWithinTurns: 3`, FINAL submitted PR body's appendix surfaces `appWorkflow: 'software-engineer'`. |

### Multi-trial expectation

Each axis MUST be run with **≥ 3 trials** to detect signal-vs-noise. Single-trial runs are flagged `low-confidence` by `connector-build-baseline-diff.ts`.

- `trialIndex` and `trialCount` populate the eval-result `metadata` block (Stage 0.6).
- Aggregate the trials per-axis; per-axis pass-rate is the trial-averaged pass-rate (NOT max, NOT min — average gives signal across noise).
- A single-trial flip in either direction (pass↔fail) on the same fixture across trials is a **flakiness alarm** worth investigation BEFORE landing the change.

### Regression-vs-improvement criteria (per axis)

- **V3-set-OFF axis**: candidate trial-averaged pass-rate must be ≥ baseline trial-averaged pass-rate. Strictly less = regression = block. Strictly more = unexpected (V3-set-OFF should be unaffected by gate-only changes; investigate before celebrating).
- **fixture-33-OFF axis**: candidate must produce decision-grammar `accepted`/`submit` (no deferral fires). Any `deferred` decision = regression.
- **fixture-33-ON axis**: candidate must produce the deferred-recovery cycle ending in `accepted`/`submit` AND `expectedBuildContextProvenance: { appWorkflow: 'software-engineer', buildPlanShape: 'se-working-doc' }`. Any deviation = regression.

### Invocation protocol

Use `scripts/connector-build-baseline-diff.ts --axis <axis>` to compare per-axis runs to the corresponding baseline. The tool's verdict gates the decision: `regression` blocks the change; `low-confidence` requires re-run before either decision; `flat` or `improvement` clears that axis. **All three axes must clear** before the change is considered validated.

### Cross-axis interactions

- A change that improves fixture-33-ON pass-rate but regresses V3-set-OFF is a NET REGRESSION (the V3 baseline is the floor, not a tradeoff axis).
- A change that improves V3-set-OFF and fixture-33-ON simultaneously is expected ONLY if the change touches general formatting/composition; pure SE-evidence-gate changes should leave V3-set-OFF flat.

### V3 regression-check protocol (post-Stage-1 and post-Stage-3)

After each code change to the contribution flow, the V3 baseline must be re-run and compared:

1. Re-run all 6 V3 baseline fixtures with `enforceSoftwareEngineerEvidence: false`.
2. Run `scripts/connector-build-baseline-diff.ts --axis v3-set-off --baseline <baseline-json> --candidate <run-json>`.
3. Verdict must be `flat` or `improvement` (not `regression`, not `low-confidence`).
4. If `improvement`, investigate why V3-set-OFF improved — unexpected unless the change was to general formatting/composition.
5. If `regression`, block the change and file a bug.

This is the regression-detection anchor for the SE-evidence gate plan. It ensures that adding the gate + appendix does not break the existing V3 fixture pass-rate.

## V3 baseline regression-check protocol (post-Stage-1 and post-Stage-3)

After each code change that touches the contribution promotion predicate, the build-context formatter, or the submit dispatcher, re-run the V3 baseline and diff:

```bash
# Re-run V3 baseline fixtures
for f in build-vague-initial-ask-CRM-27 build-mixed-case-connector-name-collapse-30
         build-mid-build-redirection-v1-to-v2-28 build-trust-collapse-after-one-error-29
         build-ready-then-edit-invalidates-readiness-31 build-two-connectors-mixed-auth-32; do
  EVAL_RESULTS_DIR=/tmp/v3-rerun npx tsx evals/connector-build.ts --fixture $f --parallel 1
done

# Diff against baseline
npx tsx scripts/connector-build-baseline-diff.ts --axis v3-set-off --baseline evals/results/connector-build/baseline-v3-pre-refactor.json --candidate /tmp/v3-rerun
```

Verdict `regression` blocks the change. See `docs/plans/260428_se_evidence_and_build_context.md` § Stage 4 for the full protocol.

### Diff workflow with `connector-build-baseline-diff.ts`

After a code change that could affect agent behaviour:

```bash
# 1. Re-run the same 6 fixtures, sequential, same model
for f in build-vague-initial-ask-CRM-27 build-mixed-case-connector-name-collapse-30 \
         build-mid-build-redirection-v1-to-v2-28 build-trust-collapse-after-one-error-29 \
         build-ready-then-edit-invalidates-readiness-31 build-two-connectors-mixed-auth-32; do
  EVAL_RESULTS_DIR=/tmp/eval-rerun npx tsx evals/connector-build.ts --fixture "$f" --parallel 1
done

# 2. Run the baseline-diff tool with the appropriate axis
npx tsx scripts/connector-build-baseline-diff.ts \
  --axis v3-set-off \
  --baseline evals/results/connector-build/baseline-v3-pre-refactor.json \
  --candidate /tmp/eval-rerun/<run-id>.json
```

The tool exits non-zero on `regression`; `incomparable` / `low-confidence` verdicts require re-running before any conclusion. See "`scripts/connector-build-baseline-diff.ts`" section above for the full CLI shape and verdict semantics.

### Regression criteria

A change **regresses** the baseline if **any** of:

1. A fixture flips from `passed: true` to `passed: false`.
2. A fixture's `assertionPassed` count drops by more than 1 (single-assertion drift can be LLM noise).
3. A new failed-assertion `type` appears in any fixture (a different *kind* of failure is signal regardless of headline pass count).
4. Any fixture's `stalledByWatchdog` flips from `false` to `true`.
5. `turnCount` or `inputTokens` increases by more than 30% on any fixture (cost/latency regression even if assertions still pass).

A change **improves** the baseline if a fixture flips `false → true` or gains assertions without losing any. When that happens, **update the baseline** in the same commit and document the change in the run-history table above.

### Open follow-ups (tracked, not done)

- `--baseline <path>` + `--tolerance` flags on `connector-build.ts` (mirroring `narration-eval.ts` § 591 of [WRITING_EVALS.md](WRITING_EVALS.md))
- Tier 2 plain-text-question heuristic windowing fix — currently false-positives on `mid-build-redirection` (density=4 anchored on a legitimate single clarification). See V3 baseline doc § "What's FAILING".

### Tooling now in tree (Stage 4.B)

- `scripts/connector-build-baseline-diff.ts` (Stage 4.B, 2026-04-28) — automated diff with the five-state verdict (`regression`/`improvement`/`flat`/`low-confidence`/`incomparable`); non-zero exit on regression. Documented above; see also `docs/plans/260428_se_evidence_and_build_context.md` § Stage 4.B.

---

## Known limitations and gaps

These are the realism gaps that prevent connector-build from being a release-quality end-to-end eval. They are tracked in [docs/plans/260427_oss_connector_eval_realism_gaps.md](../plans/260427_oss_connector_eval_realism_gaps.md).

- **Connector binary is never executed.** `expectedToolTestsBeforeReport` checks the agent *invoked* `use_tool(tool_id)` with non-empty input before reporting `ready_to_submit`. It does not check the call returned plausible output, that the connector compiled, or that the spawned MCP server responded. A "passing" fixture can correspond to syntactically broken TypeScript.
- **Bash blocks `npm install`, `npm run build`, `node`.** The agent cannot verify the connector it wrote, even if it tries.
- **Directive follow-up prompts inflate pass rates.** Several fixtures (`build-weather-api-01`, `build-coda-followup-09`, `build-multi-connector-realistic-23`, `build-no-self-block-at-registration-24`, etc.) have follow-ups that name the tool and statuses verbatim. This tests instruction-following, not organic behaviour. The harness aggregates pass rate by `evalType` so directive passes inflate the headline number for the family.
- **The question shim can silently pick the wrong option.** Unmatched question text or unmatched option label both fall back to the first option without failing the fixture. There is no guarantee the conversation followed the path the fixture author intended.
- **Non-hermetic by default.** `bootstrapEval()` is called without options, so `hermeticMcp` is false. Every developer's real super-mcp router config is the substrate. A "passes on my machine" result is not a regression-quality signal.
- **Subagent realism is degraded.** Real subagent dispatch works, but the subagent inherits the same restricted bash + bypassed write hook. Whatever the parent delegates runs under the same constraints. The fixture follow-up asks "did you run npm run build?" — the environment cannot honestly verify that.
- **No transcript output for human review.** The markdown report dumps tool calls, files, and assertions — but not a chronological transcript of assistant text + user questions + scripted answers. A reviewer cannot easily see what the conversation actually looked like end-to-end.
- **No CI gate on the build flow.** `eval:connector-build` is opt-in. Regressions don't surface at PR time.

---

## File layout

```
evals/
├── connector-build.ts                        # Orchestrator + assertion builder + markdown report writer (2169 LOC)
├── connector-build-types.ts                  # Fixture and result schemas
├── connector-build-loader.ts                 # Fixture discovery + JSON loading
├── connector-build-question-shim.ts          # User-question regex shim
├── community-share.ts                        # Composition prompt eval
├── app-bridge-install/
│   ├── harness.ts                            # Bridge prepare-install contract runner
│   └── *.json                                # Bridge fixture set
├── knowledge-work-bootstrap.ts               # Shared headless agent bootstrap (also used by knowledge-work)
├── knowledge-work-event-adapter.ts           # AgentEvent → tool trace + token usage extractor
├── knowledge-work-helpers.ts                 # Shared helpers (walkSandboxFiles, checkEvidence)
├── shared-broadcast-patch.ts                 # user_question event broadcasting patch
├── shared.ts                                 # Common CLI parsing, results writing, colours
├── fixtures/
│   ├── connector-build/                      # 32 fixtures
│   │   ├── build-*.json                      # Custom MCP server creation
│   │   ├── extend-*.json                     # Extending existing connectors
│   │   └── setup-*.json                      # Offramp setup flows
│   └── community-share/                      # 14 transcript fixtures
└── __tests__/
    ├── connector-build-loader.test.ts
    ├── connector-build-question-shim.test.ts
    ├── connector-build-assertions.test.ts
    └── rebel-mcp-connectors-description-invariants.test.ts
```

Result outputs land in `evals/results/connector-build/` (or `EVAL_RESULTS_DIR` override). Each run writes a JSON results file and a per-fixture markdown report alongside.
