#!/usr/bin/env bash
# =============================================================================
# test-github-org-rename-redirects.sh
#
# Validates GitHub organisation rename redirect behaviour by:
#   1. Creating a fresh test org + repo (org creation is manual)
#   2. Recording baseline behaviour
#   3. Renaming the org (manual step)
#   4. Running 9 automated post-rename checks
#   5. Printing a summary table
#
# Usage:
#   ./scripts/test-github-org-rename-redirects.sh
#
# Prerequisites: gh, jq, git, curl, ssh
#
# Cleanup: After the script finishes, delete the test org manually via
#   https://github.com/organizations/<ORG_NAME>/settings → Danger zone → Delete
# =============================================================================
set -euo pipefail

# ─── Argument Parsing ────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -nE '2,/^# =====/{ /^# =====/d; s/^#[[:space:]]?//; p; }' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--help]" >&2
      exit 1
      ;;
  esac
done

# ─── Parameterized Names ─────────────────────────────────────────────────────

TS=$(date +%Y%m%d%H%M%S)
ORG_OLD="ms-rename-test-${TS}"
ORG_NEW="ms-rename-done-${TS}"
REPO="test-rename"

# ─── Temp Directory ──────────────────────────────────────────────────────────

TMPDIR_BASE=$(mktemp -d)
REPO_CHECKOUT="${TMPDIR_BASE}/checkout"
CLONE_SSH_DIR="${TMPDIR_BASE}/clone-ssh"
CLONE_HTTPS_DIR="${TMPDIR_BASE}/clone-https"

# Curl config file for auth (avoids leaking token in process list via -H)
CURL_AUTH_CFG="${TMPDIR_BASE}/.curl-auth"

# ─── State ───────────────────────────────────────────────────────────────────

PUSH_SHA=""
DEFAULT_BRANCH=""
declare -a TEST_NAMES=()
declare -a TEST_EXPECTED=()
declare -a TEST_OBSERVED=()
declare -a TEST_RESULTS=()
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0

# ─── Cleanup Trap ────────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  echo ""
  echo "── Cleanup ──────────────────────────────────────────────────────"

  # Remove local temp dirs
  if [[ -d "${TMPDIR_BASE}" ]]; then
    echo "Removing temp directory: ${TMPDIR_BASE}"
    rm -rf "${TMPDIR_BASE}"
  fi

  # Remind operator to clean up remote resources manually
  echo ""
  echo "  MANUAL CLEANUP: When you're done, delete the test org at:"
  echo "    https://github.com/organizations/${ORG_NEW}/settings"
  echo "    (or ${ORG_OLD} if the rename didn't happen)"
  echo "    → Scroll to 'Danger zone' → 'Delete this organization'"

  echo "─────────────────────────────────────────────────────────────────"
  exit "$exit_code"
}
trap cleanup EXIT

# ─── Helper Functions ─────────────────────────────────────────────────────────

# Colours (safe for non-colour terminals)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GREEN='' RED='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

info()  { echo -e "${CYAN}ℹ${RESET}  $*"; }
ok()    { echo -e "${GREEN}✓${RESET}  $*"; }
warn()  { echo -e "${YELLOW}⚠${RESET}  $*"; }
fail()  { echo -e "${RED}✗${RESET}  $*"; }

# Record a test result. Does NOT exit on failure.
# Usage: record_test <index> <name> <expected> <observed> <PASS|FAIL|SKIP>
record_test() {
  local idx="$1" name="$2" expected="$3" observed="$4" result="$5"
  TEST_NAMES[$idx]="$name"
  TEST_EXPECTED[$idx]="$expected"
  TEST_OBSERVED[$idx]="$observed"
  TEST_RESULTS[$idx]="$result"

  case "$result" in
    PASS) ok "Test #${idx}: ${name} — ${result}"; ((TOTAL_PASS++)) || true ;;
    FAIL) fail "Test #${idx}: ${name} — ${result} (expected: ${expected}, observed: ${observed})"; ((TOTAL_FAIL++)) || true ;;
    SKIP) warn "Test #${idx}: ${name} — ${result} (${observed})"; ((TOTAL_SKIP++)) || true ;;
  esac
}

# Best-effort browser opening
open_browser() {
  local url="$1"
  if command -v open &>/dev/null; then
    open "$url" 2>/dev/null || true
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$url" 2>/dev/null || true
  elif command -v start &>/dev/null; then
    start "$url" 2>/dev/null || true
  fi
}

