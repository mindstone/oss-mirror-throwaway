---
description: "Operator runbook for registering, deploying, and smoke-testing Slack cloud thread delivery"
last_updated: "2026-05-03"
---

# Slack Cloud Deployment

This runbook is for operators standing up Slack thread delivery on `cloud-service`. For the system architecture, see [CLOUD_ARCHITECTURE](./CLOUD_ARCHITECTURE.md) and the implementation plan in [`docs/plans/260503_slack_cloud_webhook_polish.md`](../plans/260503_slack_cloud_webhook_polish.md).

## Prerequisites

- A Slack app:
  - **Managed mode:** Mindstone-owned Slack-app `client_id` + `client_secret` in managed cloud env vars.
  - **BYOK mode:** user-owned Slack app credentials stored through the BYOK setup flow.
- A Slack signing secret:
  - **Managed mode:** `SLACK_SIGNING_SECRET` in the cloud environment.
  - **BYOK mode:** signing secret stored with the user-owned Slack app connection.
- `CLOUD_BASE_URL` reachable by Slack over public HTTPS. Slack will not call plain HTTP callback/event URLs.

## Slack-app registration

Register or edit the Slack app in the Slack Developer Console:

<https://api.slack.com/apps>

Configure these URLs with the deployed cloud base URL:

- **Redirect URI:** `<CLOUD_BASE_URL>/api/integrations/slack/oauth/callback`
- **Event subscription URL:** `<CLOUD_BASE_URL>/api/integrations/slack/events`

Required event subscriptions:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`
- `tokens_revoked`

Bot scopes, verbatim from `src/shared/utils/slackOAuthScopes.ts`:

```text
channels:history
channels:read
chat:write
files:read
groups:history
groups:read
im:history
im:read
mpim:history
mpim:read
reactions:read
reactions:write
users:read
```

User scopes, verbatim from `src/shared/utils/slackOAuthScopes.ts`:

```text
search:read
channels:history
channels:read
channels:write
channels:write.invites
files:read
groups:read
groups:history
groups:write
groups:write.invites
im:read
im:history
im:write
mpim:read
mpim:history
mpim:write
users:read
users:read.email
chat:write
reactions:write
reminders:write
bookmarks:write
```

## Cloud env-var matrix

| Env var | Required for | Description |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Managed mode (optional with BYOK) | Verifies inbound HMAC. |
| `SLACK_CLIENT_ID` | Managed OAuth | Public Slack-app client ID. |
| `SLACK_CLIENT_SECRET` | Managed OAuth | Slack-app client secret. Keep this in cloud env only. |
| `CLOUD_BASE_URL` | Always | Public HTTPS base for OAuth callbacks and Slack events. |
| `REBEL_DISABLE_CLOUD_WEBHOOK_ADAPTERS` | Override | Set to disable cloud webhook delivery globally. |

## Smoke test

1. Deploy `cloud-service`.
2. Set the Slack env vars from the matrix above.
3. Restart the cloud service so env changes are loaded.
4. Complete OAuth from a desktop dev build.
5. Fire a test mention in Slack; observe `slack_webhook_received` followed by `slack_delivery_completed` with `outcome=success` in logs.

Before real Slack traffic, run the local signed-payload smoke:

```bash
npx tsx scripts/slack-cloud-smoke.ts --self-test
```

For a deployed target with a local log file available:

```bash
npx tsx scripts/slack-cloud-smoke.ts \
  --target-url "$CLOUD_BASE_URL/api/integrations/slack/events" \
  --signing-secret-env SLACK_SIGNING_SECRET \
  --log-file /data/logs/cloud-service.log
