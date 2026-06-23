---
description: "Per-connector testing/validation status for rebel-oss MCP connectors and the bundled connectors still awaiting OSS migration"
last_updated: "2026-06-11"
---

> **2026-06-11 — point-in-time ledger.** Rows below are dated individually; do **not** read them as current. Current pins live in [`resources/connector-catalog.json`](../../resources/connector-catalog.json) and on npm. Since 2026-06-11 all releases go via `npm run mcp:release` ([MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md)); e.g. retell-ai is now `@mindstone/mcp-server-retell-ai@0.2.3`, superseding the `@mindstone-engineering/...@0.1.3` rows below.

> **2026-04-29 update — bundled migration order:** New "Bundled migration — recommended order" section captures the credential-led port order (Tier 1 empty after Discourse deferral; Tier 2 = M365 wave + Slack/HubSpot/Google; Tier 3 = no-cred deferrals) and supersedes "Suggested Next Steps" item 7. See the section for the full rationale and the 3-branch batching plan.

> **2026-04-29 update — retell-ai 0.1.3:** Live stdio probe against the user's real Retell account exercised `initialize`, `tools/list`, and 5 read-only tools (`list_phone_numbers`, `list_agents`, `list_calls`, `list_retell_llms`, `list_voices`) plus annotation inspection. All passed. Three real bugs in 0.1.2 were fixed and republished as 0.1.3, and the catalog was re-pinned. See "retell-ai 0.1.2 → 0.1.3 incident" below.
>
> **2026-04-29 cohort sweep — all 21 untested OSS connectors offline-probed:** Spawned every published OSS package (`initialize` + `tools/list`), plus one live read-only call for Zendesk where credentials were available. **All 21 boot cleanly.** **15 of 21 have stale `SERVER_VERSION`** (same drift class as retell-ai 0.1.2). **19 of 21 have at least one mutating tool missing `destructiveHint: true`** (annotation drift). One live API success: Zendesk `list_tickets` returns the user's real tickets. See "OSS cohort sweep (2026-04-29)" below.

# OSS Connector Testing Status

Tracks which migrated `rebel-oss` connectors have been validated, which haven't, and which connectors are still bundled and awaiting OSS migration.

> Subdoc of [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md). Architecture, install lifecycle, and cross-surface handling live in the parent doc.

## See Also

- [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md) — Parent: how rebel-oss connectors work end-to-end
- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) — Building and shipping connectors
- [OPEN_SOURCE_PR_REVIEW_AND_TEST](OPEN_SOURCE_PR_REVIEW_AND_TEST.md) — Reviewer-side workflow once a contributed PR reaches `mindstone/mcp-servers`
- [TESTING_EVALS_OSS_CONNECTOR_FLOW](TESTING_EVALS_OSS_CONNECTOR_FLOW.md) — OSS connector eval harness (build flow, not per-connector behaviour)
- [MCP_OSS_CATALOG_VERSION_AUDIT](MCP_OSS_CATALOG_VERSION_AUDIT.md) — Rerunnable runbook for keeping `@mindstone/*` catalog pins aligned with npm `latest`
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) — Auth modes for the next migration wave (HubSpot, Slack, Microsoft, etc.)
- Forward plan: [`docs/plans/260410_oss_mcp_integration_forward_plan.md`](../plans/260410_oss_mcp_integration_forward_plan.md) (P7: bundled → rebel-oss migration)
- Catalog: [`resources/connector-catalog.json`](../../resources/connector-catalog.json) (source of truth)
- Validation artefacts: [`.factory/validation/<milestone>/user-testing/synthesis.json`](../../.factory/validation/)

---

## How to Update This Doc

This is an **evergreen tracking doc**. Update it whenever:

- A user-testing flow synthesis lands under `.factory/validation/<milestone>/user-testing/`.
- A connector flips from `bundled` to `rebel-oss` (or vice versa) in `resources/connector-catalog.json`.
- A new failure class is uncovered that affects the cohort (e.g. annotation drift, bridge-state hygiene).

Verify the catalog state against this doc with:

```bash
jq -r '.connectors[] | select(.provider == "bundled" or .provider == "rebel-oss") | "\(.id)\t\(.provider)"' resources/connector-catalog.json | sort
```

---

## Status Summary (as of 2026-05-22)

- **38 catalog entries migrated** to `provider: "rebel-oss"` (the v0.4.41 cohort added OpenAI Image, Google Workspace cleanup, Replit SSH, the Microsoft 365 / Office family, and HubSpot 0.2.0).
- **4 of those 38** have checked-in user-testing flow synthesis (`browser-automation`, `retell-ai`, `outreach`, `salesforce`).
- **1 of those 4** passed cleanly (`browser-automation`); the other 3 have known concrete failures (see below).
- **34 of 38** have **no per-connector user-testing flow synthesis**. Google Workspace has stronger package-level evidence (live probe passed for seven read services on `[Mindstone-email]`; write probes are pending scratch resources; Tasks/Forms remain scope-denied) but no checked-in user-testing synthesis yet. HubSpot 0.2.0 has stronger pre-publish evidence than the cohort baseline: dual-reviewer § 13 security review caught + remediated HIGH F-1 (association path injection) and LOW F-2 (input bounds on conversation tools); 262 tests passed against the rebuilt tree; live smoke from a fresh shell confirmed 95 tools including all 3 new Conversations Inbox tools.
- **5 user-facing connectors remain `bundled`** plus **13 internal-system entries** that are intentionally staying bundled.

