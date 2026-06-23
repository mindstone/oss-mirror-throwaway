import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PATTERN = /emitTranscriptSaved\(|emitTranscriptDistributionReady\(|deferTranscriptSaved\(/;
const SCAN_ROOT = path.join(REPO_ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out']);

const ALLOWED_PATH_SNIPPETS = [
  'src/core/meetingSource/',
  'src/main/services/meetingBot/transcriptEventBus.ts',
  '/__tests__/',
  '/__eslintViolationFixtures__/',
];

function normalisePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function isAllowedPath(filePath: string): boolean {
  const normalised = normalisePath(filePath);
  return ALLOWED_PATH_SNIPPETS.some((allowed) => normalised.includes(allowed));
}

interface Match {
  relativePath: string;
  line: number;
  text: string;
}

// BOUNDED-WALKER: Stays within REPO_ROOT/src/, skips node_modules/dist/build/out, no symlink follow.
function walkAndScan(rootDir: string, matches: Match[]): void {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Use lstat to avoid following symlinks back into the repo
      const stats = statSync(fullPath, { throwIfNoEntry: false });
      if (!stats || !stats.isDirectory()) continue;
      walkAndScan(fullPath, matches);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;

    const contents = readFileSync(fullPath, 'utf-8');
    if (!PATTERN.test(contents)) continue;

    const lines = contents.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (PATTERN.test(lines[i])) {
        matches.push({
          relativePath: path.relative(REPO_ROOT, fullPath),
          line: i + 1,
          text: lines[i].trim(),
        });
      }
    }
  }
}

function main(): void {
  const matches: Match[] = [];
  walkAndScan(SCAN_ROOT, matches);

  if (matches.length === 0) {
    process.stdout.write('No emit/defer calls found.\n');
    return;
  }

  const violations = matches.filter((m) => !isAllowedPath(m.relativePath));

  if (violations.length > 0) {
    const formatted = violations
      .map((v) => `${v.relativePath}:${v.line}:${v.text}`)
      .join('\n');
    process.stderr.write(`Forbidden emit/defer calls found:\n${formatted}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('All emit/defer calls are kernel-routed.\n');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to check emit/defer callers: ${message}\n`);
  process.exitCode = 1;
}
