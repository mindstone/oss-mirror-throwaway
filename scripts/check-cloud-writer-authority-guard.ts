#!/usr/bin/env npx tsx
/**
 * CI Validation: the cloud→desktop write surface must not gain a NEW raw
 * in-place content writer.
 *
 * Origin: REBEL-696 (FOX-3498) — the Google Drive sync-conflict duplication
 * loop. Rebel's cloud→desktop pull was *designed* to be a second writer onto
 * cloud-synced paths (in-place `fs.writeFileSync`). For a path the OS sync
 * engine (Google Drive / Dropbox / OneDrive / iCloud) also owns —
 * `desktop_fs_authoritative` — that in-place rewrite races the OS engine, which
 * mints a `foo (1).md` conflict copy. Drive's own broken v125 conflict-trash
 * handler can't clean the loser, so it re-enters the churn and self-feeds into
 * thousands of `(N)` copies (56-level nesting). This recurred THREE times across
 * 62A / 5QS / 696; the prior two fixes suppressed already-minted copies (the
 * *suppressor*) but never the *generator*. The 696 fix removes one writer by
 * construction: for `desktop_fs_authoritative` paths, an *edited* file is
 * deferred to the OS engine (recorded as a hash-keyed pending update), and the
 * new-file/published lifeline delivers via a non-racing atomic temp-then-rename
 * (`writeFileAtomicInTargetDirSync` / `writeFileAtomicInTargetDir`,
 * cloudAtomicWrite.ts). The remaining raw `fs.writeFileSync` / `fs.writeFile`
 * calls in the surface are reachable ONLY on the NON-authoritative branch (where
 * `writeViaAtomicRename === false`, i.e. NOT `desktop_fs_authoritative`) or are
 * internal sync-state writes, never user workspace content on an OS-owned path.
 *
 * This is the GENERATOR analogue of the now-shipped conflict-matcher consumer
 * guard (`scripts/check-conflict-matcher-consumer-guard.ts`), which guards the
 * *suppressor*. It targets the orthogonal invariant the suppressor guard does
 * not cover: a new pull/staging in-place writer that writes a cloud-authoritative
 * path in place fails CI, so a 4th recurrence cannot ship silently.
 *
 * ## What this gate flags
 *
 * A raw in-place content write — `fs.writeFileSync(`, `fs.writeFile(`,
 * `fs.appendFile(`, `fs.appendFileSync(`, `fs.promises.writeFile(`, and the bare
 * `writeFileSync(`/`writeFile(`/`appendFile(` forms — inside the cloud→desktop
 * write surface (`cloudWorkspaceSync.ts`, `cloudStagingBridge.ts`).
 *
 * NOT flagged (by construction):
 *   - The atomic seam `writeFileAtomicInTargetDirSync` / `writeFileAtomicInTargetDir`
 *     (these ARE the non-racing temp-then-rename the OS engine treats as a clean
 *     replace — the sanctioned delivery for new/published files).
 *   - Each CURRENT legitimate raw writer, recorded in WRITER_BASELINE with a
 *     one-line rationale (count-pinned so a NEW raw write to an already-baselined
 *     file is not silently absorbed).
 *
 * ## Scope (NARROW BY DESIGN)
 *
 * Exactly the two cloud→desktop *delivery* write surfaces the postmortem names
 * as the dual-writer generator. Other `src/main/services/cloud/*` files
 * (metadata / outbox / router flags / migration bookkeeping) write Rebel-internal
 * sync state, never OS-owned workspace content, and are already classified by the
 * conflict-matcher consumer guard's `cloud_internal_state_exempt` registry; widening
 * this gate to all of them would import a large internal-state allowlist and
 * dilute the generator-specific signal (the exact FP-avalanche the rec warns
 * against). A future writer added to a NEW cloud delivery surface should be added
 * to SCANNED_FILES here so it is held to the same invariant.
 *
 * Escape hatch: a `WRITER_AUTHORITY_OK: <reason>` comment on or above the line
 * (for a genuinely non-workspace / internal-state write that doesn't warrant a
 * baseline entry).
 *
 * Run: npx tsx scripts/check-cloud-writer-authority-guard.ts
 * @see scripts/check-conflict-matcher-consumer-guard.ts (the suppressor analogue)
 * @see src/main/services/cloud/cloudAtomicWrite.ts (writeFileAtomicInTargetDir[Sync])
 * @see src/core/utils/cloudStorageUtils.ts (resolveWorkspaceWriteAuthority / desktop_fs_authoritative)
 * @see docs-private/postmortems/260619_rebel696_cloud_sync_dual_writer_conflict_loop_postmortem.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * The cloud→desktop *delivery* write surface — the two paths the REBEL-696
 * postmortem identifies as the dual-writer generator. Scanned for raw in-place
 * content writes. Keep this list tight; add a new entry only for a genuinely new
 * cloud→desktop delivery surface (NOT internal-state cloud modules).
 */
export const SCANNED_FILES: readonly string[] = [
  'src/main/services/cloud/cloudWorkspaceSync.ts',
  'src/main/services/cloud/cloudStagingBridge.ts',
];

