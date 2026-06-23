#!/usr/bin/env npx tsx
/**
 * CI Validation (SYNTHESIS Stage S1): boundary-governed consumer files must route
 * EVERY cloud-capable IN-PROCESS `node:fs` read through `boundedWorkspaceFs`
 * (`src/core/services/boundedWorkspaceFs.ts`) — they may NOT call a raw,
 * target-dereferencing `node:fs` primitive directly (PLAN.md
 * docs/plans/260619_cloud-symlink-indexing — SYNTHESIS Re-Plan S1/S3; sibling of
 * the readlink-only gate `check-cloud-readlink-only.ts`).
 *
 * WHY: a symlink into a dead/unresponsive cloud FUSE mount makes
 * `stat`/`readdir`/`realpath`/`readFile`/`access`/`lstat` block in the kernel with
 * no timeout, parking a libuv-pool worker → the 0.4.48→0.4.49 turn-hang class. The
 * boundary classifies FS-FREE (readlink-only containment) and routes cloud paths to
 * the bounded, KILLABLE child-process executor; local paths keep the bare-fs fast
 * path. Once a consumer is migrated onto the boundary, this gate makes it impossible
 * for a future edit to silently re-introduce an unbounded cloud syscall via a raw
 * `fs` call in that file.
 *
 * SCOPE — deliberately bounded; this gate is NOT a whole-program safety proof:
 *   - **Allowlist, not whole-tree.** `BOUNDARY_GOVERNED_FILES` is the set of files
 *     that handle workspace paths and have been migrated onto the boundary (S3).
 *     Adding a file here asserts "this file must stay free of raw dereferencing fs".
 *   - **In-process `fs` reads only.** It catches raw `node:fs` deref calls. It does
 *     NOT cover SUBPROCESS walks (`rg`/`find -L`/`grep` via `execFile` in
 *     `globTool`/`searchFilesTool`) — those are governed SEPARATELY by
 *     `src/core/rebelCore/tools/cloudSubprocessExclusion.ts` (Stage 9). A governed
 *     file that shells out is NOT protected by this gate.
 *   - **Reads, not writes.** The boundary is a READ surface (stat/readdir/realpath/
 *     readlink/readFile/access/lstat). Cloud WRITE/COPY work (cloudWorkspaceSync /
 *     migration) is bounded coarsely at the op level (SYNTHESIS reuse map), not
 *     routed through this boundary — so write primitives (`writeFile`, `cp`,
 *     `copyFile`) are intentionally NOT in the forbidden set.
 *   - **Regex/line-based, not AST.** It resolves the common `fs` aliasing forms
 *     (static aliases, namespace import, `require`, destructure, bracket access),
 *     but a sufficiently obfuscated alias (`const m='stat'; fs[m]()`, an fs handle
 *     passed through a function, re-export gymnastics) can still evade it. If the
 *     regex proves leaky once `BOUNDARY_GOVERNED_FILES` is populated, upgrade to an
 *     AST/type-aware check (tracked follow-up). `readlink`/`readlinkSync` ARE
 *     forbidden (S3 review F1): a symlink's own inode lives ON the mount, so reading
 *     it CAN park on a dead cloud mount — route via `workspaceFs.readlink`.
 *     `existsSync` stays ALLOWED (existence probe; use `workspaceFs.access` for cloud).
 *
 * NOTE (S1): `BOUNDARY_GOVERNED_FILES` is intentionally EMPTY when this gate ships
 * in Stage S1 — the detector + its unit tests land first (proving it catches the
 * common planted bypasses and does NOT false-positive on `workspaceFs.*` calls),
 * and the set is POPULATED in Stage S3 as each consumer is migrated off raw fs.
 *
 * Run:    npx tsx scripts/check-workspace-fs-boundary.ts
 * Wired:  npm run validate:fast (scripts/run-validate-fast.ts)
 *
 * @see docs/plans/260619_cloud-symlink-indexing/PLAN.md (SYNTHESIS Re-Plan, S1/S3)
 * @see src/core/services/boundedWorkspaceFs.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Pure, unit-testable detection.
// ---------------------------------------------------------------------------

export interface BoundaryViolation {
  file: string;
  line: number;
  symbol: string;
  text: string;
}

/**
 * Files that handle workspace paths and MUST route cloud-capable fs through
 * `boundedWorkspaceFs`. POSIX, repo-relative. EMPTY in Stage S1; populated in S3.
 */
