---
description: "High-level visual and product design choices: branding, iconography, layout, and platform wiring"
last_updated: "2026-04-16"
---

# Design Overview

This document describes the high-level visual and product design choices for Mindstone Rebel, focusing on branding, iconography, and how they are wired into the Electron app.

## See also

- `ARCHITECTURE_OVERVIEW.md` – Overall system decomposition and responsibilities for main/renderer processes.
- `UI_OVERVIEW.md` – Screens, layout primitives, and interaction patterns in the renderer.
- `UI_ICONS.md` – Icon library choice (lucide-react) and usage conventions.
- `color-scheme-recommendations.md` – Palette guidance and usage notes for typography, backgrounds, and accents.
- [BUILDING](BUILDING.md) – Build process, including how `electron-builder` uses app icons.
- `UI_LOADING_SPINNER.md` – References for loading spinners (shared utility and feature-specific implementations).

## Branding and iconography

Mindstone Rebel uses the core Mindstone logo as its primary app icon to keep branding consistent across products.

- **Canonical app icon source**: `build/app-icon-source.png` – square, rounded-corner Mindstone logo (currently copied from `Bg=white.png`).
- **Supporting logo asset**: (previously `build/ms-logo.svg` — no longer present; regenerate from source if a vector logo is needed).
- **Generated iconset**: `build/mindstone.iconset` – PNGs at multiple sizes (`icon_16x16.png`, `icon_512x512@2x.png`, etc.) derived from `build/app-icon-source.png` using ImageMagick.
- **Packaged macOS app icon**: `build/icon.icns` – built from the iconset and consumed by `electron-builder`.
- **Electron Builder wiring**: `package.json → build.mac.icon` is set to `"build/icon.icns"`, and `build.directories.buildResources` is `"build"`, so the macOS bundle pulls the icon from these generated assets.

To regenerate the app icon after updating `build/app-icon-source.png`, rebuild the iconset PNGs and `.icns` (example using ImageMagick and `iconutil`):

```bash
cd mindstone/rebel-app
rm -rf build/mindstone.iconset build/icon.icns
mkdir -p build/mindstone.iconset
magick build/app-icon-source.png -filter Lanczos -resize 16x16     build/mindstone.iconset/icon_16x16.png
magick build/app-icon-source.png -filter Lanczos -resize 32x32     build/mindstone.iconset/icon_16x16@2x.png
...
magick build/app-icon-source.png -filter Lanczos -resize 1024x1024 build/mindstone.iconset/icon_512x512@2x.png
iconutil -c icns build/mindstone.iconset -o build/icon.icns
```

Keep this section accurate if the source asset or generation flow changes.

## Layout and visual hierarchy

The visual design aims to prioritize the active agent conversation, with secondary emphasis on workspace context and automation state.

- The main viewport centers the current conversation, with typography and spacing tuned for long-form text readability.
- Sidebars (history, workspace, diagnostics) use reduced contrast and smaller typography so that they provide context without competing with the main thread.
- Accent colors derived from the Mindstone palette highlight primary actions (start/stop, run automation) and important status messages.

## Future improvements

Areas to refine as the product matures:

- Expand this document with more detailed component-level design guidance (forms, tables, overlays).
- Capture motion/animation guidelines for voice transitions and automation state changes.
- Consolidate platform-specific icon and branding assets across macOS, Windows (NSIS installer), and Linux — all three platforms are now supported. See [WINDOWS_SUPPORT.md](./WINDOWS_SUPPORT.md) and `electron-builder.cjs` for Windows-specific icon wiring.
