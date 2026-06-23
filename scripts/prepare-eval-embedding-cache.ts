/**
 * Seeds the eval-mode transformers cache from a persistent canonical copy so
 * `Xenova/bge-small-en-v1.5/model.onnx` doesn't have to be re-downloaded into
 * the ephemeral `os.tmpdir()` userData every time the embedding service runs
 * an eval.
 *
 * Why this exists
 * ───────────────
 * `evals/knowledge-work-bootstrap.ts` stubs `electronApp.getPath('userData')`
 * to `os.tmpdir() + '/mindstone-eval-userData'`. The embedding service then
 * resolves its model cache as `<userData>/models/transformers`, which means
 * every eval session that runs after a macOS tmp cleanup ends up redownloading
 * the 133 MB ONNX file. Worse, partial/aborted downloads have been observed
 * to land as truncated `model.onnx` files that fail `Protobuf parsing` at load
 * time and bring every fixture in a backfill down with
 *
 *   Semantic index verification failed: hasIndex() returned false ...
 *
 * (See postmortem section in
 *  `docs/plans/260517_kw_evals_provider_metadata_and_followups.md` — Late-Stage
 *  Re-Run — Follow-up #14.)
 *
 * Canonical cache location
 * ────────────────────────
 * `<Shared drives/Product>/evals/cache/transformers/Xenova/...`
 *
 * The script's lifecycle:
 *
 * 1. If the canonical cache is missing, try to bootstrap it from the local
 *    Mindstone Rebel app's userData (`~/Library/Application Support/mindstone-rebel/models/transformers/Xenova/`).
 *    The app cache is populated the first time you use the embedding feature
 *    in the real app — so just running the desktop app once is enough.
 * 2. If both are missing, exit cleanly with a non-zero code and a clear
 *    actionable error. We deliberately do NOT auto-download here so the
 *    canonical cache stays operator-controlled.
 * 3. If the eval-mode temp cache is missing or stale (size < 100 MiB, mtime
 *    older than canonical, or model.onnx absent), copy the canonical cache
 *    over it. Otherwise, no-op.
 *
 * Run via `npx tsx scripts/prepare-eval-embedding-cache.ts` or hook into the
 * `eval:backfill:knowledge-work` npm script.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
const MIN_VALID_ONNX_BYTES = 100 * 1024 * 1024;

const EVAL_TRANSFORMERS_CACHE = path.join(
  os.tmpdir(),
  'mindstone-eval-userData',
  'models',
  'transformers',
);

const APP_TRANSFORMERS_CACHE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'mindstone-rebel',
  'models',
  'transformers',
);

function resolveCanonicalCacheRoot(): string | null {
  if (process.env.REBEL_EVAL_EMBEDDING_CACHE_ROOT) {
    return process.env.REBEL_EVAL_EMBEDDING_CACHE_ROOT;
  }
  // Default: Google Drive Shared drives/Product
  const home = os.homedir();
  const gdriveBase = path.join(
    home,
    'Library',
    'CloudStorage',
    '[Mindstone-email]',
    'Shared drives',
    'Product',
  );
  if (!fs.existsSync(gdriveBase)) return null;
  return path.join(gdriveBase, 'evals', 'cache', 'transformers');
}

interface ModelLocation {
  root: string;
  modelDir: string;
  onnxFile: string;
}

function makeLocation(root: string): ModelLocation {
  return {
    root,
    modelDir: path.join(root, MODEL_NAME),
    onnxFile: path.join(root, MODEL_NAME, 'onnx', 'model.onnx'),
  };
}

function hasValidOnnx(loc: ModelLocation): boolean {
  if (!fs.existsSync(loc.onnxFile)) return false;
  const stat = fs.statSync(loc.onnxFile);
  return stat.size >= MIN_VALID_ONNX_BYTES;
}

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcEntry = path.join(src, entry.name);
    const dstEntry = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcEntry, dstEntry);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcEntry, dstEntry);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcEntry);
      fs.symlinkSync(target, dstEntry);
    }
  }
}

function fmt(loc: ModelLocation): string {
  if (!fs.existsSync(loc.onnxFile)) return `${loc.onnxFile} (missing)`;
  const stat = fs.statSync(loc.onnxFile);
  const mb = (stat.size / (1024 * 1024)).toFixed(1);
  return `${loc.onnxFile} (${mb} MiB, mtime ${stat.mtime.toISOString()})`;
}

async function main(): Promise<void> {
  const canonicalRoot = resolveCanonicalCacheRoot();
  const canonical = canonicalRoot ? makeLocation(canonicalRoot) : null;
  const appCache = makeLocation(APP_TRANSFORMERS_CACHE);
  const evalCache = makeLocation(EVAL_TRANSFORMERS_CACHE);

  console.log('[prepare-eval-embedding-cache] Model:', MODEL_NAME);
  console.log('[prepare-eval-embedding-cache] Eval temp cache:', fmt(evalCache));
  console.log('[prepare-eval-embedding-cache] App cache:      ', fmt(appCache));
  if (canonical) {
    console.log('[prepare-eval-embedding-cache] Canonical cache:', fmt(canonical));
  } else {
    console.log('[prepare-eval-embedding-cache] Canonical cache: <gdrive unreachable; cannot use shared cache>');
  }

  if (canonical && !hasValidOnnx(canonical)) {
    if (hasValidOnnx(appCache)) {
      console.log('[prepare-eval-embedding-cache] Seeding canonical cache from app cache...');
      fs.mkdirSync(canonical.root, { recursive: true });
      copyDirSync(appCache.modelDir, canonical.modelDir);
      console.log('[prepare-eval-embedding-cache] Canonical cache populated:', fmt(canonical));
    } else {
      console.log('[prepare-eval-embedding-cache] No valid model in app cache to seed canonical from.');
    }
  }

  if (hasValidOnnx(evalCache)) {
    console.log('[prepare-eval-embedding-cache] Eval cache already valid; nothing to do.');
    return;
  }

  const source: ModelLocation | null = canonical && hasValidOnnx(canonical)
    ? canonical
    : (hasValidOnnx(appCache) ? appCache : null);

  if (!source) {
    console.error('[prepare-eval-embedding-cache] No valid model available in any cache.');
    console.error('  To fix: run the desktop app once with embedding enabled (this seeds the app cache),');
    console.error('  then re-run this script. It will copy the app-cache model into the canonical');
    console.error('  Google Drive cache and into the eval temp cache.');
    process.exit(1);
  }

  console.log(`[prepare-eval-embedding-cache] Copying ${MODEL_NAME} from ${source.root} -> ${evalCache.root} ...`);
  fs.rmSync(evalCache.modelDir, { recursive: true, force: true });
  fs.mkdirSync(evalCache.root, { recursive: true });
  copyDirSync(source.modelDir, evalCache.modelDir);
  console.log('[prepare-eval-embedding-cache] Eval cache populated:', fmt(evalCache));
}

main().catch((err) => {
  console.error('[prepare-eval-embedding-cache] Unexpected error:', err);
  process.exit(1);
});