# Poll until a condition is met. Uses wall-clock time for accurate timeouts.
# Usage: poll_until <description> <max_seconds> <interval> <command...>
poll_until() {
  local desc="$1" max_secs="$2" interval="$3"
  shift 3
  local start_time elapsed
  start_time=$(date +%s)
  info "Polling: ${desc} (timeout: ${max_secs}s)"
  while true; do
    elapsed=$(( $(date +%s) - start_time ))
    if (( elapsed >= max_secs )); then break; fi
    if "$@" >/dev/null 2>&1; then
      ok "${desc} — ready (${elapsed}s)"
      return 0
    fi
    sleep "$interval"
    printf "  … %ds / %ds\r" "$elapsed" "$max_secs"
  done
  echo ""
  fail "${desc} — timed out after ${max_secs}s"
  return 1
}

# Prompt operator to press Enter
wait_for_enter() {
  echo ""
  read -r -p "  Press Enter when done... "
  echo ""
}

# Get GitHub auth token for raw curl calls
get_gh_token() {
  gh auth token
}

# ─── Phase 0: Prerequisites ──────────────────────────────────────────────────

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  GitHub Org Rename Redirect Test${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  Old org name:  ${ORG_OLD}"
echo "  New org name:  ${ORG_NEW}"
echo "  Test repo:     ${REPO}"
echo "  Cleanup:       manual (delete org via GitHub UI when done)"
echo ""

info "Phase 0: Checking prerequisites..."

# Required tools
for tool in gh jq git curl ssh; do
  if ! command -v "$tool" &>/dev/null; then
    fail "Required tool not found: ${tool}"
    exit 1
  fi
done
ok "Required tools: gh, jq, git, curl, ssh"

# gh auth status
if ! gh auth status &>/dev/null; then
  fail "Not authenticated with gh. Run: gh auth login"
  exit 1
fi
ok "gh authenticated"

# Explicit scope check — verify we can perform org-level operations
GH_TOKEN=$(get_gh_token)

# Write auth to temp config file (avoids leaking token in process list via -H)
cat > "${CURL_AUTH_CFG}" <<EOF
header = "Authorization: token ${GH_TOKEN}"
header = "Accept: application/vnd.github+json"
EOF
chmod 600 "${CURL_AUTH_CFG}"

SCOPE_CHECK_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 15 \
  -K "${CURL_AUTH_CFG}" \
  "https://api.github.com/user/orgs")

if [[ "${SCOPE_CHECK_STATUS}" != "200" ]]; then
  fail "gh token cannot list user orgs (HTTP ${SCOPE_CHECK_STATUS}). Check scopes: gh auth refresh -h github.com -s repo,workflow"
  exit 1
fi
ok "gh token scopes sufficient (can list orgs)"

# git identity
if [[ -z "$(git config user.name 2>/dev/null || true)" ]] || [[ -z "$(git config user.email 2>/dev/null || true)" ]]; then
  fail "git user.name / user.email not configured"
  exit 1
fi
ok "git identity configured"

# SSH auth to GitHub
if ! ssh -T [external-email] 2>&1 | grep -qi "successfully authenticated"; then
  warn "SSH auth to GitHub may not be configured — SSH tests may fail"
else
  ok "SSH auth to GitHub working"
fi

# HTTPS auth via gh
if ! gh auth setup-git 2>/dev/null; then
  warn "gh auth setup-git failed — HTTPS clone may need manual auth"
else
  ok "HTTPS auth configured via gh"
fi

echo ""
ok "All prerequisites satisfied"
echo ""

# ─── Phase 1: Setup ──────────────────────────────────────────────────────────

info "Phase 1: Setup"
echo ""

