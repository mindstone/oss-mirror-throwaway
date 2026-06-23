---
description: "Skill/prompt for updating Mindstone Rebel's CHANGELOG.md from recent git history with clear, mixed-audience summaries."
use_cases:
  - "Summarising recent changes for a release or demo"
  - "Catching up teammates on what changed since a specific date"
  - "Preparing human-readable release notes from git history"
last_updated: "2026-06-10"
dependencies:
  - "../AGENTS.md"
  - "../CHANGELOG.md"
  - "./ARCHITECTURE_OVERVIEW.md"
  - "./UI_OVERVIEW.md"
  - "./GIT_SUBMODULES.md"
  - "./REBEL_SYSTEM_SYNC.md"
  - "./SUPERMCP_OVERVIEW.md"
  - "./CHANGELOG_DAILY_EXPLAINER_PROCESS.md"
  - "./DEV_DOCUMENTATION_UPDATE_PROCESS.md"
  - "./HELP_FOR_HUMANS_UPDATE_PROCESS.md"
agent_type: "main_agent"
---

# update-Changelog skill – Mindstone Rebel

[AGENT USE]
- Use this skill when a human asks you to update `CHANGELOG.md` or to summarise recent changes to Mindstone Rebel.
- Run it in the repo root on a branch that is up to date with `origin/main` and has a clean working tree.

[PERSONA]
- You are a pragmatic release-notes editor with strong product and engineering context.
- You write for both non-technical users and developers, highlighting what changed, why it matters, and how it affects them.

[GOAL]
- Produce concise, concrete changelog entries in `CHANGELOG.md` that reflect recent git history, clearly tag audience and importance, and use `yyMMdd_HHmm` timestamps.

[CONTEXT]
- Mindstone Rebel is a voice-first agentic Electron app; people use the changelog to understand what feels different in the UI and what changed under the hood.
- Entries should be short (2-3 sentences), emphasise user-facing behaviour first, and then call out important developer-facing or infrastructure changes.
- This repo's canonical engineering context lives in `docs/project/` and `AGENTS.md`; avoid duplicating that detail in the changelog—link or hint instead.

[PROCESS]
- **Model routing**: this process mixes large-scale trawling (scanning main + submodule git log, pre-grouping commits) with judgment-heavy review. Push the trawls down to a not-too-expensive agent (e.g. **Cursor Composer**), run agents in parallel where it helps, and reserve frontier models for the review gates — **GPT by default, Opus for contested calls**. Full routing, cost, and harness-dispatch guidance: [MODEL_ROSTER](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/MODEL_ROSTER.md).
- Open `CHANGELOG.md` and locate the newest entry at the top. Note its timestamp (the leading `[yyMMdd_HHmm]` tag).
- Convert that timestamp to an approximate date–time and run `git log` from the repo root using it as a lower bound (for example: `git log --since="2025-11-21 09:00" --date=iso --pretty=format:"%H|%ad|%an|%s" --reverse`).
- **Also scan submodule commits**: Run `git log` inside `rebel-system/` and `super-mcp/` with the same date filter to capture changes within those submodules. Attribute these to the original commit author inside the submodule, not the person who updated the pointer.
- Where helpful, use agents in parallel to scan and pre-group commits by likely related work, using commit messages, timings, and authorship as hints for which ones belong together.
- Scan the commit messages and group nearby commits (same feature area and close in time, roughly within an hour or so) into a small number of meaningful "changes".
- For each change group, decide whether it is primarily [User-facing], [Developer-facing], or both, and whether it is [Important] (changes behaviour, reliability, or key workflows).
- Pick an approximate timestamp for the group (often the latest commit in that group) and format it as `yyMMdd_HHmm`.
- Draft 1–2 short, concrete sentences per group in plain English: explain what changed and why a user or developer should care, avoiding internal-only jargon where possible.
  - Include more detail for particularly rich/complex commits/functionality.
  - **For important entries, capture extra context** that will help the daily explainer process later: note the problem being solved, any design decisions, and key file paths in the commit message grouping notes. This doesn't go into `CHANGELOG.md` itself but should be preserved as working notes for step 3 of [CHANGELOG_DAILY_EXPLAINER_PROCESS](./CHANGELOG_DAILY_EXPLAINER_PROCESS.md).
