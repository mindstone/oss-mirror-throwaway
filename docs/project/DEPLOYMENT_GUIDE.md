---
description: "Deployment guide for desktop, cloud, web, and mobile surfaces — current ship commands, rollout targets, and rollback paths"
last_updated: "2026-05-14"
---

# Deployment Guide

How Mindstone Rebel's four deployment surfaces (desktop, cloud, web, mobile) are built, tested, and shipped to users. This is the single source of truth for deployment processes and rollout management.


## See also

- [BUILD_AND_RELEASE_OVERVIEW.md](BUILD_AND_RELEASE_OVERVIEW.md) -- Desktop build/release/distribution hub
- [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) -- Cloud architecture, code layout, key decisions
- [CI_PIPELINE.md](CI_PIPELINE.md) -- Desktop CI automation (GitHub Actions release.yml)
- [RELEASING.md](RELEASING.md) -- Desktop release runbook
- Planning docs:
  - `docs/plans/finished/260305_cloud_deploy_optimization.md` -- Lean Docker image, .dockerignore, reconnect resilience
  - `docs/plans/obsolete/260224_cloud_auto_provisioning.md` -- One-click cloud provisioning (future; contains Fly.io API limitations research)


## How do I deploy X right now?

Quick reference for the current state of each surface. After CI/CD is implemented (see Implementation plan below), these steps will change -- the target state commands are noted in parentheses.

### Desktop

```bash
git push origin dev    # beta release (auto-built by CI, auto-updates to beta users)
git push origin main   # stable release (auto-built by CI, auto-updates to stable users)
```

No manual steps. CI handles build, sign, notarize, E2E test, and publish.

### Cloud service -- code-only change (most common, ~30s)

When only `cloud-service/src/` or handler code changed:

```bash
cd cloud-service && node build.mjs
fly sftp shell -a rebel-cloud-test
# In sftp shell:
put dist/server.mjs /tmp/server.mjs
# Exit sftp, then:
fly ssh console -a rebel-cloud-test -C "cp /tmp/server.mjs /app/cloud-service/dist/server.mjs"
fly machine restart $(fly machine list -a rebel-cloud-test --json | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))[0].id)") -a rebel-cloud-test
```

*(Target: GitHub Actions > `deploy-cloud.yml` > Run workflow > pick image tag)*

### Cloud service -- full image change (~10-15 min)

When dependencies, MCPs, web companion, rebel-system, or Dockerfile changed:

```bash
fly deploy --config cloud-service/fly.toml --dockerfile cloud-service/Dockerfile --remote-only
```

*(Target: push to dev/main triggers `build-cloud.yml` automatically; deploy via `deploy-cloud.yml` workflow_dispatch)*

### Web companion

Currently baked into the cloud Docker image. Any web UI change requires a full Docker deploy (see above).

*(Target: GitHub Actions > `deploy-web.yml` > Run workflow. Or auto-triggered on push to dev/main when `web-companion/**` changes)*

### Mobile -- JS-only change (OTA, ~30s, no app store review)

```bash
cd mobile
eas update --branch production --message "description of change"
```

Users receive the update next time they open the app.

### Mobile -- native change (full build + app store submission)

```bash
cd mobile
eas build --profile production --platform ios
eas build --profile production --platform android
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

*(Target: push to `main` triggers `.eas/workflows/deploy-to-production.yml` which auto-detects native vs JS-only changes via fingerprinting)*

### Mobile -- internal testing

```bash
cd mobile
eas build --profile preview --platform ios
eas build --profile preview --platform android
```

Distributed internally via ad-hoc. Test on physical devices before production.

*(Target: push to `dev` triggers `.eas/workflows/preview-builds.yml`)*

### Rollback quick reference

| Surface | How to roll back |
|---------|-----------------|
| Desktop | Users auto-update to the next release; or manually download previous version from GCS |
| Cloud | Re-sftp previous `server.mjs`, or `fly deploy` from a previous commit. *(Target: re-run `deploy-cloud.yml` with a previous image SHA)* |
| Web | Re-do full cloud Docker deploy. *(Target: re-run `deploy-web.yml` from previous commit)* |
| Mobile (JS) | `eas update --branch production` with the fix (OTA, ~30s) |
| Mobile (native) | Submit a new build. iOS: fix-forward only. Android: halt staged rollout. |

---


## Deployment surfaces at a glance

| Surface | Trigger | Registry / Host | Environments | Rollback |
|---------|---------|----------------|-------------|----------|
| **Desktop (Electron)** | Push to `dev`/`main` | GCS bucket | Beta (dev) / Stable (main) | Users downgrade via GCS; auto-update rolls forward |
| **Cloud service** | Manual (see below) | GHCR (public) | Single instance (`rebel-cloud-test`) | Redeploy previous image tag from GHCR |
| **Web companion** | Manual (baked into cloud image) | Baked into Docker image | Same as cloud | Same as cloud |
| **Mobile (Expo)** | Manual `eas build` + `eas submit` | EAS servers | preview / production (eas.json profiles) | OTA update (JS-only) or new build (native) |


## Desktop (Electron)

**Fully automated.** See [BUILD_AND_RELEASE_OVERVIEW.md](BUILD_AND_RELEASE_OVERVIEW.md) for the complete picture.

- Push to `dev` -> beta build -> auto-update to beta users
- Push to `main` -> stable build -> auto-update to stable users
- CI: `.github/workflows/release.yml` handles build, sign, notarize, E2E test, publish to GCS
- No manual intervention needed for routine releases


## Cloud service

### Current state (manual)

The cloud service runs on Fly.io as app `rebel-cloud-test`. Deployment is manual and requires the Fly CLI authenticated on a developer's machine.

**Two deploy methods exist**, depending on what changed:

#### Code-only deploy (most common, ~30 seconds)

When only `cloud-service/src/` or handler code changed:

```bash
# 1. Build the bundle locally
cd cloud-service && node build.mjs

