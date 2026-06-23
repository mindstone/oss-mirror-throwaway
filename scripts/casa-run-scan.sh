#!/bin/bash
# CASA Tier 2 SAST scan using Fluid Attacks CLI
# Creates zip, extracts, and runs security scan via Docker
#
# Usage:
#   ./scripts/casa-run-scan.sh         # Run with CASA-required checks only
#   ./scripts/casa-run-scan.sh --all   # Run all security checks
#
# Output:
#   casa/mindstone-rebel-source-for-casa.zip  - Source zip for submission
#   casa/Fluid-Attacks-Results.csv            - Scan results

set -e

cd "$(dirname "$0")/.."

OUTPUT_DIR="casa"
ZIP_FILE="$OUTPUT_DIR/mindstone-rebel-source-for-casa.zip"
SCAN_WORK_DIR="$OUTPUT_DIR/scan-work"
RESULTS_FILE="$OUTPUT_DIR/Fluid-Attacks-Results.csv"
RUN_ALL_CHECKS=false

# Parse arguments
if [[ "$1" == "--all" ]]; then
    RUN_ALL_CHECKS=true
    echo "=== Full SAST Scan (all checks) ==="
else
    echo "=== CASA Tier 2 SAST Scan ==="
fi
echo ""

# Step 1: Create fresh zip
echo "Creating source zip..."
./scripts/casa-create-zip.sh
echo ""

# Step 2: Prepare scan directory
echo "Preparing scan environment..."
rm -rf "$SCAN_WORK_DIR"
mkdir -p "$SCAN_WORK_DIR"

# Step 3: Extract zip
echo "Extracting source..."
unzip -q "$ZIP_FILE" -d "$SCAN_WORK_DIR"

# Step 4: Build config
if [[ "$RUN_ALL_CHECKS" == "true" ]]; then
    echo "Using all security checks..."
    CHECKS_SECTION=""
else
    echo "Downloading official CASA config from App Defense Alliance..."
    curl -sL "https://appdefensealliance.dev/static/casa/tier-2/files/fluid-config.zip" -o "$SCAN_WORK_DIR/fluid-config.zip"
    unzip -q "$SCAN_WORK_DIR/fluid-config.zip" -d "$SCAN_WORK_DIR"
    rm "$SCAN_WORK_DIR/fluid-config.zip"
    
    # Extract checks list (lines starting with "- F")
    CHECKS=$(grep -E "^- F[0-9]+" "$SCAN_WORK_DIR/fluid-config.yaml" | sed 's/^/  /')
    CHECKS_SECTION="checks:
$CHECKS"
    rm -f "$SCAN_WORK_DIR/fluid-config.yaml"
fi

# Build config compatible with fluidattacks/sast (needs sast.include, not path.include)
cat > "$SCAN_WORK_DIR/config.yaml" << EOF
namespace: mindstone-rebel

output:
  file_path: ./Fluid-Attacks-Results.csv
  format: CSV

working_dir: .

sast:
  include:
    - .
  exclude:
    - node_modules
    - dist
    - build
    - out
    - release
    - .git
    - coverage
    - tmp

sca:
  include:
    - .
  exclude:
    - node_modules

$CHECKS_SECTION

language: EN
EOF

# Step 5: Run Fluid Attacks
echo "Running Fluid Attacks SAST scan (this may take several minutes)..."
echo ""

docker run --rm \
    -v "$PWD/$SCAN_WORK_DIR:/src" \
    fluidattacks/sast sast scan /src/config.yaml

# Step 6: Copy results out
if [[ -f "$SCAN_WORK_DIR/Fluid-Attacks-Results.csv" ]]; then
    cp "$SCAN_WORK_DIR/Fluid-Attacks-Results.csv" "$RESULTS_FILE"
fi

echo ""
echo "=== Scan Complete ==="
echo "Zip file: $ZIP_FILE"
if [[ -f "$RESULTS_FILE" ]]; then
    echo "Results:  $RESULTS_FILE"
else
    echo "Note: Check $SCAN_WORK_DIR/ for output files"
fi
