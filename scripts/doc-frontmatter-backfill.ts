#!/usr/bin/env npx tsx
/**
 * One-shot backfill helper for the docs/project frontmatter ratchet.
 *
 * Companion to scripts/check-doc-frontmatter.ts. Two modes:
 *   --list            Print JSON describing every git-tracked docs/project doc
 *                     that is missing `description` and/or `last_updated`,
 *                     including the git last-commit date (the honest
 *                     last_updated) and which keys are missing. Feed the
 *                     `needs_description` set to GPT to author descriptions.
 *   --apply <file>    Apply frontmatter. <file> is JSON: { "<relpath>": "<description>" }.
 *                     For each missing doc it inserts only the keys that are
 *                     absent: `last_updated` is computed from git; `description`
 *                     comes from the JSON (required only for docs that lack one).
 *                     Idempotent — a doc that already has both keys is skipped.
 *
 * last_updated = date of the last git commit touching the file (`%ad`,
 * --date=short). That reflects when the CONTENT last changed, which is what the
 * periodic-audit staleness check wants — NOT the day we added frontmatter.
 *
 * Run via:
 *   npx tsx scripts/doc-frontmatter-backfill.ts --list > /tmp/missing.json
 *   npx tsx scripts/doc-frontmatter-backfill.ts --apply /tmp/descriptions.json
 */
import { lstatSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gitCapture } from './lib/git-exec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

const REQUIRED_KEYS = ['description', 'last_updated'] as const;
type Key = (typeof REQUIRED_KEYS)[number];

interface DocInfo {
  path: string;
  last_updated: string;
  missing: Key[];
  has_block: boolean;
}

function trackedDocs(): string[] {
  return gitCapture(['ls-files', 'docs/project/**/*.md', 'docs/project/*.md'], { cwd: repoRoot })
    .split('\n')
    .map((l: string) => l.trim())
    .filter(Boolean)
    // Skip symlinks (e.g. MCP_UPDATE_LIFECYCLE.md → MCP_UPDATE_PROPAGATION.md):
    // writing through one would double-insert into the shared target. The target
    // itself is listed separately and handled on its own.
    .filter((rel: string) => !lstatSync(join(repoRoot, rel)).isSymbolicLink());
}

function gitLastUpdated(relPath: string): string {
  try {
    const d = gitCapture(['log', '-1', '--format=%ad', '--date=short', '--', relPath], { cwd: repoRoot }).trim();
    return d || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Returns the frontmatter block lines (between the fences) or null if no block. */
function frontmatterBlock(text: string): string | null {
  if (!text.startsWith('---')) return null;
  const rest = text.slice(text.indexOf('\n') + 1);
  const end = rest.indexOf('\n---');
  if (end === -1) return null;
  return rest.slice(0, end);
}

function missingKeys(text: string): Key[] {
  const block = frontmatterBlock(text);
  if (block === null) return [...REQUIRED_KEYS];
  return REQUIRED_KEYS.filter((k) => !new RegExp(`^\\s*${k}\\s*:`, 'm').test(block));
}

function analyze(): DocInfo[] {
  const out: DocInfo[] = [];
  for (const rel of trackedDocs()) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const missing = missingKeys(text);
    if (missing.length === 0) continue;
    out.push({
      path: rel,
      last_updated: gitLastUpdated(rel),
      missing,
      has_block: frontmatterBlock(text) !== null,
    });
  }
  return out;
}

/** YAML double-quoted scalar. */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function applyOne(rel: string, description: string | undefined, missing: Key[], lastUpdated: string): string {
  const abs = join(repoRoot, rel);
  const text = readFileSync(abs, 'utf8');
  const lines: string[] = [];
  if (missing.includes('description')) {
    if (!description) throw new Error(`no description provided for ${rel} (and file lacks one)`);
    lines.push(`description: ${yamlString(description)}`);
  }
  if (missing.includes('last_updated')) {
    lines.push(`last_updated: ${yamlString(lastUpdated)}`);
  }
  let next: string;
  const block = frontmatterBlock(text);
  if (block === null) {
    // No block — prepend a fresh one.
    next = `---\n${lines.join('\n')}\n---\n\n${text}`;
  } else {
    // Has a block — insert the missing keys right after the opening fence.
    const nl = text.indexOf('\n');
    next = `---\n${lines.join('\n')}\n${text.slice(nl + 1)}`;
  }
  writeFileSync(abs, next);
  return rel;
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const docs = analyze();
    const needsDescription = docs.filter((d) => d.missing.includes('description')).map((d) => d.path);
    process.stdout.write(
      JSON.stringify({ total_missing: docs.length, needs_description: needsDescription, docs }, null, 2) + '\n',
    );
    return;
  }

  const applyIdx = args.indexOf('--apply');
  if (applyIdx !== -1) {
    const jsonPath = args[applyIdx + 1];
    if (!jsonPath) throw new Error('--apply requires a path to a descriptions JSON file');
    const descriptions: Record<string, string> = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const docs = analyze();
    let applied = 0;
    const skipped: string[] = [];
    for (const d of docs) {
      try {
        applyOne(d.path, descriptions[d.path], d.missing, d.last_updated);
        applied++;
      } catch (e) {
        skipped.push(`${d.path}: ${(e as Error).message}`);
      }
    }
    console.log(`✅ Applied frontmatter to ${applied} doc(s).`);
    if (skipped.length) {
      console.log(`⏭️  Skipped ${skipped.length} (no description available):`);
      for (const s of skipped) console.log(`   - ${s}`);
    }
    return;
  }

  console.error('Usage: --list | --apply <descriptions.json>');
  process.exit(2);
}

main();
