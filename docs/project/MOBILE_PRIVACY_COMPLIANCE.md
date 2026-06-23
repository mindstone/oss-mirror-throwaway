---
description: "Mobile (iOS/Android) privacy compliance: App Store nutrition label, Google Play Data Safety, iOS privacy manifest, and the IDFA-free archive-inspection QA checklist for analytics + Sentry"
last_updated: "2026-06-13"
---

# Mobile privacy compliance — App Store privacy label + Google Play Data Safety

Single reference for what the **mobile (React Native / Expo)** app declares to
Apple and Google, why, and the **pre-submission verification gates** that must
pass before a store build. Created for Stage B4 of the
`260612_mobile-analytics-error-monitoring` run.

The mobile app collects two data streams that trigger store privacy
obligations:

- **Crash / diagnostics** via `@sentry/react-native` (`mobile/src/utils/sentry.ts`).
- **Behavioural analytics** via `@rudderstack/rudder-sdk-react-native`
  (`mobile/src/analytics/analytics.ts`), first-party / cloud-mode, **IDFA-free**.

Both are **always-on, identified by email, no proprietary content**, disclosed
in the privacy policy (Decision Log `2026-06-12 13:40`). There is **no ATT
prompt and no cross-app tracking** — the SDKs are configured first-party and
never link `AdSupport` (see the IDFA gate below).

> **Sources of truth this doc signposts to:**
> - `mobile/app.json` → `expo.ios.privacyManifests` — the iOS privacy-manifest
>   source (generates `PrivacyInfo.xcprivacy` at prebuild).
> - `docs/plans/260612_mobile-analytics-error-monitoring/PLAN.md` — Stage B4
>   scope, the Decision Log privacy decisions, and the Failure Mode Matrix.
> - `mobile/src/analytics/PRIVACY_CONTRACT.md` — the in-repo analytics privacy
>   contract (no ad/device-mode integrations, no `setAdvertisingId`, redaction).
> - `mobile/src/analytics/__tests__/privacyManifest.guard.test.ts` — the static
>   CI guard asserting the `app.json` manifest rows below are present.
> - [MOBILE_TELEMETRY_KEYS.md](./MOBILE_TELEMETRY_KEYS.md) — how the Sentry +
>   RudderStack keys are delivered into builds (GitHub secrets → EAS) and their
>   public-vs-secret classification.

---

## 1. App Store privacy "nutrition label" (App Store Connect)

App Store Connect → App Privacy. Declare the following data types. **Every type
is "Linked to the user's identity"** (we `identify()` by email — Decision Log
`2026-06-12 13:40`), and **none is "Used to Track You"** (no IDFA, no cross-app
tracking, no data brokers).

| Data type (ASC category) | Collected? | Linked to identity | Used for tracking | Purpose | Source |
| --- | --- | --- | --- | --- | --- |
| **Crash Data** | Yes | Yes | No | App Functionality | Sentry |
| **Performance Data** | Yes | Yes | No | App Functionality | Sentry |
| **Other Diagnostic Data** | Yes | Yes | No | App Functionality | Sentry |
| **Product Interaction** (Usage Data) | Yes | Yes | No | Analytics, App Functionality | RudderStack |
| **Email Address** (Contact Info) | Yes | Yes | No | App Functionality | `identify()` post-pair |

**"Used to Track You" column: EMPTY for every row.** No ATT prompt; no
`NSUserTrackingUsageDescription`.

These rows are mirrored exactly by `expo.ios.privacyManifests` in
`mobile/app.json` (`NSPrivacyCollectedDataTypes`), each with
`NSPrivacyCollectedDataTypeLinked: true` and
`NSPrivacyCollectedDataTypeTracking: false`.

> **Why Email is Linked, not Tracking:** we attach the account email to crash +
> analytics events for support/debugging within Rebel only. It is never used to
> track the user across other companies' apps/sites, which is Apple's definition
> of "tracking". Hence Linked = yes, Tracking = no, no ATT.

---