export const BOUNDARY_GOVERNED_FILES: ReadonlySet<string> = new Set<string>([
  // Migrated onto the boundary (S3+). Each asserts "no raw dereferencing fs here".
  'src/main/ipc/searchHandlers.ts', // MA3 — Atlas gist/zoom/ask indexed-file reads
  'src/core/rebelCore/tools/zoneSafety.ts', // MA2 — post-lexical symlink-escape realpath guard
  'src/core/rebelCore/tools/lsTool.ts', // LS tool — entry validation + per-entry metadata + readlink
  'src/core/utils/safeWalkDirectory.ts', // S4.1a — shared bounded walker (root realpath + per-dir readdir + admitted-symlink stat/realpath); explicit-cloud-root carve-out via forceCloud
  'src/core/services/workspace/guardedPath.ts', // S4.1b — guarded symlink-escape resolver's realpath/lstat (the FIRST mount-touching op in the workspace read path)
  'src/main/services/workspaceFileSystem/electronWorkspaceFileSystem.ts', // S4.1b — desktop WorkspaceFileSystem READ ops (writes stay raw — gate forbids reads only)
  'src/main/services/fileWatcherService.ts', // S4.1c — analyzeWorkspaceSymlinks + source/entity metadata rebuild + cleanupStaleEntries realpath (no writes; fs import removed)
  'src/main/services/fileIndexService/index.ts', // S4.1c — MA3 indexer reads (indexFile/needsReindexing/isRecoverableSourceOnDisk); bespoke runCloudBoundedIndexRead retired; writes + 2 app-data reads (workspace-fs-allow-local) stay raw
  'src/core/services/sourceMetadataStore.ts', // S4.1d — sourceExists `access` (search-path existence probe); reached only for CONTAINMENT-LOCAL entries (cloud entries retained without fs by the R2 split), so the cloud lane is belt-and-braces; fs import removed
  'src/core/services/operatorScanner.ts', // 260622 Stage 1 — per-file OPERATOR.md read on the LIVE turn path (resolveSystemPrompt → buildOperatorPromptMetadata); a cloud-backed space operator on a dead mount would hang the turn (MA1 class). Read routed through workspaceFs; reconnecting → distinct calm scan failure. Directory walk is bounded separately by safeWalkDirectory (above).
  'src/core/services/boundedSpaceReadmeReader.ts', // 260622 Stage 3 (F3) — the distinguished-outcome Chief-of-Staff README reader; the SOLE read path is workspaceFs.readFile (cloud lane = killable pool), so no raw dereferencing fs here. Consumed by the turn-admission gate (chiefOfStaffAdmission.ts) and resolveSystemPrompt convergence.
  'src/core/services/turnPipeline/chiefOfStaffAdmission.ts', // 260622 Stage 3 (rd4) — the turn-admission CoS gate; resolves the CoS dir via workspaceFs.readdirWithFileTypes (bounded scan) and reads via readSpaceReadmeBounded. No raw dereferencing fs here — gate it against future raw-fs regression.
  'src/core/services/space/spaceService.ts', // S4.1e scan lane + S4.1f non-scan reads (create/move/remove/rename/migrate/resolve) — all routed through workspaceFs (per-path cloudReadOption); CAS/destructive pre-steps FAIL CLOSED on reconnecting (never read as absence). ONE exempt: bundled rebel-system template (getSystemSettingsPath). Writers' WRITES stay raw (gate forbids reads only).
  'src/main/ipc/libraryHandlers.ts', // S4.1e read handlers + S4.1f write/create/rename/move/delete/copy/symlink read pre-steps — routed through workspaceFs (per-path cloudLaneOptionForPath); CAS/collision/destructive/import-asset-security probes FAIL CLOSED on reconnecting. EXEMPT: provider install/config probes (workspace-fs-allow-local). BOUNDED (not routable, FS_TIMEOUT_CLOUD_MS): cloud-storage DETECTION mount-parent probes (/Volumes, ~/Library/CloudStorage, DriveFS group-container) via workspace-fs-allow-bounded. statfs cloud-skip (F3). Writers' WRITES stay raw.
  // S4.1d DESCOPE (plan amendment, consult conf 89): libraryHandlers's bespoke
  // runCloudBoundedRead wrapper was retired in S4.1e; its read handlers + (S4.1f) write-path
  // read pre-steps are now all bounded, so the whole file is governed above.
  // mcpService (MA1) re-point later. fileTreeService reads via WorkspaceFileSystem (above),
  // so it holds no raw fs and is governed transitively, not directly.
]);

