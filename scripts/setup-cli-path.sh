#!/usr/bin/env sh
set -eu

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

dry_run="${SETUP_CLI_DRY_RUN:-0}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source_cli="${REBEL_CLI_SOURCE:-"$script_dir/rebel.js"}"
bin_dir="${REBEL_CLI_BIN_DIR:-"$HOME/.local/bin"}"
target="$bin_dir/rebel"

run_or_print() {
  if [ "$dry_run" = "1" ]; then
    log "DRY RUN: $*"
  else
    "$@"
  fi
}

append_path_hint() {
  case ":${PATH:-}:" in
    *":$bin_dir:"*) return 0 ;;
  esac

  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh) profile="${HOME}/.zprofile" ;;
    bash)
      if [ "$(uname -s)" = "Darwin" ]; then
        profile="${HOME}/.bash_profile"
      else
        profile="${HOME}/.bashrc"
      fi
      ;;
    *) profile="${HOME}/.profile" ;;
  esac

  path_line="export PATH=\"$bin_dir:\$PATH\""
  if [ -f "$profile" ] && grep -F "$path_line" "$profile" >/dev/null 2>&1; then
    return 0
  fi

  if [ "$dry_run" = "1" ]; then
    log "DRY RUN: would add $bin_dir to PATH in $profile"
    return 0
  fi

  {
    printf '\n# Mindstone Rebel CLI\n'
    printf '%s\n' "$path_line"
  } >> "$profile"
  log "Added $bin_dir to PATH in $profile. Restart your terminal to pick it up."
}

if [ ! -f "$source_cli" ]; then
  warn "Rebel CLI source not found: $source_cli"
  exit 0
fi

if [ -e "$target" ] || [ -L "$target" ]; then
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source_cli" ]; then
    log "Rebel CLI already linked at $target"
    append_path_hint
    exit 0
  fi
  warn "Refusing to overwrite existing rebel binary at $target"
  exit 0
fi

run_or_print mkdir -p "$bin_dir"
if [ "$dry_run" = "1" ]; then
  log "DRY RUN: would symlink $target -> $source_cli"
else
  ln -s "$source_cli" "$target"
  log "Linked Rebel CLI: $target -> $source_cli"
fi

append_path_hint
