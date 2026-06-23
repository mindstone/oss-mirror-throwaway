#!/usr/bin/env npx tsx
/**
 * CI Validation: Active-Work Blur Budget
 *
 * Stage 3 of `docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md`
 * promotes blur radius to a runtime quality knob driven by
 * `body[data-active-work='true']`. Every glass surface that wants to
 * participate in the budget MUST bind its `backdrop-filter: blur(...)` to
 * `var(--glass-panel-blur)` or `var(--glass-overlay-blur)`. Hardcoded
 * `blur(<literal>px)` declarations escape the budget and re-introduce the
 * AGXMetal raster fan-out under streaming.
 *
 * This script flags any `backdrop-filter: blur(<literal>px)` (or the
 * `-webkit-backdrop-filter` sibling, or `backdropFilter: 'blur(<literal>px)'`
 * inline in TSX) that does not reference one of the budget tokens.
 *
 * Escape hatch: declarations that legitimately need a literal radius
 * (e.g. boot splash that renders before the renderer attaches the
 * data-active-work attribute, or a modal overlay where blur IS the
 * foreground content effect) MUST carry an inline comment containing
 * `blur-budget-exempt:` followed by a one-sentence rationale on the same
 * line as the declaration, or anywhere in the three lines immediately
 * preceding it (so a single comment can cover a paired
 * `backdrop-filter` / `-webkit-backdrop-filter` declaration).
 *
 * Run: npx tsx scripts/check-blur-budget.ts
 * Wired into: npm run validate:fast
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(REPO_ROOT, 'src', 'renderer');

const SCAN_EXTENSIONS = new Set(['.css', '.html', '.tsx', '.ts']);
const SKIP_DIRECTORIES = new Set(['node_modules', '__tests__', 'dist', 'out', 'release']);

const EXEMPT_MARKER = 'blur-budget-exempt:';

const BACKDROP_LITERAL_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:-webkit-)?backdrop-filter\s*:\s*[^;]*\bblur\(\s*[\d.]+\s*(?:px|rem|em|%)?\s*\)/g,
  /backdropFilter\s*:\s*['"][^'"]*\bblur\(\s*[\d.]+\s*(?:px|rem|em|%)?\s*\)[^'"]*['"]/g,
];

export interface Finding {
  file: string;
  line: number;
  text: string;
}

function scanFile(filePath: string, rootDir: string, findings: Finding[]): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (const pattern of BACKDROP_LITERAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const offset = match.index;
      const lineNumber = content.slice(0, offset).split('\n').length;
      const lineText = lines[lineNumber - 1] ?? '';
      const PRECEDING_LINES_TO_CHECK = 3;
      const lookbackStart = Math.max(0, lineNumber - 1 - PRECEDING_LINES_TO_CHECK);
      const lookback = lines.slice(lookbackStart, lineNumber - 1);

      if (lineText.includes(EXEMPT_MARKER) || lookback.some((l) => l.includes(EXEMPT_MARKER))) {
        continue;
      }

      findings.push({
        file: path.relative(rootDir, filePath),
        line: lineNumber,
        text: lineText.trim(),
      });
    }
  }
}

function walk(dir: string, rootDir: string, findings: Finding[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, rootDir, findings);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
    scanFile(full, rootDir, findings);
  }
}

/** Programmatic API: walks `rootDir` and returns all findings.
 * Used by `scripts/__tests__/check-blur-budget.test.ts` to drive the validator
 * against fixture directories without invoking the CLI process boundary. */
export function walkBlurBudget(rootDir: string): Finding[] {
  const findings: Finding[] = [];
  walk(rootDir, rootDir, findings);
  return findings;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(__filename);
}

if (isMain()) {
  console.log('Checking active-work blur budget compliance...\n');

  const findings = walkBlurBudget(RENDERER_DIR);

  if (findings.length === 0) {
    console.log('PASSED: No hardcoded backdrop-filter: blur() declarations escape the budget.');
    process.exit(0);
  }

  console.error(
    `FAILED: ${findings.length} hardcoded backdrop-filter blur declaration(s) escape the active-work budget.\n`,
  );
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}`);
    console.error(`    ${finding.text}`);
  }
  console.error(
    '\nFix: rebind to `var(--glass-panel-blur)` or `var(--glass-overlay-blur)` so the\n'
    + 'declaration participates in the active-work budget. If the literal radius is\n'
    + 'genuinely intentional (e.g. boot splash, foreground modal effect), add an inline\n'
    + 'comment with `blur-budget-exempt: <reason>` on the same line as, or the line\n'
    + 'immediately preceding, the declaration.\n'
    + '\nSee Stage 3 of docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md.',
  );
  process.exit(1);
}
