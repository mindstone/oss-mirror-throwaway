---
description: "Packaged dependency loading guidance — Vite/Forge bundling, static imports, super-mcp isolation, native modules"
last_updated: "2026-03-29"
---

## Packaged dependency loading

This document describes how Vite/Forge packaging treats dependencies and provides guidelines to avoid runtime "Cannot find module" errors in production builds.


## See Also

- [BUILDING](BUILDING.md) - Build process, outputs, and bundled Node environment
- [SETUP_DEVELOPMENT_ENVIRONMENT.md](SETUP_DEVELOPMENT_ENVIRONMENT.md) - development environment setup and build commands
- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) - high-level system architecture and component responsibilities
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - execution environment and Node bundling details
- [SUPERMCP_OVERVIEW.md](SUPERMCP_OVERVIEW.md) - Super-MCP HTTP mode and bundled submodule
- [DEPENDENCY_UPGRADES_AND_DEPENDABOT.md](DEPENDENCY_UPGRADES_AND_DEPENDABOT.md) - when/why to upgrade dependencies, known version constraints (chokidar, Electron, Sentry alignment), Dependabot triage process


## Version-Pinned Dependencies (Brand Icon Constraint)

`lucide-react` is pinned to **0.563.0** (the 0.x line). Do not upgrade to 1.x+.

### Why

Lucide removed all brand/logo icons in v1.0.1 (Github, Gitlab, Figma, Trello, and others). The connector catalog UI (`src/renderer/features/settings/utils/connectorIcons.ts`) uses these brand icons to visually identify specific connectors (GitHub Copilot, GitLab, Figma, Trello). The icons are mapped by name in `resources/connector-catalog.json` and rendered in the settings connector list and onboarding flow.

### What breaks if upgraded

The Vite renderer build fails with:
```
"Github" is not exported by "node_modules/lucide-react/dist/esm/lucide-react.js"
```

All 4 brand icons (`Github`, `Gitlab`, `Figma`, `Trello`) are missing in 1.x.

### If you need to upgrade in future

To move to lucide-react 1.x+, you must first replace the brand icons. Options:
1. **Inline SVG components** -- create React components from Simple Icons SVG paths, typed as `LucideIcon`. Note: brand icons are fill-based while Lucide icons are stroke-based, so you need `fill="currentColor" stroke="none"`.
2. **`@icons-pack/react-simple-icons`** -- community React wrapper for Simple Icons. Adds a dependency for 4 icons.
3. **Generic Lucide substitutes** (e.g., `GitBranch`, `Palette`) -- loses brand recognition in the connector list; not recommended since these icons identify specific companies.

### Key files

- `src/renderer/features/settings/utils/connectorIcons.ts` -- imports and maps brand icons
- `resources/connector-catalog.json` -- connector entries with `"icon": "github"` etc.
- `src/renderer/features/onboarding/steps/ToolAuthStep.tsx` -- renders connector icons via `getConnectorIcon()`


## The Problem

- Bundled builds produced a fatal runtime error (`Cannot find module '@sentry/electron/main'`) because the main process attempted to `require()` the SDK dynamically at runtime. The `.vite/build` output produced by forge does **not** contain a `node_modules` tree, so any modules that are `require()`'d lazily must already be part of the bundle via static imports.

- **Do not use `createRequire` or dynamic `require()` for production dependencies.** If a module is needed in the packaged app, import it statically at the top of the file so Vite/rollup can include it in the emitted chunk.

- When you genuinely need optional/runtime-resolved modules, keep them behind explicit `import()` statements and ensure the bundler is configured with `external`/`dynamic import` allow-lists. Otherwise the packaged build will crash once `node_modules` is stripped.

- When adding new main/preload dependencies, sanity-check the packaged output in `.vite/build/*.js` for `requireModule("<package>")` patterns and confirm the package is present in `dependencies` (not only `devDependencies`). If the package is critical, prefer static imports so the code path cannot fail in production.

- TL;DR: “If it must run after packaging, import it statically.” This prevents a repeat of the Sentry issue and keeps the bundled app self-contained.


## Spawned Subprocesses (super-mcp)

When spawning child processes that need their own dependencies (like super-mcp), different rules apply:

### The Problem

Super-mcp is bundled as a Git submodule and spawned as a separate Node.js process. When the packaged app runs from the `out/` directory during development testing, Node.js module resolution walks up the directory tree and can find the **main project's `node_modules`** before the bundled dependencies. This causes version conflicts (e.g., ajv 6.x vs ajv 8.x required by ajv-formats 3.x).

### The Solution

1. **Copy the submodule's `node_modules` alongside its `dist`**: In `forge.config.cjs`, we copy `super-mcp/node_modules` to `Resources/super-mcp/node_modules` so Node.js finds the correct versions when resolving from the script location.

2. **Set `cwd` when spawning**: In `superMcpHttpManager.ts`, we set `cwd: superMcpDir` to prevent Node.js from searching parent directories for `node_modules`.

### Key files

- `forge.config.cjs` - `packageAfterCopy` hook copies super-mcp's dist AND node_modules
- `src/main/services/superMcpHttpManager.ts` - Spawns super-mcp with isolated cwd

### Version compatibility note

Super-mcp requires specific dependency versions that differ from the main project:
- `ajv`: 8.x (main project uses 6.x)
- `ajv-formats`: 3.x (requires ajv 8.x)
- `@modelcontextprotocol/sdk`: 1.24.x (for StreamableHTTPServerTransport)

These are isolated in super-mcp's own node_modules to avoid conflicts.


## Native Modules (LanceDB, etc.)