/**
 * The target-DEREFERENCING fs primitives banned in governed files, in their SYNC
 * form. Matched as a CALL (`name(`); `existsSync` is NOT here (existence probe).
 * `readlinkSync` IS here (S3 review F1): the symlink inode lives on the mount, so it
 * can park on a dead cloud mount — route via `workspaceFs.readlink`. `opendirSync`
 * is excluded: the boundary has no `opendir` op (so there'd be no migration path),
 * and no §2 consumer uses it (`readdir` covers enumeration).
 */
export const FORBIDDEN_SYNC_PRIMITIVES = [
  'statSync',
  'lstatSync',
  'realpathSync',
  'readlinkSync',
  'readdirSync',
  'accessSync',
  'readFileSync',
] as const;

/**
 * The async dereferencing method names, flagged when called on a recognised
 * `node:fs` receiver. Aligned 1:1 with the boundary's read ops (no `opendir`).
 */
export const FORBIDDEN_ASYNC_METHODS = [
  'stat',
  'lstat',
  'realpath',
  'readlink',
  'readdir',
  'access',
  'readFile',
] as const;

/**
 * STATIC receiver identifiers that denote the Node `fs` module (the common import
 * aliases). Dynamic aliases (namespace import / `require` binding) are discovered
 * per-file and added at scan time. Case-sensitive so `workspaceFs.stat(` (receiver
 * `workspaceFs`) is NOT matched.
 */
export const FS_RECEIVER_ALIASES = ['fs', 'fsp', 'fsPromises', 'fsSync', 'fsproms'] as const;

/**
 * AUDITED inline exemption for a provably-LOCAL, non-workspace read inside a governed
 * file (e.g. an app-data path under `<userData>/` that can NEVER be a cloud mount, so
 * routing it through the workspace boundary would be a category error — the boundary's
 * contract is workspace paths only). A read line carrying this marker — on the line
 * itself OR the line directly above — is skipped. The marker must appear inside a `//`
 * line comment (not in arbitrary code or a string), keeping the escape hatch narrow.
 * Deliberately grep-auditable: it requires a human-written reason and shows up in review.
 * Do NOT use it to silence a read that could touch a workspace/cloud path — route that
 * through `workspaceFs`.
 */
export const BOUNDARY_LOCAL_EXEMPT_MARKER = 'workspace-fs-allow-local:';

