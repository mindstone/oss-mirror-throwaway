---
description: "Why mobile uses QR pairing instead of OAuth email sign-in, the BYOK trust model, and the recommended path to email-based mobile sign-in"
last_updated: "2026-04-20"
---

# Mobile Pairing and Auth: Design Decision

This document captures **why the mobile app pairs via QR code instead of using OAuth email sign-in**, the constraints that drive that choice, and the recommended path if we want to add email-based mobile sign-in in the future.

This is a decision / intent doc. Read it before proposing changes to the mobile pairing flow, the cloud bearer-token model, or the `rebel.mindstone.com` backend's relationship to user instances.

## See also

- [MOBILE_OVERVIEW.md](MOBILE_OVERVIEW.md) -- Mobile architecture, pairing code flow, known limitations
- [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) -- Per-user cloud instances, bearer token model, managed vs BYOK
- [AUTHENTICATION.md](AUTHENTICATION.md) -- Desktop OAuth (Google/Microsoft) against `rebel.mindstone.com`
- Code entry points:
  - `mobile/src/screens/PairScreen.tsx` -- QR scan + manual entry
  - `src/renderer/features/settings/components/tabs/CloudTab.tsx` -- Desktop side of pair code display
  - `private/mindstone/src/services/authService.ts` -- Desktop OAuth (identity only, not instance access)
  - `src/main/ipc/cloudHandlers.ts` -- Managed-cloud provisioning via `rebel.mindstone.com`

## The question

Why does the mobile app require scanning a QR code from desktop Settings instead of just letting the user sign in with the same email they used on desktop, and auto-pulling their chats?

## TL;DR

The QR code is not a login step. It is a **device-to-instance pairing** step. Rebel's cloud is not a multi-tenant shared backend; each user has their own isolated cloud instance (or none at all). OAuth identity alone is insufficient because:

1. **No central chat store exists to pull from.** Chats live on the user's own cloud volume or locally on desktop. `rebel.mindstone.com` has no copy.
2. **BYOK instances are unknown to Mindstone by design.** The QR code is how the mobile app learns the cloud URL and bearer token for those instances.
3. **The cloud bearer token is static and unscoped.** There is no per-device token registry that OAuth could look up.

The QR flow is load-bearing given the architecture. We should keep it. We can still **add** email-based sign-in for managed-cloud users — but only after adding per-device tokens (see Recommended path below).

## Architectural constraints

### 1. Each user has their own cloud instance

Per [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md): every user's cloud is a single Fly Machine (or DigitalOcean/Hetzner instance) with their own persistent volume at `/data`. Sessions, workspace, memory, and settings live only on that machine. There is no shared Rebel chat database.

### 2. Cloud auth is a static bearer token, not an identity

`REBEL_CLOUD_TOKEN` is a single shared secret baked into the instance at provisioning time. Desktop and mobile hold the same token. Known limitation (per `CLOUD_ARCHITECTURE.md`): *"No rotation, expiry, or revocation. Token compromise = full access."*

### 3. Desktop OAuth goes to a different surface than the user's chats

`private/mindstone/src/services/authService.ts` authenticates against `rebel.mindstone.com`. That login gates **entitlement** (managed-cloud provisioning, license tier, analytics identity) -- not access to the user's chats. The chats are on their Fly (or BYOK) instance, which `rebel.mindstone.com` does not proxy.

### 4. Two provisioning modes with different trust models

- **Mindstone-managed**: `rebel.mindstone.com` provisions the Fly instance for the logged-in user and knows `{cloudUrl, token}`. Endpoints: `/api/cloud/managed/*`.
- **BYOK (Fly / DigitalOcean / Hetzner)**: user provides their own cloud credentials; Mindstone never holds the instance token. Code: `src/core/services/cloud/providers/*`.

### 5. Sessions default to `local_only`

