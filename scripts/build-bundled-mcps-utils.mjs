/**
 * Shared utilities for MCP build infrastructure.
 *
 * Extracted from build-bundled-mcps.mjs for testability.
 * All path-dependent functions accept explicit root parameters
 * instead of relying on module-level globals.
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join, relative } from 'path';
import { createHash } from 'crypto';

/**
 * Compute SHA-256 hex digest of a single file's contents.
 * @param {string} filePath
 * @returns {string}
 */
export function computeFileHash(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Recursively walk a directory, returning all file paths.
 * Skips node_modules and build directories.
 * @param {string} dir
 * @returns {string[]}
 */
export function walkDir(dir) {
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      entries.push(fullPath);
    }
  }
  return entries;
}

/**
 * Compute a composite SHA-256 hash for an MCP from all its build inputs.
 *
 * Hash inputs:
 *   1. All files under src/ (sorted by relative path for determinism)
 *   2. package.json, package-lock.json, tsconfig.json (if they exist)
 *   3. Shared base tsconfig (if it exists)
 *   4. Shared MCP config (if it exists)
 *   5. Build script hash
 *   6. esbuild version
 *   7. Node.js version, platform, and architecture
 *   8. npm version (when available)
 *   9. microsoft-shared full hash (for microsoft-* dependents only)
 *
 * @param {string} mcpName
 * @param {{ mcpRoot: string, mcpConfigPath: string, buildScriptHash: string, esbuildVersion: string, npmVersion?: string, microsoftSharedHash?: string }} opts
 * @returns {string}
 */
export function computeMcpHash(mcpName, { mcpRoot, mcpConfigPath, buildScriptHash, esbuildVersion, npmVersion, microsoftSharedHash }) {
  const hash = createHash('sha256');
  const mcpDir = join(mcpRoot, mcpName);

  // 1. Source files (sorted for determinism)
  const srcDir = join(mcpDir, 'src');
  const srcFiles = walkDir(srcDir).sort();
  for (const file of srcFiles) {
    // Normalize to forward slashes so hashes are identical across platforms
    const rel = relative(mcpDir, file).replace(/\\/g, '/');
    hash.update(rel + '\0');
    hash.update(readFileSync(file));
  }

  // 2. Config files
  for (const configFile of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    const filePath = join(mcpDir, configFile);
    if (existsSync(filePath)) {
      hash.update(configFile + '\0');
      hash.update(readFileSync(filePath));
    }
  }

  // 2b. Shared base tsconfig (if it exists)
  const baseTsconfigPath = join(mcpRoot, 'tsconfig.base.json');
  if (existsSync(baseTsconfigPath)) {
    hash.update('tsconfig.base.json\0');
    hash.update(readFileSync(baseTsconfigPath));
  }

  // 2c. Shared MCP config (bundled list — changes invalidate all caches)
  if (mcpConfigPath && existsSync(mcpConfigPath)) {
    hash.update('mcp-config.json\0');
    hash.update(readFileSync(mcpConfigPath));
  }

  // 3. Build environment
  hash.update('buildScript\0' + buildScriptHash);
  hash.update('esbuild\0' + esbuildVersion);
  hash.update('node\0' + process.version);
  hash.update('platform\0' + process.platform);
  hash.update('arch\0' + process.arch);
  if (npmVersion) {
    hash.update('npm\0' + npmVersion);
  }

  // 4. microsoft-shared full computed hash (for microsoft-* MCPs)
  if (microsoftSharedHash) {
    hash.update('microsoftShared\0' + microsoftSharedHash);
  }

  return hash.digest('hex');
}

/**
 * Read a stored hash file for an MCP. Returns null if not found.
 * @param {string} mcpName
 * @param {string} mcpGeneratedRoot
 * @returns {string | null}
 */
export function readHashFile(mcpName, mcpGeneratedRoot) {
  try {
    const hashPath = join(mcpGeneratedRoot, mcpName, '.build-hash');
    return readFileSync(hashPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Atomically write a hash file for an MCP (.tmp + rename).
 * @param {string} mcpName
 * @param {string} hash
 * @param {string} mcpGeneratedRoot
 */
export function writeHashFile(mcpName, hash, mcpGeneratedRoot) {
  const dir = join(mcpGeneratedRoot, mcpName);
  mkdirSync(dir, { recursive: true });
  const hashPath = join(dir, '.build-hash');
  const tmpPath = join(dir, '.build-hash.tmp');
  writeFileSync(tmpPath, hash + '\n', 'utf8');
  renameSync(tmpPath, hashPath);
}

/**
 * Check whether the expected output artifact(s) exist for an MCP.
 *   - Bundled MCPs: <mcpGeneratedRoot>/<name>/server.cjs
 *   - Unbundled MCPs: <mcpRoot>/<name>/build/index.js AND node_modules/ exists
 * @param {string} mcpName
 * @param {'bundled' | 'unbundled'} kind
 * @param {{ mcpRoot: string, mcpGeneratedRoot: string }} opts
 * @returns {boolean}
 */
export function outputArtifactExists(mcpName, kind, { mcpRoot, mcpGeneratedRoot }) {
  if (kind === 'bundled') {
    return existsSync(join(mcpGeneratedRoot, mcpName, 'server.cjs'));
  }
  // unbundled: needs both build output and runtime dependencies
  return (
    existsSync(join(mcpRoot, mcpName, 'build', 'index.js')) &&
    existsSync(join(mcpRoot, mcpName, 'node_modules'))
  );
}

/**
 * Discover all MCP directories that have tsconfig.json (need build step).
 * @param {string} mcpRoot
 * @returns {string[]}
 */
export function discoverMcps(mcpRoot) {
  return readdirSync(mcpRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => existsSync(join(mcpRoot, name, 'tsconfig.json')))
    .sort();
}
