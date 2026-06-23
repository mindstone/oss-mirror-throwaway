#!/bin/bash
# Downloads Moonshine.xcframework and MoonshineVoice Swift sources for iOS builds.
# Runs as EAS build hook (eas-build-pre-install) before pod install.
#
# Downloads from the official moonshine-swift SPM distribution repo, which is
# the maintained release channel (the main moonshine repo stopped publishing
# standalone xcframework zips).
#
# GRACEFUL FAILURE: If the download fails, the build continues without local
# STT. The app will use cloud STT instead. This prevents a Moonshine hosting
# outage from blocking all iOS builds.

set -uo pipefail
# NOTE: -e is intentionally NOT set. We handle errors explicitly so a download
# failure doesn't crash the entire build.

MOONSHINE_VERSION="${MOONSHINE_VERSION:-v0.0.53}"

# Paths relative to mobile/ root (EAS runs from mobile/)
MODULE_DIR="modules/moonshine-stt/ios"
FRAMEWORK_DIR="${MODULE_DIR}/Frameworks"
VENDOR_SWIFT_DIR="${MODULE_DIR}/MoonshineVoice"

# Download from moonshine-swift (official SPM distribution repo), NOT moonshine (main repo).
XCFRAMEWORK_ZIP_URL="https://github.com/moonshine-ai/moonshine-swift/releases/download/${MOONSHINE_VERSION}/Moonshine.xcframework.zip"
SWIFT_SOURCES_URL="https://github.com/moonshine-ai/moonshine-swift/archive/refs/tags/${MOONSHINE_VERSION}.tar.gz"

# No hardcoded file list — we copy ALL *.swift from Sources/MoonshineVoice/.
# Upstream may add files (e.g. TTS support in v0.0.53); a static allowlist
# silently breaks the build when MoonshineAPI.swift references new types.

echo "[MoonshineStt] Setting up Moonshine ${MOONSHINE_VERSION} from moonshine-swift..."

# --- xcframework ---

VALID=true
if [ -f "${FRAMEWORK_DIR}/Moonshine.xcframework/Info.plist" ]; then
  for slice in ios-arm64 ios-arm64_x86_64-simulator macos-arm64_x86_64; do
    if [ ! -f "${FRAMEWORK_DIR}/Moonshine.xcframework/${slice}/libmoonshine.a" ]; then
      echo "[MoonshineStt] Missing slice ${slice}, re-downloading..."
      VALID=false
      break
    fi
  done
else
  VALID=false
fi

if [ "$VALID" = true ]; then
  echo "[MoonshineStt] Moonshine.xcframework already present and valid, skipping download."
else
  rm -rf "${FRAMEWORK_DIR}/Moonshine.xcframework"
  mkdir -p "${FRAMEWORK_DIR}"
  TEMP_ZIP=$(mktemp /tmp/moonshine-xcframework-XXXXXX.zip)
  trap 'rm -f "${TEMP_ZIP}"' EXIT

  echo "[MoonshineStt] Downloading xcframework from moonshine-swift releases..."
  if ! curl -fsSL --retry 3 --retry-delay 5 "${XCFRAMEWORK_ZIP_URL}" -o "${TEMP_ZIP}"; then
    echo "[MoonshineStt] WARNING: Failed to download Moonshine.xcframework."
    echo "[MoonshineStt] Local STT will be unavailable — app will use cloud STT instead."
    echo "[MoonshineStt] URL: ${XCFRAMEWORK_ZIP_URL}"
    rm -f "${TEMP_ZIP}"
    trap - EXIT
    exit 0
  fi

  unzip -q -o "${TEMP_ZIP}" 'Moonshine.xcframework/**' -d "${FRAMEWORK_DIR}"
  rm -f "${TEMP_ZIP}"
  trap - EXIT

  # Strip test-assets to save ~300MB
  find "${FRAMEWORK_DIR}/Moonshine.xcframework" -type d -name "test-assets" -exec rm -rf {} + 2>/dev/null || true
  find "${FRAMEWORK_DIR}/Moonshine.xcframework" -type d -name "Resources" -empty -delete 2>/dev/null || true

  echo "[MoonshineStt] Extracted Moonshine.xcframework (all slices, test-assets stripped)."
fi

# --- MoonshineVoice Swift sources ---

if [ -f "${VENDOR_SWIFT_DIR}/Transcriber.swift" ]; then
  echo "[MoonshineStt] MoonshineVoice Swift sources already present, skipping."
else
  echo "[MoonshineStt] Downloading MoonshineVoice Swift wrapper sources..."
  mkdir -p "${VENDOR_SWIFT_DIR}"

  # Download the tag archive and extract just the Swift sources.
  # This is a single HTTP request instead of 10 individual file downloads.
  TEMP_TAR=$(mktemp /tmp/moonshine-swift-XXXXXX.tar.gz)
  TEMP_EXTRACT=$(mktemp -d /tmp/moonshine-swift-extract-XXXXXX)

  if curl -fsSL --retry 3 --retry-delay 5 "${SWIFT_SOURCES_URL}" -o "${TEMP_TAR}"; then
    tar -xzf "${TEMP_TAR}" -C "${TEMP_EXTRACT}" --strip-components=1 "moonshine-swift-${MOONSHINE_VERSION#v}/Sources/MoonshineVoice/" 2>/dev/null || \
    tar -xzf "${TEMP_TAR}" -C "${TEMP_EXTRACT}" --strip-components=1 2>/dev/null

    # Copy ALL Swift sources to vendor dir (no hardcoded allowlist)
    SRC_DIR="${TEMP_EXTRACT}/Sources/MoonshineVoice"
    if [ -d "${SRC_DIR}" ]; then
      FOUND=$(find "${SRC_DIR}" -maxdepth 1 -name "*.swift" | wc -l | tr -d ' ')
      find "${SRC_DIR}" -maxdepth 1 -name "*.swift" -exec cp {} "${VENDOR_SWIFT_DIR}/" \;
      echo "[MoonshineStt] Extracted ${FOUND} MoonshineVoice Swift files."
    else
      echo "[MoonshineStt] WARNING: Could not find Sources/MoonshineVoice/ in archive."
      echo "[MoonshineStt] Local STT will be unavailable — app will use cloud STT instead."
    fi
  else
    echo "[MoonshineStt] WARNING: Failed to download MoonshineVoice sources."
    echo "[MoonshineStt] Local STT will be unavailable — app will use cloud STT instead."
  fi

  rm -f "${TEMP_TAR}"
  rm -rf "${TEMP_EXTRACT}"
fi

echo "[MoonshineStt] Setup complete."
