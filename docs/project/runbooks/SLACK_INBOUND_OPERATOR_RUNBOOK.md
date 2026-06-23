---
description: "Operator runbook for Slack inbound and Messaging tab — log lines, diagnostics, mitigations, replay, dedup, thread continuity"
last_updated: "2026-05-23"
---

# Slack Inbound / Messaging Tab — Operator Runbook

Operator guidance for the Slack inbound listening system shipped in
`docs/plans/260523_messaging_tab_and_slack_listening_polish.md`.

---

## Log line quick reference

| Log line | Fields | Purpose |
|----------|--------|---------|
| `slack_webhook_received` (extended) | `eventId`, `teamIdHash`, `eventType`, `channelType` | Correlate every inbound event |
| `slack_webhook_dispatched` (extended) | `eventId`, `teamIdHash`, `conversationId`, `isNewConversation`, `processMs` | Per-event lifecycle close |
| `slack_webhook_async_error` (extended) | `eventId`, `teamIdHash`, `error`, `phase` | Errors |
| `slack_inbound_dropped_no_bot_mention` | `eventId`, `teamIdHash`, `channelType` | G4a drop counter |
| `slack_webhook_dedup_skip` | `eventId`, `teamIdHash`, `reason` (`in-progress` / `deferred` / `processed`) | G4b durable-claim counter |
| `slack_webhook_inflight_dedup_joined` | `eventId`, `teamIdHash`, `waitMs` | G4b in-flight dedup observability |
| `slack_broadcast_deferred_no_consumer` | `eventId`, `teamIdHash`, `conversationId`, `isNewConversation`, `durationMs` | Replay-resumable delivery deferral |
| `slack_replay_payload_hash_mismatch` | `eventId`, `teamIdHash` | Durable replay integrity/tamper guard |
| `slack_replay_payload_parse_failed` | `eventId`, `teamIdHash`, `error` | Replay payload could not be parsed; entry is dropped+processed |
| `slack_replay_potential_duplicate` | `eventId`, `teamIdHash` | Replay duplicate-risk breadcrumb |
| `slack_replay_tick_failed` | `err` | Periodic replay scheduler tick failed |
| `slack_listener_auto_stopped_on_connector_disconnect` | `teamIdHash`, `source` (`connector-removed`) | F22 connector-disconnect listener cleanup success |
| `slack_listener_auto_stop_on_connector_disconnect_failed` | `teamIdHash`, `source`, `reason` or `err` | F22 cleanup failure/degraded path |
| `slack_thread_history_unavailable` | `eventId`, `teamIdHash`, `reason` (`401` / `403` / `missing` / `token_revoked` / `5xx` / `timeout` / `malformed` / `network` / `unknown`) | G4c skip counter |
| `slack_thread_history_rate_limited` | `eventId`, `teamIdHash`, `retryAfter` | G4c 429 counter |
| `slack_thread_history_fetched` | `eventId`, `teamIdHash`, `replyCount`, `fetchMs` | G4c success |
| `slack_desktop_thread_binding_probe` | `eventId`, `teamIdHash`, `outcome` (`existing` / `created-new` / `fallback-legacy`) | G5 |
| `slack_thread_identity_extraction_failed` | `eventId`, `teamIdHash` | Slack thread identity projection failed; inbound event dropped/fallback |
| `slack_polling_legacy_session_observed` | `sessionId`, `teamIdHash` | Population sizing for legacy session migration |

---

## Entry 1: Workspace stuck in `needs_reconnect` for >7 days

**Trigger / log search:** `slack_workspace_status_changed status="needs_reconnect"`

**Diagnostic steps:**
1. Identify affected `teamIdHash` from the log event.
2. Confirm whether the workspace is still active in Slack (the app may have been uninstalled or permissions revoked).
3. Check `slack_webhook_dedup_skip` rate — if many `processed` skips, the listener is receiving events for a workspace that should have been disconnected.
4. Verify the cloud-service `tokens_revoked` handler fired correctly (search `tokens_revoked` for the same `teamIdHash`).

**Mitigation:**
- Contact the user; confirm whether they still intend to use Slack with Rebel.
- If not: guide them to **Settings → Continuity & Messaging → Messaging** → disconnect.
- If yes: ask them to re-authenticate — the listener status will flip back to connected once OAuth completes.
- If the workspace is genuinely gone, a workspace mismatch state (S8) will also appear in the Messaging panel.

---

## Entry 2: G4c misbehaving (thread history pre-fetch)

**Trigger / log search:** `slack_thread_history_rate_limited` or `slack_thread_history_unavailable` with elevated rate

**Diagnostic steps:**
1. Check `slack_thread_history_unavailable` breakdown by `reason`:
   - `401` / `403` / `token_revoked` → token issue, not a G4c bug.
   - `5xx` / `timeout` → Slack API flapping; check `slack_thread_history_fetched` success rate alongside.
   - `malformed` / `network` / `unknown` → investigate transport/parsing issues or the Slack API base URL seam (`SLACK_API_BASE_URL` env var).
