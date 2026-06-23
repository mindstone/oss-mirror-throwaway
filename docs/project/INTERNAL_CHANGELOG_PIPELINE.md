---
description: "Canonical intent and operations record for the internal beta changelog + Slack post pipeline"
last_updated: "2026-05-27"
---

# Internal Changelog Pipeline

One-line summary: on each successful beta deploy, Rebel generates an internal beta summary, posts it to Slack `#general`, and archives the same summary in `INTERNAL_CHANGELOG.md`.

## Why this is a separate changelog (intent-critical)

This pipeline is deliberately separate from `rebel-system/help-for-humans/changelog.md`. Future agents should treat this separation as a product requirement, not a formatting preference.

The user intent is explicit:

> "I don't want to update the current changelog because other things happen from the current changelog. I want to create a separate changelog that's internal update kind of thing."

### Different audience

- `INTERNAL_CHANGELOG.md`: internal team communication (product, sales, customer success, engineering).
- `rebel-system/help-for-humans/changelog.md`: end-user release notes shipped in-app.

### Different lifecycle

- `INTERNAL_CHANGELOG.md`: generated per beta deploy (high cadence, operational visibility).
- `rebel-system/help-for-humans/changelog.md`: curated release notes for stable-user communication.

### Different consumer surface

- `INTERNAL_CHANGELOG.md`: broadcast to Slack `#general` and stored in-repo for maintainers.
- `rebel-system/help-for-humans/changelog.md`: read in the app's "What's New" surfaces.

Do not merge these files or collapse their workflows. Doing so breaks the communication contract this pipeline was introduced to provide.

## Output shape

The Slack post is an internal awareness briefing, especially for customer-facing teammates who need to know what users may notice in demos, office hours, and support conversations. It should not read like a commit digest or assign role-specific review work.

Current sections:

- **What you'll see** — visible screens, copy, navigation, setup, loading/error states, or interaction changes that could surprise someone in front of a user.
- **What we fixed** — plain-English reliability and behaviour changes, framed around what users may notice or what support can now explain more confidently.
- **Worth a look** — useful internal context that does not need to dominate the post.

**Bullet shape (where + what).** Each bullet is produced from a structured `{ area, change }` pair and rendered as `Area — change` — e.g. `Connectors — setup now explains itself when it needs attention.` `area` is a friendly product area (Conversations, Connectors, Model picker, Files, Meetings, Onboarding, Settings, Voice, Home, Actions); `change` is one plain sentence about what a user notices. The post reads as a human "what changed and where" briefing rather than a commit digest. This is enforced two ways: the system prompt asks the model to avoid ticket IDs, "Stage N"/phase references, commit-style prefixes, internal codenames/file paths, and engineering jargon; and a deterministic backstop (`BANNED_BULLET_PATTERNS` / `findBannedBulletContent`) **drops** any bullet that still contains those, so a non-compliant model response can't leak them. If every bullet is dropped, the post is suppressed rather than degraded (the drop reasons are also fed into the retry prompt so the model can self-correct). Patterns are deliberately narrow to avoid dropping legitimate copy — e.g. model names like `GPT-5` must not match. A legacy single-`bullet` shape is still accepted by the parser for backward compatibility. Producer: `buildLlmSystemPrompt` + `parseBucketEntries` in `scripts/post-beta-summary.ts`.

The parser still recognises the short-lived `UI/UX changes to know`, `What this means in demos and support`, and `Other fixes worth knowing` headings in older generated entries. Do not remove that compatibility without a migration, because the marker walk-back uses announced sections as a lower bound to avoid re-announcing old beta work.

## Why fully unattended from day one

This pipeline intentionally runs without a human review checkpoint before posting.

User direction:

> "From day one, yes, that's fine."

Trust mitigation was designed into the output itself, not into a manual gating step:

- Every generated summary includes an "AI-generated — ping us if it's off" footer.
- The team chose low-friction internal broadcast over a draft-and-approve queue.
- Correction happens in-channel (Slack), which is acceptable for this internal audience and purpose.

The draft/review alternative was considered and deliberately rejected in the planning process.

## Pipeline overview (CI orchestration)

The beta pipeline is a four-step post-publish chain:

1. **Generate** summary bundle from the released SHA using `scripts/post-beta-summary.ts` (`--emit-only` mode).
2. **Upload artifact** for operator forensics and replay support.
3. **Post to Slack** `#general` via webhook (`--post-from` mode).
4. **Commit archive** entry to `INTERNAL_CHANGELOG.md` on `dev` (`--commit-from` mode).

Design and stage-level rationale live in `docs/plans/260429_internal_changelog_beta_slack_post.md` (Stages 1-2). This doc intentionally signposts rather than duplicating implementation detail.

## Operating it locally

Primary offline test command:

```bash
npx tsx scripts/post-beta-summary.ts --dry-run --from-file "<fixture-path>"
```

Recommended fixture directory:

- `scripts/__fixtures__/post-beta-summary/`

Local safety model:

- Local default is safety-first dry-run when not running in CI.
- This prevents accidental Slack posts or auto-pushes from a developer machine.

