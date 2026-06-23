#!/bin/bash
#
# Reset onboarding state for Mindstone Rebel (does NOT revoke OS permissions).
#
# What this resets:
#   - app-settings.json (electron-store settings)
#   - localStorage (permission-onboarding-shown flag)
#   - Session history (optional, with --all flag)
#
# OS permissions (Microphone, Files & Folders) must be revoked manually via:
#   System Settings → Privacy & Security → [Microphone / Files and Folders]
#

set -e

# Dev uses package.json "name", prod uses "productName"
APP_SUPPORT_DEV="$HOME/Library/Application Support/mindstone-rebel"
APP_SUPPORT_PROD="$HOME/Library/Application Support/Mindstone Rebel"

RESET_ALL=false
RESET_WORKSPACE=false
RESET_KEYS=false
TARGET="both"  # dev, prod, or both

usage() {
  echo "Usage: $0 [--dev | --prod] [--all] [--reset-workspace] [--reset-keys]"
  echo ""
  echo "Options:"
  echo "  --dev              Reset dev environment only"
  echo "  --prod             Reset prod environment only"
  echo "  --all              Also clear session history"
  echo "  --reset-workspace  Also clear workspace/coreDirectory setting"
  echo "  --reset-keys       Also clear API keys (Claude, voice providers)"
  echo ""
  echo "By default, resets both dev and prod environments."
  echo "This script does NOT revoke OS permissions - do that manually in System Settings."
  exit 0
}

for arg in "$@"; do
  case $arg in
    --dev)
      TARGET="dev"
      ;;
    --prod)
      TARGET="prod"
      ;;
    --all)
      RESET_ALL=true
      ;;
    --reset-workspace)
      RESET_WORKSPACE=true
      ;;
    --reset-keys)
      RESET_KEYS=true
      ;;
    -h|--help)
      usage
      ;;
  esac
done

echo "Resetting Mindstone Rebel onboarding state..."
echo ""

# Check if app is running
if pgrep -f "Mindstone Rebel" > /dev/null 2>&1 || pgrep -f "mindstone-rebel" > /dev/null 2>&1; then
  echo "⚠️  Warning: Mindstone Rebel appears to be running. Please quit the app first."
  exit 1
fi

reset_directory() {
  local APP_SUPPORT_DIR="$1"
  local ENV_NAME="$2"

  if [ ! -d "$APP_SUPPORT_DIR" ]; then
    echo "[$ENV_NAME] Directory does not exist: $APP_SUPPORT_DIR (skipping)"
    return
  fi

  echo "[$ENV_NAME] Resetting: $APP_SUPPORT_DIR"

  local SETTINGS_FILE="$APP_SUPPORT_DIR/app-settings.json"
  local LOCAL_STORAGE_DIR="$APP_SUPPORT_DIR/Local Storage"
  local SESSIONS_DIR="$APP_SUPPORT_DIR/sessions"

  # Reset settings file (set onboardingCompleted to false, preserve other settings)
  if [ -f "$SETTINGS_FILE" ]; then
    if command -v jq > /dev/null 2>&1; then
      echo "  → Resetting onboarding flags in app-settings.json..."
      
      # Build jq filter dynamically based on flags
      # Reset all Phase 0 onboarding state (matches in-app "Restart full onboarding" behavior)
      JQ_FILTER='.onboardingCompleted = false | .onboardingFirstCompletedAt = null | .onboardingDay = null | .onboardingCompletedAt = null | .onboardingSessionIds = null'
      
      if [ "$RESET_WORKSPACE" = true ]; then
        echo "  → Also clearing workspace (coreDirectory)..."
        JQ_FILTER="$JQ_FILTER | .coreDirectory = null"
      fi
      
      if [ "$RESET_KEYS" = true ]; then
        echo "  → Also clearing API keys..."
        JQ_FILTER="$JQ_FILTER | .claude.apiKey = null | .voice.openaiApiKey = null | .voice.elevenlabsApiKey = null"
      fi
      
      jq "$JQ_FILTER" "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
    else
      echo "  → Deleting app-settings.json (jq not installed for partial reset)..."
      rm "$SETTINGS_FILE"
    fi
  else
    echo "  → No app-settings.json found (already clean)"
  fi

  # Clear localStorage (contains permission-onboarding-shown flag)
  if [ -d "$LOCAL_STORAGE_DIR" ]; then
    echo "  → Clearing localStorage..."
    rm -rf "$LOCAL_STORAGE_DIR"
  else
    echo "  → No Local Storage found (already clean)"
  fi

  # Optionally clear sessions
  if [ "$RESET_ALL" = true ]; then
    if [ -d "$SESSIONS_DIR" ]; then
      echo "  → Clearing session history..."
      rm -rf "$SESSIONS_DIR"
    else
      echo "  → No sessions found (already clean)"
    fi
  fi

  # Reset journey state in achievements store (completedDays, journeyStartedAt, graduationModalShown)
  local ACHIEVEMENTS_FILE="$APP_SUPPORT_DIR/achievements.json"
  if [ -f "$ACHIEVEMENTS_FILE" ]; then
    if command -v jq > /dev/null 2>&1; then
      echo "  → Resetting onboarding journey in achievements.json..."
      jq '.onboarding = { "completedDays": [], "journeyStartedAt": null, "graduationModalShown": null }' "$ACHIEVEMENTS_FILE" > "$ACHIEVEMENTS_FILE.tmp" && mv "$ACHIEVEMENTS_FILE.tmp" "$ACHIEVEMENTS_FILE"
    else
      echo "  → Skipping achievements.json reset (jq not installed)"
    fi
  fi

  echo ""
}

# Reset based on target
if [ "$TARGET" = "dev" ] || [ "$TARGET" = "both" ]; then
  reset_directory "$APP_SUPPORT_DEV" "DEV"
fi

if [ "$TARGET" = "prod" ] || [ "$TARGET" = "both" ]; then
  reset_directory "$APP_SUPPORT_PROD" "PROD"
fi

echo "✓ Onboarding state reset complete."
echo ""
echo "Next steps to fully test onboarding:"
echo "  1. Revoke Microphone permission: System Settings → Privacy & Security → Microphone"
echo "  2. Revoke Files & Folders: System Settings → Privacy & Security → Files and Folders"
echo "  3. Launch Mindstone Rebel"
