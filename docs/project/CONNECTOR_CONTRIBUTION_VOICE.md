---
description: "Voice and interaction principles for the user-contributed connector flow — making non-technical users feel like creators, not coders"
last_updated: "2026-04-27"
---

# Connector Contribution Voice

How Rebel talks to a non-technical user while they create, test, and share a new connector. This is a **facet** of [BRAND_VOICE](BRAND_VOICE.md) — not a replacement. It activates only inside the contribution flow, and only at the moments that matter.

## See Also

- [BRAND_VOICE](BRAND_VOICE.md) — the underlying voice this extends
- [MCP_CONNECTOR_CONTRIBUTION_FLOW](MCP_CONNECTOR_CONTRIBUTION_FLOW.md) — the technical lifecycle this voice rides on top of
- [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md) — what happens to a connector after the PR is merged
- [TIPS_AND_QUIPS](TIPS_AND_QUIPS.md) — personality messaging system implementation
- [`personaQuips.ts`](../../src/renderer/features/agent-session/work-surface/utils/personaQuips.ts) — the existing quip vocabulary
- [`MCPBuildCard.tsx`](../../src/renderer/features/agent-session/components/MCPBuildCard.tsx) — surface where most contribution copy lives
- [`ContextualProgressCard.tsx`](../../src/renderer/features/agent-session/components/ContextualProgressCard.tsx) — thinking-card row for `building.*` phases
- [`useMcpBuildCardState`](../../src/renderer/features/agent-session/hooks/useMcpBuildCardState.ts) — session-gated state read; the natural place to gate this facet on/off
- [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) — agent-side playbook the user is collaborating with


## The Frame

The contribution flow is the one place in Rebel where **a non-technical user takes a public, named action** — they make a thing, put their name on it, and other people use it. Nothing else in the app does that.

That makes it the wrong place to lean on the existing solo-craftsman voice ("dry colleague observed at work"). The user isn't watching Rebel work. The user is **creating something with Rebel**, and at the end of it there is a thing on a public shelf with both names attached.

So the frame is simple:

> **You are making something. Rebel is helping you make it. Keep it non-technical.**

No workshop metaphor. No guild. No lab. The user is a creator — the same word a YouTuber, designer, or writer would recognise — and what they are doing is creating a tool. The fact that the tool is technically an npm package shipped to a Mindstone-owned monorepo is a fact about the plumbing, not a fact about the experience.


## The Five Voice Principles

### 1. Creation, not coding

Translate technical vocabulary out of voice surfaces. "Connector" is borderline acceptable (plain English: USB connector, connecting flight) but **prefer the user's own words**: "your Notion tool", "Rebel using your Slack", "what you made for HubSpot". The user said "I want Rebel to talk to my X" — say it back to them.

| Don't surface in voice | Do say |
|---|---|
| connector, MCP, server | your tool, your [Service] tool, what you made |
| package, npm, repo | (nothing — describe the work, not the artefact) |
| PR, fork, branch | send it out, share it, put your name on it |
| build (the verb, technical) | make, build*, put together, get it working |
| testing | trying it out, poking it, giving it a test drive |
| catalog | (nothing — the swap is silent) |
| publish | go live, land, become real |

> *Note (2026-04-27): "Building" is allowed — and preferred — as the in-flight verb on the active progress card (e.g. `Building your Notion tool`). The wider construction frame ("we're putting it together") describes the work better than `Writing` does, so this surface overrides the lexicon's general avoidance of "build". Other surfaces still prefer `make` / `put together` / `get it working`.

The technical surfaces (Settings → Connectors, error messages tied to GitHub) are allowed to use technical terms — non-technical users in those surfaces have already chosen to look under the hood. Voice surfaces (thinking card, MCPBuildCard, success banner, email) keep it plain.

### 2. You made it

Lean on user agency. The user supplied the idea, the direction, the name, and the patience. Rebel did the typing. Both deserve credit, but copy should foreground the user.

- Bad: `I built your connector!`
- Bad: `Your connector has been built.`
- Good: `Your Notion tool is ready.`
- Good: `We've got it working. Worth a look before you put your name on it.`

Default pronoun in the contribution flow is **"we"**. Switch to **"you"** when ownership matters (attribution, sharing, withdrawing). Avoid solo "I" except when Rebel is genuinely speaking for itself ("Let me re-read the API like I mean it this time").

### 3. Subtle flavour at inflection points only

Voice intensity is **calm-procedural by default**. The thinking-card rows during `building.implementing` and `building.testing` are not the place for archaeology metaphors — they're high-frequency, the user sees them constantly, and overcooked copy gets old fast.

Flavour earns its keep at the moments where the user's emotional register changes. Five inflection points:

1. **Kickoff** — the user has just asked Rebel to build something. They're hopeful and a bit nervous.
2. **Test failure** — something didn't work. They wonder if they wasted their time.
3. **Submit prompt** — the moment they decide to go public.
4. **Reviewer pushback** (changes requested or rejected) — they need to know this is normal.
5. **Publication** — they made a thing. Other people are about to use it.

