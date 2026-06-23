#!/usr/bin/env npx tsx
/**
 * Post-package assertion for the bundled Super-MCP runtime.
 *
 * Stage 2 of docs/plans/260607_supermcp-release-automation/PLAN.md makes the
 * bundled runtime the packaged-app path. This script catches packaging layout
 * drift before a packaged app can fall through to any dev-only registry path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PackagedSuperMcpBundleCheckResult {
  ok: boolean;
  checkedResourcesDirs: string[];
  missing: string[];
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function discoverResourcesDirs(basePath: string): string[] {
  const resolvedBase = path.resolve(basePath);
  const candidates = new Set<string>();

  for (const candidate of [
    resolvedBase,
    path.join(resolvedBase, 'Resources'),
    path.join(resolvedBase, 'Contents', 'Resources'),
  ]) {
    if (path.basename(candidate) === 'Resources' && isDirectory(candidate)) {
      candidates.add(candidate);
    }
  }

  const pending: Array<{ dir: string; depth: number }> = [{ dir: resolvedBase, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 4 || !isDirectory(current.dir)) {
      continue;
    }
    if (path.basename(current.dir) === 'Resources') {
      candidates.add(current.dir);
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      pending.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return [...candidates].sort();
}

export function checkPackagedSuperMcpBundle(basePath: string): PackagedSuperMcpBundleCheckResult {
  const resourcesDirs = discoverResourcesDirs(basePath);
  const missing: string[] = [];

  if (resourcesDirs.length === 0) {
    missing.push(`No Resources directory found under ${path.resolve(basePath)}`);
  }

  for (const resourcesDir of resourcesDirs) {
    for (const requiredPath of [
      path.join(resourcesDir, 'super-mcp', 'dist', 'cli.js'),
      path.join(resourcesDir, 'super-mcp', 'node_modules'),
    ]) {
      if (!fs.existsSync(requiredPath)) {
        missing.push(requiredPath);
      }
    }
  }

  return {
    ok: missing.length === 0,
    checkedResourcesDirs: resourcesDirs,
    missing,
  };
}

function main(argv: readonly string[]): number {
  const basePath = argv[0] ?? path.resolve(process.cwd(), 'out');
  const result = checkPackagedSuperMcpBundle(basePath);

  if (!result.ok) {
    process.stderr.write('[check-packaged-super-mcp-bundle] FAIL: packaged Super-MCP bundle is incomplete.\n');
    for (const missingPath of result.missing) {
      process.stderr.write(`  missing: ${missingPath}\n`);
    }
    return 1;
  }

  process.stdout.write(
    '[check-packaged-super-mcp-bundle] OK: bundled Super-MCP runtime present in ' +
      `${result.checkedResourcesDirs.length} Resources director${result.checkedResourcesDirs.length === 1 ? 'y' : 'ies'}.\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exit(main(process.argv.slice(2)));
}
