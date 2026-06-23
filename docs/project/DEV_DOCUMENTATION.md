---
description: "Canonical guide for writing internal developer documentation in docs/project/ — principles, doc genres, folder organisation, signposting conventions, in-code comments, frontmatter, and what to leave out."
last_updated: "2026-05-14"
---

# Developer Documentation

The canonical place that defines our internal developer documentation: what to write, where it lives, how to organise it, and how to keep an AI coding agent oriented inside the codebase.

## See also

- [DEV_DOCUMENTATION_UPDATE_PROCESS](./DEV_DOCUMENTATION_UPDATE_PROCESS.md) — the **periodic-audit workflow** that keeps these docs accurate
- [DOC_REACHABILITY](./DOC_REACHABILITY.md) — the **~4-hops reachability principle** and the auditor that measures it
- [CAREFUL_DOC_UPDATES_PROCESS](./CAREFUL_DOC_UPDATES_PROCESS.md) — the **per-batch update workflow** for risky doc edits
- [REBEL_SYSTEM_FILES](./REBEL_SYSTEM_FILES.md) — audience separation between `docs/project/`, `rebel-system/`, and `coding-agent-instructions/`
- [HELP_FOR_HUMANS_DOCUMENTATION](./HELP_FOR_HUMANS_DOCUMENTATION.md) — sister guide for user-facing docs in `rebel-system/help-for-humans/`
- [AI_INSTRUCTIONS_ARCHITECTURE](./AI_INSTRUCTIONS_ARCHITECTURE.md) — layered instruction architecture (shared submodule vs repo-specific)
- [`rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md`](../../rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md) — the **user-facing variant** of this guidance; the format/structure advice there applies here too, this doc just adds Rebel-dev-specific policy
- [`rebel-system/skills/documentation/signposting-to-single-source-of-truth/SKILL.md`](../../rebel-system/skills/documentation/signposting-to-single-source-of-truth/SKILL.md) — cross-referencing without duplication
- [`rebel-system/skills/documentation/write-planning-doc/SKILL.md`](../../rebel-system/skills/documentation/write-planning-doc/SKILL.md) — for ephemeral `docs/plans/` planning docs

## Why this doc exists

We have a lot of AI coding agents working in this codebase. Good docs are how an agent — and a new human developer — orients quickly, makes correct decisions, and avoids unknowingly reversing prior considered choices.

Documentation that drifts or buries the *why* behind a wall of implementation prose is actively harmful: it consumes context budget, can mislead, and creates false confidence. So we keep docs **sparse, intent-first, and heavily signposted**, and we prefer **many small focused docs** over a few sprawling ones — small docs are easier to keep accurate, easier to signpost between, and cheaper to load into context.

The 2025-2026 external evidence base for this approach is summarised in [`260514_documentation_best_practices_rollout`](../plans/260514_documentation_best_practices_rollout.md) (Appendix A2 + A4) for anyone who wants the references. If that plan has been archived, look under `docs/plans/finished/`.

## Rollout status

This doc is the policy. Several parts of the policy are still rolling out via [`260514_documentation_best_practices_rollout`](../plans/260514_documentation_best_practices_rollout.md):

- Nested `AGENTS.md` at major code boundaries — landed for `src/core/`, `src/main/`, `src/renderer/`, `cloud-service/`, `mobile/`, `evals/` (Stage B).
- Link-checker CI — landed in **report-only mode** via `.lychee.toml` + `.github/workflows/docs-link-check.yml` (Stage C). The cleanup pass in Stage E drove the broken-link inventory from 81 to 0; the workflow can now be flipped from `continue-on-error: true` to blocking once a release cycle confirms no unintentional regressions slip in.
- In-code TSDoc `@see` signposts on entry-point files — landed for 11 high-traffic files (Stage D).
- Evergreen→planning-doc signposts and broken-plan-path cleanup — landed (Stage E). The remaining staleness lives in narrative prose in a small number of docs (notably `MCP_CONNECTOR_CONTRIBUTION_FLOW.md`, which still describes the pre-`4ccafd7e7` promotion architecture) and is left for content-aware follow-up.
- Topical subfolders for `docs/project/` — deferred to a follow-up pass; see Stage F. Today the directory is still mostly flat with strong filename prefixes.

Where this doc describes a target state, the rollout-status note in each relevant section calls it out.

## Principles

`docs/project/` documentation should emphasise:

- **HIGH PRIORITY — intent.** User intent, requirements, how things are supposed to work, the vision behind it, why we did things a certain way. Capture decisions, chosen alternatives, and reasoning — especially after long thoughtful conversations with the user. For guidance on capturing user intent well (verbatim quotes, preserve-vs-synthesize, conversation-type patterns), see [`export-llm-chat`](../../rebel-system/skills/utilities/export-llm-chat/SKILL.md).
- **HIGH PRIORITY — signposting.** To other docs, to relevant bits of the code (file paths plus symbol names where useful), to URLs. This helps the agent orient and avoid missing relevant other areas.
- **LOWER PRIORITY — an overview of how the system works.** Sparse and high-level. Code is the source of truth for *how*.

