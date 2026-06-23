#!/usr/bin/env npx tsx

/**
 * ============================================================================
 * ensure-changelog-section CLI — open the current version's changelog section
 * ============================================================================
 *
 * Thin CLI over the pure `ensureChangelogSection` helper. Reads the repo's
 * package.json version + the user-facing changelog
 * (rebel-system/help-for-humans/changelog.md), inserts a
 * `## v<version> — <today>` section if it's missing, and writes the file back
 * ONLY when it changed. Fully idempotent: a no-op (exit 0) if the section is
 * already present.
 *
 * SCOPE: edits the changelog FILE only. It does NOT commit, push, or advance the
 * rebel-system submodule pointer — that wiring (into the post-promote dev bump)
 * is a later stage. Run standalone, this is purely the editor.
 *
 * The inserted heading is one line that already matches the live convention; the
 * rebel-system OSS leak gate scans this file, but a `## v<version>` heading
 * carries no secret/PII risk.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { ensureChangelogSection } from './lib/ensure-changelog-section';
import { CHANGELOG_RELATIVE_PATH } from './check-changelog-heading-current';

/** Today's date formatted like the existing headings (e.g. `Jun 19, 2026`). */
export function formatToday(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function readPackageJsonVersion(repoRoot: string): string {
  const pkgPath = resolve(repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error(`package.json at ${pkgPath} has no usable "version" field`);
  }
  return pkg.version;
}

function main(): void {
  const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
  const changelogPath = resolve(repoRoot, CHANGELOG_RELATIVE_PATH);

  if (!existsSync(changelogPath)) {
    console.error(`ensure-changelog-section: changelog not found at ${changelogPath}`);
    process.exit(1);
  }

  const version = readPackageJsonVersion(repoRoot);
  const today = formatToday(new Date());
  const original = readFileSync(changelogPath, 'utf8');
  const updated = ensureChangelogSection(original, version, today);

  if (updated === original) {
    console.log(`ensure-changelog-section: '## v${version}' heading already present — no change.`);
    process.exit(0);
  }

  writeFileSync(changelogPath, updated);
  console.log(`ensure-changelog-section: inserted '## v${version} — ${today}' section into ${CHANGELOG_RELATIVE_PATH}.`);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
