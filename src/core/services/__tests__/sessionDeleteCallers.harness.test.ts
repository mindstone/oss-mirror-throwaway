/**
 * Stage 3 (260612 recs-round5): caller-enumeration + producer harness for the
 * session-store hard-delete tombstone work (extends the renderer
 * `sessionStore.deleteAuthority.producers.test.ts` pattern to the main-side
 * store, mechanically — by source scan — rather than behaviorally).
 *
 * What this pins, forever:
 *  1. EVERY production `.deleteSession(` call site in src/ + cloud-service/src/
 *     is classified (intent-declared / pass-through / non-store receiver). A
 *     new or moved caller fails CI until it is classified here AND declares an
 *     intent at the call site (assumption C3; the required `intent` param
 *     already fails the COMPILE — this harness additionally fails on receivers
 *     the type system cannot see, and keeps the single-writer assumption
 *     reviewable).
 *  2. The session-file producers (`persistSessionToDisk[Sync]` call sites) and
 *     index writers (`writeIndexFileAtomic[Sync]` call sites) match the
 *     classified inventory — guarded or exempt-with-reason (assumption C1).
 *  3. No NEW raw `this.indexPath` write exists outside the sanctioned
 *     chokepoint internals (RS F15 — the mined `loadIndexOnlySync` prune wrote
 *     raw; the port must not reintroduce that).
 *
 * The classifier core is a pure function so the "unclassified caller FAILS"
 * property is itself provable with a synthetic fixture (see the last test).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCAN_ROOTS = ['src', 'cloud-service/src'];

// ---------------------------------------------------------------------------
// Pure classifier core
// ---------------------------------------------------------------------------

interface SourceFile {
  /** Repo-relative posix-ish path. */
  relPath: string;
  content: string;
}

interface DeleteCallSite {
  relPath: string;
  line: number;
  /** The call line plus a small trailing window (multi-line call args). */
  context: string;
}

interface CallerRule {
  file: string;
  /** Unique substring that must appear in the call-site context window. */
  match: string;
  classification:
    | { kind: 'intent'; intent: 'user-delete' | 'hygiene'; reason: string }
    | { kind: 'pass-through'; reason: string }
    | { kind: 'non-store-receiver'; reason: string };
}

export function collectDeleteSessionCallSites(files: SourceFile[]): DeleteCallSite[] {
  const sites: DeleteCallSite[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Calls only (receiver dot) — method DEFINITIONS like
      // `async deleteSession(` in store classes are not call sites.
      if (!/\.deleteSession\(/.test(lines[i])) continue;
      // Skip pure type/interface signatures (deps declarations).
      if (/^\s*deleteSession:/.test(lines[i])) continue;
      sites.push({
        relPath: file.relPath,
        line: i + 1,
        context: lines.slice(i, Math.min(lines.length, i + 3)).join('\n'),
      });
    }
  }
  return sites;
}

export function classifyCallSites(
  sites: DeleteCallSite[],
  rules: CallerRule[],
): { unclassified: DeleteCallSite[]; staleRules: CallerRule[]; violations: string[] } {
  const usedRules = new Set<CallerRule>();
  const unclassified: DeleteCallSite[] = [];
  const violations: string[] = [];

  for (const site of sites) {
    // Match rules against the CALL LINE itself (first context line) so two
    // adjacent call sites cannot capture each other's rules; the intent
    // literal check below still uses the full multi-line context window.
    const callLine = site.context.split('\n')[0];
    const matching = rules.filter(
      (rule) => rule.file === site.relPath && callLine.includes(rule.match),
    );
    if (matching.length === 0) {
      unclassified.push(site);
      continue;
    }
    if (matching.length > 1) {
      violations.push(
        `${site.relPath}:${site.line} matches ${matching.length} rules — make rule "match" substrings unique`,
      );
    }
    const rule = matching[0];
    usedRules.add(rule);
    // Intent-classified store callers must literally declare the intent at the
    // call site (classification by call site, never by id shape).
    if (rule.classification.kind === 'intent') {
      const expected = `intent: '${rule.classification.intent}'`;
      if (!site.context.includes(expected)) {
        violations.push(
          `${site.relPath}:${site.line} is classified ${rule.classification.intent} but the call site does not contain \`${expected}\``,
        );
      }
    }
  }

  const staleRules = rules.filter((rule) => !usedRules.has(rule));
  return { unclassified, staleRules, violations };
}