- Write each entry as a single Markdown bullet beginning with `[timestamp] [Audience][Importance]` tags, and insert new entries at the top of `CHANGELOG.md` so the file stays newest-first.
- Strike a balance between chronological ordering and logical grouping—submodule changes can be interspersed with main repo changes when they relate to the same timeframe or feature area.
- Re-read the updated file to check that the story flows sensibly in time, there are no duplicates from earlier runs, and the language is consistent with existing entries.

[VERSIONING RULES]
When creating or updating changelog entries, follow these rules to prevent version drift:

1. **Determine the target version:**
   - Read `package.json` version from the current branch — this **is** the target version
   - Our release process auto-bumps the patch version on `dev` immediately after a successful release to `main`, so `package.json` on `dev` always reflects the next release version
   - Example: after releasing `0.4.5`, dev is bumped to `0.4.6` — new changelog entries go into `v0.4.6`

2. **Only one unreleased version at a time:**
   - NEVER create multiple speculative future versions (v0.3.9, v0.3.10, etc.)
   - All unreleased changes accumulate in the single current version section
   - Update the date range as new features are added (e.g., "Jan 16-19" becomes "Jan 16-20")

3. **For non-patch releases (minor/major bumps):**
   - If the user specifies a minor or major version bump (e.g., `0.4.0` or `1.0.0`):
     - The user will update `package.json` accordingly
     - Use that version for the changelog section

4. **After a release:**
   - The version in `package.json` on `dev` is auto-bumped by the release workflow
   - New changelog entries use the new `package.json` version
   - Example: After releasing `0.4.6`, dev bumps to `0.4.7` — new changes go into `v0.4.7`

5. **Version alignment check:**
   - Before finalizing changelog updates, verify the version in the user-facing changelog matches `package.json`

[IMPORTANT]
- Keep entries understandable to non-engineers: explain effects ("auto-scrolls to the latest message") rather than only implementation ("refactored scroll handler").
- Only mark items as [Important] when they materially change user experience, reliability, security, or integration behaviour.
- Never include secrets, internal hostnames, or personal filesystem paths in the changelog; prefer high-level descriptions.
- Prefer a small number of well-crafted lines over mirroring every commit—use judgement to group or drop noisy internal-only changes.
- **Skip planning docs**: Don't include commits that only update `docs/plans/` or other planning documents. The changelog tracks shipped changes, not work-in-progress planning.
- **Skip coding-agent-instructions**: The `coding-agent-instructions/` submodule contains project-agnostic internal dev docs and skills shared across repos. Changes there are not user-facing or product-specific—do not include them in either changelog.

[SUBMODULE CHANGES]
The repo includes two submodules that ship with the app. Scan their git history and summarise meaningful changes in 1–2 line blurbs.

