/**
 * Build the embedding workers separately from the main bundle.
 * 
 * This is needed because electron-vite doesn't support multiple entry points
 * for the main process in a way that works with Node.js Worker Threads.
 * The worker needs to be a standalone file that can be loaded by the Worker constructor.
 *
 * Builds:
 * 1. CPU embedding worker (Node.js Worker Thread)
 * 2. GPU embedding worker (Hidden BrowserWindow with WebGPU)
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, copyFile } from 'fs/promises';

// =============================================================================
// SOURCEMAP CONFIGURATION
// =============================================================================
// Match the pattern from vite.main.config.mjs for conditional sourcemaps.
// Workers use esbuild directly (not Vite), so they don't integrate with
// @sentry/vite-plugin. For now, skip sourcemaps in production/CI.
// If we need worker stack traces in Sentry later, we'd need a separate
// @sentry/cli upload step.
// =============================================================================
const isProduction = process.env.NODE_ENV === 'production';
const isCiBuild = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const enableSourcemaps = !isProduction && !isCiBuild;

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// Path aliases matching tsconfig.node.json
const pathAliases = {
  '@core': resolve(rootDir, 'src/core'),
  '@main': resolve(rootDir, 'src/main'),
  '@shared': resolve(rootDir, 'src/shared'),
};

// esbuild alias plugin for path resolution
const aliasPlugin = {
  name: 'alias',
  setup(build) {
    for (const [alias, target] of Object.entries(pathAliases)) {
      const filter = new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/.*)?$`);
      build.onResolve({ filter }, (args) => {
        const subpath = args.path.substring(alias.length);
        let resolvedPath = resolve(target, subpath.replace(/^\//, ''));
        // Add .ts extension if not present and the path doesn't have an extension
        if (!resolvedPath.match(/\.[a-zA-Z]+$/)) {
          resolvedPath = resolvedPath + '.ts';
        }
        return { path: resolvedPath };
      });
    }
  }
};

async function buildCpuWorker() {
  const outDir = resolve(rootDir, 'out/main/workers');
  
  // Ensure output directory exists
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [resolve(rootDir, 'src/main/workers/embeddingWorker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: resolve(outDir, 'embeddingWorker.js'),
    external: [
      '@huggingface/transformers',
      'onnxruntime-node'
    ],
    plugins: [aliasPlugin],
    sourcemap: enableSourcemaps,
    minify: false,
    logLevel: 'info'
  });

  console.log('CPU Worker built successfully to out/main/workers/embeddingWorker.js');
}

async function buildPreTurnWorker() {
  const outDir = resolve(rootDir, 'out/main/workers');
  
  // Ensure output directory exists
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [resolve(rootDir, 'src/main/workers/preTurnWorker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: resolve(outDir, 'preTurnWorker.js'),
    external: [
      '@huggingface/transformers',
      '@lancedb/lancedb',
      'onnxruntime-node'
    ],
    plugins: [aliasPlugin],
    sourcemap: enableSourcemaps,
    minify: false,
    logLevel: 'info'
  });

  console.log('Pre-Turn Worker built successfully to out/main/workers/preTurnWorker.js');
}

async function buildAtlasWorker() {
  const outDir = resolve(rootDir, 'out/main/workers');
  
  // Ensure output directory exists
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [resolve(rootDir, 'src/main/workers/atlasWorker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: resolve(outDir, 'atlasWorker.js'),
    external: [],
    plugins: [aliasPlugin],
    sourcemap: enableSourcemaps,
    minify: false,
    logLevel: 'info'
  });

  console.log('Atlas Worker built successfully to out/main/workers/atlasWorker.js');
}

async function buildIndexHealthWorker() {
  const outDir = resolve(rootDir, 'out/main/workers');
  
  // Ensure output directory exists
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [resolve(rootDir, 'src/main/workers/indexHealthWorker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: resolve(outDir, 'indexHealthWorker.js'),
    external: [
      '@lancedb/lancedb', // Native module, must be external
    ],
    plugins: [aliasPlugin],
    sourcemap: enableSourcemaps,
    minify: false,
    logLevel: 'info'
  });

  console.log('Index Health Worker built successfully to out/main/workers/indexHealthWorker.js');
}

async function buildCloudLivenessWorker() {
  const outDir = resolve(rootDir, 'out/main/workers');

  // Ensure output directory exists
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [resolve(rootDir, 'src/main/workers/cloudLivenessWorker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: resolve(outDir, 'cloudLivenessWorker.js'),
    external: [], // Tiny worker: only node:fs/promises (built-in). No external deps.
    plugins: [aliasPlugin],
    sourcemap: enableSourcemaps,
    minify: false,
    logLevel: 'info'
  });

  console.log('Cloud Liveness Worker built successfully to out/main/workers/cloudLivenessWorker.js');
}

async function buildGpuWorker() {
  const outDir = resolve(rootDir, 'out/main/gpu-worker');
  
  // Ensure output directory exists
  await mkdir(outDir, { recursive: true });

  // Build preload script (runs in Node.js context)
  await build({
    entryPoints: [resolve(rootDir, 'src/main/gpu-worker/preload.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: resolve(outDir, 'preload.js'),
    external: ['electron'],
    plugins: [aliasPlugin],
    sourcemap: enableSourcemaps,
    minify: false,
    logLevel: 'info'
  });

  // Build renderer script (runs in browser context with WebGPU)
  await build({
    entryPoints: [resolve(rootDir, 'src/main/gpu-worker/renderer.ts')],
    bundle: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'esm',
    outfile: resolve(outDir, 'renderer.js'),
    external: [], // Bundle everything for browser
    plugins: [aliasPlugin],
    sourcemap: enableSourcemaps,
    minify: false,
    logLevel: 'info'
  });

  // Copy HTML file
  await copyFile(
    resolve(rootDir, 'src/main/gpu-worker/index.html'),
    resolve(outDir, 'index.html')
  );

  console.log('GPU Worker built successfully to out/main/gpu-worker/');
}

async function buildAllWorkers() {
  await Promise.all([
    buildCpuWorker(),
    buildPreTurnWorker(),
    buildAtlasWorker(),
    buildIndexHealthWorker(),
    buildCloudLivenessWorker(),
    buildGpuWorker()
  ]);
  console.log('All workers built successfully');
}

buildAllWorkers().catch((err) => {
  console.error('Worker build failed:', err);
  process.exit(1);
});
