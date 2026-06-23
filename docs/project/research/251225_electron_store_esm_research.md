---
description: "Research on electron-store ESM bundling in Electron — constructor error cause, electron-vite fixes, alternatives, recommendation"
last_updated: "2025-12-26"
---

# Research Report: electron-store ESM Bundling Issues

**Date:** 2025-12-25
**Subject:** `electron-store` "Store is not a constructor" error and ESM bundling in CommonJS Electron apps

## Executive Summary
The `Store is not a constructor` error occurs because `electron-store` v11.0.2 is an ESM-only package, but `electron-vite` by default treats `dependencies` as external CommonJS `require()` calls in the main process build.

Since the main process in this project is built as CommonJS (implied by lack of `"type": "module"` in `package.json`), importing `electron-store` results in `require()` trying to load an ESM file, which fails or returns an incompatible object.

## Findings

### 1. How other projects handle ESM-only dependencies
Projects using `electron-vite` with a CommonJS main process typically solve this by **forcing the ESM dependency to be bundled**.

*   **Mechanism:** Modify the `externalizeDeps` plugin configuration or the Rollup options to **exclude** the ESM package from being marked as external.
*   **Alternative:** Use dynamic imports (`const { default: Store } = await import('electron-store')`). This works but requires changing the codebase to handle async initialization, which can be a significant refactor.

### 2. Gotchas with bundling `electron-store`
*   **Native Modules:** Bundling works well for pure JS libraries like `electron-store` but can break libraries with native bindings. Fortunately, `electron-store` is pure JS.
*   **Node Internals:** Bundled code might lose access to `__dirname` or `import.meta.url` if not handled correctly by the bundler. `electron-vite` usually handles this well.
*   **Configuration:** You must ensure `electron-store` is **NOT** in the `external` list in `rollupOptions` and **IS** in the `exclude` list of the externalize deps plugin (if used explicitly).

### 3. Long-term direction for Electron
*   **Direction:** Electron is moving towards full ESM support. Electron 28+ supports ESM natively in the main process.
*   **Current State:** Most existing apps still use CommonJS for the main process.
*   **Recommendation:** For now, keep the main process as CJS but bundle specific ESM-only dependencies.

### 4. Alternative Packages
If bundling proves too difficult, these are valid alternatives:

| Package | Type | Status | Notes |
| :--- | :--- | :--- | :--- |
| **electron-store** (bundled) | ESM | **Recommended** | Best DX, schema validation, familiar API. |
| **electron-settings** | CJS | Good | Similar API, reliable CJS support. |
| **electron-json-storage** | CJS | Good | Simple JSON file storage. |
| **conf** | ESM | Warning | `electron-store` is a wrapper around this; same ESM issues. |

## Recommended Fix

Modify `electron.vite.config.ts` to bundle `electron-store`.

Since `electron-vite` automatically externalizes `dependencies` by default, we need to override this behavior.

**Example Configuration:**

```typescript
// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    // ...
    plugins: [
      externalizeDepsPlugin({
        exclude: ['electron-store'] // Force electron-store to be bundled
      })
    ]
  }
});
```