**rebel-system/** (user-facing instructions, skills, help docs):
- **Emphasise**: Changes to the system prompt (`AGENTS.md`), new or updated skills, and script changes—these directly affect agent behaviour.
- **Mention briefly**: Updates to `help-for-humans/` docs—worth a line if substantial, but lower priority than skills/prompts.
- Typically tagged `[User-facing]` since these affect how the agent behaves and what users see.

**super-mcp/** (MCP router):
- Typically tagged `[Developer-facing]` or `[Infrastructure]` since changes here affect tooling reliability rather than direct user experience.
- Focus on: new features, bug fixes affecting tool reliability, breaking changes, or performance improvements.
- Skip: internal refactors, test-only changes, or documentation unless they signal something user-relevant.

[TEMPLATE]
- Example bullet format (adapt as needed):
  - `[251123_0418] [User-facing][Important] Enabled editing of your last user message with safe truncation, so you can fix small mistakes without restarting a conversation. (Team Member)`
- Include the contributor(s) in parentheses at the end of each entry, based on the git commit author(s) for that change group.
- Audience tags to use:
  - `[User-facing]` – visible in the app or affects how people use it
  - `[Developer-facing]` – tooling, tests, docs, or configuration that mainly impact contributors
  - `[Important]` – highlight sparingly for behaviour, reliability, or integration changes that people should notice

**Submodule change examples:**
  - `[251210_1530] [User-facing] rebel-system: Added new "meeting-prep" skill that helps gather context from calendar and email before meetings. (the team)`
  - `[251210_1200] [User-facing] rebel-system: Updated AGENTS.md to improve how the agent handles ambiguous requests—now asks clarifying questions more consistently. (Team Member)`
  - `[251209_0900] [Developer-facing] super-mcp: Fixed HTTP transport timeout handling that was causing tool calls to hang under load. (the team)`

[OPEN SOURCE]

> **The internal `CHANGELOG.md` is PUBLIC (since 2026-06-10).** The unreleased section ships to the OSS public mirror from the moment it lands on `dev` — there is no patch hiding it and no release-time scrub. Write every entry as if it is already public: no secrets, no internal URLs, no customer details, nothing embarrassing-if-quoted. Partial automated backstops exist, but **do not rely on them**: competitor-name posture is handled by exact `content_substitutions` plus a WARN-only competitor-term lint in `check:oss-surface`; employee full names are auto-substituted only for four contributors (Greg, Joshua, Harry, Liam), and the leak gate's forbidden-name patterns cover only a subset of staff — **other full names pass through to the public mirror unflagged** (several historical attributions already ship publicly). Until the owner settles the attribution posture (tracked in the 260610 OSS long-term plan §6), prefer first names or roles for anyone outside the substituted four. See `docs/project/OSS_MIRROR_RUNBOOK.md` for the mirror mechanics.

Mindstone Rebel is on a multi-quarter push to migrate bundled MCP connectors to OSS packages (under `@mindstone-engineering/mcp-server-*`, source at github.com/mindstone/mcp-servers) and to bundle internal-only skills into the open Rebel skills catalog. This is a deliberate, repeated theme — call it out explicitly whenever it lands in a release.

**When updating either changelog, scan the window for OSS-related work and surface it prominently:**

- **Bundled-MCP-connector → OSS migrations** (commit pattern: `refactor(mcp): Remove bundled <Name> connector infrastructure. Migrated to @mindstone-engineering/mcp-server-<name>`). These move a connector from in-app code to an npx-installed package that anyone can read, fork, or contribute to. **Always [Important]**, always tag user-facing.
- **New OSS-published connectors** (e.g. catalog gains `provider: rebel-oss` entries). User-visible because users can now install/use them; OSS-visible because the source is public.
- **Skills bundled into the open catalog** (commit pattern under `rebel-system/skills/`: `feat(skills): Bundle <Name> as <category> skill` or similar — previously workspace-only/internal, now shipped to all users). These both expand user-visible capability AND grow the OSS skills catalog.
- **Other open-source-relevant changes**: license fixes, OSS-PR review process changes, contribution-flow improvements (the in-app flow that lets users build & submit MCP connectors to the Rebel catalog), structural changes to the rebel-oss provider plumbing in the catalog.

**Tagging convention:**
- In `CHANGELOG.md` (internal), add `[Open Source]` as an additional bracketed tag alongside `[User-facing]` / `[Developer-facing]` and `[Important]`. Example: `[260429_1436] [User-facing][Important][Open Source] Connectors—...`.
- In `rebel-system/help-for-humans/changelog.md` (user-facing), surface OSS migrations as **Highlights** (not Improvements/Fixes), with copy that names the OSS angle explicitly ("Now Open Source", "joining the open catalog", "anyone can read, fork, or contribute"). Group multiple connector migrations into one Highlight rather than listing each individually.
- Always link or name the public source ("github.com/mindstone/mcp-servers" or the package name) in the `<!-- detail: -->` tooltip so power users can find the repo.

**Why this matters:** OSS migrations are a key strategic narrative — they signal that Rebel is ecosystem-friendly and not a closed silo. Burying them in Under-the-Hood or splitting one migration cohort across multiple bullets undersells the message.

[DUAL-CHANGELOG SYSTEM]
This repo maintains **two changelogs** for different audiences:

Related note: this repo also has `INTERNAL_CHANGELOG.md`, an internal per-beta broadcast log that is auto-generated and posted to Slack `#general`. It is intentionally separate from the two changelogs in this process. Pipeline behaviour and operating details live in [INTERNAL_CHANGELOG_PIPELINE.md](./INTERNAL_CHANGELOG_PIPELINE.md).

Audience split matters here: this process governs curated changelog updates (`CHANGELOG.md` and `rebel-system/help-for-humans/changelog.md`), while `INTERNAL_CHANGELOG.md` is an automated internal communication channel tied to beta deploys.

1. **`CHANGELOG.md`** (repo root) — Internal/technical changelog
   - Audience: Developers, product team, internal stakeholders
   - Format: Timestamped bullets with `[yyMMdd_HHmm]` tags
   - Detail level: Include developer-facing changes, submodule updates, infrastructure, and user-facing features
   - Style: Technical but accessible

2. **`rebel-system/help-for-humans/changelog.md`** — User-facing changelog
   - Audience: End users (knowledge workers, not developers)
   - Format: Version-based sections (e.g., `## v0.2.36 — Dec 22-24, 2025`)
   - Detail level: Focus on what users can see/do differently; skip internal/dev changes
   - **Important**: This file is bundled with the app; avoid dev-only details

   **Style guide for user-facing changelog:**
   - **Section structure**: Highlights → Improvements → Fixes → Under the Hood
   - **Length**: 1-2 sentences max per entry; favour brevity. Use 2 sentences when a feature genuinely needs extra context to be useful.
   - **Focus on benefits**: What it does for you, not how it works ("Find past conversations by meaning" not "Added vector search")
   - **Highlights are for user value**: Reserve Highlights for new capabilities, benefits, and improvements that users will notice and care about. Bug fixes, preventative work, and behind-the-scenes improvements belong in "Improvements" or "Fixes"—even if technically impressive. A good litmus test: if the entry describes fixing something that was broken or mitigating a problem, it's a Fix, not a Highlight. The goal: headlines that make users excited, not confused.
   - **Describe the benefit, not the mechanism**: Instead of "JIT Prompt Cache Warming", say "Faster first responses" and explain that Rebel gets ready while you're thinking. Technical names are fine in parentheses if they help power users, but lead with what the user gets.
   - **Detailed tooltips for power users**: Add a `detail` field in the metadata comment for entries that benefit from deeper explanation. This appears as a tooltip/popover for users who want to understand more. Keep it to 1-2 short paragraphs of plain text.
   - **Punchy closing quips**: End entries with a short, dry, confident statement (period required). Examples:
     - "Your meetings, remembered."
     - "The future is self-documenting."
     - "You're welcome."
     - "Discovery, optimized."
     - "The efficiency compounds."
   - **No timestamps, contributor names, or `[tags]`** — this isn't the internal changelog
   - **Tone**: Dry wit, confident, matter-of-fact. Not chatbot enthusiasm.

   **Good examples:**
   ```markdown
   - **Meeting Bot** — Automatic meeting capture via Recall.ai. Rebel detects your meetings, grabs transcripts, generates AI summaries, and stores everything organized by year and month. Your meetings, remembered.
   - **Auto-continue on rhetorical questions** — Rebel no longer stops and waits when it asks "shall I proceed?" It just... proceeds. You're welcome.
   - **Conversation startup fixed** — That 20-second delay? Gone. Tool connections load smarter now. From minutes to moments.
   ```

   **Example with detailed tooltip:**
   ```markdown
   <!-- detail: Rebel uses your idle time to pre-warm Anthropic's prompt cache with your system prompt and MCP tools. When you send your first message, the server already has your context ready—reducing first-response latency by 30-50% and lowering API costs since cached tokens are ~90% cheaper. -->
   - **Faster First Responses** — Rebel warms up while you're thinking, so your first message gets answered faster. The wait, shortened.
   ```
   The `detail` text appears as a tooltip when users hover over the entry in What's New. Keep it factual and useful—explain the "how" and "why" that power users want to know.

When updating changelogs, update **both** files with the same underlying changes but adapted for each audience.

[PRODUCTION RELEASES]
Track recent production releases (pushes to `main`) to help correlate changelog entries with shipped versions:

| Version | Released (UTC) |
|---------|----------------|
| 0.4.48 | 2026-06-17 |
| 0.4.47 | 2026-06-15 |
| 0.4.46 | 2026-06-11 |
| 0.4.43 | 2026-05-29 |
| 0.4.42 | 2026-05-22 |
| 0.4.41 | 2026-05-22 |
| 0.4.35 | 2026-04-30 |
| 0.4.34 | 2026-04-27 |
| 0.4.33 | 2026-04-23 |
| 0.4.32 | 2026-04-22 |
| 0.4.27 | 2026-04-15 |
| 0.4.26 | 2026-04-10 |
| 0.4.24 | 2026-03-31 |
| 0.4.23 | 2026-03-31 |
| 0.4.22 | 2026-03-25 |
| 0.4.21 | 2026-03-23 |
| 0.4.13 | 2026-03-04 |
| 0.4.12 | 2026-02-26 |
| 0.4.11 | 2026-02-26 |
| 0.4.10 | 2026-02-25 |
| 0.4.9 | 2026-02-24 |
| 0.4.8 | 2026-02-20 |
| 0.4.7 | 2026-02-20 |
| 0.4.6 | 2026-02-17 |
| 0.4.5 | 2026-02-16 |
| 0.4.4 | 2026-02-12 |
| 0.4.3 | 2026-02-11 |
| 0.4.2 | 2026-02-11 |
| 0.4.1 | 2026-02-10 |
| 0.4.0 | 2026-02-09 |
| 0.3.16 | 2026-02-06 |
| 0.3.15 | 2026-02-06 |
| 0.3.14 | 2026-02-05 |
| 0.3.13 | 2026-01-31 |
| 0.3.12 | 2026-01-29 |
| 0.3.11 | 2026-01-28 |
| 0.3.10 | 2026-01-25 |
| 0.3.9 | 2026-01-23 |
| 0.3.8 | 2026-01-20 |
| 0.3.7 | 2026-01-19 |
| 0.3.6 | 2026-01-15 |
| 0.3.5 | 2026-01-13 |
| 0.3.4 | 2026-01-04 |
| 0.3.3 | 2026-01-01 |
| 0.3.0 | 2025-12-27 |
| 0.2.35 | 2025-12-24 |
| 0.2.34 | 2025-12-19 |
| 0.2.33 | 2025-12-15 |

To find more releases: `git log origin/main --oneline --format="%H %ai %s" | grep -E "(Release|bump version)"` or check git tags with `git for-each-ref --sort=-creatordate --format='%(refname:short) %(creatordate:iso)' refs/tags`.

[REVIEW]
Before committing, spawn a GPT reviewer agent (`researcher-gpt5.5-high` by default; escalate to Opus for contested or high-stakes calls) to review the proposed changelog entries for factual accuracy, correct audience tagging, and adherence to the style guidelines above. Incorporate any corrections before proceeding. This cross-model review catches jargon leaks, mis-tagging, ordering errors, and forbidden content (e.g. coding-agent-instructions mentions) that same-model self-review tends to miss.

[OUTPUT]
- Updated `CHANGELOG.md` with new entries inserted at the top, covering all relevant commits since the previous timestamp.
- Updated `rebel-system/help-for-humans/changelog.md` with user-facing changes grouped by version.
- A brief summary back to the human describing the main user-facing improvements in this update window.

[FOLLOW-UP]
After updating and committing changelogs, run the documentation audits below before considering the task complete. Use agents to parallelise audit and update work — a single agent updating 10+ docs sequentially is slow and error-prone.

### 1. Daily changelog explainers (only when explicitly requested)

**Only run this if the user explicitly asks for it — not by default.** When requested, run [CHANGELOG_DAILY_EXPLAINER_PROCESS](./CHANGELOG_DAILY_EXPLAINER_PROCESS.md) to generate rich HTML explainers on Google Drive (see that doc for the output path) for each day covered by the new changelog entries. These give the product/dev team deeper context (executive summaries, tooltips, diagrams, GitHub-linked SHAs) than the bullet-format changelogs. Do it right after the changelog commit, while the grouping/research context is fresh.

- Use the `CHANGELOG.md` entries just written as the **source of triage** — they already have audience tags, importance flags, and grouping
- For multi-day runs, parallelise with one agent per day
- The HTML files complement the changelogs; they don't replace them

### 2. Documentation audits (run in parallel via agents)

Spawn two `researcher-gpt5.5-high` agents simultaneously:

1. **Dev docs audit** — Run Phase 1 of [DEV_DOCUMENTATION_UPDATE_PROCESS](./DEV_DOCUMENTATION_UPDATE_PROCESS.md). The agent reads the new changelog entries, identifies which `docs/project/` files are affected, checks 5-10 most likely candidates, and returns a prioritised list of docs needing updates with specific sections and reasons.

2. **Help docs audit** — Run Phase 1 of [HELP_FOR_HUMANS_UPDATE_PROCESS](./HELP_FOR_HUMANS_UPDATE_PROCESS.md). The agent reads the new user-facing changelog entries, inventories `rebel-system/help-for-humans/`, and returns a prioritised list of help docs needing updates.

### 3. Apply updates (parallelise where possible)

Use the audit results to update docs. For large batches (5+ files), delegate groups of related updates to `implementer` agents working in parallel on non-overlapping file sets. For smaller batches, update directly.

**Priority order**: High-priority docs first, then medium, then low. Skip low-priority updates if the batch is already large — they can wait for the next cycle.

### 4. Also consider

- Review [TESTING_E2E.md Appendix B](./TESTING_E2E.md#appendix-b-e2e-test-maintenance-process) to identify new features that deserve E2E test coverage.
- Run [screenshot capture](./SCREENSHOTS.md) (`npm run capture:screenshots`) to update product screenshots for the changelog or What's New dialog.
