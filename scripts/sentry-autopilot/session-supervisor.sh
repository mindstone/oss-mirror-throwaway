#!/usr/bin/env bash
# Ensure CLI binaries are on PATH:
#   droid        installs to ~/.local/bin (Factory installer)
#   cursor-agent installs to ~/.local/bin (Cursor installer)
#   claude       installs to ~/.local/bin (Anthropic installer)
# All three share ~/.local/bin so a single PATH export is enough today; if any
# vendor ever ships to a different location, add it here.
export PATH="$HOME/.local/bin:$PATH"
# Runner selection. Defaults to droid for backward compatibility; set
# AUTOPILOT_CLI=cursor or AUTOPILOT_CLI=claude in the autopilot env file
# to switch.
AUTOPILOT_CLI="${AUTOPILOT_CLI:-droid}"
AUTOPILOT_CURSOR_MODEL="${AUTOPILOT_CURSOR_MODEL:-composer-2.5}"
AUTOPILOT_CLAUDE_MODEL="${AUTOPILOT_CLAUDE_MODEL:-claude-opus-4-8}"
# VM-specific Claude settings file. Suppresses the committed
# .claude/settings.json (which declares dev-only SessionEnd/SessionStart
# Python transcript-export hooks the autopilot VM doesn't have) while
# leaving MCP servers, plugins, and the Task subagent tool intact — those
# are exactly what CHIEF_BUGFIXER Phase 2 needs (Sentry MCP for evidence,
# Task for parallel debugger investigation). The default lives next to
# this script so cron picks it up without extra env wiring; operators can
# override AUTOPILOT_CLAUDE_SETTINGS if they want a custom settings file.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTOPILOT_CLAUDE_SETTINGS="${AUTOPILOT_CLAUDE_SETTINGS:-$SCRIPT_DIR/claude-settings.json}"
ARTIFACT_DIR="${4:-/tmp/autopilot-fallback}"
EXIT_CODE=1
TIMEOUT="${5:-2700}"

trap finish EXIT
umask 077
set -euo pipefail

runner_json_fragment() {
  # Emit the runner metadata as a JSON object fragment (no surrounding braces).
  # Always includes "cli"; includes "cursorModel" only when running cursor and
  # "claudeModel" only when running claude, to match reporter.ts runnerMeta()
  # and avoid noisy empty tags on droid runs.
  case "$AUTOPILOT_CLI" in
    cursor)
      printf '"runner":{"cli":"%s","cursorModel":"%s"}' \
        "$AUTOPILOT_CLI" "$AUTOPILOT_CURSOR_MODEL"
      ;;
    claude)
      printf '"runner":{"cli":"%s","claudeModel":"%s"}' \
        "$AUTOPILOT_CLI" "$AUTOPILOT_CLAUDE_MODEL"
      ;;
    *)
      printf '"runner":{"cli":"%s"}' "$AUTOPILOT_CLI"
      ;;
  esac
}

inject_runner_metadata() {
  # Idempotently merge runner metadata into an existing outcome.json. Used for
  # the success path where the CLI runner produced its own outcome.json. The
  # fallback path bakes runner directly into the printf so jq is not required
  # there. If jq is missing or the file is malformed we log and skip rather
  # than failing the autopilot — runner attribution is observability, not a
  # correctness gate.
  local outcome_file="$ARTIFACT_DIR/outcome.json"

  if [ ! -f "$outcome_file" ]; then
    return
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) WARN: jq not available; skipping runner metadata injection" \
      >> "$ARTIFACT_DIR/supervisor.log"
    return
  fi

  local jq_filter model_arg
  case "$AUTOPILOT_CLI" in
    cursor)
      jq_filter='. + {runner: {cli: $cli, cursorModel: $model}}'
      model_arg="$AUTOPILOT_CURSOR_MODEL"
      ;;
    claude)
      jq_filter='. + {runner: {cli: $cli, claudeModel: $model}}'
      model_arg="$AUTOPILOT_CLAUDE_MODEL"
      ;;
    *)
      jq_filter='. + {runner: {cli: $cli}}'
      model_arg=""
      ;;
  esac

  local tmp_file="${outcome_file}.tmp"
  if jq \
      --arg cli "$AUTOPILOT_CLI" \
      --arg model "$model_arg" \
      "$jq_filter" \
      "$outcome_file" > "$tmp_file" 2>>"$ARTIFACT_DIR/supervisor.log"; then
    mv "$tmp_file" "$outcome_file"
  else
    rm -f "$tmp_file"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) WARN: jq failed to inject runner metadata into outcome.json" \
      >> "$ARTIFACT_DIR/supervisor.log"
  fi
}