/**
 * The sanctioned atomic seam. A call to either of these is the non-racing
 * temp-then-rename delivery (cloudAtomicWrite.ts) and is NEVER flagged — it is
 * exactly what a cloud-authoritative delivery is required to use.
 */
const ATOMIC_SEAM_CALLEES: ReadonlySet<string> = new Set<string>([
  'writeFileAtomicInTargetDirSync',
  'writeFileAtomicInTargetDir',
]);

/**
 * Raw in-place content-write call names this gate detects. Covers both the
 * `fs.`-qualified and bare (destructured-import) forms; `fs.promises.writeFile`
 * is matched via the property-access tail (`writeFile`). Atomic-seam callees in
 * ATOMIC_SEAM_CALLEES are explicitly excluded above.
 */
const RAW_WRITE_CALLEES: ReadonlySet<string> = new Set<string>([
  'writeFileSync',
  'writeFile',
  'appendFile',
  'appendFileSync',
]);

const WRITER_AUTHORITY_OK_RE = /WRITER_AUTHORITY_OK:/;

/**
 * Pre-existing sanctioned raw writers, recorded so this gate enforces "no NEW
 * raw in-place writer in the cloud delivery surface" without rewriting the
 * approved REBEL-696 fix code. Keyed by `relativePath::callee::firstArg`
 * (line-agnostic so unrelated edits don't reshuffle), mapped to the expected
 * occurrence count so a NEW raw write added to an already-baselined file (same
 * callee+arg) is NOT silently absorbed — mirrors CONTAINMENT_BASELINE in
 * check-pathroot-startswith-containment.ts.
 *
 * Every entry is a write that is NOT an automatic in-place content write on a
 * `desktop_fs_authoritative` path: it is either internal sync-state, or it sits
 * on the NON-authoritative branch (`writeViaAtomicRename === false`, set ONLY
 * when the resolved authority is NOT `desktop_fs_authoritative`).
 *
 * To DRAIN an entry: route the write through `writeFileAtomicInTargetDir[Sync]`
 * (or confirm it is internal-state and annotate `WRITER_AUTHORITY_OK:`), then
 * delete the entry. Never ADD an entry for a new cloud-authoritative in-place write.
 */
export const WRITER_BASELINE: ReadonlyMap<string, number> = new Map<string, number>([
  // Internal sync state: the persisted last-pushed workspace manifest
  // (sessions/cloud-workspace-manifest.json). Rebel-internal bookkeeping under
  // userData, not OS-Drive-synced workspace content — no conflict-copy class.
  ['src/main/services/cloud/cloudWorkspaceSync.ts::writeFileSync::this.filePath', 1],
  // `.conflict-cloud` copy, NON-authoritative branch ONLY. Reached in the
  // `else` of `writeAuthority === 'desktop_fs_authoritative'`: when the path is
  // NOT OS-owned, parking the cloud bytes beside the local file is safe. On the
  // `desktop_fs_authoritative` path the cloud bytes are quarantined OUTSIDE the
  // synced tree (quarantineWorkspaceCloudConflict), never written in place here.
  ['src/main/services/cloud/cloudWorkspaceSync.ts::writeFileSync::conflictFilePath', 1],
  // Cloud-pull write, NON-atomic branch ONLY (`else` of `writeViaAtomicRename`).
  // `writeViaAtomicRename` is set true ONLY inside the
  // `writeAuthority === 'desktop_fs_authoritative'` block (cloudWorkspaceSync.ts
  // ~:1997/:2078), so this raw write is unreachable on an OS-owned path; for
  // those paths an edited file defers and a new file delivers via atomic rename.
  ['src/main/services/cloud/cloudWorkspaceSync.ts::writeFileSync::localPath', 1],
  // Internal sync state: the staging-bridge cloud-id map
  // (bridgedCloudIds → persist path under userData). Rebel-internal dedup
  // bookkeeping, not OS-Drive-synced workspace content.
  ['src/main/services/cloud/cloudStagingBridge.ts::writeFile::filePath', 1],
  // Published-file pull write, NON-atomic branch ONLY (`else` of
  // `writeViaAtomicRename`). `writeViaAtomicRename` is set true ONLY inside the
  // `writeAuthority === 'desktop_fs_authoritative'` block (cloudStagingBridge.ts
  // ~:526/:561), so this raw write is unreachable on an OS-owned path.
  ['src/main/services/cloud/cloudStagingBridge.ts::writeFile::absolutePath', 1],
]);

export interface RawWriteViolation {
  relativePath: string;
  line: number;
  callee: string;
  firstArg: string;
}

export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

export function writerBaselineKey(v: RawWriteViolation): string {
  return `${v.relativePath}::${v.callee}::${v.firstArg}`;
}

