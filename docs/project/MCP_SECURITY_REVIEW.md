---
description: "Workflow for security-reviewing a non-official 3rd-party MCP server we ship in the catalog"
last_updated: "2026-05-13"
---

# Non-Official 3rd-Party MCP — Security Review Process

How to do a defensible security review of a community / 3rd-party MCP server we are about to add to the catalog, or are already shipping. Aimed at preventing the obvious failure modes — telemetry default-on to a maintainer-controlled sink, hardcoded SDK pins drifting between source and tarball, SSRF / auth gaps in HTTP transports, and supply-chain regressions — without spending a week on it per MCP.

This is the workflow that produced [the n8n-mcp review](../research/260513_n8n_community_mcp_security_review.md) on 2026-05-13. **Use it for any non-official MCP whose code we don't own**, especially before shipping to non-technical users. Re-run it on every pinned-version bump.

For deeper context on connector intake, dependency policy, and OSS security policy *for connectors we publish ourselves*, see:

- [`MCP_IMPROVEMENT_WORKFLOW`](MCP_IMPROVEMENT_WORKFLOW.md) — the umbrella workflow for adding/improving MCPs (links here from § "Quality Checklist" and § "Integrating Third-Party MCPs").
- [`MCP_SERVER_STANDARD`](MCP_SERVER_STANDARD.md) — server-implementation standards (auth, errors, security baseline, packaging) for MCPs we own.
- [`MCP_OSS_CONNECTORS`](MCP_OSS_CONNECTORS.md) — OSS distribution policy for MCPs we publish.

---

## When to use this

Run a full review when **any** of these are true:

- Adding a new community / 3rd-party MCP to `resources/connector-catalog.json` (`provider: 'community'`, `'direct'`, or any non-`'bundled'` provider).
- Bumping a pinned version of an existing community MCP (run a **fast** re-review per § "Re-review on bump").
- Switching transport (e.g., `stdio` → `http`) on a community MCP.
- Material upstream events: maintainer change, new GHSAs in a related package, npm 2FA-loss incident, a noted competitor's MCP getting compromised.

Skip (or use a `light` mode — see § "Light mode") for:

- Renaming or copy-editing a connector entry without code or env-var changes.
- MCPs we own (use [`MCP_SERVER_STANDARD`](MCP_SERVER_STANDARD.md) instead).
- MCPs from a vendor we already have an enterprise security relationship with (e.g., we ship Notion's hosted MCP — Notion's security posture is in scope for our procurement process, not this workflow).

---

## What we're looking for

A non-exhaustive list of failure modes we expect to find. **At least skim these before writing the subagent prompts** so your prompts are targeted, not generic.

