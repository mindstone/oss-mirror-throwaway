#!/usr/bin/env node
/**
 * Patch @electron/osx-sign walkAsync to avoid unbounded Promise.all concurrency.
 *
 * Why:
 * - @electron/osx-sign@1.3.3 walkAsync recurses with Promise.all and calls isBinaryFile()
 *   for every file in the .app bundle.
 * - For large bundles (e.g. MCP servers + git-bundle), this can open thousands of files
 *   concurrently and hit EMFILE on some CI runners even when ulimit is increased.
 *
 * Fix:
 * - Replace the Promise.all child traversal with a sequential for-of walk.
 *   (Matches the approach proposed in electron/osx-sign PR #286.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const TARGETS = [
  path.join(projectRoot, 'node_modules', '@electron', 'osx-sign', 'dist', 'cjs', 'util.js'),
  path.join(projectRoot, 'node_modules', '@electron', 'osx-sign', 'dist', 'esm', 'util.js'),
];

const PATCH_MARKER = '[mindstone-rebel] walkAsync patched';

function patchWalkAsyncUtilFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { status: 'missing' };
  }

  const original = fs.readFileSync(filePath, 'utf8');

  const isEsm = original.includes('export async function walkAsync');

  if (original.includes(PATCH_MARKER)) {
    // Early version of this patch accidentally referenced `exports` inside the ESM build.
    // If we see that, rewrite to use the local ESM symbol.
    if (isEsm && original.includes('(0, exports.debugLog)')) {
      const fixed = original.replaceAll('(0, exports.debugLog)', 'debugLog');
      fs.writeFileSync(filePath, fixed, 'utf8');
      return { status: 'repatched_esm' };
    }
    return { status: 'already_patched' };
  }

  // Replace only the inner _walkAsync implementation to minimize patch fragility.
  const walkAsyncInnerRegex =
    /async function _walkAsync\(dirPath\) \{[\s\S]*?\n\s*\}\n\s*const allPaths = await _walkAsync\(dirPath\);/m;

  const removingLogLine = isEsm
    ? `                        debugLog('Removing... ' + filePath);\n`
    : `                        (0, exports.debugLog)('Removing... ' + filePath);\n`;

  const replacementInner = `async function _walkAsync(dirPath) {\n` +
    `        const children = await fs.readdir(dirPath);\n` +
    `        const results = [];\n` +
    `        for (const child of children) {\n` +
    `            const filePath = path.resolve(dirPath, child);\n` +
    `            const stat = await fs.stat(filePath);\n` +
    `            if (stat.isFile()) {\n` +
    `                switch (path.extname(filePath)) {\n` +
    `                    case '.cstemp': // Temporary file generated from past codesign\n` +
    removingLogLine +
    `                        await fs.remove(filePath);\n` +
    `                        break;\n` +
    `                    default: {\n` +
    `                        const maybeBinaryPath = await getFilePathIfBinary(filePath);\n` +
    `                        if (maybeBinaryPath) {\n` +
    `                            results.push(maybeBinaryPath);\n` +
    `                        }\n` +
    `                        break;\n` +
    `                    }\n` +
    `                }\n` +
    `            }\n` +
    `            else if (stat.isDirectory() && !stat.isSymbolicLink()) {\n` +
    `                const walkResult = await _walkAsync(filePath);\n` +
    `                switch (path.extname(filePath)) {\n` +
    `                    case '.app': // Application\n` +
    `                    case '.framework': // Framework\n` +
    `                        walkResult.push(filePath);\n` +
    `                }\n` +
    `                results.push(walkResult);\n` +
    `            }\n` +
    `        }\n` +
    `        return results;\n` +
    `    }\n` +
    `    const allPaths = await _walkAsync(dirPath);`;

  if (!walkAsyncInnerRegex.test(original)) {
    return { status: 'no_match' };
  }

  const patched =
    `// ${PATCH_MARKER}: avoid EMFILE via sequential traversal\n` +
    original.replace(walkAsyncInnerRegex, replacementInner);

  fs.writeFileSync(filePath, patched, 'utf8');
  return { status: 'patched' };
}

function main() {
  const results = [];
  for (const target of TARGETS) {
    results.push({ file: target, ...patchWalkAsyncUtilFile(target) });
  }

  const patchedCount = results.filter((r) => r.status === 'patched').length;
  const alreadyCount = results.filter((r) => r.status === 'already_patched').length;

  if (patchedCount === 0 && alreadyCount === 0) {
    // Don't hard fail installs; this patch is best-effort and dependency layout can change.
    console.log('[patch-electron-osx-sign-walkasync] No files patched');
    for (const r of results) {
      console.log(`  - ${r.status}: ${r.file}`);
    }
    return;
  }

  console.log(
    `[patch-electron-osx-sign-walkasync] Patched: ${patchedCount}, already patched: ${alreadyCount}`
  );
}

main();
