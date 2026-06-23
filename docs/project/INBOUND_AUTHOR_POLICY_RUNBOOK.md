---
description: "Operator runbook for Slack inbound author policy: silent-drop gates, structured logs, failure modes, and recovery actions."
last_updated: "2026-05-24"
---

# Inbound Author Policy Runbook

One-line summary: Slack inbound author policy silently drops unauthorized inbound triggers and preserves thread context only from allowed authors.

## See also

- [SAFETY_SYSTEM_OVERVIEW](./SAFETY_SYSTEM_OVERVIEW.md) — safety surfaces and system-level signposting
- [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) — cross-process architecture and service boundaries
- [260523_inbound_author_policy plan](../plans/260523_inbound_author_policy.md) — stage-by-stage design source

## Pipeline diagram

```mermaid
flowchart LR
  A[Slack webhook event] --> B[Stage 0: Parse + sanitize metadata]
  B --> C[Stage 3: Derive principal]
  C --> D1[Stage 5 L1: self-loop guard by metadata agentInstanceId]
  D1 --> D2[Stage 5 L2: self-loop guard by bot_id]
  D2 --> D3[Stage 5 L3: self-loop guard by event.user fallback]
  D3 --> D4[Stage 5 L4: detect other Rebel metadata mismatch]
  D4 --> E1[Stage 3: owner identity guard (ownerOnly)]
  E1 --> E2[Stage 5: per-principal rate limit (10 per 60s, owner exempt)]
  E2 --> F[Stage 3: inboundAuthorGates evaluation]
  F -->|deny| G[Silent drop + recent sender record]
  F -->|allow| H[Stage 2: thread digest prefetch + per-reply author filter]
  H --> I[Conversation route + reply dispatch]
```

## Invariants (Inv-1..Inv-12) and what they guard

| Invariant | Guardrail purpose |
|---|---|
| Inv-1 | Unauthorized inbound triggers are silently dropped by default. |
| Inv-2 | Inbound author admission is isolated from tool-approval safety logic (`inboundAuthorGates/` vs `connectorApprovalGates/`). |
| Inv-3 | Digest filtering happens before slicing, so allowed context is not crowded out by unauthorized replies. |
| Inv-4 | `legacyPermissive` bypasses Stage 3 admission enforcement, preserving legacy trigger behavior during upgrade. |
| Inv-5 | Slack metadata is advisory and untrusted; it never grants authorization on its own. |
| Inv-6 | Authorization is based on signed Slack identity fields (`event.user`, `event.bot_id`) plus policy state. |
| Inv-7 | Owner-only mode without resolved owner identity is explicit (`slack_inbound_dropped_no_owner_identity`) and user-noticed. |
| Inv-8 | Every decision log carries `policyRevision` for drift diagnosis. |
| Inv-9 | Slack-derived labels render as text only (no HTML execution path in Settings UI). |
| Inv-10 | Recent message attempts are cloud-authoritative (no desktop-only source of truth). |
| Inv-11 | Gate evaluator exceptions fail closed (`slack_inbound_gate_evaluator_error`) and do not silently allow inbound traffic. |
| Inv-12 | Settings normalization for `inboundAuthorPolicy` is total; unknown/corrupt shapes are reseeded to safe `legacyPermissive` + review pending. |

Clarifications used in operations:
- Inv-4a: in `legacyPermissive`, Stage 2 digest filtering machinery runs but functions as a no-op (all authors retained).
- Inv-5a: metadata fields (`actingOnBehalfOf`, `ownerUserId`, `threadScope`) are advisory display/context only.
- Mobile users have no Settings UI for this feature; mobile is cloud-continuity, configuration happens on desktop and applies to all surfaces via cloud sync.

## D-decisions (D1-D14) and why they exist

| Decision | Why this exists |
|---|---|
| D1 | Dedicated `inboundAuthorGates/` keeps inbound admission logic independent from tool safety. |
| D2 | `surfaceId` naming keeps policy transport-agnostic beyond Slack. |
| D3 | `surfaceTrusted` naming avoids channel-specific schema debt. |
| D4 | Connector-specific `normalizeAuthorId` avoids accidental cross-connector identity mismatches. |
| D5 | Dedicated `experimental.agentInstanceId` avoids repurposing analytics identity in public metadata. |
| D6 | Single migration contract avoids contradictory seeding behavior on upgrade vs fresh install. |
| D7 | Digest quarantine shipped before webhook gate to land context-injection protection early. |
| D8 | Bot-authored events go through policy evaluation so agent principals are explicit and testable. |
| D9 | Layered self-loop guard protects against missing metadata and legacy payload variance. |
| D10 | Recent attempts are cloud-authoritative so desktop/cloud/mobile triage sees the same facts. |
| D11 | Settings naming/order lock reduces support ambiguity and UX drift. |
| D12 | Per-thread cap deferred; no frozen-thread UX in v1. |
| D13 | Multi-Rebel detection uses `peerInstanceCount` synced from provisioning metadata (no new channel). |
| D14 | 60-day gentle re-prompt nudges users out of long-lived `legacyPermissive` when stranger attempts exist. |
| D15 | `REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1` bypasses policy gating for emergency operator recovery while emitting explicit audit logs. |

