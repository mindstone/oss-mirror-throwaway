#!/usr/bin/env bash
#
# e2e-mobile.sh — one-command local mobile E2E loop.
#
# Boots a deterministic local cloud (mock agent + test-mode seed endpoints),
# installs the app on an already-running iOS simulator / Android emulator,
# seeds backend state, and runs the Maestro flows with rich diagnostics.
#
# This is the deterministic LANE: no live LLM, no deployed Fly dependency.
# See docs/project/MOBILE_QA.md for the three-lane model + prerequisites.
#
# Prerequisites (one-time machine setup — the script checks and tells you):
#   - A JDK on PATH (Maestro needs it):        brew install openjdk
#   - Maestro:                                 curl -Ls https://get.maestro.mobile.dev | bash
#   - iOS: Xcode + a *matching* simulator runtime. If `xcodebuild` reports
#     "iOS XX.X is not installed", run:        xcodebuild -downloadPlatform iOS
#     (Xcode ships an SDK whose simulator runtime may not be downloaded — the
#     documented blocker we hit on the dev Mac, 2026-06-06.)
#   - Android: an emulator booted + adb on PATH (CI uses reactivecircus/android-emulator-runner).
#   - A built app installed on the target (e.g. `eas build -p ios --profile e2e --local`
#     or `expo run:ios`); this script installs a prebuilt .app/.apk if you pass --app.
#
# Usage:
#   mobile/scripts/e2e-mobile.sh [--platform ios|android] [--app <path>] [--flow <dir-or-file>] [--port N]
#
# Env overrides: E2E_PORT, E2E_TOKEN, E2E_RUN_ID, REBEL_REPO_ROOT.
set -euo pipefail

# ---- args ----
PLATFORM="ios"
APP_PATH=""
FLOW_OVERRIDE=""        # if set (file or dir), run exactly that instead of the curated list
PORT="${E2E_PORT:-3100}"
# Curated, ordered flow list. login.yaml runs first (clearState; confirms the
# Keychain pairing established in step 4.5 survives). The rest assume pairing
# persists. The approval/conflict flows consume their seeded fixtures, so the run
# loop RE-SEEDS before every flow (see step 6) — order between them is therefore
# independent.
DEFAULT_FLOWS=(login.yaml new-conversation.yaml conversations.yaml tool_approval_sheet.yaml conflict_resolve_with_rebel.yaml conflict_keep_mine_keep_theirs.yaml)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --app) APP_PATH="$2"; shift 2 ;;
    --flow) FLOW_OVERRIDE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="${REBEL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MOBILE_DIR="$REPO_ROOT/mobile"
CLOUD_DIR="$REPO_ROOT/cloud-service"
TOKEN="${E2E_TOKEN:-e2e-token}"
APP_BUNDLE_ID="${E2E_APP_BUNDLE_ID:-com.mindstone.rebel.mobile}"
# Stable (reused) cloud userdata so boot stays warm (~40s). A fresh mktemp each
# run forces a cold super-mcp tool-index build that can exceed the boot timeout.
# Override with E2E_CLOUD_USER_DATA; delete the dir to force a clean cold boot.
CLOUD_USER_DATA="${E2E_CLOUD_USER_DATA:-${TMPDIR:-/tmp}/rebel-e2e-cloud-userdata}"
mkdir -p "$CLOUD_USER_DATA"
RUN_ID="${E2E_RUN_ID:-local-$$}"           # threaded app→cloud for log correlation
OUT_DIR="$MOBILE_DIR/build/maestro-results/$RUN_ID"
CLOUD_LOG="$OUT_DIR/cloud-service.log"
DEVICE_LOG="$OUT_DIR/device.log"
mkdir -p "$OUT_DIR"

CLOUD_PID=""
DEVICE_LOG_PID=""
# Portable port-listener kill (BSD/macOS xargs has no `-r`, so avoid it).
kill_port_listeners() {
  local pids
  pids="$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
}
cleanup() {
  [[ -n "$DEVICE_LOG_PID" ]] && kill "$DEVICE_LOG_PID" 2>/dev/null || true
  [[ -n "$CLOUD_PID" ]] && kill "$CLOUD_PID" 2>/dev/null || true
  kill_port_listeners "$PORT"   # belt-and-braces: free the port
}
trap cleanup EXIT

echo "==> [1/6] preflight"
command -v maestro >/dev/null || { echo "Maestro not installed (curl -Ls https://get.maestro.mobile.dev | bash)"; exit 1; }
java -version >/dev/null 2>&1 || { echo "No JDK on PATH (brew install openjdk; Maestro needs it)"; exit 1; }

echo "==> [2/6] build cloud bundle (tsx dev path is broken; the bundle is the supported local run)"
( cd "$CLOUD_DIR" && node build.mjs >/dev/null )

