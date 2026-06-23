#!/usr/bin/env node

/**
 * Build all TypeScript MCPs in resources/mcp/
 * 
 * Auto-discovers MCPs by looking for tsconfig.json files.
 * Builds microsoft-shared first (dependency for other MS MCPs),
 * then builds remaining MCPs with limited concurrency.
 * 
 * MCP classification (bundled vs unbundled, Microsoft dependents) is read from
 * scripts/mcp-config.json — the single source of truth shared with forge.config.cjs.
 * 
 * For bundled MCPs, creates a single server.cjs bundle using esbuild
 * to eliminate node_modules and reduce package size (~590 MB savings).
 * 
 * Content-hash caching: each MCP's source inputs are SHA-256 hashed. If the hash
 * matches the stored value and output artifacts exist, the build is skipped.
 * Override with --force flag or REBUILD_MCPS=1 environment variable.
 * 
 * Testable utilities (hashing, discovery, artifact checks) live in
 * scripts/build-bundled-mcps-utils.mjs.
 */

import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

import {
  computeFileHash,
  walkDir,
  computeMcpHash,
  readHashFile,
  writeHashFile,
  outputArtifactExists,
  discoverMcps,
} from './build-bundled-mcps-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const mcpRoot = join(projectRoot, 'resources', 'mcp');
const mcpGeneratedRoot = join(projectRoot, 'resources', 'mcp-generated');

const MAX_CONCURRENCY = 4;

/**
 * Single source of truth for MCP build classification.
 * See scripts/mcp-config.json for the authoritative list.
 *
 * bundledMcps: MCPs bundled into a single server.cjs via esbuild (no node_modules at runtime).
 *
 * microsoftDependents: microsoft-* MCPs that depend on microsoft-shared via file:../microsoft-shared.
 *   Note: microsoft-shared is a library dependency (not an MCP server), built first.
 */
