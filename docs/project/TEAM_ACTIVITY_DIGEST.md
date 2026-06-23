---
description: "Rebel pointer + project overrides for the team-activity digest — 'what has X been working on?' answered from exported conversation transcripts. Generic process lives in coding-agent-instructions."
use_cases:
  - "Answering 'what has <person> been working on in the past few days?'"
  - "Weekly digest of what the whole team did, including work that didn't ship"
  - "Recovering the intent behind a shipped change by tracing its commit back to the conversation"
last_updated: "2026-06-18"
dependencies:
  - "../../coding-agent-instructions/workflows/TEAM_ACTIVITY_DIGEST.md"
  - "../../coding-agent-instructions/workflows/CHANGELOG_DAILY_EXPLAINER.md"
  - "../../coding-agent-instructions/docs/DROID_AND_CURSOR_CONVERSATION_TRANSCRIPT_EXPORT.md"
  - "./CHANGELOG_DAILY_EXPLAINER_PROCESS.md"
agent_type: "main_agent"
---

# Team Activity Digest — Rebel overrides

> **The process lives in the shared workflow:** [`coding-agent-instructions/workflows/TEAM_ACTIVITY_DIGEST.md`](../../coding-agent-instructions/workflows/TEAM_ACTIVITY_DIGEST.md). Read it for the full method — resolve the owner handle, list a person's sessions in a window, read frontmatter, cluster into themes, and follow the depth ladder. This file only supplies Rebel's concrete values.

**To use it, point an agent at the shared workflow + this file and ask your question** — e.g. *"what has Josh been working on in the past couple of days?"* or *"give me a digest of what the team shipped and started this week."* The agent runs the `find`/`rg` recipes against the path below and synthesises.

## Rebel's overrides

| Placeholder | Rebel value |
|-------------|-------------|
| `{CONVERSATIONS_DIR}` | The `Shared drives/Product/droid-conversations` folder on the Product Google Shared Drive. On a synced Mac: `…/Library/CloudStorage/GoogleDrive-<you>@example.com/Shared drives/Product/droid-conversations`. Non-Mac or custom mount: set `DROID_CONVERSATIONS_DIR` (see the [export doc](../../coding-agent-instructions/docs/DROID_AND_CURSOR_CONVERSATION_TRANSCRIPT_EXPORT.md#override)). |
| `{repo-slug}` | `mindstonerebel` — so Rebel sessions are at `…/droid-conversations/mindstonerebel/YYYY/MM/<owner>_DD_HHmmss_<slug>.md`. (Pre-2026-04-12 sessions were migrated here from the old un-slugged root.) |
| `{explainer}` | [CHANGELOG_DAILY_EXPLAINER_PROCESS](./CHANGELOG_DAILY_EXPLAINER_PROCESS.md) → the generated HTML at `$CHANGELOG_DIR`. |
| `{changelog}` | [`CHANGELOG.md`](../../CHANGELOG.md) (internal, timestamped) for cross-referencing commit SHAs. |

## Rebel notes

- **Cross-repo view**: a Rebel teammate's work in other Mindstone repos lands under sibling `<repo-slug>/` folders (e.g. `weteachbackend/`). For "everything X did", scan all slugs, not just `mindstonerebel/`.
- **Diagnosing gaps**: if someone's sessions are missing, the transcripts never reached Drive — see [DIAGNOSING_MISSING_DROID_AND_CURSOR_TRANSCRIPT_EXPORTS](../../coding-agent-instructions/docs/DIAGNOSING_MISSING_DROID_AND_CURSOR_TRANSCRIPT_EXPORTS.md), not this digest.
- **Companion**: the digest gives intent + effort (incl. unshipped work); the [daily explainer](./CHANGELOG_DAILY_EXPLAINER_PROCESS.md) gives the shipped detail. Join on commit SHA.