**Why this matters.** Changes made by future agents must stay aligned with intent and not unknowingly reverse important decisions. Signposting ensures agents get to the right bit of code quickly (without filling up context with irrelevant stuff) and make good decisions about where to make changes (because they're aware of existing machinery and how it all works together). We aim for an agent to reach **most relevant code within ~4 hops** (`AGENTS.md` → `[TOPIC]_OVERVIEW` hub → narrower doc → file/function, then static analysis); we measure and maintain this — see [DOC_REACHABILITY](./DOC_REACHABILITY.md).

**Solution quality.** Prefer clean, simple, elegant docs. Aim for general/reusable, robust framing that captures the durable *why*, not brittle, over-specific implementation notes that will rot. Avoid over-documenting.

## Doc genres and where they live

| Genre | Location | Audience | Bundled with app? | How to write |
|-------|----------|----------|-------------------|--------------|
| Internal evergreen | `docs/project/` | Rebel developers | No | This doc |
| Planning (ephemeral) | `docs/plans/` (and `finished/`, `obsolete/`, `partway/`) | Rebel developers | No | [`write-planning-doc`](../../rebel-system/skills/documentation/write-planning-doc/SKILL.md) |
| Postmortems | `docs-private/postmortems/` | Rebel developers | No | No dedicated skill yet — match the style of recent files in the folder |
| Library reference | `docs/research/libraries/` | Rebel developers | No | This doc + [DEV_DOCUMENTATION_UPDATE_PROCESS](./DEV_DOCUMENTATION_UPDATE_PROCESS.md) for freshness rules |
| Tutorials | `docs/tutorials/` | Rebel developers | No | Match the style of recent files in the folder |
| In-code (nested) | `<dir>/AGENTS.md`, `<dir>/README.md` | AI agents + developers in that subtree | No | This doc § AGENTS.md and README.md |
| In-code (signpost comments) | Top-of-file TSDoc / native comment with `@see` | AI agents + developers reading that file | No | This doc § In-code signpost comments |
| User-facing skills | `rebel-system/skills/` | End users (via the agent) | **Yes** | [`write-skill`](../../rebel-system/skills/documentation/write-skill/SKILL.md) |
| User-facing help | `rebel-system/help-for-humans/` | End users | **Yes** | [HELP_FOR_HUMANS_DOCUMENTATION](./HELP_FOR_HUMANS_DOCUMENTATION.md) |
| Shared agent instructions | `coding-agent-instructions/` | AI coding agents across repos | No | [AI_INSTRUCTIONS_ARCHITECTURE](./AI_INSTRUCTIONS_ARCHITECTURE.md) |

Use the audience to pick the location. See [REBEL_SYSTEM_FILES](./REBEL_SYSTEM_FILES.md) for the full rationale on the three-way split.

## Folder organisation: topical subfolders + `[TOPIC]_OVERVIEW.md` hubs (target state)

> **Rollout status:** target state. Today `docs/project/` is still mostly flat with strong filename prefixes (`ARCHITECTURE_*`, `MCP_*`, `UI_*`, `TESTING_*`, etc.). Migration to subfolders is tracked in Stage F of [`260514_documentation_best_practices_rollout`](../plans/260514_documentation_best_practices_rollout.md). Until that lands, place new docs at the top level using the existing prefix convention.

The target shape is **topical subfolders**, each containing:

- A `[TOPIC]_OVERVIEW.md` hub (e.g. `MCP_OVERVIEW.md`) — frontmatter, brief intent paragraph for the topic, a one-line blurb signposting each doc inside, and a See also block. Name hubs `[TOPIC]_OVERVIEW.md`, not a bare `OVERVIEW.md`, so they stay self-describing wherever they're linked or opened (matching today's `MCP_OVERVIEW`, `UI_OVERVIEW`, `ARCHITECTURE_OVERVIEW`, …).
- The topical evergreen docs themselves

Root `AGENTS.md` signposts to each `[TOPIC]_OVERVIEW.md` rather than listing every doc.

The planned subfolders (subject to refinement during Stage F): `architecture/`, `mcp/`, `ui/`, `testing/`, `evals/`, `build-and-release/`, `cloud/`, `mobile/`, `process/`, `safety/`, `debugging/`, `onboarding/`, `platform/`.

A small number of "front door" docs live at the top level of `docs/project/`: `CODING_PRINCIPLES.md`, `PROJECT_OVERRIDES.md`, `PRODUCT_VISION_FEATURES.md`, `BRAND_VOICE.md`, `SUBAGENT_REFERENCE.md`, `AI_INSTRUCTIONS_ARCHITECTURE.md`, this doc.