```

The script posts a deterministic signed Slack payload, requires a 200 ack within 2 seconds, checks for `slack_webhook_received`, and redacts credential-shaped values before printing failures. Do not inspect token files manually.

This script signs and POSTs to whatever URL you give it. Only point it at local or staging targets unless you're certain the signing secret matches that environment — production webhooks reject `team_id: T_SMOKE` with 200 ack-and-drop, but we still don't want noise in real logs.

## Log grep recipes

Examples assume JSON-ish log lines; adjust quoting for the active log sink.

- **Health / steady state**
  ```bash
  grep slack_webhook_received /data/logs/cloud-service.log
  ```
- **Signature failures**
  ```bash
  grep slack_signature_failure /data/logs/cloud-service.log
  ```
- **Permanent delivery failures**
  ```bash
  grep slack_delivery_failed_permanent /data/logs/cloud-service.log
  ```
- **Rate limiting**
  ```bash
  grep slack_webhook_rate_limited /data/logs/cloud-service.log
  ```
- **Delivery success rate**
  ```bash
  grep -c slack_delivery_completed /data/logs/cloud-service.log
  grep slack_delivery_completed /data/logs/cloud-service.log | grep -c 'outcome[=:]"success"\|outcome=success'
  ```

`teamIdHash` is the first 12 hex characters of the SHA-256 hash of the Slack team ID:

```bash
printf '%s' "$TEAM_ID" | shasum -a 256 | cut -c1-12
```

Use this to correlate operator-known workspace IDs with logs without emitting raw team IDs.

## Common failure modes

| Log line / signal | Likely cause | Operator action |
|---|---|---|
| `slack_signature_failure` with `SIGNATURE_MISMATCH` | Wrong signing secret, wrong app, body modified by proxy, or stale BYOK credential. | Confirm Slack app signing secret, proxy body passthrough, and BYOK stored secret. Restart after env changes. |
| `slack_signature_failure` with `REPLAY` | Slack retried an event already processed. | Usually no action; repeated bursts mean a proxy or Slack retry loop is replaying old requests. |
| `slack_webhook_dropped_secret_unavailable` | No signing secret available for the workspace mode. | Set `SLACK_SIGNING_SECRET` for managed mode or reconnect BYOK with a signing secret. Restart managed cloud. |
| `slack_webhook_dropped_disabled` | User disabled cloud Slack delivery. | No action unless unexpected; ask the user to enable Slack cloud delivery in Settings. |
| `slack_webhook_dropped_not_connected` or `workspace_needs_reconnect` | Slack workspace missing, disconnected, or token revoked. | Ask user to reconnect Slack. Check for `tokens_revoked` events. |
| `slack_webhook_dropped_team_mismatch` | Event came from a Slack team different from the connected workspace. | Check Slack app installation and whether the user reconnected the wrong workspace. |
| `slack_webhook_rate_limited` | IP or team event volume exceeded the route limits. | Confirm whether traffic is legitimate. If hostile, block upstream at the provider/WAF. If legitimate, review limit settings before increasing. |
| `slack_delivery_failed_permanent` with `workspace_not_connected`, `token_revoked`, `tokens_revoked`, or `account_inactive` | Bot token is unusable. | Reconnect Slack; for managed users, verify the managed Slack app remains installed. |
| `slack_delivery_failed_permanent` with `channel_not_found` | Bot cannot see the target channel/thread. | Add Rebel to the channel or reconnect with correct channel permissions. |
| `slack_webhook_async_error` | Ack succeeded but async handoff failed. | Inspect adjacent error metadata, check `pendingInbound` replay on restart, and escalate if replay does not clear. |
| Settings card shows "Slack relay temporarily offline" | Managed central proxy health beacon missed 3 cycles. | Follow the central-proxy outage playbook below. |
| Startup warning about disk encryption | BYOK host is not Fly and encrypted volume is not confirmed. | Enable cloud disk encryption before storing Slack credentials. |
| `/oauth/start` returns 429 | Too many OAuth states in flight. | Wait for TTL expiry or clear stuck OAuth attempts after confirming no active user flow. |
| Cloud refuses to start because token file mode is permissive | Slack token store permissions are broader than `0600`. | Fix file mode/ownership; do not weaken the fail-closed check. |

## Central-proxy outage playbook (managed users)

Managed Slack users rely on the Mindstone central proxy before events reach the user's cloud. The proxy emits a health beacon to the user's cloud every 60 seconds; after 3 missed beacons, the settings card should show "Slack relay temporarily offline".

Operator steps:

1. Check central-proxy health and recent deploys.
2. Confirm the user's cloud is reachable from the proxy.
3. If the proxy is down, restore or roll back the proxy first. User clouds should keep existing pending-delivery records.
4. If one user is blocked and the proxy is healthy, verify their `CLOUD_BASE_URL` and Slack workspace binding.
5. Temporary workaround: user can switch to BYOK and reconnect Slack directly to their cloud.

## Disk encryption assumptions

- **Fly:** persistent volumes are treated as provider-encrypted for this deployment model.
- **DigitalOcean / Hetzner / other BYOK hosts:** the user/operator must enable encrypted volumes or equivalent host-level disk encryption before storing Slack credentials.

If encryption cannot be confirmed, log the warning and avoid treating the deployment as production-ready for BYOK Slack.

## `SLACK_SIGNING_SECRET` rotation

1. Rotate the signing secret in the Slack Developer Console.
2. Update `SLACK_SIGNING_SECRET` in the managed cloud environment.
3. Restart the cloud service.
4. Send a test Slack mention and verify `slack_webhook_received`.

Pending-delivery records survive this procedure; do not delete the pending-delivery store. Rotation changes verification of new inbound events, not already queued outbound replies.

## `CLOUD_BASE_URL` changes

- **Managed users:** update the managed proxy routing and Slack app URLs. The proxy absorbs the public URL change for users.
- **BYOK users:** update the Slack app Redirect URI and Event subscription URL, then have the user reconnect Slack. Existing BYOK OAuth state and callback URLs are bound to the old base URL.

After changing `CLOUD_BASE_URL`, restart the cloud service and run the smoke test.

## Thread-history limit

The `slack_get_thread_history` tool reads at most 50 Slack messages from a thread. This keeps latency and Slack API usage bounded. For longer threads, Rebel sees the most relevant recent window, not an infinite transcript. The bureaucracy is finite. For once.

## Credential leak procedure

If the Mindstone Slack-app client secret leaks:

1. Rotate the Mindstone Slack-app client secret immediately in Slack.
2. Update `SLACK_CLIENT_SECRET` in managed cloud environments.
3. Restart managed cloud/proxy services.
4. Treat all managed Slack connections as requiring reconnect; managed users must reconnect Slack so tokens are bound through the rotated app credentials.
5. Audit logs for token-shaped values; redaction should remove `xox*`, `client_secret`, OAuth codes, and Slack signatures before they leave process boundaries.

BYOK credential leaks are handled per user-owned Slack app: rotate that user's Slack app secret/signing secret and reconnect their workspace.
