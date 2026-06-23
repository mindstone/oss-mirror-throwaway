---
description: "Interactive batch process for shrinking the OSS public-mirror scrub surface — decide per item: keep-as-is / remove / move-to-private, with the leak gate as the going-forward catch. Modelled on EDIT_PROCESS_FOR_IMPORTANT_DOCS."
last_updated: "2026-06-15"
---

# OSS Scrub — Batch Review Process

A **human-in-the-loop batch process** for working through the OSS public-mirror "scrub" surface
(the `content_substitutions` in `mirror/substitutions.yaml`, plus whatever `npm run check:oss-surface`
flags) and deciding, per item, whether to **keep it as-is publicly**, **remove it**, or **move it
into `private/`** — then leaning on the leak gate to catch regressions going forward.

The aim is to **shrink the transform**: every scrub rule we can retire is one fewer permanent
difference between the internal and public repos, which directly reduces cross-repo back-port
friction (a community PR that touches a transformed region won't apply cleanly to canonical — see
[`OSS_BACKPORT_RUNBOOK.md`](OSS_BACKPORT_RUNBOOK.md)). Fewer transforms ⇒ more PRs apply cleanly.

> **Why a batch, and why interactive:** most scrub items are *posture decisions* (is this content
> actually fine in public?) or *light cleanups*, not mechanical edits — so they need the owner's
> call, but they're cheap to do many at once. This process is modelled on
> [`coding-agent-instructions/docs/EDIT_PROCESS_FOR_IMPORTANT_DOCS.md`](../../coding-agent-instructions/docs/EDIT_PROCESS_FOR_IMPORTANT_DOCS.md):
> group by ease × value, small batches, show before/after, get approval, commit after each approval,
> never more than 3 questions at a time. The background + the three-families taxonomy live in
> [`docs/plans/260610_oss-mirror-process/260615_private-submodule-broad-scope-analysis.md`](../plans/260610_oss-mirror-process/260615_private-submodule-broad-scope-analysis.md) §8.

## The core decision — keep / remove / move (a/b/c)

For each scrubbed thing (an employee email, an internal URL, a name, a competitor mention, …), pick
one disposition:

- **(a) Keep as-is publicly** — the content is genuinely fine in the open. Then **retire both** the
  `content_substitution` rule *and* the matching leak-gate pattern (the content is no longer
  "forbidden"). This is a **posture decision** and is **owner-gated** (see below) — it reduces what
  we protect, so it needs explicit sign-off.
- **(b) Remove from public-eligible files** — the content is avoidable in shared source/docs (e.g.
  a personal email → a role address; an internal URL → an issue *id*). Edit canonical so the content
  isn't there, and **keep a leak-gate pattern as the safety net** so it can't creep back.
- **(c) Move into `private/`** — the file genuinely needs the internal content. Move it under a
  path-deleted area (`private/**`, `docs/plans/**`, …); the leak gate ensures it doesn't reappear in
  a public-eligible file.

After (b)/(c), the silent `content_substitution` *transform* can usually retire — the gate now
*blocks* (fails the build) instead of the mirror *rewriting* (silently). That is the deliberate
shift: **transform-and-forget → gate-and-clean.** It's more honest and shrinks the transform, at the
cost of "build's red until you clean it" friction.

## Non-negotiable safety rule

`npm run check:oss-surface` (the leak gate, in `validate:fast`) **must stay green at the end of every
batch.** It is the catch-process that makes this whole approach safe. **Never weaken the gate to make
something pass.** Dropping a gate pattern is only allowed under disposition (a) with explicit owner
sign-off that the content is fine public. If unsure, default to (b)/(c) and keep the pattern.

## The process

1. **Enumerate the surface.**
   - List the `content_substitutions` rules in `mirror/substitutions.yaml`.
   - Run `npm run check:oss-surface` and note what it flags.
   - For each pattern class, grep the **public-eligible** files (everything not under a
     `path_deletions` glob) for live occurrences, with counts + file areas.
