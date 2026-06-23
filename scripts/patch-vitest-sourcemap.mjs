#!/usr/bin/env node
/**
 * Patch @vitest/utils extractSourcemapFromFile to tolerate malformed inline source maps.
 *
 * Why:
 * - On Linux CI runners only, vitest's unhandled-error stack-trace formatter crashes with
 *   `SyntaxError: Unexpected token '�', "�" is not valid JSON` during teardown.
 * - Root cause: parseErrorStacktrace -> getSourceMap -> extractSourcemapFromFile reads some
 *   file whose `//# sourceMappingURL=data:...` comment has non-JSON base64 payload, and
 *   convert-source-map's Converter throws from JSON.parse in its constructor.
 * - This happens AFTER all tests pass (17391 passing, 0 failing) but causes the process to
 *   exit 1, blocking CI.
 * - The failing file cannot be identified from the stack trace alone, and the issue does
 *   not reproduce on macOS locally.
 *
 * Fix:
 * - Wrap extractSourcemapFromFile in try/catch so a malformed inline sourcemap simply
 *   degrades to "no sourcemap available" for that frame rather than crashing the whole
 *   vitest process. Stack traces for such frames will be slightly less pretty; functionality
 *   is preserved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const TARGET = path.join(
  projectRoot,
  'node_modules',
  '@vitest',
  'utils',
  'dist',
  'source-map',
  'node.js'
);

const PATCH_MARKER = '[mindstone-rebel] extractSourcemapFromFile patched';

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { status: 'missing' };
  }

  const original = fs.readFileSync(filePath, 'utf8');

  if (original.includes(PATCH_MARKER)) {
    return { status: 'already_patched' };
  }

  // Match the exact function body we ship against.
  const FUNCTION_REGEX =
    /function extractSourcemapFromFile\(code, filePath\) \{\s*const map = \(convertSourceMap\.fromSource\(code\) \|\| convertSourceMap\.fromMapFileSource\(code, createConvertSourceMapReadMap\(filePath\)\)\)\?\.\s*toObject\(\);\s*return map \? \{ map \} : undefined;\s*\}/;

  if (!FUNCTION_REGEX.test(original)) {
    return { status: 'no_match' };
  }

  const replacement =
    `function extractSourcemapFromFile(code, filePath) {\n` +
    `\ttry {\n` +
    `\t\tconst map = (convertSourceMap.fromSource(code) || convertSourceMap.fromMapFileSource(code, createConvertSourceMapReadMap(filePath)))?.toObject();\n` +
    `\t\treturn map ? { map } : undefined;\n` +
    `\t} catch {\n` +
    `\t\t// Malformed inline sourcemap comment (e.g. binary data base64'd into a sourcemap\n` +
    `\t\t// URL). Fall back to no sourcemap rather than crashing the whole vitest run.\n` +
    `\t\treturn undefined;\n` +
    `\t}\n` +
    `}`;

  const patched =
    `// ${PATCH_MARKER}: tolerate malformed inline sourcemaps\n` +
    original.replace(FUNCTION_REGEX, replacement);

  fs.writeFileSync(filePath, patched, 'utf8');
  return { status: 'patched' };
}

function main() {
  const result = patchFile(TARGET);
  if (result.status === 'patched') {
    console.log(`[patch-vitest-sourcemap] Patched: ${TARGET}`);
  } else if (result.status === 'already_patched') {
    console.log(`[patch-vitest-sourcemap] Already patched: ${TARGET}`);
  } else {
    // Don't hard fail installs; dep layout may change across vitest versions.
    console.log(`[patch-vitest-sourcemap] ${result.status}: ${TARGET}`);
  }
}

main();
