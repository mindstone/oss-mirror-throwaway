---
description: "Build scripts, packaging, and local development setup for Mindstone Rebel"
last_updated: "2026-03-30"
---

# Building Mindstone Rebel

This document explains how to build and package the app locally.

## See also

- [BUILD_AND_RELEASE_OVERVIEW](./BUILD_AND_RELEASE_OVERVIEW.md) — hub for all build/release docs
- [CI_PIPELINE](./CI_PIPELINE.md) — what CI does automatically when you push
- [DISTRIBUTION](./DISTRIBUTION.md) — how builds reach users (auto-updates, signing)
- [SETUP_DEVELOPMENT_ENVIRONMENT](./SETUP_DEVELOPMENT_ENVIRONMENT.md) — dev prerequisites and configuration
- [PACKAGED_DEPENDENCY_NOTES](./PACKAGED_DEPENDENCY_NOTES.md) — how Vite/Forge treats dependencies
- [MCP_IMPROVEMENT_WORKFLOW](./MCP_IMPROVEMENT_WORKFLOW.md) — MCP development workflow (references build pipeline)

## npm scripts

Mindstone Rebel uses `electron-vite` for building and Electron Forge for packaging.

```bash
# Compile TypeScript and prepare production bundles
npm run build

# Create packaged app for local testing (macOS: .app, Windows: .exe)
npm run package

# Create distributable installer (macOS: DMG, Windows: Squirrel installer)
npm run make
```

### What each script does

| Script | Output | Use case |
|--------|--------|----------|
| `npm run build` | Bundles in `out/` | Compile only, no app package |
| `npm run package` | App bundle in `out/Mindstone Rebel-*/` | Local testing of production behavior |
| `npm run package:run` | Same as `package`, then opens the .app | One-command production-quality local run (~90s) |
| `npm run make` | Installer in `out/make/` | Create distributable for users |

### Development scripts

| Script | Predev? | HMR? | Performance | Use case |
|--------|---------|------|-------------|----------|
| `npm run dev` | Yes (55-90s cold, fast if cached) | Yes | Dev mode (slower) | Daily development with code changes |
| `npm start` | No | Yes | Dev mode (slower) | Quick restart when bundles already built (15-25s) |
| `npm run package:run` | No (but rebuilds app) | No | Production (fastest) | Testing real-world app performance |

`npm start` includes `--remote-debugging-port=9222` for CDP access. It is equivalent to `npm run dev` without the `predev` step (no submodule sync, no MCP bundle builds).

### npm run build

- Compiles main, preload, and renderer processes
- Produces optimised bundles in `out/`
- Does **not** produce a user-installable app on its own

### npm run package

- Uses Electron Forge to create an app bundle
- macOS: Creates `.app` bundle in `out/Mindstone Rebel-darwin-{arch}/`
- Windows: Creates `.exe` in `out/Mindstone Rebel-win32-x64/`
- Useful for verifying production behavior without creating an installer

### npm run make

- Uses Electron Forge to create distributable installers
- macOS: Creates signed DMG in `out/make/`
- Windows: Creates Squirrel installer (`.exe` + nupkg) in `out/make/squirrel.windows/`


## Build outputs and directories

Packaging produces several key directories:

| Directory | Contents |
|-----------|----------|
| `out/` | All build outputs |
| `out/main/`, `out/preload/`, `out/renderer/` | Compiled JavaScript bundles |
| `out/Mindstone Rebel-darwin-{arch}/` | macOS app bundles (from `npm run package`) |
| `out/make/` | Distributable installers (from `npm run make`) |

These are build artifacts and should not be hand-edited. Git ignores these directories.


## Beta vs Stable builds

The `BUILD_CHANNEL` environment variable controls which variant is built:

| Channel | App Name | Bundle ID | Icon |
|---------|----------|-----------|------|
| stable (default) | Mindstone Rebel | `com.mindstone.rebel` | `build/icon.*` |
| beta | Mindstone Rebel Beta | `com.mindstone.rebel.beta` | `build/icon-beta.*` |