## 2. iOS privacy manifest (`PrivacyInfo.xcprivacy`) — required-reason APIs

Authored in `mobile/app.json` → `expo.ios.privacyManifests`; Expo merges it into
the generated `PrivacyInfo.xcprivacy` at prebuild. Required-reason APIs declared:

| API category | Reason code | Used by |
| --- | --- | --- |
| `NSPrivacyAccessedAPICategoryUserDefaults` | `CA92.1` | Sentry **and** RudderStack RN wrapper (`NSUserDefaults` in `RNPreferenceManager.m`) |
| `NSPrivacyAccessedAPICategorySystemBootTime` | `35F9.1` | Sentry |
| `NSPrivacyAccessedAPICategoryFileTimestamp` | `C617.1` | Sentry |

`NSPrivacyTracking: false`, `NSPrivacyTrackingDomains: []`.

### RudderStack required-reason rows — status (B4 finding)

The Stage B4 task was to add RudderStack's required-reason rows from its
**shipped pod manifest**. Findings:

- The **RN wrapper** (`@rudderstack/rudder-sdk-react-native@3.1.0`, present in
  `node_modules`) ships its iOS sources but **no `PrivacyInfo.xcprivacy`**. Its
  only verifiable required-reason API is **UserDefaults** (`NSUserDefaults` in
  `ios/RNPreferenceManager.m`) → **`CA92.1`, which is already declared** (shared
  with Sentry). No `SystemBootTime`, `FileTimestamp`, `DiskSpace`, or advertising
  framework usage was found in the wrapper sources.
- The wrapper's actual data/network/persistence work lives in the **core
  `Rudder` pod** (podspec dependency `Rudder >= 1.32.1, < 2.0.0`). **That pod is
  NOT in `node_modules`** — it is fetched only at `pod install` during
  `expo prebuild`. Its `PrivacyInfo.xcprivacy` is the authoritative source for
  any *additional* RudderStack required-reason rows.