When adding a new doc, place it inside the right subfolder once Stage F lands; create a new subfolder only if you have at least 3-4 related docs and the topic doesn't fit any existing one. Discuss with the user before adding a new subfolder.

## `AGENTS.md` and `README.md` in code subdirectories

Nested `AGENTS.md` files belong **at major architectural boundaries**, not in every folder. Current set:

- `src/core/`, `src/main/`, `src/renderer/` — the three desktop process surfaces
- `src/preload/` — the Electron context-isolation security boundary
- `cloud-service/`, `mobile/` — the cloud and mobile surfaces
- `cloud-client/`, `packages/shared/` — the cross-surface shared client library and platform-agnostic utility hub
- `evals/` — the eval suite
- `mcp-servers/` — the MCP connector monorepo (a submodule; maintains its own)

This is the set of *major boundaries*, not a cap — add one when a new boundary clears the bar below. **Bar for a new boundary:** a directory consumed across surfaces (or otherwise load-bearing) whose "don't reverse this" rules are *not* self-evident from reading the code. If the rules are obvious from the files, or it's just an app surface consuming shared libraries, skip it — an extra `AGENTS.md` dilutes context (see the arXiv evidence in [`260514_documentation_best_practices_rollout`](../plans/260514_documentation_best_practices_rollout.md)) more than it helps. **Intentionally excluded:** `src/shared/` is covered by the root `AGENTS.md` plus the dense headers in `src/shared/ipc/contracts.ts` / `cloudChannelPolicies.ts` / `cloudSettingsPolicy.ts`; don't add a nested file there without revisiting that decision with the user.

Each is **short** (target under 200 lines per Anthropic's `CLAUDE.md` guidance; in practice 30-80 lines is plenty) and contains:

- Frontmatter (`description`, `last_updated`)
- One-paragraph intent statement for the directory
- Hard rules ("never import `electron` here", "use boundary interfaces", "stores must use lazy `getStore()`")
- A See also block signposting to the parent `AGENTS.md`, the right `docs/project/` docs, and key code entry points inside the directory

Do **not** put implementation walkthroughs in a nested `AGENTS.md`. If you find yourself doing that, the content belongs in an evergreen doc and the `AGENTS.md` should just signpost to it.

`README.md` (instead of `AGENTS.md`) is used when the folder has a human audience too — e.g., `src/renderer/components/ui/README.md` for component-library users, `evals/README.md` for eval-suite operators. Same shape, different name.

## In-code signpost comments (policy)

When a code file is intent-critical or sits at an architecturally important entry point, add a top-of-file TSDoc-style header that signposts to the relevant doc(s) and to other key code. This gives an agent a low-cost "where am I, what else should I read?" anchor — the cheap **reverse** of [doc reachability](./DOC_REACHABILITY.md). Where a full header is overkill, a one-line `// See: docs/project/FOO.md` pointer counts too.

```ts
/**
 * Electron main process entry point. Boots the app, wires boundary
 * interfaces (platform / storeFactory / handlerRegistry /
 * broadcastService), and runs the agent turn loop via
 * executeAgentTurn().
 *
 * @see docs/project/REBEL_CORE.md — runtime architecture
 * @see docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md — turn pipeline
 * @see docs/project/ARCHITECTURE_OVERVIEW.md — system overview
 */
```

**When to add a header:**

- The file is listed in root `AGENTS.md` § Code Entry Points
- The file implements or wires a boundary interface
- The file enforces a non-obvious invariant (e.g., a security check, a fallback contract)
- The file is at a place where an agent would benefit from being pulled out to a doc before making a change
- You're editing the file anyway and notice it lacks one

**Style:**

- 4-10 lines. Purpose on top, `@see` lines after.
- Prefer `@see` with a relative path or `docs/project/...` path. Symbol names are OK ("see `executeAgentTurn()`").
- Don't restate what the code does — let identifiers and types do that. Capture the **why** and the **where to read more**.
- Don't reference the current task / fix / PR; that becomes stale (this is consistent with the project's general comment policy).
- **Non-TS files** (Python, shell, JSON, etc.) use the language's native comment style. The shape stays the same: short purpose, then "See: ..." pointers.

**Drift mitigation:** the link-checker CI (see `.github/workflows/docs-link-check.yml`) catches `@see` paths that rot. It runs in report-only mode today; blocking once Stage E of [`260514_documentation_best_practices_rollout`](../plans/260514_documentation_best_practices_rollout.md) clears the existing inventory. Fix or remove a wrong signpost as soon as you spot it — a wrong signpost is worse than no signpost.

## Signposting conventions

### Two-way signposting

When you add a new doc, add inbound links **to** it from related docs, and outbound links **from** it to related docs. The signposting is the doc.

