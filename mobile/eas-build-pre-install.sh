#!/bin/bash
# EAS Build hook: runs before dependency installation (before pod install).
# See: https://docs.expo.dev/build-reference/npm-hooks/
set -uo pipefail

echo "=== EAS pre-install hook ==="

# Download Moonshine xcframework and Swift sources for iOS builds.
# Graceful failure: if download fails, build continues without local STT.
if [ "${EAS_BUILD_PLATFORM:-}" = "ios" ] || [ "$(uname)" = "Darwin" ]; then
  bash scripts/download-moonshine-xcframework.sh
fi

echo "=== EAS pre-install hook complete ==="