write_fallback_outcome() {
  mkdir -p "$ARTIFACT_DIR"

  if [ -f "$ARTIFACT_DIR/outcome.json" ]; then
    return
  fi

  local error_message
  if [ "$EXIT_CODE" -eq 124 ]; then
    error_message="Session timed out after ${TIMEOUT}s"
  else
    error_message="${AUTOPILOT_CLI} runner exited without writing outcome.json"
  fi

  printf '{"outcome":"failed","failure_kind":"supervisor_failure","original_outcome":null,"exit_code":%d,"error":"%s",%s}\n' \
    "$EXIT_CODE" "$error_message" "$(runner_json_fragment)" > "$ARTIFACT_DIR/outcome.json"

  printf '{"level":"error","component":"sentry-autopilot-supervisor","log_discriminator":"supervisor_fail","sentryId":"%s","exit_code":%d,"error":"%s","cli":"%s","message":"Session supervisor wrote fallback outcome"}\n' \
    "${SENTRY_ID:-unknown}" "$EXIT_CODE" "$error_message" "$AUTOPILOT_CLI" >&2
}

finish() {
  local trap_code=$?
  if [ "$EXIT_CODE" -eq 0 ] && [ "$trap_code" -ne 0 ]; then
    EXIT_CODE="$trap_code"
  fi

  write_fallback_outcome
  inject_runner_metadata
  touch "$ARTIFACT_DIR/.done"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Session completed (exit $EXIT_CODE)" >> "$ARTIFACT_DIR/supervisor.log"
  exit 0
}

if [ "$#" -lt 4 ]; then
  echo "Usage: session-supervisor.sh WORKTREE SENTRY_ID PROMPT_FILE ARTIFACT_DIR [TIMEOUT]" >&2
  exit 64
fi

WORKTREE="$1"
SENTRY_ID="$2"
PROMPT_FILE="$3"

mkdir -p "$ARTIFACT_DIR"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting session for $SENTRY_ID" > "$ARTIFACT_DIR/supervisor.log"
echo $$ > "$ARTIFACT_DIR/supervisor.pid"

cd "$WORKTREE"
# Strip reporter-only secrets (Slack webhook, Linear API key) from the bugfixer's
# environment so it cannot inadvertently re-post or mutate those surfaces.
# SENTRY_AUTH_TOKEN is intentionally retained: the CHIEF_BUGFIXER agent uses it
# as the REST fallback path when the Sentry MCP is disconnected (Stage G —
# see coding-agent-instructions/docs/SENTRY_REST_FALLBACK.md). The token MUST be
# scoped to read + issue-resolve only; see the doc for the full token-surface
# rationale and runbook.
unset SLACK_WEBHOOK LINEAR_API_KEY

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Invoking runner: ${AUTOPILOT_CLI}" >> "$ARTIFACT_DIR/supervisor.log"