2. Check `slack_thread_history_rate_limited` separately for Slack throttling pressure (`retryAfter` field).
3. Confirm the flag is still enabled for the user: `experimental.slackInboundThreadHistory = true` in persisted user settings.
4. Check `slack_thread_history_fetched` for `replyCount: 0` — this fires even on empty digest; if most events are zero-count, the thread may genuinely be single-message.

**Mitigation:**
- Per-user disable: set `experimental.slackInboundThreadHistory = false` directly in persisted settings data (`settings.json` / settings store record; there is no in-app toggle in Messaging). Pre-fetch stops; Rebel replies with just the current mention text.
- Fleet-wide kill: if the issue is structural (not per-user), a cloud-service env var override can be added in a follow-up plan (not shipped in v1).

---

## Entry 3: G5 misbehaving (desktop thread continuity)

**Trigger / log search:** `slack_desktop_thread_binding_probe outcome=fallback-legacy` with elevated rate

**Diagnostic steps:**
1. Confirm `experimental.slackDesktopThreadContinuity = true` for the user.
2. Check `slack_polling_legacy_session_observed` — if this counter is growing rapidly, the polling adapter is hitting existing legacy sessions instead of binding to new `slack-thread` conversations. This is expected for existing sessions but not for new ones.
3. Look at `slack_thread_identity_extraction_failed` — if non-zero, the desktop polling adapter is failing to project a `SlackThreadIdentity` from the search event, falling back to legacy mint.
4. Check `slack_inbound_dropped_no_bot_mention` for the desktop polling path — this fires on the cloud webhook side, not desktop, so less relevant here.

**Mitigation:**
- Per-user disable: set `experimental.slackDesktopThreadContinuity = false` directly in persisted settings data (`settings.json` / settings store record; there is no in-app toggle in Messaging). Desktop polling reverts to the legacy `slack-mention-poll` session-mint path.
- Fleet-wide kill: not shipped in v1; a follow-up plan can add the env var override if needed.

---

## Entry 4: Replay backlog (pending inbound log not draining)

**Trigger / log search:** elevated `slack_broadcast_deferred_no_consumer`, rising `slack_webhook_dedup_skip reason=deferred`, or replay errors (`slack_replay_payload_hash_mismatch`, `slack_replay_tick_failed`)

**Diagnostic steps:**
1. Confirm the cloud-service is running and that the periodic replay scheduler is healthy (no repeated `slack_replay_tick_failed`).
2. Check `slack_replay_potential_duplicate` and `slack_replay_payload_hash_mismatch` — these indicate replay duplicate-risk or payload integrity guard trips.
3. Confirm the consumer (cloud push to desktop or the external conversation service) is reachable. If no consumer is connected, events accumulate in `broadcast-deferred` state — this is expected behavior, not a bug.
4. Check `slack_webhook_dedup_skip reason=deferred` trends — sustained growth indicates replay is not draining deferred entries.

**Mitigation:**
- Wait for periodic replay: scheduler re-drives replay every 60s with bounded concurrency (cap 5), so deferred entries should drain once a consumer is available.
- If scheduler is failing (`slack_replay_tick_failed`) or queue growth is unbounded, restart cloud-service to reset in-memory replay state and force immediate startup replay.
- If the backlog is large and replay is slow: the bounded concurrency is intentional to avoid Slack API rate limits; let it drain naturally.
- If restart does not drain: check `slack_pending_inbound_log` file state on disk for corruption or a stuck write lock.

---

## Entry 5: In-flight Map growth

**Trigger / log search:** cloud-service memory pressure; `slack_webhook_inflight_dedup_joined waitMs` with rising average (indicates contention on a single event_id)

**Diagnostic steps:**
1. Confirm the 60s TTL sweep is running: search for `slack_webhook_inflight_dedup_joined` log lines and check that `waitMs` values are low (< 100ms) for the majority of entries.
2. If `waitMs` is high for many entries, the sweep may not be keeping pace with inbound event volume. Check cloud-service process uptime — a recent restart would reset the map.
3. Check `slack_webhook_dedup_skip reason=in-progress` — high in-progress count with no corresponding `releaseAfterSuccess` suggests the TTL is working but events are arriving faster than 10min window clears them.

**Mitigation:**
- Restart cloud-service (resets the in-memory Map and the 60s sweep timer).
- If observed leak persists: increase sweep frequency or instrument `slack_webhook_inflight_map_size` as a recurring log metric. A follow-up plan can add explicit size logging to the sweep loop.
- The in-memory Map is an optimisation only; correctness still lives in the durable `slackPendingInboundLog` claim state. Events are not lost if the Map grows.

---

## Feature flag inventory

| Flag | Default | Location | Disable when |
|------|---------|----------|--------------|
| `experimental.slackInboundThreadHistory` | `true` | Persisted user settings (`settings.json` / settings store record; no Messaging UI toggle) | Rate limits or thread-history context-injection issues |
| `experimental.slackDesktopThreadContinuity` | `true` | Persisted user settings (`settings.json` / settings store record; no Messaging UI toggle) | Desktop thread continuity bugs requiring legacy mint path |
