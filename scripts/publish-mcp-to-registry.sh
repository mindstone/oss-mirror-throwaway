#!/usr/bin/env bash
# Publish one @mindstone/mcp-server-<connector> to the MCP Registry.
#
# Usage:
#   ./scripts/publish-mcp-to-registry.sh <connector> [--mcp-servers=<path>]
#
# Prereqs:
#   - mcp-publisher installed (brew install mcp-publisher) — see Phase 0.2
#     of docs/project/MCP_OSS_PACKAGE_MANUAL_UPDATE.md
#   - Logged in once per shell session: `mcp-publisher login github`
#     (device flow; `github-oidc` is the GitHub Actions variant, won't work
#     locally)
#   - jq, curl, npm on PATH
#
# Behaviour:
#   1. Reads <mcp-servers>/connectors/<connector>/server.json
#   2. Preflight A — `mcp-publisher validate` (schema/cross-file consistency)
#   3. Preflight B — verify the published npm tarball carries the expected
#      `mcpName` field (otherwise registry will reject ownership)
#   4. Preflight C — verify the npm version is not deprecated
#   5. `mcp-publisher publish`; on `already exists` we re-query the registry
#      to confirm a matching entry, then treat as success (idempotent)
#   6. Final visibility check via the registry search API
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

CONN=""
MCP_SERVERS="${MCP_SERVERS_REPO:-$_DEFAULT_MCP_SERVERS}"

for arg in "$@"; do
  case "$arg" in
    --mcp-servers=*) MCP_SERVERS="${arg#--mcp-servers=}" ;;
    --help|-h)
      sed -n '2,27p' "$0"
      exit 0
      ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)
      if [[ -n "$CONN" ]]; then
        echo "only one connector at a time (got '$CONN' and '$arg')" >&2
        exit 2
      fi
      CONN="$arg"
      ;;
  esac
done

if [[ -z "$CONN" ]]; then
  echo "usage: $0 <connector> [--mcp-servers=<path>]" >&2
  exit 2
fi

SJ="$MCP_SERVERS/connectors/$CONN/server.json"
if [[ ! -f "$SJ" ]]; then
  echo "ERROR: missing $SJ (check --mcp-servers path)" >&2
  exit 1
fi

NAME=$(jq -r '.name' "$SJ")
VER=$(jq -r '.version' "$SJ")
PKG=$(jq -r '.packages[0].identifier' "$SJ")

if [[ -z "$NAME" || -z "$VER" || -z "$PKG" || "$NAME" == "null" || "$VER" == "null" || "$PKG" == "null" ]]; then
  echo "ERROR: server.json missing name/version/packages[0].identifier" >&2
  exit 1
fi

echo "==> $CONN: $NAME @ $VER (npm: $PKG)"

# Preflight A — schema/manifest validation. Catches registry schema drift early.
mcp-publisher validate "$SJ"

# Preflight B — published npm version exists and carries matching mcpName.
ACTUAL_VER=$(npm view "$PKG@$VER" version 2>/dev/null || true)
if [[ "$ACTUAL_VER" != "$VER" ]]; then
  echo "ERROR: $PKG@$VER not visible on npm yet (got '$ACTUAL_VER'). CDN lag, wrong version, or never published?" >&2
  exit 1
fi
NPM_MCPNAME=$(npm view "$PKG@$VER" mcpName 2>/dev/null || true)
if [[ "$NPM_MCPNAME" != "$NAME" ]]; then
  echo "ERROR: mcpName drift — npm has '$NPM_MCPNAME', server.json has '$NAME'." >&2
  echo "       Likely the published version predates the mcpName addition. Cut a no-op patch bump per Phase B, republish, then retry." >&2
  exit 1
fi

# Preflight C — refuse to register a deprecated version.
DEP=$(npm view "$PKG@$VER" deprecated 2>/dev/null || true)
if [[ -n "$DEP" ]]; then
  echo "ERROR: $PKG@$VER is deprecated ($DEP); refusing to register." >&2
  exit 1
fi

# Publish (idempotent on republish of same name+version).
ERR_LOG=$(mktemp)
trap 'rm -f "$ERR_LOG"' EXIT

if mcp-publisher publish "$SJ" 2> "$ERR_LOG"; then
  echo "OK: published $NAME@$VER"
elif grep -qiE "duplicate version|already.?(exists|published)|version.*(exists|already)" "$ERR_LOG"; then
  # Defense in depth: confirm the registry actually has a matching record
  # before treating an error as success. The registry wraps each entry as
  # { servers: [ { server: { name, version, ... }, _meta: ... } ] }.
  if curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=$NAME" \
       | jq -e --arg n "$NAME" --arg v "$VER" '.servers[]? | select(.server.name==$n and .server.version==$v)' > /dev/null; then
    echo "OK: $NAME@$VER already registered (idempotent)"
  else
    echo "ERROR: mcp-publisher reported duplicate but registry has no matching $NAME@$VER" >&2
    cat "$ERR_LOG" >&2
    exit 1
  fi
else
  cat "$ERR_LOG" >&2
  exit 1
fi

# Final visibility check (eventual consistency — warn, don't fail).
if curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=$NAME" \
     | jq -e --arg n "$NAME" '.servers[]? | select(.server.name==$n)' > /dev/null; then
  echo "OK: visible in registry search"
else
  echo "WARN: not yet visible in registry search (eventual consistency; retry in a few seconds)" >&2
fi
