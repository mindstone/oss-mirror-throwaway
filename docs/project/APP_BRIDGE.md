---
description: "Developer reference for the Rebel App Bridge: localhost HTTP+WS server, pairing flow, capability registry, command router, and the Rebel browser extension that drives `rebel_browser_*` MCP tools."
last_updated: "2026-04-21"
audience: "contributors"
---

> Non-technical user guide: see `rebel-system/help-for-humans/browser-extension.md`

# Rebel App Bridge

The **App Bridge** is a small localhost HTTP + WebSocket server that hosts the
surface every Rebel-companion app talks to — the browser extension, the Office
sidecar (Stage 8), and any future desktop-app shim. It pairs once, accepts
commands over WS, and dispatches them via a token-gated HTTP relay that the
bundled `rebel-app-bridge` MCP server turns into first-class `rebel_browser_*`
tools.

## Why it exists

Rebel needs an agent that can *do* things in tools outside the Electron
window — read a webpage in Chrome, fill a form, drop a note into Word. We
refuse to ship browser-control code inside the Electron process (blocked by
Chrome's sandbox, ugly in Office). Instead the companion apps hold the DOM
handles, and the App Bridge is the trust boundary between them and Rebel's
agent runtime. Security posture, not convenience, is the first-class concern.

## Reading order (signposts)

### Start here
- `docs/plans/260418_rebel_app_bridge_and_browser_extension.md` — full planning
  doc with requirements (R1-R33), decisions (D1-D33), staged rollout, and
  risk register. The authoritative source of truth for intent.

### Core primitives
- `src/core/appBridge/shared/protocol.ts` — wire protocol (auth, register,
  command, response, error), capability keys, port constants, WS close codes.
- `src/core/appBridge/shared/errors.ts` — `ErrorCode` enum + HTTP/WS mappings.
- `src/core/appBridge/server/wsServer.ts` — WebSocket upgrade + auth/register
  state machine (`awaiting-auth` → `awaiting-register` → `registered`).
- `src/core/appBridge/server/originGuard.ts` — `Origin` + `Host` pre-upgrade
  checks (chrome-extension://, moz-extension://, localhost:<port>).
- `src/core/appBridge/server/pairingStore.ts` — 6-digit codes, TTL, attempt
  burn (10 wrong guesses = burn the pool, R7).
- `src/core/appBridge/server/tokenStore.ts` — pair tokens, router-internal
  token (R5 / D13), token-kind classification (`pair` vs `router-internal`).
- `src/core/appBridge/server/pairRoutes.ts` — `/pair/start`, `/pair/claim`,
  `/pair/revoke`. Start is router-internal-only outside dev.
- `src/core/appBridge/server/httpRelay.ts` — `/apps/:appId/:capabilityId`;
  router-internal-token-only, never accepts pair tokens (D13).
- `src/core/appBridge/server/capabilityRegistry.ts` — per-app capability
  catalogue. Populated on `register`, cleared on disconnect.
- `src/core/appBridge/server/commandRouter.ts` — correlates `command` →
  `response` frames, enforces retry idempotency (R19 / D22), rejects pending
  on app disconnect.
- `src/core/appBridge/server/connectionManager.ts` — per-app singleton
  connection + heartbeat; supersede semantics on reconnect.
- `src/core/appBridge/installer/` — browser detection (`browserDetect.ts`) and 
  extension folder extraction logic (`extensionFolder.ts`). Pure, platform-agnostic.
- `src/core/appBridge/index.ts` — `createAppBridge(options)` — the factory
  every host (Electron main, cloud-service, tests) calls. Returns the handle
  with `port`, `stateFilePath`, `routerInternalToken`, `stop()`.

### Desktop wiring
- `src/main/services/appBridgeManager.ts` — lifetime owner of the bridge on
  desktop. Starts on app ready, writes state file to userData,
  de-registers on quit.
- `src/main/services/appBridgeInstallerService.ts` — orchestrates browser 
  detection, copies the bundled extension to `userData`, and opens the 
  `chrome://extensions` page for side-loading.
- `src/main/ipc/appBridgeHandlers.ts` — IPC contracts the Settings UI calls:
  `app-bridge:start-pair`, `app-bridge:claim-pair`, `app-bridge:revoke`,
  `app-bridge:snapshot`, `app-bridge:restart-dynamic-port`, plus installer 
  channels (`app-bridge:detect-browsers`, `app-bridge:extract-extension`, etc.).
- `resources/mcp/rebel-app-bridge/` — bundled stdio MCP server the agent
  calls. Discovers the bridge via the state file, presents the router-internal
  token, forwards MCP tool calls as `/apps/:appId/:capability` POSTs. Also 
  hosts the `__host` namespace for native local capabilities like 
  `rebel_bridge_list_browsers`.
- `src/shared/cloudChannelPolicies.ts` — `app-bridge:*` channels are desktop-
  only (the cloud service has no local bridge).

### Browser extension
- `packages/browser-extension/src/manifest.json` — MV3 manifest, allow-listed
  permissions (`activeTab`, `scripting`, `offscreen`), no broad host grants.
- `packages/browser-extension/src/background/serviceWorker.ts` — service
  worker that owns browser scope resolution, tab-aware side-panel opening,
  capability dispatch, and offscreen-document nudges.
- `packages/browser-extension/src/offscreen.html` + `offscreen.ts` — keeps
  the WS open when the service worker sleeps.
- `packages/browser-extension/src/content/contentScript.ts` — DOM reads
  (article text, selection, URL) and DOM writes (fill, click). Enforces
  the sensitive-field / destructive-click policy at the boundary so even a
  compromised agent can't bypass it.
- `packages/browser-extension/src/popup/` — connection/status popup with
  quick actions and side-panel launch.
- `resources/mcp/rebel-app-bridge/bridge-discovery.js` — shared helper to
  locate the running bridge (state file location, protocol version, PID
  health check).

### UI (Settings → Connectors)
- `src/renderer/features/settings/utils/setupPromptGenerator.ts` — seeds the
  deterministic `rebel_bridge_prepare_install` setup prompt for Rebel Browser.
- `src/renderer/features/settings/components/ExpandedConnectionCard.tsx` — connection
  card inside the unified connectors panel: state (Paired / Reconnecting /
  Port conflict / Replaced), revoke, intent-queue indicator.
- `src/renderer/features/settings/hooks/useUnifiedConnections.ts` — query hook
  that merges MCP connectors + the App Bridge snapshot.

### Tests and evals
- `src/core/appBridge/__tests__/*.test.ts` — unit tests for every primitive
  (token scope, pairing TTL, WS state machine, command idempotency, origin
  guard, http relay auth).
- `tests/e2e/app-bridge/*.spec.ts` — 8 Playwright scenarios covering the
  user-visible behaviours: pair flow, read page, fill form happy/reject,
  click destructive reject, offscreen respawn, token revoke, port
  conflict fallback. Run via `npm run test:e2e:bridge-browser` (headful
  Chromium, skipped on headless Linux without `CI_XVFB=1`).
- `evals/__tests__/browser-control-safety-fixtures.test.ts` — structural
  guard for safety fixtures 154-157 (sensitive field block / allow,
  destructive click block / allow). Runs in `npm test`.
- `evals/fixtures/safety-prompt/15{4,5,6,7}_browser-control_*.json` — the
  LLM-evaluated fixtures. Runs nightly via
  `.github/workflows/eval.yml` (safety-prompt matrix entry).
- Quick regression: `npm run eval:app-bridge-safety` (vitest, no API key).

### Build and release
- `scripts/build-browser-extension.ts` — builds `packages/browser-extension`,
  produces `dist/browser-extension.zip` used by Playwright and side-load
  installation. Invoked via `npm run build:browser-extension`.
- `resources/connector-catalog.json` — `bundled-app-bridge` entry that advertises
  the bridge + extension pairing flow in Settings → Connectors.
- CHANGELOG.md + `rebel-system/help-for-humans/changelog.md` — user-facing
  release notes.

## Design principles (Stage 9 consolidation)

1. **Security first.** Every new surface goes through origin + token checks
   *before* any async work. We fail-closed and log — never silently succeed.
2. **Policy at the extension boundary.** The bridge forwards commands; the
   extension enforces sensitive-field / destructive-click policy and returns
   a structured `SAFETY_BLOCKED` that the agent surfaces to the user. The
   bridge-side tests (`fill-form-safety-reject.spec.ts`, `click-destructive-
   reject.spec.ts`) lock this down.
3. **Deterministic retries.** Duplicate `commandId`s dispatch at most once;
   late responses after a retry don't clobber earlier state (R19 / D22).
4. **Dynamic port resilience.** On `EADDRINUSE`, the bridge walks the fallback
   list (52320-52325 by default) and writes the actual port into the state
   file; the extension's discovery helper re-reads on mismatch.
5. **Core-first.** All business logic lives in `src/core/appBridge/`; only
   main-process wiring (Electron `app.on('ready')`, userData paths, Sentry
   boundary) lives in `src/main/`. Cloud-service doesn't host a bridge
   (there's no local extension to pair with).

## Installer service

The installer service (`src/main/services/appBridgeInstallerService.ts`) coordinates the process of setting up Rebel Browser on the user's machine without the need for manual file manipulation by the user.

- **What it does:** Detects installed browsers, extracts the bundled extension payload into the user's `userData` folder, reveals the extracted folder in the OS file explorer, and opens the target browser's extension management page for side-loading.
- **IPC channels:**
  - `app-bridge:detect-browsers` — returns a list of compatible browsers found on the system.
  - `app-bridge:extract-extension` — performs the actual extraction to disk.
  - `app-bridge:reveal-extension-folder` — opens the OS file explorer to the newly extracted folder.
  - `app-bridge:open-browser-extensions-page` — opens the browser to its native extensions manager (e.g. `chrome://extensions`).
- **`__host` MCP namespace:** Contains `rebel_bridge_list_browsers`, handled directly inside the MCP subprocess rather than relayed to the extension. Detection logic is duplicated in `host.js` (`resources/mcp/rebel-app-bridge/tools/host.js`) because the MCP subprocess is a plain Node script that cannot import TypeScript files from core.
- **Crash-consistent extraction:** When extracting the extension, the service uses a staging directory and an atomic rename to overwrite any existing extension folder. This ensures a failure mid-extraction doesn't leave the user with a broken extension.
- **Portable browsers:** Supports `REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS` (e.g. `chrome:C:\My Chrome\chrome.exe`) to accommodate users who install browsers in non-standard locations.

## Install resilience (deterministic prepare-install flow)

The Rebel Browser setup path is now deterministic-tool-first. Settings seeds a
short setup prompt that tells the agent to call `rebel_bridge_prepare_install`;
the older browser-install skill is fallback/education only, not the primary
state machine. Chromium still requires a manual user handoff for loading an
unpacked extension, so the tool prepares the local state and returns structured
next steps rather than pretending the browser security UX can be bypassed.

### Architecture overview

1. The conversation calls `rebel_bridge_prepare_install({})` immediately.
2. If multiple browsers are available, the tool returns
   `setupStatus: "needs_browser_choice"` plus deterministic `browserChoices`; the
   agent asks the user which browser to use, then calls the same tool with
   `browser_id`.
3. For a selected browser, the host route extracts or refreshes the managed
   extension folder, preserves/reuses the boot-token install session on safe
   retries, reveals the folder, and opens the browser extensions page when
   possible.
4. The tool returns a redacted step ledger (`attemptId`, `setupStatus`,
   `steps`, optional `installSessionAlias`, and `nextStep`). It does not return raw
   install paths, binary paths, install-session ids, router tokens, or boot-token contents.
5. `setupStatus: "awaiting_user_handoff"` is the normal post-prepare state:
   the user still needs to enable Developer Mode if needed and load or reload
   the revealed extension folder. `setupStatus: "degraded"` means preparation
   succeeded but one convenience step, such as revealing the folder or opening
   the browser page, needs manual help.
6. After the user completes the browser handoff, the agent verifies with
   `rebel_browser_status({})` and may use `rebel_bridge_diagnose` for
   aggregate-only troubleshooting.

### Host tools that make the install flow work

- `rebel_bridge_prepare_install` — canonical setup entry point. It detects
  browsers, prepares the extension, opens/reveals what it can, and returns the
  user handoff state. Prefer this for Setup with Rebel.
- `rebel_bridge_list_browsers` — diagnostic/manual browser detection plus the
  generic sentinel.
- `rebel_bridge_extract_extension` — lower-level manual recovery tool for
  writing the managed extension folder.
- `rebel_bridge_reveal_extension_folder` — lower-level manual recovery tool for
  showing that folder in the OS file manager.
- `rebel_bridge_open_extensions_page` — lower-level manual recovery tool for
  opening the browser's extensions manager or returning a structured manual
  fallback.
- `rebel_bridge_diagnose` — aggregate-only install diagnosis when the extension
  still is not usable after the browser handoff.

### Generic browser sentinel: `none-of-the-above`

`rebel_bridge_list_browsers` always appends the sentinel browser id
`none-of-the-above` as the final option. That keeps the install flow usable
when the detector finds nothing helpful or when the user is on a Chromium fork
we do not ship a first-class recipe for yet. The downstream tools accept that
id and return manual instructions rather than pretending automation succeeded.

### Extension auto-open compatibility

The extension tries to open its popup automatically after install, but Chromium
forks disagree about whether that counts as a user gesture. Treat the current
matrix as empirical, not canonical; telemetry and field reports fill in the
gaps over time.

| Browser family | Expected behaviour |
| --- | --- |
| Chrome / Edge | Popup auto-open is usually accepted. |
| Brave / Arc / Comet | Popup auto-open is not reliable; the toolbar icon + badge fallback matters. |
| Other Chromium forks | Assume nothing. The agent should tell the user to click the Rebel icon if the popup does not appear. |

### Cross-profile threat note

The install flow is intentionally profile-aware. A recently minted pairing
session can simplify consent only for the extension instance that appeared
during that same install window. It does **not** grant blanket trust to every
browser profile on the machine. That matters on shared desktops, multi-profile
browser setups, and any case where more than one Chromium profile can talk to
the bridge.

### NMH manifests (latent)

Chunk C of the install-delight plan adds latent NMH manifest writing. The
details now live in the dedicated section near the end of this doc so the
installer-service overview can stay brief.

## Common developer tasks

### Add a new capability
1. Append to `CAPABILITY_KEYS` in `src/core/appBridge/shared/protocol.ts`.
2. Register a tool in `resources/mcp/rebel-app-bridge/tools/` that references
   it.
3. Implement the handler in `packages/browser-extension/src/content/` (DOM)
   or `serviceWorker.ts` (non-DOM) and advertise it during `register`.
4. Add an eval fixture (if the capability has a safety dimension) and a
   `tests/e2e/app-bridge/` scenario.
5. Rebuild the extension: `npm run build:browser-extension`.

### Debug a pair failure
- Check `~/Library/Application Support/mindstone-rebel/logs/*.log` for
  `app-bridge.pair` breadcrumbs. `pair-claim-fail` with `code: BAD_REQUEST`
  means 10 wrong guesses burned the pool — the user needs a fresh code.
- Check the extension popup for the "Connection taken by another browser"
  state; the bridge only allows one WS per `appId` + `clientId` pair
  (D11 supersede).

### Debug a dispatch failure
- `APP_NOT_CONNECTED` (503) → extension isn't registered yet. Look at
  `CapabilityRegistry.listAppIds()` in the bridge.
- `CAPABILITY_NOT_SUPPORTED` (404) → extension connected but didn't advertise
  that capability. Likely a forgotten `register` update.
- `COMMAND_TIMEOUT` (504) → extension took too long. Default 30 s,
  overridable per-call via `timeoutMs`.
- `IDEMPOTENT_DROP` (409) → retry came after the original executed (R19).

## NMH manifests (latent)

These files are written now for forward compatibility only. The relay binary
is **not** bundled yet, so Chromium still has nothing runnable to launch and
the extension remains on the WS transport.

- **Follow-ups before activation:** code-sign the relay binary, add relay-side
  auth that mirrors the HTTP bridge token handshake, and wire Windows registry
  integration.
- **Pure builder:** `src/core/appBridge/installer/nmhManifest.ts` resolves the
  per-OS manifest paths and content without importing Electron.
- **Hardened writer:** `src/main/services/appBridgeInstallerService.ts` does
  the symlink-escape ancestry check, atomic `wx` temp-write + rename,
  owner-only permissions, and owned-file-only unregister.

## Related docs
- `docs/project/SAFETY_SYSTEM_OVERVIEW.md` — where the `browser-control`
  safety category fits.
- `docs/project/MCP_ARCHITECTURE.md` — how the bundled `rebel-app-bridge`
  stdio server slots into the agent's tool catalogue.
- `docs/project/SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` — dev env flags
  (`REBEL_APP_BRIDGE_DEV`, `VITE_REBEL_APP_BRIDGE_DEV`).