# 2. Upload to the running machine
fly sftp shell -a rebel-cloud-test
put dist/server.mjs /tmp/server.mjs

# 3. Move into place (sftp won't overwrite directly)
fly ssh console -a rebel-cloud-test -C "cp /tmp/server.mjs /app/cloud-service/dist/server.mjs"

# 4. Restart the machine
fly machine restart $(fly machine list -a rebel-cloud-test --json | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))[0].id)") -a rebel-cloud-test
```

#### Full Docker deploy (rare, ~10-15 minutes)

When dependencies, MCPs, web companion, rebel-system, or Dockerfile changed:

```bash
fly deploy --config cloud-service/fly.toml --dockerfile cloud-service/Dockerfile --remote-only
```

**When to use full deploy:**
- `package.json` or `cloud-service/package.json` dependency changes
- MCP servers added/removed/updated
- Web companion SPA (`web-companion/`) changes
- Dockerfile itself (base image, layers)
- `rebel-system/` content bundled into image

### Rollback (current)

- **Code-only**: Re-sftp the previous `server.mjs` bundle, restart
- **Full image**: No version history. Rebuild from a previous commit and `fly deploy`

### Target state (CI/CD with GHCR)

The target architecture uses two separate workflows: one for building images (push-triggered), one for deploying them (manual).

```
Push to dev/main -> [Workflow 1: build-cloud.yml]
                    -> Build Docker image (with submodule checkout)
                    -> Smoke test: run image in CI, hit /api/health
                    -> Push to GHCR (tagged commit SHA + branch-latest)
                    -> Image ready for manual deploy

Developer clicks "Deploy" -> [Workflow 2: deploy-cloud.yml (workflow_dispatch)]
                           -> Input: image tag (SHA or branch-latest)
                           -> fly machine update --image ghcr.io/<org>/rebel-cloud:<tag>
                           -> Poll health endpoint (30s timeout)
                           -> Slack notification on success/failure
