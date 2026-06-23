#!/usr/bin/env npx tsx
/**
 * WS0 stage-6 CI guard: no NEW duplicate provider/dialect inference from model-id
 * prefix outside the centralized classifier.
 *
 * Why: WS0 collapsed 4+ historical `inferProvider*` / `inferModelDialect` clones
 * onto ONE shared raw-syntax classifier (`src/shared/utils/modelIdClassifier.ts`)
 * plus the route-decision dialect inference (`providerRouteDecision.ts`). The
 * clone bug class — each call site re-deriving a provider/dialect by chaining
 * `model.includes('/')` / `startsWith('claude-')` / `startsWith('gpt-')` and
 * drifting apart — recurred repeatedly. This guard keeps the collapse intact: a
 * NEW file that chains the per-family bare-prefix arms (the clone's distinctive
 * `claude-` + `gpt-` co-occurrence) fails CI here.
 *
 * Mechanism (raw-text co-occurrence, mirroring
 * scripts/check-direct-anthropic-route-chokepoint.ts): a clone keys on BOTH the
 * `claude-` and `gpt-` bare prefixes (mapping each to a different provider).
 * Legitimate non-clone code keys on at most ONE of them — a claude-only gate, a
 * slash-form boolean, or a switch on the TARGET provider — so the co-occurrence
 * of both exact sniffs in one production file is high-signal with (proven) zero
 * false positives on the post-WS0 tree. The allowlist is MINIMAL: only the three
 * files that genuinely co-occur both sniffs today (the shared classifier, which
 * OWNS the inference, plus two files whose two sniffs sit in unrelated functions).
 * Every other file — including hot routing files like providerRouting.ts — is NOT
 * allowlisted, so a clone re-added there IS caught.
 *
 * The allowlist + sniff idioms live in scripts/model-id-clone-config.mjs (shared
 * with the self-test scripts/__tests__/check-model-id-inference-clone.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCAN_GLOBS,
  hasCloneSignature,
  isAllowlisted,
  isTestFile,
  normalizePathPosix,
} from './model-id-clone-config.mjs';

// The rarer of the two clone arms — seeding the candidate set on it keeps the
// list tiny; the authoritative decision is the shared `hasCloneSignature` (both
// arms required). Mirrors the `rg` regex this scan used before, in JS form.
const GPT_PREFIX_SNIFF = /\.startsWith\((['"])gpt-\1\)/u;

// Directory names never worth descending into for source candidates (keeps the
// native walk fast + matches what `rg --type ts` over `src`/`evals` effectively saw).
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'out', '.vite', 'release']);

// `rg --type ts` (the type set this scan used) matches *.ts, *.tsx, *.mts, *.cts —
// NOT just *.ts. Matching all four keeps coverage identical: a clone re-added in a
// `.tsx`/`.mts`/`.cts` source must still be caught.
const TS_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const isTsSource = (name: string): boolean =>
  TS_SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));

/**
 * Candidate set: files that contain a `gpt-` bare-prefix sniff (the rarer of the
 * two arms). We then re-read each and apply the full co-occurrence + allowlist +
 * test filters in JS.
 *
 * Implemented as a native Node walk (NOT `rg`): the dev-checks ubuntu runner does
 * NOT install ripgrep, and the previous `rg … || true` swallowed `rg: not found`
 * and returned an empty candidate set — a SILENT no-op that made this guard
 * (and its `main()` CLI) pass on a tree it never actually scanned. Same
 * rg-not-on-CI rationale as scripts/check-daily-spark-no-leak.ts. The negative-
 * control self-test caught this exact silent failure.
 */
function listCandidateFiles(repoRoot: string): string[] {
  const candidates: string[] = [];

  const walk = (absDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return; // a missing SCAN_GLOB root is "nothing to scan"
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !isTsSource(entry.name)) continue;
      let contents: string;
      try {
        contents = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') continue; // disappeared mid-walk (benign)
        throw err;
      }
      if (GPT_PREFIX_SNIFF.test(contents)) {
        candidates.push(normalizePathPosix(path.relative(repoRoot, abs)));
      }
    }
  };

  for (const glob of SCAN_GLOBS) {
    walk(path.join(repoRoot, glob));
  }
  return candidates;
}

/**
 * Pure, importable core of the guard: returns the posix-normalized relative paths
 * of every NON-test, NON-allowlisted source file that carries the two-arm clone
 * signature. Empty array == clean tree. Exported so the self-test can run the
 * real scan end-to-end (genuine green-on-tree + injected-clone negative control).
 */
export function findCloneViolations(repoRoot: string): string[] {
  const violations: string[] = [];
  for (const rel of listCandidateFiles(repoRoot)) {
    const normalized = normalizePathPosix(rel);
    if (isTestFile(normalized) || isAllowlisted(normalized)) continue;
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    if (hasCloneSignature(fs.readFileSync(abs, 'utf8'))) {
      violations.push(normalized);
    }
  }
  return violations;
}

function main(): void {
  const repoRoot = process.cwd();
  const violations = findCloneViolations(repoRoot);

  if (violations.length > 0) {
    console.error(
      `\n✗ check-model-id-inference-clone: found ${violations.length} file(s) that re-derive a ` +
        `provider/dialect by chaining the bare-prefix arms (\`startsWith('claude-')\` + ` +
        `\`startsWith('gpt-')\`) outside the centralized classifier:\n` +
        violations.map((v) => `  - ${v}`).join('\n') +
        `\n\nRoute this through the shared classifier (src/shared/utils/modelIdClassifier.ts) ` +
        `via one of its adapters (toProviderSwitchProvider / toActiveProviderForFallback / ` +
        `toModelDialect / toBillingFamily), or — if this is a genuinely new, intentionally ` +
        `divergent chokepoint/LEFT site — add it to MODEL_ID_CLONE_ALLOWLIST in ` +
        `scripts/model-id-clone-config.mjs WITH a divergence comment. Do NOT clone the inference.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-model-id-inference-clone: no duplicate provider/dialect inference clones ` +
      `(all chained-arm inference confined to the shared classifier + the 3 audited two-arm sites).`,
  );
}

// Only run as the CLI entry point — importing this module (the self-test) must
// NOT trigger the scan or process.exit.
const isCliEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) {
  main();
}
