#!/usr/bin/env npx tsx
/**
 * Recs hot-list generator — demand-driven triage signal from pathologist runs.
 *
 * Stage 3 of docs/plans/260611_recs-triage-system: new postmortem augment
 * lines may carry an optional `prior_recommendation_fingerprints` array (16
 * lowercase-hex tracker fingerprints, see
 * scripts/postmortem-recommendations-tracker.ts `fingerprintOf` and
 * coding-agent-instructions/scripts/chief_pathologist_v2/augment_vocab.py).
 * Each chief-pathologist run ingests those into
 * `data/augmentations.ndjson` (per-bug rows) and aggregates them per bucket
 * into `data/qa13_prior_recommendations.ndjson` (`implicated_fingerprints`).
 *
 * This script reads the NEWEST run under the shared-drive reports root and
 * emits the "hot list": recommendation fingerprints implicated in recent
 * bugs, with the bug ids and dates that implicated them. The shortlist
 * generator (Stage 4) puts these first.
 *
 * Forward-only by design: old augment lines lack the field, so early runs
 * legitimately produce an EMPTY hot-list. Every missing layer (root dir, run
 * dir, ndjson file, field) degrades to an empty list with a clear message and
 * exit 0 — absence of signal is not an error.
 *
 * Output: docs-private/postmortems/_recs_hotlist.generated.json (gitignored,
 * same convention as _index_recommendations.generated.yaml).
 *
 * Run: npx tsx scripts/recs-hotlist.ts
 *      npx tsx scripts/recs-hotlist.ts --reports-root /path/to/reports --out /tmp/hotlist.json
 * Env: RECS_HOTLIST_REPORTS_ROOT overrides the default reports root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_REPORTS_ROOT =
  '/Users/you/Library/CloudStorage/[Mindstone-email]/'
  + 'Shared drives/Product/droid-pathologist-reports';

export const DEFAULT_OUT_PATH = path.join(
  __dirname,
  '..',
  'docs-private',
  'postmortems',
  '_recs_hotlist.generated.json',
);

// Matches v3 run folders: "260610_2214_chief_pathologist_7d". The
// YYMMDD_HHMM prefix makes plain name-sort chronological.
const RUN_DIR_RE = /^\d{6}_\d{4}_chief_pathologist_.+$/;

// Mirrors augment_vocab.RECOMMENDATION_FINGERPRINT_RE — first 16 hex chars
// of sha256(bug_id + action_type + description), lowercase by construction.
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

const FINGERPRINTS_FIELD = 'prior_recommendation_fingerprints';

export interface HotlistBugRef {
  bug_id: string;
  /** ISO date derived from the bug_id's YYMMDD prefix; null if unparsable. */
  date: string | null;
}

export interface HotlistEntry {
  fingerprint: string;
  n_bugs: number;
  bugs: HotlistBugRef[];
}

export interface HotlistPayload {
  generated_at: string;
  reports_root: string;
  /** Basename of the run folder the hot-list was built from; null when none found. */
  run_dir: string | null;
  n_fingerprints: number;
  message: string;
  hotlist: HotlistEntry[];
}

/** Newest pathologist run dir under `root` by name-sort; null when absent. */
export function findNewestRunDir(root: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const runs = names
    .filter((name) => RUN_DIR_RE.test(name))
    .filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  if (runs.length === 0) return null;
  return path.join(root, runs[runs.length - 1]);
}

function readNdjson(filePath: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Tolerant by design: a malformed line in a generated artifact must
      // not kill the whole hot-list. The pathologist's own validators flag
      // corruption at the source.
    }
  }
  return rows;
}

function cleanFingerprints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && FINGERPRINT_RE.test(item),
  );
}

function bugDateFromId(bugId: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(bugId);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `20${yy}-${mm}-${dd}`;
}

/**
 * Build hot-list entries from a run dir's data files.
 *
 * Primary source: data/augmentations.ndjson (per-bug rows carry the bug ids
 * and dates). Secondary: data/qa13_prior_recommendations.ndjson — its
 * bucket-level `implicated_fingerprints` union backstops fingerprints whose
 * augment rows are missing (entry emitted with an empty bugs list).
 */
export function buildHotlist(runDir: string): HotlistEntry[] {
  const dataDir = path.join(runDir, 'data');
  const bugsByFingerprint = new Map<string, Set<string>>();

  for (const row of readNdjson(path.join(dataDir, 'augmentations.ndjson'))) {
    const bugId = row['bug_id'];
    if (typeof bugId !== 'string' || !bugId) continue;
    for (const fingerprint of cleanFingerprints(row[FINGERPRINTS_FIELD])) {
      let bugs = bugsByFingerprint.get(fingerprint);
      if (!bugs) {
        bugs = new Set<string>();
        bugsByFingerprint.set(fingerprint, bugs);
      }
      bugs.add(bugId);
    }
  }

  for (const row of readNdjson(
    path.join(dataDir, 'qa13_prior_recommendations.ndjson'),
  )) {
    for (const fingerprint of cleanFingerprints(row['implicated_fingerprints'])) {
      if (!bugsByFingerprint.has(fingerprint)) {
        bugsByFingerprint.set(fingerprint, new Set<string>());
      }
    }
  }

  const entries: HotlistEntry[] = [];
  for (const [fingerprint, bugIds] of bugsByFingerprint) {
    const bugs = [...bugIds]
      .sort()
      .map((bugId): HotlistBugRef => ({ bug_id: bugId, date: bugDateFromId(bugId) }));
    entries.push({ fingerprint, n_bugs: bugs.length, bugs });
  }
  entries.sort(
    (a, b) => b.n_bugs - a.n_bugs || a.fingerprint.localeCompare(b.fingerprint),
  );
  return entries;
}

export interface RunOptions {
  reportsRoot?: string;
  outPath?: string;
}

export function runRecsHotlist(options: RunOptions = {}): HotlistPayload {
  const reportsRoot =
    options.reportsRoot
    ?? process.env.RECS_HOTLIST_REPORTS_ROOT
    ?? DEFAULT_REPORTS_ROOT;
  const outPath = options.outPath ?? DEFAULT_OUT_PATH;

  const runDir = findNewestRunDir(reportsRoot);
  let hotlist: HotlistEntry[] = [];
  let message: string;
  if (runDir === null) {
    message =
      `No pathologist run dirs found under ${reportsRoot} — emitting an `
      + 'empty hot-list. (Not an error: check the reports root / Drive mount.)';
  } else {
    hotlist = buildHotlist(runDir);
    message =
      hotlist.length === 0
        ? `Run ${path.basename(runDir)} carries no ${FINGERPRINTS_FIELD} data — `
          + 'emitting an empty hot-list. (Expected for runs over augment lines '
          + 'that predate the field; the join is forward-only.)'
        : `Hot-list built from ${path.basename(runDir)}: ${hotlist.length} `
          + 'implicated recommendation fingerprint(s).';
  }

  const payload: HotlistPayload = {
    generated_at: new Date().toISOString(),
    reports_root: reportsRoot,
    run_dir: runDir === null ? null : path.basename(runDir),
    n_fingerprints: hotlist.length,
    message,
    hotlist,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function parseArgs(argv: string[]): RunOptions {
  const options: RunOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reports-root' && argv[i + 1]) {
      options.reportsRoot = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--out' && argv[i + 1]) {
      options.outPath = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(__filename);
}

if (isMain()) {
  const options = parseArgs(process.argv.slice(2));
  const payload = runRecsHotlist(options);
  console.log(payload.message);
  console.log(`Wrote ${options.outPath ?? DEFAULT_OUT_PATH}`);
  process.exit(0);
}