CI sets this automatically based on branch. See [CI_PIPELINE](./CI_PIPELINE.md) for details.


## Bundled Node.js environment

The packaged app includes a **complete Node.js installation** (~100 MB) with `node`, `npm`, and `npx`. This is essential because:

- MCP servers often use `npx` to run (e.g., `npx -y some-mcp-server@latest`)
- The packaged app cannot rely on the user's system Node.js installation
- Without `npm`/`npx`, user-configured MCP servers would fail

The bundle is created automatically during build via the `prebuild` script:

```bash
npm run bundle:node   # Creates resources/node-bundle/ with node, npm, npx
```

At runtime, `setupNodeEnvironment()` in `systemUtils.ts` adds `node-bundle/bin/` to PATH so that MCP servers can use `npx`.


## Bundled MCP servers

Rebel includes 14+ bundled MCP servers in `resources/mcp/` that provide integrations (Google Workspace, Slack, Microsoft 365, etc.). These are built automatically as part of the `prebuild` script:

```bash
node scripts/build-bundled-mcps.mjs   # Discovers, builds, and bundles all MCPs
```

The script auto-discovers MCPs with `tsconfig.json` files and builds them in dependency order (`microsoft-shared` first, as it's a dependency for other Microsoft MCPs). This runs locally during `npm run prebuild` and explicitly in CI.

**Content-hash caching:** The build script caches each MCP's build using SHA-256 hashes of its inputs (source files, config, dependencies, build script, Node/esbuild versions). On subsequent runs, unchanged MCPs are skipped. Override with `--force` flag or `REBUILD_MCPS=1` env var.

### esbuild bundling (no node_modules in packaged builds)

**Critical:** All bundled TypeScript MCPs are compiled into a single `server.cjs` file using esbuild. This eliminates `node_modules` from packaged builds, saving ~590 MB and improving startup performance on Windows.

The `BUNDLED_MCPS` array in both `scripts/build-bundled-mcps.mjs` and `forge.config.cjs` controls which MCPs get this treatment. During packaging (`forge.config.cjs`), bundled MCPs copy **only** `server.cjs` to the output — no `node_modules`, `build/`, or `src/` directories.

**Exception:** `agent-browser` is intentionally kept unbundled because it shells out to the `agent-browser` CLI binary rather than importing Node modules.

**When creating a new TypeScript MCP, you must:**
1. Add your MCP name to the `BUNDLED_MCPS` array in `scripts/build-bundled-mcps.mjs`
2. Add your MCP name to the `BUNDLED_MCPS` array in `forge.config.cjs`
3. Ensure your MCP's entry point compiles to `build/index.js` (esbuild reads from there)
4. Verify the resulting `server.cjs` works standalone (no missing native deps)

If your MCP depends on native modules (binary `.node` files, platform-specific binaries), it cannot be esbuild-bundled. Discuss with the team before adding an unbundled MCP — the goal is to keep `node_modules` out of packaged builds.


## Troubleshooting

### Build or packaging fails

```bash
npm ci                # Ensure dependencies are installed
npm run build         # Check for TypeScript/bundling issues
```

### Icon does not update after changing `build/icon.png`

Clear macOS icon cache:

```bash
sudo rm -rf /Library/Caches/com.apple.iconservices.store
```

Then log out and back in.


## Testing packaged builds

**Important**: Running the app from `out/` does NOT accurately test dependency resolution - Node.js can still find modules from the project's `node_modules/`.

To properly test a packaged build:

```bash
# Quick test (runs from out/ — fast but Node.js can still resolve project node_modules)
npm run package:run

# Proper isolation test (copy outside the project tree)
npm run package
cp -R "out/Mindstone Rebel-darwin-arm64/Mindstone Rebel.app" /tmp/
open "/tmp/Mindstone Rebel.app"
```

See [PACKAGED_DEPENDENCY_NOTES](./PACKAGED_DEPENDENCY_NOTES.md#testing-packaged-dependencies) for details on testing native modules and diagnosing "Cannot find module" errors.