// ---------------------------------------------------------------------------
// THE classification table (Stage 3 PLAN § per-caller classification)
// ---------------------------------------------------------------------------

const CALLER_RULES: CallerRule[] = [
  {
    file: 'src/main/ipc/sessionsHandlers.ts',
    match: "getIncrementalSessionStore().deleteSession(payload.id, { intent: 'user-delete' })",
    classification: { kind: 'intent', intent: 'user-delete', reason: 'sessions:delete IPC — genuine user intent (desktop + cloud-routed)' },
  },
  {
    file: 'src/main/services/cloud/cloudRouter.ts',
    match: "store.deleteSession(tombstone.sessionId, { intent: 'user-delete' })",
    classification: { kind: 'intent', intent: 'user-delete', reason: 'cloud tombstone apply — cross-device delete-wins is the point' },
  },
  {
    file: 'src/main/services/cloud/cloudRouter.ts',
    match: "store.deleteSession(payload.id, { intent: 'user-delete' })",
    classification: { kind: 'intent', intent: 'user-delete', reason: 'cloud-routed sessions:delete — genuine user intent, routed' },
  },
  {
    file: 'src/core/services/cloudSessionMergeService.ts',
    match: "deps.deleteSession(args.sessionId, { intent: 'user-delete' })",
    classification: { kind: 'intent', intent: 'user-delete', reason: 'processSessionDelete — cross-device delete-wins' },
  },
  {
    file: 'src/core/services/e2eSessionReset.ts',
    match: "store.deleteSession(summary.id, { intent: 'user-delete' })",
    classification: { kind: 'intent', intent: 'user-delete', reason: 'e2e:clear-all-sessions — factory-reset semantics, followed by test-reset ledger clear' },
  },
  {
    file: 'cloud-service/src/routes/e2eFixtures.ts',
    match: "deps.deleteSession(session.id, { intent: 'user-delete' })",
    classification: { kind: 'intent', intent: 'user-delete', reason: 'cloud resetSessions — factory-reset semantics, followed by test-reset ledger clear' },
  },
  {
    file: 'src/main/services/conversationIndexService.ts',
    match: "sessionStore.deleteSession(summary.id, { intent: 'hygiene' })",
    classification: { kind: 'intent', intent: 'hygiene', reason: 'ghost-prune of file-confirmed-missing presumed-gone data — tombstoning would block cloud re-sync of a live session' },
  },
  {
    file: 'src/core/services/cloudContinuityStateService.ts',
    match: "deps.deleteSession(sessionId, { intent: 'hygiene' })",
    classification: { kind: 'intent', intent: 'hygiene', reason: 'continuity GC — housekeeping, no fresh user intent at this call site' },
  },
  {
    file: 'src/core/services/incrementalSessionStore.ts',
    match: "this.deleteSession(sessionId, { intent: 'hygiene' })",
    classification: { kind: 'intent', intent: 'hygiene', reason: 'cleanupLeakedSessions — startup housekeeping of leaked internals; non-tombstoning keeps the ledger small (C-13), re-prune is self-healing' },
  },
  {
    file: 'cloud-service/src/bootstrap.ts',
    match: 'store.deleteSession(id, options)',
    classification: { kind: 'pass-through', reason: 'CloudServiceDeps wiring — carries the calling route\'s intent (declared at each route call site)' },
  },
  {
    file: 'cloud-service/src/bootstrap.ts',
    match: 'sessionSeqIndex.deleteSession(id)',
    classification: { kind: 'non-store-receiver', reason: 'per-session seq index cleanup — not the session store' },
  },
  {
    file: 'cloud-service/src/routes/ipc.ts',
    match: 'getSessionSeqIndex().deleteSession(sessionId)',
    classification: { kind: 'non-store-receiver', reason: 'per-session seq index cleanup — not the session store' },
  },
];