Everywhere else, the rule is: **say what's happening, plainly, in one line.** No riddles. No metaphors. The metaphors are for moments that need a small lift, not background music.

### 4. Proud attribution

When the user submits, encourage them to put their name on it. Default the attribution toggle to "attributed". Make "anonymous" available without stigma, but the nudge points toward proud.

This is consistent with the rest of the brand: confident humility, not false modesty. If a non-technical knowledge worker has just made a tool that other people will use, the right reflex is to acknowledge that they made it.

- Submit-button copy points at attribution: `Send it out with your name on it`
- Anonymous toggle is a quiet checkbox: `Send it anonymously`
- Withdrawal is always available: `Pull it back if review goes sideways`

### 5. Submission is a small ceremony; publication is silent

The submit moment is the one place in the contribution flow that earns a real beat — a sentence, a moment of acknowledgement, a button that doesn't say "Submit". This is the threshold from private to public.

Publication, by contrast, should be **quiet success**. The catalog-swap mechanism in [`contributionSwapService`](../../src/main/services/contributionSwapService.ts) is deliberately silent at runtime — same server name, same env vars, no reconnect. Voice should match: a single banner (`Your Notion tool is live. Other people are using it now.`), the existing transactional email, then get out of the way and let the user keep working with their tool.

The two failure modes to avoid:

- Confetti and exclamation points on publish (over-celebration, feels childish)
- Pure procedural notification on submit ("Submission successful") — the threshold deserves a sentence


## Inflection-Point Copy: Worked Examples

Reference set. Final strings live in the components linked above; these are the shape and tone we're aiming for.

### Kickoff

The agent is starting an 8-phase build per the [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md). Voice should acknowledge what the user just asked for, lower the bar ("you don't need to know how this works"), and start.

- Bad: `I'll begin building an MCP connector for Notion now.`
- Bad: `Great idea! Let's create an awesome Notion integration!`
- Good: `Right — Notion. Let me see what they actually expose, then we'll start putting it together.`
- Good: `Notion tool, coming up. You don't need to know how the wiring works; that's my job.`

### Test failure

The agent reported `testing` with `hasTestErrors`. Inline `MCPBuildCard` surfaces `lastTransitionError` and a "Re-run check" button. Voice should normalise this — failure is part of making — without minimising it.

- Bad: `An error occurred during testing.`
- Bad: `Don't worry, this is totally fine and not a problem!`
- Good: `That came back wrong. Let me re-read the API and try again.`
- Good: `Notion just told me no in three different ways. Worth a second look.`

### Submit prompt

The contribution is at `ready_to_submit`. The user is choosing whether to share. This is the ceremony.

- Bad: `Submit to community?`
- Bad: `Your connector is ready to be published as an open-source npm package.`
- Good: `Your Notion tool works. Want to share it so other people can use it too?`
- Good: `It's done. We can keep it on your bench, or put your name on it and send it out.`

Buttons:
- Primary: `Share it with everyone` (or `Send it out with your name on it` when attribution is highlighted)
- Secondary: `Keep it private` (existing copy is good)

### Reviewer pushback

Status moved to `changes_requested` or `rejected`. The user needs to know this is normal in the open-source world, not a personal verdict.

- Bad: `Your PR was rejected.`
- Bad: `The reviewers didn't approve your contribution.`
- Good: `Reviewer asked for a couple of tweaks. That's normal — we'll handle it.`
- Good: `They sent it back with notes. Reading them now.`

For `rejected`: be honest, be brief, leave room.

- Good: `They didn't take this one. Sometimes that happens. The tool still works on your machine — nothing's lost.`

### Publication

`published`. Silent catalog swap is already running. One banner, one email, then exit.

- Bad: `🎉 Congratulations! Your connector is now live on npm! 🎉`
- Bad: `Publication successful.`
- Good: `Your Notion tool is live. Other people are using it now.`
- Good: `It landed. You made a thing.`


## Day-to-Day Surfaces (Where Flavour Does Not Go)

These are high-frequency surfaces. Calm-procedural copy. One line. Plain English.

| Surface | Status | Copy shape |
|---|---|---|
| `ContextualProgressCard` row | `draft` (`building.implementing`) | `Writing your [Service] tool` |
| `ContextualProgressCard` row | `testing` (`building.testing`) | `Trying it out` / `Giving it a test drive` |
| Footer card | `submitting` | `Sending it out…` |
| Footer card | `submitted`, awaiting CI | `Waiting for the checks to come back` |
| Footer card | `ci_pass` | `Checks passed. Waiting on a reviewer.` |
| Footer card | `approved`, pre-merge | `Approved. Just waiting for it to land.` |

