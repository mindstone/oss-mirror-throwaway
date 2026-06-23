/**
 * LanceDB Search Spike — Latency Measurement + FTS Quality Comparison
 *
 * Stage 2: Measures FTS-only and fuzzy query latency against the real LanceDB index.
 * Stage 3: Compares LanceDB FTS results against Fuse.js for the same queries.
 *
 * Run: npx tsx scripts/measure-lancedb-search.ts
 */

import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import Fuse from 'fuse.js';

const LANCE_DIR = path.join(
  os.homedir(), 'Library', 'Application Support', 'mindstone-rebel',
  'indices', 'global', 'conversations', 'lancedb'
);
const TABLE_NAME = 'conversation_embeddings';
const RESULT_LIMIT = 10;
const RUNS_PER_QUERY = 3;

const TEST_QUERIES = [
  // Short single-word
  'meeting', 'budget', 'email',
  // Multi-word
  'project roadmap', 'Christmas movies',
  // Fuzzy / typo
  'meeing', 'cristmas', 'budgt',
  // Prefix-like (short)
  'chr', 'mee', 'pro',
  // Long
  'What was the decision about marketing',
];

interface TableRecord {
  sessionId: string;
  title: string;
  search_text: string;
  createdAt: number;
  updatedAt: number;
  origin: string;
  messageCount: number;
}