### Signposts from evergreen docs to planning docs

Where a planning doc (active, finished, or obsolete) carries useful context (decisions, rejected alternatives, full rationale) that an agent would benefit from, the relevant evergreen doc should include a one- or two-line signpost — *not* duplicated content. Pattern:

> See `docs/plans/finished/<yyMMdd_some_decision>.md` for the original rationale: chose A over B because of cross-surface parity (rejected because boundary interfaces handled the case more cleanly).

(Use the real planning-doc path when applying this pattern.) Keep the inline summary to one or two sentences; the full reasoning stays in the planning doc.

### Cross-reference format

Bullet lists with a one-sentence "why this matters":

```markdown
- [SAFETY_SYSTEM_OVERVIEW](./SAFETY_SYSTEM_OVERVIEW.md) — overall safety architecture, links to tool/memory/bash safety docs
- `src/main/services/toolSafetyService.ts` — LLM-based tool safety evaluation; see `evaluateToolSafety()` for the core flow
- [Anthropic context-engineering post](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — external reference on context budgets
```

Prefer `file path + symbol name` over brittle line numbers.

### Single source of truth

Each piece of information should have one canonical home. Link to it rather than duplicating. Repeating a 2-3-sentence summary in two places is fine; restating a multi-paragraph explanation in two places is not. When in doubt, signpost.

## Frontmatter standard

All `docs/project/` files should have YAML frontmatter:

```yaml
---
description: "One-line summary of what this doc covers"
last_updated: "YYYY-MM-DD"
---
```

`description` makes the doc easy to scan at a glance and is the natural field for future tooling (indexes, search) to consume. `last_updated` lets the periodic-audit workflow flag stale docs. When auditing, add frontmatter to any doc missing it.

Some docs in the tree have additional fields (sync pair info, ratchet baselines, etc.) — those are doc-specific operational state and don't need to spread.

## What to write (and what to leave out)

**Write:**

- The user-facing intent and requirements (especially anything that came from a long, thoughtful conversation — see [`export-llm-chat`](../../rebel-system/skills/utilities/export-llm-chat/SKILL.md) for capture patterns; note that raw conversation exports live in Google Drive, not the repo)
- The decisions, the alternatives we considered, and why we chose what we chose
- The principles and constraints we want future agents to respect
- Signposts to the code that implements this and to related docs
- Gotchas and limitations that aren't obvious from the code
- Just enough overview to make the rest navigable

**Leave out:**

- Line-by-line "how this function works" — code is the source of truth
- Auto-generated API references — they drift fast; signpost to the code instead
- Stable, well-understood patterns that don't need restating
- Anything you'd expect to be wrong in three months — signpost to the canonical source

If you find yourself narrating a function body, stop and signpost to the function instead. If you find yourself documenting a stable framework convention, stop and signpost to the framework docs instead.

This is a guideline, not a hard ban. Sometimes a small worked example is the clearest way to capture intent. Use judgement.

## Filename conventions

- Evergreen docs in `docs/project/`: `TOPIC_NAME.md` (uppercase, underscore-separated). Subfolders use lowercase (`mcp/`, `architecture/`).
- Planning docs in `docs/plans/`: `yyMMdd[letter]_description_in_lowercase.md` (see the [planning-doc skill](../../rebel-system/skills/documentation/write-planning-doc/SKILL.md)).
- `[TOPIC]_OVERVIEW.md` (e.g. `MCP_OVERVIEW.md`) is the convention for a topic's hub doc — used flat today, and inside the topic's subfolder once Stage F lands.
- `AGENTS.md` is the convention for nested agent-instruction files in code subdirectories.
- `README.md` is the convention when a code subdirectory also has a human audience.

## Quality checklist

Before committing a doc change:

- [ ] Captures intent / decisions / rationale, not just implementation prose
- [ ] Signposts to code (with symbol names where useful) and to related docs
- [ ] No stale file paths or references to removed code
- [ ] Cross-references added in both directions where helpful
- [ ] Frontmatter `description` and `last_updated` present and accurate
- [ ] Examples match current code patterns
- [ ] No duplication of content that already exists elsewhere — signpost instead
- [ ] No unrequested implementation walkthroughs
- [ ] Voice is clear and concise (and Rebel's [brand voice](./BRAND_VOICE.md) if the copy might surface in user-visible places)

## Maintenance

See [DEV_DOCUMENTATION_UPDATE_PROCESS](./DEV_DOCUMENTATION_UPDATE_PROCESS.md) for the periodic-audit workflow (frontmatter checks, link checks, library-version freshness, broken-signpost fixes).

For risky or important per-batch updates, use [CAREFUL_DOC_UPDATES_PROCESS](./CAREFUL_DOC_UPDATES_PROCESS.md): clarify intent before editing, propose surgical changes, wait for inspection, commit on explicit authorisation.
