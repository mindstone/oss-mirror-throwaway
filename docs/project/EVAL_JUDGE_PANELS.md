---
description: "Judge panel design: primary + arbitrator roles, per-judge status lifecycle, replay-judge tool, and configuration reference."
last_updated: "2026-06-11"
---

# Eval Judge Panels

Three independent judges score each fixture: one Anthropic model (Opus), one OpenAI model (GPT), and one Google model (Gemini, via OpenAI-compat endpoint). Independent model families means a rate-limit or outage on one provider cannot silently block the others — the panel degrades gracefully rather than catastrophically.

The three-judge panel reflects a direct user directive: restore the proper Opus + GPT primary panel with Gemini as arbitrator and median fallback when the arbitrator is unavailable. See the [reliability plan](../plans/260429_eval_reliability_judge_panel.md) for the full motivation.

**Canonical panel (locked 2026-05-05):** Anthropic Opus 4.7 + OpenAI GPT-5.4 (primaries), Google Gemini 3.1 Pro Preview (arbitrator). GPT-5.4 is held stable across runs for cross-model comparability; bumping the GPT primary requires re-judging prior runs via [`replay-judge`](#replay-judge-tool) before any new comparisons can be made.

## Primary vs Arbitrator Roles

The panel operates in two tiers:

- **Primary judges (Anthropic + OpenAI)** — both run on every fixture unless one fails. Their verdicts form the base consensus.
- **Arbitrator (Google Gemini)** — runs only when:
  - Both primaries agree and the score is close to the 3.0 pass threshold (arbitrator confirms the consensus), or
  - The primaries disagree (arbitrator breaks the tie), or
  - Fewer than two primaries succeed (arbitrator fills the gap as a replacement).

Escalation logic and the degraded-verdict matrix are implemented in `runJudgePanel` in [`evals/knowledge-work.ts`](../../evals/knowledge-work.ts). See that function for the full state machine.

## Per-Judge Status Lifecycle

Each judge call ends in exactly one of these statuses, persisted in the `JudgeResult` for every fixture:

| Status | Meaning |
|--------|---------|
| `success` | Judge returned a valid verdict. |
| `failed-rate-limit` | HTTP 429 from the judge provider. Retried up to 3 times (initial + 2 retries) with exponential backoff. |
| `failed-parse` | Judge response was not valid JSON. May indicate a truncated streaming response. Short retry window (2s/8s/32s). |
| `failed-timeout` | Judge call exceeded its 5-minute window. Single retry at 60s before failing. |
| `failed-other` | Network error, 5xx from judge provider, or other unexpected failure. Retried with 5s/15s/45s backoff. |
| `failed-missing-key` | Judge was configured (present in `HermeticEvalConfig.judges`) but had no API key available — no call was made. Snapshot records this so `eval:replay-judge` knows the gap exists. |

The retry schedule is implemented by `decideJudgeRetry` in [`evals/judgePanel.ts`](../../evals/judgePanel.ts).

## Replay-Judge Tool

When a judge fails during a run (rate-limited, missing key, etc.), `eval:replay-judge` can fill the gap afterwards without re-running the agent. It reads a snapshot written alongside each fixture result and re-runs only the missing judge.

**When to use it:**
- Gemini was rate-limited during the run but you have the snapshot and want the full three-judge verdict.
- A judge key was missing when the run started; it's now configured.
- You want to test a different judge model against the same fixture corpus.

**How snapshots work:**

Every fixture that goes through `runJudgePanel` writes a sidecar JSON to:
```
<results-dir>/.judge-inputs/<runId>/<fixtureId>.json
```

The snapshot contains the full judge prompt (immune to corpus drift between original run and replay), the configured judge list, and every attempted judge's result including errors and timing. Keys are never written to snapshots — `eval:replay-judge` resolves them from the running config or environment.

**Example invocation:**
```bash
npm run eval:replay-judge -- --run evals/results/knowledge-work/260429_125753_command-a-03-2025_rc_all.json --judge gemini-3.1-pro-preview --fixtures missing
```

This replays all fixtures where Gemini's status is not `success`. Run-specific flags (`--fixtures missing` for all failures, `--fixtures fixture-id-1,fixture-id-2` for specific ones) control scope.

The tool is at [`evals/replay-judge.ts`](../../evals/replay-judge.ts).

## Configuration

Judge-panel structure is configured in the hermetic config file passed to eval harnesses via `--config <path>`, specifically at `HermeticEvalConfig.judges` (see [`evals/configs/types.ts`](../../evals/configs/types.ts)).

API keys are env-only at runtime (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, etc.). For local convenience, capture and source keys with:

```bash
npm run eval:capture-keys -- --apply
set -a; source evals/configs/.local/keys.env; set +a
```

**Example panel block** (inside a hermetic config file):
```json
{
  "schemaVersion": "1.0",
  "bundle": { "working": "claude-sonnet-4-6" },
  "cliProvider": "anthropic",
  "judges": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-7",
      "role": "primary",
      "label": "Anthropic Opus (claude-opus-4-7)"
    },
    {
      "provider": "openai",
      "model": "gpt-5.4",
      "baseUrl": "https://api.openai.com/v1",
      "role": "primary",
      "label": "OpenAI GPT-5.4 (gpt-5.4)"
    },
    {
      "provider": "google",
      "model": "gemini-3.1-pro-preview",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
      "role": "arbitrator",
      "label": "Google Gemini 3.1 Pro (gemini-3.1-pro-preview)"
    }
  ]
}
```

Gemini is routed through the OpenAI-compat endpoint at `/v1beta/openai` — the native Gemini API is not used for judge calls.

## See Also

- [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) — Harness overview; judge system summary and adaptive allocation
- [EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md) — score comparability inputs, including judge-panel identity
- [EVAL_HARNESS_RELIABILITY.md](EVAL_HARNESS_RELIABILITY.md) — Error preservation, retry policies, watchdog semantics, and crash isolation
- [WRITING_EVALS.md](WRITING_EVALS.md) — Eval index and fixture guidance
- [`evals/judgePanel.ts`](../../evals/judgePanel.ts) — Canonical source for `JudgeResult`, `JudgeStatus`, `decideJudgeRetry`, and `runJudgePanel` primitives
- [`evals/replay-judge.ts`](../../evals/replay-judge.ts) — Replay CLI implementation
- [`evals/configs/types.ts`](../../evals/configs/types.ts) — Hermetic config schema (including `HermeticEvalConfig.judges`)