echo "==> [3/6] boot deterministic local cloud on :$PORT (mock agent + test-mode seed endpoints)"
kill_port_listeners "$PORT"
PORT="$PORT" \
  REBEL_MOCK_AGENT_TURNS=1 \
  REBEL_E2E_TEST_MODE=1 \
  REBEL_CLOUD_TOKEN="$TOKEN" \
  REBEL_SURFACE=cloud NODE_ENV=development \
  REBEL_USER_DATA="$CLOUD_USER_DATA" \
  node "$CLOUD_DIR/dist/server.mjs" >"$CLOUD_LOG" 2>&1 &
CLOUD_PID=$!
# Boot can take ~40s warm, much longer on a COLD userdata (super-mcp tool-index
# build). We reuse a stable userdata dir ($CLOUD_USER_DATA, default warm) rather
# than a fresh mktemp each run so boot stays ~40s; still allow generous headroom.
for i in $(seq 1 150); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  [[ $i == 150 ]] && { echo "cloud failed to boot:"; tail -20 "$CLOUD_LOG"; exit 1; }
  sleep 1
done
echo "    cloud healthy (pid $CLOUD_PID)"

# The iOS Simulator reaches the host at 127.0.0.1; the Android emulator uses 10.0.2.2
# (or `adb reverse tcp:$PORT tcp:$PORT` to make 127.0.0.1 work). The pairing deep link
# / login.yaml uses CLOUD_URL.
#
# iOS uses `localhost`, NOT the `127.0.0.1` IPv4 literal: the cloud bundle binds
# to the IPv6 wildcard (`::`, shown as `*:PORT` by lsof). The host's curl reaches
# it over dual-stack, but the simulator app's fetch to the IPv4 literal does NOT
# connect to the IPv6 listener and times out ("Server is waking up or
# unreachable") — whereas `localhost` resolves to `::1` and reaches it. (Verified
# 2026-06-07 on the dev Mac.) The harness health probe below still curls
# 127.0.0.1 from the host, which works.
if [[ "$PLATFORM" == "android" ]]; then
  command -v adb >/dev/null && adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1 || true
  CLOUD_URL="http://127.0.0.1:$PORT"
else
  CLOUD_URL="http://localhost:$PORT"
fi
# Percent-encode the URL for the `rebel://e2e/pair?cloudUrl=...` deep link: query
# values MUST be encoded (an unencoded `://` mangles the parsed URL and the app
# pairs against a broken host). Used by the pairing step below + login.yaml.
CLOUD_URL_ENC="${CLOUD_URL//%/%25}"; CLOUD_URL_ENC="${CLOUD_URL_ENC//:/%3A}"; CLOUD_URL_ENC="${CLOUD_URL_ENC//\//%2F}"

echo "==> [4/6] (re)install app + start device log capture"
# IMPORTANT (pairing reset): Maestro's `launchApp: clearState` clears the app
# data container but NOT the iOS Keychain / Android keystore, where pairing
# credentials live — so `clearState` does NOT unpair. NOTE (verified 2026-06-07):
# on the iOS SIMULATOR, `xcrun simctl uninstall` ALSO does not clear the keychain,
# so even uninstall+reinstall can leave the app paired. The RELIABLE E2E pairing
# mechanism is therefore the test-mode deep link (Stage 11): deliver
# `rebel://e2e/pair?cloudUrl=<url>&token=<tok>` via `xcrun simctl openurl` — it
# calls the real pair() and OVERWRITES any stale pairing, no unpair needed. The
# uninstall below is best-effort (clears app data; helps on Android / real fresh
# installs); set E2E_KEEP_PAIRING=1 to skip it. For a guaranteed-unpaired sim use
# `xcrun simctl erase` (wipes keychain) before install.
if [[ -n "$APP_PATH" ]]; then
  if [[ "$PLATFORM" == "android" ]]; then
    [[ "${E2E_KEEP_PAIRING:-0}" != "1" ]] && adb uninstall "$APP_BUNDLE_ID" >/dev/null 2>&1 || true
    adb install -r "$APP_PATH"
    ( adb logcat -v time >"$DEVICE_LOG" 2>&1 ) & DEVICE_LOG_PID=$!
  else
    [[ "${E2E_KEEP_PAIRING:-0}" != "1" ]] && xcrun simctl uninstall booted "$APP_BUNDLE_ID" >/dev/null 2>&1 || true
    xcrun simctl install booted "$APP_PATH"
    ( xcrun simctl spawn booted log stream --style compact --predicate 'processImagePath CONTAINS "Rebel"' >"$DEVICE_LOG" 2>&1 ) & DEVICE_LOG_PID=$!
  fi
else
  echo "    (no --app given; assuming the app is already installed — NOTE: clearState does"
  echo "     NOT unpair; pass --app to force a clean unpaired reinstall, or use the e2e pair"
  echo "     deep link / E2E_KEEP_PAIRING=1 if you intend to reuse an existing pairing.)"
