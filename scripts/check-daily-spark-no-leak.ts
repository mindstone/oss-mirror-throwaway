#!/usr/bin/env npx tsx
/**
 * CI Validation: Daily Spark No-Leak Guard
 *
 * Enforces the Daily Spark privacy invariant: spark `body` and
 * `captionOverride` text must never appear in logs, telemetry, or analytics
 * payloads. Format names, ids, counts, and timing are fine — spark text is
 * not.
 *
 * This guard scans the Daily Spark surfaces (core service, store, scheduler,
 * IPC handler, renderer hook, card component, slot wrapper, tracking
 * module) for two classes of regression:
 *
 *   1. Any `log.*` call that references `.body`, `.captionOverride`, or
 *      `sparkText`.
 *   2. Any `analytics.track` call inside `src/renderer/src/tracking.ts` that
 *      references the same identifiers.
 *
 * Run: npx tsx scripts/check-daily-spark-no-leak.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260512_daily_spark.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

const DAILY_SPARK_FILES: string[] = [
  'src/core/services/dailySparkService.ts',
  'src/core/services/dailySparkStore.ts',
  'src/main/services/dailySparkScheduler.ts',
  'src/main/ipc/dailySparkHandlers.ts',
  'src/renderer/features/homepage/hooks/useDailySpark.ts',
  'src/renderer/features/homepage/components/DailySparkCard.tsx',
  'src/renderer/features/homepage/components/DailySparkSlot.tsx',
];

const TRACKING_FILE = 'src/renderer/src/tracking.ts';

const LEAK_IDENT_PATTERN =
  '(?:\\.body\\b|\\bbody\\s*:\\s*[^,)}]+\\bspark|\\.captionOverride\\b|\\bsparkText\\b)';

interface RgMatch {
  file: string;
  line: number;
  text: string;
}

// Native Node grep — avoids requiring `rg` (ripgrep) to be installed on CI
// runners. Behaviour matches `rg --no-heading -n --with-filename`: one match
// per line, all lines that contain a match are emitted.
function rg(pattern: string, files: string[]): RgMatch[] {
  const regex = new RegExp(pattern);
  const matches: RgMatch[] = [];
  for (const file of files) {
    const abs = path.resolve(REPO_ROOT, file);
    let contents: string;
    try {
      contents = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') continue;
      throw err;
    }
    const lines = contents.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ file, line: i + 1, text: lines[i] });
      }
    }
  }
  return matches;
}

function rgPipe(pattern: string, files: string[], filterPattern: string): RgMatch[] {
  const candidates = rg(pattern, files);
  const filter = new RegExp(filterPattern);
  return candidates.filter((m) => filter.test(m.text));
}

const LOG_CALL_PATTERN = 'log\\.(info|warn|error|debug|fatal|trace)';
const TRACK_CALL_PATTERN = 'analytics\\.track';

let hasFailures = false;

console.log('Daily Spark no-leak guard — scanning for spark text in logs/telemetry...\n');

const logLeaks = rgPipe(LOG_CALL_PATTERN, DAILY_SPARK_FILES, LEAK_IDENT_PATTERN);
if (logLeaks.length > 0) {
  hasFailures = true;
  console.error('FAIL: Daily Spark log calls reference spark text:');
  for (const m of logLeaks) {
    console.error(`  ${m.file}:${m.line}: ${m.text.trim()}`);
  }
  console.error('');
}

const trackLeaks = rgPipe(TRACK_CALL_PATTERN, [TRACKING_FILE], LEAK_IDENT_PATTERN);
if (trackLeaks.length > 0) {
  hasFailures = true;
  console.error('FAIL: analytics.track calls in tracking.ts reference spark text:');
  for (const m of trackLeaks) {
    console.error(`  ${m.file}:${m.line}: ${m.text.trim()}`);
  }
  console.error('');
}

const trackDailySparkCalls = rg(
  "analytics\\.track\\('Daily Spark",
  [TRACKING_FILE],
);
for (const m of trackDailySparkCalls) {
  if (LEAK_IDENT_PATTERN && new RegExp(LEAK_IDENT_PATTERN).test(m.text)) {
    hasFailures = true;
    console.error('FAIL: Daily Spark analytics event carries spark text:');
    console.error(`  ${m.file}:${m.line}: ${m.text.trim()}`);
    console.error('');
  }
}

if (hasFailures) {
  console.error(
    'Daily Spark privacy invariant violated. Spark `body` and ' +
      '`captionOverride` text must never appear in logs, telemetry, or ' +
      'analytics payloads. Format names, ids, counts, and timing are fine.',
  );
  console.error('See docs/plans/260512_daily_spark.md for the full invariant.');
  process.exit(1);
}

console.log('PASS: Daily Spark surfaces leak no spark text into logs or telemetry.');
console.log(`Scanned ${DAILY_SPARK_FILES.length + 1} files.`);
