#!/usr/bin/env -S npx tsx
/**
 * REBEL-1A9 Remediation Script
 * ----------------------------
 * One-shot audit of shared spaces for source-capture files that may have been
 * misrouted before the Chief-of-Staff-only gate landed. Scans every shared
 * space's `memory/sources/` folder, reads YAML frontmatter, and flags files
 * that look sensitive (meetings of any kind, small/1:1-shaped meetings,
 * sensitive title patterns).
 *
 * Standalone script — no imports from src/main/ or src/renderer/ so it stays
 * free of Electron dependencies. Uses node built-ins only. Matches the flat
 * key/value frontmatter shape with lightweight regex (same approach as
 * `src/renderer/features/inbox/utils/extractSourceMetadata.ts`).
 *
 * Usage:
 *   npx tsx scripts/remediate-shared-space-sources.ts <workspace-path>
 *   npx tsx scripts/remediate-shared-space-sources.ts <workspace-path> --move
 *
 * Dry-run is the default. `--move` relocates flagged files to
 * `<workspace>/Chief-of-Staff/memory/sources/` preserving the
 * `YYYY/MM-MMM/DD/file.md` sub-path.
 *
 * Exit codes:
 *   0  No flagged files found, or --move completed without failures
 *   1  Flagged files found (dry-run) OR one or more moves failed
 *
 * Context: see `docs/plans/260418_source_capture_chief_of_staff_only.md` (Stage 5)
 * and `docs-private/postmortems/260409_source_capture_sensitive_meeting_routing_postmortem.md`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

interface ParsedFrontmatter {
  sourceType?: string;
  description?: string;
  participants?: string[];
  occurredAt?: string;
}

type FlagReason = 'meeting-in-shared-space' | 'small-meeting' | 'sensitive-title';

interface SensitivityFlag {
  reason: FlagReason;
  detail: string;
}

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  spaceRelativePath: string;
  frontmatter: ParsedFrontmatter;
  flags: SensitivityFlag[];
}

// ============================================================================
// Constants
// ============================================================================

const COS_DIR_NAME_LOWER = 'chief-of-staff';
const COS_DEFAULT_DIR_NAME = 'Chief-of-Staff';
const SMALL_MEETING_PARTICIPANT_THRESHOLD = 3;
const MAX_SCAN_DEPTH = 3; // covers work/{Company}/{Team}

/**
 * Root-level directory names to skip when discovering spaces. Covers common
 * system directories (`node_modules`) and Rebel-bundled submodules
 * (`rebel-system`, `super-mcp`). Hidden directories (starting with `.`) are
 * skipped at every depth.
 */
const SKIP_ROOT_DIRS = new Set<string>([
  'node_modules',
  'rebel-system',
  'super-mcp',
  'coding-agent-instructions',
  '_archived-spaces',
]);

/**
 * Sensitive title patterns. Each entry uses a regex tuned to minimise false
 * positives (word boundaries for short tokens like PIP/HR to avoid matching
 * "pipeline" or "hr*" substrings). Matched against both the filename and the
 * frontmatter `description` field.
 */
const SENSITIVE_PATTERNS: Array<{ label: string; match: RegExp }> = [
  { label: '1:1', match: /1:1|\b1[-_ ]?on[-_ ]?1s?\b/i },
  { label: 'performance', match: /\bperformance\s+(review|feedback|concerns|improvement|plan|rating|evaluation)\b/i },
  { label: 'PIP', match: /\bPIP\b/i },
  { label: 'HR', match: /\bHR\b/i },
  { label: 'salary', match: /\bsalary\b/i },
  { label: 'compensation', match: /\bcompensation\b/i },
  { label: 'review', match: /\b(performance|annual|mid[- ]?year|year[- ]?end|compensation|comp|salary|promo|promotion|360)[- ]review\b/i },
  { label: 'disciplinary', match: /\bdisciplinary\b/i },
  { label: 'feedback', match: /\b(performance|negative|constructive|360)\s+feedback\b/i },
];

// ============================================================================
// Argument parsing
// ============================================================================

interface CliArgs {
  workspacePath: string;
  move: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let workspacePath: string | undefined;
  let move = false;

