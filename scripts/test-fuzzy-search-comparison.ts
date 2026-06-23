/**
 * Fuzzy Search Comparison Test: Fuse.js vs uFuzzy
 *
 * Purpose: Determine if Fuse.js can be fixed with query preprocessing,
 * or if uFuzzy is needed for @-mention autocomplete search.
 *
 * Run with: npx tsx scripts/test-fuzzy-search-comparison.ts
 */

import Fuse from 'fuse.js';
import uFuzzy from '@leeoniya/ufuzzy';

// Real session titles from user's conversation history
const SESSION_TITLES = [
  'Christmas Movie Quiz Guessing',
  'Rebel Quiz Answer',
  'Mindstone People Memory Check',
  'find my prompt on image generation re Rebel character',
  'Calendar Access Permissions Stefan',
  'Rebel Launch Memory Audit',
  'Rebel Launch Prep Review',
  'Rebel Launch Event Readiness',
  'Otter MCP Setup',
  'Otter MCP Authentication',
  'Lead Engineer Hiring Criteria',
  'Rebel Memory System Links',
  'AI in the Wild Analysis',
  'Rebel Character Image Prompt',
  'Slack Progress Update Skill',
  'Date Time Query',
  'Current Workspace Directory',
  'Rebel Meeting Notion Summary',
  'Rebel success metrics Penny',
  'OAuth Links Mindstone MCPs',
  'Google Workspace MCP Auth',
  "Mehdi's CV Retrieval",
  'Online GP Appointment Search',
  "Su's 80th Birthday WhatsApp",
  'Daily Wins & Learnings',
  'Investment Research Summary',
  'Product Roadmap Discussion',
  'Team Standup Notes',
  'Developer Partner Onboarding',
  'Email Draft Review',
];

