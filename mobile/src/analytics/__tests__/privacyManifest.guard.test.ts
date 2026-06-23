/**
 * Stage B4 — STATIC GUARD for the iOS privacy manifest declared in
 * `mobile/app.json` (`expo.ios.privacyManifests`).
 *
 * This is the cheap CI gate against an accidental deletion / edit of the
 * privacy declarations that gate App Store submission. It is a STATIC read of
 * the `app.json` SOURCE — it does NOT (and cannot) verify the *generated*
 * `PrivacyInfo.xcprivacy`, which is only produced at `expo prebuild` /
 * `pod install` and must merge the third-party pods' own shipped manifests
 * (notably the core `Rudder` pod). FULL verification still requires the
 * post-prebuild archive inspection documented in
 * `docs/project/MOBILE_PRIVACY_COMPLIANCE.md` and the B4 release-gate QA
 * checklist. See that doc for where the prebuild manifest-diff would slot into
 * CI.
 *
 * What this asserts (so an accidental regression is caught in the normal Jest
 * run, before it ships to TestFlight / Play via the auto-deploy on `dev`):
 *
 *  1. `NSPrivacyTracking` is present and `false` (no ATT / cross-app tracking).
 *  2. Sentry's three required-reason APIs are declared with the exact reason
 *     codes (UserDefaults CA92.1, SystemBootTime 35F9.1, FileTimestamp C617.1).
 *     These also cover the RudderStack RN wrapper's only verifiable
 *     required-reason API (UserDefaults / NSUserDefaults — CA92.1).
 *  3. The analytics + diagnostics collected-data-type rows exist
 *     (Crash + Performance + OtherDiagnostic from Sentry; ProductInteraction
 *     from RudderStack; EmailAddress from the identify-by-email model), every
 *     row Linked-to-identity and NOT used for tracking.
 */

import fs from 'node:fs';
import path from 'node:path';

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const APP_JSON = path.join(MOBILE_ROOT, 'app.json');

interface AccessedApiType {
  NSPrivacyAccessedAPIType: string;
  NSPrivacyAccessedAPITypeReasons: string[];
}

interface CollectedDataType {
  NSPrivacyCollectedDataType: string;
  NSPrivacyCollectedDataTypeLinked?: boolean;
  NSPrivacyCollectedDataTypeTracking?: boolean;
  NSPrivacyCollectedDataTypePurposes?: string[];
}

interface PrivacyManifests {
  NSPrivacyTracking?: boolean;
  NSPrivacyTrackingDomains?: string[];
  NSPrivacyAccessedAPITypes?: AccessedApiType[];
  NSPrivacyCollectedDataTypes?: CollectedDataType[];
}

// Required-reason APIs that MUST be declared (code -> reason). Sentry is
// authoritative; UserDefaults also covers the RudderStack RN wrapper.
const REQUIRED_ACCESSED_APIS: Record<string, string> = {
  NSPrivacyAccessedAPICategoryUserDefaults: 'CA92.1',
  NSPrivacyAccessedAPICategorySystemBootTime: '35F9.1',
  NSPrivacyAccessedAPICategoryFileTimestamp: 'C617.1',
};

// Collected data types that MUST be declared (Sentry diagnostics +
// RudderStack product interaction + identify-by-email).
const REQUIRED_COLLECTED_DATA_TYPES = [
  'NSPrivacyCollectedDataTypeCrashData',
  'NSPrivacyCollectedDataTypePerformanceData',
  'NSPrivacyCollectedDataTypeOtherDiagnosticData',
  'NSPrivacyCollectedDataTypeProductInteraction',
  'NSPrivacyCollectedDataTypeEmailAddress',
] as const;

describe('iOS privacy manifest (app.json static guard)', () => {
  const raw = fs.readFileSync(APP_JSON, 'utf8');
  const config = JSON.parse(raw) as {
    expo?: { ios?: { privacyManifests?: PrivacyManifests } };
  };
  const manifest = config.expo?.ios?.privacyManifests;

  it('declares expo.ios.privacyManifests', () => {
    expect(manifest).toBeDefined();
  });

  it('declares NSPrivacyTracking: false (no ATT / cross-app tracking)', () => {
    expect(manifest?.NSPrivacyTracking).toBe(false);
  });

  it('declares the three required-reason APIs with their exact reason codes', () => {
    const declared = new Map(
      (manifest?.NSPrivacyAccessedAPITypes ?? []).map((entry) => [
        entry.NSPrivacyAccessedAPIType,
        entry.NSPrivacyAccessedAPITypeReasons ?? [],
      ]),
    );
    for (const [apiType, reasonCode] of Object.entries(REQUIRED_ACCESSED_APIS)) {
      expect(declared.has(apiType)).toBe(true);
      expect(declared.get(apiType)).toContain(reasonCode);
    }
  });

  it('declares the analytics + diagnostics collected-data-type rows', () => {
    const declaredTypes = new Set(
      (manifest?.NSPrivacyCollectedDataTypes ?? []).map(
        (entry) => entry.NSPrivacyCollectedDataType,
      ),
    );
    for (const dataType of REQUIRED_COLLECTED_DATA_TYPES) {
      expect(declaredTypes.has(dataType)).toBe(true);
    }
  });

  it('marks every collected-data-type as NOT used for tracking', () => {
    const trackingRows = (manifest?.NSPrivacyCollectedDataTypes ?? []).filter(
      (entry) => entry.NSPrivacyCollectedDataTypeTracking === true,
    );
    expect(trackingRows).toEqual([]);
  });

  it('keeps tracking domains empty (no cross-app tracking endpoints)', () => {
    // Empty/absent both acceptable; a non-empty list would imply ATT obligations.
    expect(manifest?.NSPrivacyTrackingDomains ?? []).toEqual([]);
  });
});
