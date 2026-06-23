#!/bin/bash
# Count Lines of Code for rebel-app
#
# Usage:
#   ./scripts/count-loc.sh              # Source code only (src/, scripts/, config/)
#   ./scripts/count-loc.sh --all        # Include tests
#   ./scripts/count-loc.sh --evals      # Count evals separately (harness + fixtures)
#   ./scripts/count-loc.sh --docs       # Include docs/ directory
#   ./scripts/count-loc.sh --full       # Include docs + skills directories
#   ./scripts/count-loc.sh --submodules # Also count submodules separately
#   ./scripts/count-loc.sh --json       # JSON output for parsing
#
# Prerequisites: scc (install with: brew install scc)
#
# Default (source code):
#   - src/, scripts/, config/ directories
#   - Root config files (*.json, *.js, *.ts, *.mjs)
#
# What's always excluded:
#   - node_modules, dist, out, build, coverage
#   - Generated code (src/preload/generated/)
#   - Submodules (rebel-system, super-mcp, coding-agent-instructions)
#   - Test files by default (tests/, *.test.ts, *.spec.ts)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Parse arguments
FORMAT="wide"
INCLUDE_TESTS=false
INCLUDE_EVALS=false
INCLUDE_DOCS=false
INCLUDE_FULL=false
INCLUDE_SUBMODULES=false

for arg in "$@"; do
  case $arg in
    --json)
      FORMAT="json"
      shift
      ;;
    --all)
      INCLUDE_TESTS=true
      shift
      ;;
    --evals)
      INCLUDE_EVALS=true
      shift
      ;;
    --docs)
      INCLUDE_DOCS=true
      shift
      ;;
    --full)
      INCLUDE_FULL=true
      shift
      ;;
    --submodules)
      INCLUDE_SUBMODULES=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--all] [--docs] [--full] [--submodules] [--json]"
      echo ""
      echo "Options:"
      echo "  --all        Include test files"
      echo "  --evals      Count evals separately (harness + fixtures)"
      echo "  --docs       Include docs/ directory"
      echo "  --full       Include docs + skills directories"
      echo "  --submodules Also count submodules separately"
      echo "  --json       Output in JSON format"
      exit 0
      ;;
  esac
done

# Check if scc is installed
if ! command -v scc &> /dev/null; then
  echo "Error: scc is not installed. Install with: brew install scc"
  exit 1
fi

# Common exclusions for all runs
COMMON_EXCLUDES=(
  --exclude-dir node_modules
  --exclude-dir dist
  --exclude-dir out
  --exclude-dir build
  --exclude-dir .git
  --exclude-dir .vite
  --exclude-dir .cache
  --exclude-dir generated
)

# Test exclusions
TEST_EXCLUDES=(
  --exclude-dir tests
  --exclude-dir __tests__
)

# Build target directories based on flags
build_targets() {
  local targets="src scripts config"
  
  if [ "$INCLUDE_DOCS" = true ] || [ "$INCLUDE_FULL" = true ]; then
    targets="$targets docs"
  fi
  
  if [ "$INCLUDE_FULL" = true ]; then
    targets="$targets skills"
  fi
  
  # Add root config files
  local root_configs=""
  for f in *.json *.js *.ts *.mjs *.cjs *.md; do
    if [ -f "$f" ] && [ "$f" != "package-lock.json" ]; then
      root_configs="$root_configs $f"
    fi
  done
  
  echo "$targets $root_configs"
}

# Build scc command
build_scc_command() {
  local include_tests=$1
  local targets=$2
  
  local cmd="scc $targets --no-cocomo --sort code --format $FORMAT"
  
  for exclude in "${COMMON_EXCLUDES[@]}"; do
    cmd="$cmd $exclude"
  done
  
  if [ "$include_tests" = false ]; then
    for exclude in "${TEST_EXCLUDES[@]}"; do
      cmd="$cmd $exclude"
    done
  fi
  
  echo "$cmd"
}

# Main project count
if [ "$FORMAT" = "wide" ]; then
  echo "================================================================================"
  echo -n "rebel-app Lines of Code"
  if [ "$INCLUDE_FULL" = true ]; then
    echo -n " (FULL: source + docs + skills)"
  elif [ "$INCLUDE_DOCS" = true ]; then
    echo -n " (source + docs)"
  else
    echo -n " (source only: src/, scripts/, config/)"
  fi
  if [ "$INCLUDE_TESTS" = true ]; then
    echo " [with tests]"
  else
    echo " [excluding tests]"
  fi
  echo "================================================================================"
  echo ""