# --- Manual step: org creation ---
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  MANUAL STEP: Create the test organisation${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  1. Go to: https://github.com/account/organizations/new"
echo "     (attempting to open in your browser...)"
echo ""
echo "  2. Create a FREE organisation with this exact name:"
echo -e "       ${BOLD}${ORG_OLD}${RESET}"
echo ""
echo "  3. Skip inviting members, finish creation"
echo ""

open_browser "https://github.com/account/organizations/new"
wait_for_enter

# Readiness gate: poll until org exists
poll_until "Org ${ORG_OLD} visible via API" 120 5 \
  gh api "orgs/${ORG_OLD}" --jq .login

echo ""
info "Creating test repository: ${ORG_OLD}/${REPO}"
gh repo create "${ORG_OLD}/${REPO}" --public --description "Org rename redirect test (auto-created, safe to delete)"
ok "Repository created: ${ORG_OLD}/${REPO}"

# Clone via SSH and set up working checkout
git clone "[external-email]:${ORG_OLD}/${REPO}.git" "${REPO_CHECKOUT}"
cd "${REPO_CHECKOUT}"

# Detect default branch name
DEFAULT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")
info "Default branch: ${DEFAULT_BRANCH}"

# Create a minimal CI workflow
mkdir -p .github/workflows
cat > .github/workflows/ci.yml << 'WORKFLOW_EOF'
name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "CI is working"
WORKFLOW_EOF

# Initial commit and push
git add -A
git commit -m "chore: initial commit with CI workflow"
if ! git push origin "${DEFAULT_BRANCH}"; then
  fail "Initial push failed — cannot proceed"
  exit 1
fi
ok "Initial commit pushed"

info "Waiting for initial CI run to confirm Actions are working..."
sleep 10  # Brief pause for GitHub to register the push

# Verify initial CI run kicked off (best-effort, non-blocking)
if gh run list --repo "${ORG_OLD}/${REPO}" --limit 1 --json status --jq '.[0].status' 2>/dev/null | grep -qE "queued|in_progress|completed"; then
  ok "Initial CI workflow detected"
else
  warn "Could not confirm initial CI run — CI test (#9) may be affected"
fi

echo ""
ok "Phase 1 complete: org + repo + CI workflow ready"
echo ""

# ─── Phase 2: Record Baseline ────────────────────────────────────────────────

info "Phase 2: Recording baseline..."

BASELINE_WEB_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://github.com/${ORG_OLD}/${REPO}")
BASELINE_ORG_API=$(gh api "orgs/${ORG_OLD}" --jq .login 2>/dev/null || echo "FAILED")
BASELINE_REPO_API=$(gh api "repos/${ORG_OLD}/${REPO}" --jq .full_name 2>/dev/null || echo "FAILED")

echo "  Repo web URL:    HTTP ${BASELINE_WEB_STATUS}"
echo "  Org API (.login): ${BASELINE_ORG_API}"
echo "  Repo API (.full_name): ${BASELINE_REPO_API}"

if [[ "${BASELINE_WEB_STATUS}" != "200" ]] || [[ "${BASELINE_ORG_API}" != "${ORG_OLD}" ]] || [[ "${BASELINE_REPO_API}" != "${ORG_OLD}/${REPO}" ]]; then
  fail "Baseline checks failed — something is wrong with the test setup"
  exit 1
fi

ok "Baseline recorded — all checks nominal"
echo ""

# ─── Phase 3: Rename ─────────────────────────────────────────────────────────

info "Phase 3: Rename"
echo ""

echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  MANUAL STEP: Rename the organisation${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  1. Go to: https://github.com/organizations/${ORG_OLD}/settings"
echo "     (attempting to open in your browser...)"
echo ""
echo "  2. Scroll to \"Danger zone\" at the bottom"
echo ""
echo "  3. Click \"Rename organization\""
echo ""
echo "  4. IMPORTANT: Change the org LOGIN/HANDLE (not the display name!)"
echo -e "       Old name: ${BOLD}${ORG_OLD}${RESET}"
echo -e "       New name: ${BOLD}${ORG_NEW}${RESET}"
echo ""
echo "  5. Confirm the rename"
echo ""

open_browser "https://github.com/organizations/${ORG_OLD}/settings"
wait_for_enter

# Dual readiness gate: poll until BOTH conditions are met
# Condition 1: new org responds 200
# Condition 2: old org responds non-200 (404)
info "Waiting for rename to propagate (dual readiness gate)..."

check_new_org_ready() {
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -K "${CURL_AUTH_CFG}" \
    "https://api.github.com/orgs/${ORG_NEW}")
  [[ "$status" == "200" ]]
}

check_old_org_gone() {
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -K "${CURL_AUTH_CFG}" \
    "https://api.github.com/orgs/${ORG_OLD}")
  # Specifically check for 404, not just "any non-200" (transient errors shouldn't pass)
  [[ "$status" == "404" ]]
}

check_both_ready() {
  check_new_org_ready && check_old_org_gone
}

poll_until "New org (${ORG_NEW}) visible AND old org (${ORG_OLD}) gone" 180 5 check_both_ready