## Migrated rebel-oss Connectors — Validation Status

### Validated via user-testing flow

| Connector | npm package | Round | Synthesis | Status | Open issues |
|---|---|---|---|---|---|
| `bundled-browser-automation` | `@mindstone-engineering/mcp-server-browser-automation` | 1 | [browser-automation](../../.factory/validation/browser-automation/user-testing/synthesis.json) | **PASS** (12/12) | none |
| `bundled-retell-ai` | `@mindstone-engineering/mcp-server-retell-ai@0.1.3` | 2 + post-publish live stdio probe (2026-04-29) | [retell-ai](../../.factory/validation/retell-ai/user-testing/synthesis.json) | **PASS** in 0.1.3 (synthesis.json round 2 still records 4/5 — pre-fix; needs re-run to re-emit) | VAL-RETELL-007 fixed in 0.1.2 (annotations); two further endpoint bugs fixed in 0.1.3 (`/list-calls` → `/v2/list-calls`, `/list-retell-llm` → `/list-retell-llms`) and stale `SERVER_VERSION` constant replaced with `package.json` read |
| `bundled-outreach` | `@mindstone-engineering/mcp-server-outreach` | 2 | [outreach](../../.factory/validation/outreach/user-testing/synthesis.json) | **FAIL** (2/3) | VAL-OUTREACH-006 — `MINDSTONE_REBEL_BRIDGE_STATE` references still present in source and packed dist bridge module (bridge-state hygiene) |
| `bundled-salesforce` | `@mindstone-engineering/mcp-server-salesforce` | 1 | [salesforce](../../.factory/validation/salesforce/user-testing/synthesis.json) | **FAIL** (19/24, 4 failed, 1 blocked) | VAL-SF-003 (no actionable recovery guidance on 4xx/5xx); VAL-SF-006 (`MCP_HOST_BRIDGE_STATE` / `MINDSTONE_REBEL_BRIDGE_STATE` strings); VAL-SF-009 (runtime Salesforce refs in `bundledInboxBridge` + `mcpServerRemovalService`); VAL-CROSS-005 (`npm run test` exits code 1 in final state) |

### Migrated but no per-connector user-testing flow

These have shipped catalog entries pointing at npm packages, but no `.factory/validation/<id>/user-testing/synthesis.json` exists. There is some indirect coverage from the connector-build eval harness (`evals/...`) and the `npx`-spawn smoke test added in commit `714d0b5dd` (NanoBanana / ElevenLabs / Napkin only), and a Zendesk regression fixture from `8992d1f4f`, but none of these substitute for a user-testing flow.