  for (const arg of args) {
    if (arg === '--move') {
      move = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`);
      printUsage();
      process.exit(1);
    } else if (!workspacePath) {
      workspacePath = arg;
    } else {
      console.error(`Unexpected positional argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!workspacePath) {
    console.error('Error: workspace path is required\n');
    printUsage();
    process.exit(1);
  }

  return {
    workspacePath: path.resolve(workspacePath),
    move,
  };
}

function printUsage(): void {
  console.error(
    [
      'Usage: npx tsx scripts/remediate-shared-space-sources.ts <workspace-path> [--move]',
      '',
      'Scans shared spaces for source files that may have been misrouted (REBEL-1A9).',
      'Flags meetings, small participant counts, and sensitive title patterns.',
      '',
      'Arguments:',
      '  <workspace-path>  Absolute path to the Rebel workspace (coreDirectory)',
      '',
      'Options:',
      '  --move            Move flagged files to Chief-of-Staff/memory/sources/',
      '                    (default: dry-run — report only, no changes)',
      '  --help, -h        Show this help text',
      '',
      'Exit codes:',
      '  0  No flagged files found, or --move completed without failures',
      '  1  Flagged files found (dry-run) or one or more moves failed',
    ].join('\n'),
  );
}

// ============================================================================
// Frontmatter parsing (regex-based, no YAML parser dependency)
// Mirrors the approach in src/renderer/features/inbox/utils/extractSourceMetadata.ts
// ============================================================================

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content) return {};

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return {};
  const body = match[1];

  return {
    sourceType: readScalarField(body, 'source_type'),
    description: readScalarField(body, 'description'),
    participants: readListField(body, 'participants'),
    occurredAt: readScalarField(body, 'occurred_at'),
  };
}

function readScalarField(body: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm');
  const m = body.match(re);
  if (!m) return undefined;
  const raw = m[1].trim().replace(/^['"]|['"]$/g, '').trim();
  return raw || undefined;
}

function readListField(body: string, key: string): string[] | undefined {
  // Inline form: key: [a, b, c]
  const inlineRe = new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\]$`, 'm');
  const inline = body.match(inlineRe);
  if (inline) {
    const items = inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  // Block form:
  // key:
  //   - a
  //   - b
  const blockRe = new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+-[ \\t]*.+\\n?)+)`, 'm');
  const block = body.match(blockRe);
  if (block) {
    const items = block[1]
      .split('\n')
      .map((line) => line.replace(/^[ \t]+-[ \t]*/, '').trim())
      .map((s) => s.replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}

// ============================================================================
// Space discovery
// ============================================================================

/**
 * Walks the workspace and returns the absolute path of every shared-space
 * `memory/sources/` directory. A directory is considered a space when it
 * contains a `memory/sources/` subdirectory. Chief-of-Staff is excluded.
 */
function findSharedSpaceSourceDirs(workspacePath: string): { dirs: string[]; depthCapHits: string[] } {
  const results: string[] = [];
  const depthCapHits: string[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > MAX_SCAN_DEPTH) {
      depthCapHits.push(path.relative(workspacePath, dir) || dir);
      return;
    }

    // At depth >= 1, check whether this dir is itself a space.
    // (The workspace root itself is never a space.)
    if (depth >= 1 && hasSourcesSubdir(dir)) {
      const dirName = path.basename(dir);
      if (dirName.toLowerCase() !== COS_DIR_NAME_LOWER) {
        results.push(path.join(dir, 'memory', 'sources'));
      }
      return; // stop descent once we've identified a space
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (depth === 0 && SKIP_ROOT_DIRS.has(entry.name.toLowerCase())) continue;
      if (entry.name.toLowerCase() === COS_DIR_NAME_LOWER) continue;

      const childPath = path.join(dir, entry.name);

      // Only descend into directories. For symlinks, verify they resolve to
      // directories (via fs.statSync which follows symlinks).
      if (entry.isDirectory()) {
        scan(childPath, depth + 1);
      } else if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(childPath);
          if (stat.isDirectory()) scan(childPath, depth + 1);
        } catch {
          // broken symlink — skip
        }
      }
    }
  }

  scan(workspacePath, 0);
  return { dirs: results, depthCapHits };
}

function hasSourcesSubdir(dir: string): boolean {
  const sourcesPath = path.join(dir, 'memory', 'sources');
  try {
    return fs.statSync(sourcesPath).isDirectory();
  } catch {
    return false;
  }
}

// ============================================================================
// Source-file walking
// ============================================================================

/** Recursively collect all `.md` files beneath a `memory/sources/` root. */
function walkSourceFiles(sourcesDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  walk(sourcesDir);
  return files;
}

// ============================================================================
// Sensitivity classification
// ============================================================================

