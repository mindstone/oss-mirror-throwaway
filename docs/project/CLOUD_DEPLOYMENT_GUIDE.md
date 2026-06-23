---
description: "Cloud delta-sync deployment guide — staging preflight, rollout verification, stuck outbox diagnosis, manual re-enqueue"
last_updated: "2026-05-10"
---

# Cloud Deployment Guide

Delta sync deployment gates live here. General deployment mechanics are in [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md).

## Delta sync pre-deploy preflight

Run this against staging before flipping the production delta-push capability flag:

```bash
STAGING_CLOUD_URL=https://<staging-cloud> \
STAGING_CLOUD_TOKEN=<token> \
STAGING_DELTA_SYNC_SESSION_ID=<oversized-session-id> \
npm run preflight-delta-sync-staging
```

Manual prerequisite: seed `STAGING_DELTA_SYNC_SESSION_ID` on staging with an already-synced oversized session representative of the `8f0b7c32` class (roughly 25MB before delta). The script is idempotent: it only reads the lean event cursor and sends a metadata-only delta POST.

The gate is green only when:

- `X-Rebel-Capabilities` advertises `session-event-delta-push`.
- Lean `GET /api/sessions/:id/events?sinceSeq=0&limit=1` succeeds.
- The preflight cursor is seeded from cloud `serverSeq`.
- The first delta `POST /api/sessions/:id/events` succeeds with a payload under 5MB.

Use `--json` for CI-readable output.

## Delta sync rollout verification

After deploy, run this on a desktop with cloud sync enabled:

```bash
CLOUD_URL=https://<cloud-service> \
CLOUD_TOKEN=<token> \
npm run verify-delta-sync-rollout
```

For fixture or support runs, pass the outbox explicitly:

```bash
npm run verify-delta-sync-rollout -- --outbox ./tmp/cloud-outbox.json --json
```

The report lists each outbox session's status, attempts, cursor, last drain attempt, last response code, and cloud `serverSeq`. It flags:

- `pending`/`failed` entries with `attempts > 3` as stuck candidates. These should normally auto-recover on the next drain after deploy via F3 cursor seeding plus F29 create-then-append.
- `permanent_failure` entries caused by `413` / `BODY_TOO_LARGE` as manual re-enqueue candidates.

Manual re-enqueue procedure: use the existing outbox admin path to clear the `permanent_failure` flag for the affected session, then trigger the next drain. The new code re-evaluates the entry; if one event still exceeds the compressed per-event limit, the F23 per-event policy splits or skips the offender instead of forcing a full PUT.

Known rollout canary: session `8f0b7c32` is currently `pending` with `attempts=6` and a 502 error. Expected post-deploy behaviour is automatic recovery: the next drain runs F3 + F28 lean pull preflight, seeds the cursor from cloud `maxSeq`, seeds `lastPushedMessageIds` per F27, then uses F29 delta append for local post-cursor events. If it does not recover, use the manual re-enqueue procedure above.