/**
 * AUDITED inline exemption for a NON-workspace read that CANNOT be routed through
 * `workspaceFs` (the path has no containment classification — e.g. `/Volumes`,
 * `~/Library/CloudStorage`, a provider group-container, the OneDrive sync-root env path)
 * but CAN still park on a dead FUSE mount, so it is bounded another way: an explicit
 * `withTimeout(…, FS_TIMEOUT_CLOUD_MS, …)` race. This is DISTINCT from
 * `workspace-fs-allow-local:` (which asserts provably-local + never-cloud): a
 * `*-allow-bounded:` read IS potentially cloud-touching but is made non-hanging by a
 * caller-side timeout instead of the killable executor.
 *
 * MECHANICALLY ENFORCED (S4.1f review F1): the marker is NOT a free escape hatch — the
 * MARKED raw-read line must ALSO contain BOTH `withTimeout(` and `FS_TIMEOUT_CLOUD_MS` (so a
 * bounded read is written single-line: `await withTimeout(fs.readdir(x), FS_TIMEOUT_CLOUD_MS,
 * fallback); // workspace-fs-allow-bounded: …`). A line carrying the marker WITHOUT that
 * wrapping FAILS the gate (it would otherwise let a future un-bounded raw cloud read pass).
 * Used ONLY for cloud-storage DETECTION mount-parent probes — never for workspace content.
 */
export const BOUNDARY_BOUNDED_EXEMPT_MARKER = 'workspace-fs-allow-bounded:';
/** Tokens that must co-occur on a `*-allow-bounded:` read line to prove the timeout bound. */
const BOUNDED_TIMEOUT_TOKENS = ['withTimeout(', 'FS_TIMEOUT_CLOUD_MS'] as const;

/** True iff `rawLine` carries the LOCAL exemption marker INSIDE a `//` comment (F2: not in
 *  arbitrary code/string — the marker must follow a `//`). */
function lineHasLocalExemptComment(rawLine: string): boolean {
  const commentIdx = rawLine.indexOf('//');
  return commentIdx !== -1 && rawLine.indexOf(BOUNDARY_LOCAL_EXEMPT_MARKER) > commentIdx;
}

/** True iff `rawLine` carries the BOUNDED exemption marker INSIDE a `//` comment. */
function lineHasBoundedExemptComment(rawLine: string): boolean {
  const commentIdx = rawLine.indexOf('//');
  return commentIdx !== -1 && rawLine.indexOf(BOUNDARY_BOUNDED_EXEMPT_MARKER) > commentIdx;
}

/**
 * True iff `rawLine` actually wraps its read in `withTimeout(…, FS_TIMEOUT_CLOUD_MS, …)`.
 *
 * Scans ONLY the CODE portion of the line, stripping any trailing `//` comment first —
 * otherwise the marker comment itself (which mentions the budget by name) would spoof the
 * bound check. Mirrors `stripComments`'s naive split convention; safe here because none of
 * the real bounded read lines carry a `//` inside a string literal before the tokens.
 */
function lineIsTimeoutBounded(rawLine: string): boolean {
  const code = rawLine.split('//')[0];
  return BOUNDED_TIMEOUT_TOKENS.every((tok) => code.includes(tok));
}

/** The `fs` module specifiers an import/require can come from. */
const FS_MODULE_SPECIFIERS = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'];
/** Regex alternation matching any fs module specifier (for `require('…')`). */
const FS_MODULE_RE = '(?:fs|node:fs|fs/promises|node:fs/promises)';

/**
 * Strip line + block comments, returning an array the SAME LENGTH as the input
 * (comment regions blanked) so line numbers are preserved.
 */
function stripComments(rawLines: string[]): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (let raw of rawLines) {
    let line = raw;
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        inBlockComment = false;
        line = line.slice(endIdx + 2);
      } else {
        out.push('');
        continue;
      }
    }
    while (line.includes('/*')) {
      const startIdx = line.indexOf('/*');
      const endIdx = line.indexOf('*/', startIdx + 2);
      if (endIdx !== -1) {
        line = line.slice(0, startIdx) + line.slice(endIdx + 2);
      } else {
        line = line.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
    }
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1) line = line.slice(0, commentIdx);
    out.push(line);
  }
  return out;
}

/**
 * A reference is a VIOLATION only when it is an actual CALL of a forbidden raw fs
 * primitive (or a destructure/import that would enable a bare call) — not a
 * boundary call (`workspaceFs.*`), a comment, or a doc reference.
 */