echo ""
info "Brief propagation delay (10s)..."
sleep 10
ok "Phase 3 complete — rename confirmed"
echo ""

# ─── Phase 4: Post-Rename Checks ─────────────────────────────────────────────

info "Phase 4: Running post-rename checks..."
echo ""

# --- Test 1: Old repo web URL redirect ---
info "Test #1: Old repo web URL redirect"
# Phase 1: without -L, check for redirect status and Location header
T1_HEADERS=$(curl -s -D - -o /dev/null --max-time 30 "https://github.com/${ORG_OLD}/${REPO}")
T1_STATUS=$(echo "$T1_HEADERS" | head -1 | { grep -oE '[0-9]{3}' || true; } | head -1)
T1_LOCATION=$(echo "$T1_HEADERS" | { grep -i '^location:' || true; } | sed $'s/^[Ll]ocation: *//; s/\r$//' | head -1)

# Phase 2: with -L, check effective URL
T1_EFFECTIVE_URL=$(curl -s -o /dev/null -w '%{url_effective}' -L --max-time 30 "https://github.com/${ORG_OLD}/${REPO}")
T1_FINAL_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 30 "https://github.com/${ORG_OLD}/${REPO}")

T1_OBSERVED="${T1_STATUS}"
if [[ -n "$T1_LOCATION" ]]; then
  T1_OBSERVED="${T1_STATUS}→$(echo "$T1_LOCATION" | head -c 60)"
fi

# Validate redirect target matches expected org/repo pattern
T1_EXPECTED_PATTERN="github.com/${ORG_NEW}/${REPO}"
if [[ "$T1_STATUS" =~ ^30[0-9]$ ]] && [[ "$T1_EFFECTIVE_URL" == *"${T1_EXPECTED_PATTERN}"* ]] && [[ "$T1_FINAL_STATUS" == "200" ]]; then
  record_test 1 "Old repo web redirect" "30x→${ORG_NEW}/${REPO}" "$T1_OBSERVED (final: ${T1_FINAL_STATUS})" "PASS"
else
  record_test 1 "Old repo web redirect" "30x→${ORG_NEW}/${REPO}" "$T1_OBSERVED (final: ${T1_FINAL_STATUS})" "FAIL"
fi

# --- Test 2: Old org profile page ---
info "Test #2: Old org profile page"
T2_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://github.com/${ORG_OLD}")

if [[ "$T2_STATUS" == "404" ]]; then
  record_test 2 "Old org profile page" "404" "$T2_STATUS" "PASS"
else
  record_test 2 "Old org profile page" "404" "$T2_STATUS" "FAIL"
fi

# --- Test 3: Old org API request (raw curl, NOT gh api — it follows redirects) ---
info "Test #3: Old org API request"
T3_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
  -K "${CURL_AUTH_CFG}" \
  "https://api.github.com/orgs/${ORG_OLD}")

if [[ "$T3_STATUS" == "404" ]]; then
  record_test 3 "Old org API request" "404" "$T3_STATUS" "PASS"
elif [[ "$T3_STATUS" == "301" ]]; then
  record_test 3 "Old org API request" "404" "${T3_STATUS} (redirect at API level)" "PASS"
else
  record_test 3 "Old org API request" "404" "$T3_STATUS" "FAIL"
fi

# --- Test 4: Old repo API request (raw curl, NOT gh api — it follows redirects) ---
info "Test #4: Old repo API request"
T4_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
  -K "${CURL_AUTH_CFG}" \
  "https://api.github.com/repos/${ORG_OLD}/${REPO}")

if [[ "$T4_STATUS" == "404" ]]; then
  record_test 4 "Old repo API request" "404 or 301" "${T4_STATUS} (confirmed break)" "PASS"
elif [[ "$T4_STATUS" == "301" ]]; then
  record_test 4 "Old repo API request" "404 or 301" "${T4_STATUS} (redirect active at API level)" "PASS"
else
  record_test 4 "Old repo API request" "404 or 301" "$T4_STATUS" "FAIL"
fi

# --- Test 5: New repo API request ---
info "Test #5: New repo API request"
T5_FULL_NAME=$(gh api "repos/${ORG_NEW}/${REPO}" --jq .full_name 2>/dev/null || echo "FAILED")
T5_EXPECTED="${ORG_NEW}/${REPO}"

if [[ "$T5_FULL_NAME" == "$T5_EXPECTED" ]]; then
  record_test 5 "New repo API request" "200, ${T5_EXPECTED}" "$T5_FULL_NAME" "PASS"