// ---------------------------------------------------------------------------
// Repo scan plumbing
// ---------------------------------------------------------------------------

function isProductionSourceFile(relPath: string): boolean {
  if (!/\.(ts|tsx|mts)$/.test(relPath)) return false;
  if (relPath.endsWith('.d.ts')) return false;
  if (/(^|\/)__tests__\//.test(relPath)) return false;
  if (/(^|\/)__test_helpers__\//.test(relPath)) return false;
  if (/\.(test|spec)\.(ts|tsx|mts)$/.test(relPath)) return false;
  return true;
}

function walkProductionSources(): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (absDir: string): void => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const relPath = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      if (!isProductionSourceFile(relPath)) continue;
      if (!/\.deleteSession\(/.test(fs.readFileSync(abs, 'utf8'))) continue;
      out.push({ relPath, content: fs.readFileSync(abs, 'utf8') });
    }
  };
  for (const root of SCAN_ROOTS) {
    walk(path.join(REPO_ROOT, root));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store-internal producer scan helpers (assumption C1 / RS F15)
// ---------------------------------------------------------------------------

const STORE_PATH = path.join(REPO_ROOT, 'src/core/services/incrementalSessionStore.ts');

function findEnclosingMethod(lines: string[], index: number): string {
  for (let i = index; i >= 0; i--) {
    const match = /^  (?:private |public |protected )?(?:async )?(?:get |set )?([A-Za-z_][A-Za-z0-9_]*)\(/.exec(lines[i]);
    if (match) return match[1];
  }
  return '<module>';
}

function enclosingMethodsOf(pattern: RegExp): string[] {
  const lines = fs.readFileSync(STORE_PATH, 'utf8').split('\n');
  const methods: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      methods.push(findEnclosingMethod(lines, i));
    }
  }
  return methods.sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deleteSession caller-enumeration harness (assumption C3)', () => {
  it('every production .deleteSession( call site is classified with a declared intent (or pass-through / non-store receiver)', () => {
    const sites = collectDeleteSessionCallSites(walkProductionSources());
    expect(sites.length).toBeGreaterThan(0);

    const { unclassified, staleRules, violations } = classifyCallSites(sites, CALLER_RULES);

    expect(
      unclassified.map((s) => `${s.relPath}:${s.line}\n${s.context}`),
      'UNCLASSIFIED deleteSession caller(s) found. Every caller must declare a delete intent at the call site ' +
        '(see SessionDeleteIntent in incrementalSessionStore.ts and the Stage 3 classification table in ' +
        'docs/plans/260612_recs-round5/PLAN.md), then be added to CALLER_RULES in this harness.',
    ).toEqual([]);
    expect(violations).toEqual([]);
    expect(
      staleRules.map((r) => `${r.file} :: ${r.match}`),
      'Stale CALLER_RULES row(s) — the call site moved or was removed; update the table.',
    ).toEqual([]);
  });

  it('FIXTURE PROOF: an unclassified caller is mechanically detected (the harness would fail CI)', () => {
    const synthetic: SourceFile = {
      relPath: 'src/main/services/someNewService.ts',
      content: [
        'async function rogueCleanup(store: IncrementalSessionStore): Promise<void> {',
        "  await store.deleteSession('some-id', { intent: 'user-delete' });",
        '}',
      ].join('\n'),
    };
    const sites = collectDeleteSessionCallSites([synthetic]);
    expect(sites).toHaveLength(1);
    const { unclassified } = classifyCallSites(sites, CALLER_RULES);
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0].relPath).toBe('src/main/services/someNewService.ts');
  });

  it('FIXTURE PROOF: a classified caller whose call site lost its intent literal is flagged', () => {
    const synthetic: SourceFile = {
      relPath: 'src/main/services/conversationIndexService.ts',
      content: "            await sessionStore.deleteSession(summary.id, { intent: 'hygiene' } as never); // mutated\n",
    };
    // Mutate the rule expectation: pretend the call site declares the WRONG intent.
    const mutated = synthetic.content.replace("'hygiene'", "'unknown'");
    const { violations } = classifyCallSites(
      collectDeleteSessionCallSites([{ ...synthetic, content: mutated }]),
      CALLER_RULES.filter((r) => r.file === 'src/main/services/conversationIndexService.ts').map((r) => ({
        ...r,
        match: 'sessionStore.deleteSession(summary.id',
      })),
    );
    expect(violations).toHaveLength(1);
  });
});