## Structured log schema (Inv-8)

### Schema A — `InboundAuthorDecisionLog`

```json
{
  "event": "string",
  "eventId": "string",
  "teamIdHash": "string",
  "principalUserIdHash": "12-char sha256 prefix",
  "principalKind": "human | agent | unknown",
  "surfaceId": "string",
  "decision": "drop | drop_context | drop_self_message | drop_rate_limited | drop_no_owner_identity | drop_no_author_identity | drop_no_bot_mention | drop_metadata_parse_failed | allow",
  "gateId": "string",
  "reason": "string",
  "policyRevision": "string",
  "policySummary": {
    "mode": "ownerOnly | allowlist | legacyPermissive",
    "allowlistSize": "number",
    "blocklistSize": "number",
    "surfaceTrustedSize": "number",
    "agentAllowlistSize": "number"
  }
}
```

Notes:
- `principalUserIdHash` is derived from `sha256(<principalKind>:<normalizedAuthorId>).slice(0,12)`.
- `policySummary` is emitted on every drop-helper path so operators can decode what revision *meant* at the time of the decision without opening the settings file.
- Most drop events in this runbook use Schema A.

### Schema B — `SlackMetadataParseFailureLog`

```json
{
  "event": "slack_metadata_parse_failed",
  "eventId": "string",
  "teamIdHash": "string",
  "principalUserIdHash": "hashed unknown",
  "principalKind": "unknown",
  "surfaceId": "string | unknown",
  "decision": "drop_metadata_parse_failed",
  "gateId": "metadata-parse",
  "reason": "metadata_schema_invalid | metadata_too_large | metadata_non_serializable",
  "policyRevision": "string",
  "policySummary": {
    "mode": "ownerOnly | allowlist | legacyPermissive",
    "allowlistSize": "number",
    "blocklistSize": "number",
    "surfaceTrustedSize": "number",
    "agentAllowlistSize": "number"
  },
  "metadataBytes": "number (optional)",
  "issuePaths": ["path", "path"] 
}
```

### Schema C — `SlackOutboundMetadataFallbackLog`

```json
{
  "intent": "thread_reply | thread_open | dm_reply",
  "eventType": "rebel_thread_reply | rebel_thread_open | rebel_dm_reply",
  "metadataBytes": "number (oversize only)",
  "maxBytes": 1024
}
```

### Schema D — `InboundAuthorPolicyCorruptionLog`

```json
{
  "event": "inbound_author_policy_corrupted_schema_v1 | inbound_author_policy_corrupted_unknown_shape",
  "issues": [
    { "code": "string", "path": "string" }
  ],
  "type": "string (unknown-shape only)",
  "schemaVersion": "number | null (unknown-shape only)"
}
```

## Per-decision log catalog