export function findBoundaryViolations(source: string, filePath: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const rawLines = source.split('\n');
  const lines = stripComments(rawLines);

  // ---- Pass 1: discover DYNAMIC fs-module receiver aliases in this file ----
  // `import * as nfs from 'node:fs'` and `const nfs = require('node:fs')` bind an
  // arbitrary name to the fs module; collect those so the call-matchers below flag
  // `nfs.stat(` / `nfs.promises.stat(` too (DA-F2/GPT-F3 bypass).
  const dynamicAliases = new Set<string>();
  const nsImportRe = new RegExp(`import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['"]${FS_MODULE_RE}['"]`);
  // Default import: `import nfs from 'node:fs'` / `import nfs, { x } from …` (the
  // default binding is the module namespace; `nfs.promises.stat(` must be caught).
  // Excludes `import {` and `import * as` (those start with `{`/`*`, not `\w`).
  const defaultImportRe = new RegExp(
    `import\\s+(\\w+)\\s*(?:,\\s*(?:\\{[^}]*\\}|\\*\\s+as\\s+\\w+))?\\s+from\\s+['"]${FS_MODULE_RE}['"]`,
  );
  const requireRe = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*require\\(\\s*['"]${FS_MODULE_RE}['"]\\s*\\)`);
  for (const line of lines) {
    const ns = nsImportRe.exec(line);
    if (ns) dynamicAliases.add(ns[1]);
    const di = defaultImportRe.exec(line);
    if (di) dynamicAliases.add(di[1]);
    const rq = requireRe.exec(line);
    if (rq) dynamicAliases.add(rq[1]);
  }
  const allReceivers = [...new Set([...FS_RECEIVER_ALIASES, ...dynamicAliases])];
  const receiverGroup = allReceivers.join('|');

  // ---- Pass 2: violations ----
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const originalLine = rawLines[i];
    const lineNum = i + 1;
    if (!line.trim()) continue;
    // AUDITED local-read exemption (`workspace-fs-allow-local:` on this line or the one
    // directly above) — provably-local, never-cloud reads.
    if (lineHasLocalExemptComment(originalLine) || (i > 0 && lineHasLocalExemptComment(rawLines[i - 1]))) {
      continue;
    }
    // AUDITED bounded-read exemption (`workspace-fs-allow-bounded:` on this line or the one
    // directly above) — a cloud-touching probe that can't route through `workspaceFs` but is
    // made non-hanging by an explicit timeout. MECHANICALLY ENFORCED (review F1): the RAW
    // READ LINE itself must wrap the read in `withTimeout(…, FS_TIMEOUT_CLOUD_MS, …)`. If the
    // marker is present but the read isn't so bounded, we DO NOT skip — it falls through to
    // be flagged as a violation, so the marker can't silence an un-bounded raw cloud read.
    if (lineHasBoundedExemptComment(originalLine) || (i > 0 && lineHasBoundedExemptComment(rawLines[i - 1]))) {
      if (lineIsTimeoutBounded(originalLine)) {
        continue;
      }
      // marker present but the read is NOT timeout-bounded → fall through → flagged.
    }
    const push = (symbol: string) =>
      violations.push({ file: filePath, line: lineNum, symbol, text: originalLine.trim() });

    // (c) Destructured forbidden ES import from an fs module:
    //     `import { stat, readdir } from 'node:fs/promises'`.
    const importMatch = /^\s*import\b[^;]*\bfrom\b\s*['"]([^'"]+)['"]/.exec(line);
    if (importMatch && FS_MODULE_SPECIFIERS.includes(importMatch[1])) {
      const braceMatch = /\{([^}]*)\}/.exec(line);
      if (braceMatch) {
        for (const raw of braceMatch[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim();
          if ((FORBIDDEN_ASYNC_METHODS as readonly string[]).includes(name)) {
            push(`import { ${name} } from '${importMatch[1]}'`);
          }
        }
      }
      continue; // an import line is never also a call line
    }
    if (/^\s*import\b/.test(line) || /^\s*export\b[^=]*\bfrom\b/.test(line)) continue;

    // (d) Destructure from an fs source enabling bare calls:
    //     `const { stat } = fs.promises | fsp | require('fs') | <dynamicAlias>`.
    const destructSources = [
      'fs\\.promises',
      `require\\(\\s*['"]${FS_MODULE_RE}['"]\\s*\\)`,
      ...allReceivers.map((a) => `\\b${a}\\b`),
    ];
    const destructRe = new RegExp(
      `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:${destructSources.join('|')})`,
    );
    const dm = destructRe.exec(line);
    if (dm) {
      for (const raw of dm[1].split(',')) {
        const name = raw.trim().split(/[:\s]/)[0].trim();
        if ((FORBIDDEN_ASYNC_METHODS as readonly string[]).includes(name)) {
          push(`destructured ${name} from fs`);
        }
      }
    }

    // (a) Bare sync primitives (`statSync(`, also `fs.statSync(`).
    for (const symbol of FORBIDDEN_SYNC_PRIMITIVES) {
      const callRe = new RegExp(`(?<!\\w)${symbol}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(line)) !== null) {
        if (/\bfunction\s+$/.test(line.slice(0, m.index))) continue; // a definition
        push(symbol);
      }
    }

    // (b) Async fs-module calls — dot OR bracket access on a static/dynamic fs
    //     receiver, AND the same via `.promises.` (for `node:fs` default/namespace
    //     imports like `nfs.promises.stat(`).
    for (const method of FORBIDDEN_ASYNC_METHODS) {
      const patterns = [
        new RegExp(`\\b(?:${receiverGroup})\\.${method}\\s*\\(`, 'g'),
        new RegExp(`\\b(?:${receiverGroup})\\[\\s*['"]${method}['"]\\s*\\]\\s*\\(`, 'g'),
        new RegExp(`\\b(?:${receiverGroup})\\.promises\\.${method}\\s*\\(`, 'g'),
        new RegExp(`\\b(?:${receiverGroup})\\.promises\\[\\s*['"]${method}['"]\\s*\\]\\s*\\(`, 'g'),
      ];
      for (const re of patterns) {
        const matches = line.match(re);
        if (matches) for (let k = 0; k < matches.length; k++) push(`fs.${method}`);
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Setup-file eager-import guard (S4.1b blocker prevention).
// ---------------------------------------------------------------------------
//
// WHY: `vitest.setup.ts` runs for EVERY desktop test and is evaluated BEFORE a suite's
// hoisted `vi.mock('node:fs/promises')` takes effect. A STATIC import of a
// boundary-governed module (or `boundedWorkspaceFs` itself) into setupFiles eagerly
// evaluates the boundary's `import fsp from 'node:fs/promises'` binding against the
// REAL fs — which then silently defeats every desktop suite's fs mock (wrong-pass /
// timeout). That was the S4.1b ~34-red-suite blocker (root cause: setup statically
// imported ElectronWorkspaceFileSystem → guardedPath → boundedWorkspaceFs). The fix is
// to load such modules LAZILY inside their factory thunk. This guard makes the failure
// class impossible to silently reintroduce as more consumers join the boundary in
// S4.1c/d — it is registry-driven, so the forbidden set grows automatically.

export interface SetupEagerImportViolation {
  line: number;
  specifier: string;
  resolved: string;
  text: string;
}

/**
 * Repo-relative POSIX `.ts` paths that `vitest.setup.ts` must NEVER reach via a STATIC
 * `import`/`export … from`, a bare side-effect `import '…'`, or a TOP-LEVEL
 * `const/let/var … = require('…')`: the boundary module itself plus every
 * boundary-governed consumer. Load any of them LAZILY inside a factory thunk instead.
 */
export const SETUP_FORBIDDEN_EAGER_FILES: ReadonlySet<string> = new Set<string>([
  'src/core/services/boundedWorkspaceFs.ts',
  ...BOUNDARY_GOVERNED_FILES,
]);

/** `@alias/` → `src/<dir>/` prefixes, mirroring tsconfig path aliases. */
const SETUP_ALIAS_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['@core/', 'src/core/'],
  ['@main/', 'src/main/'],
  ['@shared/', 'src/shared/'],
  ['@renderer/', 'src/renderer/'],
  ['@preload/', 'src/preload/'],
];

/**
 * Resolve an import specifier (as written in `vitest.setup.ts`, which lives at the repo
 * root) to a repo-relative POSIX `.ts` path, or `null` if it is a bare/node module
 * (e.g. `vitest`, `node:fs`) that cannot match the registry. Exported for unit tests.
 */
export function resolveSetupImportSpecifier(spec: string): string | null {
  const aliased = SETUP_ALIAS_PREFIXES.find(([alias]) => spec.startsWith(alias));
  let p: string;
  if (aliased) {
    p = aliased[1] + spec.slice(aliased[0].length);
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    p = path.posix.normalize(spec); // setup file is at the repo root
  } else if (spec.startsWith('src/')) {
    p = spec;
  } else {
    return null; // bare module specifier — not a local source file
  }
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/') || p.startsWith('..')) return null; // escaped above root
  if (!p.endsWith('.ts') && !p.endsWith('.tsx')) p = `${p}.ts`;
  return p;
}

/**
 * Find STATIC eager imports of boundary-governed (or boundary) modules in
 * `vitest.setup.ts`. The lazy-factory fix uses an INDENTED (in-thunk) `require(...)`,
 * which is intentionally NOT a violation — only static `import`/`export … from`, bare
 * side-effect `import '…'`, and TOP-LEVEL (column-0) `require` bindings are flagged.
 * `import type … from` is exempt (type-only; no runtime module evaluation).
 *
 * SCOPE: registry-driven and DIRECT — it flags a setup import whose specifier resolves
 * to a file in {@link SETUP_FORBIDDEN_EAGER_FILES}. It does not trace transitive graphs
 * (a static setup import of a NON-governed file that itself imports the boundary would
 * slip through); in practice the boundary's direct importers ARE the governed consumers,
 * so the direct check covers the realistic poison edges and auto-covers S4.1c/d.
 */
export function findSetupEagerBoundaryImports(source: string): SetupEagerImportViolation[] {
  const violations: SetupEagerImportViolation[] = [];
  const rawLines = source.split('\n');
  const lines = stripComments(rawLines);

  const importFromRe = /^\s*(?:import|export)\b[^;]*\bfrom\s*['"]([^'"]+)['"]/;
  const sideEffectImportRe = /^\s*import\s+['"]([^'"]+)['"]/;
  const typeOnlyImportRe = /^\s*import\s+type\b/;
  // TOP-LEVEL only (no leading whitespace) so the lazy fix's INDENTED in-thunk
  // `require(...)` is not flagged. `=\s*require\(` requires `require` immediately after
  // `=`, so `const f = () => require(...)` (a lazy arrow) is also correctly ignored.
  const topLevelRequireRe = /^(?:const|let|var)\s+[^=]*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (typeOnlyImportRe.test(line)) continue;

    let spec: string | null = null;
    const fromM = importFromRe.exec(line);
    if (fromM) spec = fromM[1];
    if (spec === null) {
      const seM = sideEffectImportRe.exec(line);
      if (seM) spec = seM[1];
    }
    if (spec === null) {
      const rqM = topLevelRequireRe.exec(line);
      if (rqM) spec = rqM[1];
    }
    if (spec === null) continue;

    const resolved = resolveSetupImportSpecifier(spec);
    if (resolved && SETUP_FORBIDDEN_EAGER_FILES.has(resolved)) {
      violations.push({ line: i + 1, specifier: spec, resolved, text: rawLines[i].trim() });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// CLI runner — skipped under Vitest (imported for unit tests instead).
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..');

if (!process.env.VITEST) {
  console.log('Checking that boundary-governed files route workspace fs through boundedWorkspaceFs...\n');

  const allViolations: BoundaryViolation[] = [];
  let scanned = 0;

  for (const relativePath of BOUNDARY_GOVERNED_FILES) {
    const abs = path.join(REPO_ROOT, relativePath);
    if (!fs.existsSync(abs)) {
      console.error(`\n✗ Boundary-governed file not found: ${relativePath}`);
      console.error('  Update BOUNDARY_GOVERNED_FILES in scripts/check-workspace-fs-boundary.ts if it was renamed/moved.');
      process.exit(1);
    }
    scanned += 1;
    const src = fs.readFileSync(abs, 'utf8');
    allViolations.push(...findBoundaryViolations(src, relativePath));
  }

  // ---- Setup-file eager-import guard (S4.1b blocker prevention) ----
  const setupRel = 'vitest.setup.ts';
  const setupAbs = path.join(REPO_ROOT, setupRel);
  const setupViolations: SetupEagerImportViolation[] = fs.existsSync(setupAbs)
    ? findSetupEagerBoundaryImports(fs.readFileSync(setupAbs, 'utf8'))
    : [];

  let failed = false;

  if (allViolations.length > 0) {
    failed = true;
    console.error(`\n✗ Found ${allViolations.length} raw fs call(s) in boundary-governed files:\n`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    -> ${v.symbol}`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'These files are boundary-governed: every cloud-capable workspace fs READ MUST\n' +
        'go through `boundedWorkspaceFs` (workspaceFs.stat/readdir/realpath/readFile/\n' +
        'readFileBytes/access/lstat), which classifies the path FS-free and routes a\n' +
        'cloud path to the bounded, killable child-process executor. A raw `fs.stat`/\n' +
        '`statSync`/… on a workspace path can block in the kernel on a dead cloud FUSE\n' +
        'mount and re-open the 0.4.48→0.4.49 turn-hang class.\n' +
        'If the op is genuinely on a NON-workspace / always-local path, move it to a\n' +
        'non-governed file or extract a clearly-local helper — do not call raw fs here.\n' +
        'See: docs/plans/260619_cloud-symlink-indexing/PLAN.md (SYNTHESIS Re-Plan, S1/S3)',
    );
  }

  if (setupViolations.length > 0) {
    failed = true;
    console.error(
      `\n✗ ${setupRel} statically imports ${setupViolations.length} boundary-governed module(s) eagerly:\n`,
    );
    for (const v of setupViolations) {
      console.error(`  ${setupRel}:${v.line}`);
      console.error(`    -> ${v.specifier}  (resolves to ${v.resolved})`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'setupFiles run for EVERY desktop test and are evaluated BEFORE a suite\'s hoisted\n' +
        "vi.mock('node:fs/promises') takes effect. A static import of a boundary-governed\n" +
        'module (or boundedWorkspaceFs itself) into setup eagerly evaluates the boundary\'s\n' +
        "`import fsp from 'node:fs/promises'` binding against the REAL fs, which then\n" +
        "silently defeats every desktop suite's fs mock (wrong-pass / timeout — the S4.1b\n" +
        'red-suite blocker). Load the module LAZILY inside its factory thunk instead:\n' +
        '    setWorkspaceFileSystemFactory(() => {\n' +
        "      const { ElectronWorkspaceFileSystem } = require('./src/main/.../electronWorkspaceFileSystem');\n" +
        '      return new ElectronWorkspaceFileSystem();\n' +
        '    });\n' +
        'See: docs/plans/260619_cloud-symlink-indexing (S4.1b blocker decision).',
    );
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `\n✓ ${scanned} boundary-governed file(s) scanned — none call raw dereferencing fs` +
      (scanned === 0 ? ' (set is empty until Stage S3 migrates consumers)' : '') +
      `\n✓ ${setupRel} — no eager static import of boundary-governed modules`,
  );
}
