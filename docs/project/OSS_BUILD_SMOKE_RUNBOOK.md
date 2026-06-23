---
description: "OSS build smoke checks for the Mindstone carve-out: scripted static gate plus manual packaged-app checks."
last_updated: "2026-06-23"
---

# OSS Build Smoke Runbook

This runbook covers the B3 Mindstone carve-out smoke. The durable scripted gate is `scripts/check-oss-build-smoke.ts`; the dynamic checks below need a packaged desktop app and a network observer.

See also:

- `docs/plans/260607_b3-carveout-stages-2-10/PLAN.md` — Stage S9, Amendment A6(A)/(D)
- `scripts/check-oss-build-smoke.ts` — static bundle and OSS auth-provider contract gate
- `src/core/services/ossNullAuthProvider.ts` — OSS pseudo-user auth provider
- `src/main/oss/private-mindstone-stub/` — public OSS replacement for the private Mindstone bootstrap

## Scripted Gate

Run after building with the private tree detached:

```bash
rm -rf out
mv private private.oss-smoke-detached
trap 'mv private.oss-smoke-detached private' EXIT
npm run build:legacy
npm run validate:oss-smoke
```

Use `npm run build:legacy` for this gate. It writes the `out/main` and `out/renderer`
Electron-vite outputs that the smoke script scans; `npm run build` drives the Forge
packaging path and writes different intermediate output.

The script asserts:

- Built main plus renderer executable bundles exist in the expected Electron-vite output roots.
- The bundle contains the OSS stub marker `private-mindstone-stub`.
- Executable JS under `.vite/build`, `out/main`, and `out/renderer` contains none of the private auth/relay markers: `private/mindstone/`, `private-mindstone-real`, `DESKTOP_REBEL_AUTH_PROVIDER`, `ElectronCurrentUserProvider`, `MindstoneAuthProvider`, the Mindstone auth-only endpoint paths, or the relay submit path `/api/contribution/v1/submit`.
- Shipped `*.js.map` files do not include source paths under `private/mindstone/` and do not embed private auth function bodies such as `fetchAuthConfig()` or `initiateLogin()`.
- `OSS_NULL_AUTH_PROVIDER` reports `licenseTier: 'teams'`, `isOssBuild: true`, returns `null` from `getAccessToken()`, sets the global license tier to `teams`, and makes zero `fetch` calls.

Per A6(D), `/api/config` and `/api/ping` are not B3 leak markers. `/api/config`
references can remain in public comments until the B4/B6 config-consumer work, and
`/api/ping` is used by the public provider-reachability diagnostic for arbitrary
provider URLs. The S9 gate is scoped to real Mindstone auth/relay executable-code
leaks and private source shipped in sourcemaps.

`npm run validate:oss-smoke -- --contract-only` runs only the provider-contract assertions.

## Launch Gate (boot smoke)

The scripted gate above SCANS the bundle; it never LAUNCHES the app, so it cannot catch a
runtime boot crash. A whole class of startup crashes is invisible to a static scan: a module
that reads a boundary singleton (e.g. `getPlatformConfig()`) at MODULE-LOAD time, before
`src/main/bootstrap.ts` initialises it, throws `PlatformConfig not initialized` and the app
dies with `App threw an error during load` before any window appears. This shipped in the OSS
build (toolIndexService + bundledHttpMcpManager read platform config at import time) and was
only found by manually launching the built app — see
[260622_fix-oss-toolindex-boot-crash](../plans/260622_fix-oss-toolindex-boot-crash/PLAN.md).

`npm run validate:oss-boot-smoke` closes that gap as a SINGLE command: it BUILDS the faithful
OSS mirror FORGE bundle, then LAUNCHES it with an isolated user-data dir and asserts the main
process boots PAST bootstrap (reaches `app.whenReady`) with no load-time boundary crash.

```bash
npm run validate:oss-boot-smoke
```

That one command runs `scripts/run-oss-boot-smoke.mjs`, which:
1. `scripts/build-oss-mirror-bundle.mjs` — produces the faithful bundle (see below), then
2. `scripts/check-oss-boot-smoke.ts --main <bundle>` — launches + observes the boot.

**Why the TRANSFORMED MIRROR, not `mv private`.** The faithful public-build target is the
output of `mirror/transform.ts` — the exact source that ships to the public OSS repo — NOT the
canonical checkout with `private/` merely detached (`mv private`). They differ in
boot-relevant ways:
- The transform applies content substitutions, dependency stripping (e.g. rudderstack removed
  from `package.json`), and path deletions. `mv private` skips all of that, so a crash
  introduced or masked by a substitution would be invisible to it.
- In the mirror, `private/` contains only the stub `README.md`; `private/mindstone/src/bootstrap.ts`
  is GONE. So `vite.main.config.mjs`'s `existsSync(privateMindstoneBootstrapPath)` is false and
  `@private/mindstone` resolves to `src/main/oss/private-mindstone-stub` — exactly the
  public-build code path. `mv private` happens to reach the same alias, but only the full
  transform reproduces the *whole* OSS module graph faithfully.

The build script transforms into a fresh empty dir (the transform requires an empty output —
see `ensureWritableOutputRoot`), syncs into a gitignored workdir `.local/oss-boot-mirror/source/`,
hardlink-clones `node_modules` from the repo (`cp -al`, hash-gated on `package-lock.json` so
repeat runs are fast; falls back to `npm ci` if the clone fails), then spawns `electron-forge
start` and kills it once `.vite/build/bootstrap.js` exists.

Manual / CI use — skip the build and launch an existing bundle:

