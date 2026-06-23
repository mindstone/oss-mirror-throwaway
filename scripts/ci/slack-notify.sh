#!/usr/bin/env bash

set -euo pipefail

SLACK_API_BASE="https://slack.com/api"

MODE=""
TEXT=""
EMOJI=""
THREAD_TS=""
FIND_BY_SHA=""

log() {
  echo "[slack-notify] $*" >&2
}

usage() {
  cat >&2 <<'EOF'
Usage:
  slack-notify.sh --mode post [--text "message"]
  slack-notify.sh --mode reply [--thread-ts <ts> | --find-by-sha <sha>] [--text "message"]
  slack-notify.sh --mode react [--thread-ts <ts> | --find-by-sha <sha>] --emoji <name>

Environment:
  SLACK_BOT_TOKEN   Slack Bot token (required)
  SLACK_CHANNEL_ID  Slack channel ID (required)

Notes:
  - For post/reply, --text can be omitted to read from stdin.
  - post/reply print the created message ts to stdout on success.
  - Diagnostics are written to stderr.
EOF
}

json_get() {
  local json="$1"
  local filter="$2"
  printf '%s' "$json" | jq -r "$filter" 2>/dev/null || true
}

read_text_input() {
  local provided_text="$1"

  if [[ -n "$provided_text" ]]; then
    printf '%s' "$provided_text"
    return 0
  fi

  if [[ ! -t 0 ]]; then
    cat
    return 0
  fi

  printf ''
}

slack_api_json() {
  local endpoint="$1"
  local payload="$2"

  log "API call: POST ${SLACK_API_BASE}/${endpoint}"
  log "Payload: ${payload}"

  local response
  local http_code
  response="$(curl -sS -w "\n%{http_code}" -X POST "${SLACK_API_BASE}/${endpoint}" \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data "$payload" 2>&1)" || true

  http_code="$(echo "$response" | tail -1)"
  response="$(echo "$response" | sed '$d')"

  log "HTTP status: ${http_code}"
  log "Response: ${response}"

  printf '%s' "$response"
}

slack_api_form() {
  local endpoint="$1"
  shift

  log "API call: POST ${SLACK_API_BASE}/${endpoint} (form-encoded)"
  log "Args: $*"

  local response
  local http_code
  response="$(curl -sS -w "\n%{http_code}" -X POST "${SLACK_API_BASE}/${endpoint}" \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    "$@" 2>&1)" || true

  http_code="$(echo "$response" | tail -1)"
  response="$(echo "$response" | sed '$d')"

  log "HTTP status: ${http_code}"
  log "Response: ${response}"

  printf '%s' "$response"
}

