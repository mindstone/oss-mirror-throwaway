---
description: "Mobile (React Native) QA & E2E testing: Maestro flow catalog, how to run, prerequisites, and how to seed approval system state."
last_updated: "2026-06-07"
---

# Mobile QA & E2E Testing

This doc is the single entry point for mobile (`mobile/`) manual + automated UI testing. Unit tests + integration tests run in Jest via `npm run test` inside `mobile/`; UI-level flows run under [Maestro](https://maestro.mobile.dev) against a real simulator/emulator.

## See Also

- [MOBILE_OVERVIEW.md](MOBILE_OVERVIEW.md) -- App architecture, pairing, cloud continuity
- [APPROVAL_SYSTEM.md](APPROVAL_SYSTEM.md) -- Approval architecture (desktop + cloud + mobile) and the Stage D bottom sheets exercised by the flows below
- [TESTING_AUTOMATION_OVERVIEW.md](TESTING_AUTOMATION_OVERVIEW.md) -- Repo-wide testing hub (unit + E2E + evals)
- [TESTING_E2E.md](TESTING_E2E.md) -- Playwright E2E (desktop only; mobile uses Maestro, not Playwright)
- [MOBILE_IOS_CREDENTIALS.md](MOBILE_IOS_CREDENTIALS.md) -- iOS signing + TestFlight build setup

## Tooling

- **Maestro** -- UI E2E runner. Install: `curl -Ls "https://get.maestro.mobile.dev" | bash`, then `maestro --version`. Docs: <https://maestro.mobile.dev/getting-started>.
- **Jest** -- unit + integration tests in `mobile/src/__tests__/`. Run: `cd mobile && npm run test`. Mobile uses **Jest, not Vitest**: never import from `'vitest'` in `mobile/**`, and validate changed mobile tests with `cd mobile && npx jest <path>` (not the repo-root Vitest runner).
- `mobile/.maestro/` -- canonical home for Maestro flow YAMLs.
- `mobile/.env.maestro.example` -- template for environment variables (`CLOUD_URL`, `CLOUD_TOKEN`) used by the login flow.

## Running Maestro flows locally

```sh
# From the repo root:
cd mobile
npm run test:maestro               # runs every YAML in .maestro/

# Run a single flow:
npx maestro test .maestro/login.yaml
npx maestro test .maestro/conflict_resolve_with_rebel.yaml
```

The `test:maestro` script is wired in `mobile/package.json` and calls `maestro test .maestro/`. Pre-PR unit testing is covered by Jest (`npm run test`) and does not require Maestro.

## Deterministic local-cloud E2E lane (recommended)

The flows above historically depended on a **deployed** cloud + **live** agent turns + manually-created backend state — flaky, and impossible to gate in CI. The deterministic lane removes all three by pointing the app at a **local cloud** running in test mode:

- **Deterministic agent** — boot `cloud-service` with `REBEL_MOCK_AGENT_TURNS=1` (synthetic assistant+result events, no Anthropic call).
- **Seedable state** — `REBEL_E2E_TEST_MODE=1` mounts test-only endpoints under `/__e2e/*` (see `cloud-service/src/routes/e2eFixtures.ts`):
  - `GET /__e2e/health`, `POST /__e2e/reset`, `POST /__e2e/seed/conversation`.
  - **Hard-gated**: invisible (404) unless `REBEL_E2E_TEST_MODE=1`; refuses to enable under `NODE_ENV=production` or any Fly marker; requires an explicit `Authorization: Bearer <REBEL_E2E_TOKEN || REBEL_CLOUD_TOKEN>` even in dev (it does **not** use the dev-open `authorize()`). Writes through the real stores and broadcasts the same events mobile sees in production — realistic, not a bypass.
- **Run correlation** — pass `X-Rebel-E2E-Run-Id`; it's echoed in responses and tagged in cloud logs (and used in Maestro artifact paths) so one failed flow is traceable across app, cloud, and fixtures.

> **Run the local cloud from the built bundle**, not the `tsx` dev path: `cd cloud-service && node build.mjs && node dist/server.mjs`. The `node --import tsx src/server.ts` path currently crashes on an ESM-interop issue (`@core/platform`). Health: `GET /api/health`.

### One command

```sh
# iOS simulator (booted) or Android emulator (booted) must already exist; app installed.
mobile/scripts/e2e-mobile.sh --platform ios --app /path/to/Rebel.app
mobile/scripts/e2e-mobile.sh --platform android --app /path/to/rebel-e2e.apk
```

The script boots the deterministic cloud, installs the app (if `--app`), seeds state, runs every `.maestro/` flow with `--debug-output`/`--test-output-dir`, and captures cloud + device logs into `mobile/build/maestro-results/<runId>/`.

### Building a simulator-installable app

Use the `e2e` EAS profile (added in `mobile/eas.json`): `ios.simulator: true`, `EXPO_PUBLIC_REBEL_E2E=1` (which enables the test-mode app paths). e.g. `cd mobile && eas build -p ios --profile e2e --local` (or `expo run:ios` for a quick local build).

> **iOS simulator prerequisite (known dev-Mac gotcha, 2026-06-06):** Xcode may ship an SDK whose **simulator runtime isn't installed** (e.g. SDK iOS 26.5 but only the 26.4 runtime present). `xcodebuild` then resolves *no* eligible simulator destination. Fix: `xcodebuild -downloadPlatform iOS`. The app itself compiles cleanly; this is purely a runtime-availability gap.

### CI

`.github/workflows/mobile-e2e.yml` runs this lane on an **Android emulator on Linux** (cheap PR gate; `reactivecircus/android-emulator-runner` + KVM), booting the local cloud as a job step and uploading Maestro/cloud artifacts. An **iOS-simulator-on-macOS** lane runs nightly/on-dispatch (macOS runners are pricey). *(Authored 2026-06-06; treat the first runs as non-required until flake rate is known, then promote.)*

### The three lanes (mock/real boundary)

| Lane | Cloud | Agent | When | Catches |
|------|-------|-------|------|---------|
| **Deterministic** (PR gate) | local | mock (`REBEL_MOCK_AGENT_TURNS`) + seeded fixtures | every PR | nav/pairing/stores/HTTP/WS/approval-UI/protocol regressions |
| **Live-LLM** (nightly) | local | real provider creds | nightly | provider/prompt regressions the mock can't see |
| **Release smoke** | deployed | real | pre-TestFlight/Play | packaging + production config |

Mock only the nondeterministic edges (LLM output, tool-option generation, fixed delays); keep real auth, stores, event channel, deep links, and UI. The deterministic lane *will* false-green provider/packaging issues — that's what the other two lanes are for.

### Prerequisites

1. **Simulator/emulator running.** Xcode (iOS) or Android Studio (Android). Maestro auto-detects; if both are running it prompts.
2. **App installed.** `cd mobile && npm run ios` or `npm run android` once to install a dev build on the target device.
3. **Paired (authenticated) session.** Pairing is established by the harness, not by walking the manual pair screen (which a previously-paired sim never shows — see Gotchas). `e2e-mobile.sh` launches the app and delivers `rebel://e2e/pair?cloudUrl=<localhost-url>&token=<token>` via `xcrun simctl openurl` against a fully-booted app; the credentials land in the iOS Keychain and survive `clearState`. `.maestro/login.yaml` then just confirms a clean-state launch still reaches `home-screen` (i.e. pairing is healthy). To pair by hand against a fresh sim:

   ```sh
   xcrun simctl launch booted com.mindstone.rebel.mobile
   # NOTE localhost (not 127.0.0.1) and percent-encoded query values:
   xcrun simctl openurl booted 'rebel://e2e/pair?cloudUrl=http%3A%2F%2Flocalhost%3A3100&token=<TOKEN>'
   ```

   Subsequent flows assume the pairing persists across launches (`launchApp` without `clearState`).

## Approval system E2E flows

Stage G of [`docs/plans/260417_approval_consolidation_closeout.md`](../plans/260417_approval_consolidation_closeout.md) shipped three Maestro flows that exercise the Stage D bottom sheets + Stage B capability-token wiring + Stage 6 conversational resolution path end-to-end on a device.

| Flow | Exercises |
|------|-----------|
| [`.maestro/conflict_resolve_with_rebel.yaml`](../../mobile/.maestro/conflict_resolve_with_rebel.yaml) | Open the inbox, tap the **inline** "Resolve with Rebel" callout button on the seeded conflicting staged file, confirm the conversation screen opens (the app mints a Stage B capability token + pushes a prefilled conversation). Stops at conversation-open; semantic resolution is eval territory. |
| [`.maestro/conflict_keep_mine_keep_theirs.yaml`](../../mobile/.maestro/conflict_keep_mine_keep_theirs.yaml) | Tap the **inline** "Keep mine" callout button (`resolveConflict(id, 'keep-staged')`, mints a capability token); confirm the conflict callout disappears as the store broadcast removes the resolved file. "Keep theirs" is symmetric (same handler). |
| [`.maestro/tool_approval_sheet.yaml`](../../mobile/.maestro/tool_approval_sheet.yaml) | Open the inbox, confirm the seeded tool-approval card renders, tap the **inline** Approve action, confirm the card disappears once resolved server-side. **NOTE:** exercises the inline approve path — the detail sheet + `PrincipleOptionsPicker` "approve-always" path is a known gap (sheet renders empty in this harness, see Gotchas below); still unit-covered. |

### Backend state prerequisites

The approval/conflict flows depend on pre-seeded inbox state — a staged file with a conflict, and a pending tool approval. This is now produced deterministically by the **test-mode seed endpoints** (no manual desktop driving needed):

- `POST /__e2e/seed/tool-approval` → a pending tool approval (`toolUseID` `e2e-tool-approval-1`).
- `POST /__e2e/seed/staged-file-conflict` → a staged file with a real hash-divergence conflict.
- `POST /__e2e/seed/conversation` → one conversation ("Seed conversation for Maestro").
- `POST /__e2e/reset` → clears pending approvals + staged files + conversations.

These are wired through the cloud's test-mode `e2eSeed` ops (`cloud-service/src/bootstrap.ts`, populated only under `REBEL_E2E_TEST_MODE=1` after the data-root guard) and are invoked by `e2e-mobile.sh` **before every flow** (the flows consume their fixtures). If you run a flow by hand against a cloud where the fixture wasn't seeded, it fails at `assertVisible: id: "conflict-callout"` / `id: "inbox-approval-section"` — a **prerequisite-not-met** failure, not a regression. (Driving the desktop app to produce real staged conflicts remains the most realistic path for exploratory testing.)

### Flow design choices (why each YAML is shaped this way)

- **`rebel://tasks` deep link.** The flows open the inbox via `rebel://tasks` rather than tapping the bottom tab bar because tab-bar taps in Maestro rely on `accessibilityLabel` matching, which is locale-sensitive. The `tasks` target is parsed by [`src/shared/navigation/urlParser.ts`](../../src/shared/navigation/urlParser.ts) and mapped to `/(tabs)/inbox` inside [`mobile/app/+native-intent.ts`](../../mobile/app/+native-intent.ts) -- a stable deep-link contract that doesn't shift with localisation.
- **`capabilityToken` assertion uses `copyTextFrom` + `assertTrue`.** The seed prompt is ~8 KB and most of it isn't visible on screen at once, so `assertVisible: { text: "..." }` against the `capabilityToken` line is unreliable. Instead the flow copies the `conversation-input` value into `${maestro.copiedText}` and asserts the copied string contains `Capability token:`. This works regardless of where the TextInput is scrolled.
- **Inline-vs-sheet tap ambiguity.** The `ConflictCallout` renders inside both `StagedFileCard` (inline on the inbox) AND `StagedFileApprovalSheet` (inside the detail sheet). Tapping a staged-file card's centre can land on an inline callout button, which fires the same handler as the sheet's button but skips the sheet open. The "Resolve with Rebel" flow handles both outcomes with a `runFlow` conditional; the Keep-mine flow exercises the inline button directly because the end state is identical either way.
- **Stopping before semantic resolution.** `conflict_resolve_with_rebel.yaml` stops after the agent turn kicks off (stop button visible) rather than asserting the conflict was actually resolved. Asserting semantic resolution requires a deterministic LLM response which Maestro cannot guarantee; the semantic behaviour is covered by [`evals/conflict-resolution.ts`](../../evals/conflict-resolution.ts) in deterministic mode and `npm run eval:conflict-resolution:live` in live-agent mode. See [WRITING_EVALS.md § Conflict Resolution Eval](WRITING_EVALS.md#conflict-resolution-eval-evalsconflict-resolutionts).

## Adding new Maestro flows

1. Drop a new `*.yaml` in `mobile/.maestro/` following the conventions in [`login.yaml`](../../mobile/.maestro/login.yaml) / [`conversations.yaml`](../../mobile/.maestro/conversations.yaml): `appId` at the top, `---` separator, steps below.
2. Use existing `testID`s where possible. Prefer testIDs over `accessibilityLabel` / visible-text matches because:
   - testIDs are locale-agnostic.
   - Visible text can change with product-voice tweaks.
   - `accessibilityLabel` is localised; testIDs are not.
3. When a testID doesn't exist, add it inline (the change is typically a 1-line `testID={...}` on a non-interactive Text or View element near the header of the target component).
4. Add a signpost row in the table above so future agents can find it.

## Troubleshooting

- **"No simulator/emulator found."** Boot one manually first (Xcode: `xcrun simctl boot "iPhone 15"`; Android: `emulator @Pixel_7`).
- **Flow hangs at `assertVisible`.** Most often the app isn't paired or isn't on the expected screen. Run `.maestro/login.yaml` first. If the app is paired but the screen is wrong, check the deep link (`rebel://...`) -- mobile's deep-link parser is in [`mobile/app/+native-intent.ts`](../../mobile/app/+native-intent.ts).
- **`copyTextFrom` returns empty on Android.** Some Android builds don't expose TextInput's value to the accessibility tree. Verify on iOS first; file a bug with reproduction steps if Android-specific.
- **Sheet doesn't open when the flow taps the card.** The tap centre may have landed on a nested interactive element (e.g. the inline "Resolve with Rebel" button). The `conflict_resolve_with_rebel.yaml` flow handles this with `runFlow`; other flows can be updated similarly, or a small `testID` can be added to a non-interactive Text in the card header so the tap falls through to the outer TouchableOpacity.

## Hard-won gotchas (verified 2026-06-07, dev-Mac iOS 26.5 simulator)

These cost real debugging time on the deterministic lane. Read before touching pairing, the tab bar, or the flow catalog.

- **Dev-mode LogBox silently eats ALL tab-bar taps.** In a `__DEV__` (Metro) build, React Native renders the LogBox warning notification (`"! Open debugger to view warnings."`) as a transparent overlay pinned to the bottom of the screen — directly on top of the custom tab bar. Maestro/XCUITest taps on the mic / "Type" / bottom-tab buttons report "COMPLETED" but their `onPress` never fires (raw point-taps too). Release / `e2e`-profile builds have `__DEV__===false` and no LogBox, so the tab bar works for real users — this is purely a dev-build artifact. Guard: `mobile/app/_layout.tsx` calls `LogBox.ignoreAllLogs(true)` when `EXPO_PUBLIC_REBEL_E2E==='1'`. If tab-bar taps mysteriously no-op, dump `maestro hierarchy` and look for an overlay node with that accessibilityText.
- **Pair to `localhost`, never the `127.0.0.1` IPv4 literal.** The local cloud bundle binds the IPv6 wildcard (`*:PORT`). The host's `curl 127.0.0.1` works dual-stack, but the simulator app's `fetch` to the IPv4 literal does not reach the IPv6 listener and times out — `pair()` then reports *"Server is waking up or unreachable."* `localhost` resolves to `::1` and connects. `e2e-mobile.sh` uses `http://localhost:$PORT` for the iOS pairing URL.
- **Deep-link query values must be percent-encoded.** `rebel://e2e/pair?cloudUrl=http://...` with an unencoded `://` is mangled by the query parser → broken URL. The harness computes a percent-encoded `CLOUD_URL_ENC` for `login.yaml`.
- **Establish pairing against a FULLY-BOOTED app, from the harness — not inside a Maestro flow.** A deep link delivered right after `launchApp clearState` races the JS-bundle hydration and leaves the `(e2e)/pair` route stuck on its loading spinner (measured: wait-for-home-then-pair passes 5/5; the cold ordering fails 4/4). The harness step **[4.5/6]** launches the app then delivers `rebel://e2e/pair` via `xcrun simctl openurl` (the `(e2e)/pair.tsx` route also retries `pair()` 6×). The resulting pairing lives in the iOS **Keychain**, which `launchApp: clearState` does NOT clear — so `login.yaml` is now a pure boot-and-stay-paired smoke check (clearState → wait `home-screen`) and every other flow inherits the pairing. For a guaranteed-fresh sim use `xcrun simctl erase` (wipes the Keychain), then let the harness re-pair.
- **Re-seed before every flow.** The approval/conflict flows consume their fixtures (resolve the approval / drop the staged file), so a single up-front seed leaves later flows with nothing to act on. `e2e-mobile.sh` step [6/6] resets + re-seeds all fixtures before each flow and runs each as its own `maestro test`.
- **KNOWN GAP — `ToolApprovalSheet` detail view renders empty in this harness.** Tapping the approval card body opens only `tool-approval-sheet-backdrop`; no sheet content mounts (no JS error — suspected bottom-sheet detent or seeded-approval shape mismatch). `tool_approval_sheet.yaml` therefore exercises the **inline** `approvals-approve-button-…` action (resolves the approval reliably); the sheet + `PrincipleOptionsPicker` "approve-always" path is still only unit-covered. **Needs investigation — could be a real bug or a seed mismatch.**