| Connector | npm package | Notes |
|---|---|---|
| `bundled-apple-shortcuts` | `@mindstone-engineering/mcp-server-apple-shortcuts@0.1.0` | macOS-only |
| `bundled-custom-email` | `@mindstone-engineering/mcp-server-email-imap@0.2.1` | Generic IMAP |
| `bundled-elevenlabs` | `@mindstone-engineering/mcp-server-elevenlabs@0.2.0` | Smoke-only via `714d0b5dd` |
| `bundled-fathom` | `@mindstone-engineering/mcp-server-fathom@0.2.1` | |
| `bundled-freshdesk` | `@mindstone-engineering/mcp-server-freshdesk@0.2.0` | File-based credential contract still flagged broken in `260422_oss_migration_audit_followups.md` |
| `bundled-gamma` | `@mindstone-engineering/mcp-server-gamma@0.3.0` | Misclassification regression covered in eval (`260423_gamma_provider_misclassification.md`) |
| `bundled-google` | `@mindstone/mcp-server-google-workspace@0.1.3` | Catalog flipped and bundled source deleted 2026-05-19 via [`260519_google_workspace_oss_migration`](../plans/260519_google_workspace_oss_migration.md). Bumped to `0.1.3` on 2026-05-31 to fix REBEL-H3 (Shared Drives broken) — added `supportsAllDrives: true` to Drive API calls. Live package probe passed for seven read services on `[Mindstone-email]` (Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts) plus OAuth refresh/disable-refresh round trip. Write probes are pending scratch Gmail label / Calendar / Drive resources. Tasks and Forms remain scope-denied under the current account. User-testing synthesis still pending. |
| `bundled-hubspot` | `@mindstone/mcp-server-hubspot@0.2.0` | Catalog bumped from `0.1.2` to `0.2.0` in v0.4.41 (Rebel dev commit `9fd9112f4`). v0.2.0 ships FOX-3354 (`get_hubspot_line_item` + line-items wiring on `list/get_hubspot_deal`) and FOX-3376 (3 Conversations Inbox tools — `list_hubspot_ticket_threads`, `list_hubspot_thread_messages`, `get_hubspot_thread_message_original_content`). The new conversation tools require `conversations.read`, mirrored into `HUBSPOT_WRITE_SCOPES` (optional tier — keeps the baseline consent contract unchanged for existing cohorts; SCOPE_MISSING surfaces reactively on first conversation tool call rather than silently). **Dual-reviewer § 13 security review** caught + remediated HIGH F-1 (association path injection on `list_hubspot_associations` — `${objectType}/${recordId}` was templated into the URL without validation; remediation added path-segment validators + `encodeURIComponent` + 52-test regression guard) and LOW F-2 (input bounds on the 3 new conversation-tool schemas). Phase F live smoke from a fresh shell confirmed `HubSpot MCP Server v0.2.0` startup banner, **95 tools** total, and all 3 conversation tools + `get_hubspot_line_item` PRESENT. Report: [`docs-private/reports/security-reviews/260521_hubspot_0.2.0.md`](../../docs-private/reports/security-reviews/260521_hubspot_0.2.0.md). User-testing flow synthesis still pending (`.factory/validation/hubspot/user-testing/synthesis.json` not yet created); covered indirectly by 242 hubspot-touching unit tests passing on dev post-cherry-pick. |
| `bundled-humaans` | `@mindstone-engineering/mcp-server-humaans@0.2.0` | |
| `bundled-icloud-mail` | `@mindstone-engineering/mcp-server-email-imap@0.2.1` | IMAP wrapper |
| `bundled-kling` | `@mindstone-engineering/mcp-server-kling@0.3.0` | |
| `bundled-microsoft-mail` | `@mindstone/mcp-server-microsoft-mail@0.1.1` | Outlook Mail; migrated in the v0.4.41 Microsoft 365 cohort. Shares the preserved Microsoft account/token migration path across desktop and cloud. User-testing synthesis still pending. |
| `bundled-microsoft-calendar` | `@mindstone/mcp-server-microsoft-calendar@0.1.1` | Outlook Calendar; migrated in the v0.4.41 Microsoft 365 cohort. User-testing synthesis still pending. |
| `bundled-microsoft-files` | `@mindstone/mcp-server-microsoft-files@0.1.1` | OneDrive; migrated in the v0.4.41 Microsoft 365 cohort. User-testing synthesis still pending. |
| `bundled-microsoft-teams` | `@mindstone/mcp-server-microsoft-teams@0.1.1` | Teams; migrated in the v0.4.41 Microsoft 365 cohort. User-testing synthesis still pending. |
| `bundled-microsoft-sharepoint` | `@mindstone/mcp-server-microsoft-sharepoint@0.1.1` | SharePoint; migrated in the v0.4.41 Microsoft 365 cohort. User-testing synthesis still pending. |
| `bundled-mixmax` | `@mindstone-engineering/mcp-server-mixmax@0.2.0` | |
| `bundled-nano-banana` | `@mindstone-engineering/mcp-server-nano-banana@0.3.0` | Smoke-only via `714d0b5dd`; workspace-path fix landed `260419a` |
| `bundled-napkin` | `@mindstone-engineering/mcp-server-napkin@0.3.0` | Smoke-only via `714d0b5dd` |
| `openai-image-generation` | `@mindstone/mcp-server-openai-image@0.1.2` | First connector under the new `@mindstone/` scope; second `rebel-oss` under the mandatory § 13 gate (Slack is first). Live coverage deferred — `providerKeys.openai` is null in the test environment as of 2026-05-19; backfill when a paid OpenAI key is available. Security review: `docs-private/reports/security-reviews/260503_openai-image_0.1.0.md` (PENDING_REVIEWERS at catalog-pin time). |
| `bundled-office` | `@mindstone/mcp-server-office@0.2.0` | Word/Excel/PowerPoint Office add-in connector; catalog remains `provider: "rebel-oss"` and is part of the current Microsoft/Office family status. User-testing synthesis still pending. |
| `bundled-opus-video-clip` | `@mindstone/mcp-server-opus-video-clip@0.1.0` | OpusClip video clipping connector (catalog id rename landed 2026-05-20). User-testing synthesis still pending. |
| `bundled-pandadoc` | `@mindstone-engineering/mcp-server-pandadoc@0.2.0` | |
| `bundled-slack` | `@mindstone/mcp-server-slack@0.1.2` | Catalog flipped to rebel-oss as Stages 0-4 of the migration plan (`docs/plans/260429_slack_mcp_oss_migration.md`); bundled-source tree deleted 2026-05-19 in commit `aff75dfd6` (Phase D, mirrors the Vanta pattern). **Tarball hygiene PASS:** `npm pack @mindstone/mcp-server-slack@0.1.2` extracted on 2026-05-19, `grep -r` for `MINDSTONE_REBEL_BRIDGE_STATE` / `MCP_HOST_BRIDGE_STATE` / `mindstone-rebel` / `host bridge` → **zero matches** in the published dist. Closes failure-class 1 at publish for this connector (Option A from the migration plan). User-testing flow synthesis still pending (`.factory/validation/slack/user-testing/synthesis.json` not yet created); covered indirectly by `slackMentionAdapter` test suite and OSS-cohort smoke probes. Host-side machinery preserved: `slackAuthService`, `slackHandlers`, `slackMentionAdapter`, `slackCredentialSource`, `buildSlackInstancePayload`. |
| `bundled-replit-ssh` | `@mindstone/mcp-server-replit-ssh@0.1.2` | OSS package first published as `0.1.0` on 2026-05-19T15:15:22Z; current catalog pin is `0.1.2`. Catalog flipped in rebel-app PR #289; bundled tree `resources/mcp/replit-ssh/` deleted in the Phase F cleanup. Awaiting Phase E desktop live probe by user (real Repl env vars + ≥5 read / ≥2 write tool round-trip through desktop Rebel). |
| `bundled-quickbooks` | `@mindstone-engineering/mcp-server-quickbooks@0.2.0` | Vendored from intuit/quickbooks-online-mcp-server |
| `bundled-runway` | `@mindstone-engineering/mcp-server-runway@0.3.0` | |
| `bundled-servicenow` | `@mindstone-engineering/mcp-server-servicenow@0.2.0` | |
| `bundled-talentlms` | `@mindstone-engineering/mcp-server-talentlms@0.2.0` | |
| `bundled-workday` | `@mindstone-engineering/mcp-server-workday@0.2.0` | |
| `bundled-yahoo-mail` | `@mindstone-engineering/mcp-server-email-imap@0.2.1` | IMAP wrapper |
| `bundled-zendesk` | `@mindstone-engineering/mcp-server-zendesk@0.3.0` | Misclassification regression fixtures only (`8992d1f4f`) |