function classifyFile(frontmatter: ParsedFrontmatter, fileName: string): SensitivityFlag[] {
  const flags: SensitivityFlag[] = [];

  const sourceType = frontmatter.sourceType?.toLowerCase();
  const isMeeting = sourceType === 'meeting';

  if (isMeeting) {
    flags.push({
      reason: 'meeting-in-shared-space',
      detail: 'All meeting sources must route to Chief-of-Staff (source capture policy)',
    });

    if (frontmatter.participants) {
      const count = frontmatter.participants.length;
      if (count > 0 && count <= SMALL_MEETING_PARTICIPANT_THRESHOLD) {
        flags.push({
          reason: 'small-meeting',
          detail: `Meeting has ${count} participant${count === 1 ? '' : 's'} — likely private`,
        });
      }
    }
  }

  const matched = new Set<string>();
  const candidates = [fileName, frontmatter.description ?? ''].filter(Boolean);
  for (const pattern of SENSITIVE_PATTERNS) {
    if (candidates.some((text) => pattern.match.test(text))) {
      matched.add(pattern.label);
    }
  }
  if (matched.size > 0) {
    flags.push({
      reason: 'sensitive-title',
      detail: `Matches sensitive patterns: ${Array.from(matched).join(', ')}`,
    });
  }

  return flags;
}

// ============================================================================
// Move to Chief-of-Staff
// ============================================================================

/**
 * Resolve the Chief-of-Staff directory name in the workspace, preferring the
 * case already on disk (`Chief-of-Staff` vs `chief-of-staff`). Falls back to
 * `Chief-of-Staff` when no such directory exists.
 */
function findCosDirName(workspacePath: string): { name: string; existed: boolean } {
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.toLowerCase() === COS_DIR_NAME_LOWER) {
        return { name: entry.name, existed: true };
      }
    }
  } catch {
    // fall through
  }
  return { name: COS_DEFAULT_DIR_NAME, existed: false };
}

interface MoveResult {
  moved: boolean;
  error?: string;
  targetPath?: string;
}

/**
 * Move a flagged source file into `<workspace>/<CoS>/memory/sources/`
 * preserving the `YYYY/MM-MMM/DD/file.md` sub-path. If a file already exists
 * at the target, appends a `.moved-N` suffix to avoid overwriting.
 */
function moveFileToCoS(file: SourceFile, workspacePath: string, cosDirName: string): MoveResult {
  const parts = file.absolutePath.split(path.sep);
  // Find the LAST `memory/sources/` segment — searching backwards avoids
  // misresolution when the workspace path itself contains `memory/sources/`.
  let sourcesIdx = -1;
  for (let i = parts.length - 1; i >= 1; i--) {
    if (parts[i] === 'sources' && parts[i - 1] === 'memory') {
      sourcesIdx = i;
      break;
    }
  }
  if (sourcesIdx === -1) {
    return { moved: false, error: 'Could not locate memory/sources/ segment in path' };
  }

  const relSubpath = parts.slice(sourcesIdx + 1).join(path.sep);
  const targetPath = path.join(workspacePath, cosDirName, 'memory', 'sources', relSubpath);

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    let finalTarget = targetPath;
    if (fs.existsSync(finalTarget)) {
      const ext = path.extname(targetPath);
      const base = ext ? targetPath.slice(0, -ext.length) : targetPath;
      let n = 1;
      while (fs.existsSync(`${base}.moved-${n}${ext}`)) n++;
      finalTarget = `${base}.moved-${n}${ext}`;
    }

    fs.renameSync(file.absolutePath, finalTarget);
    return { moved: true, targetPath: finalTarget };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { moved: false, error: msg };
  }
}

// ============================================================================
// Reporting helpers
// ============================================================================

function formatParticipants(participants: string[]): string {
  const preview = participants.slice(0, 4).join(', ');
  const suffix = participants.length > 4 ? ', …' : '';
  return `${participants.length} (${preview}${suffix})`;
}

// ============================================================================
// Main
// ============================================================================