fi

targets=$(build_targets)
cmd=$(build_scc_command "$INCLUDE_TESTS" "$targets")
eval $cmd

# Evals count if requested
if [ "$INCLUDE_EVALS" = true ]; then
  EVAL_EXCLUDES=(
    --exclude-dir node_modules
    --exclude-dir .cache
    --exclude-dir __pycache__
    --exclude-dir results
    --exclude-dir .git
    --exclude-dir .workspace-snapshot
  )

  if [ "$FORMAT" = "wide" ]; then
    echo ""
    echo "================================================================================"
    echo "Evals: harness code (evals/*.ts, mcp-twins/, __tests__/, gui/, benchmarks/)"
    echo "================================================================================"
    echo ""
  fi

  eval_cmd="scc evals/ --no-cocomo --sort code --format $FORMAT --exclude-dir fixtures --not-match '\\.built'"
  for exclude in "${EVAL_EXCLUDES[@]}"; do
    eval_cmd="$eval_cmd $exclude"
  done
  eval $eval_cmd

  if [ "$FORMAT" = "wide" ]; then
    echo ""
    echo "================================================================================"
    echo "Evals: fixtures (evals/fixtures/)"
    echo "================================================================================"
    echo ""
  fi

  eval_cmd="scc evals/fixtures/ --no-cocomo --sort code --format $FORMAT"
  eval $eval_cmd
fi

# Submodule counts if requested
if [ "$INCLUDE_SUBMODULES" = true ]; then
  if [ "$FORMAT" = "wide" ]; then
    echo ""
    echo "================================================================================"
    echo "Submodule: rebel-system"
    echo "================================================================================"
    echo ""
  fi
  
  # For submodules, we need a fresh command without the submodule exclusions
  SUBMODULE_EXCLUDES=(
    --exclude-dir node_modules
    --exclude-dir dist
    --exclude-dir out
    --exclude-dir build
    --exclude-dir coverage
    --exclude-dir .vite
    --exclude-dir .cache
    --exclude-dir tmp
    --exclude-dir temp
    --exclude-dir .git
    --exclude-dir generated
  )
  
  # rebel-system also excludes Anthropic-official-skills (third-party)
  sub_cmd="scc rebel-system --no-cocomo --sort code --format $FORMAT --exclude-dir Anthropic-official-skills"
  for exclude in "${SUBMODULE_EXCLUDES[@]}"; do
    sub_cmd="$sub_cmd $exclude"
  done
  for exclude in "${LOCKFILE_EXCLUDES[@]}"; do
    sub_cmd="$sub_cmd $exclude"
  done
  eval $sub_cmd
  
  if [ "$FORMAT" = "wide" ]; then
    echo ""
    echo "================================================================================"
    echo "Submodule: super-mcp"
    echo "================================================================================"
    echo ""
  fi
  
  sub_cmd="scc super-mcp --no-cocomo --sort code --format $FORMAT"
  for exclude in "${SUBMODULE_EXCLUDES[@]}"; do
    sub_cmd="$sub_cmd $exclude"
  done
  for exclude in "${LOCKFILE_EXCLUDES[@]}"; do
    sub_cmd="$sub_cmd $exclude"
  done
  eval $sub_cmd
  
  if [ "$FORMAT" = "wide" ]; then
    echo ""
    echo "================================================================================"
    echo "Submodule: coding-agent-instructions"
    echo "================================================================================"
    echo ""
  fi
  
  sub_cmd="scc coding-agent-instructions --no-cocomo --sort code --format $FORMAT"
  for exclude in "${SUBMODULE_EXCLUDES[@]}"; do
    sub_cmd="$sub_cmd $exclude"
  done
  for exclude in "${LOCKFILE_EXCLUDES[@]}"; do
    sub_cmd="$sub_cmd $exclude"
  done
  eval $sub_cmd
fi

if [ "$FORMAT" = "wide" ]; then
  echo ""
  echo "================================================================================"
  echo "Options: --all (tests) | --evals | --docs | --full | --submodules | --json"
  echo "================================================================================"
fi