fi

echo "==> [4.5/6] establish pairing (deep link → fully-booted app)"
# Pairing MUST happen here, against a fully-booted app — NOT from inside a Maestro
# flow. A deep link delivered before the JS bundle has hydrated (common on a cold
# clearState launch, especially a Metro dev build) races the loader and leaves the
# test-mode pair route stuck on its spinner. Delivering it to an already-running
# app is reliable. The resulting pairing lives in the iOS Keychain, which
# `launchApp: clearState` does NOT clear — so every Maestro flow's clearState
# relaunch restores it and lands on home. login.yaml asserts exactly that.
#
# We launch + re-deliver the link a few times because the very first delivery can
# still beat hydration on a cold boot; each delivery re-mounts the pair route,
# which runs the real pair() (itself retried). Set E2E_SKIP_PAIR=1 to skip (e.g.
# when intentionally reusing an existing pairing and the cloud URL is unchanged).
PAIR_LINK="rebel://e2e/pair?cloudUrl=${CLOUD_URL_ENC}&token=${TOKEN}&runId=${RUN_ID}"
if [[ "${E2E_SKIP_PAIR:-0}" == "1" ]]; then
  echo "    (E2E_SKIP_PAIR=1 — reusing existing pairing)"
elif [[ "$PLATFORM" == "android" ]]; then
  adb shell monkey -p "$APP_BUNDLE_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  for _ in 1 2 3 4; do
    sleep 4
    adb shell am start -a android.intent.action.VIEW -d "$PAIR_LINK" "$APP_BUNDLE_ID" >/dev/null 2>&1 || true
  done
else
  xcrun simctl launch booted "$APP_BUNDLE_ID" >/dev/null 2>&1 || true
  for _ in 1 2 3 4; do
    sleep 4
    xcrun simctl openurl booted "$PAIR_LINK" >/dev/null 2>&1 || true
  done
fi
echo "    delivered pairing deep link (cloudUrl=$CLOUD_URL)"

echo "==> [5/6] seed deterministic backend state"
seed() { curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "X-Rebel-E2E-Run-Id: $RUN_ID" -H 'Content-Type: application/json' "$@"; }
# Reset + (re)seed every fixture. Called before EACH flow (step 6) because the
# approval/conflict flows consume their fixtures (resolve the approval / drop the
# staged file) — a single up-front seed would leave later flows with nothing to
# act on. Approval/conflict endpoints are tolerated-if-absent on older builds.
seed_all() {
  seed -d '{}' "http://127.0.0.1:$PORT/__e2e/reset" >/dev/null
  seed -d '{"title":"Seed conversation for Maestro"}' "http://127.0.0.1:$PORT/__e2e/seed/conversation" >/dev/null
  seed -d '{}' "http://127.0.0.1:$PORT/__e2e/seed/tool-approval" >/dev/null || true
  seed -d '{}' "http://127.0.0.1:$PORT/__e2e/seed/staged-file-conflict" >/dev/null || true
}
seed_all
echo "    seeded conversation + tool-approval + staged-conflict (runId=$RUN_ID)"

echo "==> [6/6] run Maestro flows with debug output → $OUT_DIR"
# Build the ordered flow list.
FLOWS=()
if [[ -n "$FLOW_OVERRIDE" ]]; then
  FLOWS=("$FLOW_OVERRIDE")
else
  FLOWS=("${DEFAULT_FLOWS[@]}")
fi
echo "    flows: ${FLOWS[*]}"
# Run each flow as its own `maestro test`, re-seeding a clean fixture set first so
# every flow gets fresh backend state regardless of what earlier flows consumed.
# We DON'T stop on first failure — a green-by-flow report is more useful than a
# halt; the overall exit code is non-zero if any flow failed.
MAESTRO_RC=0
FAILED_FLOWS=()
for f in "${FLOWS[@]}"; do
  echo "----> flow: $f (re-seeding fixtures)"
  seed_all
  set +e
  CLOUD_URL="$CLOUD_URL" CLOUD_URL_ENC="$CLOUD_URL_ENC" CLOUD_TOKEN="$TOKEN" \
    maestro test \
      --test-output-dir "$OUT_DIR/$f" \
      --debug-output "$OUT_DIR/$f" \
      "$MOBILE_DIR/.maestro/$f"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then MAESTRO_RC=$rc; FAILED_FLOWS+=("$f"); fi
done
[[ ${#FAILED_FLOWS[@]} -gt 0 ]] && echo "    FAILED flows: ${FAILED_FLOWS[*]}"

echo "==> done (maestro rc=$MAESTRO_RC). Artifacts: $OUT_DIR"
echo "    cloud log: $CLOUD_LOG   device log: $DEVICE_LOG   (all tagged runId=$RUN_ID)"
exit $MAESTRO_RC