export function partitionRawWrites(violations: RawWriteViolation[]): {
  fresh: RawWriteViolation[];
  baselinedKeys: Set<string>;
  staleKeys: string[];
} {
  const byKey = new Map<string, RawWriteViolation[]>();
  for (const v of violations) {
    const key = writerBaselineKey(v);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(v);
  }
  const fresh: RawWriteViolation[] = [];
  const baselinedKeys = new Set<string>();
  for (const [key, vs] of byKey) {
    const allowed = WRITER_BASELINE.get(key) ?? 0;
    if (allowed > 0) baselinedKeys.add(key);
    if (vs.length > allowed) fresh.push(...vs.slice(allowed));
  }
  const staleKeys = [...WRITER_BASELINE.keys()].filter(
    (k) => (byKey.get(k)?.length ?? 0) < (WRITER_BASELINE.get(k) ?? 0),
  );
  return { fresh, baselinedKeys, staleKeys };
}

/**
 * Resolve the callee name of a call expression to the symbol this gate keys on:
 *   - bare `writeFileSync(...)`        → "writeFileSync"
 *   - `fs.writeFileSync(...)`          → "writeFileSync"  (property-access tail)
 *   - `fs.promises.writeFile(...)`     → "writeFile"      (property-access tail)
 * Returns null for anything that isn't an identifier or property-access callee.
 */
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return null;
}

/** Stable, line-agnostic name for the first argument of a write call. */
function firstArgName(node: ts.CallExpression, sf: ts.SourceFile): string {
  const arg = node.arguments[0];
  if (!arg) return '<none>';
  if (ts.isIdentifier(arg)) return arg.text;
  // `this.filePath`, `path.join(...)` etc. — use the trimmed source text so the
  // baseline key stays stable and human-readable.
  return arg.getText(sf).replace(/\s+/g, '');
}

export function scanSourceForRawWrites(
  sourceText: string,
  relativePath: string,
): RawWriteViolation[] {
  const sf = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations: RawWriteViolation[] = [];

  const lineHasMarker = (pos: number): boolean => {
    const { line } = sf.getLineAndCharacterOfPosition(pos);
    const lineStart = sf.getLineStarts()[line];
    const nextLineStart = sf.getLineStarts()[line + 1] ?? sourceText.length;
    const prevLineStart = line > 0 ? sf.getLineStarts()[line - 1] : lineStart;
    const slice = sourceText.slice(prevLineStart, nextLineStart);
    return WRITER_AUTHORITY_OK_RE.test(slice);
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = calleeName(n.expression);
      if (
        callee &&
        RAW_WRITE_CALLEES.has(callee) &&
        !ATOMIC_SEAM_CALLEES.has(callee) &&
        !lineHasMarker(n.getStart(sf))
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        violations.push({
          relativePath,
          line: line + 1,
          callee,
          firstArg: firstArgName(n, sf),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return violations;
}

export function findCloudRawWrites(): RawWriteViolation[] {
  const violations: RawWriteViolation[] = [];
  for (const rel of SCANNED_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // A scanned surface that no longer exists surfaces as a stale baseline
      // entry below (its expected writers go to zero) — loud, not silent.
      continue;
    }
    violations.push(...scanSourceForRawWrites(text, toPosix(rel)));
  }
  return violations;
}

function main(): void {
  const violations = findCloudRawWrites();
  const { fresh, baselinedKeys, staleKeys } = partitionRawWrites(violations);

  if (staleKeys.length > 0) {
    console.warn('⚠ check-cloud-writer-authority-guard: baseline entries reduced/removed (prune them):');
    for (const k of staleKeys) console.warn(`  - ${k}`);
    console.warn('');
  }

  if (fresh.length === 0) {
    console.log(
      `✓ check-cloud-writer-authority-guard: no NEW raw in-place writer in the cloud delivery surface ` +
        `(${baselinedKeys.size} sanctioned writers baselined; ${staleKeys.length} stale).`,
    );
    return;
  }

  console.error(
    '✗ check-cloud-writer-authority-guard: NEW raw in-place content write(s) in the cloud→desktop write surface:',
  );
  for (const v of fresh) {
    console.error(`  - ${v.relativePath}:${v.line}  ${v.callee}(${v.firstArg}, …)`);
  }
  console.error('');
  console.error('A raw in-place write in the cloud delivery surface that can reach a');
  console.error('`desktop_fs_authoritative` (OS-Drive-synced) path is a SECOND writer on that');
  console.error('path — it races the OS sync engine, which mints self-feeding `foo (1).md`');
  console.error('conflict copies (REBEL-696, the 3x-recurring Drive dual-writer class).');
  console.error('');
  console.error('Route cloud-authoritative workspace writes through the deferral / pending-update');
  console.error('seam, or deliver via the non-racing atomic temp-then-rename:');
  console.error('  import { writeFileAtomicInTargetDirSync } from "./cloudAtomicWrite";');
  console.error('  writeFileAtomicInTargetDirSync(localPath, content, "utf8");');
  console.error('');
  console.error('If this write is genuinely a non-workspace / internal-state write (never an');
  console.error('OS-owned workspace path), add it to WRITER_BASELINE with a one-line rationale,');
  console.error('or annotate the line with `WRITER_AUTHORITY_OK: <reason>`.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