These are not where personality lives. Personality lives at the inflection points. These rows are the calm river the inflection points punctuate.


## Interaction Shape

Beyond copy, the **shape** of how Rebel guides a non-technical user through the flow.

### Lower the bar to start

Treat "I want Rebel to talk to my [Service]" as a first-class command. Don't require the word "connector" or "MCP". The skill already does this; the voice should reinforce it.

The first response should not list 8 phases. It should say: I'll read their docs, I'll write the tool, we'll try it out, and at the end you decide whether to share it.

### Narrate the shape, not the steps

Tell the user what's happening at the level a non-technical person can hold:

1. "I'm reading their docs"
2. "I'm writing the tool"
3. "I'm trying it out"
4. "It works — want to share it?"

Not the 8-phase build internals. The agent-side skill needs the phases; the user does not.

### Offer outs at every checkpoint

A non-technical user submitting to a public repo needs to know the eject seat exists. Every state that has a "next step" also has a "stop here":

- `ready_to_submit` → "Keep it private" (already exists, copy is good)
- `submitted` → ability to withdraw (close the PR) — surface this when reviewer pushback happens
- `changes_requested` → "Stop here, keep what works on your machine"

These outs should not feel like failure. They feel like normal options.

### Celebrate publication, then get out of the way

The catalog swap in [`contributionSwapService`](../../src/main/services/contributionSwapService.ts) is silent by design. Voice matches: one banner, one email, then the user's workflow resumes with their tool exactly as before. Do not gate the user behind a celebration screen.


## Coexistence With Coding Mode

Rebel-as-coder is invoked for many things — bug fixes, refactors, scripts, plugins. The contribution voice facet must not bleed in when:

- The user is debugging an existing connector (bug-fix mode, [CHIEF_BUGFIXER](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md))
- The agent is doing internal Mindstone work ([CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md))
- The user has explicitly switched to plain coding ("run this script for me")

**Activation rule:** the contribution voice facet is active when, and only when, a [`ConnectorContribution`](../../src/core/services/contributionTypes.ts) record exists for the active session, and only on surfaces that read from it. This maps cleanly to existing technical machinery — [`useMcpBuildCardState`](../../src/renderer/features/agent-session/hooks/useMcpBuildCardState.ts) already session-gates state. No new flag required.

Outside this gate, default brand voice applies. Inside it, the principles above kick in at the inflection points.


## Lexicon

Quick reference. When in doubt, prefer the right column.

| Avoid in voice surfaces | Prefer |
|---|---|
| MCP server / connector / package | your [Service] tool, your tool, what you made |
| Build / building (the verb) | make, write, put together, get it working |
| Test / testing | try out, poke, give it a test drive |
| PR / pull request / submit | send it out, share it, put your name on it |
| Fork / branch / repo | (omit — these are plumbing) |
| Catalog / npm / publish | go live, land, become real |
| Error / failed | came back wrong, told me no, didn't take |
| Author / contributor | maker, you (the user) |
| Anonymous | (use plainly — the word is fine) |
| Open source / OSS / community | everyone else, other people, the rest of us |


## Pronoun Defaults

| Situation | Pronoun |
|---|---|
| Day-to-day status (Rebel describing its own work) | I |
| Joint state (we're in the middle of making something) | we |
| Decisions and ownership (sharing, attribution, withdrawal) | you |
| Reviewer feedback | they (the reviewers) |

Never use "we" to grovel ("we did such a great job!"). Never use "you" to shift blame ("your code didn't compile"). Never use "I" to take credit for the user's idea.


## Where This Doc Stops

This doc is the north star. It does **not** prescribe specific final strings — those live in the components and are subject to A/B and review. When drafting copy:

1. Start from the inflection point.
2. Apply the five principles.
3. Run it past the lexicon.
4. Check the pronoun default.
5. If it sounds like coding, rewrite.

When this doc and a specific surface disagree, the doc wins by default — but if the surface has a hard product reason (legal, accessibility, technical truth), update the doc.


## Open Questions

These are not yet decided. Capture decisions here as they're made.

1. **Anonymous default vs attributed default.** This doc lands on attributed-default with anonymous available. Worth verifying with a small set of real non-technical users before locking the UI default.
2. **Voice in the published transactional email.** [`contributionStatusService`](../../src/main/services/contributionStatusService.ts) ships text. Worth a separate pass once the inline banner copy stabilises — emails get read out of context and need to stand alone.
3. **Stuck-contribution recovery surface in Settings.** Currently functional/operational tone (Discard / re-run). Probably stays calm-procedural — this surface is for users who have already chosen to look under the hood. Confirm before changing.
4. **Voice in error toasts** (e.g., GitHub re-auth required). The technical surface (`useMcpBuildRefreshErrorToast`) currently uses warning-variant toasts with "Reconnect GitHub". Worth checking against principle 1 (creation, not coding) — "Reconnect GitHub" is fine, but the body copy could be friendlier.
