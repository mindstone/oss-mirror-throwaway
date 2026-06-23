/**
 * Deep Search Latency + Coverage Spike
 *
 * Measures how long deep search takes on real data, and what it finds
 * that hybrid search misses.
 *
 * Run: npx tsx scripts/measure-deep-search.ts
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'mindstone-rebel');
const SESSIONS_DIR = path.join(USER_DATA, 'sessions');
const LANCE_DIR = path.join(USER_DATA, 'indices', 'global', 'conversations', 'lancedb');
const TABLE_NAME = 'conversation_embeddings';

const TEST_QUERIES = [
  'meeting',
  'budget',
  'Christmas',
  'error',
  'help me',
  'thank you',
  'can you',
  'I need',
  'project',
  'schedule',
];

interface SessionFile {
  id: string;
  title?: string;
  messages?: Array<{ role: string; text?: string; createdAt?: number }>;
  deletedAt?: number | null;
}

interface DeepHit {
  sessionId: string;
  title: string;
  matchCount: number;
  matchPreview: string;
  matchedInAssistant: boolean;
  matchedInMiddle: boolean;
}

async function main() {
  console.log('=== Deep Search Latency + Coverage Spike ===\n');

  // 1. Count sessions on disk
  let sessionFiles: string[] = [];
  try {
    const entries = fs.readdirSync(SESSIONS_DIR);
    sessionFiles = entries.filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    console.log('No sessions directory found at', SESSIONS_DIR);
    return;
  }

  console.log(`Sessions on disk: ${sessionFiles.length}`);

  // 2. Load all sessions (measuring time)
  const t0 = performance.now();
  const sessions: SessionFile[] = [];
  let totalMessages = 0;
  let totalChars = 0;
  for (const file of sessionFiles) {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
      const session = JSON.parse(raw) as SessionFile;
      if (session.deletedAt) continue;
      sessions.push(session);
      const msgs = session.messages ?? [];
      totalMessages += msgs.length;
      for (const m of msgs) totalChars += (m.text ?? '').length;
    } catch {
      // skip corrupted
    }
  }
  const loadTime = performance.now() - t0;

  console.log(`Loadable sessions: ${sessions.length}`);
  console.log(`Total messages: ${totalMessages.toLocaleString()}`);
  console.log(`Total text: ${(totalChars / 1_000_000).toFixed(1)}M chars`);
  console.log(`Session load time: ${Math.round(loadTime)}ms`);

  // 3. Open LanceDB for comparison
  const lancedb = await import('@lancedb/lancedb');
  const db = await lancedb.connect(LANCE_DIR);
  const table = await db.openTable(TABLE_NAME);

  // Get all indexed sessionIds for comparison
  const indexedRows = await table.query().select(['sessionId']).toArray() as any[];
  const indexedSessionIds = new Set(indexedRows.map((r: any) => r.sessionId));
  console.log(`LanceDB indexed sessions: ${indexedSessionIds.size}`);
  console.log();

  // 4. Run deep search for each query and measure
  console.log('Deep Search Results:');
  console.log(`  ${pad('Query', 25)} | Time(ms) | Hits | Asst-only | Mid-only | Not-in-LanceDB`);
  console.log(`  ${'-'.repeat(25)} | -------- | ---- | --------- | -------- | --------------`);

  const allResults: { query: string; time: number; hits: DeepHit[]; hybridHits: number }[] = [];

  for (const query of TEST_QUERIES) {
    const queryLower = query.toLowerCase();

    // Deep search
    const t1 = performance.now();
    const hits: DeepHit[] = [];

    for (const session of sessions) {
      const msgs = session.messages ?? [];
      let matchCount = 0;
      let firstPreview = '';
      let matchedInAssistant = false;
      let matchedInMiddle = false;

      // Check what LanceDB FTS now indexes: title + search_text
      // search_text = all non-hidden user messages + first non-hidden assistant response (12K budget)
      const title = session.title ?? '';
      const allUserText = msgs.filter(m => m.role === 'user' && m.text).map(m => m.text).join(' ');
      const firstAssistantText = msgs.find(m => m.role === 'assistant' && m.text)?.text?.slice(0, 2000) ?? '';
      const searchText = [allUserText, firstAssistantText].join(' ');

      for (let i = 0; i < msgs.length; i++) {
        const text = (msgs[i].text ?? '').toLowerCase();
        const idx = text.indexOf(queryLower);
        if (idx >= 0) {
          matchCount++;
          if (!firstPreview) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + query.length + 40);
            firstPreview = text.slice(start, end);
          }
          // Is this in an assistant message?
          if (msgs[i].role === 'assistant') matchedInAssistant = true;
          // Is this in a middle message (not first user, not last few)?
          if (i > 0 && i < msgs.length - 3) matchedInMiddle = true;
        }
      }

      if (matchCount > 0) {
        hits.push({
          sessionId: session.id,
          title: title || 'Untitled',
          matchCount,
          matchPreview: firstPreview.slice(0, 80),
          matchedInAssistant,
          matchedInMiddle,
        });
      }
    }
    const deepTime = performance.now() - t1;

    // Hybrid search comparison
    let hybridHits = 0;
    try {
      const ftsQuery = new lancedb.MultiMatchQuery(query, ['title', 'search_text']);
      const hybridResults = await table.query()
        .fullTextSearch(ftsQuery)
        .limit(20)
        .select(['sessionId'])
        .toArray() as any[];
      hybridHits = new Set(hybridResults.map((r: any) => r.sessionId)).size;
    } catch {
      // FTS may fail
    }

    // Classify hits
    const assistantOnly = hits.filter(h => h.matchedInAssistant && !titleOrSearchTextMatch(h, query, sessions));
    const middleOnly = hits.filter(h => h.matchedInMiddle && !titleOrSearchTextMatch(h, query, sessions));
    const notInLanceDB = hits.filter(h => !indexedSessionIds.has(h.sessionId));

    allResults.push({ query, time: deepTime, hits, hybridHits });

    console.log(`  ${pad(`"${query}"`, 25)} | ${pad(Math.round(deepTime).toString(), 8)} | ${pad(hits.length.toString(), 4)} | ${pad(assistantOnly.length.toString(), 9)} | ${pad(middleOnly.length.toString(), 8)} | ${notInLanceDB.length}`);
  }

  // 5. Summary
  const avgTime = allResults.reduce((s, r) => s + r.time, 0) / allResults.length;
  const totalHits = allResults.reduce((s, r) => s + r.hits.length, 0);
  const totalHybridHits = allResults.reduce((s, r) => s + r.hybridHits, 0);

  console.log('\n\nSummary:');
  console.log(`  Average deep search time: ${Math.round(avgTime)}ms`);
  console.log(`  Total deep search hits: ${totalHits} across ${TEST_QUERIES.length} queries`);
  console.log(`  Total hybrid search hits: ${totalHybridHits} across ${TEST_QUERIES.length} queries`);
  console.log(`  Deep search finds ${((totalHits / Math.max(totalHybridHits, 1)) * 100).toFixed(0)}% as many results as hybrid`);

  // What percentage of deep hits are in content hybrid can't reach?
  let assistantOnlyTotal = 0;
  let middleOnlyTotal = 0;
  for (const r of allResults) {
    for (const h of r.hits) {
      if (h.matchedInAssistant) assistantOnlyTotal++;
      if (h.matchedInMiddle) middleOnlyTotal++;
    }
  }
  console.log(`  Hits in assistant responses: ${assistantOnlyTotal} (${Math.round(assistantOnlyTotal / Math.max(totalHits, 1) * 100)}%)`);
  console.log(`  Hits in middle messages: ${middleOnlyTotal} (${Math.round(middleOnlyTotal / Math.max(totalHits, 1) * 100)}%)`);

  // Performance assessment
  if (avgTime < 500) {
    console.log('\n  VERDICT: Deep search is fast enough to include in unified search (< 500ms)');
  } else if (avgTime < 2000) {
    console.log('\n  VERDICT: Deep search is marginal (500-2000ms). Could include with timeout or progressive loading.');
  } else {
    console.log('\n  VERDICT: Deep search is too slow for automatic inclusion (> 2000ms). Keep as opt-in.');
  }

  console.log('\nDone.');
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

function titleOrSearchTextMatch(hit: DeepHit, query: string, sessions: SessionFile[]): boolean {
  const session = sessions.find(s => s.id === hit.sessionId);
  if (!session) return false;
  const title = (session.title ?? '').toLowerCase();
  const msgs = session.messages ?? [];
  const allUserText = msgs.filter(m => m.role === 'user' && m.text).map(m => m.text!.toLowerCase()).join(' ');
  const firstAssistant = msgs.find(m => m.role === 'assistant' && m.text)?.text?.slice(0, 2000).toLowerCase() ?? '';
  const q = query.toLowerCase();
  return title.includes(q) || allUserText.includes(q) || firstAssistant.includes(q);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