// Test queries and expected matches
const TEST_CASES = [
  { query: 'chr-mov', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Hyphenated abbreviation' },
  { query: 'chr mov', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Space-separated abbreviation' },
  { query: 'christ', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Prefix match' },
  { query: 'quiz guess', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Two words in order' },
  { query: 'mov-quiz', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Out of order hyphenated' },
  { query: 'ch', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Very short query (2 chars)' },
  { query: 'chr', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Short query (3 chars)' },
  { query: 'movie christmas', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Out of order words' },
  { query: 'xmas', expectedMatch: null, description: 'Semantic synonym (should NOT match)' },
  { query: 'christmsa', expectedMatch: 'Christmas Movie Quiz Guessing', description: 'Typo tolerance' },
  { query: 'rebel launch', expectedMatch: 'Rebel Launch Memory Audit', description: 'Multi-word exact' },
  { query: 'reb-lau', expectedMatch: 'Rebel Launch Memory Audit', description: 'Hyphenated abbreviation' },
  { query: 'mcp setup', expectedMatch: 'Otter MCP Setup', description: 'Technical abbreviation' },
  { query: 'lead eng', expectedMatch: 'Lead Engineer Hiring Criteria', description: 'Partial word match' },
];

interface SearchResult {
  title: string;
  score: number;
}

// Create Fuse instance with current config
const createCurrentFuse = (titles: string[]) => {
  return new Fuse(
    titles.map((t) => ({ title: t })),
    {
      keys: ['title'],
      threshold: 0.4,
      includeScore: true,
      includeMatches: true,
      ignoreLocation: true,
      minMatchCharLength: 1,
      distance: 200,
    }
  );
};

// Fuse with query preprocessing (replace hyphens with spaces)
const searchWithPreprocessing = (fuse: Fuse<{ title: string }>, query: string): SearchResult[] => {
  const preprocessed = query.replace(/-/g, ' ');
  const results = fuse.search(preprocessed, { limit: 5 });
  return results.map((r) => ({ title: r.item.title, score: r.score ?? 1 }));
};

// Fuse with extended search mode
const createExtendedFuse = (titles: string[]) => {
  return new Fuse(
    titles.map((t) => ({ title: t })),
    {
      keys: ['title'],
      threshold: 0.4,
      includeScore: true,
      useExtendedSearch: true,
      ignoreLocation: true,
      minMatchCharLength: 1,
    }
  );
};

const searchWithExtended = (fuse: Fuse<{ title: string }>, query: string): SearchResult[] => {
  // Convert "word1 word2" to "'word1 'word2" for AND matching
  const parts = query.replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const extendedQuery = parts.map((p) => `'${p}`).join(' ');
  const results = fuse.search(extendedQuery, { limit: 5 });
  return results.map((r) => ({ title: r.item.title, score: r.score ?? 1 }));
};

// uFuzzy search
const searchWithUFuzzy = (uf: uFuzzy, haystack: string[], query: string): SearchResult[] => {
  const [idxs, info, order] = uf.search(haystack, query);

  if (!idxs || idxs.length === 0) {
    return [];
  }

  const results: SearchResult[] = [];
  const sortedIdxs = order ? order.map((i) => idxs[i]) : idxs;

  for (let i = 0; i < Math.min(5, sortedIdxs.length); i++) {
    const idx = sortedIdxs[i];
    results.push({
      title: haystack[idx],
      // uFuzzy doesn't provide normalized scores, use position as pseudo-score
      score: i * 0.1,
    });
  }

  return results;
};

// Format result for display
const formatResult = (results: SearchResult[], expectedMatch: string | null): string => {
  if (results.length === 0) {
    return expectedMatch === null ? '✓ (no match)' : '✗ NO MATCH';
  }

  const topMatch = results[0].title;
  const isCorrect = expectedMatch ? topMatch === expectedMatch : false;
  const mark = isCorrect ? '✓' : expectedMatch === null ? '?' : '✗';

  return `${mark} ${topMatch.substring(0, 40)}${topMatch.length > 40 ? '…' : ''}`;
};

// Main comparison
const runComparison = () => {
  console.log('='.repeat(120));
  console.log('FUZZY SEARCH COMPARISON: Fuse.js vs uFuzzy');
  console.log('='.repeat(120));
  console.log(`\nDataset: ${SESSION_TITLES.length} session titles\n`);

  // Create search instances
  const currentFuse = createCurrentFuse(SESSION_TITLES);
  const extendedFuse = createExtendedFuse(SESSION_TITLES);
  const uf = new uFuzzy({
    intraMode: 1, // Allow gaps between chars
    intraIns: 1, // Allow insertions
    interIns: 3, // Allow insertions between terms
  });

  // Print header
  console.log(
    '| Query'.padEnd(20) +
      '| Description'.padEnd(30) +
      '| Fuse (current)'.padEnd(45) +
      '| Fuse (preprocessed)'.padEnd(45) +
      '| Fuse (extended)'.padEnd(45) +
      '| uFuzzy'.padEnd(45) +
      '|'
  );
  console.log('|' + '-'.repeat(19) + '|' + '-'.repeat(29) + '|' + '-'.repeat(44) + '|' + '-'.repeat(44) + '|' + '-'.repeat(44) + '|' + '-'.repeat(44) + '|');

  // Track scores
  const scores = {
    current: { pass: 0, fail: 0 },
    preprocessed: { pass: 0, fail: 0 },
    extended: { pass: 0, fail: 0 },
    ufuzzy: { pass: 0, fail: 0 },
  };

  for (const testCase of TEST_CASES) {
    const { query, expectedMatch, description } = testCase;

    // Run searches
    const currentResults = currentFuse.search(query, { limit: 5 }).map((r) => ({
      title: r.item.title,
      score: r.score ?? 1,
    }));
    const preprocessedResults = searchWithPreprocessing(currentFuse, query);
    const extendedResults = searchWithExtended(extendedFuse, query);
    const ufuzzyResults = searchWithUFuzzy(uf, SESSION_TITLES, query);

    // Check correctness
    const currentCorrect = currentResults.length > 0 && currentResults[0].title === expectedMatch;
    const preprocessedCorrect = preprocessedResults.length > 0 && preprocessedResults[0].title === expectedMatch;
    const extendedCorrect = extendedResults.length > 0 && extendedResults[0].title === expectedMatch;
    const ufuzzyCorrect = ufuzzyResults.length > 0 && ufuzzyResults[0].title === expectedMatch;

    if (expectedMatch !== null) {
      if (currentCorrect) scores.current.pass++;
      else scores.current.fail++;
      if (preprocessedCorrect) scores.preprocessed.pass++;
      else scores.preprocessed.fail++;
      if (extendedCorrect) scores.extended.pass++;
      else scores.extended.fail++;
      if (ufuzzyCorrect) scores.ufuzzy.pass++;
      else scores.ufuzzy.fail++;
    }

    console.log(
      '| ' +
        query.padEnd(18) +
        '| ' +
        description.padEnd(28) +
        '| ' +
        formatResult(currentResults, expectedMatch).padEnd(43) +
        '| ' +
        formatResult(preprocessedResults, expectedMatch).padEnd(43) +
        '| ' +
        formatResult(extendedResults, expectedMatch).padEnd(43) +
        '| ' +
        formatResult(ufuzzyResults, expectedMatch).padEnd(43) +
        '|'
    );
  }

  console.log('|' + '-'.repeat(19) + '|' + '-'.repeat(29) + '|' + '-'.repeat(44) + '|' + '-'.repeat(44) + '|' + '-'.repeat(44) + '|' + '-'.repeat(44) + '|');

  // Print summary
  console.log('\n' + '='.repeat(120));
  console.log('SUMMARY (excluding negative test cases):');
  console.log('='.repeat(120));
  const total = scores.current.pass + scores.current.fail;
  console.log(`Fuse.js (current config):     ${scores.current.pass}/${total} passed (${Math.round((scores.current.pass / total) * 100)}%)`);
  console.log(`Fuse.js (with preprocessing): ${scores.preprocessed.pass}/${total} passed (${Math.round((scores.preprocessed.pass / total) * 100)}%)`);
  console.log(`Fuse.js (extended search):    ${scores.extended.pass}/${total} passed (${Math.round((scores.extended.pass / total) * 100)}%)`);
  console.log(`uFuzzy:                       ${scores.ufuzzy.pass}/${total} passed (${Math.round((scores.ufuzzy.pass / total) * 100)}%)`);

  console.log('\n' + '='.repeat(120));
  console.log('RECOMMENDATION:');
  console.log('='.repeat(120));

  const bestFuse = Math.max(scores.current.pass, scores.preprocessed.pass, scores.extended.pass);
  const ufuzzyScore = scores.ufuzzy.pass;

  if (ufuzzyScore > bestFuse) {
    console.log('→ uFuzzy outperforms all Fuse.js configurations. Consider switching to uFuzzy.');
  } else if (scores.preprocessed.pass > scores.current.pass && scores.preprocessed.pass >= ufuzzyScore) {
    console.log('→ Query preprocessing (hyphen→space) improves Fuse.js to match or exceed uFuzzy.');
    console.log('  Fix: Add preprocessing step before calling Fuse.search()');
  } else if (scores.extended.pass > scores.current.pass && scores.extended.pass >= ufuzzyScore) {
    console.log('→ Extended search mode improves Fuse.js. Consider using useExtendedSearch: true.');
  } else if (scores.current.pass === bestFuse && scores.current.pass >= ufuzzyScore) {
    console.log('→ Current Fuse.js config is optimal. No changes needed.');
  } else {
    console.log('→ Results are mixed. Review individual test cases for specific improvements.');
  }
};

runComparison();
