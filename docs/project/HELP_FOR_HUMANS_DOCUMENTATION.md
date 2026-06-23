---
description: "Canonical guide for writing user-facing documentation in rebel-system/help-for-humans/"
last_updated: "2026-04-16"
---

# Help-for-Humans Documentation

Guidelines for writing user-facing documentation that ships with Rebel in `rebel-system/help-for-humans/`.

## See Also

- [REBEL_SYSTEM_FILES](./REBEL_SYSTEM_FILES.md) — Directory structure and audience distinction between `rebel-system/` and `docs/project/`
- [HELP_FOR_HUMANS_UPDATE_PROCESS](./HELP_FOR_HUMANS_UPDATE_PROCESS.md) — Periodic audit workflow for keeping docs current
- [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md) — Style guide for the user-facing changelog
- [signposting-to-single-source-of-truth](../../rebel-system/skills/documentation/signposting-to-single-source-of-truth/SKILL.md) — Cross-referencing without duplication


## Audience

**Write for:** General knowledge workers — executives, PMs, researchers, professionals. Not developers.

These docs are **bundled into the Rebel app** and distributed to end users. Users cannot modify them — they're read-only and updated only via app releases.


## What to Include vs. Avoid

**Include:**
- Clear, friendly explanations of how features work
- Step-by-step instructions for common tasks
- Troubleshooting guidance users can follow themselves
- Links to other help-for-humans docs (not internal docs)

**Avoid:**
- Developer-only details (submodules, Git internals, private tokens)
- References to this superproject (`docs/project/`, `src/`, `package.json`)
- Technical jargon without explanation
- Implementation details users don't need


## Format Requirements

### YAML Frontmatter

Every file must have a `description` field:

```yaml
---
description: "One-line summary of what this doc covers"
---
```

### Filename Convention

Descriptive, hyphenated: `feature-name.md` or `concept-explanation.md`

**Searchability matters:** Filenames should include key searchable terms so AI agents and users can find docs easily. Ask: "If someone searches for [concept], will this filename appear?"

**Good examples:**
- `running-big-jobs-unleashed-auto-done.md` — includes "unleashed" and "auto-done" keywords
- `mcp-connectors-tools-and-integrations.md` — includes "connectors", "mcp", "integrations"
- `memory-folders-and-approvals.md` — includes "memory", "folders", "approvals"
- `google-drive-desktop-local-sync.md` — specifies "desktop" and "local sync"

**Avoid:**
- Generic names like `running-big-jobs.md` when specific concepts like "unleashed" are covered
- Single-word names like `ElevenLabs.md` when the purpose (`text-to-speech`) isn't clear
- Vague names like `memory-description.md` when key concepts (`folders`, `approvals`) are missing


## Content Guidelines

### Be Practical and Actionable

- Lead with the most common use case
- Provide step-by-step instructions where relevant
- Include examples users can try immediately
- Add troubleshooting for common issues

### Keep It Scannable

- Use descriptive headings (not just "Overview" or "Details")
- Bullet points for lists of items
- Code blocks for commands or examples users type
- Tables for comparisons or reference data

### Cross-Reference Helpfully

- Link to related help docs with brief context
- Use a "See also" section for related topics
- Don't duplicate content — link to the single source of truth

### Link Format for In-App Viewing

When linking to other help-for-humans docs, use the canonical `rebel://library/` protocol so links open in the document preview drawer rather than opening Finder. The path component must be URL-encoded (slashes → `%2F`):

```markdown
<!-- GOOD: Canonical form, opens in document preview drawer -->
[Connectors guide](rebel://library/rebel-system%2Fhelp-for-humans%2Fmcp-connectors-tools-and-integrations.md)

<!-- BAD: Opens in Finder -->
[Connectors guide](mcp-connectors-tools-and-integrations.md)
```

Full path format: `rebel://library/rebel-system%2Fhelp-for-humans%2F<filename>.md`

**Anchors** (`#heading`) and query params (`?q=…`) are preserved verbatim — only the path component is URL-encoded. Example:

```markdown
[Extended context](rebel://library/rebel-system%2Fhelp-for-humans%2FAI-models.md#extended-context)
```

**Legacy forms:** Historical docs may still use `library://rebel-system/help-for-humans/…` or `workspace://…`. Reader code paths accept all three forms indefinitely for back-compat, but new authoring must use the canonical form. The repo-wide cleanup landed in 2026-04 — see `docs/plans/260416_finish_library_url_cleanup.md`.


## Tone

Match Rebel's voice: dry wit, calm reassurance, cultural depth. Not chatbot enthusiasm.

**Good:** "If something goes wrong, the troubleshooting guide has your back."

**Avoid:** "We're so excited to help you troubleshoot!"

See `src/renderer/features/agent-session/work-surface/utils/personaQuips.ts` for tone calibration.


## Quality Checklist

Before committing a help-for-humans doc:

- [ ] Has YAML frontmatter with `description`
- [ ] Uses plain language (no unexplained jargon)
- [ ] Actionable — readers know what to do next
- [ ] Links to other help docs use canonical `rebel://library/rebel-system%2Fhelp-for-humans%2F…` format (not legacy `library://` or `workspace://`)
- [ ] Links work and point to other user-facing docs (not `docs/project/`)
- [ ] No references to internal code, build systems, or developer processes
- [ ] Tone matches Rebel's voice (capable, witty, not chirpy)