else
  record_test 5 "New repo API request" "200, ${T5_EXPECTED}" "$T5_FULL_NAME" "FAIL"
fi

# --- Test 6: Git push via old SSH remote (consolidated with CI trigger) ---
info "Test #6: Git push via old SSH remote"
cd "${REPO_CHECKOUT}"

# Verify remote still points to old org name
CURRENT_REMOTE=$(git remote get-url origin)
if ! echo "$CURRENT_REMOTE" | grep -q "${ORG_OLD}"; then
  warn "Remote URL doesn't contain old org name: ${CURRENT_REMOTE}"
fi

# Make a trivial commit and push via old remote
echo "# Post-rename push test $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> README.md
git add README.md
git commit -m "test: post-rename push via old SSH remote"
if git push origin "${DEFAULT_BRANCH}" 2>&1; then
  PUSH_SHA=$(git rev-parse HEAD)
  record_test 6 "Git push via old SSH" "Push succeeds" "OK (SHA: ${PUSH_SHA:0:8})" "PASS"
else
  record_test 6 "Git push via old SSH" "Push succeeds" "FAILED" "FAIL"
  PUSH_SHA=""
fi

# --- Test 7: Git clone via old SSH URL ---
info "Test #7: Git clone via old SSH URL"
if git clone "[external-email]:${ORG_OLD}/${REPO}.git" "${CLONE_SSH_DIR}" 2>&1; then
  record_test 7 "Git clone via old SSH" "Clone succeeds" "OK" "PASS"
else
  record_test 7 "Git clone via old SSH" "Clone succeeds" "FAILED" "FAIL"
fi

# --- Test 8: Git clone via old HTTPS URL ---
info "Test #8: Git clone via old HTTPS URL"
if git clone "https://github.com/${ORG_OLD}/${REPO}.git" "${CLONE_HTTPS_DIR}" 2>&1; then
  record_test 8 "Git clone via old HTTPS" "Clone succeeds" "OK" "PASS"
else
  record_test 8 "Git clone via old HTTPS" "Clone succeeds" "FAILED" "FAIL"
fi

# --- Test 9: CI trigger after rename (uses SHA from test 6) ---
info "Test #9: CI trigger after rename (polling for SHA: ${PUSH_SHA:0:8})"
if [[ -z "$PUSH_SHA" ]]; then
  record_test 9 "CI trigger after rename" "Workflow runs" "Skipped (no push SHA from test 6)" "SKIP"
else
  CI_FOUND=false
  CI_STATUS="unknown"
  CI_CONCLUSION="pending"
  CI_TIMEOUT=300  # 5 minutes
  CI_INTERVAL=10
  CI_START=$(date +%s)

  while true; do
    CI_ELAPSED=$(( $(date +%s) - CI_START ))
    if (( CI_ELAPSED >= CI_TIMEOUT )); then break; fi

    # Query runs for the specific SHA — take first match only via [0]
    RUN_INFO=$(gh run list --repo "${ORG_NEW}/${REPO}" --json headSha,status,conclusion \
      --jq "[.[] | select(.headSha == \"${PUSH_SHA}\")][0]" 2>/dev/null || echo "")

    if [[ -n "$RUN_INFO" ]] && [[ "$RUN_INFO" != "null" ]]; then
      CI_STATUS=$(echo "$RUN_INFO" | jq -r '.status' 2>/dev/null || echo "unknown")
      CI_CONCLUSION=$(echo "$RUN_INFO" | jq -r '.conclusion // "pending"' 2>/dev/null || echo "pending")

      if [[ "$CI_STATUS" == "completed" ]]; then
        CI_FOUND=true
        break
      fi
    fi

    sleep "$CI_INTERVAL"
    printf "  … %ds / %ds (status: %s)\r" "$CI_ELAPSED" "$CI_TIMEOUT" "${CI_STATUS}"
  done
  echo ""

  if [[ "$CI_FOUND" == "true" ]]; then
    if [[ "$CI_CONCLUSION" == "success" ]]; then
      record_test 9 "CI trigger after rename" "Workflow succeeds" "completed (${CI_CONCLUSION})" "PASS"
    else
      record_test 9 "CI trigger after rename" "Workflow succeeds" "completed (${CI_CONCLUSION})" "FAIL"
      warn "  CI completed but conclusion was: ${CI_CONCLUSION} (not success)"
    fi
  else
    record_test 9 "CI trigger after rename" "Workflow succeeds" "timed out (${CI_STATUS})" "FAIL"
  fi