## Bundled Connectors NOT Yet Migrated

User-facing — real candidates for OSS migration (P7 of the forward plan):

| Connector | Server name | Likely complexity |
|---|---|---|
| `bundled-app-bridge` | RebelAppBridge | Likely stays bundled — deep Electron integration |
| `bundled-ibkr` | IBKR | Has external `verifiedSource` |
| `bundled-mixpanel` | Mixpanel | OAuth/API surface; still bundled in current catalog |
| `bundled-profitsage` | ProfitSage | |
| `discourse` | Discourse | **Deferred — do not port (see note below)** |

Internal/system entries (`isInternal: true`, ~12 expected to stay bundled per forward plan): `rebel-automations`, `rebel-canvas`, `rebel-diagnostics`, `rebel-inbox`, `rebel-internal`, `rebel-mcp-connectors`, `rebel-meetings`, `rebel-plugins`, `rebel-search-and-conversations`, `rebel-settings`, `rebel-spaces`, `rebels-community`, plus `rebels-community-write`.

### `discourse` — deferred from OSS migration (2026-04-29)

**Decision:** Do **not** migrate `discourse` to `rebel-oss` at this time. Keep it bundled.

**Reason:** The only Discourse instance Rebel ships pre-configured against is `https://rebels.mindstone.com`, which is Mindstone's **internal** Discourse channel (Rebels community). The connector profile in the user's electron store (`mcp/discourse-write/profile.json`) carries write-enabled credentials for that internal site. Publishing the connector to npm under `@mindstone-engineering/...` would advertise an internal-only integration to the open ecosystem and create pressure to support arbitrary external Discourse instances we don't intend to maintain.

This is **not** a "wait until creds are sorted" deferral — even though the user has working creds, Discourse is being held back deliberately because it is functionally an internal connector that happens to ride on a public protocol. Future agents: do not move `discourse` to `provider: "rebel-oss"` without explicit re-authorisation from the user. If the decision is ever reversed, the upstream `discourse/discourse-mcp` (the existing `verifiedSource`) is the natural starting point — the work is technical, the blocker is policy.

Related: the internal `rebels-community` and `rebels-community-write` entries (in the `isInternal: true` list above) are the same channel; they should remain bundled for the same reason.

## Bundled migration — recommended order (2026-04-29)

> **Supersedes** the lower-complexity-first ordering in "Suggested Next Steps" item 7 (kept below for diff history). The reordering reflects an explicit credential audit of the user's electron store: connectors with working creds in `~/Library/Application Support/mindstone-rebel/` can be end-to-end validated in this branch, no-cred connectors cannot — so testability beats nominal complexity.

### Credential inventory (electron store, audited 2026-04-29)

| Connector | Cred present? | Where |
|---|---|---|
| `discourse` | yes — `rebels.mindstone.com` user_api_key, `allow_writes: true` | `mcp/discourse-write/profile.json` |
| ~~`bundled-google`~~ | yes — 3 accounts | `google-workspace-mcp/` (`[Mindstone-email]`, `[external-email]`, `[external-email]`) — **migrated 2026-05-19 to `@mindstone/mcp-server-google-workspace@0.1.0`**; token/account file paths unchanged |
| ~~`bundled-microsoft-{mail,calendar,files,sharepoint,teams}`~~ | yes — 1 account, **shared across all 5** | `microsoft-mcp/` (`[Mindstone-email]`) — **migrated in v0.4.41** to `@mindstone/mcp-server-microsoft-{mail,calendar,files,teams,sharepoint}@0.1.1`; per-account migration preserved across desktop and cloud |
| ~~`bundled-hubspot`~~ | yes — 1 account | `mcp/hubspot/credentials/engineering-mindstone-com.token.json` — **migrated in v0.4.41** to `@mindstone/mcp-server-hubspot@0.2.0` (Rebel dev commit `9fd9112f4`); token file path unchanged; `conversations.read` added to host write-scopes (optional tier) so existing 0.1.2 cohorts keep working unchanged |
| ~~`bundled-slack`~~ | yes — 1 workspace authed (Mindstone, `TKQ8HRFQ8`) | `mcp/slack/workspaces/TKQ8HRFQ8.json` — **migrated 2026-05-19 to `@mindstone/mcp-server-slack@0.1.2`** (Phase D cleanup `aff75dfd6`); token file path unchanged |
| `bundled-ibkr` | no | — |
| `bundled-profitsage` | no | — |
| ~~`bundled-replit-ssh`~~ | no | — **migrated 2026-05-19**; current catalog pin `@mindstone/mcp-server-replit-ssh@0.1.2` |
| ~~`openai-image-generation`~~ | no — `providerKeys.openai` is null in `app-settings.json` | — **migrated 2026-05-19**; current catalog pin `@mindstone/mcp-server-openai-image@0.1.2` |
| `bundled-app-bridge` | n/a — likely stays bundled (deep Electron integration) | — |
| ~~`bundled-office`~~ | n/a — Office add-in | — **catalog is `rebel-oss`** at `@mindstone/mcp-server-office@0.2.0` |