## Voice Checklist for Writers

When writing or updating help-for-humans docs, ask yourself:

1. **Would an executive understand this?** If it requires technical background, simplify or link to an explanation
2. **Does it sound like Rebel?** Dry wit, not chatbot enthusiasm. Confident, not boastful.
3. **Is there jargon?** Use the "plain English (technical term)" pattern on first use, e.g., "connections (MCP)"
4. **Does it lead with benefit?** Users want to know "what can I do?" before "how does it work?"
5. **Is there a good metaphor?** Rebel excels at these: "like a capable colleague," "driving with a co-pilot"
6. **Would you say this out loud?** If it sounds stilted when spoken, rewrite it
7. **Is it scannable?** Use tables, bullets, short paragraphs
8. **Does it avoid internal references?** No `src/`, `docs/project/`, GitHub links, or submodules

### Jargon Replacement Pattern

On first mention of a technical term, use "plain English (technical term)" so users can find the term in the UI:

| Technical Term | First Mention Pattern | Subsequent |
|----------------|----------------------|------------|
| MCP | "connections (MCP)" | "connections" |
| OAuth | "sign in (OAuth)" | "sign in" |
| Context window | "working memory (context window)" | "working memory" |
| API key | "your access code (API key)" | "access code" |
| Token | Avoid; if needed: "roughly a word" | — |
| stdio/SSE | Remove entirely — users don't need this | — |


## Examples of Good Help Docs

- `terminology.md` — Clear definitions, friendly tone, practical links
- `where-rebel-stores-things.md` — Concise, well-structured, platform-specific details
- `keyboard-shortcuts-and-hotkeys.md` — Scannable, practical, immediately useful
- `how-rebel-is-built.md` — Friendly architecture overview for curious users
- `quick-open.md` — Feature-focused, scannable, practical


## Internal-to-User Doc Mapping

Many features have both internal (`docs/project/`) and user-facing (`help-for-humans/`) documentation:

| Internal Doc | User-Facing Doc |
|--------------|-----------------|
| [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) | [architecture-technical-description.md](../../rebel-system/help-for-humans/architecture-technical-description.md) |
| [REBEL_CORE](./REBEL_CORE.md) | [architecture-technical-description.md](../../rebel-system/help-for-humans/architecture-technical-description.md) (§ The Agent Model) |
| [PRODUCT_VISION_FEATURES](./PRODUCT_VISION_FEATURES.md) | [product-overview-and-features.md](../../rebel-system/help-for-humans/product-overview-and-features.md) |
| [AUTOMATIONS](./AUTOMATIONS.md) | [automations.md](../../rebel-system/help-for-humans/automations.md) |
| [INBOX_PANEL](./INBOX_PANEL.md) | [actions.md](../../rebel-system/help-for-humans/actions.md) |
| [MEETING_BOT](./MEETING_BOT.md) | [meetings-and-notetaker.md](../../rebel-system/help-for-humans/meetings-and-notetaker.md) |
| [PRIVACY_MODE](./PRIVACY_MODE.md) | [privacy-mode.md](../../rebel-system/help-for-humans/privacy-mode.md) |
| [SCRATCHPAD](./SCRATCHPAD.md) | [scratchpad.md](../../rebel-system/help-for-humans/scratchpad.md) |
| [THE_SPARK](./THE_SPARK.md) | [the-spark.md](../../rebel-system/help-for-humans/the-spark.md) |
| [LIBRARY_AND_FILE_ACCESS](./LIBRARY_AND_FILE_ACCESS.md) | [spaces.md](../../rebel-system/help-for-humans/spaces.md) |
| [SEARCH](./SEARCH.md) | [file-search.md](../../rebel-system/help-for-humans/file-search.md) |
| [MCP_CONFIGURATION](./MCP_ARCHITECTURE.md) | [mcp-connectors-tools-and-integrations.md](../../rebel-system/help-for-humans/mcp-connectors-tools-and-integrations.md) |
| [mcps/SLACK_MCP](./mcps/SLACK_MCP.md) | [connectors/slack.md](../../rebel-system/help-for-humans/connectors/slack.md) |
| [mcps/GOOGLE_WORKSPACE_MCP](./mcps/GOOGLE_WORKSPACE_MCP.md) | [connectors/google-workspace.md](../../rebel-system/help-for-humans/connectors/google-workspace.md) |
| [BILLING_AND_SUBSCRIPTION_TIERS](./BILLING_AND_SUBSCRIPTION_TIERS.md) | [mindstone-plans-and-billing.md](../../rebel-system/help-for-humans/mindstone-plans-and-billing.md) |
| [TIME_SAVED](./TIME_SAVED.md) | [time-saved-estimation.md](../../rebel-system/help-for-humans/time-saved-estimation.md) |
| [VOICE_AND_AUDIO](./VOICE_AND_AUDIO.md) | [voice-and-audio.md](../../rebel-system/help-for-humans/voice-and-audio.md) |
| [MOBILE_OVERVIEW](./MOBILE_OVERVIEW.md) | [cloud-continuity-and-mobile.md](../../rebel-system/help-for-humans/cloud-continuity-and-mobile.md) |
| [MOVING_REBEL_BETWEEN_COMPUTERS](./MOVING_REBEL_BETWEEN_COMPUTERS.md) | [moving-rebel-to-a-new-computer.md](../../rebel-system/help-for-humans/moving-rebel-to-a-new-computer.md) |
