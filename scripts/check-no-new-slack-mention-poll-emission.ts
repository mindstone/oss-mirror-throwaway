import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Violation = {
  file: string;
  line: number;
  text: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'cloud-service/src', 'mobile/src', 'packages'];
const EMISSION_PATTERN = /\bkind\s*:\s*['"]slack-mention-poll['"]/;
const COMPAT_MARKER = 'COMPAT: slack-mention-poll fallback';

function isTextFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);
}

function shouldSkip(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/');
  return (
    normalized.includes('/__tests__/') ||
    normalized.includes('.test.') ||
    normalized.includes('.spec.') ||
    normalized.endsWith('/scripts/check-no-new-slack-mention-poll-emission.ts')
  );
}

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(entryPath, files);
    } else if (entry.isFile() && isTextFile(entryPath) && !shouldSkip(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function hasCompatMarkerNearby(lines: string[], index: number): boolean {
  const start = Math.max(0, index - 3);
  const end = Math.min(lines.length - 1, index + 3);
  for (let i = start; i <= end; i += 1) {
    if (lines[i]?.includes(COMPAT_MARKER)) {
      return true;
    }
  }
  return false;
}

function scanFile(filePath: string): Violation[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const violations: Violation[] = [];
  lines.forEach((line, index) => {
    if (!EMISSION_PATTERN.test(line)) return;
    if (hasCompatMarkerNearby(lines, index)) return;
    violations.push({
      file: path.relative(ROOT, filePath),
      line: index + 1,
      text: line.trim(),
    });
  });
  return violations;
}

function main(): number {
  const violations = SCAN_DIRS
    .flatMap((dir) => walk(path.join(ROOT, dir)))
    .flatMap(scanFile);

  if (violations.length === 0) {
    return 0;
  }

  process.stderr.write('New slack-mention-poll context emissions are not allowed outside the compat shim.\n');
  for (const violation of violations) {
    process.stderr.write(`${violation.file}:${violation.line}: ${violation.text}\n`);
  }
  return 1;
}

process.exitCode = main();