Per [MOBILE_OVERVIEW.md known limitations](MOBILE_OVERVIEW.md#known-limitations): *"Sessions default to `local_only` -- must be explicitly promoted to `cloud_active` for mobile/web visibility."* Even after a successful login, most of the user's chats may physically not be on any cloud instance.

### 6. Mobile is a companion, not standalone

Mobile requires desktop + cloud mode enabled. If cloud mode isn't set up, there's no QR to scan -- the gate is implicit.

## What the QR code actually carries

From `mobile/src/screens/PairScreen.tsx`:

```ts
type PairPayload = { v: number; type: string; cloudUrl: string; token: string };
```

Two things OAuth identity alone does not provide:

- **`cloudUrl`** -- which specific machine is the user's (`rebel-cloud-XXXXXXXX.fly.dev` or their BYOK domain). Mindstone does not know this for BYOK users. Even for managed-cloud users, it is per-user.
- **`token`** -- the static bearer token that gates everything on that instance. Generated at provisioning time on the user's desktop.

## Why we don't just store BYOK tokens on the Mindstone backend

"Store `{cloudUrl, token}` on `rebel.mindstone.com` keyed by OAuth identity, look it up on mobile sign-in" is technically straightforward. We have deliberately not done it. The tradeoffs:

### 1. It collapses BYOK into managed cloud

The defining property of BYOK is that **Mindstone does not hold the keys to your instance.**

- **Managed** = Mindstone provisions, holds the token, can reach in. Convenience.
- **BYOK** = User provisions on their own cloud account, token stays on their desktop + mobile. Sovereignty.

Storing BYOK tokens in Mindstone's backend reverses that. Users who chose BYOK -- enterprises, privacy-sensitive professionals, the data-sovereignty crowd -- chose it *because* Mindstone doesn't hold the keys. Quietly changing this is a trust violation even if technically fine.

### 2. Blast radius expands significantly

Today, a breach of `rebel.mindstone.com` exposes identity and entitlement data but not chat/workspace/memory content. If we store instance tokens, a single backend breach compromises every BYOK user's instance. The token is total access -- no scopes, no rotation.

### 3. Compliance surface expands

Once Mindstone holds keys to the user's instance, Mindstone is effectively a data processor for everything in that instance. GDPR data processing agreements, SOC2 controls over that storage, subpoena exposure, and breach notification obligations all get bigger. Today, none of this applies to BYOK data.

### 4. Sync correctness problems

The token would now live in three places (desktop, mobile, backend). Rotation, re-provisioning, and token repair (`cloud:repair-token`) must update all three atomically or users get locked out. More moving parts, more failure modes.

### 5. It does not fix the underlying debt

Per-device revocation ("lost my phone, kill its access") still requires per-device tokens. Storing the shared instance token server-side gives convenient login but does not solve the security problem that actually matters.

## Recommended path if we want email-based mobile sign-in

Do these in order. Stage 1 is valuable regardless of Stage 2.

### Stage 1: Per-device tokens on each cloud instance

Replace the single shared `REBEL_CLOUD_TOKEN` with a per-device token registry stored on each instance's volume.

- New endpoint on the cloud instance (authenticated with the existing master token) to mint a device-scoped token: `{ deviceId, deviceName, token, createdAt, revokedAt }`.
- Desktop keeps the master token; mobile devices get device-scoped tokens.
- Settings UI to list and revoke individual devices.
- Mobile pairing (still via QR) mints a device token and stores that, not the master token.

This fixes the real security debt. No backend work on `rebel.mindstone.com` required. Works for both managed and BYOK.

### Stage 2: Opt-in backend storage for email-based pairing

Add a toggle in desktop Cloud settings:

> "Allow email sign-in from new devices -- sign in on your phone with your email instead of scanning a QR code. We'll store pairing details on Mindstone servers to make this possible."

On opt-in, desktop registers `{cloudUrl, deviceToken}` (a freshly minted device token, not the master token) with `rebel.mindstone.com`. Mobile OAuth sign-in fetches device tokens registered for that user and pairs automatically.

Why this is materially better than storing master tokens:

- **Per-device scope**: backend breach leaks revocable per-device tokens, not master keys.
- **Explicit user choice**: users who want sovereignty stay on QR-only.
- **No sync cascade**: rotating the master token does not cascade to N mobile devices.
- **Managed-cloud default**: users who picked managed already trust Mindstone with provisioning; the opt-in can default on for them.
- **BYOK default off**: preserves the BYOK trust model for users who chose it.

### Stage 3: QR remains the fallback

- For users who decline the opt-in.
- For first pairing when no devices are registered yet.
- For BYOK users who don't want Mindstone to hold any token.

## What not to do

- **Do not** store the master `REBEL_CLOUD_TOKEN` on `rebel.mindstone.com`, even for managed-cloud users. Use device-scoped tokens from day one.
- **Do not** remove the QR flow. It is the correct primitive for device pairing and the only path that preserves BYOK sovereignty.
- **Do not** silently enable backend storage of instance tokens without an explicit opt-in. This is a trust-model change, not a UX tweak.
- **Do not** attempt "auto-pull chats on sign-in" without first addressing that sessions default to `local_only`. Users would sign in and see an empty list of their many local chats -- worse UX than the QR.

## Decision status

- **Current state (2026-04-20)**: QR pairing only. Documented above.
- **Stage 1 (per-device tokens)**: Not started. Recommended regardless of Stage 2.
- **Stage 2 (opt-in backend storage for email sign-in)**: Not started. Blocked on Stage 1.
- **Owner**: Unassigned.

Update this doc when decisions change or stages progress.
