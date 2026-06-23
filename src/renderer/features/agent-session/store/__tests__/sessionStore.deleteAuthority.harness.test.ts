import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Producer-enumeration harness for the session delete-authority seam
// (postmortem 260607_tombstone_ledger_f1_f2_block_renderer; recs
// 0244e406e12a79d3 + 0861256572136651).
//
// Enumerates EVERY `sessionSummaries:` write site by scanning the production
// source (not a hand-list of producers, so it cannot rot silently):
//
//   1. Every `sessionSummaries:` line in sessionStore.ts must carry a
//      `delete-authority: <category>` marker on the same line or within the
//      3 preceding lines. Adding a new producer/removal path without
//      classifying it through ./sessionDeleteAuthority.ts fails here.
//   2. Per-category site counts are pinned exactly. A new site forces the
//      author to consciously pick a category AND re-pin — the review moment
//      where "does this path consult delete authority?" gets asked.
//   3. The classifier/declaration call counts into sessionDeleteAuthority.ts
//      are pinned, and the raw ledger primitives must NOT reappear in
//      sessionStore.ts — the discriminated classification is the only way to
//      consult delete authority.
//   4. Removal-shaped categories (removal / soft-delete / exempt) are the CI
//      corpus check from rec 0861256572136651: every removal path either
//      records its removal through the authority or carries an explicit
//      `exempt — <rationale>` marker explaining why async producers may
//      legitimately reintroduce the id.
//   5. Renderer-wide: no file outside sessionStore.ts may write
//      `sessionSummaries` through a direct setState — new IPC/event-driven
//      producers must come in through store actions (which classify).
//
// LIMITATION (review F3): check 5 is a HEURISTIC backstop, not exhaustive
// static analysis — it flags `setState(` followed by a `sessionSummaries:`
// property within 15 lines. It will not catch every mutation shape (aliased
// setState references, wrapper functions, spread-built partials, callbacks
// wider than the window). The authoritative guarantees are checks 1-4 on
// sessionStore.ts itself plus the convention that all summary writes go
// through store actions; treat check 5 as a tripwire, and do not cite it as
// proof that no external writer exists.
// ---------------------------------------------------------------------------

const STORE_PATH = fileURLToPath(new URL('../sessionStore.ts', import.meta.url));
const RENDERER_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const MARKER_RE =
  /\/\/ delete-authority: (classified|removal|soft-delete|restore|update-only|type|init|exempt)\b/;
const WRITE_SITE_RE = /^\s*(?:set\(\{\s*)?sessionSummaries:/;
const MARKER_LOOKBACK_LINES = 3;

type Category =
  | 'classified'
  | 'removal'
  | 'soft-delete'
  | 'restore'
  | 'update-only'
  | 'type'
  | 'init'
  | 'exempt';

function loadStoreLines(): string[] {
  return readFileSync(STORE_PATH, 'utf8').split('\n');
}

function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

function countProductionOccurrences(lines: string[], token: string): number {
  let count = 0;
  for (const line of lines) {
    if (isCommentLine(line)) continue;
    let idx = line.indexOf(token);
    while (idx !== -1) {
      count += 1;
      idx = line.indexOf(token, idx + token.length);
    }
  }
  return count;
}

function enumerateWriteSites(lines: string[]): Array<{
  line: number;
  category: Category | null;
  markerLine: string | null;
}> {
  const sites: Array<{ line: number; category: Category | null; markerLine: string | null }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!WRITE_SITE_RE.test(lines[i])) continue;
    if (isCommentLine(lines[i])) continue;
    let category: Category | null = null;
    let markerLine: string | null = null;
    for (let back = 0; back <= MARKER_LOOKBACK_LINES; back++) {
      const candidate = lines[i - back];
      if (candidate === undefined) break;
      const match = MARKER_RE.exec(candidate);
      if (match) {
        category = match[1] as Category;
        markerLine = candidate.trim();
        break;
      }
    }
    sites.push({ line: i + 1, category, markerLine });
  }
  return sites;
}