| Event / decision | Stage + meaning | Payload schema | Typical root causes | Recovery actions | User-visible impact |
|---|---|---|---|---|---|
| `slack_inbound_dropped_author_policy` | Stage 3 deny: stranger/blocked principal was refused | Schema A (`decision: drop`) | `ownerOnly`/`allowlist` deny, blocklist precedence, missing allowlist entry | Inspect `mode`, `allowlist`, `blocklist`, `agentAllowlist`; check Settings → Recent message attempts; allow/block explicitly as needed | Sender gets no Slack reply; trigger appears in Recent message attempts |
| `slack_inbound_gate_evaluator_error` | Stage 3 evaluator threw; webhook failed closed | Schema A (`decision: drop`, `gateId: evaluator_error`) | Runtime exception in gate evaluator, malformed policy/context assumptions | Inspect error message + stack, patch evaluator bug, then replay pending inbound if needed | Trigger is silently dropped; human senders still appear in Recent message attempts |
| `slack_inbound_author_policy_bypassed` | Stage 3 policy bypass active via emergency env flag | Schema A semantics (`decision: allow`, `gateId: policy_bypass`, `reason: REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1`) | Operator-enabled emergency override | Disable bypass once incident stabilizes, review logs for traffic that would have been denied | All policy-denied traffic is admitted while bypass is active |
| `slack_inbound_dropped_self_message_metadata` | Stage 5 layer 1 self-loop drop by metadata ID match | Schema A (`decision: drop_self_message`, `gateId: self_message`, `reason: metadata_agent_instance_id_matches`) | Expected echo of Rebel’s own outbound post | Usually no action; if excessive, verify `experimental.agentInstanceId` uniqueness/sync | Prevents loop storms; no user action required in normal case |
| `slack_inbound_dropped_self_message` | Stage 5 layer 2 self-loop drop by `bot_id` match | Schema A (`decision: drop_self_message`, `reason: bot_id_matches_workspace_bot_user_id`) | Metadata absent but event is from workspace bot | Verify workspace bot identity if unexpected; otherwise expected fallback behavior | Prevents self-echo loop |
| `slack_inbound_dropped_self_message_user` | Stage 5 layer 3 self-loop drop by `event.user` fallback | Schema A (`decision: drop_self_message`, `reason: user_matches_workspace_bot_user_id`) | Slack payload without `bot_id` but synthetic self event via `user` | Verify upstream payload shaping if frequent; fallback path is intentional | Prevents loop on legacy/synthetic payloads |
| `slack_inbound_other_rebel_detected` | Stage 5 layer 4 detects another Rebel instance (non-drop) | Schema A (`decision: allow`, `gateId: self_message`, `reason: metadata_agent_instance_id_mismatch`) | Shared bot identity, metadata `agentInstanceId` differs from local instance | Decide whether peer should be admitted via `agentAllowlist`; review multi-Rebel workspace status | Message may continue if gate allows peer; otherwise denied later by policy |
| `slack_inbound_dropped_rate_limited` | Stage 5 per-principal limiter denied trigger | Schema A (`decision: drop_rate_limited`, `gateId: inbound_rate_limit`, `reason: principal_rate_limited`) | Burst traffic from same principal (>10 in 60s), abuse, accidental loops from external automation | Identify principal key in logs, validate legitimacy, tune limiter constants only if needed | Legitimate bursts can be silently dropped; sender sees no reply |
| `slack_inbound_rate_limiter_evicted` | Stage 5 limiter bucket cap evicted oldest principal bucket | Debug payload (`bucketCount`, `evictedPrincipalKeyHash`) | Sudden bursts with many distinct principals (bucket map reached `maxBuckets`) | Verify event volume pattern; raise `maxBuckets` only if sustained legitimate fan-out warrants it | No direct user impact; diagnostics signal only |
| `slack_inbound_dropped_no_author_identity` | Stage 3 could not derive `user`/`bot_id` principal | Schema A (`decision: drop_no_author_identity`, `gateId: principal_derivation`, `reason: missing_user_and_bot_id`) | Malformed webhook payload, unsupported event shape, upstream proxy stripping fields | Validate inbound payload integrity/signing path; inspect event subtype/source | Trigger dropped silently |
| `slack_inbound_dropped_no_owner_identity` | Stage 3 owner-only mode without resolved owner | Schema A (`decision: drop_no_owner_identity`, `gateId: slack_owner_allowlist`, `reason: owner_identity_missing`) | `experimental.cloudSlackWorkspace.authedUserId` missing/stale after disconnect/reconnect drift | Reconnect Slack from desktop; verify owner ID persisted; confirm notice surfaced | Owner-only effectively blocks human triggers until reconnected; user sees Settings notice |
| `slack_inbound_dropped_no_bot_mention` | Stage 3 mention gate dropped a non-DM message without @mentioning Rebel | Schema A (`decision: drop_no_bot_mention`, `gateId: mention_gate`) + `channelType` | User posted in channel/MPIM without explicitly tagging Rebel | Ask sender to @mention Rebel (or DM). If behavior changed unexpectedly, inspect mention-parser path/tests. | Message is ignored silently |
| `slack_metadata_parse_failed` | Stage 0 metadata malformed/oversized/non-serializable; metadata treated as absent | Schema B (now emitted via shared drop helper) | Outbound metadata schema mismatch, oversized metadata blob, corrupted payload | Check paired outbound logs (`slack_outbound_metadata_*`), keep payload ≤1KB, validate schema | Message still processes, but self-loop/peer-routing hints may be lost |
| `slack_outbound_metadata_oversize` | Stage 4 outbound metadata too large; post sent without metadata | Schema C (`metadataBytes`, `maxBytes`) | Oversized `threadScope` or future payload expansion | Reduce metadata payload size, keep advisory fields minimal | Inbound metadata-dependent protections degrade for that message |
| `slack_outbound_metadata_missing_agent_instance_id` | Stage 4 outbound metadata disabled due missing instance ID | Schema C | `experimental.agentInstanceId` absent/blank before send | Verify settings normalization seeded ID; check desktop→cloud settings sync | Post succeeds, but metadata-based self-loop layer is unavailable |
| `slack_digest_predicate_error` | Stage 2 predicate threw for one reply; fail-closed exclusion | Schema A semantics (`gateId: digest-author-predicate`, `reason: predicate_error`) | Unexpected author shape or predicate runtime error in digest pass | Inspect digest filter path and reply author data; verify fallback exclusion not broad | Only affected reply is excluded from context; conversation still routes |
| `inbound_author_policy_corrupted_schema_v1` | Stage 0 schema-v1 refine failed; policy reseeded to safe fallback | Schema D | Partial settings write, manual settings corruption, migration drift | Inspect `issues[]`, verify settings writer path, have user review policy on next desktop open | Policy reseeds to `legacyPermissive` + review pending; user sees upgrade review prompt |
| `inbound_author_policy_corrupted_unknown_shape` | Stage 0 normalization saw unknown/non-object/unsupported policy shape; policy reseeded to safe fallback | Schema D | Persisted `{}` shape, unsupported schema version, non-object values | Inspect `type` + `schemaVersion`, audit settings writers, then have user review policy in Settings | Policy reseeds to `legacyPermissive` + review pending |
| `inbound_author_policy_backup_persisted` | Stage 0 corruption recovery saved a local forensic snapshot before reseeding | Payload includes `branch`, `type`, `schemaVersion` | Corrupt schema-v1 refine failure or unknown-shape fallback branch fired | Use `experimental.inboundAuthorPolicyBackup` to recover tuned values manually, then clean the writer path that created corruption | No immediate user impact; enables post-incident recovery |
| `drop_context` (decision value) | Stage 2 per-reply digest filter excluded one reply | Schema A (`event` usually `slack_inbound_dropped_author_policy`, `decision: drop_context`) | Reply author denied by owner/allowlist policy or predicate fail-closed branch | Review filtered principal hashes and policy mode; use Recent message attempts + policy panel to adjust | “Context filtered” indicator may appear; trigger still processed |

