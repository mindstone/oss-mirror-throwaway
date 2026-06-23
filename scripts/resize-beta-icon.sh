#!/bin/bash
# Resize app icons to have proper padding for macOS dock
# Apple HIG recommends ~10% padding around the icon content
#
# Usage:
#   ./resize-beta-icon.sh         # Resize stable icon (default)
#   ./resize-beta-icon.sh beta    # Resize beta icon
#   ./resize-beta-icon.sh all     # Resize both

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/../build"

# Target: content scaled to ~80% (gives ~10% padding on each side)
SCALE_PERCENT=80

resize_icon() {
    local ICON_NAME="$1"
    local SOURCE_PNG="$BUILD_DIR/${ICON_NAME}.png"
    local BACKUP_PNG="$BUILD_DIR/${ICON_NAME}-original.png"
    local OUTPUT_ICNS="$BUILD_DIR/${ICON_NAME}.icns"
    local OUTPUT_ICO="$BUILD_DIR/${ICON_NAME}.ico"
    
    if [ ! -f "$SOURCE_PNG" ]; then
        # For stable icon, try to use app-icon-source.png as source
        if [ "$ICON_NAME" = "icon" ] && [ -f "$BUILD_DIR/app-icon-source.png" ]; then
            SOURCE_PNG="$BUILD_DIR/app-icon-source.png"
            BACKUP_PNG="$BUILD_DIR/icon-original.png"
        else
            echo "ERROR: Source file not found: $SOURCE_PNG"
            return 1
        fi
    fi
    
    echo "=== Processing $ICON_NAME ==="
    
    # Backup original if not already backed up
    if [ ! -f "$BACKUP_PNG" ]; then
        cp "$SOURCE_PNG" "$BACKUP_PNG"
        echo "Backed up original to ${ICON_NAME}-original.png"
    fi
    
    # Get source dimensions
    DIMENSIONS=$(magick identify -format "%wx%h" "$BACKUP_PNG")
    SOURCE_SIZE=$(magick identify -format "%w" "$BACKUP_PNG")
    echo "Source: $DIMENSIONS"
    
    # Calculate content size (80% of 1024)
    CANVAS_SIZE=1024
    CONTENT_SIZE=$((CANVAS_SIZE * SCALE_PERCENT / 100))
    echo "Resizing to ${CONTENT_SIZE}x${CONTENT_SIZE} within ${CANVAS_SIZE}x${CANVAS_SIZE} canvas..."
    
    # Create high-res version with padding
    local TEMP_PNG="$BUILD_DIR/${ICON_NAME}-temp.png"
    magick "$BACKUP_PNG" \
        -resize ${CONTENT_SIZE}x${CONTENT_SIZE} \
        -gravity center \
        -background none \
        -extent ${CANVAS_SIZE}x${CANVAS_SIZE} \
        "$TEMP_PNG"
    
    # Copy to final location
    cp "$TEMP_PNG" "$BUILD_DIR/${ICON_NAME}.png"
    echo "Created: ${ICON_NAME}.png"
    
    # Create iconset directory
    local ICONSET_DIR="$BUILD_DIR/${ICON_NAME}.iconset"
    rm -rf "$ICONSET_DIR"
    mkdir -p "$ICONSET_DIR"
    
    # Generate all required sizes
    for SIZE in 16 32 128 256 512; do
        magick "$TEMP_PNG" -resize ${SIZE}x${SIZE} "$ICONSET_DIR/icon_${SIZE}x${SIZE}.png"
        DOUBLE=$((SIZE * 2))
        magick "$TEMP_PNG" -resize ${DOUBLE}x${DOUBLE} "$ICONSET_DIR/icon_${SIZE}x${SIZE}@2x.png"
    done
    echo "Generated iconset"
    
    # Generate .icns
    iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"
    echo "Created: ${ICON_NAME}.icns"
    
    # Generate .ico
    magick "$TEMP_PNG" -define icon:auto-resize=256,128,96,64,48,32,16 "$OUTPUT_ICO"
    echo "Created: ${ICON_NAME}.ico"
    
    # Update mindstone.iconset if processing stable icon
    if [ "$ICON_NAME" = "icon" ]; then
        echo "Updating mindstone.iconset..."
        cp "$ICONSET_DIR"/* "$BUILD_DIR/mindstone.iconset/"
    fi
    
    # Clean up temp files but keep iconset for beta
    rm -f "$TEMP_PNG"
    if [ "$ICON_NAME" = "icon" ]; then
        rm -rf "$ICONSET_DIR"
    fi
    
    echo "Done with $ICON_NAME"
    echo ""
}

# Parse argument
TARGET="${1:-stable}"

case "$TARGET" in
    beta)
        resize_icon "icon-beta"
        ;;
    stable|icon)
        resize_icon "icon"
        ;;
    all)
        resize_icon "icon"
        resize_icon "icon-beta"
        ;;
    *)
        echo "Usage: $0 [stable|beta|all]"
        exit 1
        ;;
esac

echo "=== Complete ==="
echo "Rebuild the app to see the change in the dock."
