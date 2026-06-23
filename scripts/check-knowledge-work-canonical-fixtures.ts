#!/usr/bin/env npx tsx
/**
 * CI Validation: Knowledge-work canonical-fixture attestation gate.
 *
 * Enforces that every fixture in `evals/fixtures/knowledge-work-reproducible/`
 * that participates in the canonical corpus (i.e. is neither `defaultDisabled`
 * nor `calibration`) carries a `canonicalSince: YYYY-MM-DD` attestation field.
 *
 * Why: the analyzer's Model Performance chart goes empty whenever a new
 * canonical fixture is added without backfilling existing variants (see
 * docs/plans/260518_kw_eval_canonical_drift_and_rerun_cells.md for the
 * 2026-05-15 and 2026-05-18 incidents). This gate forces an explicit
 * affirmation that the author considered backfill before flipping a
 * fixture into the canonical set: either keep `defaultDisabled: true`
 * (and the fixture stays out of the canonical chart), or remove it and
 * add `canonicalSince` in the same commit (signalling backfill is done).
 *
 * The gate is a forcing function, not a proof of correctness. It cannot
 * detect a fixture promoted with `canonicalSince` set but no actual
 * backfill against existing variants. That mitigation is structural —
 * the analyzer's partial-coverage table will immediately reveal an
 * un-backfilled promotion on the next analyzer run, and the author will
 * see Model Performance empty when they look at the report.
 *
 * Hard rules (mirroring evals/knowledge-work-canonical-corpus.ts):
 *   - Recursive walk; ignores `_`-prefixed files (matches loader).
 *   - Canonical = has runner-shape (`prompt` OR valid `turns[]`),
 *     has non-empty trimmed `id`, AND `defaultDisabled !== true`,
 *     AND `calibration !== true`.
 *   - Malformed JSON in the canonical tree FAILS the gate (does not
 *     silently skip). The loader warns and skips; the gate must be
 *     stricter so a malformed canonical fixture cannot drift unnoticed.
 *
 * Strict `canonicalSince` format:
 *   - Matches `/^\d{4}-\d{2}-\d{2}$/`.
 *   - Round-trips through `new Date(input).toISOString().slice(0,10)`.
 *   - Cannot be more than 24h in the future of "now" (clock-skew grace).
 *
 * Run: npx tsx scripts/check-knowledge-work-canonical-fixtures.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260518_kw_eval_canonical_drift_and_rerun_cells.md
 * @see evals/knowledge-work-canonical-corpus.ts
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'evals', 'fixtures', 'knowledge-work-reproducible');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface FixtureCheckIssue {
  path: string;
  reason: string;
}

export interface CheckResult {
  exitCode: 0 | 1;
  message: string;
  issues: FixtureCheckIssue[];
  scanned: number;
  canonical: number;
}

interface FixtureLike {
  id?: unknown;
  prompt?: unknown;
  turns?: unknown;
  defaultDisabled?: unknown;
  calibration?: unknown;
  canonicalSince?: unknown;
}

type DateCheck = { ok: true } | { ok: false; reason: string };

function checkCanonicalSinceShape(value: unknown, nowMs: number): DateCheck {
  if (typeof value !== 'string') {
    return { ok: false, reason: `canonicalSince must be a string (got ${typeof value})` };
  }
  if (!ISO_DATE_RE.test(value)) {
    return { ok: false, reason: `canonicalSince must match YYYY-MM-DD (got "${value}")` };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, reason: `canonicalSince is not a valid calendar date ("${value}")` };
  }
  if (parsed.toISOString().slice(0, 10) !== value) {
    return {
      ok: false,
      reason: `canonicalSince does not round-trip ("${value}" -> "${parsed.toISOString().slice(0, 10)}"); use a real calendar date`,
    };
  }
  if (parsed.getTime() > nowMs + FUTURE_GRACE_MS) {
    return { ok: false, reason: `canonicalSince is in the future ("${value}")` };
  }
  return { ok: true };
}

function hasRunnerFixtureShape(fixture: FixtureLike): boolean {
  const hasPrompt = typeof fixture.prompt === 'string' && fixture.prompt.length > 0;
  const hasTurns = Array.isArray(fixture.turns)
    && fixture.turns.length > 0
    && fixture.turns.every((turn) =>
      typeof turn === 'object'
      && turn !== null
      && 'prompt' in turn
      && typeof (turn as { prompt?: unknown }).prompt === 'string'
    );
  return hasPrompt || hasTurns;
}

function collectFixtureFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function checkCanonicalFixtures(opts: {
  fixturesDir?: string;
  now?: number;
} = {}): CheckResult {
  const fixturesDir = opts.fixturesDir ?? FIXTURES_DIR;
  const nowMs = opts.now ?? Date.now();
  const issues: FixtureCheckIssue[] = [];
  let scanned = 0;
  let canonical = 0;

  let files: string[];
  try {
    files = collectFixtureFiles(fixturesDir);
  } catch (error) {
    return {
      exitCode: 1,
      message:
        `[canonical-fixtures] FAIL — cannot read fixtures directory "${fixturesDir}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
      issues: [],
      scanned: 0,
      canonical: 0,
    };
  }

  for (const filePath of files) {
    scanned++;
    const rel = path.relative(fixturesDir, filePath);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      issues.push({
        path: rel,
        reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    let fixture: FixtureLike;
    try {
      fixture = JSON.parse(raw) as FixtureLike;
    } catch (error) {
      issues.push({
        path: rel,
        reason: `malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const id = typeof fixture.id === 'string' ? fixture.id.trim() : '';
    if (!id) continue;
    if (!hasRunnerFixtureShape(fixture)) continue;

    if (fixture.defaultDisabled === true) continue;
    if (fixture.calibration === true) continue;

    canonical++;

    if (!('canonicalSince' in fixture) || fixture.canonicalSince === undefined || fixture.canonicalSince === null) {
      issues.push({
        path: rel,
        reason:
          'missing canonicalSince. Either (a) add "defaultDisabled": true if this fixture is not yet ready to be canonical, ' +
          'OR (b) add "canonicalSince": "YYYY-MM-DD" with today\'s date AFTER backfilling existing model variants ' +
          '(several hours of eval runs). See docs/project/TESTING_EVALS_KNOWLEDGE_WORK.md#adding-a-canonical-fixture',
      });
      continue;
    }

    const dateCheck = checkCanonicalSinceShape(fixture.canonicalSince, nowMs);
    if (!dateCheck.ok) {
      issues.push({ path: rel, reason: dateCheck.reason });
      continue;
    }
  }

  if (issues.length === 0) {
    return {
      exitCode: 0,
      message: `[canonical-fixtures] OK — ${canonical}/${scanned} canonical fixtures attested.`,
      issues,
      scanned,
      canonical,
    };
  }

  return {
    exitCode: 1,
    message:
      `[canonical-fixtures] FAIL — ${issues.length} issue(s) across ${canonical} canonical / ${scanned} scanned.\n\n` +
      issues.map((i) => `  ${i.path}: ${i.reason}`).join('\n') +
      `\n\nSee docs/project/TESTING_EVALS_KNOWLEDGE_WORK.md#adding-a-canonical-fixture ` +
      `for the canonical-fixture promotion workflow.`,
    issues,
    scanned,
    canonical,
  };
}

const isCli = require.main === module
  || (typeof process !== 'undefined'
    && process.argv[1]
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename));
if (isCli) {
  const result = checkCanonicalFixtures();
  if (result.exitCode === 0) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  process.exit(result.exitCode);
}