describe('delete-authority producer-enumeration harness (sessionStore.ts)', () => {
  const lines = loadStoreLines();
  const sites = enumerateWriteSites(lines);

  it('finds the known producer surface (scan is not vacuous)', () => {
    // If the scan regex or file layout changes such that we stop seeing the
    // well-known producers, the harness must fail rather than pass emptily.
    expect(sites.length).toBeGreaterThanOrEqual(20);
    const source = lines.join('\n');
    for (const producer of [
      'updateSessionSummary:',
      'addOrUpdateHistorySession:',
      'setSessionSummaries:',
      'ingestExternalSessions:',
      'addReceiptMessageToSession:',
      'removeHistorySession:',
      'softDeleteSession:',
      'restoreSession:',
      'emptyTrash:',
      'clearAllSessionsForE2E:',
    ]) {
      expect(source).toContain(producer);
    }
  });

  it('every sessionSummaries write site carries a delete-authority marker', () => {
    const unmarked = sites.filter((s) => s.category === null);
    expect(
      unmarked,
      `Unmarked sessionSummaries write site(s) at line(s) ${unmarked
        .map((s) => s.line)
        .join(', ')} of sessionStore.ts. Every write to sessionSummaries must ` +
        `classify its intent via src/renderer/features/agent-session/store/` +
        `sessionDeleteAuthority.ts and carry a "// delete-authority: <category>" ` +
        `marker within ${MARKER_LOOKBACK_LINES} lines (see that module's doc ` +
        `comment for the contract).`,
    ).toEqual([]);
  });

  it('pins the per-category site counts (new sites must be consciously classified)', () => {
    const counts: Record<string, number> = {};
    for (const site of sites) {
      const key = site.category ?? 'UNMARKED';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    // EXACT pin — stale-entry anti-rot. If you add/remove a sessionSummaries
    // write site, classify it through sessionDeleteAuthority.ts, give it the
    // right marker, and update this pin in the same change.
    //
    // Behavior-preserving extraction (260622_refactor-session-store Stages 1-2
    // + 7): the three NON-WRITE `sessionSummaries:` sites moved to sibling
    // modules, each carrying its marker: the `type` field declaration ->
    // ./sessionStoreTypes.ts, the `init` empty-state array (createInitialState)
    // -> ./sessionStoreHelpers.ts, and the diagnostics-parameter `type` site
    // (getSessionSummariesPayloadDiagnostics) -> ./leakDiagnostics.ts. This pin
    // scans sessionStore.ts, which now holds only genuine write sites; the moved
    // markers are pinned separately by the sibling-marker anti-rot test below.
    expect(counts).toEqual({
      classified: 7,
      removal: 3,
      'soft-delete': 2,
      restore: 1,
      'update-only': 11,
      exempt: 1,
    });
  });

  // Anti-rot for the non-write markers that the 260622 extraction moved to
  // sibling modules. These are NOT write sites (a type declaration, the initial
  // empty-state array, a diagnostics parameter) — they match the
  // `sessionSummaries:` token and carry markers only so the convention stays
  // legible. Genuine writes anywhere in the renderer are caught by the
  // renderer-wide setState scan below; this pin keeps the moved markers from
  // silently rotting (e.g. someone deletes the comment during a later edit).
  const SIBLING_MARKERS: ReadonlyArray<{ file: string; category: Category; count: number }> = [
    { file: 'sessionStoreTypes.ts', category: 'type', count: 1 },
    { file: 'sessionStoreHelpers.ts', category: 'init', count: 1 },
    { file: 'leakDiagnostics.ts', category: 'type', count: 1 },
  ];

  it('pins the non-write delete-authority markers that moved to sibling modules', () => {
    for (const { file, category, count } of SIBLING_MARKERS) {
      const siblingPath = fileURLToPath(new URL(`../${file}`, import.meta.url));
      const siblingLines = readFileSync(siblingPath, 'utf8').split('\n');
      const matched = enumerateWriteSites(siblingLines).filter((s) => s.category === category);
      expect(
        matched.length,
        `Expected ${count} "${category}" delete-authority marker(s) on a ` +
          `sessionSummaries: line in ${file} (moved there by the 260622 ` +
          `extraction). Found ${matched.length}. If you intentionally moved or ` +
          `removed it, update SIBLING_MARKERS — and if it became a real write, ` +
          `route it through sessionDeleteAuthority.ts.`,
      ).toBe(count);
    }
  });

  it('exempt markers must carry an explicit rationale', () => {
    const exemptSites = sites.filter((s) => s.category === 'exempt');
    for (const site of exemptSites) {
      expect(site.markerLine).toMatch(/delete-authority: exempt — .{20,}/);
    }
  });

  it('pins the authority-seam call counts (producers cannot silently bypass)', () => {
    // EXACT pins. classifySessionSummaryWrite: updateSessionSummary,
    // addOrUpdateHistorySession, setSessionSummaries (per-row),
    // ingestExternalSessions (per-snapshot), addReceiptMessageToSession.
    expect(countProductionOccurrences(lines, 'classifySessionSummaryWrite(')).toBe(5);
    // recordSessionRemoval: hard-delete (removeHistorySession), empty-trash
    // (emptyTrash), e2e-clear ×4 (clearAllSessionsForE2E).
    expect(countProductionOccurrences(lines, 'recordSessionRemoval(')).toBe(6);
    expect(countProductionOccurrences(lines, 'declareSoftDelete(')).toBe(1);
    expect(countProductionOccurrences(lines, 'declareSessionRestore(')).toBe(1);
    expect(countProductionOccurrences(lines, 'isReattachableTrashRow(')).toBe(1);
  });

  it('raw tombstone-ledger primitives do not reappear in sessionStore.ts', () => {
    // The ledger lives in sessionDeleteAuthority.ts and its membership query is
    // intentionally unexported; a local re-implementation would fork delete
    // authority. (Comments may mention the history; code may not.)
    for (const token of [
      'isSessionTombstoned',
      'tombstoneSession(',
      'tombstoneSessions(',
      'clearTombstone(',
      'sessionTombstones',
    ]) {
      expect(
        countProductionOccurrences(lines, token),
        `Found raw ledger primitive "${token}" in sessionStore.ts — route it ` +
          `through sessionDeleteAuthority.ts instead.`,
      ).toBe(0);
    }
  });
});

describe('delete-authority renderer-wide scan (producers beyond the store)', () => {
  it('no direct setState writes to sessionSummaries outside sessionStore.ts', () => {
    const violations: string[] = [];
    const LOOKAHEAD = 15;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (entry === '__tests__' || entry === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        if (entry === 'sessionStore.ts' || entry === 'sessionDeleteAuthority.ts') continue;

        const fileLines = readFileSync(full, 'utf8').split('\n');
        for (let i = 0; i < fileLines.length; i++) {
          if (!/\bsetState\s*\(/.test(fileLines[i])) continue;
          for (let j = i; j <= Math.min(i + LOOKAHEAD, fileLines.length - 1); j++) {
            if (/^\s*sessionSummaries:\s/.test(fileLines[j]) && !isCommentLine(fileLines[j])) {
              violations.push(`${full}:${j + 1}`);
            }
          }
        }
      }
    };
    walk(RENDERER_ROOT);

    expect(
      violations,
      `Direct setState write(s) to sessionSummaries outside the session store: ` +
        `${violations.join(', ')}. All sessionSummaries writes must go through ` +
        `sessionStore.ts actions so they classify against ` +
        `sessionDeleteAuthority.ts (see its doc comment).`,
    ).toEqual([]);
  });
});