describe('session-file producer + index-write inventory (assumption C1, RS F15)', () => {
  it('persistSessionToDisk[Sync] call sites match the classified producer inventory exactly', () => {
    const methods = enclosingMethodsOf(/this\.persistSessionToDisk(Sync)?\(/);
    // Classification: every producer is guarded (input filter / write-skip /
    // early return / tombstoned-entry skip) — see the Stage 3 guards in each.
    expect(methods).toEqual(
      [
        'saveSync', // guarded: filterWritableSessions on input
        'upsertSessionsSyncInternal', // guarded: input filter + index prune (+ ledger re-read for reload)
        'flush', // guarded: filterWritableSessions on input
        'migrateFromLegacy', // guarded: write-side tombstone skip
        'migrateFromLegacySync', // guarded: write-side tombstone skip
        'migrateFromAgentSessions', // guarded: write-side tombstone skip
        'migrateFromAgentSessionsSync', // guarded: write-side tombstone skip
        'correctInterruptedSessionsOnStartup', // guarded: tombstoned entries skipped in the affected-loop
        'finalizeActiveSessionsOnShutdown', // guarded: tombstoned entries skipped in the affected-loop
        'doUpsertSession', // guarded: dropped-tombstoned early return
      ].sort(),
    );
  });

  it('writeIndexFileAtomic[Sync] call sites match the classified index-writer inventory exactly', () => {
    const methods = enclosingMethodsOf(/this\.writeIndexFileAtomic(Sync)?\(/);
    expect(methods).toEqual(
      [
        'upsertSessionsSyncInternal', // guarded: incoming filter + tombstoned-index prune
        'writeIndex', // guarded: incoming filter + merged-map sweep
        'writeIndexSync', // guarded: incoming filter + merged-map sweep
        'refreshSessionIndexSummaries', // guarded (fix round, review F1): filterWritableIndexEntries prunes tombstoned rows from the raw-parsed/in-memory index BEFORE the refresh map is built — the entriesById.has() add-proof gate is now structural, not caller-dependent
        'loadIndexOnlySync', // guarded: writes the tombstone-PRUNED index via the chokepoint (RS F15 — the mined port wrote this raw)
        'correctInterruptedSessionsOnStartup', // guarded: operates on the pruned index, tombstoned entries skipped
        'finalizeActiveSessionsOnShutdown', // guarded: tombstoned entries skipped
        'doUpsertSession', // guarded: dropped-tombstoned early return precedes the write
        'doDeleteSession', // guarded: the delete itself (removes the entry)
      ].sort(),
    );
  });

  it('no raw this.indexPath write exists outside the sanctioned chokepoint internals (RS F15)', () => {
    const methods = enclosingMethodsOf(/write(?:File|FileSync)\(this\.indexPath/);
    expect(methods).toEqual(
      [
        'writeIndexFileAtomic', // the chokepoint itself
        'writeIndexFileAtomicSync', // the chokepoint itself (sync)
        'recoverIndexFromBackupSync', // sanctioned bypass: RESTORES the primary FROM the validated backup
      ].sort(),
    );
  });
});