Reproduce with: `ls "$HOME/Library/Application Support/mindstone-rebel/" | rg -i "auth|token|oauth|credential|connector|mcp"` and `jq` on each accounts file (see commit `0d021164b` for the exact probe).

### Port order

#### Tier 1 — quick win, non-OAuth, fully testable

1. ~~**`discourse`**~~ — **DEFERRED.** Was the natural Tier 1 candidate (external `verifiedSource`, static `user_api_key`, write-enabled creds), but classified as functionally internal — see the "`discourse` — deferred from OSS migration" note above. **Tier 1 is currently empty** as a result.

#### Tier 2 — OAuth-heavy, working creds in store

2. ~~**`bundled-microsoft-mail`**~~ — **DONE in v0.4.41** via `@mindstone/mcp-server-microsoft-mail@0.1.1`; per-account migration preserved across desktop and cloud.
3. ~~**`bundled-microsoft-calendar`**~~ — **DONE in v0.4.41** via `@mindstone/mcp-server-microsoft-calendar@0.1.1`.
4. ~~**`bundled-microsoft-files`** (OneDrive)~~ — **DONE in v0.4.41** via `@mindstone/mcp-server-microsoft-files@0.1.1`.
5. ~~**`bundled-microsoft-sharepoint`**~~ — **DONE in v0.4.41** via `@mindstone/mcp-server-microsoft-sharepoint@0.1.1`.
6. ~~**`bundled-microsoft-teams`**~~ — **DONE in v0.4.41** via `@mindstone/mcp-server-microsoft-teams@0.1.1`.
7. ~~**`bundled-slack`**~~ — **DONE 2026-05-19** via `@mindstone/mcp-server-slack@0.1.2`; Phase D bundled-source cleanup landed in commit `aff75dfd6`. Tarball hygiene grep clean. User-testing synthesis still pending.
8. ~~**`bundled-hubspot`**~~ — **DONE in v0.4.41** via `@mindstone/mcp-server-hubspot@0.2.0`. v0.2.0 ships FOX-3354 (line_items → deals reads) + FOX-3376 (3 Conversations Inbox tools); `conversations.read` mirrored into host write-scopes (optional tier). Dual-reviewer § 13 security review caught + remediated HIGH F-1 (association path injection) and LOW F-2 (input bounds). Phase F fresh-shell smoke: 95 tools, all 3 conversation tools + `get_hubspot_line_item` PRESENT. Tarball hygiene clean (no `MINDSTONE_REBEL_BRIDGE_STATE` / `MCP_HOST_BRIDGE_STATE` in published dist — never had them; hubspot was already on the `@mindstone` scope path from 0.1.2). User-testing synthesis still pending.
9. ~~**`bundled-google`**~~ — **DONE 2026-05-19** via `@mindstone/mcp-server-google-workspace@0.1.0`; live package probe passed seven read services and host OAuth refresh coverage, with write probes deferred until scratch resources exist.

#### Tier 3 — defer until creds exist (or skip on this branch entirely)

10. ~~**`openai-image-generation`**~~ — **DONE 2026-05-19**; current catalog pin `@mindstone/mcp-server-openai-image@0.1.2`. Live coverage is still deferred until a paid OpenAI key is available.
11. **`bundled-ibkr`** — No creds; has external `verifiedSource` (`interactivebrokers.github.io/tws-api/`) suggesting a vendoring path, but worth a real account first.
12. **`bundled-profitsage`** — No creds.
13. ~~**`bundled-replit-ssh`**~~ — **DONE 2026-05-19**; current catalog pin `@mindstone/mcp-server-replit-ssh@0.1.2`. Awaiting user-run desktop live probe.

#### Out of scope

`bundled-app-bridge` (deep Electron integration) per the existing testing-status doc; the 12 `rebel-*` internal entries (and `rebels-community*`) stay bundled by design. `bundled-office` is no longer out of scope here because its catalog entry is `rebel-oss`.

### Practical batching

To cut this efficiently, group as three branches / PR-trains:

- ~~**Branch A:** `discourse` only~~ — **N/A** (deferred above).
- ~~**Branch B:** the M365 wave~~ — **DONE in v0.4.41**; Mail, Calendar, Files/OneDrive, SharePoint, and Teams are all `rebel-oss` catalog entries.
- ~~**Branch C:** Slack + HubSpot + Google~~ — **DONE** for Slack (2026-05-19, 0.1.2), Google Workspace (2026-05-19, 0.1.0 → 0.1.2), and HubSpot (v0.4.41, 0.2.0 — bumped from 0.1.2). Each was its own OAuth surface but they were independent of each other; the OAuth/refresh-token plumbing in `rebel-oss` is now proven across all three. Remaining work is user-testing synthesis/backfill rather than bundled→OSS migration.