## Failure mode matrix (copied from plan §10)

| Component | Scenario | Impact | Detection | Mitigation |
|---|---|---|---|---|
| Webhook principal gate | `bot_id` event dropped before evaluator | Agent path never exercised | Missing `kind: 'agent'` coverage in tests | Stage 3 routing split removes unconditional drop |
| Owner-only mode | `authedUserId` missing | Legit owner messages dropped opaquely | `slack_inbound_dropped_no_owner_identity` | Reconnect notice + explicit logging |
| Digest filter | Predicate throws on one reply | Entire digest lost in v1-style behavior | `slack_digest_predicate_error` | Per-reply catch; continue with remaining replies |
| Digest order | Slice before filter | Allowed context can be crowded out | Deterministic unit tests | Locked filter-before-slice logic |
| Metadata parser | Oversized/malformed payload | Parser crash or unsafe logs | `slack_metadata_parse_failed` | Strict parse bounds + treat as absent |
| Self-loop guard | Metadata absent | Self-loop not detected via primary path | Self-loop fallback metrics | `bot_id` and legacy `event.user` fallbacks |
| Recent attempts store | Repeat attempts append duplicates | Noisy/low-signal list | Store dedupe tests | Principal-key upsert semantics |
| UI rendering | Hostile Slack display names | Potential XSS/confusable confusion | Hostile-string render tests | React text-node-only invariant |
| Migration | Partial write of policy/notice | Inconsistent policy state | schemaVersion mismatch checks | Single atomic settings update |
| Webhook evaluator | Gate evaluator throws | Legit inbound traffic can be dropped | `slack_inbound_gate_evaluator_error` | Fail-closed drop + alert operator; patch evaluator and replay if needed |
| Migration | Corrupt policy unknown shape (`{}`, unsupported version, non-object) | Policy could drift without correction | `inbound_author_policy_corrupted_unknown_shape` | Total normalization fallback to `legacyPermissive` + review pending |
| Emergency operations | Bypass mode active | Policy-denied traffic is admitted | `slack_inbound_author_policy_bypassed` | Use only for incidents; disable ASAP and audit post-incident |
| Cross-surface | Stale policy diagnostics | Hard to explain drops | Missing revision context in logs | `policyRevision` stamped on mutations + drops |