resolve_thread_ts() {
  local direct_ts="$1"
  local sha_input="$2"

  if [[ -n "$direct_ts" ]]; then
    printf '%s' "$direct_ts"
    return 0
  fi

  if [[ -z "$sha_input" ]]; then
    printf ''
    return 0
  fi

  local short_sha
  short_sha="${sha_input:0:7}"

  local response
  response="$(slack_api_form "conversations.history" \
    -d "channel=${SLACK_CHANNEL_ID}" \
    -d "limit=200")"

  if [[ -z "$response" ]]; then
    log "conversations.history returned an empty response; continuing without thread ts."
    printf ''
    return 0
  fi

  local ok
  ok="$(json_get "$response" '.ok // false')"
  if [[ "$ok" != "true" ]]; then
    local error
    error="$(json_get "$response" '.error // "unknown_error"')"
    log "conversations.history failed (${error}); continuing without thread ts."
    printf ''
    return 0
  fi

  local normalized_sha
  normalized_sha="$(printf '%s' "$short_sha" | tr '[:upper:]' '[:lower:]')"

  local found_ts
  found_ts="$(printf '%s' "$response" | jq -r --arg shortSha "$normalized_sha" '
    (.messages // [])
    | map(select(((.text // "") | ascii_downcase | contains($shortSha))))
    | .[0].ts // empty
  ' 2>/dev/null || true)"

  if [[ -z "$found_ts" ]]; then
    log "No anchor message found for SHA ${short_sha}; will post top-level message."
  fi

  printf '%s' "$found_ts"
}

post_message() {
  local text="$1"
  local thread_ts="$2"

  local payload
  if [[ -n "$thread_ts" ]]; then
    payload="$(jq -n \
      --arg channel "$SLACK_CHANNEL_ID" \
      --arg text "$text" \
      --arg thread_ts "$thread_ts" \
      '{channel: $channel, text: $text, thread_ts: $thread_ts, unfurl_links: false, unfurl_media: false}')"
  else
    payload="$(jq -n \
      --arg channel "$SLACK_CHANNEL_ID" \
      --arg text "$text" \
      '{channel: $channel, text: $text, unfurl_links: false, unfurl_media: false}')"
  fi

  local response
  response="$(slack_api_json "chat.postMessage" "$payload")"

  if [[ -z "$response" ]]; then
    log "chat.postMessage returned an empty response."
    return 0
  fi

  local ok
  ok="$(json_get "$response" '.ok // false')"
  if [[ "$ok" != "true" ]]; then
    local error
    error="$(json_get "$response" '.error // "unknown_error"')"
    log "chat.postMessage failed (${error})."
    return 0
  fi

  local ts
  ts="$(json_get "$response" '.ts // empty')"
  if [[ -n "$ts" ]]; then
    printf '%s\n' "$ts"
  else
    log "chat.postMessage succeeded but response had no ts."
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ $# -lt 2 ]]; then
        log "Missing value for --mode"
        usage
        exit 0
      fi
      MODE="$2"
      shift 2
      ;;
    --text)
      if [[ $# -lt 2 ]]; then
        log "Missing value for --text"
        usage
        exit 0
      fi
      TEXT="$2"
      shift 2
      ;;
    --emoji)
      if [[ $# -lt 2 ]]; then
        log "Missing value for --emoji"
        usage
        exit 0
      fi
      EMOJI="$2"
      shift 2
      ;;
    --thread-ts)
      if [[ $# -lt 2 ]]; then
        log "Missing value for --thread-ts"
        usage
        exit 0
      fi
      THREAD_TS="$2"
      shift 2
      ;;
    --find-by-sha)
      if [[ $# -lt 2 ]]; then
        log "Missing value for --find-by-sha"
        usage
        exit 0
      fi
      FIND_BY_SHA="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      log "Unknown argument: $1"
      usage
      exit 0
      ;;
  esac
done

log "=== slack-notify.sh v2 ==="
log "Mode: '${MODE}'"
log "Text length: ${#TEXT}"
log "Emoji: '${EMOJI}'"
log "Thread TS: '${THREAD_TS}'"
log "Find by SHA: '${FIND_BY_SHA}'"
log "SLACK_BOT_TOKEN set: $([ -n "${SLACK_BOT_TOKEN:-}" ] && echo 'yes' || echo 'NO')"
log "SLACK_BOT_TOKEN prefix: ${SLACK_BOT_TOKEN:+${SLACK_BOT_TOKEN:0:10}...}"
log "SLACK_CHANNEL_ID: '${SLACK_CHANNEL_ID:-}'"

if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  log "Missing required environment variable: SLACK_BOT_TOKEN"
  exit 1
fi

if [[ -z "${SLACK_CHANNEL_ID:-}" ]]; then
  log "Missing required environment variable: SLACK_CHANNEL_ID"
  exit 1
fi

if [[ -z "$MODE" ]]; then
  log "Missing required argument: --mode"
  usage
  exit 0
fi

case "$MODE" in
  post)
    message_text="$(read_text_input "$TEXT")"
    if [[ -z "$message_text" ]]; then
      log "No message text provided for post mode; skipping."
      exit 0
    fi

    post_message "$message_text" ""
    ;;

  reply)
    message_text="$(read_text_input "$TEXT")"
    if [[ -z "$message_text" ]]; then
      log "No message text provided for reply mode; skipping."
      exit 0
    fi

    resolved_thread_ts="$(resolve_thread_ts "$THREAD_TS" "$FIND_BY_SHA")"
    post_message "$message_text" "$resolved_thread_ts"
    ;;

  react)
    if [[ -z "$EMOJI" ]]; then
      log "Missing required argument for react mode: --emoji"
      usage
      exit 0
    fi

    resolved_thread_ts="$(resolve_thread_ts "$THREAD_TS" "$FIND_BY_SHA")"
    if [[ -z "$resolved_thread_ts" ]]; then
      log "No thread ts available for reaction; skipping reaction."
      exit 0
    fi

    payload="$(jq -n \
      --arg channel "$SLACK_CHANNEL_ID" \
      --arg timestamp "$resolved_thread_ts" \
      --arg name "$EMOJI" \
      '{channel: $channel, timestamp: $timestamp, name: $name}')"

    response="$(slack_api_json "reactions.add" "$payload")"
    if [[ -z "$response" ]]; then
      log "reactions.add returned an empty response; continuing."
      exit 0
    fi

    ok="$(json_get "$response" '.ok // false')"
    if [[ "$ok" == "true" ]]; then
      exit 0
    fi

    error="$(json_get "$response" '.error // "unknown_error"')"
    if [[ "$error" == "already_reacted" ]]; then
      log "Reaction :${EMOJI}: already exists on ${resolved_thread_ts}; continuing."
      exit 0
    fi

    log "reactions.add failed (${error}); continuing."
    exit 0
    ;;

  *)
    log "Invalid --mode value: ${MODE}. Expected post, reply, or react."
    usage
    exit 0
    ;;
esac