Native modules with platform-specific binaries cannot be bundled by Vite or loaded from inside an asar archive. They require special handling.

### Native module inventory

The app depends on 5 native modules with prebuilt binaries:

| Module | Purpose |
|--------|---------|
| `@lancedb/lancedb` | Vector database for semantic search |
| `@huggingface/transformers` | ML library with ONNX runtime |
| `onnxruntime-node` | ONNX runtime native bindings |
| `sherpa-onnx-node` | Local speech-to-text (fragile on Windows -- see `docs/plans/260317_fox2829_windows_local_stt_investigation.md`) |
| `bufferutil` / `utf-8-validate` | WebSocket performance (native optional deps) |

All 5 use **N-API** (ABI-stable across Node versions), so prebuilt binaries generally survive Node version bumps without recompilation. However, this is not guaranteed -- always validate after Electron upgrades that change the bundled Node version.

### Prebuilt binary model

`electron-builder.cjs` sets `buildDependenciesFromSource: false` and `npmRebuild: false` -- we rely entirely on prebuilt binaries downloaded by npm, not on rebuilding from source during packaging. This means:
- If a native module publisher hasn't built against the current Node ABI, packaging succeeds but the module fails at runtime
- Platform-specific optional deps (e.g., `@lancedb/lancedb-darwin-arm64`) are only installed for the CI runner's platform
- Version constraints on native modules may be driven by binary availability, not API changes (see [LanceDB Intel Mac constraint](DEPENDENCY_UPGRADES_AND_DEPENDABOT.md#lancedb--apache-arrow-pinned-to-0223-intel-mac-constraint))

### The Problem

When Vite encounters a native module like `@lancedb/lancedb`, it cannot bundle the native binaries. Instead, it marks the package as `external` in `vite.main.config.mjs`:

```javascript
external: [
  '@lancedb/lancedb',      // Native vector database
  '@huggingface/transformers', // ML library with ONNX runtime
  'onnxruntime-node',      // ONNX runtime native bindings
]
```

At runtime, Node.js tries to resolve these from `node_modules`. But in a packaged app:
1. `node_modules` is inside the asar archive
2. Native modules cannot load their `.node` binaries from inside an asar
3. The `asar.unpack` pattern doesn't help because Node.js resolves external modules before checking unpacked locations

### The Solution

Native modules must be explicitly copied to `app.asar.unpacked/node_modules/` in the `packageAfterCopy` hook in `forge.config.cjs`:

```javascript
// Step 5b: Copy LanceDB native module for semantic search
const lancedbScopeSrc = path.join(__dirname, 'node_modules', '@lancedb');
const lancedbScopeDest = path.join(unpackedNodeModules, '@lancedb');
if (fs.existsSync(lancedbScopeSrc)) {
  const lancedbPackages = await fsp.readdir(lancedbScopeSrc);
  await fsp.mkdir(lancedbScopeDest, { recursive: true });
  for (const pkg of lancedbPackages) {
    // Copy each @lancedb/* package (main + platform-specific binaries)
    await copyDir(path.join(lancedbScopeSrc, pkg), path.join(lancedbScopeDest, pkg));
  }
}
```

### Platform-specific binaries

Many native modules use optional dependencies for platform-specific binaries:
- `@lancedb/lancedb` (main package)
- `@lancedb/lancedb-darwin-arm64` (macOS ARM)
- `@lancedb/lancedb-darwin-x64` (macOS Intel)
- `@lancedb/lancedb-win32-x64-msvc` (Windows)
- `@lancedb/lancedb-linux-x64-gnu` (Linux)

When `npm ci` runs on CI, only the platform-appropriate binary is installed. The `packageAfterCopy` hook copies all `@lancedb/*` packages that exist, so each platform gets the correct binary.

### Key files

- `vite.main.config.mjs` - Lists native modules as `external`
- `forge.config.cjs` - `packageAfterCopy` hook copies native modules to unpacked location


## Testing Packaged Dependencies

**Important**: Running the packaged app from the `out/` directory does NOT accurately test dependency resolution. Node.js module resolution walks up the directory tree and can find the project's `node_modules/`, masking packaging issues.

### How to test properly

```bash
# 1. Package the app
npm run package

# 2. Copy it OUTSIDE the project directory
cp -R "out/Mindstone Rebel-darwin-arm64/Mindstone Rebel.app" /tmp/

# 3. Run from the isolated location
open "/tmp/Mindstone Rebel.app"
```

Or test with the full distributable:

```bash
# Create DMG and install from it
npm run make
open out/make/Mindstone\ Rebel*.dmg
# Drag to a temp location (not /Applications to avoid overwriting your installed version)
```

### What to verify

1. Open DevTools (`Cmd+Option+I` / `Ctrl+Shift+I`)
2. Check the console for "Cannot find module" errors
3. Test features that use native modules:
   - **Semantic search**: `await window.searchApi.indexStatus()` and `await window.searchApi.reindex({ force: false })`
   - **MCP servers**: Check if tools load correctly

### Why this matters

| Run location | Module resolution | Accurate test? |
|--------------|-------------------|----------------|
| `out/Mindstone Rebel.app` | Can find `../../node_modules/` | No |
| `/tmp/Mindstone Rebel.app` | Only bundled/unpacked modules | Yes |
| `/Applications/` (installed) | Only bundled/unpacked modules | Yes |

### CI vs Local differences

CI builds may behave differently because:
1. **Clean install**: CI runs `npm ci` (fresh node_modules)
2. **Different platform binaries**: CI runners install platform-specific optional deps
3. **Signing**: macOS builds are signed and notarized (can affect binary loading)

Always test with the isolated app method above before assuming a fix works.