Remaining user-facing bundled candidates after v0.4.41 are `bundled-ibkr`, `bundled-profitsage`, and `bundled-mixpanel`; `bundled-app-bridge` likely stays bundled and `discourse` remains deliberately deferred. `openai-image-generation` and `bundled-replit-ssh` are already migrated and only need live/user-testing backfill.

### Why this overrides "Suggested Next Steps" item 7

Item 7 below recommends doing the Tier-3 (no-creds) connectors first on the grounds of nominal complexity. That's correct in a vacuum but ignores that in this branch we can't actually validate them end-to-end without setting up new accounts (IBKR, ProfitSage, Replit) or a paid OpenAI key. The cohort sweep above already established that "compiles + boots + tools/list works" passes for every published OSS connector — i.e. the offline-probe coverage that Tier 3 work would attract is the same coverage we already have. Tier 2 is where the validation gap is real, because we have the creds to actually exercise the OAuth flow and a live tool call. Item 7 is left in place for diff history; future agents should treat **this section** as the authoritative migration order until creds change or another decision lands.

## Recurring Failure Classes Across the Cohort

These keep recurring across the failing synthesis reports and are worth treating as cohort-level issues rather than per-connector bugs.

1. **Bridge-state hygiene.** `MINDSTONE_REBEL_BRIDGE_STATE` / `MCP_HOST_BRIDGE_STATE` strings still ship in OSS dist bundles (Outreach, Salesforce). Indicates the OSS port left internal host vocabulary in the published packages. Sweep all 25 packages.
2. **Annotation drift.** Retell-AI mutating tools report `destructiveHint:false`. Same class as `260413_port_tool_annotations_to_oss_connectors.md` — needs a sweep across the OSS cohort. *Fixed for retell-ai in 0.1.2.*
3. **Recovery-guidance contract.** Salesforce 4xx/5xx errors return `{ok:false,error}` without actionable recovery fields. Likely affects every connector that hasn't been audited against the recovery-guidance contract.
4. **Leftover bundled cleanup.** Salesforce still has runtime references in `bundledInboxBridge.ts` and `mcpServerRemovalService.ts` after the cleanup commit — the cleanup-worker pattern needs a closing audit step.
5. **Test suite red post-migration.** `npm run test` exits with code 1 in the post-Salesforce-migration tree (VAL-CROSS-005). Worth confirming whether that's still red on `feature/rebel-oss-provider-v2`.
6. **Timeout sweep.** 16 OSS connectors still carry `REQUEST_TIMEOUT_MS = 30_000` (tracked in `260422_oss_migration_audit_followups.md` §7).
7. **Live-API endpoint drift.** Retell-AI 0.1.2 hit two paths that the upstream API doesn't actually serve (`/list-calls` returns HTTP 404 — should be `/v2/list-calls`; `/list-retell-llm` returns 404 — typo for `/list-retell-llms`). MSW-based unit tests passed because the mock handlers were registered on the same wrong paths the production code called, so the bugs only surfaced on a live stdio probe. **Cohort risk:** every list-shaped tool whose mock and production code share a string constant is a candidate for the same failure mode. Recommend the OSS connector eval harness add a thin live-API probe gate (read-only methods only, opt-in via per-connector secret) so MSW drift doesn't ship.
8. **`SERVER_VERSION` drift from `package.json`.** Retell-AI 0.1.2 reported `version: "0.1.1"` on `initialize` because `src/types.ts` hardcoded the constant. Fixed in 0.1.3 by switching to a `createRequire`-based read of `package.json`. **Cohort risk:** any connector that maintains a hand-edited version constant beside `package.json` will silently misreport. Worth a one-line sweep across the 25 packages to standardise on the package.json read.

## Suggested Next Steps

In priority order, based on what would close the validation gap fastest:

1. **Backfill user-testing flows** for the 21 migrated-but-untested connectors. Even thin flows (auth + one happy-path tool call + one error path) close the silent-failure gap.
2. **Run a cohort-wide bridge-state grep** against published dist bundles (catches Outreach + Salesforce class).
3. **Run a cohort-wide annotation audit** (catches Retell-AI class). *Done for retell-ai 0.1.2.*
4. **Add the recovery-guidance contract assertion** to the OSS connector eval harness so future migrations fail loudly when missing.
5. **Add a live-API probe gate** to the OSS connector eval harness (read-only tools only, opt-in per connector with stored test credentials). This is the only mechanism that catches the class of bug found in retell-ai 0.1.2 (mock handlers and production code sharing a wrong path).
6. **Sweep `SERVER_VERSION` constants** across all 25 OSS packages and replace hardcoded strings with `package.json` reads (failure class 8 above).
7. **Resume remaining P7 migrations** — after v0.4.41, the credential-led Microsoft / Google / Slack / HubSpot wave is done, and the no-creds OpenAI Image + Replit SSH ports are also done. Remaining user-facing bundled candidates are `bundled-ibkr`, `bundled-profitsage`, and `bundled-mixpanel`; `discourse` is intentionally excluded and `bundled-app-bridge` likely stays bundled.

## retell-ai 0.1.2 → 0.1.3 incident (2026-04-29)