Explicit override modes:

- `--no-commit`: write summary content locally but skip commit/push.
- `--emit-only`: generate bundle only (used by CI orchestration, useful locally for inspection).
- `--post-from <dir>`: post a previously generated bundle to Slack.
- `--commit-from <dir>`: append and commit from a previously generated bundle.

## Operational configuration

Required secrets and variables:

- `secrets.TEST_CLAUDE_API_KEY`: Anthropic API key (reused existing secret).
- `secrets.SLACK_WEBHOOK_URL_GENERAL`: webhook bound to Slack `#general` (owner: Slack admin to provision).
- `vars.INTERNAL_CHANGELOG_POST_ENABLED`: pipeline kill switch (`true` by default; set to `false` to disable posting job).

## Failure modes operators may see

For full scenarios and mitigations, use the planning doc's Failure Mode Matrix:

- [Failure Mode Matrix](../plans/260429_internal_changelog_beta_slack_post.md#failure-mode-matrix)

Common operator-visible cases:

- **Anthropic timeout/rate-limit/refusal or malformed JSON**: the generator first tries hard to recover before giving up. Per-bullet validation is lenient (a single malformed/out-of-range bullet is dropped, not the whole summary), and the AI call is retried up to `MAX_LLM_ATTEMPTS` (3) — re-prompting with the validation error — because the Anthropic SDK's own retries only cover transport errors, not responses we fail to parse/validate. If a usable summary still cannot be produced, the post is **suppressed entirely** (`raw_fallback` → `skipReason`): nothing is posted to `#general` and nothing is archived. This is deliberate — a degraded commit-dump must never reach a non-technical audience. The skip is observable: logged by the generator, recorded in `metadata.json`, and surfaced in the CI step summary ("Internal beta summary skipped"). Producer: `generateBucketsWithLlm` / `buildSummaryBundle` in `scripts/post-beta-summary.ts`.
- **Slack webhook 4xx/5xx**: Slack post may fail; markdown archive still proceeds where possible.
- **Push rejection to `dev`**: check branch protection/rulesets and the checkout token first. The internal changelog job uses the same release-access token pattern as other private-repo release steps; if direct push remains blocked, the plan's PR-based fallback design is the next operational step.

## Recursion safety model

Recursion prevention is layered on purpose:

1. **Static, template-controlled commit subject** — the auto-commit subject is `chore(internal-changelog): beta v{ver} summary [skip ci]`, where `{ver}` is the only interpolation and is sourced from a known-safe input (`BETA_VERSION` env or `package.json`). No LLM-generated text, source commit subject, or branch ref can leak into the subject line.
2. **Body sanitisation** — any `[deploy-beta]` literal in the body (e.g., quoted from a source commit) is rewritten to `[deploy beta]`. Same pass also strips raw commit hashes, `#PR` numbers, and branch refs from the rendered output.
3. **`[skip ci]` token in the subject** — GitHub recognises `[skip ci]` and suppresses `push` and `workflow_dispatch` workflow runs for that push. This is independent of defense 1: defense 1 ensures *no* dangerous content lands in the subject; defense 3 ensures the subject *additionally* carries the suppression token.
4. **Structural path guard** in `.github/workflows/beta-deploy-trigger.yml` — short-circuits when the only file changed across the push is `INTERNAL_CHANGELOG.md`, regardless of `[skip ci]` discipline. Survives a future agent removing the token "to fix something".
5. **Token-aware push path** — the archive push may use a repo access token instead of the default `GITHUB_TOKEN` so branch rules can allow the changelog commit. In that mode, do **not** rely on default-token no-recurse semantics; recursion safety depends on the template-controlled `[skip ci]` subject and the structural path guard.

If maintainers change the checkout/push token again, they must preserve both:

- `[skip ci]` in the auto-commit path.
- The structural path guard in `beta-deploy-trigger.yml`.

## Source of truth for intent and rationale

Canonical planning and decision record:

- [260429_internal_changelog_beta_slack_post.md](../plans/260429_internal_changelog_beta_slack_post.md)

Use the planning doc for:

- user quotes and intent-critical rationale;
- stage-by-stage implementation decisions;
- amendments discovered during implementation/review;
- failure-mode and fallback rationale.

## Known follow-ups and discovered improvements

The current backlog lives in:

- [Discovered Improvements](../plans/260429_internal_changelog_beta_slack_post.md#discovered-improvements)

Operator note for first real beta:

- **FU-6** is intentionally deferred: monitor early beta runs for unexpected `raw_fallback` frequency to smoke-test the live LLM path under real release conditions.

## See also

- [CHANGELOG_UPDATE_PROCESS.md](./CHANGELOG_UPDATE_PROCESS.md)
- [`INTERNAL_CHANGELOG.md`](../../INTERNAL_CHANGELOG.md)
- [`scripts/post-beta-summary.ts`](../../scripts/post-beta-summary.ts)
- [Build and Release Overview](./BUILD_AND_RELEASE_OVERVIEW.md)