2. **Group by ease × value, then prioritise the groups.** Natural groups: personal emails ·
   internal Slack/Linear URLs · employee names · competitor mentions · anything else. Order the
   groups so the cheap, clearly-correct, high-value ones go first (per EDIT_PROCESS).
3. **For each group, propose a disposition.** Present, concisely: the pattern, where it appears
   (counts + representative files), and a recommended a/b/c with one-line rationale. Where useful,
   offer two variants (close-to-current vs lightly-improved). **Then stop and get approval** — never
   more than 3 questions at once.
4. **Apply the approved disposition.**
   - (a): remove the `content_substitution` rule + the matching leak-gate pattern (in
     `mirror/oss-forbidden-patterns.ts` / the `REBEL_SYSTEM_STRICT_PATTERNS` set). Update any
     `fixtures_*`.
   - (b): edit canonical files to remove/neutralise; keep the gate pattern.
   - (c): move the file/content under a path-deleted area; update
     [`PUBLIC_MIRROR_EXCLUSION_LIST.md`](PUBLIC_MIRROR_EXCLUSION_LIST.md) if a new deletion glob is
     needed (parity lint enforces agreement).
5. **Verify + commit per batch.** Run `npm run check:oss-surface`, `npm run mirror:check-drift`, and
   `npm run validate:mirror-exclusion-list-parity` — all green. Commit the batch with explicit paths
   + AI-provenance trailers (per [`GIT_COMMIT_CHANGES.md`](../../coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md)).
   Then move automatically to the next group.
6. **Cross-family check before flipping posture.** Because (a)/(b) decisions have product/privacy/
   legal implications, run a quick cross-family review (e.g. a GPT pass) on the batch's posture calls
   before they land — diverse-family review catches a "that's actually sensitive" miss.

## Owner-gated decisions (don't decide these alone)

These are **posture calls only Greg / legal can make** — surface them, don't assume:

- **Employee-name posture** — substitute all / none / the current four? (Open Q10 in the long-term
  plan; currently inconsistent — four people redacted, other contributors flow through.) Open source
  normally carries real author names; squashed history means git-blame isn't exposed regardless.
- **Competitor-name posture** — are factual mentions ("fixed Cursor export") fine public, or do we
  keep the neutral-phrasing posture? If kept, prefer writing *new* entries neutrally so the rule set
  never grows (the Bucket-A / D8 playbook).
- **Anything secrets-adjacent** (real credentials, tokens, internal hostnames) — never disposition
  (a); these stay scrubbed/removed regardless.

## See also

- [`OSS_MIRROR_RUNBOOK.md`](OSS_MIRROR_RUNBOOK.md) — day-2 mirror operations hub.
- [`PUBLIC_MIRROR_EXCLUSION_LIST.md`](PUBLIC_MIRROR_EXCLUSION_LIST.md) — narrative companion to
  `mirror/substitutions.yaml`'s `path_deletions`.
- [`OSS_LEAK_GATE.md`](OSS_LEAK_GATE.md) — the `check:oss-surface` gate (the catch-process) + its
  pattern sets.
- [`docs/plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md`](../plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md)
  — §2 mechanism ladder (Bucket-A / D8 playbook), §2.7 license-header bake-in.
- [`docs/plans/260610_oss-mirror-process/260615_private-submodule-broad-scope-analysis.md`](../plans/260610_oss-mirror-process/260615_private-submodule-broad-scope-analysis.md)
  — §8 three-families taxonomy + gate-and-clean reframe (the "why" behind this process).
- [`coding-agent-instructions/docs/EDIT_PROCESS_FOR_IMPORTANT_DOCS.md`](../../coding-agent-instructions/docs/EDIT_PROCESS_FOR_IMPORTANT_DOCS.md)
  — the interactive-batch pattern this process is modelled on.