Live stdio probe against the published 0.1.2 with a real Retell account credential surfaced three bugs that unit tests (MSW-mocked) could not catch:

| Bug | Symptom | Root cause | Fix |
|---|---|---|---|
| `list_calls` returns HTTP 404 | "Retell AI API error (HTTP 404): Not Found" on every call | `mcp-servers/connectors/retell-ai/src/tools/calls.ts` POSTed to `/list-calls`; Retell's actual endpoint is `/v2/list-calls`. MSW mock matched the wrong path so unit tests passed. | Change one string in `tools/calls.ts`; update the matching mock in `test/helpers/retell-mock-api.ts`. |
| `list_retell_llms` returns HTTP 404 | "HTTP 404: Not Found" | `mcp-servers/connectors/retell-ai/src/tools/llms.ts` GET `/list-retell-llm`; correct endpoint is `/list-retell-llms` (plural). Same MSW collusion. | Change one string + matching mock. |
| `serverInfo.version` reports `0.1.1` despite published 0.1.2 | Stale on `initialize` | `src/types.ts` hardcoded `SERVER_VERSION = '0.1.1'`. | Replace with `createRequire(import.meta.url)` + `require('../package.json').version`. |

After fix: `npm test` 25/25 pass; live probe runs `initialize` + `tools/list` + `list_phone_numbers` + `list_agents` + `list_calls` + `list_retell_llms` + `list_voices` cleanly. Published as `0.1.3`; Rebel `connector-catalog.json` repinned. The synthesis.json for retell-ai still records the round-2 4/5 result (pre-fix); it should be re-run to formally mark the milestone passing.

**Why this matters for the rest of the cohort:** the same MSW-handler-mirrors-production-string pattern is in use across the OSS connectors. Until a live-API probe gate exists, the eval harness will keep accepting wrong endpoint paths so long as the mock matches them. See failure classes 7 and 8 above.

## OSS cohort sweep (2026-04-29)

Following the retell-ai incident, every untested OSS connector was spawned via `npx -y <package>` and probed for `initialize` + `tools/list`. Where the user's Electron-store creds were available (only Zendesk in the current session — see triage below), one read-only live API call was added.

### Credential-availability triage

The bridge HTTP server (Rebel main process inbox bridge) was up on `127.0.0.1:52598` during the sweep. `super-mcp-router.json` was inspected for live env-var values (real api keys vs. `{{TEMPLATE}}` placeholders vs. absent).

| Connector | Configured in router? | API-key env populated? | Live-testable now? |
|---|---|---|---|
| `bundled-zendesk` | yes | `ZENDESK_CONFIG_PATH/accounts.json` has real apiToken | **YES** (verified) |
| `bundled-apple-shortcuts` | no | none required (macOS-native) | **YES** (no creds path) |
| `bundled-fathom` | yes | no `FATHOM_API_KEY` set | offline only |
| `bundled-humaans` | yes | no `HUMAANS_API_KEY` set | offline only |
| `bundled-servicenow` | yes | no SN credentials env | offline only |
| `bundled-gamma` | yes | env has `{{GAMMA_API_KEY}}` placeholder | offline only |
| `bundled-icloud-mail` | yes | bridge-pattern; no IMAP creds visible | offline only |
| 13 other migrated connectors | no | n/a | offline only |

### Results matrix

```
id                          expected  reported     tools  RO/DEST/IDE/OW  drift   live
--------------------------------------------------------------------------------------
bundled-apple-shortcuts     0.1.0     0.1.0         2     1/0/1/0         -
bundled-browser-automation  0.1.3     0.1.2 DRIFT  18     5/1/6/17        -
bundled-fathom              0.2.1     0.1.0 DRIFT   7     6/0/0/0         1
bundled-icloud-mail         0.2.1     0.1.0 DRIFT   9     4/0/0/0         1
bundled-yahoo-mail          0.2.1     0.1.0 DRIFT   9     4/0/0/0         1
bundled-custom-email        0.2.1     0.1.0 DRIFT   9     4/0/0/0         1
bundled-pandadoc            0.2.0     0.1.0 DRIFT   9     5/0/0/0         3
bundled-mixmax              0.2.0     0.1.0 DRIFT  10     6/0/0/0         3
bundled-zendesk             0.3.0     0.2.0 DRIFT  20    14/4/0/0         1   list_tickets:OK
bundled-freshdesk           0.2.0     0.1.0 DRIFT  11     5/1/0/0         3
bundled-gamma               0.3.0     0.3.0         6     3/0/0/0         1
bundled-napkin              0.3.0     0.3.0         4     1/0/0/0         1
bundled-elevenlabs          0.2.0     0.1.0 DRIFT   8     3/0/0/0         2
bundled-kling               0.3.0     0.3.0         4     1/0/0/0         1
bundled-runway              0.3.0     0.3.0        22     6/2/0/0         2
bundled-nano-banana         0.3.0     0.3.0         3     0/0/0/0         1
bundled-humaans             0.2.0     0.1.0 DRIFT  11     9/0/0/0         2
bundled-workday             0.2.0     0.1.0 DRIFT   4     3/0/0/0         1
bundled-quickbooks          0.2.0     0.1.0 DRIFT  13     8/0/0/0         5
bundled-servicenow          0.2.0     0.1.0 DRIFT  10     7/0/0/0         3
bundled-talentlms           0.2.0     0.1.0 DRIFT  24    16/1/0/0         4
```