const mcpConfigPath = join(projectRoot, 'scripts', 'mcp-config.json');
let mcpConfig;
try {
  mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
} catch (err) {
  console.error(`❌ Failed to load ${mcpConfigPath}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(mcpConfig.bundledMcps) || !Array.isArray(mcpConfig.microsoftDependents)) {
  console.error('❌ mcp-config.json must contain bundledMcps and microsoftDependents arrays');
  process.exit(1);
}
const BUNDLED_MCPS = mcpConfig.bundledMcps;
const MICROSOFT_DEPENDENTS = mcpConfig.microsoftDependents;

/**
 * Read the esbuild version from the project's root node_modules.
 * @returns {string}
 */
function getEsbuildVersion() {
  try {
    const pkgPath = join(projectRoot, 'node_modules', 'esbuild', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version;
  } catch {
    return 'none';
  }
}

function getNpmVersion() {
  try {
    return execSync('npm --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Quick syntax check for a cached bundled MCP to catch corrupt artifacts.
 * Runs `node --check` which parses without executing (~50ms per file).
 * @param {string} mcpName
 * @returns {boolean}
 */
function smokeCheckBundle(mcpName) {
  const serverPath = join(mcpGeneratedRoot, mcpName, 'server.cjs');
  if (!existsSync(serverPath)) return true; // unbundled MCPs don't have server.cjs
  try {
    execSync(`node --check "${serverPath}"`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    console.warn(`  ⚠️  ${mcpName} cached bundle failed syntax check — will rebuild`);
    return false;
  }
}

// ─── Build functions ─────────────────────────────────────────────────────────

/**
 * Bundle an MCP into a single server.cjs file using esbuild.
 * This eliminates the need for node_modules at runtime.
 * Output goes to resources/mcp-generated/<name>/server.cjs (separate from source).
 * @param {string} mcpName 
 * @returns {Promise<{ success: boolean, error?: string, size?: number }>}
 */
async function bundleMcp(mcpName) {
  const mcpDir = join(mcpRoot, mcpName);
  const entryPoint = join(mcpDir, 'build', 'index.js');
  const outDir = join(mcpGeneratedRoot, mcpName);
  const outfile = join(outDir, 'server.cjs');
  
  console.log(`  📦 Bundling ${mcpName} with esbuild...`);
  
  try {
    if (!existsSync(entryPoint)) {
      throw new Error(`Entry point not found: ${entryPoint}. Run tsc build first.`);
    }
    
    // Ensure output directory exists
    mkdirSync(outDir, { recursive: true });
    
    // Dynamic import esbuild (available via Vite)
    const { build } = await import('esbuild');
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile,
      sourcemap: false,
      minify: true,
      logLevel: 'warning',
      // Exclude native Node.js addon files (.node) from bundling.
      // Libraries like ssh2 use optional native bindings with pure-JS fallbacks;
      // esbuild cannot process .node files, so we leave them as external requires.
      loader: { '.node': 'empty' },
      // Boot-time graceful-fs install — prepended to the bundle so it runs
      // before any module body executes. graceful-fs is externalised so the
      // bundled MCP shares a single graceful-fs instance/queue with whatever
      // node_modules ships beside the spawned process. See
      // docs/plans/260428_graceful_fs_emfile_fix.md Stage 1.
      external: ['graceful-fs'],
      banner: {
        js: "if (process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') { try { require('graceful-fs').gracefulify(require('node:fs')); } catch (e) { globalThis.__REBEL_BOOTSTRAP_BANNER_ERROR__ = { kind: 'graceful_fs_install_failed', error: { name: e && e.name, message: e && e.message, stack: e && e.stack }, at: Date.now() }; if (process.env.REBEL_DEBUG_BOOTSTRAP === '1') { console.warn('[bootstrap-banner] graceful-fs failed to load:', e); } } }",
      },
    });
    
    const bundleSize = statSync(outfile).size;
    const sizeMB = (bundleSize / 1024 / 1024).toFixed(2);
    console.log(`  ✅ ${mcpName} bundled to server.cjs (${sizeMB} MB)`);
    return { success: true, size: bundleSize };
  } catch (err) {
    const message = err.message || String(err);
    console.error(`  ❌ ${mcpName} bundling failed: ${message.slice(0, 200)}`);
    return { success: false, error: message };
  }
}

/**
 * Install dependencies for an MCP directory.
 * Uses `npm ci` when a lockfile exists, otherwise `npm install`.
 * @param {string} mcpDir
 */
function installDeps(mcpDir) {
  const hasLockfile = existsSync(join(mcpDir, 'package-lock.json'));
  const cmd = hasLockfile ? 'npm ci' : 'npm install';
  execSync(cmd, { cwd: mcpDir, stdio: 'pipe', env: { ...process.env, npm_config_loglevel: 'error' } });
}

/**
 * Known upstream manifest defects in nested node_modules that we patch
 * after `npm ci` so esbuild bundling produces clean output.
 *
 * Each entry is keyed by MCP name and lists package paths whose manifests
 * need a small, idempotent fix. Patches are no-ops when the manifest
 * already has the correct shape, so they survive future upgrades without
 * code changes here.
 *
 * Currently empty: the previous googleapis@129 sideEffects-as-string
 * defect was resolved upstream by 130+. The google-workspace MCP now
 * pins googleapis@^171.4.0 (commit 260501_googleapis_171_upgrade.md),
 * which ships `sideEffects: false` correctly. The patch infrastructure
 * is retained for any future upstream defect that needs the same shape.
 */
const UPSTREAM_MANIFEST_PATCHES = {};

/**
 * Apply known upstream manifest patches for a freshly-installed MCP. Logs
 * each successful patch so silent application is observable; missing files
 * (e.g. dependency removed in a future upgrade) are logged but not fatal so
 * upstream fixes don't require coordinated patch removal.
 * @param {string} mcpName
 * @param {string} mcpDir
 */
function patchUpstreamManifests(mcpName, mcpDir) {
  const patches = UPSTREAM_MANIFEST_PATCHES[mcpName];
  if (!patches) return;

  for (const patch of patches) {
    const manifestPath = join(mcpDir, patch.relativePath);
    if (!existsSync(manifestPath)) {
      console.log(`  ℹ️  ${mcpName} patch skipped (file missing): ${patch.relativePath}`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      console.warn(`  ⚠️  ${mcpName} patch skipped (parse failed): ${patch.relativePath}: ${err.message}`);
      continue;
    }
    if (patch.apply(manifest)) {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      console.log(`  🔧 ${mcpName} patched ${patch.relativePath} (${patch.description})`);
    }
  }
}

/**
 * Compile TypeScript for an MCP directory via `npm run build`.
 * @param {string} mcpDir
 */
function compileTsc(mcpDir) {
  execSync('npm run build', { cwd: mcpDir, stdio: 'pipe' });
}

/**
 * Build a single MCP
 * @param {string} mcpName 
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function buildMcp(mcpName) {
  const mcpDir = join(mcpRoot, mcpName);
  const shouldBundle = BUNDLED_MCPS.includes(mcpName);
  
  console.log(`  📦 Building ${mcpName}${shouldBundle ? ' (will bundle)' : ''}...`);
  
  try {
    installDeps(mcpDir);
    patchUpstreamManifests(mcpName, mcpDir);
    compileTsc(mcpDir);

    if (shouldBundle) {
      // Bundle with esbuild
      const bundleResult = await bundleMcp(mcpName);
      if (!bundleResult.success) {
        return bundleResult;
      }
      console.log(`  ✅ ${mcpName} built and bundled successfully`);
    } else {
      // Remove dev dependencies after build (TypeScript no longer needed at runtime)
      execSync('npm prune --omit=dev', {
        cwd: mcpDir,
        stdio: 'pipe',
        env: { ...process.env, npm_config_loglevel: 'error' }
      });
      console.log(`  ✅ ${mcpName} built successfully`);
    }
    
    return { success: true };
  } catch (err) {
    const message = err.stderr?.toString() || err.message || 'Unknown error';
    console.error(`  ❌ ${mcpName} failed: ${message.slice(0, 200)}`);
    return { success: false, error: message };
  }
}

/**
 * Build MCPs in parallel with concurrency limit
 * @param {string[]} mcpNames 
 * @returns {Promise<Map<string, { success: boolean, error?: string }>>}
 */
async function buildMcpsParallel(mcpNames) {
  const results = new Map();
  const pending = [...mcpNames];
  const running = new Map();
  
  return new Promise((resolve) => {
    function startNext() {
      while (running.size < MAX_CONCURRENCY && pending.length > 0) {
        const name = pending.shift();
        
        // Run build asynchronously (buildMcp is now async)
        const buildPromise = buildMcp(name).then(result => {
          results.set(name, result);
          running.delete(name);
          
          if (pending.length > 0) {
            startNext();
          } else if (running.size === 0) {
            resolve(results);
          }
        });
        
        running.set(name, buildPromise);
      }
      
      if (pending.length === 0 && running.size === 0) {
        resolve(results);
      }
    }
    
    startNext();
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const forceRebuild = process.argv.includes('--force') || process.env.REBUILD_MCPS === '1';

  if (forceRebuild) {
    console.log('⚡ Force rebuild enabled — all caches will be ignored\n');
  }

  console.log('🔍 Discovering MCPs...\n');
  
  const allMcps = discoverMcps(mcpRoot);
  
  if (allMcps.length > 0) {
    console.log(`Found ${allMcps.length} TypeScript MCPs (need build):\n  ${allMcps.join(', ')}\n`);
  }
  
  if (allMcps.length === 0) {
    console.log('No MCPs to process.');
    return;
  }

  // Warn about config-to-disk drift (MCPs on disk but not in bundledMcps, or vice versa)
  const ALWAYS_UNBUNDLED = mcpConfig.alwaysUnbundled ?? ['microsoft-shared'];
  const onDiskNotInConfig = allMcps.filter(m => !BUNDLED_MCPS.includes(m) && !ALWAYS_UNBUNDLED.includes(m));
  const inConfigNotOnDisk = BUNDLED_MCPS.filter(m => !allMcps.includes(m));
  if (onDiskNotInConfig.length > 0 || inConfigNotOnDisk.length > 0) {
    console.warn('⚠️  mcp-config.json may be out of sync with disk:');
    if (onDiskNotInConfig.length) console.warn(`   On disk but not in bundledMcps: ${onDiskNotInConfig.join(', ')}`);
    if (inConfigNotOnDisk.length) console.warn(`   In bundledMcps but not on disk: ${inConfigNotOnDisk.join(', ')}`);
    console.warn('');
  }

  // Precompute build environment hashes (shared across all MCPs)
  // Hash both the main script and the utils module so changes to either invalidate caches
  const mainScriptHash = computeFileHash(__filename);
  const utilsHash = computeFileHash(join(__dirname, 'build-bundled-mcps-utils.mjs'));
  const buildScriptHash = createHash('sha256').update(mainScriptHash).update(utilsHash).digest('hex');
  const esbuildVersion = getEsbuildVersion();
  const npmVersion = getNpmVersion();

  const results = new Map();
  let skippedCount = 0;
  let rebuiltCount = 0;
  
  // ── microsoft-shared (build first — dependency for other MS MCPs) ──────

  let microsoftSharedHash = null;

  if (allMcps.includes('microsoft-shared')) {
    const isBundled = BUNDLED_MCPS.includes('microsoft-shared');
    const kind = isBundled ? 'bundled' : 'unbundled';
    microsoftSharedHash = computeMcpHash('microsoft-shared', { mcpRoot, mcpConfigPath, buildScriptHash, esbuildVersion, npmVersion });
    const storedHash = readHashFile('microsoft-shared', mcpGeneratedRoot);
    const artifactOk = outputArtifactExists('microsoft-shared', kind, { mcpRoot, mcpGeneratedRoot });

    if (!forceRebuild && microsoftSharedHash === storedHash && artifactOk && smokeCheckBundle('microsoft-shared')) {
      console.log('⏭️  skip microsoft-shared (up to date)\n');
      results.set('microsoft-shared', { success: true });
      skippedCount++;
    } else {
      const reason = !artifactOk ? 'missing artifacts' : storedHash == null ? 'no cache' : 'sources changed';
      console.log(`📦 rebuild microsoft-shared (${reason})...\n`);
      const result = await buildMcp('microsoft-shared');
      results.set('microsoft-shared', result);

      if (!result.success) {
        console.error('\n❌ microsoft-shared failed to build. Stopping.');
        process.exit(1);
      }
      // Recompute hash after build in case npm install created/modified package-lock.json
      microsoftSharedHash = computeMcpHash('microsoft-shared', { mcpRoot, mcpConfigPath, buildScriptHash, esbuildVersion, npmVersion });
      writeHashFile('microsoft-shared', microsoftSharedHash, mcpGeneratedRoot);
      rebuiltCount++;
      console.log('');
    }
  }

  // Warn if microsoft-shared is missing but dependents exist
  if (!allMcps.includes('microsoft-shared')) {
    const presentDeps = allMcps.filter(n => MICROSOFT_DEPENDENTS.includes(n));
    if (presentDeps.length > 0) {
      console.warn(`⚠️  microsoft-shared not found but these MCPs depend on it: ${presentDeps.join(', ')}`);
      console.warn('   Their builds may fail or produce broken output.\n');
    }
  }

  // ── Remaining TypeScript MCPs ──────────────────────────────────────────

  const remaining = allMcps.filter(name => name !== 'microsoft-shared');
  const toBuild = [];

  for (const mcpName of remaining) {
    const isBundled = BUNDLED_MCPS.includes(mcpName);
    const kind = isBundled ? 'bundled' : 'unbundled';
    const isMsDep = MICROSOFT_DEPENDENTS.includes(mcpName);
    const currentHash = computeMcpHash(mcpName, {
      mcpRoot,
      mcpConfigPath,
      buildScriptHash,
      esbuildVersion,
      npmVersion,
      microsoftSharedHash: isMsDep ? microsoftSharedHash : undefined,
    });
    const storedHash = readHashFile(mcpName, mcpGeneratedRoot);
    const artifactOk = outputArtifactExists(mcpName, kind, { mcpRoot, mcpGeneratedRoot });

    if (!forceRebuild && currentHash === storedHash && artifactOk && smokeCheckBundle(mcpName)) {
      console.log(`⏭️  skip ${mcpName} (up to date)`);
      results.set(mcpName, { success: true });
      skippedCount++;
    } else {
      const reason = !artifactOk ? 'missing artifacts' : storedHash == null ? 'no cache' : 'sources changed';
      console.log(`📦 rebuild ${mcpName} (${reason})`);
      toBuild.push(mcpName);
    }
  }

  if (toBuild.length > 0) {
    console.log(`\n📦 Building ${toBuild.length} MCPs (concurrency: ${MAX_CONCURRENCY})...\n`);
    const parallelResults = await buildMcpsParallel(toBuild);
    for (const name of toBuild) {
      const result = parallelResults.get(name);
      results.set(name, result);
      if (result.success) {
        // Recompute hash after build in case npm install created/modified package-lock.json
        const isMsDep = MICROSOFT_DEPENDENTS.includes(name);
        const finalHash = computeMcpHash(name, {
          mcpRoot,
          mcpConfigPath,
          buildScriptHash,
          esbuildVersion,
          npmVersion,
          microsoftSharedHash: isMsDep ? microsoftSharedHash : undefined,
        });
        writeHashFile(name, finalHash, mcpGeneratedRoot);
        rebuiltCount++;
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────

  const failed = [...results.entries()].filter(([, r]) => !r.success);
  const failedCount = failed.length;
  
  console.log('\n' + '='.repeat(50));
  console.log(`✅ ${skippedCount} skipped (up to date), ${rebuiltCount} rebuilt, ${failedCount} failed`);
  
  if (failedCount > 0) {
    console.log(`❌ ${failedCount} MCPs failed:`);
    failed.forEach(([name]) => console.log(`   - ${name}`));
    process.exit(1);
  }
  
  console.log('\n🎉 All MCPs processed successfully!');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