function main(): number {
  const { workspacePath, move } = parseArgs(process.argv);

  if (!fs.existsSync(workspacePath)) {
    console.error(`Error: workspace path does not exist: ${workspacePath}`);
    return 1;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspacePath);
  } catch (err) {
    console.error(`Error: cannot stat workspace path: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!stat.isDirectory()) {
    console.error(`Error: workspace path is not a directory: ${workspacePath}`);
    return 1;
  }

  console.log('REBEL-1A9 Source Remediation');
  console.log('='.repeat(60));
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Mode:      ${move ? 'MOVE (files will be relocated)' : 'dry-run (report only)'}`);
  console.log('');

  // 1) Discover shared-space memory/sources/ directories
  const { dirs: sharedSourceDirs, depthCapHits } = findSharedSpaceSourceDirs(workspacePath);
  if (depthCapHits.length > 0) {
    console.log(`⚠ Scan depth cap (${MAX_SCAN_DEPTH}) reached under these directories — deeper spaces may be missed:`);
    for (const hit of depthCapHits) {
      console.log(`  • ${hit}`);
    }
    console.log('');
  }
  if (sharedSourceDirs.length === 0) {
    console.log('No shared-space memory/sources/ directories found.');
    console.log('✓ Nothing to remediate.');
    return 0;
  }

  console.log(
    `Found ${sharedSourceDirs.length} shared-space memory/sources/ director${
      sharedSourceDirs.length === 1 ? 'y' : 'ies'
    }:`,
  );
  for (const dir of sharedSourceDirs) {
    console.log(`  • ${path.relative(workspacePath, dir) || dir}`);
  }
  console.log('');

  // 2) Scan, parse, classify
  const flagged: SourceFile[] = [];
  let totalScanned = 0;
  let readErrors = 0;

  for (const sourcesDir of sharedSourceDirs) {
    const spaceRoot = path.dirname(path.dirname(sourcesDir));
    const spaceRel = path.relative(workspacePath, spaceRoot) || path.basename(spaceRoot);

    const files = walkSourceFiles(sourcesDir);
    totalScanned += files.length;

    for (const absPath of files) {
      let content = '';
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch {
        readErrors++;
        continue;
      }
      const fm = parseFrontmatter(content);
      const fileName = path.basename(absPath);
      const flags = classifyFile(fm, fileName);
      if (flags.length === 0) continue;

      flagged.push({
        absolutePath: absPath,
        relativePath: path.relative(workspacePath, absPath),
        spaceRelativePath: spaceRel,
        frontmatter: fm,
        flags,
      });
    }
  }

  console.log(`Total source files in shared spaces: ${totalScanned}`);
  console.log(`Flagged as potentially sensitive:    ${flagged.length}`);
  if (readErrors > 0) console.log(`Read errors:                         ${readErrors}`);
  console.log('');

  if (flagged.length === 0) {
    console.log('✓ No flagged files — nothing to remediate.');
    return 0;
  }

  // 3) Breakdown by flag reason (a file may carry multiple flags)
  const breakdown = new Map<FlagReason, number>();
  for (const file of flagged) {
    for (const f of file.flags) {
      breakdown.set(f.reason, (breakdown.get(f.reason) ?? 0) + 1);
    }
  }
  console.log('Flag breakdown (counts may exceed flagged files — a file can carry multiple flags):');
  for (const [reason, count] of breakdown.entries()) {
    console.log(`  ${reason.padEnd(30)} ${count}`);
  }
  console.log('');

  // 4) Per-file detail
  console.log('Flagged files:');
  console.log('-'.repeat(60));
  for (const file of flagged) {
    console.log(`  ${file.relativePath}`);
    console.log(`    Space:         ${file.spaceRelativePath}`);
    console.log(`    Type:          ${file.frontmatter.sourceType ?? '(missing)'}`);
    console.log(`    Description:   ${file.frontmatter.description ?? '(missing)'}`);
    console.log(
      `    Participants:  ${
        file.frontmatter.participants ? formatParticipants(file.frontmatter.participants) : '(missing)'
      }`,
    );
    console.log(`    Occurred at:   ${file.frontmatter.occurredAt ?? '(missing)'}`);
    for (const flag of file.flags) {
      console.log(`    ⚠ [${flag.reason}] ${flag.detail}`);
    }
    console.log('');
  }

  // 5) Dry-run: stop here, exit 1
  if (!move) {
    console.log('This was a dry-run — no files were moved.');
    console.log('To relocate flagged files to Chief-of-Staff, rerun with --move:');
    console.log(`  npx tsx scripts/remediate-shared-space-sources.ts "${workspacePath}" --move`);
    return 1;
  }

  // 6) Move mode
  const cos = findCosDirName(workspacePath);
  console.log(`Chief-of-Staff directory: ${cos.name}${cos.existed ? '' : ' (will be created)'}`);
  console.log('Moving flagged files…');
  console.log('-'.repeat(60));

  let moved = 0;
  let failed = 0;
  for (const file of flagged) {
    const result = moveFileToCoS(file, workspacePath, cos.name);
    if (result.moved) {
      moved++;
      const relTarget = result.targetPath
        ? path.relative(workspacePath, result.targetPath)
        : '(unknown)';
      console.log(`  ✓ Moved: ${file.relativePath}`);
      console.log(`      → ${relTarget}`);
    } else {
      failed++;
      console.log(`  ✗ Failed: ${file.relativePath}`);
      console.log(`      Error: ${result.error ?? 'unknown'}`);
    }
  }
  console.log('');
  console.log(`Moved: ${moved} / Failed: ${failed} / Total flagged: ${flagged.length}`);

  return failed > 0 ? 1 : 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error('Fatal error:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