interface SearchResult {
  sessionId: string;
  title: string;
  score: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fmt(ms: number): string {
  return ms < 1 ? '<1' : Math.round(ms).toString();
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

function overlap(a: string[], b: string[]): { shared: number; aOnly: string[]; bOnly: string[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  const shared = a.filter(id => setB.has(id)).length;
  return {
    shared,
    aOnly: a.filter(id => !setB.has(id)),
    bOnly: b.filter(id => !setA.has(id)),
  };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('=== LanceDB Search Spike Results ===\n');

  // Dynamic import to avoid bundling issues
  const lancedb = await import('@lancedb/lancedb');

  // 1. Open table
  const t0 = performance.now();
  const db = await lancedb.connect(LANCE_DIR);
  const table = await db.openTable(TABLE_NAME);
  const openTime = performance.now() - t0;

  // 2. Get row count and all records for Fuse comparison
  const t1 = performance.now();
  let allRecords: TableRecord[];
  let hasSearchText = false;
  try {
    allRecords = await table.query()
      .select(['sessionId', 'title', 'search_text', 'createdAt', 'updatedAt', 'origin', 'messageCount'])
      .toArray() as any[];
    hasSearchText = true;
  } catch {
    // Pre-migration table — search_text column doesn't exist yet
    console.log('Note: search_text column not found (migration not yet run). Using title-only for FTS.');
    allRecords = await table.query()
      .select(['sessionId', 'title', 'createdAt', 'updatedAt', 'origin', 'messageCount'])
      .toArray() as any[];
  }
  const loadTime = performance.now() - t1;

  // Dedupe by sessionId (keep latest)
  const bySession = new Map<string, TableRecord>();
  for (const r of allRecords) {
    const existing = bySession.get(r.sessionId);
    if (!existing || r.updatedAt > existing.updatedAt) {
      bySession.set(r.sessionId, r);
    }
  }
  const records = Array.from(bySession.values());

  console.log('Table Stats:');
  console.log(`  Sessions indexed: ${records.length} (${allRecords.length} raw rows)`);
  console.log(`  Table open time: ${fmt(openTime)}ms`);
  console.log(`  Full load time: ${fmt(loadTime)}ms`);

  // 3. Check FTS indices
  const indices = await table.listIndices();
  console.log(`  FTS indices: ${indices.filter((i: any) => i.indexType === 'FTS').map((i: any) => i.columns?.join(',') || i.name).join(', ') || 'none'}`);
  console.log();

  // 4. Set up Fuse.js (matching searchSessionTitles config)
  const fuseEntries = records.map(r => ({
    sessionId: r.sessionId,
    title: r.title || 'Untitled',
  }));

  const fuse = new Fuse(fuseEntries, {
    keys: ['title'],
    threshold: 0.4,
    includeMatches: true,
    includeScore: true,
    minMatchCharLength: 1,
    ignoreLocation: true,
    useExtendedSearch: true,
  });

  // Transform query for extended search (same as searchSessionTitles)
  function transformQuery(query: string): string {
    const terms = query.split(/[\s\-_]+/).filter(t => t.length > 0);
    if (terms.length <= 1) return `'${query}`;
    return terms.map(t => `'${t}`).join(' ');
  }

  // 5. Run latency measurements + quality comparison
  console.log('Latency Results (ms):');
  console.log(`  ${pad('Query', 40)} | FTS cold | FTS warm | Fuzzy cold | Fuzzy warm`);
  console.log(`  ${'-'.repeat(40)} | -------- | -------- | ---------- | ----------`);

  const latencyResults: { query: string; ftsCold: number; ftsWarm: number; fuzzyCold: number; fuzzyWarm: number }[] = [];
  const qualityResults: { query: string; fuseResults: SearchResult[]; ftsResults: SearchResult[]; fuzzyResults: SearchResult[] }[] = [];

  for (const query of TEST_QUERIES) {
    // FTS (MultiMatchQuery)
    const ftsTimes: number[] = [];
    let ftsResults: SearchResult[] = [];
    for (let i = 0; i < RUNS_PER_QUERY; i++) {
      const start = performance.now();
      try {
        const ftsColumns = hasSearchText ? ['title', 'search_text'] : ['title'];
        const ftsQuery = new lancedb.MultiMatchQuery(query, ftsColumns);
        const raw = await table.query()
          .fullTextSearch(ftsQuery)
          .limit(RESULT_LIMIT)
          .select(['sessionId', 'title'])
          .toArray() as any[];
        ftsTimes.push(performance.now() - start);
        if (i === 0) {
          ftsResults = raw.map((r: any) => ({
            sessionId: r.sessionId,
            title: r.title,
            score: r._score ?? r._relevance_score ?? 0,
          }));
        }
      } catch (e: any) {
        ftsTimes.push(performance.now() - start);
        if (i === 0) console.log(`    FTS error for "${query}": ${e.message?.slice(0, 80)}`);
      }
    }

    // Fuzzy (MatchQuery on title with fuzziness=1)
    const fuzzyTimes: number[] = [];
    let fuzzyResults: SearchResult[] = [];
    for (let i = 0; i < RUNS_PER_QUERY; i++) {
      const start = performance.now();
      try {
        const fuzzyQuery = new lancedb.MatchQuery(query, 'title', { fuzziness: 1 });
        const raw = await table.query()
          .fullTextSearch(fuzzyQuery)
          .limit(RESULT_LIMIT)
          .select(['sessionId', 'title'])
          .toArray() as any[];
        fuzzyTimes.push(performance.now() - start);
        if (i === 0) {
          fuzzyResults = raw.map((r: any) => ({
            sessionId: r.sessionId,
            title: r.title,
            score: r._score ?? r._relevance_score ?? 0,
          }));
        }
      } catch (e: any) {
        fuzzyTimes.push(performance.now() - start);
        if (i === 0) console.log(`    Fuzzy error for "${query}": ${e.message?.slice(0, 80)}`);
      }
    }

    // Fuse.js
    const transformed = transformQuery(query);
    const fuseRaw = fuse.search(transformed, { limit: RESULT_LIMIT });
    const fuseResults: SearchResult[] = fuseRaw.map(r => ({
      sessionId: r.item.sessionId,
      title: r.item.title,
      score: r.score ?? 0,
    }));

    const ftsCold = ftsTimes[0] ?? 0;
    const ftsWarm = ftsTimes.length > 1 ? (ftsTimes.slice(1).reduce((a, b) => a + b, 0) / (ftsTimes.length - 1)) : ftsCold;
    const fuzzyCold = fuzzyTimes[0] ?? 0;
    const fuzzyWarm = fuzzyTimes.length > 1 ? (fuzzyTimes.slice(1).reduce((a, b) => a + b, 0) / (fuzzyTimes.length - 1)) : fuzzyCold;

    latencyResults.push({ query, ftsCold, ftsWarm, fuzzyCold, fuzzyWarm });

    console.log(`  ${pad(`"${query}"`, 40)} | ${pad(fmt(ftsCold), 8)} | ${pad(fmt(ftsWarm), 8)} | ${pad(fmt(fuzzyCold), 10)} | ${fmt(fuzzyWarm)}`);

    qualityResults.push({ query, fuseResults, ftsResults, fuzzyResults });
  }

  // 6. Quality comparison
  console.log('\nQuality Comparison:');
  for (const { query, fuseResults, ftsResults, fuzzyResults } of qualityResults) {
    const fuseIds = fuseResults.map(r => r.sessionId);
    const ftsIds = ftsResults.map(r => r.sessionId);
    const fuzzyIds = fuzzyResults.map(r => r.sessionId);

    console.log(`\n  Query: "${query}"`);
    console.log(`    Fuse.js (${fuseResults.length}): ${fuseResults.slice(0, 3).map(r => `"${r.title}"`).join(', ')}${fuseResults.length > 3 ? '...' : ''}`);
    console.log(`    LanceDB FTS (${ftsResults.length}): ${ftsResults.slice(0, 3).map(r => `"${r.title}"`).join(', ')}${ftsResults.length > 3 ? '...' : ''}`);
    console.log(`    LanceDB Fuzzy (${fuzzyResults.length}): ${fuzzyResults.slice(0, 3).map(r => `"${r.title}"`).join(', ')}${fuzzyResults.length > 3 ? '...' : ''}`);

    if (fuseIds.length > 0 || ftsIds.length > 0) {
      const o = overlap(fuseIds, ftsIds);
      console.log(`    FTS overlap with Fuse: ${o.shared}/${Math.max(fuseIds.length, ftsIds.length)} sessions`);
      if (o.aOnly.length > 0) {
        const fuseOnly = fuseResults.filter(r => o.aOnly.includes(r.sessionId));
        console.log(`    Fuse-only: ${fuseOnly.slice(0, 3).map(r => `"${r.title}"`).join(', ')}`);
      }
      if (o.bOnly.length > 0) {
        const ftsOnly = ftsResults.filter(r => o.bOnly.includes(r.sessionId));
        console.log(`    FTS-only: ${ftsOnly.slice(0, 3).map(r => `"${r.title}"`).join(', ')}`);
      }
    }
  }

  // 7. Summary
  const avgFtsCold = latencyResults.reduce((s, r) => s + r.ftsCold, 0) / latencyResults.length;
  const avgFtsWarm = latencyResults.reduce((s, r) => s + r.ftsWarm, 0) / latencyResults.length;
  const avgFuzzyCold = latencyResults.reduce((s, r) => s + r.fuzzyCold, 0) / latencyResults.length;
  const avgFuzzyWarm = latencyResults.reduce((s, r) => s + r.fuzzyWarm, 0) / latencyResults.length;

  const totalOverlap = qualityResults.reduce((s, r) => {
    const fuseIds = r.fuseResults.map(x => x.sessionId);
    const ftsIds = r.ftsResults.map(x => x.sessionId);
    if (fuseIds.length === 0 && ftsIds.length === 0) return s;
    return s + overlap(fuseIds, ftsIds).shared / Math.max(fuseIds.length, ftsIds.length, 1);
  }, 0);
  const queriesWithResults = qualityResults.filter(r => r.fuseResults.length > 0 || r.ftsResults.length > 0).length;

  console.log('\n\nSummary:');
  console.log(`  Average FTS latency: ${fmt(avgFtsCold)}ms (cold), ${fmt(avgFtsWarm)}ms (warm)`);
  console.log(`  Average Fuzzy latency: ${fmt(avgFuzzyCold)}ms (cold), ${fmt(avgFuzzyWarm)}ms (warm)`);
  console.log(`  Overall quality overlap: ${queriesWithResults > 0 ? Math.round(totalOverlap / queriesWithResults * 100) : 0}%`);

  // Check if fuzzy actually helps with typo queries
  const typoQueries = ['meeing', 'cristmas', 'budgt'];
  const fuzzyHelps = typoQueries.filter(q => {
    const r = qualityResults.find(x => x.query === q);
    return r && r.fuzzyResults.length > 0;
  });
  console.log(`  Fuzzy typo recovery: ${fuzzyHelps.length}/${typoQueries.length} typo queries found results`);

  console.log('\nDone.');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
