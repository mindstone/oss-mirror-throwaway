/**
 * Scan source directories for all named `import { X } from 'electron'`
 * and return a Set of import names.
 *
 * Uses Node.js fs (no external tools like rg) so it works in Docker
 * builds and CI without extra dependencies.
 *
 * Consumers: cloud-service/build.mjs, evals/build.mjs,
 *            evals/build-semantic-retrieval.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const IMPORT_REGEX = /import\s*\{([^}]+)\}\s*from\s*'electron'/g;

/**
 * @param {{ projectRoot: string, scanDirs?: string[] }} options
 * @returns {Set<string>} Set of named electron import identifiers
 */
export function discoverElectronImports({ projectRoot, scanDirs }) {
  const dirs = scanDirs ?? [
    path.join(projectRoot, 'src/main'),
    path.join(projectRoot, 'src/preload'),
  ];
  const imports = new Set();

  function scanDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        scanDir(full);
      } else if (/\.[tj]sx?$/.test(entry.name)) {
        let content;
        try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
        let match;
        while ((match = IMPORT_REGEX.exec(content)) !== null) {
          for (const name of match[1].split(',')) {
            let trimmed = name.trim();
            if (!trimmed || trimmed.startsWith('type ')) continue;
            const asMatch = trimmed.match(/^\S+\s+as\s+(\S+)$/);
            if (asMatch) trimmed = asMatch[1];
            imports.add(trimmed);
          }
        }
      }
    }
  }

  for (const dir of dirs) scanDir(dir);
  return imports;
}

/**
 * Given a set of specialized stub names and a set of discovered import
 * names, return an array of stub lines for any discovered name not in
 * the specialized set.
 *
 * @param {{ specialized: Set<string>, discovered: Set<string>, mode?: 'noop' | 'throw' }} options
 *   - `noop` (default): assigns `noopProxy` — silently succeeds on any access.
 *     Appropriate for eval builds where survivability matters more than correctness.
 *   - `throw`: generates a per-import Proxy that throws on any property access.
 *     Appropriate for production cloud builds where silent electron usage is a bug.
 * @returns {{ autoStubs: string[], allNames: string[] }}
 */
export function buildAutoStubs({ specialized, discovered, mode = 'noop' }) {
  const autoStubs = [];
  for (const name of discovered) {
    if (!specialized.has(name)) {
      if (mode === 'throw') {
        autoStubs.push(
          `const ${name} = new Proxy({}, { get(_, prop) { ` +
          `if (prop === 'then') return undefined; ` +
          `throw new Error("Electron API '${name}." + String(prop) + "' is not available in cloud mode. ` +
          `Move this code behind a platform guard or into src/main/."); } });`
        );
      } else {
        autoStubs.push(`const ${name} = noopProxy;`);
      }
    }
  }

  const allNames = [...new Set([...specialized, ...discovered])]
    .filter(n => !n.startsWith('type '))
    .sort();

  return { autoStubs, allNames };
}