set +e
case "$AUTOPILOT_CLI" in
  droid)
    timeout "$TIMEOUT" droid exec --auto high -f "$PROMPT_FILE" \
      >> "$ARTIFACT_DIR/supervisor.log" 2>&1
    EXIT_CODE=$?
    ;;
  cursor)
    if [ -z "${CURSOR_API_KEY:-}" ]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: AUTOPILOT_CLI=cursor requires CURSOR_API_KEY" \
        >> "$ARTIFACT_DIR/supervisor.log"
      EXIT_CODE=78
    else
      # cursor-agent doesn't accept a prompt file flag, so we pipe the prompt
      # via stdin. --print runs headlessly; --force allows tool calls without
      # interactive approval; --trust skips workspace trust prompts.
      # API key is read from CURSOR_API_KEY env var (passed through by tmux env).
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Using cursor model: ${AUTOPILOT_CURSOR_MODEL}" \
        >> "$ARTIFACT_DIR/supervisor.log"
      timeout "$TIMEOUT" cursor-agent \
        --print \
        --output-format stream-json \
        --model "$AUTOPILOT_CURSOR_MODEL" \
        --force \
        --trust \
        --workspace "$WORKTREE" \
        < "$PROMPT_FILE" \
        >> "$ARTIFACT_DIR/supervisor.log" 2>&1
      EXIT_CODE=$?
    fi
    ;;
  claude)
    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: AUTOPILOT_CLI=claude requires ANTHROPIC_API_KEY" \
        >> "$ARTIFACT_DIR/supervisor.log"
      EXIT_CODE=78
    else
      # Claude Code CLI invocation. Like cursor, claude doesn't take a prompt
      # file flag — we pipe via stdin. Flag breakdown:
      #   --print                          headless one-shot mode
      #   --output-format stream-json      structured JSON event per turn
      #   --verbose                        REQUIRED with stream-json under --print
      #                                    (claude 2.1.165 enforces this; see
      #                                    docs/plans/260604_autopilot_claude_code/spike_results.md)
      #   --dangerously-skip-permissions   skip tool-permission prompts (mirrors
      #                                    droid --auto high / cursor --force --trust)
      #   --settings <file>                point claude at the autopilot's
      #                                    VM-specific settings file (empty
      #                                    `hooks` object suppresses the committed
      #                                    .claude/settings.json's SessionEnd/
      #                                    SessionStart Python transcript-export
      #                                    hooks the VM doesn't have, while
      #                                    leaving MCP servers, plugins, and the
      #                                    Task subagent tool intact — exactly
      #                                    what CHIEF_BUGFIXER Phase 2 needs).
      #                                    Replaced --bare in 2026-06-06 once
      #                                    shadow runs revealed --bare also
      #                                    stripped MCP/Task and forced
      #                                    Phase-2-evidence-hard-stop escalations.
      #   --no-session-persistence         supervisor sessions are one-shot
      #   --add-dir "$WORKTREE"            grant tool access to the worktree
      # No --max-budget-usd: per user decision (2026-06-04), AUTOPILOT_SESSION_TIMEOUT
      # is the only Stage 1 cost ceiling. Promote to --max-budget-usd if Stage 8
      # shadow runs surface unbounded cost behaviour.
      # API key is read from ANTHROPIC_API_KEY env var (passed through by tmux env).
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Using claude model: ${AUTOPILOT_CLAUDE_MODEL}" \
        >> "$ARTIFACT_DIR/supervisor.log"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Using claude settings: ${AUTOPILOT_CLAUDE_SETTINGS}" \
        >> "$ARTIFACT_DIR/supervisor.log"
      timeout "$TIMEOUT" claude \
        --print \
        --output-format stream-json \
        --verbose \
        --model "$AUTOPILOT_CLAUDE_MODEL" \
        --dangerously-skip-permissions \
        --settings "$AUTOPILOT_CLAUDE_SETTINGS" \
        --no-session-persistence \
        --add-dir "$WORKTREE" \
        < "$PROMPT_FILE" \
        >> "$ARTIFACT_DIR/supervisor.log" 2>&1
      EXIT_CODE=$?
    fi
    ;;
  *)
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: unknown AUTOPILOT_CLI '${AUTOPILOT_CLI}' (expected 'droid', 'cursor', or 'claude')" \
      >> "$ARTIFACT_DIR/supervisor.log"
    EXIT_CODE=78
    ;;
esac
set -e