> **PREBUILD TODO (do NOT guess codes):** after the next `expo prebuild` /
> `pod install`, read `ios/Pods/Rudder/.../PrivacyInfo.xcprivacy` (and re-check
> the RN wrapper pod). Add any required-reason API or collected-data rows it
> declares that are not already in `app.json` (merge, don't duplicate —
> `CA92.1` UserDefaults is already covered). The researcher report
> (`subagent_reports/260612_160554_researcher-rudderstack-expo-privacy.md`, Q3a)
> flags `SystemBootTime`/`FileTimestamp`/`DiskSpace` as *possible* but
> unconfirmed (RudderStack docs 403'd) — verify against the pod, never declare
> on speculation. This is captured as the post-prebuild manifest-diff step in §4.

---

## 3. Google Play Data Safety (Play Console)

Android submits to Play **alpha / internal**. Play Console → App content → Data
safety. Declarations mirror the App Store label:

| Play data category → type | Collected | Shared | Processed ephemerally | Required | Purpose |
| --- | --- | --- | --- | --- | --- |
| **App activity → App interactions** | Yes | No | No | No (optional, no in-app toggle but disclosed) | Analytics, App functionality |
| **App info & performance → Crash logs** | Yes | No | No | No | App functionality / diagnostics |
| **App info & performance → Diagnostics** | Yes | No | No | No | App functionality / diagnostics |
| **Personal info → Email address** | Yes | No | No | No | App functionality |

Play-specific answers:

- **Is all collected data encrypted in transit?** Yes (HTTPS to Sentry +
  RudderStack data plane).
- **Do you provide a way to request data deletion?** Yes — via the privacy
  policy contact route (account-level deletion).
- **Is data shared with third parties?** "Shared" in Play's sense = transfer to
  *other companies*. Sentry + RudderStack are **processors acting on our
  behalf**, so declare **collected, not shared**.
- **Advertising / device ID (`AD_ID`)?** **No.** The app does **not** request the
  `com.google.android.gms.permission.AD_ID` permission and does not collect the
  advertising ID. Confirm `AD_ID` is absent from the merged
  `AndroidManifest.xml` after prebuild (see §4). RudderStack RN forwards
  `autoCollectAdvertId: false` to Android native.

---

## 4. Pre-submission verification gates (the key pre-GA checks)

Mobile **auto-deploys to TestFlight + Play alpha on every `dev` push**
(`.github/workflows/mobile-preview.yml`), so these gates must run before a build
intended for store review / submission.

### 4a. iOS IDFA / ATT — DONE (source-level verified)

**Status: no IDFA, no ATT prompt required — provable from source.** "Not used to
track you" is accurate. This is no longer a blocking gate; it is settled at the
source level, with the binary grep below retained only as belt-and-suspenders.

Source-level evidence (verified 2026-06-14):

- The **RudderStack RN wrapper** iOS sources
  (`node_modules/@rudderstack/rudder-sdk-react-native/ios/*`) reference **no**
  `AdSupport` / `AppTrackingTransparency` / `advertisingIdentifier` /
  `ASIdentifierManager` / `ATTrackingManager` — confirmed by grep across the
  wrapper's `.m`/`.mm`/`.h` (zero matches).
- iOS IDFA is **manual-only**: the wrapper exposes `putAdvertisingId`
  (`RNRudderSdkModuleImpl.m`) — the app would have to *pass in* an IDFA; the SDK
  never auto-collects one. **Our code never calls it**, and the F4 static guard
  (`mobile/src/analytics/__tests__/privacyContract.guard.test.ts`, forbid list
  includes `setAdvertisingId`/`putAdvertisingId`) **forbids it across both
  `mobile/src` and `mobile/app`** — so a future regression that called it would
  fail CI.
- The core **`Rudder` iOS pod** (podspec dependency `Rudder >= 1.32.1, < 2.0.0`
  in `RNRudderSdk.podspec`) is where the wrapper's data/network work lives. Its
  podspec declares only `Foundation` as a framework — **no `AdSupport`,
  `AdServices`, or `AppTrackingTransparency`, and no IDFA subspec**. (The pod is
  not in `node_modules`; it is fetched at `pod install` during `expo prebuild` —
  the framework declaration is the authoritative source.)

Conclusion: no advertising framework is linked, so there is **no ATT prompt** and
the App Store / Play "not used to track you" declaration is provably correct.

**Belt-and-suspenders (optional, no longer blocking).** If you want to confirm
against an actual built archive (e.g. after adding a new transitive dep), run the
following against a **production-profile** archive (after `eas build` or a local
`expo run:ios --configuration Release` archive). Expect zero matches:

```sh
# 1. No advertising frameworks linked anywhere in the app bundle / frameworks.
#    Expect ZERO matches. Any hit = investigate before submitting.
grep -rl "AdSupport"                 "Rebel.app/" "Rebel.app/Frameworks/" 2>/dev/null
grep -rl "AppTrackingTransparency"   "Rebel.app/" "Rebel.app/Frameworks/" 2>/dev/null

# 2. No IDFA / ATT symbols in the main binary or any framework binary.
#    Expect NO output. Run over the app binary and each .framework binary.
nm -u "Rebel.app/Rebel" 2>/dev/null | grep -iE "ASIdentifierManager|advertisingIdentifier|ATTrackingManager|requestTrackingAuthorization"
otool -L "Rebel.app/Rebel" | grep -iE "AdSupport|AppTrackingTransparency"
for fw in Rebel.app/Frameworks/*.framework; do
  bin="$fw/$(basename "$fw" .framework)"
  [ -f "$bin" ] && otool -L "$bin" | grep -iE "AdSupport|AppTrackingTransparency" && echo "  ^ in $fw"
done

# 3. No ATT usage-description key snuck into the merged Info.plist.
/usr/libexec/PlistBuddy -c "Print :NSUserTrackingUsageDescription" "Rebel.app/Info.plist" 2>&1 # expect: "Does Not Exist"
```

Equivalent via **Xcode Organizer**: open the archive → Window → Organizer →
select the build → "Generate Privacy Report" — confirm no tracking domains and
no advertising-related required-reason entries appear. Also review the linked
frameworks list in the Organizer for `AdSupport` / `AppTrackingTransparency`.

> If ANY advertising symbol/framework appears: a device-mode ad integration or a
> transitive dep pulled it in. STOP — do not submit. Trace the linker, remove
> the offending dep, re-declare the manifest, re-verify. (Mitigation: the repo's
> `PRIVACY_CONTRACT.md` + the static guard forbid the integration packages, so
> this should only fire on an unexpected transitive dep.)

### 4b. Generated `PrivacyInfo.xcprivacy` manifest diff (post-prebuild)

The static guard (`privacyManifest.guard.test.ts`) only checks the **source**
in `app.json`. The **generated** manifest must additionally pick up the third-
party pods' own declarations. After `expo prebuild`:

```sh
# Locate and inspect the generated manifest.
find ios -name "PrivacyInfo.xcprivacy"
plutil -p ios/Rebel/PrivacyInfo.xcprivacy   # or the app target's path
# Inspect the core Rudder pod's shipped manifest for ADDITIONAL required-reason rows.
find ios/Pods/Rudder -name "PrivacyInfo.xcprivacy" -exec plutil -p {} \;
```

Confirm: Sentry's three required-reason APIs + all five collected-data rows are
present, `NSPrivacyTracking` is `false`, tracking domains empty. Capture any new
rows the `Rudder` pod declares and fold them into `app.json` (the §2 PREBUILD
TODO). **Slot into CI:** this diff belongs in a prebuild-enabled CI job (it
cannot run in the standard Jest/Metro PR job because no `ios/` dir exists
pre-prebuild) — e.g. a gate in the EAS production build or a dedicated
`prebuild + manifest-diff` workflow step, failing the build if the generated
manifest is missing an expected key.

### 4c. Android `AD_ID` absence

```sh
# After prebuild, confirm the AD_ID permission is NOT in the merged manifest.
grep -r "com.google.android.gms.permission.AD_ID" android/app/src/main/AndroidManifest.xml \
  android/app/build/intermediates/merged_manifests 2>/dev/null   # expect: no output
```

### 4d. `reset(false)` preserves anonymousId on a real build

On unpair, `mobile/src/analytics/analytics.ts` calls the SDK `reset(false)` to
clear account identity while preserving the device `anonymousId` (reconciled
with `rebel_client_id`). The `false` (do-not-reset-anonymousId) semantics are
SDK-native and untestable in Jest. On a real dev build: pair → note the
anonymousId → unpair → confirm the **same** anonymousId persists on the next
emitted event (so an unpaired device isn't re-counted as a new install).

### 4e. Hermes / expo-router funnel timing

RN 0.81 + new arch runs Hermes. Confirm on a dev build that the launch-init
funnel (`launchInitFunnel`) fires its analytics events in the correct order
relative to expo-router mount, and that an unhandled promise rejection + a
thrown error both reach Sentry under Hermes (carried over from the Stage A1 QA
note — re-verify if the rejection wiring changes).

---

## 5. Privacy-policy disclosure wording

The privacy policy (linked from `mobile/app/(tabs)/help.tsx` →
`https://mindstone.com/privacy-policy`) and the in-app Privacy disclosure card
must cover, in plain language (Rebel voice — dry, clear, calm):

> Rebel collects crash reports and anonymous-feature usage to see what's working
> and what's broken. This is tied to your account (so we can help when something
> goes wrong) but is **never** any message content, and is **never** used to
> track you across other apps. Crash and diagnostic data is handled by Sentry;
> usage analytics by RudderStack — both as processors acting on our behalf.

Key claims that MUST stay true (and are enforced by the redaction layer +
`PRIVACY_CONTRACT.md`): no message content, no raw file paths/URLs/emails in
event *properties* (email travels only via the SDK-managed `identify()`
channel), no cross-app tracking, no IDFA.
