---
description: "Living playbook for using the knowledge-work eval as a feedback loop to improve models + harness (autoresearch-style self-improvement); case study + diagnostic reference for MCP tool-call failures"
last_updated: "2026-06-09"
---

# Knowledge-Worker Eval Optimisation

> **TODO (for the Chief / next editor):** add a reciprocal "See also" pointer **from**
> [`KNOWLEDGE_WORKER_EVAL_REPORT.md`](KNOWLEDGE_WORKER_EVAL_REPORT.md) **to this doc**, so the two
> link both ways. (REPORT.md describes the eval *system + results*; this doc is the *optimisation
> playbook* that consumes it. As of 2026-06-09 REPORT.md does not yet exist under that exact name —
> if it is created from the existing eval material, wire the back-link at the same time.)

This is a **living playbook**, not a one-off report. It captures both the *analysis* of a concrete
investigation (MCP tool-call failures, June 2026) and — more importantly — the **process** we
followed, so it can be repeated for the next model/harness improvement.

---

## 1. Purpose & vision — evals as a feedback loop

The end goal is **self-improvement with evals as feedback**, in the spirit of
[karpathy/autoresearch](https://github.com/karpathy/autoresearch): a closed loop where a
reproducible eval drives concrete model + harness changes, the changes are measured against the same
eval, and the loop repeats. This doc is **step one** toward that loop — the manual version of the
cycle, written down precisely enough to automate later.

The knowledge-work eval is the right substrate for this because it is **reproducible and
non-dynamic** (static-response fixtures, locked judge panel, hermetic MCP twins). That means a
before/after comparison is a clean signal, not noise — see
[TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) and
[EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md) for the mechanics that make it reproducible.

**Use this playbook when:** you want to *improve* a model or the harness for a model (lower tool-call
failure rate, recover cost/efficiency, fix a reliability problem, qualify a candidate primary model),
and you can attribute the change to a specific seam (router, system prompt, MCP setup, a Rebel Core
feature). It is **not** the playbook for adding fixtures or rebalancing the rubric — that's
[WRITING_EVALS.md](WRITING_EVALS.md) and the corpus docs.

**Important framing distinction.** Canonical eval runs compare **between model-configurations**
(which model is better). The optimisation loop is the *transpose*: it holds the model-config fixed
and compares **between core/harness variants** for that one model. The harness experimentation infra
(P9, below) exists precisely to make that second axis measurable without polluting the first.

---

## 2. The loop (playbook)

The concrete iterate → measure → fix → re-measure cycle. Each turn of the loop:

1. **Pick a model + a few representative tool-heavy fixtures.** Iteration speed beats coverage. For
   the June run: DeepSeek-v4-Flash on `cross-channel-weekly-digest-01` and friends. Save the full
   30-fixture canonical run for *near the end* — it's the long pole and it costs money.
2. **Run them a lot, headless.** Skip the wizard; drive `evals/.built.mjs` directly:
   ```bash
   # Export keys into THIS shell (the `set -a` is load-bearing — node reads from process.env)
   set -a; source evals/configs/.local/keys.env; set +a

   node evals/build.mjs        # rebuild the bundle after any harness/source edit
   node evals/.built.mjs \
     --config evals/configs/.local/openrouter-gpt54thinking-ds4flash.json \
     --fixture cross-channel-weekly-digest-01 \
     --tier 0 --single-judge --provider openrouter \
     --experiment ds4flash-toolcall --variant alias-deleted --varied core-harness
   ```
3. **Read the run LOGS, not just the scores.** The score tells you *whether* it failed; the log tells
   you *why*. Grep for the tool-call forensics — `-33003` (arg validation) and `-32602` (unknown
   tool) — and count occurrences per error message. See §4 for what the codes mean and how to read
   per-model/per-family scores from the analyzer.
4. **Form a hypothesis** at a specific seam. Prefer the **router seam** (super-mcp `use_tool`) where
   one fix kills the failure class for *all* models by construction — not a per-model prompt patch.
5. **Fix it, then validate with an experiment-tagged spike.** Tag every non-canonical run so it never
   contaminates the canonical dashboards:
   - `--experiment <cohort>` — kebab cohort id (presence of this is what marks a run non-canonical)
   - `--variant <label>` — the arm (e.g. `alias-deleted` vs `alias-present`)
   - `--varied <comp[,comp]>` — which component you changed; vocabulary:
     `model-config | system-prompt | mcp-setup | core-harness | fixtures | judge-panel`
   The analyzer **excludes experiment-tagged runs by default** (opt back in with
   `--experiment <name|all>`). Componentized run-identity keeps canonical runs score-comparable across
   the harness change at the model-config level (system-prompt and core-harness are deliberately
   *out* of the default comparability key).
6. **Confirm with a wider / full-30 run.** Once a fix looks good on the representative fixtures, run
   the canonical suite **untagged** (so it lands as canonical) with the real panel:
   ```bash
   node evals/.built.mjs \
     --config evals/configs/.local/openrouter-gpt54thinking-ds4flash.json \
     --all --tier 0 --rerun-all --parallel 4 --provider openrouter
   ```
   `--rerun-all` bypasses the skip-already-good coverage planner so you get a clean full before/after.

**Run-log retention.** Logs are persisted to Drive (`Product/evals/run-logs/<category>/`), basename
mirroring the result stem so they link by name. The harness tees child stdout/stderr to both the TTY
and that file. This is what makes the "read the logs" step repeatable weeks later — the forensic
evidence for the June investigation lived in `/tmp` and had to be rescued to Drive. **Do not leave
forensic logs in `/tmp`.**

> Headless launches can die on SIGHUP through the deep `npx → npm → tsx → orchestrator → worker`
> chain. For long full-30 runs from an agent/CI context, use a detached session manager (see
> TESTING_EVALS_KNOWLEDGE_WORK.md §detached-runs), not `nohup … &`.

---

## 3. Case study: MiniMax / DeepSeek-v4-Flash MCP tool-call failures (June 2026)

**The trigger:** the early-June knowledge-work eval showed MiniMax-M3 (and others) struggling to call
MCP tools in the format super-mcp's `use_tool` router requires. DeepSeek-v4-Flash was a candidate
primary model, so its failures mattered for a promotion decision.

**The diagnosis — two distinct failure classes, not one MiniMax quirk** (measured from the run logs):

| Class | What the model does | super-mcp result | MiniMax-M3 | DS4-Flash |
|---|---|---|---|---|
| **(A) Type-stringification** | typed scalars sent as strings: `max_results:"40"`, `return_json:"true"`, `limit:"20"` | `-33003` Ajv type error | **242** (~81% of its validation failures) | **0** |
| **(B) Wrong field name** | a field the schema doesn't have: `count` instead of `limit` | `-33003`/strip → reject | 44 | **81** (76 = `count` on `get_slack_channel_history`) |

So "MiniMax struggles to call MCPs" was *true but mislocated*: the root cause is **general harness
weakness in super-mcp's `use_tool`**, and the two weak models stress *different* classes. MiniMax is
overwhelmingly class (A); DS4-Flash types correctly (0 type errors) but trips on field names and then
enters a **non-convergent retry loop** (observed `attempt:15+` on the identical failing call, burning
the whole turn — ~15–17× retries).

**The fixes — all at the router seam, kill-by-construction:**

- **(B) Slack alias deletion + drift-guard.** `super-mcp/src/config/paramAliasMap.ts` carried a stale
  `get_slack_channel_history: [{ from: "limit", to: "count" }]`, but the live connector
  (`mcp-servers/connectors/slack/src/tools/channels.ts:115`) declares canonical
  `limit: z.number().int().min(1).max(200)`. The alias **rewrote a correct `limit` into an invalid
  `count`** — a self-inflicted regression from the connector flipping `count`→`limit` while the alias
  map (a *different* submodule) didn't follow. We verified this end-to-end:
  `normalizeArgKeys({limit:20}, Slack/get_slack_channel_history)` → `{count:20}` against the built
  `dist`. Fix: delete the stale alias (+ the dead `MICROSOFT_TOOL_ALIASES` block targeting tool-ids
  the connector never registers), and the durable form is **connector-owned forgiveness** (accept
  both spellings) + a **startup drift-guard** (alias `to` must exist in the live schema, `from` must
  not) so the class can't silently recur across submodules.
- **(B′) Bare-name top-level resolver.** DS4-Flash also called connector sub-tools (`rebel_search_files`,
  `rebel_search_sources`) by **bare name at the top level** instead of via `use_tool` — super-mcp's
  dispatcher only knows the meta-tools, so it returns `-32602 Unknown tool` (~36 wasted calls/run).
  Fix: in the `super-mcp/src/server.ts` dispatcher `default` case, route an unknown top-level name
  that matches a loaded sub-tool to `handleUseTool({ tool_id: name, args })`, with a clean guidance
  error otherwise. Kills the class for all models.
- **(A) Schema-aware per-field coercion (P3-C).** super-mcp already has `coerceStringifiedNumber /
  Boolean / Json` (`utils/normalizeInput.ts`) but applies them only to its *own* params, never to the
  inner tool's typed fields — even though the handler has the resolved target schema in hand at
  validation time (`useTool.ts:1021`). Fix: walk the resolved schema and coerce per-field **only when
  the schema type ∈ {number, integer, boolean}** (never touch `string`/`enum`), with Ajv as backstop.
  A controlled spike already proved the principle: real typed schema → 12/12 clean; schema-less
  wrapper → 12/12 stringified (`docs/research/260605_minimax_tool_arg_stringification_spike.md`).

**The honest value calibration.** These fixes recover **cost/efficiency + reliability**, *not* the
bulk of the leaderboard quality gap (which is reasoning on tool-light families). DS4-Flash is the
lowest-efficiency model (~$8.67/30-fixture run, inflated 15–17× by the retry loop) and a turn-burning
loop can *fail a fixture outright*. That is exactly why these fixes de-risk promoting DS4-Flash to
primary even though they may not move judge score much: **a primary that loops 16× is a production
problem regardless of judge quality.**

**The deeper architectural fork (unresolved, decision-relevant).** super-mcp exposes one generic
`use_tool` router over hundreds of typed sub-tools; the model never sees a per-call typed JSON schema,
only prose + a schema-less `arguments` object. P3-C (coercion) is the cheap by-construction backstop.
**P3-A** (inject the resolved tool's *real* typed `input_schema` into a per-tool `use_tool` variant) is
the architecturally-honest fix matching the spike's winning condition — but it's a Phase-3 STOP-class
change to a shared OSS contract, so it must be **spiked with data before committing**, not blind.

---

## 4. Diagnostic signals reference

**The two error codes (this is the core forensic vocabulary):**

- **`-33003` — argument validation failure.** The tool was found, but the args didn't pass Ajv
  against the resolved schema. The model receives the full **`repair_ticket`** (JSON-stringified into
  the tool_result text, capped ~2000 chars). This is class (A) type errors and class (B) unknown
  fields. Sub-messages tell you which: `expected number, got string` (class A) vs an unknown-field
  rejection (class B).
- **`-32602` — unknown tool.** super-mcp's top-level dispatcher only knows the meta-tools
  (`use_tool`, `search_tools`, `list_tools`, `get_tool_details`, …); a **bare** connector tool name
  hits the `default` case and is rejected. This is the bare-name class (B′).

**How to grep the logs.** Count human-readable error occurrences per class in the retained run log,
e.g.:
```bash
grep -c "code=-33003" <run-log>
grep -oE "expected (number|boolean|integer|array), got [a-z]+" <run-log> | sort | uniq -c
grep -oE "Unknown tool: [a-z_]+" <run-log> | sort | uniq -c   # -32602 / bare-name class
```

**Reading per-model / per-family scores** comes from the analyzer
(`evals/analyze-knowledge-work-*.ts`): judge score (1–5), pass%, efficiency, and family breakdown
(`large_data`, `cross_channel`, `meeting_prep`, …). The tool-heavy families (`large_data`,
`cross_channel`) are where tool-call fixes show up; tool-light families are reasoning-bound and won't
move.

**Tool calls are emergent, not fixture-pinned.** A fixture's JSON does not enumerate which tools the
model will call — *the model decides at runtime*. In the June run the chosen validation fixture made
**0** `get_slack_channel_history` calls, so a "passed" result did **not** prove the alias fix. When
measuring a fix, first confirm the fixture *emergently drives the tool you changed* (read the log),
or you're measuring nothing. Likewise, `large_data` fixtures *do* drive tool calls even though the
mcp-twins serve responses deterministically and no tool name appears in the fixture JSON — don't infer
"tool-free" from the fixture file.

---

## 5. Lessons / pitfalls

- **Verify a hypothesised "regression" against the BASELINE logs before chasing it.** When
  `rebel_search` returned `-32602` in the worktree run, it looked like a fresh break. The decisive
  check: the **June baseline DS4-Flash logs show the identical `-32602` ×36** — it was *not* a
  regression, just the bare-name class reproduced faithfully. A per-run anomaly that also exists in the
  baseline is not your bug. (Cf. the broader rule: a per-function/per-run "regression" claim is false
  if the same behaviour is present at base — verify end-to-end.)
- **Paired baseline-vs-fix on the *same* fixture cancels confounds.** Run `--variant alias-present`
  and `--variant alias-deleted` on the same fixture/model/seed; the diff is the fix's effect, with the
  model's randomness and the fixture's quirks held constant.
- **Prompt fixes don't fix stringification — use the router.** Three system-prompt variants all went
  12/12 *fail* on class (A) in the controlled spike. The model receives the full `repair_ticket` and
  *ignores* it. Structural fixes at the seam (coerce / alias / bound the loop) beat "surface the ticket
  better" or "tell the model in the prompt." Ask "can I make this not even reach the failure path?"
  before reaching for a prompt tweak or a test.
- **Tag every experiment so it never pollutes canonical dashboards.** `--experiment` presence is the
  *only* thing that marks a run non-canonical (keyed on metadata, never on filename). Forget the tag
  and you corrupt the leaderboard. Conversely, drop the tag deliberately when you want the run to land
  *as* canonical (the final confirmation full-30).
- **Don't trust a researcher's "it doesn't run in that path" without re-verifying.** The twins-fidelity
  report asserted the stale alias "does not run in the eval path (twins bypass super-mcp)." A direct
  spike against the built `dist` showed it **does** run (the eval routes through built super-mcp; the
  alias fired and trapped `limit`→`count`). Re-verify path/architecture claims with an isolated spike
  before building on them.
- **Read logs, not just scores.** A fixture can *pass* while the model wasted 16 retries and $X on a
  loop you're trying to fix; the score hides it, the log shows it.

---

## 6. See also

- [`docs/plans/260608_minimax-ds4-mcp-toolcall-eval/PLAN.md`](../plans/260608_minimax-ds4-mcp-toolcall-eval/PLAN.md)
  — the full investigation, P1–P9 proposals, re-run set, and Decision Log (primary source for §3).
- [`docs/research/260605_minimax_tool_arg_stringification_spike.md`](../research/260605_minimax_tool_arg_stringification_spike.md)
  — the controlled stringification spike (authoritative record of the class-A mechanism).
- [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) — harness mechanics, CLI flags,
  key capture, detached runs.
- [EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md) — corpus hashes, score-field fingerprints,
  `analysisSchemaVersion` comparability (the basis for componentized run-identity).
- [WRITING_EVALS.md](WRITING_EVALS.md) — adding fixtures / overview (the *other* axis from this doc).
- [`evals/AGENTS.md`](../../evals/AGENTS.md) — eval-directory agent instructions.
- `KNOWLEDGE_WORKER_EVAL_REPORT.md` — the eval *system + results* report this playbook consumes
  **(reciprocal back-link TODO at the top of this doc).**