```bash
npm run validate:oss-boot-smoke -- --main <path>/.vite/build/bootstrap.js
npm run validate:oss-boot-smoke -- --force-deps    # rebuild the workdir node_modules clone
```

Key points:
- **Target the FORGE bundle (`.vite/build/bootstrap.js`) or a packaged app — NOT `out/main`
  (`build:legacy`).** Legacy uses electron-vite lib mode which INLINES the lazily-imported
  `./index`, so it over-reports offenders that never crash in the shipped Forge build. Legacy
  is scan-only (it feeds the static gate above).
- FAIL = Electron prints `App threw an error during load` (its fatal main-entry-load signal)
  or the process exits non-zero before booting. A bare `...not initialized. Call setX()` line
  is NOT a failure on its own — several boundaries log that as a gracefully-handled
  deferred-binding warning at module load.
- PASS = bootstrap reaches `--- app start` and the main process gets into `index.ts`'s
  `whenReady` handler (a renderer `ERR_CONNECTION_REFUSED` when launched without a dev server
  is EXPECTED and fine — we assert MAIN boots, not the renderer).
### CI wiring (fail-closed publish gate)

This boot smoke is wired into CI as a **fail-closed gate on the OSS mirror publish** (shipped
2026-06-23, `docs/plans/260623_oss-boot-smoke-ci/PLAN.md`): a boot-crashing OSS build physically
cannot publish to the public mirror.

- **Where it lives.** A composite action `.github/actions/oss-boot-smoke-linux/action.yml` holds
  the Linux steps once (apt GUI libs, Node 22, token-gated submodule checkout, `npm ci`, then two
  xvfb steps — `Build OSS mirror bundle` via `scripts/build-oss-mirror-bundle.mjs`, then
  `Launch OSS boot smoke` via `scripts/run-oss-boot-smoke.mjs --main <bundle>` run from the
  transformed-mirror workdir). The composite is consumed by two callers:
  - the `boot-smoke` job in `.github/workflows/reusable-mirror-validation.yml` (the publish gate);
  - the standalone `.github/workflows/oss-boot-smoke.yml` (the manual / on-demand button).
- **When it runs.** On **every** `mirror-publish` build_scan (dry-run and production alike), and
  on demand via the standalone workflow.
- **How it gates.** The `boot-smoke` job runs on `ubuntu-22.04` parallel to `validate`/`test`/
  `test-rest` and feeds the fail-closed `gate` aggregation: a skipped, failed, or cancelled
  boot-smoke forces `gates_passed=false`, which blocks the privileged `publish` job
  (`mirror-publish.yml`, gated on `build_scan.outputs.gates_passed == 'true'`). The job is fast
  (~3.5 min total, well under the other gate jobs' wall-clock) so the gate is genuinely
  parallel / near-free.
- **Run it locally.** `npm run validate:oss-boot-smoke` (same command, same scripts).
- **Run it on Linux manually.** Push to an `oss-boot-smoke/**` branch (push-triggered — dispatch
  off the default branch is unreliable) or `workflow_dispatch` the standalone `oss-boot-smoke.yml`.
- **Linux gotcha (for future maintainers).** `electron-forge start` (which the build spawns)
  orphans electron + the renderer dev-server; the build must SIGKILL the whole process **group**,
  or an inherited fd keeps the CI step's stdout open and the step hangs after the bundle is built.
  See the Decision Log in `docs/plans/260623_oss-boot-smoke-ci/PLAN.md` (the first Linux run hit
  exactly this).
- **Out of scope (state it plainly).** This Linux gate deliberately does **not** catch
  platform-specific *native-module-at-import* issues. The root cause it targets is
  bundler-determined module-init ordering, which is platform-independent — so a Linux run catches
  the same class macOS would. Per-OS packaged builds cover native-module-at-import separately. This
  Linux/mirror gate is also **distinct from** `release.yml`'s macOS `Desktop Boot Smoke`
  (`npm run package:boot-smoke`), which launches the *commercial* packaged `.app` and — since
  **2026-06-23** — **blocks publish on both channels** (darwin-only; promoted from advisory). See
  [CI_PIPELINE § E2E gating criteria](./CI_PIPELINE.md#e2e-gating-criteria) for the authoritative
  wiring and rollback.

## Chief Session Checks

These are the dynamic checks the Chief should run during S9 when a desktop launch environment is available:

- Package and launch the OSS/stub app from a fresh user data directory, for example `MINDSTONE_REBEL_USER_DATA_DIR=/tmp/rebel-oss-smoke`.
- Confirm Settings -> Account shows the guest pseudo-user identity and no sign-in flow.
- Confirm the effective license tier is `teams`.
- Confirm contribution-sharing UI is absent in Settings and the MCP build card. Per A6(A), S9 does not require a working GitHub submission path.
- Exercise auth IPC from the running app where practical: `auth:get-state` returns the `oss-user` authenticated state, `auth:get-config` returns the static OSS config, and login/OTP channels return typed OSS-unavailable errors.

## Pre-Launch Manual Checks

Run these before treating an OSS desktop build as release-ready:

- Observe outbound HTTP with mitmproxy, Charles, or equivalent while launching from a fresh user data directory. The B3 requirement is no auth-path egress to `rebel.mindstone.com`; managed cloud/subscription/dashboard endpoints remain B6 scope and are not part of this S9 gate.
- Complete a Slack OAuth-MCP round trip through the public `rebel-auth.mindstone.com` worker and confirm the token lands. That worker is intentionally public and should remain usable in OSS builds.
- Re-check the contribution-sharing surfaces after first config load. They should stay hidden in OSS mode, not flicker back into a relay option.
- Keep the scripted gate in the release checklist output so any later promotion from non-blocking CI to blocking CI has a concrete command and recent result.
