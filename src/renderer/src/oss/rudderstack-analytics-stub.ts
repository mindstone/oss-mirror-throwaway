/**
 * OSS no-op stub for `@rudderstack/analytics-js` (Elastic-2.0).
 *
 * THIS IS THE OSS BUILD ALIAS TARGET. In OSS builds, both renderer Vite configs
 * (`vite.renderer.config.mjs` + the renderer section of `electron.vite.config.ts`)
 * alias the specifier `@rudderstack/analytics-js` to THIS module so the OSS
 * renderer bundle resolves deterministically to a no-op — the Elastic-2.0 SDK is
 * neither bundled nor present in the public `package.json`/lockfile (it is
 * dependency-stripped via `mirror/substitutions.yaml#dependency_strips`).
 *
 * In COMMERCIAL builds the alias is ABSENT, so the guarded dynamic import of
 * the SDK in `src/renderer/src/analytics.ts` resolves the REAL package and
 * analytics behaves exactly as before.
 *
 * The method surface MUST match every method `analytics.ts` calls on the client:
 *   load / ready / track / identify / alias / setAnonymousId
 * (kept in lockstep with the local `RudderAnalyticsClient` interface in
 * `analytics.ts`). The OSS runtime never actually reaches the constructor — the
 * no-phone-home cred gate returns first — but the stub keeps the build resolvable
 * and any accidental call a harmless no-op.
 */

export class RudderAnalytics {
  load(_writeKey: string, _dataPlaneUrl: string, _options?: unknown): void {
    // no-op: OSS builds never load a real analytics SDK.
  }

  ready(_callback: () => void): void {
    // no-op: never signals ready (OSS analytics stays dark).
  }

  track(..._args: unknown[]): void {
    // no-op
  }

  identify(..._args: unknown[]): void {
    // no-op
  }

  alias(_newId: string, _previousId?: string): void {
    // no-op
  }

  setAnonymousId(_id: string): void {
    // no-op
  }
}
