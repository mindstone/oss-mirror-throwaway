---
description: "How the mobile (Expo/EAS) builds receive their 4 telemetry keys — the GitHub-secrets → EAS-environment pass-through, public-vs-secret classification, rotation, build verification, and the local-dev/e2e exclusions"
last_updated: "2026-06-14"
---

# Mobile telemetry keys — GitHub → EAS pass-through

How the mobile (React Native / Expo) app gets the credentials for Sentry (error
monitoring) and RudderStack (analytics) into its production builds, and why it
takes an extra CI step that the desktop/cloud surfaces don't need.

This is the **key-delivery** doc. For the telemetry *behaviour* (what's captured,
redaction, privacy), see:

- Error monitoring: [ERROR_MONITORING_AND_SENTRY.md § Mobile](./ERROR_MONITORING_AND_SENTRY.md#mobile-react-native--expo)
- Analytics: [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md § Mobile](./ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md#mobile-react-native--expo)
- Store privacy declarations: [MOBILE_PRIVACY_COMPLIANCE.md](./MOBILE_PRIVACY_COMPLIANCE.md)

---

## The 4 keys

| GitHub secret | EAS env var (mobile) | Read by | Visibility |
| --- | --- | --- | --- |
| `SENTRY_DSN` | `EXPO_PUBLIC_SENTRY_DSN` | `mobile/src/utils/sentry.ts` (`resolveSentryDsn`) at runtime | `plaintext` (public client key) |
| `RUDDERSTACK_WRITE_KEY` | `EXPO_PUBLIC_RUDDERSTACK_WRITE_KEY` | `mobile/src/analytics/analytics.ts` (`resolveWriteKey`) at runtime | `plaintext` (public client key) |
| `RUDDERSTACK_DATA_PLANE_URL` | `EXPO_PUBLIC_RUDDERSTACK_DATA_PLANE_URL` | `mobile/src/analytics/analytics.ts` (`resolveDataPlaneUrl`) at runtime | `plaintext` (public client key) |
| `SENTRY_AUTH_TOKEN` | `SENTRY_AUTH_TOKEN` | Sentry Metro/Expo plugin at **build time** (source-map / debug-symbol upload) | **`sensitive`** |

These are the **same** keys the desktop and cloud builds use — the same Sentry
project (`mindstone/rebel`) and the same RudderStack workspace. They live as
**repo- or organization-level GitHub Actions secrets** (no GitHub `environment:`
gating — see the scoping note below), sourced by `.github/workflows/release.yml`
for desktop and by the two mobile workflows for mobile.

`SENTRY_DSN` and `SENTRY_AUTH_TOKEN` are confirmed **repo-level** secrets.
`RUDDERSTACK_WRITE_KEY` and `RUDDERSTACK_DATA_PLANE_URL` were not visible in the
repo secret list, but `release.yml` already consumes them successfully as plain
`${{ secrets.* }}` references for desktop — which proves they resolve for this
repo's workflows (most likely **org-level** Actions secrets granted to
`mindstone/rebel-app`). A plain `${{ secrets.* }}` reference resolves
regardless of whether a secret is repo- or org-scoped.

> **Troubleshooting — if mobile analytics ships inert:** first check that the
> two RudderStack secrets above are granted to this repo (repo Settings →
> Secrets and variables → Actions, or the org admin's secret-access list).

### Public vs secret classification

The three `EXPO_PUBLIC_*` vars are **public client keys** — they are compiled
into the shipped app bundle and are extractable from any installed binary, so
`plaintext` visibility is correct and not a leak. A Sentry DSN and a RudderStack
write key are *designed* to be embedded in clients; abuse is mitigated at the
ingest side, not by hiding the key.

`SENTRY_AUTH_TOKEN` is the **only true secret** here. It is a build-time
credential that authorises uploading source maps / debug symbols to the Sentry
org; it must never ship in the bundle. It is created with **`sensitive`**
visibility and is **not** prefixed `EXPO_PUBLIC_` (so it cannot leak into the JS
bundle). It is consumed only by the Sentry plugin during the EAS build.

> **Why `sensitive`, not `secret`:** EAS loads only **Plain-text + Sensitive**
> environment variables into the build environment — `secret`-visibility vars are
> write-only and are **not** exposed to the build. A `secret` `SENTRY_AUTH_TOKEN`
> therefore can't be read by the Sentry plugin's `sentry-cli`, and symbol upload
> fails with *"Auth token is required"*. `sensitive` is readable by the build but
> masked in logs and the EAS UI — the right level for a build-time credential.
> (Verified live on build run `27512711468`, which loaded only the three
> plaintext vars; an earlier `secret` `SENTRY_AUTH_TOKEN` was absent from the
> build env.) **Visibility changes self-heal:** EAS rejects changing an existing
> var's visibility via `env:create --force` (`"You cannot change a secret variable
> to a non-secret variable"`), so the sync job catches a failed `create`, runs
> `eas env:delete` for that var, and retries `create` fresh at the target
> visibility — all in CI under `EXPO_TOKEN`, with no manual step. (This is why a
> one-off `secret` `SENTRY_AUTH_TOKEN` left over from an earlier run is cleaned up
> automatically on the next build.)

---

## Why mobile needs a pass-through step (the core of this doc)

Desktop/cloud builds run **on the GitHub Actions runner**, so `release.yml` can
read `${{ secrets.* }}` straight into the build's `env:`.

Mobile builds do **not** run on the runner. `eas build` hands the source off to
**Expo's EAS Build servers**, which build off-runner. GitHub Actions secrets do
not travel to EAS. EAS resolves env vars from **its own per-environment store**
(the `production` / `preview` / `development` environments), not from whatever
was set on the runner.

So the runner's job is to **bridge** the two: read the GitHub secrets and write
them into the EAS `production` environment *before* `eas build` runs. The
`production` EAS environment is the one every mobile build uses — both mobile
workflows build with `--profile production`, and `mobile/eas.json` pins
`"environment": "production"` on that profile.

### The CI job

A **single prerequisite job** `sync-eas-telemetry-env` in each mobile workflow
(`.github/workflows/mobile-preview.yml` and
`.github/workflows/mobile-production.yml`) does the sync **once**; every EAS
*build* job declares `needs: [sync-eas-telemetry-env]` so the env is populated
before any build runs.

This replaced an earlier per-build-job step. Running the sync inside each build
job meant the `build-ios` and `build-android` jobs would **concurrently**
`eas env:create --force` the same four names in the same EAS environment — and
because the implementation is effectively check-then-create/update, the first
run against absent variables could race. A single prerequisite job removes that
race and de-duplicates.

```yaml
sync-eas-telemetry-env:
  name: Sync telemetry keys to EAS production environment
  runs-on: ubuntu-latest
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '22', cache: 'npm', cache-dependency-path: mobile/package-lock.json }
    - uses: expo/expo-github-action@v8
      with: { eas-version: latest, token: '${{ secrets.EXPO_TOKEN }}', packager: npm }
    - name: Sync telemetry keys to EAS production environment
      env:
        SENTRY_DSN: ${{ secrets.SENTRY_DSN }}
        RUDDERSTACK_WRITE_KEY: ${{ secrets.RUDDERSTACK_WRITE_KEY }}
        RUDDERSTACK_DATA_PLANE_URL: ${{ secrets.RUDDERSTACK_DATA_PLANE_URL }}
        SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
      run: |
        set -euo pipefail
        set +x  # defensive: never echo commands (would expose secret values)
        cd mobile
        sync_one() {        # retries transient EAS API failures (3 attempts)
          local eas_name="$1" secret_value="$2" visibility="$3" attempt
          for attempt in 1 2 3; do
            if eas env:create --scope project --environment production \
                 --name "$eas_name" --value "$secret_value" \
                 --visibility "$visibility" --non-interactive --force; then
              echo "Synced $eas_name (visibility=$visibility) to EAS production"; return 0
            fi
            echo "::warning::eas env:create for $eas_name failed (attempt $attempt/3); retrying…"; sleep 5
          done
          echo "::error::eas env:create for $eas_name failed after 3 attempts"; return 1
        }
        sync_required() {   # Sentry keys: REQUIRED → hard-fail when empty
          local v="$1" name="$2" vis="$3" gh="$4"
          if [ -z "$v" ]; then
            echo "::error::$gh secret is empty — mobile deploy builds must ship Sentry telemetry + symbolication"; exit 1
          fi
          sync_one "$name" "$v" "$vis"
        }
        sync_optional() {   # RudderStack keys: OPTIONAL → warn-and-continue
          local v="$1" name="$2" vis="$3"
          if [ -z "$v" ]; then
            echo "::warning::Skipping EAS env $name — empty; analytics ships inert (degraded, not a safety regression)"; return 0
          fi
          sync_one "$name" "$v" "$vis"
        }
        sync_required "$SENTRY_DSN"                 EXPO_PUBLIC_SENTRY_DSN                 plaintext SENTRY_DSN
        sync_optional "$RUDDERSTACK_WRITE_KEY"      EXPO_PUBLIC_RUDDERSTACK_WRITE_KEY      plaintext
        sync_optional "$RUDDERSTACK_DATA_PLANE_URL" EXPO_PUBLIC_RUDDERSTACK_DATA_PLANE_URL plaintext
        sync_required "$SENTRY_AUTH_TOKEN"          SENTRY_AUTH_TOKEN                      secret     SENTRY_AUTH_TOKEN
```

Design points:

- **Secrets flow via the masked `env:` block**, referenced as shell variables.
  They are only passed as `--value "$VAR"` (the EAS CLI's documented
  non-interactive string API). GitHub masks the `env:` values in logs; the
  runner is GitHub-hosted and ephemeral, there is no `set -x` (a defensive
  `set +x` guarantees it), and no value is echoed — so this is an acceptable
  residual risk. (GitHub advises avoiding command-line secret passing *where
  possible*; here EAS requires `--value`.)
- **Idempotent** via `--force` (overwrite-if-exists). The job runs on every
  deploy and converges the EAS env to the current GitHub secret — see *Rotation*.
- **Retried**: each `eas env:create` retries up to 3 times (5s apart) so a
  transient EAS API hiccup does not fail an entire deploy.
- **Fail-closed asymmetry** (mirrors `release.yml`'s desktop `SENTRY_DSN`
  preflight): the two **Sentry** keys (`SENTRY_DSN`, `SENTRY_AUTH_TOKEN`) are
  **required** — an empty value `::error::`s and `exit 1`s the job. These are
  deploy workflows (not fork PRs), so empty means scoping drift / outage, and a
  telemetry-dark or unsymbolicated store build is the exact failure we must
  prevent. The two **RudderStack** keys are **optional** — an empty value emits
  a `::warning::` and continues, because analytics-dark degrades gracefully and
  is not a safety regression.
- `eas env:create` flags verified against the eas-cli reference for the pinned
  `>= 18.0.0`: `--scope project|account`, `--environment <name>`,
  `--visibility plaintext|sensitive|secret`, `--non-interactive`, and `--force`
  (overwrite). Canonical visibility token is `plaintext` (not `plain`).

### Secret scoping (verified)

`release.yml` reads `SENTRY_DSN`, `RUDDERSTACK_WRITE_KEY`,
`RUDDERSTACK_DATA_PLANE_URL`, and `SENTRY_AUTH_TOKEN` directly as
`${{ secrets.* }}` with **no `environment:` key on any job** — they are **not**
gated behind a GitHub deployment environment. `SENTRY_DSN` and
`SENTRY_AUTH_TOKEN` are confirmed **repo-level**; the two RudderStack keys
resolve for `release.yml` today (so they are repo- or org-level), but were not
seen in the repo secret list, so they are most likely **org-level** Actions
secrets granted to this repo. Either way, a plain `${{ secrets.* }}` reference
resolves and the mobile jobs need **no `environment:` addition**. (If these were
ever moved behind a GitHub `environment:`, the `sync-eas-telemetry-env` job
would need the matching `environment:` declaration too.)

---

## Rotation

To rotate any key: update the **GitHub Actions secret** (repo Settings →
Secrets and variables → Actions). The next mobile build re-runs the sync step
and `--force`-overwrites the EAS env var with the new value. No manual
`eas env:*` command and no EAS dashboard edit is needed — GitHub is the single
source of truth, EAS is a derived cache.

(One caveat: an *in-flight* EAS build already submitted with the old value will
finish with the old value; the next build picks up the rotation.)

---

## Verifying a build picked up the keys

The keys are only fully provable from a **real build** running on a device /
simulator (you cannot verify EAS injection from a PR check). On a production
build:

- **Sentry:** the app logs `[Sentry:Mobile] Enabled` at startup
  (`initSentry()`), vs `[Sentry:Mobile] Disabled` when the DSN is absent.
- **Analytics:** `analytics.isAvailable()` returns `true` and the app logs
  `[analytics:mobile] Enabled` (vs `[analytics:mobile] Disabled` with reason
  `missing RudderStack credentials`). `getMobileAnalyticsHealth()` reports
  `{ permitted: true, enabled: true }`.
- **Source maps (`SENTRY_AUTH_TOKEN`):** a crash in Sentry shows symbolicated /
  de-minified stack frames rather than bundled offsets.

> Final end-to-end verification — that the EAS build actually injected the vars
> and the app emits — requires a real preview/production build and is an **ops
> step**, not something CI or a unit test can assert.

---

## Local dev and `e2e` are intentionally creds-free

- **Local dev:** the keys are absent from a developer's environment by design.
  Sentry stays disabled and analytics stays **inert** (`isAnalyticsPermitted()`
  is false → `init()` short-circuits, every `track()`/`identify()` no-ops). This
  is intentional: developers do not emit telemetry, and the absence is logged,
  not silently swallowed.
- **`e2e` profile:** the sync step targets only the `production` EAS
  environment, so it never touches the `e2e` profile. `e2e` keeps
  `SENTRY_DISABLE_AUTO_UPLOAD: true` and `withoutCredentials: true`
  (`mobile/eas.json`) and stays analytics-inert. E2E runs must not emit
  telemetry or attempt symbol upload.

---

## Ops prerequisite

This automation only works if the **4 GitHub secrets exist and are in scope**
for the mobile workflows (repo- or org-level, as today). The fail-closed
asymmetry matters here:

- If a **Sentry** secret (`SENTRY_DSN` / `SENTRY_AUTH_TOKEN`) is missing, the
  `sync-eas-telemetry-env` job **hard-fails** and the whole deploy aborts — a
  telemetry-dark or unsymbolicated store build is worse than no build.
- If a **RudderStack** secret is missing, the job emits a `::warning::` and the
  build continues, shipping analytics inert (degraded, not a safety regression).

Keeping all four present and current is the standing owner action — see
`docs-private/ops/OSS_COMMERCIAL_CONFIG_TODO.md`.
