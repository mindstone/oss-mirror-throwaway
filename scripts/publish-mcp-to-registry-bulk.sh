#!/usr/bin/env bash
# Bulk-publish every connector under <mcp-servers>/connectors/ to the MCP
# Registry. Use this for the one-time backfill or whenever you suspect Phase F
# step 29 was skipped on a recent publish and the registry has drifted from npm.
#
# Usage:
#   ./scripts/publish-mcp-to-registry-bulk.sh [--dry-run]
#                                             [--connector=<name>]
#                                             [--mcp-servers=<path>]
#
# Prereqs: same as publish-mcp-to-registry.sh.
#
# Per-connector outcomes printed as a single table:
#   PASS      — already registered at the version in server.json
#   PUBLISHED — published this run (only without --dry-run)
#   WOULD-PUB — would publish (--dry-run only)
#   SKIP      — preflight failed; details in the third column
#   FAIL      — publish attempted but mcp-publisher errored
#
# Per-connector failures log the reason but do not abort — one bad connector
# cannot block the rest.
#
# --mcp-servers defaults to <repo>/mcp-servers when the submodule is
# initialized (connectors/ present), else ../mcp-servers (legacy sibling).
# Override via flag or MCP_SERVERS_REPO env var.

set -euo pipefail

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPO_ROOT="$(cd "$_HERE/.." && pwd)"
_DEFAULT_MCP_SERVERS="$_REPO_ROOT/../mcp-servers"
if [[ -d "$_REPO_ROOT/mcp-servers/connectors" ]]; then
  _DEFAULT_MCP_SERVERS="$_REPO_ROOT/mcp-servers"
fi

DRY=0
ONLY=""
MCP_SERVERS="${MCP_SERVERS_REPO:-$_DEFAULT_MCP_SERVERS}"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --connector=*) ONLY="${arg#--connector=}" ;;
    --mcp-servers=*) MCP_SERVERS="${arg#--mcp-servers=}" ;;
    --help|-h)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -d "$MCP_SERVERS/connectors" ]]; then
  echo "ERROR: no connectors/ under $MCP_SERVERS (use --mcp-servers=<path>)" >&2
  exit 1
fi

PUB="$_HERE/publish-mcp-to-registry.sh"

printf "%-30s %-10s %s\n" CONNECTOR ACTION DETAIL
printf "%-30s %-10s %s\n" "------------------------------" "----------" "------"

shopt -s nullglob
for d in "$MCP_SERVERS"/connectors/*/; do
  name="$(basename "$d")"
  [[ "$name" == "_template" ]] && continue
  if [[ -n "$ONLY" && "$ONLY" != "$name" ]]; then
    continue
  fi

  SJ="${d}server.json"
  if [[ ! -f "$SJ" ]]; then
    printf "%-30s %-10s %s\n" "$name" SKIP "no server.json"
    continue
  fi

  NAME=$(jq -r '.name' "$SJ" 2>/dev/null || true)
  VER=$(jq -r '.version' "$SJ" 2>/dev/null || true)
  PKG=$(jq -r '.packages[0].identifier' "$SJ" 2>/dev/null || true)
  if [[ -z "$NAME" || "$NAME" == "null" || -z "$VER" || "$VER" == "null" || -z "$PKG" || "$PKG" == "null" ]]; then
    printf "%-30s %-10s %s\n" "$name" SKIP "malformed server.json"
    continue
  fi

  # Cheap preflight to classify each connector before touching mcp-publisher.
  NPM_MCPNAME=$(npm view "$PKG@$VER" mcpName 2>/dev/null || true)
  if [[ -z "$NPM_MCPNAME" ]]; then
    printf "%-30s %-10s %s\n" "$name" SKIP "mcpName not in npm@$VER (needs no-op bump)"
    continue
  fi
  if [[ "$NPM_MCPNAME" != "$NAME" ]]; then
    printf "%-30s %-10s %s\n" "$name" SKIP "mcpName mismatch (npm=$NPM_MCPNAME)"
    continue
  fi

  REG=$(curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=$NAME" 2>/dev/null \
          | jq -r --arg n "$NAME" --arg v "$VER" '.servers[]? | select(.server.name==$n and .server.version==$v) | .server.version' \
          | head -1)
  if [[ "$REG" == "$VER" ]]; then
    printf "%-30s %-10s %s\n" "$name" PASS "already registered"
    continue
  fi

  if [[ "$DRY" == "1" ]]; then
    printf "%-30s %-10s %s\n" "$name" WOULD-PUB "registry=${REG:-none} → $VER"
  else
    OUT=$(mktemp)
    if "$PUB" "$name" --mcp-servers="$MCP_SERVERS" > "$OUT" 2>&1; then
      printf "%-30s %-10s %s\n" "$name" PUBLISHED "$VER"
    else
      printf "%-30s %-10s %s\n" "$name" FAIL "$(tail -1 "$OUT")"
    fi
    rm -f "$OUT"
  fi
done