(`RO/DEST/IDE/OW` = readOnly / destructive / idempotent / openWorld annotation counts. `drift` = number of tools whose name matches `(create|update|delete|remove|send|configure|post|patch|put)_*` but lack `destructiveHint: true`.)

### Class A — `SERVER_VERSION` drift (15 connectors)

Every connector below reports a stale version on `initialize`, mirroring the retell-ai 0.1.2 → 0.1.3 incident:

`bundled-fathom` (0.1.0 vs 0.2.1) · `bundled-icloud-mail` / `bundled-yahoo-mail` / `bundled-custom-email` (all share the email-imap package, 0.1.0 vs 0.2.1) · `bundled-pandadoc` (0.1.0 vs 0.2.0) · `bundled-mixmax` (0.1.0 vs 0.2.0) · `bundled-zendesk` (0.2.0 vs 0.3.0) · `bundled-freshdesk` (0.1.0 vs 0.2.0) · `bundled-elevenlabs` (0.1.0 vs 0.2.0) · `bundled-humaans` (0.1.0 vs 0.2.0) · `bundled-workday` (0.1.0 vs 0.2.0) · `bundled-quickbooks` (0.1.0 vs 0.2.0) · `bundled-servicenow` (0.1.0 vs 0.2.0) · `bundled-talentlms` (0.1.0 vs 0.2.0) · `bundled-browser-automation` (0.1.2 vs 0.1.3 — the *one* otherwise-passing connector)

Same root cause as retell-ai: hand-edited `SERVER_VERSION` constant in `src/types.ts`. Same fix: `createRequire(import.meta.url)` + `require('../package.json').version`.

### Class B — annotation drift (19 connectors)

Tools whose name pattern strongly implies a mutating call but where `destructiveHint` is absent or `false`. This is the same class as VAL-RETELL-007 fixed in retell-ai 0.1.2, except much broader. Concrete tools:

- `bundled-fathom` — `configure_fathom_api_key`
- `bundled-icloud-mail` / `bundled-yahoo-mail` / `bundled-custom-email` — `configure_email_imap`
- `bundled-pandadoc` — `configure_pandadoc_api_key`, `create_document_from_template`, `send_document`
- `bundled-mixmax` — `configure_mixmax_api_key`, `send_mixmax_email`, `send_mixmax_snippet`
- `bundled-zendesk` — `create_zendesk_ticket`
- `bundled-freshdesk` — `configure_freshdesk`, `create_freshdesk_ticket`, `update_freshdesk_ticket`
- `bundled-gamma` — `configure_gamma_api_key`
- `bundled-napkin` — `configure_napkin_api_key`
- `bundled-elevenlabs` — `configure_elevenlabs_api_key`, `create_music_plan`
- `bundled-kling` — `configure_kling_api_keys`
- `bundled-runway` — `configure_runway_api_key`, `create_custom_voice`
- `bundled-nano-banana` — `configure_nano_banana_api_key`
- `bundled-humaans` — `configure_humaans_api_key`, `create_humaans_time_away`
- `bundled-workday` — `configure_workday_credentials`
- `bundled-quickbooks` — `configure_quickbooks`, `create_quickbooks_invoice`, `create_quickbooks_customer`, `create_quickbooks_bill`, `create_quickbooks_vendor`
- `bundled-servicenow` — `configure_servicenow`, `create_servicenow_incident`, `update_servicenow_incident`
- `bundled-talentlms` — `configure_talentlms`, `create_talentlms_user`, `create_talentlms_course`, `create_talentlms_group`

The `configure_*_api_key` family is debatable (it mutates a runtime in-memory variable, not external state) but for safety-pane consistency they should all be marked `destructiveHint: true` like retell-ai's `configure_retell_api_key` was.

### Class C — `openWorldHint` essentially absent (20 of 21)

Only `bundled-browser-automation` sets `openWorldHint` (on 17 of 18 tools). Every other OSS connector reports 0. This is a separate annotation-completeness gap — every connector that calls a remote API should be `openWorldHint: true`. Worth a one-pass sweep alongside the destructive-hint sweep.

### Live API verification (Zendesk)

The only OSS connector with usable creds in the Electron store right now was Zendesk. Probe ran `list_tickets` (read-only) — returned cleanly with the user's real `mindstone-45270` subdomain. **No endpoint-drift bug observed for Zendesk** (unlike retell-ai), but coverage is one tool out of 20, so this is not a clean-bill-of-health for the package — only a sanity that the auth wiring + happy path work.

### Recommended actions (in order)

1. **Cohort `SERVER_VERSION` sweep** — 15 connectors. One-line change per package. Probably 30 minutes of mechanical work.
2. **Cohort destructive-hint sweep** — 19 connectors with concrete tool names listed above. Roughly 50 individual annotation patches. Could be batched as a single PR per connector or one big sweep PR.
3. **Cohort `openWorldHint: true` sweep** on every remote-API tool — Class C above.
4. **Bring up Rebel app** during a future testing session to expose the bridge endpoints, then re-probe Fathom / Humaans / ServiceNow / iCloud Mail (after entering API keys for the first three) so live API tests cover more than just Zendesk.