## Common operational scenarios

### 1) Owner identity is missing

1. Check desktop settings state: `experimental.cloudSlackWorkspace.authedUserId`.
2. Confirm `slack_inbound_dropped_no_owner_identity` events are present.
3. Reconnect Slack from desktop.
4. Re-test owner DM inbound trigger.

### 2) Stranger triggered Rebel

1. Confirm `slack_inbound_dropped_author_policy`.
2. Open **Settings → Continuity & Messaging → Messaging → Recent message attempts**.
3. Review sender and policy mode (`ownerOnly` vs `allowlist`).
4. Apply `Allow this ID` or `Block this ID` per policy intent.

### 3) Rate-limit is dropping legitimate traffic

1. Confirm `slack_inbound_dropped_rate_limited`.
2. Identify affected principal key/hash and traffic pattern.
3. Validate whether burst is expected or abusive.
4. If expected, raise limiter settings (currently in-memory hardcoded 10 per 60s).

### 4) Multi-Rebel detected

1. Confirm `slack_inbound_other_rebel_detected`.
2. Decide whether the peer should be admitted via `agentAllowlist`.
3. Verify workspace `peerInstanceCount` and Settings multi-Rebel notice state.

### 5) Metadata round-trip is broken (outbound stamping disabled)

1. Check for `slack_outbound_metadata_missing_agent_instance_id` and `slack_outbound_metadata_oversize`.
2. Verify `experimental.agentInstanceId` exists and is synced to cloud runtime.
3. Re-test outbound post and confirm no `slack_metadata_parse_failed` on inbound echo.

### 6) Schema corruption was detected

1. Confirm `inbound_author_policy_corrupted_schema_v1` or `inbound_author_policy_corrupted_unknown_shape`.
2. Inspect `issues[]` payload in logs for missing/invalid fields.
3. Verify policy reseeded to `legacyPermissive` and `upgradeReviewPending: true`.
4. Ask user to complete the one-time policy review from Settings on next desktop open.

### 7) Corrupt policy recovery needs the old tuned lists

1. Confirm `inbound_author_policy_backup_persisted` fired for the same incident window.
2. Open the local settings file (`~/Library/Application Support/<app>/app-settings.json`) and inspect `experimental.inboundAuthorPolicyBackup`.
3. Copy needed values (allowlist/blocklist/surfaceTrusted/agentAllowlist) from the backup into `experimental.inboundAuthorPolicy`.
4. Keep the backup value intact until validation is complete, then clean up only after policy behavior is confirmed.

### 8) Bypass was left on accidentally

1. Check **Settings → Continuity & Messaging → Messaging** for the warning banner (“Inbound author policy is currently bypassed…”).
2. Confirm logs include `slack_inbound_author_policy_bypassed`.
3. Remove `REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1` from the cloud environment and restart/redeploy cloud-service.
4. Verify the banner clears and policy-deny logs (`slack_inbound_dropped_author_policy`) resume for blocked strangers.

## Emergency override

Set `REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1` to bypass inbound author policy admission checks temporarily.

- Scope: bypasses policy-mode admission (`ownerOnly` / `allowlist`) while keeping signature validation, self-loop guards, and rate limiting active.
- Observability: every bypassed inbound event emits `slack_inbound_author_policy_bypassed`.
- Exit criteria: disable the flag as soon as the incident is mitigated, then review bypass-period logs for traffic that would normally be denied.

## Forward-compat notes (Rebel-to-Rebel foundation)

The current rollout deliberately lays the foundation for future Rebel-to-Rebel routing:

1. Stage 4 metadata stamping (`agentInstanceId`) provides stable sender identity in Slack payload metadata.
2. Stage 5 layer 4 (`slack_inbound_other_rebel_detected`) distinguishes peer Rebel messages from self-loop echoes.
3. Stage 3 gate path supports explicit peer admission via `agentAllowlist`.

## Known limitations (v1)

1. Rate limiter is in-memory only (state resets on cloud restart).
2. `peerInstanceCount` depends on managed provisioner write-path updates (separate workstream).
3. Bundled MCP Slack user-token tools are intentionally out of scope for inbound author policy enforcement.
4. Cross-cluster rate-limit coordination is not implemented (assumes single cloud instance).
5. Bypass mode is observable but unaudited — while `REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1` is active, anything that policy would have denied is allowed; review logs post-incident.
6. Agent allowlist entries match metadata-stamped `agentInstanceId`; any actor able to forge Slack message metadata could impersonate an allowlisted agent. Use sparingly; prefer `ownerOnly` + explicit human allowlist when possible.
