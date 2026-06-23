#!/usr/bin/env npx tsx

/**
 * ============================================================================
 * Dev-side changelog-heading assertion
 * ============================================================================
 *
 * Asserts the user-facing changelog (rebel-system/help-for-humans/changelog.md)
 * already carries a `## v<version>` heading matching the repo's package.json
 * version — the SAME convention three release-time gates require (reusable
 * `validate-release`, publish-to-gcs, and release-to-production's
 * `validateChangelogForRelease`) plus the CI-triggered-promote fast-forward
 * pre-flight (`changelog-heading`).
 *
 * WHY (S10): those gates only run on the privileged main / promote path, so a
 * missing heading surfaces late — at release time, after a long build. This is
 * the early-warning lever: it runs on dev pushes (wired into dev-checks.yml,
 * RED-but-non-blocking) so drift is caught weeks early, with context, while the
 * change that introduced it is fresh. It does NOT gate publish — dev-checks
 * doesn't gate release — it just goes red so someone notices.
 *
 * DESIGN: pure core + thin CLI.
 * - `evaluateChangelogHeadingCurrent({ version, content })` is a pure,
 *   dependency-injected function (no I/O) — exhaustively unit-testable.
 * - The thin `main()` reads the real package.json version and the real
 *   changelog file, then prints + exits per the verdict.
 *
 * The heading-match rule is the single source of truth re-exported from
 * scripts/promote-preflight.ts (`changelogHasVersionHeading`) — import-only
 * reuse, never a second regex.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { changelogHasVersionHeading } from './promote-preflight';

/** Path to the user-facing changelog, relative to the repo root. */
export const CHANGELOG_RELATIVE_PATH = 'rebel-system/help-for-humans/changelog.md';

export interface ChangelogHeadingInputs {
  /** The version the heading must match (the repo's package.json version). */
  version: string;
  /** The full changelog file content. */
  content: string;
}

export interface ChangelogHeadingResult {
  /** true iff a `## v<version>` heading is present. */
  ok: boolean;
  /** human-legible reason (names the expected heading + how to fix on failure). */
  reason: string;
}

/**
 * Pure verdict: is the `## v<version>` heading present in `content`?
 * Fail-closed on a missing/blank version or content — the CLI must always have
 * both, so an empty here is itself a (loud) failure rather than a silent pass.
 */
export function evaluateChangelogHeadingCurrent(inputs: ChangelogHeadingInputs): ChangelogHeadingResult {
  const version = (inputs.version ?? '').trim();
  const content = inputs.content ?? '';

  if (!version) {
    return {
      ok: false,
      reason: 'Could not determine the package.json version — cannot check the changelog heading.',
    };
  }

  if (changelogHasVersionHeading(content, version)) {
    return {
      ok: true,
      reason: `Changelog has the expected '## v${version}' heading.`,
    };
  }

  const hasUnreleased = /^## Unreleased(\s|$)/m.test(content);
  const unreleasedNote = hasUnreleased
    ? ` The changelog has a '## Unreleased' section — rename it to '## v${version} — <date range>'.`
    : '';

  return {
    ok: false,
    reason:
      `Changelog at ${CHANGELOG_RELATIVE_PATH} is missing a '## v${version}' heading ` +
      `(must match package.json version ${version}).${unreleasedNote} ` +
      `Add a '## v${version} — <date range>' section at the top of the entries ` +
      `(see docs/project/CHANGELOG_UPDATE_PROCESS.md), or run ` +
      `\`npx tsx scripts/ensure-changelog-section.ts\` to open it.`,
  };
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
  // The script lives in <repoRoot>/scripts, so the repo root is its parent.
  const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
  const changelogPath = resolve(repoRoot, CHANGELOG_RELATIVE_PATH);

  if (!existsSync(changelogPath)) {
    console.error(`changelog-heading check: changelog not found at ${changelogPath}`);
    process.exit(1);
  }

  const version = readPackageJsonVersion(repoRoot);
  const content = readFileSync(changelogPath, 'utf8');

  const result = evaluateChangelogHeadingCurrent({ version, content });
  if (result.ok) {
    console.log(`changelog-heading check: ${result.reason}`);
    process.exit(0);
  }
  console.error(`changelog-heading check: ${result.reason}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