1. **Default-on telemetry / data exfiltration.** Where does the package phone home? What does it send? Is the sanitisation complete? Is opt-out honoured at every entry point (including early-startup error reporters)? Does opt-out actually prevent network calls or just hide them?
2. **HTTP server auth.** Even if we run stdio, the HTTP code is in the package — confirm we don't accidentally launch it. If we do run HTTP: auth model, default tokens, CORS, rate limiting, request-size limits, bearer leakage in error bodies.
3. **SSRF / host allowlisting on outbound calls.** Loopback, RFC1918, link-local, cloud metadata (`169.254.169.254`), IPv4-as-int, leading-zero IPs, DNS rebinding, redirect-follow. Especially for MCPs where the user supplies a base URL.
4. **Secret handling.** API keys/tokens never logged, never in error bodies, never sent to telemetry. Tight permissions on any on-disk credential store. HTTPS enforcement on outbound calls (or at minimum a documented warning).
5. **Tool input validation.** Zod schemas with `.max(...)` where applicable. JSON parse with size limits. No `eval` / `Function` / `vm.runIn*` / `child_process` paths reachable from tool handlers.
6. **Prototype pollution / ReDoS / path traversal.** Especially in any sanitiser used by telemetry — those run on attacker-controlled data by definition.
7. **Filesystem footprint.** Where does it write on first run? Are permissions correct? Are tmpfiles in user-shared locations?
8. **Supply-chain & install hooks.** `postinstall` / `prepublish` scripts; optional deps that may fetch native binaries; bundled binary blobs (sqlite DBs, ML models) you'd notice if swapped.
9. **Published artifact vs source drift.** The npm tarball can have different `dependencies` (and different `files`) from the source `package.json`. Use `npm view <pkg>@<version> dependencies --json` and `npm pack --dry-run` to check.
10. **Maintainer & repo health.** One-person project? 2FA on npm? Security policy? Disclosure responsiveness? Any history of security reports being mishandled? (Use the GitHub Security tab and the maintainer's reply history — not vibes.)
11. **LLM tool descriptions that coach the model into leaking.** If the package collects `userIntent` or similar in its telemetry, check what the tool-description string sent to the LLM says. A maintainer who tells the model to "include a specific intent string" while also exfiltrating that string is a bigger leak than the sanitiser alone suggests.

---

## The workflow (cost-laddered)

Total wall-clock: ~30–60 minutes for the orchestrator (you), ~$5–15 in subagent cost depending on model mix.

### Phase 0 — Inventory and clone

1. Identify the catalog entry, current pinned version, transport mode, and env vars we set/expose.
2. Clone the upstream repo to a temp location at the **exact pinned version tag** (not `main`):
   ```bash
   mkdir -p /Users/you/dev/projects/mindstone/mcps
   cd /Users/you/dev/projects/mindstone/mcps
   git clone --depth 50 <upstream-url> <pkg-name>
   cd <pkg-name>
   git checkout <tag>
   ```
3. Skim top-level files: `README.md`, `SECURITY.md`, `PRIVACY.md`, `package.json`, `CHANGELOG.md`, `docs/*`. Note any `THREAT_MODEL.md` or `SECURITY_HARDENING.md`. Read the recent commit log around the tag for security-fix patterns.
4. **Check the upstream Security tab on GitHub** for advisories: `https://github.com/<owner>/<repo>/security/advisories`. Note IDs and fixed-in versions.
5. Create the artefact folder:
   ```bash
   mkdir -p docs/research/<YYMMDD>_<connector_id>_security_review
   ```

### Phase 1 — Parallel cheap-model crawl (4 subagents)

Launch all four in **one** assistant turn, in parallel. Each gets a focused brief and writes a Markdown report to the artefact folder. Prompts below are templates — customise the file paths and "what to investigate" sections to the MCP.

#### A. Telemetry / data exfiltration auditor — `reviewer-minimax2.7`

Focus: every place the package opens an outbound network call, what it sends, sanitisation completeness, opt-out coverage, persistent state, failure modes, and recent fixes around telemetry. Writes to `<folder>/A_telemetry_minimax.md`.

#### B. HTTP / auth / SSRF / secrets auditor — `reviewer-kimi-k2.5`

Focus: HTTP server auth (even if we don't run it), SSRF/host validation, secret handling, tool input validation, prototype pollution, ReDoS, path traversal, hardcoded secrets, dangerous APIs (`eval`, `child_process`, raw SQL). Writes to `<folder>/B_http_auth_ssrf_kimi.md`.

> Note: Kimi reviewer droids sometimes return findings inline rather than writing to disk. Save the response content yourself if so.

#### C. External research — `researcher-gpt5.5-high` (or fallback `researcher-gemini3.1-pro`)

Focus: published CVE/GHSA list, dep-of-deps advisories, public discussion (GitHub issues, Reddit, HN), maintainer reputation, npm download stats, release cadence, any "no-telemetry forks," hosted-service privacy comparison. Writes to `<folder>/C_web_research_<model>.md`. Cite a URL for every claim.

#### D. Structural map / dangerous-path inventory — `researcher-gemini3.1-pro` (or `researcher-gpt5.5-high`)

Focus: top-level inventory, entry points, `bin` / `postinstall` / `scripts` hooks, trust boundaries, filesystem footprint, supply-chain behaviour, doc-vs-code mismatches. Explicitly hands off to A and B for deeper dives. Writes to `<folder>/D_structure_map_<model>.md`.

> **Why this split.** A and B do deep code review on the two highest-risk surfaces. C provides the external-record check (CVEs, maintainer rep, deps) that purely static review can miss. D builds the map and surfaces things A and B were not asked about. The four reports overlap deliberately — discrepancies between them are signal, not noise.

#### Prompt template (the actual structure we've battle-tested)

Use these sections, in this order, in every Phase-1 subagent prompt:

```
## Goal
(One paragraph. What does this agent specifically audit, and what's the deliverable?)

## Context
- Repo location (with pinned tag and HEAD hash)
- Launch command we use in the catalog
- Env vars we set
- Target users (e.g., non-technical knowledge workers)
- Coverage hand-off note ("agents X, Y are covering surfaces P, Q — don't duplicate")

## Constraints
- Static analysis only, no installs, no execution, no outbound network from the subagent except for documented public registry reads.
- Read-only.
- Specific things NOT to do.

## What to investigate
(Numbered list, 5–10 items. Each item asks for file:line citations.)

## Required output
Write findings to `<absolute path>`. Use this structure:
(literal Markdown skeleton with section headings)

Then return a short summary (≤ 12 bullets) of top findings, severity-tagged.
```

#### Cost-conscious model choices for Phase 1

| Role | Default droid | Why | Fallbacks |
|---|---|---|---|
| Telemetry / exfiltration audit | `reviewer-minimax2.7` | Strong reasoning, cheap; great at long sanitiser-pattern walks | `reviewer-glm5`, `reviewer-kimi-k2.5` |
| HTTP / auth / SSRF / secrets audit | `reviewer-kimi-k2.5` | Different model family from above; tends to find different things | `reviewer-glm5`, `reviewer-minimax2.7` |
| External web research | `researcher-gpt5.5-high` | Strongest at citation discipline | `researcher-gemini3.1-pro`, `researcher-opus4.7` |
| Structural map | `researcher-gemini3.1-pro` | Strong at top-down structure, complements the deep dives | `researcher-gpt5.5-high`, `researcher-opus4.7` |

Pick model families that genuinely disagree — running two Kimis or two Gemini gives you confirmation bias, not coverage.

### Phase 2 — Consolidation (Codex)

Subagent: `implementer-gpt5.3-codex` (must be the *implementer* variant — the reviewer variant lacks file-edit tools and will fail to write the output file).

Brief: read all four Phase-1 reports + the Rebel catalog entry + the upstream source. Cross-check claims, resolve discrepancies (especially between source-tree and published-tarball claims), rank severity *for Rebel's actual deployment* (not generically), produce an action plan, and identify the 5–8 items most worth Opus's attention. Writes to `<folder>/E_consolidated_codex.md`.

Key prompts that have worked:

- "For each significant finding, identify which agent reported it, whether others corroborate, contradict, or are silent, and whether you can independently verify it with one read of the source."
- "Highlight discrepancies, especially: [list the specific tensions you noticed between the Phase 1 reports]."
- "Rank for our specific launch config. 'MCP servers are risky' doesn't help."
- "Severity scale: CRIT (exploitable today), HIGH (significant residual risk under our config), MED (conditional), LOW (defence-in-depth), N/A-FOR-REBEL (HTTP-only or build-only paths)."
- "Mark anything you can't verify in one read as `[unverified, needs Opus]`."

### Phase 3 — Final adjudication (Opus)

Subagent: `implementer-opus4.7-thinking`.

Brief: read Codex's consolidation. Adjudicate the open items. Do an **independent sniff test** (30 minutes of poking) for things the other reviewers might have missed — especially around sanitiser completeness, LLM-coaching effects, and subtle entry-point reachability. Produce a final severity-ranked list, a keep/restrict/remove verdict, concrete Rebel actions in priority order, and upstream issues with draft titles. Writes to `<folder>/F_opus_final.md`.

The Opus pass is where we spend real money — keep its brief tight. The pre-filtering done by Codex is what makes this affordable.

### Phase 4 — Orchestrator write-up (you)

Write `docs/research/<YYMMDD>_<connector_id>_security_review.md` — the top-level summary. Audience: a future engineer reading this in two months who wants the verdict and the next steps, not a forensic re-read. Structure:

```markdown
---
title: "<Connector name> MCP — Security Review"
date: <YYYY-MM-DD>
package: <npm-name>@<pinned-version>
upstream: <github-url>
catalog_id: <catalog-id>
status: KEEP | RESTRICT | REMOVE
process: docs/project/MCP_SECURITY_REVIEW.md
---

# <Connector name> MCP — Security Review

## TL;DR (3-5 bullets)

## Status box (table)

## Prioritised findings
### CRIT / HIGH / MED / LOW / N/A-for-our-deployment

## Concrete next steps (numbered)

## Open questions

## Pointers to the raw reports (table)

## See also (catalog entry, upstream docs, process)
```

Keep the per-finding body lean — point into the raw reports for the deep evidence rather than re-paste it. The folder of A–F reports is the citation, not the body.

### Phase 5 — Catalog hardening & CI guards

Translate the findings into concrete catalog / code changes:

1. **Catalog env hardening.** Add any "must-set" env vars (typically telemetry-off flags) to the entry's `mcpConfig.env`.
2. **Catalog setupInstructions edits.** Add user-facing warnings (HTTPS recommendation, mention of disabled telemetry, etc.).
3. **CI lint** under `scripts/` validating the invariants the review locked in (transport, telemetry env, setup-copy text, SDK floor). Hook into `validate:fast`.
4. **Upstream issues filed** for the items where the right fix is in their code, not ours. Use the draft titles Opus produced — they're usually well-framed.

Each of these should land as a **separate PR if practical** to keep blame visible. At minimum, the catalog change should be its own commit.

---

## Light mode

For repeat reviews on a pinned-version bump where the previous full review is recent (< 3 months), skip Phases 1–3 and run:

1. `git diff <old-tag>..<new-tag> -- src/ package.json package.runtime.json` — read it yourself.
2. `npm view <pkg>@<new-version> dependencies --json` — check for dep drift.
3. Check the upstream Security tab for new advisories since the previous review.
4. One subagent (`reviewer-gpt5.5-high` or `reviewer-opus4.7-thinking`) reviewing the diff with the previous review's open questions as the brief.
5. Update the existing review doc with a "v<new-version> delta" section. Don't write a new top-level file unless the delta is large.

If the diff contains material changes to telemetry, sanitisers, HTTP server, or any of the dangerous-API areas — go back to the full workflow.

---

## Re-review on bump

When bumping a pinned version, **before merging the bump**:

1. Confirm the previous review's open questions are still the same shape.
2. Run light mode (above).
3. Verify the CI guards still pass (especially the dep-floor check — bumping `n8n-mcp` may also bump or downgrade `@modelcontextprotocol/sdk` in the tarball).
4. If any finding has shifted severity, update the top-level review doc.

---

## Anti-patterns (don't do this)

- **Running one subagent and calling it done.** Different model families catch different things. The Phase-1 quad is non-negotiable for a first review.
- **Running two subagents from the same family** (e.g., two GPT, two Claude). You get confirmation, not coverage.
- **Letting subagents grade their own work** as `[verified]`. The Codex/Opus passes exist to adjudicate, not to rubber-stamp.
- **Reviewing `main` instead of the pinned tag.** The published tarball is the only thing our users run. `main` is research material.
- **Skipping the published-tarball check.** The `package.runtime.json` / publish-pipeline drift pattern we found in n8n-mcp is not unique. Always run `npm view <pkg>@<ver> dependencies --json`.
- **Treating "the maintainer says it's safe" as evidence.** The privacy policy is a claim, not a proof. RLS policies should be inspectable.
- **Hard-failing user setup on the basis of a static finding** when a doc + CI lint will do. Non-technical users should not be debugging your security policy.

---

## Templates

Worked example prompts for all six subagent phases are preserved (in their full, customised form) in the n8n-mcp review folder: [`docs/research/260513_n8n_community_mcp_security_review/`](../research/260513_n8n_community_mcp_security_review/). When starting a new review, copy the structure from that round and adjust the specifics — don't try to remember every section heading from scratch.

---

## See also

- [`MCP_IMPROVEMENT_WORKFLOW`](MCP_IMPROVEMENT_WORKFLOW.md) — the umbrella connector workflow (research → analysis → review → implement → test → docs). This security review slots in **before** "Phase 4: Implementation" for any community connector, and **on every bump** thereafter.
- [`MCP_SERVER_STANDARD`](MCP_SERVER_STANDARD.md) — for MCPs we publish ourselves; different bar.
- [`MCP_OSS_CONNECTORS`](MCP_OSS_CONNECTORS.md) — OSS distribution policy.
- [`MCP_ARCHITECTURE`](MCP_ARCHITECTURE.md) — how connectors work in Rebel.
- [`docs/research/260513_n8n_community_mcp_security_review.md`](../research/260513_n8n_community_mcp_security_review.md) — the worked example.
- Maintainer's [Anthropic guide on writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — useful background for understanding how telemetry-on-by-default + LLM-coached tool descriptions compound.
