---
description: "Rules and signposts for mobile/ — the React Native mobile app that consumes cloud-client and shared core types."
last_updated: "2026-05-14"
---

# mobile — React Native App

`mobile/` is the **React Native surface** (Expo). It consumes `cloud-client` (shared React hooks + API layer) and `src/shared/` (types and IPC contracts). It talks to the cloud HTTP server in `cloud-service/`, which in turn delegates to the same `src/core/` business logic Electron uses.

## Hard rules

- **Business logic does not live here.** It belongs in `src/core/` (cross-surface) or `cloud-client/` (cross-mobile-and-future-web). `mobile/` contains only React Native-specific UI, navigation, and platform shims.
- **Reuse the cloud-client API layer**, don't roll your own HTTP/auth.
- **Cross-surface parity is a real check, not a vibe.** When a feature touches auth, provider routing, or anything desktop-connected, walk [`CROSS_SURFACE_PARITY_CHECKLIST`](../docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md). Default answer: sync the underlying data; don't quietly disable the feature on mobile.
- **No imports from `electron`** anywhere in this tree.
- **Knowledge-worker audience.** Same product lens as desktop: copy, defaults, error messages, onboarding are evaluated for non-technical users.
- **Never log secrets.** Use the shared logger.

## What genuinely lives here

- `app/` — Expo Router screens and entry
- `src/components/` — RN components (the desktop UI library doesn't apply here; we have a parallel mobile component set)
- `src/screens/` — top-level screens
- `src/hooks/` — RN-specific hooks (composition of `cloud-client` hooks plus RN concerns)
- `src/services/`, `src/api/` — RN-specific service wiring; thin layers over `cloud-client`
- `src/stores/` — RN-side Zustand stores (UI state; not business state)
- `src/transport/` — networking, SSE, retries
- `src/analytics/` — **mobile-local** client-side behavioural analytics (RudderStack RN). Mobile emits its own client/UI-origin events here; do **not** wire `@core/tracking` or add to `src/shared/trackingTypes.ts` (mobile event types stay mobile-local, and core's tracker runs on cloud — mirroring core events would double-count). Architecture: [`ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md § Mobile`](../docs/project/ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md#mobile-react-native--expo).
- `targets/` — Expo target configuration
- `.maestro/` — Maestro E2E test flows

## Testing tooling delta

Mobile uses **Jest** (not Vitest) for unit tests and **Maestro** for E2E flows (see `.maestro/`). `jest.config.js` and `jest.setup.js` configure the harness; mocks live in `__mocks__/`.

**Typechecking.** Mobile is typechecked by the repo TS error ratchet via two projects, both at baseline 0: `mobile` (production surface, `mobile/tsconfig.json`) and `mobile-test` (test surface, `mobile/tsconfig.test.json`, which extends the production config and re-includes the test globs). Both run under the **root** TypeScript compiler (6.x) inside `npm run validate:ts-ratchet` (part of `validate:fast` → local push gate + CI), so mobile-test type debt now fails by construction. **Do NOT run `cd mobile && tsc`** — mobile-local tsc (~5.9) rejects the `ignoreDeprecations: "6.0"` value with TS5103 before reaching any real error. Typecheck from repo root: `npm run validate:ts-ratchet` (or, for a single project, `npx tsc -p mobile/tsconfig.test.json --noEmit` from root).

## CI/CD

Preview builds auto-trigger on `dev` (or `main`) push when `mobile/**`, `cloud-client/**`, or `packages/shared/**` change. They deliberately **exclude** `src/core/**` and `src/shared/**` (touched by almost every commit; a core/shared change that needs to reach mobile is shipped via `workflow_dispatch`) — `mobile-runtime-integrity.yml` is the workflow that covers those core/shared paths. Production builds require manual dispatch. Full details: `.github/workflows/mobile-*.yml` and [`CI_PIPELINE`](../docs/project/CI_PIPELINE.md).

## See also

- Root [`AGENTS.md`](../AGENTS.md) — repo-wide rules; especially "Core-first, desktop-first architecture" and "Cross-surface parity check"
- [`../src/core/AGENTS.md`](../src/core/AGENTS.md) — where the business logic actually lives
- [`../cloud-service/AGENTS.md`](../cloud-service/AGENTS.md) — the HTTP backend mobile talks to
- [`docs/project/MOBILE_OVERVIEW.md`](../docs/project/MOBILE_OVERVIEW.md) — mobile architecture overview
- [`docs/project/MOBILE_PAIRING_AND_AUTH.md`](../docs/project/MOBILE_PAIRING_AND_AUTH.md) — mobile auth + device pairing
- [`docs/project/MOBILE_IOS_CREDENTIALS.md`](../docs/project/MOBILE_IOS_CREDENTIALS.md) — iOS signing / TestFlight credentials
- [`docs/project/MOBILE_QA.md`](../docs/project/MOBILE_QA.md) — mobile QA process
- [`docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md`](../docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md) — required check before merging cross-surface features
- [`docs/project/CI_PIPELINE.md`](../docs/project/CI_PIPELINE.md) — mobile CI/CD pipelines
- `cloud-client/` — the shared client library this app consumes
- `src/shared/types.ts` — core shared types
