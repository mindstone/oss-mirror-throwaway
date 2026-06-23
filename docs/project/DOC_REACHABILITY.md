---
description: "The reachability principle — an agent should reach most relevant code within ~4 documentation hops — and the auditor that measures it."
last_updated: "2026-06-14"
---

# Doc Reachability

## Principle

An agent (or new developer) should be able to navigate from root `AGENTS.md` to **most relevant code within a handful of hops** — roughly **4 or fewer**:

```
AGENTS.md → [TOPIC]_OVERVIEW hub → narrower/specific doc → the main file(s)/function(s)
            → (then static analysis for callers / consumers from there)
```

If reaching a load-bearing piece of code takes more hops than that — or isn't reachable from the docs at all — that's a signposting gap. The usual remedy is **a small, narrow signpost doc** (or a link from the nearest hub), not more prose. See [DEV_DOCUMENTATION](./DEV_DOCUMENTATION.md) for what good docs look like.

## The auditor

`npm run audit:doc-reachability` (`scripts/audit-doc-reachability.ts`) measures this. **Stage 1 (deterministic):** it builds a markdown → {doc, code} link graph from `AGENTS.md`, BFS-es hop distance over doc→doc edges, and reports — stratified by risk tier (path heuristics + import fan-in from `.impact-map.json`):

- **unreachable high-risk units** — code directories no doc route reaches (act on these first);
- units **reachable but beyond the hop budget**;
- **stale code references** — docs pointing at code paths that no longer exist.

It writes a markdown + JSON report to `tmp/doc-reachability/`. It is a **periodic report, not a CI gate**, and **not** a link-integrity checker (lychee owns that — see `.lychee.toml`).

**Stage 2 (thin LLM-traversal judge)** — `npm run audit:doc-reachability:judge` (`scripts/audit-doc-reachability-judge.ts`) — grades whether a reachable doc *actually orients* an agent (a thin, accurate signpost doc passes; brevity is never penalised). It samples a risk-stratified set (leaf units reached via a one-liner, plus unreachable units to re-check Stage 1), has **Cursor Composer-2** traverse from `AGENTS.md` and grade `PASS_EXACT / PASS_AREA / WEAK / FAIL` with a JSON route transcript, then runs a **deterministic post-check** verifying every cited path exists — a judgment citing a missing path is flagged *untrustworthy* (kills hallucinated routes). Modes: `--prepare` / `--verify <json>` / `--run` (end-to-end). Design, decisions, and known limitations: [`260614_doc_reachability_audit/PLAN.md`](../plans/260614_doc_reachability_audit/PLAN.md).

## How to act on a gap

1. Pick the highest-fan-in unreachable high-risk units.
2. Add a small `[TOPIC]_OVERVIEW`-style or directory-level signpost doc (or a link from the nearest existing hub) that names the area and its key files.
3. Fix any stale code references the report flags.

## See also

- [DEV_DOCUMENTATION](./DEV_DOCUMENTATION.md) — the documentation policy this measures adherence to
- [DEV_DOCUMENTATION_UPDATE_PROCESS](./DEV_DOCUMENTATION_UPDATE_PROCESS.md) — the periodic-audit workflow that runs this auditor
- `scripts/audit-doc-reachability.ts` — the auditor (`runAudit()` is the entry point)
- `scripts/generate-impact-map.ts` — produces `.impact-map.json`, reused for fan-in risk tiers