```

**Key components:**

1. **GHCR (GitHub Container Registry)** as the central image registry
   - **Public repository** -- simplest approach; Fly's Machines API can pull public images directly without any registry auth configuration. The image contains compiled/bundled JS (not source code), and the desktop app already ships equivalent compiled code to users' machines, so marginal IP exposure is minimal.
   - Every push to `dev` builds and pushes an image tagged `dev-<sha>` + `dev-latest`
   - Every push to `main` builds and pushes `prod-<sha>` + `prod-latest`
   - Full version history, easy rollback to any previous image
   - Images persist permanently (unlike Fly's ephemeral registry)
   - **BYOK compatibility**: Because GHCR is public, user-owned Fly machines can also pull images directly via `fly machine update --image ghcr.io/<org>/rebel-cloud:<tag>` -- no registry credentials needed on the user's Fly account.
   - **Cleanup policy**: Optional. Keep last 20 dev images and all prod images. Use `delete-package-versions` GitHub Action on a weekly schedule to prune older dev images if storage becomes a concern.

2. **Deploy mechanism: `fly machine update --image`**
   - Since GHCR is public, `fly machine update --image ghcr.io/<org>/rebel-cloud:<tag>` just works -- no registry auth configuration needed on the Fly side
   - This preserves the mounted volume (`rebel_data` at `/data`) across deploys
   - **Not** `fly deploy` (which rebuilds from Dockerfile when `[build]` is in fly.toml)
   - **Not** `fly deploy --image` (which has caveats with Fly's newer Machines API)
   - **Prerequisite**: Validate `fly machine update --image ghcr.io/...` end-to-end before implementing the workflow (Phase 0). Confirm volume preservation and health check pass.

3. **Manual deploy gate** via `workflow_dispatch`
   - Developer selects which image tag to deploy (prefer SHA-based tags over `*-latest` for deterministic rollback)
   - Workflow runs health check validation after deploy (poll `/api/health` for up to 30s)
   - Human-in-the-loop before anything hits production

4. **Local testing as "staging"**
   - Build and run the Docker image locally to validate before deploying
   - `docker build -f cloud-service/Dockerfile -t rebel-cloud:local .`
   - `docker run -p 8080:8080 -e REBEL_CLOUD_TOKEN=test rebel-cloud:local`
   - Hit `http://localhost:8080/api/health` to verify
   - **Limitations**: Local Docker testing cannot validate Fly-specific behaviour (auto-stop/start, volume persistence across restarts, Anycast routing, health check integration with Fly's proxy). It validates application correctness, not infrastructure behaviour.

5. **Instant rollback**
   - Trigger deploy workflow with a previous image tag (SHA-based)
   - Or for code-only hotfixes: sftp a known-good `server.mjs` bundle (see caveat below)

6. **Version header** (implement alongside Phase 1)
   - Add `X-Rebel-Cloud-Version: <commit-sha>` response header to all cloud API responses
   - Trivially cheap (~1 line), high defensive value with 4 independently-deployed surfaces
   - Enables desktop/web/mobile to detect version drift and warn users

### User cloud update propagation (BYOK)

In the BYOK model, each user has their own Fly machine. When a new image is pushed to GHCR, the **desktop app** is responsible for updating the user's cloud instance -- users never interact with Fly directly.

**How it works:**

```
Desktop app starts / periodically checks
     |
     v
1. Check latest image tag from GHCR (public, no auth):
   GET https://api.github.com/orgs/<org>/packages/container/rebel-cloud/versions
   → parse latest tag (e.g., "prod-abc123")
     |
     v
2. Check running version from user's cloud instance:
   GET https://<user-app>.fly.dev/api/health
   → read X-Rebel-Cloud-Version header (e.g., "old-sha")
     |
     v
3. If versions differ → update the user's machine via Fly Machines REST API:
   PATCH https://api.machines.dev/v1/apps/<user-app>/machines/<machine-id>
   Headers: Authorization: Bearer <user's fly token>
   Body: { "config": { "image": "ghcr.io/<org>/rebel-cloud:prod-abc123" } }
     |
     v
4. Poll health endpoint until machine is healthy (~30s)
     |
     v
5. Reconnect desktop ↔ cloud bridge
```

**Key details:**

- **No `flyctl` needed** -- the desktop app calls Fly's REST API directly over HTTPS
- **User's Fly API token** is stored in the desktop app (provisioned during initial cloud setup, stored in safeStorage)
- **Machine ID** is stored alongside the token during provisioning
- **GHCR tag query** is unauthenticated (public package) -- the desktop app just needs to parse the JSON response for the latest `prod-*` tag
- **UX**: User sees a brief "Updating your cloud instance..." indicator. If the update fails, the app continues with the existing version and retries later.
- **Frequency**: Check on app launch + every 24h while running. Don't check more often (avoids GitHub API rate limits, which are 60 req/hr unauthenticated).

**Rollback safety**: If a bad image is pushed, the desktop app will try to update users to it. Mitigation: the deploy workflow's health check (Phase 1) catches broken images before they get the `prod-latest` tag. Only images that pass the smoke test get tagged `prod-*`.

### SFTP code-only deploy: caveat

The existing sftp deploy method (overwrite `server.mjs` on the running machine) remains useful for rapid hotfixes. However, be aware of **rootfs state drift**: the sftp'd file lives on the machine's ephemeral rootfs, not the persistent volume. The change will be lost on:
- Next `fly machine update --image` deploy (intended -- CI image becomes source of truth)
- Machine migration to a different host (Fly infrastructure event)
- Machine stop/start cycle (note: auto-stop is currently disabled in fly.toml, but Fly infrastructure events can still restart machines)

After Phase 1 is live, sftp should be reserved for emergency hotfixes only. The CI pipeline is the source of truth.

### Infrastructure details

| Property | Value |
|----------|-------|
| Fly app | `rebel-cloud-test` |
| Region | `iad` (US East) |
| VM | `performance-2x`, 4GB RAM |
| Volume | `rebel_data` at `/data` (10GB initial) |
| Health check | `GET /api/health` every 15s |
| Dockerfile | `cloud-service/Dockerfile` |
| Fly config | `cloud-service/fly.toml` |
| Build script | `cloud-service/build.mjs` |

### Secrets (Fly.io)

Cloud service secrets are set via `fly secrets set -a rebel-cloud-test`:

- `REBEL_CLOUD_TOKEN` -- Auth token for desktop-to-cloud communication
- `ANTHROPIC_API_KEY` -- Claude API key (if cloud runs its own key)
- Any MCP OAuth tokens (set per-connector)

**Never commit these.** The desktop app stores the bridge token in settings (see CLOUD_IMPROVEMENT_OPPORTUNITIES.md #7 for safeStorage migration).


## Mobile (Expo / React Native)

### Current state (manual)

Mobile uses Expo Application Services (EAS) for builds and submissions. All operations are manual from a developer's laptop.

**Build profiles** (defined in `mobile/eas.json`):

| Profile | Purpose | Distribution |
|---------|---------|-------------|
| `development` | Dev client builds | Internal (ad-hoc) |
| `preview` | Internal testing builds | Internal (ad-hoc) |
| `production` | App Store / Play Store | Store submission |

**Build:**
```bash
cd mobile
eas build --profile production --platform ios
eas build --profile production --platform android
```

**Submit:**
```bash
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

### Rollback

- **OTA updates** (JS-only changes): Publish a new OTA update pointing to the previous JS bundle. Takes effect on next app open. This is the fastest rollback path (~30 seconds).
- **iOS native builds**: Submit a new build to TestFlight/App Store. Apple doesn't support rollback; you ship a fix-forward.
- **Android native builds**: Play Store supports staged rollouts (1% -> 5% -> 20% -> 100%) and halt/rollback of staged rollouts.

### Target state (EAS Workflows)

Expo now recommends **EAS Workflows** (`.eas/workflows/*.yml`) over GitHub Actions for mobile CI/CD. EAS Workflows are purpose-built for Expo/React Native and handle signing, credentials, and platform-specific build quirks natively. GitHub Actions can still trigger them but the heavy lifting runs on Expo's infrastructure.

**Key concepts:**
- **EAS Build**: Compiles native iOS/Android binaries on Expo's cloud (handles signing, provisioning, keystore)
- **EAS Submit**: Uploads built binaries to App Store Connect / Google Play Console
- **EAS Update**: Pushes JS-only changes over-the-air (OTA) without app store review (~seconds to deploy)
- **Fingerprint**: Hashes the native characteristics of the project. If only JS changed (no native dependency/config changes), skip the full build and send an OTA update instead

**Two deployment paths:**

| What changed | Path | Time | App store review? |
|-------------|------|------|-------------------|
| JS/TS code only (features, UI, bug fixes) | EAS Update (OTA) | ~30 seconds | No |
| Native dependencies, Expo SDK version, app.json config | EAS Build + Submit | ~15-30 min build + store review | Yes |

#### Workflow 1: Preview builds (internal testing)

Trigger: push to `dev` or `workflow_dispatch`

```yaml
# .eas/workflows/preview-builds.yml
name: Preview builds

on:
  push:
    branches: ['dev']

jobs:
  build_android:
    name: Build Android Preview
    type: build
    params:
      platform: android
      profile: preview
  build_ios:
    name: Build iOS Preview
    type: build
    params:
      platform: ios
      profile: preview
```

Preview builds are distributed internally (ad-hoc) for testing on physical devices before production.

#### Workflow 2: Deploy to production

Trigger: push to `main`

Uses fingerprinting to decide whether to do a full build+submit or just an OTA update:

```yaml
# .eas/workflows/deploy-to-production.yml
name: Deploy to production

on:
  push:
    branches: ['main']

jobs:
  fingerprint:
    name: Fingerprint
    type: fingerprint
    environment: production
  get_android_build:
    name: Check for existing android build
    needs: [fingerprint]
    type: get-build
    params:
      fingerprint_hash: ${{ needs.fingerprint.outputs.android_fingerprint_hash }}
      profile: production
  get_ios_build:
    name: Check for existing ios build
    needs: [fingerprint]
    type: get-build
    params:
      fingerprint_hash: ${{ needs.fingerprint.outputs.ios_fingerprint_hash }}
      profile: production
  build_android:
    name: Build Android
    needs: [get_android_build]
    if: ${{ !needs.get_android_build.outputs.build_id }}
    type: build
    params:
      platform: android
      profile: production
  build_ios:
    name: Build iOS
    needs: [get_ios_build]
    if: ${{ !needs.get_ios_build.outputs.build_id }}
    type: build
    params:
      platform: ios
      profile: production
  submit_android_build:
    name: Submit Android Build
    needs: [build_android]
    type: submit
    params:
      build_id: ${{ needs.build_android.outputs.build_id }}
  submit_ios_build:
    name: Submit iOS Build
    needs: [build_ios]
    type: submit
    params:
      build_id: ${{ needs.build_ios.outputs.build_id }}
  publish_android_update:
    name: Publish Android OTA update
    needs: [get_android_build]
    if: ${{ needs.get_android_build.outputs.build_id }}
    type: update
    params:
      branch: production
      platform: android
  publish_ios_update:
    name: Publish iOS OTA update
    needs: [get_ios_build]
    if: ${{ needs.get_ios_build.outputs.build_id }}
    type: update
    params:
      branch: production
      platform: ios
```

**How fingerprinting works**: If native code hasn't changed since the last build (same fingerprint hash), the workflow skips the expensive build+submit and instead publishes a JS-only OTA update via EAS Update. Users receive the update next time they open the app -- no app store review needed.

#### Prerequisites (must be configured before enabling CI)

1. **`EXPO_TOKEN`** -- Generate at expo.dev > Account Settings > Access Tokens. Set as GitHub secret if triggering from GitHub Actions. EAS Workflows use it automatically when configured.

2. **iOS submission credentials**:
   - App Store Connect API key (recommended for CI): generate at appstoreconnect.apple.com > Users and Access > Integrations > App Store Connect API
   - Configure in EAS: `eas credentials --platform ios` or set `ASC_API_KEY_ID`, `ASC_API_KEY_ISSUER_ID`, `ASC_API_KEY_PATH` environment variables
   - The `ascAppId: "6760136915"` is already configured in `eas.json`

3. **Android submission credentials**:
   - Google Play service account JSON key: create at console.cloud.google.com > IAM & Admin > Service Accounts
   - Upload to EAS: `eas credentials --platform android` (select "Google Service Account Key")
   - Grant the service account "Release Manager" role in Google Play Console

4. **EAS Update setup**:
   - Run `eas update:configure` to add the required config to `app.json`
   - This adds the `expo-updates` package and configures the update URL

5. **Monorepo dependency**: `mobile/package.json` uses `"@rebel/cloud-client": "file:../cloud-client"`. EAS builds clone from git, so the monorepo structure works if the root `package.json` is present. Verify with a test build: `eas build --profile preview --platform android --non-interactive`

6. **Verify all credentials**: Run `eas credentials` for both platforms and confirm signing certs, provisioning profiles, and store submission keys are all managed by EAS.

**EAS build costs**: Free tier = 15 builds/month for iOS, 15 for Android. OTA updates are unlimited on free tier. Production volume may require a paid EAS plan ($99/mo for 100 builds).


## Web companion

### Current state (coupled to cloud service)

The web companion is a standalone React SPA (`web-companion/`) that is currently built inside the cloud service Dockerfile and served by the cloud service at `/app/`. Any web UI change requires a full Docker rebuild + cloud redeploy.

**Build**: `cd web-companion && npx vite build` (output: `web-companion/dist/`)
**Served from**: `data/web-app/` inside the Docker container (via `webAppServing.ts`)
**API calls**: Same-origin to `/api/` (proxied in dev via vite config to `localhost:8080`)
**Auth flow**: Desktop's CloudTab generates a pairing URL like `${cloudUrl}/app#token=...`. The SPA extracts the token from the URL fragment and uses `window.location.origin` as the API base. This means the SPA assumes it is served from the same origin as the API.

### Target state (two-phase decoupling)

Decoupling web deploys from Docker builds is the goal, but moving to a CDN introduces significant complexity (cross-origin auth, CORS, `file:` dependency on `cloud-client`, base path changes, per-user API URL configuration). We use a phased approach:

#### Phase 2a: Same-origin independent deploys (recommended first step)

Build the web companion in CI and upload the assets to the running Fly machine, keeping same-origin serving via `webAppServing.ts`. This decouples web deploys from Docker builds without any auth, CORS, or architectural changes.

```
Push to dev/main -> CI builds web companion SPA
                 -> Upload dist/ to Fly machine via sftp (overwrite data/web-app/)
                 -> Available in ~30 seconds, no Docker rebuild needed
```

**What changes:**
1. CI workflow builds the SPA (`cd web-companion && npm run build`)
2. CI uploads `web-companion/dist/` to the Fly machine's `data/web-app/` directory via sftp
3. `webAppServing.ts` continues serving the updated assets -- no restart needed (static file server)
4. Docker image still contains a baseline copy of the web companion (built during `fly deploy`). CI-uploaded assets override it.

**What doesn't change:**
- Same-origin API calls (no CORS issues)
- Existing auth/token flow (URL fragment pairing works as-is)
- `base: '/app/'` in vite.config.ts (unchanged)
- No `cloud-client` packaging changes needed (monorepo `file:` ref stays)

**Benefits:**
- Web UI changes deploy independently (~30s, no Docker rebuild)
- Zero auth/CORS/infrastructure changes
- Rollback: re-upload previous build, or next Docker deploy resets to baseline
- Docker image retains a working web companion for fresh deploys and BYOK users

#### Phase 2b: CDN hosting (future, when needed)

If global edge caching, PR preview deploys, or fully independent web infrastructure becomes necessary, migrate to Cloudflare Pages. This requires solving several problems first:

**Prerequisites for CDN hosting:**
1. **Cross-origin auth**: The SPA currently assumes `window.location.origin` is the API origin. A CDN-hosted SPA needs the API URL injected at runtime (not build-time, since each user connects to their own cloud instance). The pairing URL flow (`#token=...`) would need to also encode the cloud URL, e.g., `https://web.rebel.ai/app#token=...&api=https://user-instance.fly.dev`
2. **CORS configuration**: Tighten from wildcard to the CDN domain. Configure CORS on the cloud service BEFORE migrating, allowing both origins during transition.
3. **`cloud-client` packaging**: `web-companion/package.json` uses `"@rebel/cloud-client": "file:../cloud-client"`. Cloudflare Pages builds cannot resolve parent-directory `file:` references. Need npm workspaces at root level or publish `cloud-client` as a package.
4. **Base path**: `vite.config.ts` has `base: '/app/'`. CDN hosting may need `base: '/'`. The SPA router (`BrowserRouter basename="/app"`) also needs updating.
5. **PR preview safety**: Cloudflare Pages auto-generates preview URLs per PR. If previews point at the shared production cloud instance, testing mutates real user data. Must either disable PR previews or use a dedicated test cloud instance.
6. **WebSocket URL derivation**: `cloud-client` constructs WebSocket URLs via `config.cloudUrl.replace(/^http/, 'ws')`. This works if `cloudUrl` is the full origin (scheme + host), but must be validated for the CDN configuration.

**Architecture after CDN migration:**

```
[User browser] ---> [CDN: web companion SPA]
                          |
                          | API calls (fetch/WebSocket) to user's cloud instance
                          v
                    [Fly.io: cloud service API]
```

### Key files

| File | Purpose |
|------|---------|
| `web-companion/` | SPA source (React + Vite) |
| `web-companion/vite.config.ts` | Build config, `base: '/app/'`, dev proxy to localhost:8080 |
| `web-companion/package.json` | Dependencies -- note `@rebel/cloud-client` is a `file:../cloud-client` reference |
| `cloud-service/src/webAppServing.ts` | Static file server for SPA (serves from `data/web-app/`, runs pre-auth) |
| `cloud-client/` | Shared API client (HTTP + WebSocket URL construction) |


## Rollout checklist

When deploying changes that affect users:

### Cloud service
- [ ] Test locally: `docker build` + `docker run` + hit health endpoint
- [ ] Build passes CI (`cloud-ci.yml` / `build-cloud.yml` green)
- [ ] Deploy using the appropriate method (CI image deploy, code-only sftp, or full Docker)
- [ ] Verify health check: `curl https://rebel-cloud-test.fly.dev/api/health`
- [ ] Verify version header: `curl -I https://rebel-cloud-test.fly.dev/api/health | grep X-Rebel-Cloud-Version`
- [ ] Test desktop app connects to cloud instance successfully
- [ ] Check logs: `fly logs -a rebel-cloud-test`

### Web companion
- [ ] Build locally: `cd web-companion && npm run build`
- [ ] Test locally against dev cloud service
- [ ] Deploy: upload `dist/` to Fly machine (Phase 2a) or push to CDN (Phase 2b)
- [ ] Verify SPA loads and connects to cloud API

### Mobile
- [ ] Run `npm --prefix mobile run test:runtime-integrity`
- [ ] Determine deploy path: JS-only change (OTA update) or native change (full build+submit)?
- [ ] **If JS-only**: `eas update --branch production --message "description"` (OTA, no app store review)
- [ ] **If native change**: Build with `preview` profile first, test on physical devices
- [ ] **If native change**: Build with `production` profile, submit to App Store / Play Store
- [ ] Monitor crash reports and reviews after release
- [ ] Verify OTA update delivery: check expo.dev dashboard for update adoption

### Cross-surface changes
- [ ] If IPC contracts changed: deploy cloud first, then ship desktop update (cloud must be backwards-compatible)
- [ ] If auth/token format changed: coordinate cloud + desktop + web deploy timing
- [ ] Check `X-Rebel-Cloud-Version` header to confirm expected version is live before deploying dependent surfaces
- [ ] Update [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) if deployment topology changed


## Known gaps and improvement opportunities

1. **No CI-triggered cloud deploys** -- Every cloud deploy requires manual CLI commands. Target: two GitHub Actions workflows (build + deploy) with GHCR + manual deploy gate. See Phase 1.
2. **No image version history** -- Fly's ephemeral registry means no easy rollback. Target: public GHCR with SHA-tagged images. See Phase 1.
3. **Web companion coupled to Docker builds** -- Any web UI change requires a full Docker rebuild + cloud redeploy. Target: CI-built SPA uploaded via sftp (Phase 2a), CDN hosting later (Phase 2b).
4. **No mobile CI pipeline** -- Builds require `eas` CLI from a developer's machine. Target: GitHub Actions with EXPO_TOKEN + store credentials. See Phase 3.
5. **Single cloud instance** -- No staging/production split. Target: local Docker testing as staging, with optional future staging Fly app.
6. **No version negotiation** -- Desktop and cloud can drift if deployed out of sync. Target: `X-Rebel-Cloud-Version` response header (Phase 1). See also CLOUD_IMPROVEMENT_OPPORTUNITIES.md #4.
7. **Cloud VM is oversized** -- `performance-4x` (16GB, ~$100/mo) vs planned `shared-cpu-1x` (512MB, ~$4/mo). See CLOUD_IMPROVEMENT_OPPORTUNITIES.md #14.
8. **CORS is fully wildcard** -- `Access-Control-Allow-Origin: *` on all cloud responses. Should be tightened once web companion hosting is settled. See Phase 4 and CLOUD_IMPROVEMENT_OPPORTUNITIES.md #10.

See [CLOUD_IMPROVEMENT_OPPORTUNITIES.md](CLOUD_IMPROVEMENT_OPPORTUNITIES.md) for the full prioritized list.


## Implementation plan

### Phase 0: Validate prerequisites

Before implementing any workflow, validate the deployment mechanism end-to-end:

```bash
# 1. Build and push a test image to GHCR manually
docker build -f cloud-service/Dockerfile -t ghcr.io/<org>/rebel-cloud:test .
echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin
docker push ghcr.io/<org>/rebel-cloud:test

# 2. Ensure the GHCR package visibility is set to "public"
#    (GitHub > Packages > rebel-cloud > Settings > Change visibility)

# 3. Test fly machine update with the public GHCR image
fly machine list -a rebel-cloud-test --json  # get machine ID
fly machine update <machine-id> --image ghcr.io/<org>/rebel-cloud:test -a rebel-cloud-test

# 4. Verify:
#    - Volume (rebel_data at /data) is preserved
#    - Health check passes
#    - App functions correctly
curl https://rebel-cloud-test.fly.dev/api/health
```

Because GHCR is public, no registry authentication is needed on the Fly side -- `fly machine update --image` pulls directly from `ghcr.io`.

**Do not proceed to Phase 1 until this validation passes.**

### Phase 1: Cloud CI/CD + version header (highest impact)

Two separate workflows:

**Workflow 1: `build-cloud.yml` (push-triggered)**

1. Trigger on push to `dev`/`main` with comprehensive path filters:
   - `cloud-service/**`
   - `src/core/**`, `src/main/ipc/**`, `src/main/services/**`
   - `src/shared/**`
   - `web-companion/**` (until Phase 2a decouples it)
   - `super-mcp/**`
   - `resources/mcp/**`
   - `rebel-system/**`
   - `scripts/build-bundled-mcps*`, `scripts/mcp-config.json`
   - `cloud-client/**`
   - `packages/**`
   - `Dockerfile` (root), `cloud-service/Dockerfile`
2. Checkout with submodules (copy token pattern from `release.yml`)
3. Build Docker image with pinned base: `FROM node:22.13.1-slim` (not `node:22-slim`)
4. Smoke test: run image in CI, poll `/api/health` for 30s
5. Push to GHCR: tag `<branch>-<sha>` + `<branch>-latest`
6. **Do not deploy** -- image is ready for manual deploy via Workflow 2

**Workflow 2: `deploy-cloud.yml` (workflow_dispatch)**

1. Input: image tag (default: `dev-latest`, but prefer SHA-based for deterministic rollback)
2. `fly machine update <machine-id> --image ghcr.io/<org>/rebel-cloud:<tag> -a rebel-cloud-test` (no auth needed -- GHCR is public)
4. Poll health endpoint for 30s:
   ```bash
   for i in $(seq 1 15); do
     curl -sf https://rebel-cloud-test.fly.dev/api/health && break
     sleep 2
   done
   ```
5. Slack notification on success/failure (reuse existing `SLACK_WEBHOOK` secret)

**Version header** (implement in cloud-service code alongside the workflows):
- Add `X-Rebel-Cloud-Version: <commit-sha>` response header to all API responses
- Exposes the running version for monitoring and cross-surface compatibility checks

**GitHub secrets needed:**
- `FLY_API_TOKEN` -- Fly.io deploy token for `rebel-cloud-test`
- GHCR uses the built-in `GITHUB_TOKEN` (no extra secret)
- `SLACK_WEBHOOK` -- already exists from release.yml

**GHCR cleanup** (add to `build-cloud.yml` or a separate scheduled workflow):
- Weekly: delete dev images older than 20 versions
- Never auto-delete prod images
- Use `actions/delete-package-versions` or equivalent

### Phase 2a: Web companion independent deploys (same-origin)

Decouple web deploys from Docker builds while keeping same-origin serving. No auth, CORS, or infrastructure changes.

**Workflow: `deploy-web.yml` (workflow_dispatch or triggered after cloud deploy)**

```yaml
# .github/workflows/deploy-web.yml
name: Deploy Web Companion

on:
  workflow_dispatch:
    inputs:
      target_app:
        description: 'Fly app name'
        default: 'rebel-cloud-test'
  push:
    branches: [dev, main]
    paths:
      - 'web-companion/**'
      - 'cloud-client/**'

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          # Token pattern from release.yml for submodule access
          token: ${{ secrets.GH_PAT }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      # Install root dependencies (needed for file:../cloud-client resolution)
      - run: npm ci

      # Build the web companion SPA
      - run: cd web-companion && npm run build

      # Upload built assets to Fly machine via SSH
      # fly ssh sftp requires FLY_API_TOKEN for authentication
      - uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Deploy web assets to Fly machine
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
        run: |
          APP="${{ github.event.inputs.target_app || 'rebel-cloud-test' }}"

          # Create a tarball of the built assets
          tar -czf /tmp/web-companion.tar.gz -C web-companion/dist .

          # Upload and extract on the machine
          # fly ssh console runs commands on the machine
          cat /tmp/web-companion.tar.gz | \
            fly ssh console -a "$APP" -C "cat > /tmp/web-companion.tar.gz"

          fly ssh console -a "$APP" -C "\
            rm -rf /data/web-app/* && \
            tar -xzf /tmp/web-companion.tar.gz -C /data/web-app/ && \
            rm /tmp/web-companion.tar.gz"

          # No restart needed -- webAppServing.ts serves static files directly

      - name: Verify deployment
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
        run: |
          APP="${{ github.event.inputs.target_app || 'rebel-cloud-test' }}"
          # Check that the SPA loads (returns HTML, not 404)
          curl -sf "https://${APP}.fly.dev/app/" | head -1 | grep -q "<!DOCTYPE html>"
          echo "Web companion deployed successfully"
```

**Key details:**
1. `npm ci` at root is required because `web-companion/package.json` depends on `"@rebel/cloud-client": "file:../cloud-client"`
2. Uses `fly ssh console` with piped tarball to transfer files (more reliable than sftp for CI)
3. `FLY_API_TOKEN` (same secret as cloud deploy) authenticates the SSH connection
4. No machine restart needed -- `webAppServing.ts` serves static files from `/data/web-app/`
5. Docker image continues to include a baseline web companion build (for fresh deploys and BYOK users)
6. Rollback: re-run workflow from a previous commit, or next Docker deploy resets to baseline

### Phase 2b: CDN hosting (future, when needed)

See "Phase 2b: CDN hosting" in the Web companion section above. Requires solving: cross-origin auth/pairing flow, `cloud-client` packaging (`file:` dependency), CORS tightening, base path changes, PR preview safety.

### Phase 3: Mobile CI/CD (EAS Workflows)

Use EAS Workflows (`.eas/workflows/*.yml`) rather than GitHub Actions for mobile builds. EAS handles signing, credentials, and platform quirks natively.

1. **Set up EAS Update**: Run `eas update:configure` to enable OTA updates
2. **Create workflow files** (see "Target state (EAS Workflows)" in the Mobile section above):
   - `.eas/workflows/preview-builds.yml` -- triggered on push to `dev` (internal testing)
   - `.eas/workflows/deploy-to-production.yml` -- triggered on push to `main` (fingerprint -> build+submit or OTA)
3. **Configure all credentials** (detailed in the Mobile section prerequisites):
   - `EXPO_TOKEN` for CI authentication
   - iOS: App Store Connect API key
   - Android: Google Play service account JSON key
   - Verify with `eas credentials` for both platforms
4. **Test with a preview build first**: `eas build --profile preview --platform android --non-interactive`
5. **Validate monorepo**: Confirm EAS can resolve `file:../cloud-client` dependency during build

EAS build costs: Free tier = 15 iOS + 15 Android builds/month. OTA updates are unlimited. Budget for paid plan ($99/mo) if shipping native changes frequently.

### Phase 4: Rollout controls

1. Add auto-rollback to deploy workflow: if health check fails after 30s, `fly machine update` back to previous image tag
2. Slack notification on deploy (already in Phase 1)
3. Tighten CORS from wildcard to specific allowed origins (coordinate with web companion hosting)


## Review history

### Septuple review -- 2026-03-06

Reviewers: GPT-5.3 Codex (82%), Opus 4.6 (82%), Gemini 3.1 Pro (95%), GLM-5 (80%), Kimi K2.5 (72%), MiniMax M2.5 (92%). GPT-5.5-high timed out.

**Accepted:**
- Specify exact `fly machine update --image` mechanism, not vague `flyctl deploy` (all 6 reviewers)
- GHCR as central registry with cleanup policy (all 6) -- **updated**: changed to public after registry research (see "Registry decision" below)
- Add Phase 0 prerequisite validation before implementing workflows (all 6)
- Web companion CDN decoupling has massive hidden complexity (cross-origin auth, `file:` dependency, base path changes); use same-origin sftp approach first (Opus, MiniMax, Kimi, GPT-5.3-Codex)
- Move version header from Phase 4 to Phase 1 (Opus, Kimi)
- Split into two workflows: build (push-triggered) + deploy (manual) (MiniMax)
- Add comprehensive path triggers covering all Dockerfile inputs (Opus)
- Add submodule checkout to workflow, copy pattern from release.yml (Opus, MiniMax)
- Pin Docker base image to specific version (Opus)
- Document SFTP rootfs state drift risk (Gemini)
- Note EAS credential requirements beyond EXPO_TOKEN (Gemini)
- Document Cloudflare PR preview shared-state risk (Gemini)
- Add smoke test in CI before pushing to GHCR (Opus)
- Document local Docker testing limitations (Opus)
- Add GHCR image retention/cleanup policy (Opus)

**Rejected:**
- "Don't automate Fly deploy at all, just use manual flyctl" (Kimi) -- `workflow_dispatch` is low-complexity and avoids developers needing local flyctl auth. One click > remembering CLI commands.
- "Skip Phase 3 and 4 entirely" (Kimi) -- they're correctly deferred as later phases already. Keeping them documented as the roadmap is valuable.
- "Deprecate SFTP immediately after Phase 1" (Gemini) -- SFTP remains valuable for emergency hotfixes (~30s vs minutes for full image deploy). Documented the state drift caveat instead.

### Registry decision -- 2026-03-06

**Decision: Public GHCR** (not private, not Fly registry, not two-registry mirror).

**Why public**: Fly's Machines API does not support pulling from private third-party registries (confirmed via community threads Jan 2025, March 2024, and official docs). The alternatives considered were:
- **Private GHCR + mirror to Fly registry**: Over-engineered. Requires CI to push to two registries, adds complexity for BYOK user machines.
- **Fly registry only**: Images persist while referenced by a machine (officially documented May 2025), but no independent version history and full dependency on Fly's infrastructure.
- **Public GHCR**: Simplest. `fly machine update --image ghcr.io/...` just works for both our machines and BYOK user machines. No auth, no mirroring, no complexity.

**IP exposure tradeoff**: The Docker image contains compiled/bundled JS, not source code. The desktop Electron app already ships equivalent compiled code to every user's machine. The marginal risk of a public Docker image is minimal -- someone would need to know the package exists, pull it, and reverse-engineer bundled Node.js code. Secrets (API keys, tokens) are injected via Fly secrets, never baked into the image.
