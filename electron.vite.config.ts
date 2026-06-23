import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { buildSentryRelease, sentryBuildConstants } from './src/shared/telemetry/sentryConfig';
import { RENDERER_SINGLETON_DEPS } from './scripts/renderer-singleton-deps.mjs';

/**
 * NOTE: This config powers ONLY the legacy build scripts:
 *   - `npm run build:legacy`   (electron-vite build)
 *   - `npm run dev:legacy`     (electron-vite dev)
 *   - `npm run dist:legacy`    (electron-vite build + electron-builder)
 *
 * Packaged production builds (`npm run package`, `npm run build`,
 * `npm run make`) use electron-forge + `vite.renderer.config.mjs`, not
 * this file.
 *
 * The renderer.resolve.dedupe list below MUST stay in sync with
 * vite.renderer.config.mjs — enforced by scripts/check-alias-integrity.ts.
 */

const releaseName = buildSentryRelease(process.env.npm_package_version ?? undefined);
const privateMindstoneBootstrapPath = resolve(__dirname, 'private/mindstone/src/bootstrap.ts');
const privateMindstoneAliasTarget = existsSync(privateMindstoneBootstrapPath)
  ? resolve(__dirname, 'private/mindstone/src')
  : resolve(__dirname, 'src/main/oss/private-mindstone-stub');

// OSS build signal for the renderer (compile-time literal, read via
// rendererIsOss()). Derived from the SAME existsSync check as the alias target
// above. Must stay in sync with vite.renderer.config.mjs (the forge/production
// renderer config) — enforced by scripts/check-alias-integrity.ts.
const isOssBuild = !existsSync(privateMindstoneBootstrapPath);

// OSS-only alias for the Elastic-2.0 RudderStack browser SDK. In OSS builds the
// package is dependency-stripped from the public manifest (mirror/substitutions.yaml
// #dependency_strips) and physically absent, so the guarded dynamic import of
// the SDK in src/renderer/src/analytics.ts is
// resolved to a local no-op stub instead of failing at Rollup. In COMMERCIAL
// builds the alias is ABSENT so the real package resolves and analytics behaves
// as today. Must mirror the vite.renderer.config.mjs renderer alias EXACTLY
// (enforced by scripts/check-alias-integrity.ts).
const rudderstackOssAlias: Record<string, string> = isOssBuild
  ? { '@rudderstack/analytics-js': resolve(__dirname, 'src/renderer/src/oss/rudderstack-analytics-stub.ts') }
  : {};

const parseToggle = (value: string | undefined): boolean | undefined => {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
};

// Auth token is read from env var only - never hard-coded (it's a secret)
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const explicitUploadToggle = parseToggle(process.env.SENTRY_UPLOAD_SOURCEMAPS);
const isProductionBuild = process.env.NODE_ENV === 'production';
const enableSourcemapUpload = Boolean(sentryAuthToken) && (explicitUploadToggle ?? isProductionBuild);

const createSentryPlugin = (assetsGlob: string): any =>
  sentryVitePlugin({
    org: sentryBuildConstants.org,
    project: sentryBuildConstants.project,
    authToken: sentryAuthToken,
    telemetry: false,
    disable: !enableSourcemapUpload,
    release: {
      name: releaseName,
      inject: false
    },
    sourcemaps: {
      assets: assetsGlob
    }
  });

export default defineConfig({
  main: {
    entry: 'src/main/bootstrap.ts',
    resolve: {
      alias: {
        '@core': resolve(__dirname, 'src/core'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
        '@private/mindstone': privateMindstoneAliasTarget,
        '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
        // Main-process services (e.g. mcpServerRemovalService, assetUploadOutbox)
        // import '@rebel/cloud-client/cloudClient'. This alias exists in the
        // renderer section and in vite.main.config.mjs (forge build) but was
        // missing here, so the legacy electron-vite main bundle failed to
        // resolve it. See postmortem 260423_core_alias_missing_from_renderer_section.
        '@rebel/cloud-client': resolve(__dirname, 'cloud-client/src')
      }
    },
    build: {
      externalizeDeps: {
        // Bundle these pure-JS packages instead of externalizing:
        // - electron-store: ESM-only, needs CJS/ESM interop
        // - electron-updater: no native bindings, must be bundled
        // - graceful-fs: must be bundled for asar resolution (REBEL-536/537)
        exclude: ['electron-store', 'electron-updater', 'graceful-fs']
      }
    },
    vite: {
      build: {
        sourcemap: true,
        outDir: 'out/main',
        rollupOptions: {
          external: [
            '@lancedb/lancedb',
            '@huggingface/transformers',
            'onnxruntime-node',
            'apache-arrow',
            'ignore',
            '@recallai/desktop-sdk',
            'win-ca', // Windows cert store - ships roots.exe binary that must be on disk
            'sherpa-onnx-node', // Windows STT - native module loaded via createRequire from unpacked
            // graceful-fs is intentionally NOT external — must be bundled for asar resolution.
            // See vite.main.config.mjs comment and REBEL-536/REBEL-537.
          ],
        }
      },
      plugins: [createSentryPlugin('out/main/**/*')]
    }
  } as any,
  preload: {
    input: {
      index: resolve(__dirname, 'src/preload/index.ts')
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@rebel/shared': resolve(__dirname, 'packages/shared/src')
      }
    },
    vite: {
      build: {
        sourcemap: true,
        outDir: 'out/preload'
      },
      plugins: [createSentryPlugin('out/preload/**/*')]
    }
  } as any,
  renderer: {
    define: {
      __REBEL_IS_OSS__: JSON.stringify(isOssBuild),
    },
    resolve: {
      dedupe: [...RENDERER_SINGLETON_DEPS],
      alias: {
        '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
        '@rebel/cloud-client': resolve(__dirname, 'cloud-client/src'),
        // @core is needed because renderer files import from '@core/navigation' (and others).
        // Added 2026-04-23 (D20 Stage 5) to match the new-build-path vite.renderer.config.mjs.
        // Without this alias, `npm run build:legacy`/`verify:agent:full` fail at Rollup resolve.
        '@core': resolve(__dirname, 'src/core'),
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer'),
        ...rudderstackOssAlias
      }
    },
    server: {
      watch: {
        // Exclude non-source directories from Vite's file watcher to prevent
        // spurious HMR triggers (each triggers Tailwind CSS rebuild in dev).
        ignored: ['**/rebel-system/**', '**/super-mcp/**', '**/out/**', '**/build/**', '**/venv/**', '**/logs/**', '**/test-results/**', '**/.git/**']
      }
    },
    plugins: [react(), tailwindcss(), createSentryPlugin('out/renderer/**/*')],
    build: {
      sourcemap: true,
      outDir: 'out/renderer'
    },
    assetsInclude: ['**/*.lottie']
  }
});
