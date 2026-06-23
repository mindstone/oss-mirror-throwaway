import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { RENDERER_SINGLETON_DEPS } from "./scripts/renderer-singleton-deps.mjs";
import { createLegacySentryPlugin, resolveSourcemapUpload } from "./scripts/vite-sentry-plugin.mjs";
import { visualizer } from "rollup-plugin-visualizer";

const projectRoot = __dirname;

const enableSourcemapUpload = resolveSourcemapUpload();

// Load .env.local before config evaluation so ELECTRON_RENDERER_PORT is available
// This enables per-worktree port overrides for running multiple dev servers
// Shell env vars take precedence over .env.local (spread env first, then overlay process.env)
const env = loadEnv("development", projectRoot, "");
process.env = { ...env, ...process.env };
const rendererRoot = resolve(projectRoot, "src/renderer");
const rendererOutDirSetting = process.env.ELECTRON_RENDERER_OUT_DIR ?? ".vite/renderer/main_window";
const outDir = resolve(projectRoot, rendererOutDirSetting);
const outDirGlobBase = rendererOutDirSetting.replaceAll("\\\\", "/");

const devServerUrl = process.env.ELECTRON_RENDERER_URL;

// OSS build signal for the renderer. Computed from the SAME existsSync check
// the main/forge configs use to pick the @private/mindstone alias target:
// when the mirror strips private/mindstone/src/bootstrap.ts, the build is OSS.
// Exposed as a compile-time literal so the renderer (which inits telemetry
// synchronously before React) reads it via rendererIsOss() with no preload
// round-trip. Must stay in sync with electron.vite.config.ts renderer section
// (enforced by scripts/check-alias-integrity.ts).
const privateMindstoneBootstrapPath = resolve(projectRoot, "private/mindstone/src/bootstrap.ts");
const isOssBuild = !existsSync(privateMindstoneBootstrapPath);

// OSS-only alias for the Elastic-2.0 RudderStack browser SDK. In OSS builds the
// package is dependency-stripped from the public manifest (mirror/substitutions.yaml
// #dependency_strips) and physically absent, so the guarded dynamic import of
// the SDK in src/renderer/src/analytics.ts is
// resolved to a local no-op stub instead of failing at Rollup. In COMMERCIAL
// builds the alias is ABSENT so the real package resolves and analytics behaves
// as today. Must mirror the electron.vite.config.ts renderer section EXACTLY
// (enforced by scripts/check-alias-integrity.ts).
const rudderstackOssAlias = isOssBuild
  ? { "@rudderstack/analytics-js": resolve(projectRoot, "src/renderer/src/oss/rudderstack-analytics-stub.ts") }
  : {};

export default defineConfig({
  root: rendererRoot,
  base: devServerUrl ?? "./",
  define: {
    __REBEL_IS_OSS__: JSON.stringify(isOssBuild),
  },
  resolve: {
    dedupe: [...RENDERER_SINGLETON_DEPS],
    alias: {
      "@rebel/shared": resolve(projectRoot, "packages/shared/src"),
      "@rebel/cloud-client": resolve(projectRoot, "cloud-client/src"),
      "@renderer": rendererRoot,
      "@core": resolve(projectRoot, "src/core"),
      "@shared": resolve(projectRoot, "src/shared"),
      "@": rendererRoot,
      ...rudderstackOssAlias,
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: enableSourcemapUpload ? "hidden" : false,
  },
  server: {
    host: process.env.ELECTRON_RENDERER_HOST ?? "127.0.0.1",
    port: process.env.ELECTRON_RENDERER_PORT
      ? Number(process.env.ELECTRON_RENDERER_PORT)
      : 5173,
    strictPort: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    // Don't ship renderer sourcemaps in packaged builds.
    createLegacySentryPlugin(projectRoot, [`${outDirGlobBase}/**/*.map`]),
    ...(process.env.ANALYZE === "1"
      ? [
          visualizer({
            filename: "stats-renderer.html",
            template: "treemap",
            gzipSize: true,
          }),
        ]
      : []),
  ],
});
