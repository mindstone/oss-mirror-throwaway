# Mobile Analytics Privacy Contract

This contract governs what the mobile RudderStack analytics layer
(`mobile/src/analytics/`) may and may not do. It is enforced by the redaction
layer (`redaction.ts`) plus unit tests in `__tests__/`, not by convention alone.

It is **load-bearing for App Store / Play compliance** (Stages B2/B4): the iOS
privacy manifest and the App Store / Play Data Safety declarations describe
exactly the behaviour this contract pins down. If this contract drifts, those
declarations become lies.

## Hard prohibitions

1. **No advertising / IDFA / device-graph collection.**
   - SDK config must set `autoCollectAdvertId: false` and `collectDeviceId: false`.
   - The app must NOT call `setAdvertisingId` / `putAdvertisingId` /
     `putDeviceToken`, and must NOT install any RudderStack **device-mode**
     integration package (e.g. ad/attribution destinations such as
     `@rudderstack/rudder-integration-*` for Adjust/AppsFlyer/Firebase/Braze).
     All destinations are **cloud-mode** through the data plane only.
   - Rationale: keeps the app IDFA-free → no `AdSupport.framework`, no
     `AppTrackingTransparency` link, **no ATT prompt**, and lets the privacy
     manifest keep `NSPrivacyTracking: false` with empty tracking domains.

2. **No content or raw identifiers as event properties.**
   The following property keys are **dropped** (not merely scrubbed) by
   `redactAnalyticsProperties` before any event leaves the device:
   `url`, `email`, `cloudUrl`/`cloud_url`, anything matching `message`,
   `content`, `transcript`, `path`/`filepath`/`file_path`, `prompt`, `body`.
   - Message bodies, prompts, transcripts, file contents and file paths are
     **never** analytics properties.
   - Email is identity, not a property: it travels ONLY on the SDK-managed
     `identify()` channel, never on `track()`.

3. **Ids are hashed, not raw.**
   `cloudUrl`/`sessionId`-shaped properties are replaced with a stable,
   non-reversible hash (`cloudUrlHash` / `sessionIdHash`). The raw value never
   leaves the device as an analytics property.

4. **Shared redaction is reused, never forked.**
   `redactAnalyticsProperties` runs the shared `redactObjectDeep`
   (`@shared/utils/sentryRedaction`) over the remaining properties so analytics
   inherits the same email/path/api-key/secret scrubbing as Sentry. Mobile does
   not maintain its own redaction pattern set.

## Identity rules

- `anonymousId` is the existing install id (`rebel_client_id`), reconciled via
  `anonymousId.ts` — never a freshly minted UUID.
- `identify(email)` (Stage B3) uses email as the identity trait, matching
  desktop. Degrade gracefully to anonymous-only when email is absent.
- On unpair (Stage B3): call `analytics.reset()` so identity never outlives the
  session.

## iOS privacy manifest (Stage B2)

`mobile/app.json` → `expo.ios.privacyManifests` declares analytics collection:

- `NSPrivacyCollectedDataTypeProductInteraction` (Usage Data) — `Linked: true`
  (we identify by email), `Tracking: false`, purposes Analytics +
  AppFunctionality. The diagnostics/email rows (Crash/Performance/Other
  Diagnostic Data + EmailAddress) come from the Sentry + identified-by-email
  arc (A1/A2).
- Top-level `NSPrivacyTracking: false` and `NSPrivacyTrackingDomains: []` stay
  as-is: the RudderStack data plane is a first-party processor, NOT a tracking
  domain, and the IDFA-free config (prohibition 1) means no ATT-relevant
  tracking. Linked-to-identity is NOT the same as "used to track you."

**Deferred to Stage B4 (do not guess here):** RudderStack's own
`NSPrivacyAccessedAPITypes` required-reason rows (if any beyond Sentry's
UserDefaults `CA92.1` / SystemBootTime `35F9.1` / FileTimestamp `C617.1`) must
be verified against the **shipped pod's** bundled `PrivacyInfo.xcprivacy` after
`expo prebuild`, then merged into the app.json manifest. app.json is strict
JSON (no comments), so this deferral lives here, not inline.

## Enforcement

- `redaction.ts` implements prohibitions 2–4.
- `__tests__/redaction.test.ts` asserts forbidden keys are stripped, ids are
  hashed, and emails do not survive as properties.
- `__tests__/analytics.test.ts` asserts the singleton is inert until permitted
  and that `reset()` semantics hold.

If a new event needs a property that this contract forbids, the answer is to
re-model the property (hash it, drop the raw value, or move identity to
`identify()`), **not** to weaken the contract.
