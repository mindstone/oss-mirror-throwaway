#!/usr/bin/env npx tsx
/**
 * Frontmatter ratchet for docs/project/.
 *
 * Policy (docs/project/DEV_DOCUMENTATION.md § Frontmatter standard): every
 * docs/project/ markdown file should carry YAML frontmatter with `description`
 * and `last_updated`. Soft enforcement let this drift — ~187 of 355 files lack
 * it. A big-bang backfill was explicitly rejected, so this gate works as a
 * RATCHET instead: it never forces existing docs to be fixed, but it
 *   1. fails if a *changed* doc lacks frontmatter (`--changed`), and
 *   2. fails if the repo-wide missing-count goes UP vs the committed baseline.
 * Backfill drains the baseline over time; `--update-baseline` records progress.
 *
 * Mirrors the ratchet idiom of scripts/check-typescript-errors.ts.
 *
 * Run via:
 *   npx tsx scripts/check-doc-frontmatter.ts                 # repo-wide ratchet
 *   npx tsx scripts/check-doc-frontmatter.ts --changed       # strict on changed docs (vs origin/dev)
 *   npx tsx scripts/check-doc-frontmatter.ts --changed main  # strict on changed docs vs <ref>
 *   npx tsx scripts/check-doc-frontmatter.ts --update-baseline
 * Part of validate:fast pipeline (as `validate:doc-frontmatter`).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gitCapture } from './lib/git-exec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const docsRoot = join(repoRoot, 'docs', 'project');
const baselinePath = join(__dirname, 'doc-frontmatter-baseline.json');

const REQUIRED_KEYS = ['description', 'last_updated'] as const;

/** List git-tracked markdown files under docs/project/ (recursive). */
function trackedDocs(): string[] {
  const out = gitCapture(['ls-files', 'docs/project/**/*.md', 'docs/project/*.md'], { cwd: repoRoot });
  return out
    .split('\n')
    .map((l: string) => l.trim())
    .filter(Boolean);
}

/**
 * A file "has frontmatter" if it opens with a `---` fence, has a closing `---`,
 * and the block contains every REQUIRED_KEYS entry as a `key:` line.
 */
function hasFrontmatter(absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  const text = readFileSync(absPath, 'utf8');
  if (!text.startsWith('---')) return false;
  const rest = text.slice(text.indexOf('\n') + 1);
  const end = rest.indexOf('\n---');
  if (end === -1) return false;
  const block = rest.slice(0, end);
  return REQUIRED_KEYS.every((k) => new RegExp(`^\\s*${k}\\s*:`, 'm').test(block));
}

function missingFrontmatter(relPaths: string[]): string[] {
  return relPaths.filter((rel) => !hasFrontmatter(join(repoRoot, rel))).sort();
}

function readBaseline(): number {
  if (!existsSync(baselinePath)) return Number.POSITIVE_INFINITY;
  return JSON.parse(readFileSync(baselinePath, 'utf8')).missing ?? Number.POSITIVE_INFINITY;
}

function changedDocs(baseRef: string): string[] {
  // Files added/modified vs the merge-base with baseRef, scoped to docs/project/*.md.
  let mergeBase = baseRef;
  try {
    mergeBase = gitCapture(['merge-base', 'HEAD', baseRef], { cwd: repoRoot }).trim();
  } catch {
    /* baseRef may be unreachable in shallow CI checkouts — fall back to a direct diff */
  }
  let out = '';
  try {
    out = gitCapture(['diff', '--name-only', '--diff-filter=AM', `${mergeBase}...HEAD`], { cwd: repoRoot });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l.startsWith('docs/project/') && l.endsWith('.md'));
}

function main(): void {
  const args = process.argv.slice(2);
  console.log('📝 Doc Frontmatter Ratchet');
  console.log('==========================\n');

  if (!existsSync(docsRoot)) {
    console.log('⏭️  docs/project not found — skipping\n');
    return;
  }

  const all = trackedDocs();
  const missing = missingFrontmatter(all);
  const present = all.length - missing.length;

  if (args.includes('--update-baseline')) {
    writeFileSync(baselinePath, JSON.stringify({ missing: missing.length }, null, 2) + '\n');
    console.log(`✍️  Baseline updated: ${missing.length} file(s) missing frontmatter.\n`);
    return;
  }

  // --changed: strict. Any newly added/modified doc MUST carry frontmatter.
  if (args.includes('--changed')) {
    const i = args.indexOf('--changed');
    const baseRef = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'origin/dev';
    const changed = changedDocs(baseRef);
    const offenders = missingFrontmatter(changed);
    if (offenders.length > 0) {
      console.error(
        `❌ ${offenders.length} changed doc(s) lack \`description\`+\`last_updated\` frontmatter:\n`,
      );
      for (const f of offenders) console.error(`   - ${f}`);
      console.error(
        `\n   Fix: add YAML frontmatter (see docs/project/DEV_DOCUMENTATION.md § Frontmatter standard).\n`,
      );
      process.exit(1);
    }
    console.log(`✅ All ${changed.length} changed doc(s) carry frontmatter.\n`);
    return;
  }

  // Default: repo-wide ratchet. Fail only if the count went UP.
  const baseline = readBaseline();
  console.log(`   ${present}/${all.length} docs have frontmatter; ${missing.length} missing.`);
  console.log(`   Baseline (max allowed missing): ${baseline}\n`);

  if (missing.length > baseline) {
    console.error(
      `❌ Missing-frontmatter count rose ${baseline} → ${missing.length}. New offenders likely:\n`,
    );
    for (const f of missing.slice(0, 20)) console.error(`   - ${f}`);
    if (missing.length > 20) console.error(`   …and ${missing.length - 20} more`);
    console.error(
      `\n   Add frontmatter to the doc(s) you touched, or run --update-baseline if you intentionally added a doc and backfilled others.\n`,
    );
    process.exit(1);
  }

  if (missing.length < baseline) {
    console.log(
      `🎉 Missing count dropped ${baseline} → ${missing.length}. Lower the ratchet:\n   npx tsx scripts/check-doc-frontmatter.ts --update-baseline\n`,
    );
    // Improvement is not a failure; surface it but exit clean.
  } else {
    console.log('✅ No regression in frontmatter coverage.\n');
  }
}

main();