fi

echo ""
ok "Phase 4 complete"
echo ""

# ─── Phase 5: Summary Table ──────────────────────────────────────────────────

info "Phase 5: Summary"
echo ""

# Print summary table
printf "╔══════╦═══════════════════════════════╦═════════════════════════════════╦══════════════════════════════════════════════╦════════╗\n"
printf "║  %-3s ║ %-29s ║ %-31s ║ %-44s ║ %-6s ║\n" "#" "Test" "Expected" "Observed" "Result"
printf "╠══════╬═══════════════════════════════╬═════════════════════════════════╬══════════════════════════════════════════════╬════════╣\n"

for i in 1 2 3 4 5 6 7 8 9; do
  name="${TEST_NAMES[$i]:-—}"
  expected="${TEST_EXPECTED[$i]:-—}"
  observed="${TEST_OBSERVED[$i]:-—}"
  result="${TEST_RESULTS[$i]:-—}"

  # Truncate long strings for table display
  name="${name:0:29}"
  expected="${expected:0:31}"
  observed="${observed:0:44}"

  # Colour the result
  case "$result" in
    PASS) result_display="${GREEN}PASS${RESET}" ;;
    FAIL) result_display="${RED}FAIL${RESET}" ;;
    SKIP) result_display="${YELLOW}SKIP${RESET}" ;;
    *)    result_display="$result" ;;
  esac

  printf "║  %-3s ║ %-29s ║ %-31s ║ %-44s ║ " "$i" "$name" "$expected" "$observed"
  printf '%s' "${result_display}"
  printf "%*s║\n" $((6 - ${#result})) ""
done

printf "╚══════╩═══════════════════════════════╩═════════════════════════════════╩══════════════════════════════════════════════╩════════╝\n"

echo ""
echo "  Totals: ${GREEN}${TOTAL_PASS} PASS${RESET}  ${RED}${TOTAL_FAIL} FAIL${RESET}  ${YELLOW}${TOTAL_SKIP} SKIP${RESET}"
echo ""

# Conclusion block
T1_RESULT="${TEST_RESULTS[1]:-FAIL}"
T2_RESULT="${TEST_RESULTS[2]:-FAIL}"
T3_RESULT="${TEST_RESULTS[3]:-FAIL}"
T4_RESULT="${TEST_RESULTS[4]:-FAIL}"
T5_RESULT="${TEST_RESULTS[5]:-FAIL}"
T6_RESULT="${TEST_RESULTS[6]:-FAIL}"
T7_RESULT="${TEST_RESULTS[7]:-FAIL}"
T8_RESULT="${TEST_RESULTS[8]:-FAIL}"
T9_RESULT="${TEST_RESULTS[9]:-FAIL}"

yesno() { if [[ "$1" == "PASS" ]]; then echo "YES"; else echo "NO"; fi; }

echo "CONCLUSION:"
echo "  Repo URL redirects safe:     $(yesno "$T1_RESULT")"
echo "  Old org profile breaks:      $(yesno "$T2_RESULT") (404 as expected)"
echo "  Old API calls break:         $(if [[ "$T3_RESULT" == "PASS" && "$T4_RESULT" == "PASS" ]]; then echo "YES"; else echo "NO"; fi) (404/301 as expected)"
echo "  New API works:               $(yesno "$T5_RESULT")"
echo "  Git transport redirects:     $(if [[ "$T6_RESULT" == "PASS" && "$T7_RESULT" == "PASS" && "$T8_RESULT" == "PASS" ]]; then echo "YES"; else echo "NO"; fi) (push + clone work via old URLs)"
echo "  CI runs after rename:        $(yesno "$T9_RESULT")"
echo ""

echo "NOTE: This test does NOT validate:"
echo "  - Third-party CI/services that store the org name internally"
echo "  - Webhooks, OAuth app config, Fly configs, hardcoded string references"
echo "  - GitHub Pages or npm @scope packages under the org"
echo "  - Whether redirects survive if the old org name gets re-registered by someone else"
echo ""

# Exit code: 0 if no FAIL (SKIPs are acceptable)
if (( TOTAL_FAIL > 0 )); then
  fail "Some tests FAILED — see above for details"
  exit 1
else
  ok "All tests passed (${TOTAL_PASS} pass, ${TOTAL_SKIP} skip)"
  exit 0
fi
